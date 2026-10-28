// Package featureflags 提供原子快照读写的 feature flag 集。
// flags 经 FEATURE_FLAGS 帧（kind 911）广播到 sys.>，SIGHUP 白名单热重载可写。
// 读多写少：Snapshot() 走 atomic.Value 零拷贝读，Apply() 写整份新副本。
package featureflags

import (
	"sync"
	"sync/atomic"
)

// 默认 flag 集合常量：同名 key 的默认值。
const (
	KeyVideoEnabled = "video_enabled"
	KeyE2EE         = "e2ee"
	KeyRegistration = "registration"
	KeyReadonly     = "readonly"
	KeyCallEnabled  = "call_enabled"
)

// Defaults 返回默认 flag 集合的副本。
func Defaults() map[string]any {
	return map[string]any{
		KeyVideoEnabled: false,
		KeyE2EE:         false,
		KeyRegistration: true,
		KeyReadonly:     false,
		KeyCallEnabled:  false,
	}
}

// state 内部不可变快照（发布后不再修改）。
type state struct {
	flags   map[string]any
	version uint64
}

// Flags 并发安全的 flag 存储。零值不可用，用 New()。
type Flags struct {
	cur atomic.Value // *state
	mu  sync.Mutex   // 只串行化 Apply
}

// New 用默认集合构造。
func New() *Flags {
	f := &Flags{}
	f.cur.Store(&state{flags: Defaults(), version: 0})
	return f
}

// NewFromMap 用指定集合构造。
func NewFromMap(m map[string]any) *Flags {
	f := &Flags{}
	cp := make(map[string]any, len(m))
	for k, v := range m {
		cp[k] = v
	}
	f.cur.Store(&state{flags: cp, version: 0})
	return f
}

// Snapshot 返回当前集合的只读副本（调用方可安全修改，不影响存储）。
func (f *Flags) Snapshot() map[string]any {
	s := f.cur.Load().(*state)
	cp := make(map[string]any, len(s.flags))
	for k, v := range s.flags {
		cp[k] = v
	}
	return cp
}

// Version 返回当前版本号（每次 Apply 递增）。
func (f *Flags) Version() uint64 {
	return f.cur.Load().(*state).version
}

// Apply 原子合并 delta（仅覆盖出现的 key），返回新版本号。
func (f *Flags) Apply(delta map[string]any) uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	old := f.cur.Load().(*state)
	next := make(map[string]any, len(old.flags)+len(delta))
	for k, v := range old.flags {
		next[k] = v
	}
	for k, v := range delta {
		if v == nil {
			delete(next, k) // nil 语义 = 删除该 flag 回退默认
			continue
		}
		next[k] = v
	}
	newVer := old.version + 1
	f.cur.Store(&state{flags: next, version: newVer})
	return newVer
}

// Get 返回单个 flag 值；不存在返回 (nil, false)。
func (f *Flags) Get(key string) (any, bool) {
	s := f.cur.Load().(*state)
	v, ok := s.flags[key]
	return v, ok
}

// Bool 便捷读取布尔 flag，不存在或类型不符返回 def。
func (f *Flags) Bool(key string, def bool) bool {
	if v, ok := f.Get(key); ok {
		if b, isB := v.(bool); isB {
			return b
		}
	}
	return def
}
