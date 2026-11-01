package ws

// sendqueue.go: per-connection bounded send queue + write batching
// (perf-spec v1.2 §2.2 / §2.3).
//
// 回滚说明（2025 大群压测回归）：v1.2 曾在此实现「慢消费者降级」——环满时置
// lagging、向控制通道投递 RESYNC(kind 14)，并丢弃后续 inline 帧，期望客户端
// 收到 RESYNC 后自行 SYNC 补拉缺口。该方案在 500 人群压测中把可用性从 2.2%
// 打到 0.9%（p95 4.2s→8.8s）：前端 apps/client 没有任何 RESYNC handler
// （main.tsx 无注册、kinds.ts 无常量），压测客户端也不发 SYNC，降级退路
// 完全不存在——连接进入 LAGGING 后所有 inline 帧静默蒸发，压测期间约 6.9 万
// 个 ACK 因此凭空消失。本回滚删除 lagging/RESYNC 机制，环满恢复 v1.1.1 的
// 「静默丢弃 + dropped 计数」语义。完整根因分析见 docs/perf-postmortem-v1.2-draft.md；
// v1.2 大群拉取模式将由客户端先实现补拉 handler 后再另行引入。
//
// 保留的优化：
//   - 环容量 1024（原 4096，省内存；静默丢弃语义与 v1.1.1 一致）；
//   - drain-then-batch 的写循环结构（当前 writeBatch 仍逐帧写，结构保留给
//     后续真正的合批）；
//   - safety tick 改为可选（Config.SendTick，默认 0 = 不启用，消除空转唤醒）；
//   - 控制帧遵守 jsonMode（frameWireMsg）。
//
// Design:
//   - Inline fan-out frames land in a bounded ring (capacity 1024). A separate
//     small priority lane carries control frames (protocol-error close) that
//     must never be blocked behind inline traffic.
//   - The write loop drains the whole queue per wake and hands it to a single
//     writeBatch call (idle ⇒ one frame in, zero added latency; under load ⇒
//     many frames coalesced into one loop iteration).

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// sendRingCap is the default inline ring capacity (perf-spec §2.3: 1024).
const sendRingCap = 1024

// outMsg is one prepared WebSocket message handed to the writer.
type outMsg struct {
	mt int
	b  []byte
}

// connWriter abstracts the socket write primitives so write batching is
// unit-testable without a real websocket.Conn.
type connWriter interface {
	// writeBatch writes all prepared messages in one logical call (production:
	// one write-loop iteration; the fake: one counted call).
	writeBatch(msgs []outMsg) error
	// writeControl sends a control frame (ping) or close frame.
	writeControl(mt int, data []byte) error
}

// gorillaWriter is the production connWriter. It routes every write through
// gorilla so its internal mutex serialises data frames, control frames and the
// read-side auto-pong (writing raw to the socket would race those).

type gorillaWriter struct{ c *websocket.Conn }

func (w gorillaWriter) writeBatch(msgs []outMsg) error {
	if len(msgs) == 0 {
		return nil
	}
	_ = w.c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	for _, m := range msgs {
		if err := w.c.WriteMessage(m.mt, m.b); err != nil {
			return err
		}
	}
	return nil
}

func (w gorillaWriter) writeControl(mt int, data []byte) error {
	return w.c.WriteControl(mt, data, time.Now().Add(10*time.Second))
}

// sendQueue is a bounded ring plus a priority control lane. All methods are
// safe for concurrent use; the write loop is the only consumer.
type sendQueue struct {
	mu     sync.Mutex
	ring   [][]byte
	ctrl   [][]byte
	cap    int
	closed bool
}

func newSendQueue(cap int) *sendQueue {
	if cap <= 0 {
		cap = sendRingCap
	}
	return &sendQueue{cap: cap}
}

// push enqueues one inline frame. It returns false when the frame was dropped
// (ring full → silent drop, matching the v1.1.1 slow-consumer semantics, or
// the queue is closed). The caller is expected to count drops via
// Conn.dropped; no signalling to the client is performed.
func (q *sendQueue) push(b []byte) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed || len(q.ring) >= q.cap {
		return false
	}
	q.ring = append(q.ring, b)
	return true
}

// pushCtrl enqueues a high-priority control frame (never blocked by inline
// traffic).
func (q *sendQueue) pushCtrl(b []byte) {
	q.mu.Lock()
	if !q.closed {
		q.ctrl = append(q.ctrl, b)
	}
	q.mu.Unlock()
}

// drain removes everything.
func (q *sendQueue) drain() (ctrl [][]byte, data [][]byte) {
	q.mu.Lock()
	ctrl = q.ctrl
	data = q.ring
	q.ctrl = nil
	q.ring = nil
	q.mu.Unlock()
	return ctrl, data
}

func (q *sendQueue) pending() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.ring) + len(q.ctrl)
}

func (q *sendQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
}
