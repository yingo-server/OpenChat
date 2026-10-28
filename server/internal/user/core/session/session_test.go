package session

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeConn 实现 Conn 接口，记录收到的帧。
type fakeConn struct {
	id     uint64
	uid    int64
	device string
	mu     sync.Mutex
	got    [][]byte
	closed atomic.Bool
}

func (c *fakeConn) ID() uint64       { return c.id }
func (c *fakeConn) UserID() int64    { return c.uid }
func (c *fakeConn) DeviceID() string { return c.device }
func (c *fakeConn) Write(b []byte) bool {
	c.mu.Lock()
	c.got = append(c.got, append([]byte(nil), b...))
	c.mu.Unlock()
	return true
}
func (c *fakeConn) Close() error { c.closed.Store(true); return nil }
func (c *fakeConn) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.got)
}

func TestRegisterLookupUnregister(t *testing.T) {
	s := New(30 * time.Second)
	c1 := &fakeConn{id: 1, uid: 10, device: "a"}
	c2 := &fakeConn{id: 2, uid: 10, device: "b"}
	if err := s.Register(c1); err != nil {
		t.Fatal(err)
	}
	if err := s.Register(c2); err != nil {
		t.Fatal(err)
	}
	if got := s.GetByUser(10); len(got) != 2 {
		t.Fatalf("GetByUser = %d, want 2", len(got))
	}
	if got := s.Lookup(2); got == nil || got.DeviceID() != "b" {
		t.Fatalf("Lookup(2) = %v", got)
	}
	s.Unregister(1)
	if s.Lookup(1) != nil {
		t.Fatal("conn 1 still present")
	}
	if got := s.Count(); got != 1 {
		t.Fatalf("Count = %d", got)
	}
}

// TestTombstone tombstone 30s 内拒绝复用 connID。
func TestTombstone(t *testing.T) {
	s := New(30 * time.Second)
	now := time.Unix(1000, 0)
	s.now = func() time.Time { return now }
	c := &fakeConn{id: 42, uid: 1}
	if err := s.Register(c); err != nil {
		t.Fatal(err)
	}
	s.Unregister(42)
	if !s.Tombstoned(42) {
		t.Fatal("connID should be tombstoned")
	}
	if err := s.Register(&fakeConn{id: 42, uid: 1}); err != ErrTombstoned {
		t.Fatalf("re-register err = %v, want ErrTombstoned", err)
	}
	now = now.Add(31 * time.Second)
	if s.Tombstoned(42) {
		t.Fatal("tombstone should expire after 30s")
	}
	if err := s.Register(&fakeConn{id: 42, uid: 1}); err != nil {
		t.Fatalf("register after expiry: %v", err)
	}
}

// TestConcurrentRegisterUnregisterBroadcast 并发注册/注销/广播（-race）。
func TestConcurrentRegisterUnregisterBroadcast(t *testing.T) {
	s := New(30 * time.Second)
	const workers = 16
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		w := w
		wg.Add(1)
		go func() {
			defer wg.Done()
			uid := int64(w % 4)
			for i := 0; i < 200; i++ {
				id := uint64(w*1000 + i + 1)
				c := &fakeConn{id: id, uid: uid, device: fmt.Sprintf("d%d", w)}
				if err := s.Register(c); err != nil {
					continue
				}
				s.Broadcast(uid, []byte("x"))
				s.Unregister(id)
			}
		}()
	}
	// 并发广播者。
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			s.Broadcast(int64(i%4), []byte("y"))
		}
	}()
	wg.Wait()
}

// TestBroadcastAllConnections 广播写向该 uid 的全部连接。
func TestBroadcastAllConnections(t *testing.T) {
	s := New(30 * time.Second)
	conns := []*fakeConn{
		{id: 1, uid: 5}, {id: 2, uid: 5}, {id: 3, uid: 5}, {id: 4, uid: 6},
	}
	for _, c := range conns {
		if err := s.Register(c); err != nil {
			t.Fatal(err)
		}
	}
	n := s.Broadcast(5, []byte("hello"))
	if n != 3 {
		t.Fatalf("Broadcast delivered = %d, want 3", n)
	}
	for _, c := range conns[:3] {
		if c.count() != 1 {
			t.Fatalf("conn %d got %d frames", c.id, c.count())
		}
	}
	if conns[3].count() != 0 {
		t.Fatal("other uid should not receive")
	}
}

// TestPresenceCopy presence 副本读写。
func TestPresenceCopy(t *testing.T) {
	s := New(30 * time.Second)
	s.SetPresence(9, 1, time.Now())
	if st, ok := s.Presence(9); !ok || st != 1 {
		t.Fatalf("presence = %v,%v", st, ok)
	}
	if _, ok := s.Presence(10); ok {
		t.Fatal("unknown uid should be absent")
	}
}
