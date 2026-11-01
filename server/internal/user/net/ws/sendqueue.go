package ws

// sendqueue.go: per-connection bounded send queue + write batching + slow-consumer
// degradation (perf-spec v1.2 §2.2 / §2.3).
//
// Design:
//   - Inline fan-out frames land in a bounded ring (capacity 1024). A separate
//     small priority lane carries control frames (RESYNC, protocol-error close)
//     that must never be blocked behind inline traffic.
//   - The write loop drains the whole queue per wake and hands it to a single
//     writeBatch call (idle ⇒ one frame in, zero added latency; under load ⇒
//     many frames coalesced into one loop iteration). A 15ms safety tick flushes
//     anything a lost wakeup could strand.
//   - When the ring is full the connection is marked LAGGING: a RESYNC control
//     frame is queued and every further inline frame is dropped. The client then
//     pulls the gap (kind 8 SYNC) instead of the whole group paying for one slow
//     socket. When the queue drains, lagging clears and inline delivery resumes.

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/yingo-server/OpenChat/server/internal/proto/gen/chatpb"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
	"github.com/yingo-server/OpenChat/server/internal/user/net/frame"
)

const (
	// sendRingCap is the default inline ring capacity (perf-spec §2.3: 1024).
	sendRingCap = 1024
	// writeFallbackFlush is the safety-flush interval (perf-spec §2.2: 15ms).
	writeFallbackFlush = 15 * time.Millisecond
)

// outMsg is one prepared WebSocket message handed to the writer.
type outMsg struct {
	mt int
	b  []byte
}

// connWriter abstracts the socket write primitives so write batching and the
// degradation path are unit-testable without a real websocket.Conn.
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
	mu      sync.Mutex
	ring    [][]byte
	ctrl    [][]byte
	cap     int
	lagging bool
	closed  bool
}

func newSendQueue(cap int) *sendQueue {
	if cap <= 0 {
		cap = sendRingCap
	}
	return &sendQueue{cap: cap}
}

// push enqueues one inline frame. It returns (enqueued bool, needResync bool):
//   - (true, false)  frame accepted;
//   - (false, true)  ring was full → caller must queue a RESYNC control frame
//     (lagging is now armed, so no further inline frames are accepted);
//   - (false, false) dropped (already lagging or the connection is closed).
func (q *sendQueue) push(b []byte) (bool, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return false, false
	}
	if q.lagging {
		return false, false
	}
	if len(q.ring) >= q.cap {
		q.lagging = true
		return false, true
	}
	q.ring = append(q.ring, b)
	return true, false
}

// pushCtrl enqueues a high-priority control frame (never blocked by inline
// traffic, exempt from the lagging gate).
func (q *sendQueue) pushCtrl(b []byte) {
	q.mu.Lock()
	if !q.closed {
		q.ctrl = append(q.ctrl, b)
	}
	q.mu.Unlock()
}

// drain removes everything and clears lagging (the queue is now empty, so the
// slow-consumer condition no longer holds and inline delivery may resume).
func (q *sendQueue) drain() (ctrl [][]byte, data [][]byte) {
	q.mu.Lock()
	ctrl = q.ctrl
	data = q.ring
	q.ctrl = nil
	q.ring = nil
	q.lagging = false
	q.mu.Unlock()
	return ctrl, data
}

func (q *sendQueue) pending() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.ring) + len(q.ctrl)
}

func (q *sendQueue) isLagging() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.lagging
}

func (q *sendQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
}

// resyncFrame builds the RESYNC control frame handed to a lagging connection.
// Format (additive, perf-spec §2.3): Envelope{kind = KindResync(14), payload =
// empty}. It carries no seq: the client already knows its own last_seq and
// reacts by issuing a SYNC/k8 catch-up for the conversations it tracks. It is a
// server→client control hint; it changes no existing kind's semantics.
func resyncFrame() []byte {
	env := &chatpb.Envelope{Kind: uint32(kinds.KindResync)}
	b, _ := frame.Encode(env)
	return b
}
