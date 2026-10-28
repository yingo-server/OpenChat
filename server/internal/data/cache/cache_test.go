package cache

import (
	"fmt"
	"strconv"
	"testing"
	"time"
)

func TestPutGetInvalidate(t *testing.T) {
	c := New(1024)
	c.Put("a", 1, time.Minute)
	if v, ok := c.Get("a"); !ok || v.(int) != 1 {
		t.Fatalf("get: %v %v", v, ok)
	}
	if !c.Invalidate("a") {
		t.Fatal("invalidate should report drop")
	}
	if _, ok := c.Get("a"); ok {
		t.Fatal("entry survived invalidate")
	}
	if c.Invalidate("a") {
		t.Fatal("double invalidate should be false")
	}
}

func TestTTL(t *testing.T) {
	c := New(1024)
	base := time.Unix(1000000, 0)
	c.now = func() time.Time { return base }
	c.Put("a", 1, MemberTTL) // 60s: the permission red line
	c.Put("u", 1, UserTTL)
	base = base.Add(59 * time.Second)
	if _, ok := c.Get("a"); !ok {
		t.Fatal("member entry expired before 60s")
	}
	base = base.Add(2 * time.Second)
	if _, ok := c.Get("a"); ok {
		t.Fatal("member entry survived past 60s (authorization red line)")
	}
	base = base.Add(250 * time.Second) // total 311s since put (> 300s UserTTL)
	if _, ok := c.Get("u"); ok {
		t.Fatal("user entry survived past 300s")
	}
}

func TestTouch(t *testing.T) {
	c := New(1024)
	base := time.Unix(0, 0)
	c.now = func() time.Time { return base }
	c.Put("a", 1, time.Minute)
	base = base.Add(30 * time.Second)
	if !c.Touch("a") {
		t.Fatal("touch failed")
	}
	base = base.Add(40 * time.Second) // 70s since put, touch doesn't extend TTL
	if _, ok := c.Get("a"); ok {
		t.Fatal("touch must not extend TTL (permission staleness bound)")
	}
	if c.Touch("a") {
		t.Fatal("touch on expired/absent should be false")
	}
}

func TestLRUEviction(t *testing.T) {
	c := New(shardCount) // 1 per shard
	c.Put("k0", 0, 0)
	c.Put("k1", 1, 0) // k0/k1 may map to same or different shards
	if c.Len() > shardCount {
		t.Fatalf("over capacity: %d", c.Len())
	}
	// force many keys into a small cache; total must stay bounded
	c2 := New(32) // 2 per shard
	for i := 0; i < 1000; i++ {
		c2.Put("k"+strconv.Itoa(i), i, 0)
	}
	if c2.Len() > 32 {
		t.Fatalf("capacity violated: %d", c2.Len())
	}
}

func TestTypedHelpers(t *testing.T) {
	c := New(1024)
	mk := MemberKey{Cid: 5, UID: 9}
	c.PutMember(mk, "member-row")
	if v, ok := c.Member(mk); !ok || v != "member-row" {
		t.Fatalf("Member: %v %v", v, ok)
	}
	c.InvalidateMember(mk)
	if _, ok := c.Member(mk); ok {
		t.Fatal("member invalidate failed")
	}

	uk := UserKey(42)
	c.PutUser(uk, "user-row")
	if _, ok := c.User(uk); !ok {
		t.Fatal("User get failed")
	}
	c.InvalidateUser(uk)
	if _, ok := c.User(uk); ok {
		t.Fatal("user invalidate failed")
	}
}

func TestInvalidateConv(t *testing.T) {
	c := New(4096)
	for uid := int64(1); uid <= 50; uid++ {
		c.PutMember(MemberKey{Cid: 7, UID: uid}, uid)
		c.PutMember(MemberKey{Cid: 8, UID: uid}, uid) // other conv must survive
	}
	c.InvalidateConv(7)
	for uid := int64(1); uid <= 50; uid++ {
		if _, ok := c.Member(MemberKey{Cid: 7, UID: uid}); ok {
			t.Fatalf("conv 7 member %d survived", uid)
		}
		if _, ok := c.Member(MemberKey{Cid: 8, UID: uid}); !ok {
			t.Fatalf("conv 8 member %d wrongly dropped", uid)
		}
	}
}

func TestShardingDistribution(t *testing.T) {
	c := New(16384)
	for i := 0; i < 16000; i++ {
		c.Put(fmt.Sprintf("key-%d", i), i, time.Hour)
	}
	// Every shard should hold some entries (FNV over diverse keys).
	for i, s := range c.shards {
		s.mu.Lock()
		if len(s.items) == 0 {
			s.mu.Unlock()
			t.Fatalf("shard %d empty — sharding broken", i)
		}
		s.mu.Unlock()
	}
}
