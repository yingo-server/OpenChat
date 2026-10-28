// Package cache is the data layer's shared read cache: a sharded (16) LRU
// with per-entry TTL. It exists so the dispatcher's越权拦截点 (membership check
// before ANY write enters the pipeline) is fast — while remaining strictly
// bounded in staleness.
//
// Docs red line: 权限不缓存超 60 秒 — membership TTL is 60s and the write path
// EXPLICITLY invalidates on membership mutation (AddMember/RemoveMember/
// SetMemberRole). Cache 提供 Get/Invalidate/Touch 原语；不做主动失效猜测。
//
// Authorization authority is ALWAYS the store row: a cache hit is a hint that
// saves a query, never a source of truth beyond its TTL.
package cache

import (
	"hash/fnv"
	"strconv"
	"sync"
	"time"
)

// TTLs — freshness bounds from docs/admin-data-design.md and the authorization
// red line ("权限不缓存超 60s"). These are cache mechanism constants, not
// authorization policy.
const (
	MemberTTL = 60 * time.Second  // membership/permission entries
	UserTTL   = 300 * time.Second // identity profile entries
)

// DefaultCapacity is the total entry budget (100k) split evenly over shards.
const DefaultCapacity = 100000

// MemberKey addresses a membership entry: (cid, uid) → store.Member.
type MemberKey struct {
	Cid int64
	UID int64
}

func (k MemberKey) String() string {
	return "m:" + strconv.FormatInt(k.Cid, 10) + ":" + strconv.FormatInt(k.UID, 10)
}

// UserKey addresses an identity entry: uid → store.User.
type UserKey int64

func (k UserKey) String() string { return "u:" + strconv.FormatInt(int64(k), 10) }

const shardCount = 16 // power of two, mask-based selection

// Cache is a 16-shard LRU with per-entry TTL. All methods are safe for
// concurrent use; contention is bounded by shard partitioning.
type Cache struct {
	shards   [shardCount]*shard
	perShard int
	now      func() time.Time // test seam
}

// New creates the cache with total capacity cap (rounded down to a multiple
// of 16; minimum 16). Entries beyond capacity evict LRU-first per shard.
func New(capacity int) *Cache {
	if capacity < shardCount {
		capacity = shardCount
	}
	per := capacity / shardCount
	c := &Cache{perShard: per, now: time.Now}
	for i := range c.shards {
		c.shards[i] = &shard{perShard: per, items: map[string]*entry{}}
	}
	return c
}

// entry is one cached value, linked into its shard's recency list.
type entry struct {
	key      string
	val      any
	expireAt time.Time // zero = never (tests)
	prev, next *entry
}

// shard is one lock-protected LRU partition (intrusive doubly-linked list,
// front = most recently used).
type shard struct {
	mu       sync.Mutex
	perShard int
	items    map[string]*entry
	head     *entry
	tail     *entry
}

func (s *shard) unlink(e *entry) {
	if e.prev != nil {
		e.prev.next = e.next
	} else {
		s.head = e.next
	}
	if e.next != nil {
		s.nextPrevFix(e)
	} else {
		s.tail = e.prev
	}
	e.prev, e.next = nil, nil
}

func (s *shard) nextPrevFix(e *entry) { e.next.prev = e.prev }

func (s *shard) pushFront(e *entry) {
	e.prev, e.next = nil, s.head
	if s.head != nil {
		s.head.prev = e
	}
	s.head = e
	if s.tail == nil {
		s.tail = e
	}
}

// hash picks a shard by FNV-1a of the string key.
func hash(s string) int {
	h := fnv.New32a()
	h.Write([]byte(s))
	return int(h.Sum32() & (shardCount - 1))
}

func (c *Cache) shardFor(key string) *shard { return c.shards[hash(key)] }

// Get returns the cached value for key if present and unexpired. A hit
// refreshes LRU recency (equivalent to Touch).
func (c *Cache) Get(key string) (any, bool) {
	s := c.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.items[key]
	if !ok {
		return nil, false
	}
	if !e.expireAt.IsZero() && c.now().After(e.expireAt) {
		s.unlink(e)
		delete(s.items, key)
		return nil, false
	}
	s.unlink(e)
	s.pushFront(e)
	return e.val, true
}

// Put stores val under key with ttl (ttl <= 0 means: keep until eviction —
// tests only; production callers always pass MemberTTL/UserTTL). Evicts the
// LRU tail when the shard is over capacity.
func (c *Cache) Put(key string, val any, ttl time.Duration) {
	s := c.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.items[key]; ok {
		s.unlink(e)
		delete(s.items, key)
	}
	e := &entry{key: key, val: val}
	if ttl > 0 {
		e.expireAt = c.now().Add(ttl)
	}
	s.items[key] = e
	s.pushFront(e)
	for len(s.items) > s.perShard && s.tail != nil {
		victim := s.tail
		s.unlink(victim)
		delete(s.items, victim.key)
	}
}

// Invalidate drops key (write path calls this explicitly on membership /
// profile mutation). Returns whether a live entry was dropped.
func (c *Cache) Invalidate(key string) bool {
	s := c.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.items[key]
	if !ok {
		return false
	}
	s.unlink(e)
	delete(s.items, key)
	return true
}

// Touch refreshes recency without changing TTL; returns whether the key was
// present (expired entries are treated as absent and removed).
func (c *Cache) Touch(key string) bool {
	s := c.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.items[key]
	if !ok {
		return false
	}
	if !e.expireAt.IsZero() && c.now().After(e.expireAt) {
		s.unlink(e)
		delete(s.items, key)
		return false
	}
	s.unlink(e)
	s.pushFront(e)
	return true
}

// Len returns the number of live (not yet lazily-reaped) entries.
func (c *Cache) Len() int {
	n := 0
	for _, s := range c.shards {
		s.mu.Lock()
		n += len(s.items)
		s.mu.Unlock()
	}
	return n
}

// ------------------------------------------------- typed helpers (hot path)

// Member reads a membership entry.
func (c *Cache) Member(k MemberKey) (any, bool) { return c.Get(k.String()) }

// PutMember caches a membership entry with the 60s permission TTL.
func (c *Cache) PutMember(k MemberKey, m any) { c.Put(k.String(), m, MemberTTL) }

// InvalidateMember is called by the write path on any membership mutation
// affecting (cid, uid) — explicit invalidation, no guessing.
func (c *Cache) InvalidateMember(k MemberKey) { c.Invalidate(k.String()) }

// User reads an identity entry.
func (c *Cache) User(k UserKey) (any, bool) { return c.Get(k.String()) }

// PutUser caches an identity entry with the 300s profile TTL.
func (c *Cache) PutUser(k UserKey, u any) { c.Put(k.String(), u, UserTTL) }

// InvalidateUser is called by the write path on profile/ban mutation.
func (c *Cache) InvalidateUser(k UserKey) { c.Invalidate(k.String()) }

// InvalidateConv drops every membership entry of a conversation (member list
// changed wholesale). MemberKey hashing is per (cid,uid), so this scans the
// conversation's own shard prefix space — implemented as a targeted sweep of
// all shards' maps by key prefix "m:<cid>:".
func (c *Cache) InvalidateConv(cid int64) {
	prefix := "m:" + strconv.FormatInt(cid, 10) + ":"
	for _, s := range c.shards {
		s.mu.Lock()
		for k, e := range s.items {
			if len(k) > len(prefix) && k[:len(prefix)] == prefix {
				s.unlink(e)
				delete(s.items, k)
			}
		}
		s.mu.Unlock()
	}
}
