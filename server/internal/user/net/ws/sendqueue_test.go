package ws

import (
	"sync"
	"testing"
)

// v1.2 的 RESYNC/lagging 降级已回滚（docs/perf-postmortem-v1.2-draft.md）。
// 以下测试锁定回滚后的语义：环满 = 静默丢弃（对应 v1.1.1 行为），无任何
// 控制帧副作用，drain 后正常恢复入队。

func TestSendQueuePushSilentDropWhenFull(t *testing.T) {
	q := newSendQueue(3)
	for i := 0; i < 3; i++ {
		if !q.push([]byte{byte(i)}) {
			t.Fatalf("push %d: expected enqueue while ring has room", i)
		}
	}
	// 环满：push 返回 false，但不改变队列状态（静默丢弃）。
	for i := 0; i < 5; i++ {
		if q.push([]byte("overflow")) {
			t.Fatal("push: expected drop when ring is full")
		}
	}
	if got := q.pending(); got != 3 {
		t.Fatalf("pending = %d, want 3 (overflow frames silently dropped)", got)
	}
	ctrl, data := q.drain()
	if len(ctrl) != 0 {
		t.Fatalf("ctrl lane len = %d, want 0 (no RESYNC/degradation control frames)", len(ctrl))
	}
	if len(data) != 3 {
		t.Fatalf("data len = %d, want 3", len(data))
	}
}

func TestSendQueuePushAfterDrain(t *testing.T) {
	q := newSendQueue(2)
	_ = q.push([]byte("a"))
	_ = q.push([]byte("b"))
	if q.push([]byte("c")) {
		t.Fatal("expected drop when full")
	}
	q.drain()
	if !q.push([]byte("d")) {
		t.Fatal("expected enqueue after drain")
	}
	if got := q.pending(); got != 1 {
		t.Fatalf("pending = %d, want 1", got)
	}
}

func TestSendQueuePushClosed(t *testing.T) {
	q := newSendQueue(2)
	q.close()
	if q.push([]byte("x")) {
		t.Fatal("expected drop on closed queue")
	}
	q.pushCtrl([]byte("y")) // must not panic / must be ignored
	if got := q.pending(); got != 0 {
		t.Fatalf("pending = %d, want 0", got)
	}
}

func TestSendQueueConcurrentPushDrain(t *testing.T) {
	q := newSendQueue(16)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				q.push([]byte("f"))
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for j := 0; j < 10; j++ {
			q.drain()
		}
	}()
	wg.Wait()
	if got := q.pending(); got > 16 {
		t.Fatalf("pending = %d, want <= cap", got)
	}
}

// Conn.Write 层：环满时 dropped 计数递增且返回 false（Write 层即 v1.1.1
// 「静默丢弃 + 计数」语义的对外表现）。
func TestConnWriteDropsWhenRingFull(t *testing.T) {
	c := &Conn{q: newSendQueue(1), notify: make(chan struct{}, 1), done: make(chan struct{})}
	if !c.Write([]byte("a")) {
		t.Fatal("first write should enqueue")
	}
	if c.Write([]byte("b")) {
		t.Fatal("second write should be dropped (ring full)")
	}
	if got := c.Dropped(); got != 1 {
		t.Fatalf("dropped = %d, want 1", got)
	}
	if got := c.Pending(); got != 1 {
		t.Fatalf("pending = %d, want 1", got)
	}
}
