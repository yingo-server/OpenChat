// flusher: group-commit stage. See pipe.go for the overall flow.
package pipe

import (
	"context"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/data/store"
	"github.com/yingo-server/OpenChat/server/internal/pkg/log"
)

const (
	defaultFlushBatch = 1000
	defaultFlushEvery = 50 * time.Millisecond
)

// flusher accumulates ReadyMsg up to batchSize (default 1000) or interval
// (default 50ms), commits the batch in ONE transaction
// (store.MsgWriter.AppendMessages), then — and only then — emits ack frames.
// Acks hang off the COMMIT, never off the enqueue (docs §1.2). A failed
// batch answers the WHOLE batch with code=500 (all-or-nothing contract).
type flusher struct {
	w         store.MsgWriter
	out       chan<- *env
	lg        *log.Logger
	batchSize int
	interval  time.Duration
	readyCh   <-chan ReadyMsg
	dedup     *Dedup

	// done closes when run() returns (final flush complete) — Drain waits on it.
	done chan struct{}
}

// ReadyMsg is one message entering the flusher: the pending row plus the
// lineage needed to build its ack env.
type ReadyMsg struct {
	Msg   store.PendingMsg
	Trace string
}

func newFlusher(w store.MsgWriter, out chan<- *env, ready <-chan ReadyMsg, d *Dedup, lg *log.Logger) *flusher {
	return &flusher{w: w, out: out, lg: lg, batchSize: defaultFlushBatch,
		interval: defaultFlushEvery, readyCh: ready, dedup: d, done: make(chan struct{})}
}

func (f *flusher) run(ctx context.Context) {
	defer close(f.done)
	t := time.NewTimer(f.interval)
	defer t.Stop()
	var buf []ReadyMsg
	flushNow := func() {
		if len(buf) == 0 {
			return
		}
		f.flush(ctx, buf)
		buf = buf[:0]
	}
	for {
		select {
		case m, ok := <-f.readyCh:
			if !ok {
				flushNow() // writeCh closed: SIGTERM final commit
				return
			}
			buf = append(buf, m)
			if len(buf) >= f.batchSize {
				if !t.Stop() {
					select { case <-t.C: default: }
				}
				t.Reset(f.interval)
				flushNow()
			}
		case <-t.C:
			t.Reset(f.interval)
			flushNow()
		case <-ctx.Done():
			flushNow()
			return
		}
	}
}

func (f *flusher) flush(ctx context.Context, buf []ReadyMsg) {
	batch := make([]store.PendingMsg, len(buf))
	for i, m := range buf {
		batch[i] = m.Msg
	}
	if err := f.w.AppendMessages(ctx, batch); err != nil {
		f.lg.Error("flusher: batch failed", "batch_len", len(buf), "err", err.Error())
		for _, m := range buf {
			f.emit(m.Msg, 500, "flush failed")
		}
		return
	}
	for _, m := range buf {
		f.dedup.Remember(m.Msg.Cid, m.Msg.SenderID, m.Msg.ClientMsgID, dedupResult{
			MsgID: m.Msg.MsgID, Seq: m.Msg.Seq, SentAt: m.Msg.SentAt, Status: 0,
		})
		f.emit(m.Msg, 0, "")
	}
}

// emit sends the ack env for one message (status 0 = ok) on the outbound
// lane. Non-blocking: the lane is bounded and the client's retry path
// (dedup memory + DB UNIQUE) is the safety net for a dropped ack.
func (f *flusher) emit(m store.PendingMsg, status uint32, reason string) {
	e := buildAckEnv(m.Cid, m.ClientMsgID, m.MsgID, m.Seq, status)
	select {
	case f.out <- e:
	default:
		f.lg.Warn("flusher: outbound lane full; ack dropped (retry will dedup)")
	}
}
