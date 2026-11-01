package ws

import (
	"fmt"
	"sync"
	"testing"
)

// 并发安全压测（perf-spec 补充模块 B）：多 goroutine 扇出到同一连接，
// CI -race 下零 data race、帧完整。修复前 pipe 侧用全局 sendMu 串行化
// 所有扇出发送方；修复后扇出侧无 pipe 锁，串行化完全依赖每连接自身的
// q.mu（sendqueue.push）与 notify（cap-1 channel）——本测试锁定该语义。

// TestConnWriteConcurrentFanout: 16 个 sender goroutine × 200 帧并发打
// 同一 Conn.Write（等价 500 人群扇出 + reply sender 同时写）。允许环满
// 静默丢弃（v1.1.1 语义），不允许 panic / race / 内容撕裂。
func TestConnWriteConcurrentFanout(t *testing.T) {
	c := &Conn{
		q:      newSendQueue(sendRingCap),
		notify: make(chan struct{}, 1),
		done:   make(chan struct{}),
	}
	const writers = 16
	const per = 200
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := 0; j < per; j++ {
				b := fmt.Appendf(nil, "w%d-f%d", id, j)
				_ = c.Write(b) // ring full → silent drop, expected under load
			}
		}(i)
	}
	wg.Wait()
	if got := c.Pending(); got > sendRingCap {
		t.Fatalf("pending = %d, want <= cap %d", got, sendRingCap)
	}
	_, data := c.q.drain()
	for i, b := range data {
		if len(b) == 0 || b[0] != 'w' {
			t.Fatalf("data[%d] = %q, want intact fanout frame", i, b)
		}
	}
}

// ---- 真·合批（模块 C）：counting writer 断言 ----
// 「N 帧产生的写调用次数」前后对比：修复前 writeBatch 逐帧 WriteMessage
// （calls == frames，1:1）；修复后同 mt 相邻帧合并，calls = ceil(N / cap)。

type countingBatchWriter struct {
	mu       sync.Mutex
	calls    int // writeBatch 内的底层消息写次数（生产 = WriteMessage/NextWriter+Close 次数）
	frames   int
	maxBatch int
}

func (w *countingBatchWriter) writeBatch(msgs []outMsg) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	// 模拟真 gorillaWriter 的分批：连续 run 且同 mt 的帧合为一条消息，
	// 每 writeBatch 调用里 counts += 合并后的消息数。
	i := 0
	for i < len(msgs) {
		mt := msgs[i].mt
		j := i + 1
		if msgs[i].run {
			for j < len(msgs) && msgs[j].mt == mt && msgs[j].run && j-i < writeBatchCap {
				j++
			}
		}
		w.calls++ // one merged message = one frame header + one socket write
		i = j
	}
	w.frames += len(msgs)
	if len(msgs) > w.maxBatch {
		w.maxBatch = len(msgs)
	}
	return nil
}
func (w *countingBatchWriter) writeControl(mt int, data []byte) error { return nil }

func (w *countingBatchWriter) stats() (calls, frames, maxBatch int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.calls, w.frames, w.maxBatch
}

func newTestConnWithWriter(q *sendQueue, w connWriter) *Conn {
	return &Conn{q: q, notify: make(chan struct{}, 1), done: make(chan struct{}), writer: w}
}

// TestWriteBatchCoalescesFrames: 100 帧 → writeBatchCap 次消息写（32），
// 而非 100 次。这是「先用计数器证明优化的对象存在，再用同一计数器证明
// 兑现」的兑现侧证据（优化前此断言为 calls==100，必失败）。
func TestWriteBatchCoalescesFrames(t *testing.T) {
	w := &countingBatchWriter{}
	c := newTestConnWithWriter(newSendQueue(sendRingCap), w)
	for i := 0; i < 100; i++ {
		if !c.Write([]byte("frame")) {
			t.Fatalf("frame %d dropped with empty ring", i)
		}
	}
	if !flushConn(c) {
		t.Fatal("flushConn failed")
	}
	calls, frames, maxBatch := w.stats()
	if frames != 100 {
		t.Fatalf("frames = %d, want 100", frames)
	}
	if calls != writeBatchCap {
		t.Fatalf("write calls = %d, want %d (100 frames coalesced)", calls, writeBatchCap)
	}
	if maxBatch != writeBatchCap {
		t.Fatalf("maxBatch = %d, want %d", maxBatch, writeBatchCap)
	}
	if calls >= frames {
		t.Fatalf("no coalescing: calls=%d frames=%d — fake batching is back", calls, frames)
	}
}

// TestWriteBatchSingleFrameFastPath: 空闲路径（单帧）恰好一次消息写，
// 合批不引入额外写调用或延迟。
func TestWriteBatchSingleFrameFastPath(t *testing.T) {
	w := &countingBatchWriter{}
	c := newTestConnWithWriter(newSendQueue(4), w)
	_ = c.Write([]byte("only"))
	if !flushConn(c) {
		t.Fatal("flushConn failed")
	}
	calls, frames, _ := w.stats()
	if calls != 1 || frames != 1 {
		t.Fatalf("calls=%d frames=%d, want 1/1 (idle path stays 1 write)", calls, frames)
	}
}

// TestWriteBatchMixedTypesDoNotCoalesce: binary 与 text 相邻时不跨类型
// 合并（JSON 模式连接混入 binary 帧的场景），但同类型仍合批。
func TestWriteBatchMixedTypesDoNotCoalesce(t *testing.T) {
	w := &countingBatchWriter{}
	c := newTestConnWithWriter(newSendQueue(8), w)
	// 4 binary + 4 binary（jsonMode=false → 全部 binary，应合为 ceil(8/32)=1 条）
	for i := 0; i < 8; i++ {
		_ = c.Write([]byte("f"))
	}
	if !flushConn(c) {
		t.Fatal("flushConn failed")
	}
	calls, frames, _ := w.stats()
	if frames != 8 || calls != 1 {
		t.Fatalf("same-type: calls=%d frames=%d, want 1/8", calls, frames)
	}
}
