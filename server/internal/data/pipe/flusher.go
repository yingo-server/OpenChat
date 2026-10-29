// flusher: group-commit stage. See pipe.go for the overall flow.
package pipe

import (
	"context"
	"encoding/json"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/data/store"
	"github.com/yingo-server/OpenChat/server/internal/pkg/log"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
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
	convs     store.ConvStore
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

func newFlusher(w store.MsgWriter, convs store.ConvStore, out chan<- *env, ready <-chan ReadyMsg, d *Dedup, lg *log.Logger) *flusher {
	return &flusher{w: w, convs: convs, out: out, lg: lg, batchSize: defaultFlushBatch,
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
					select {
					case <-t.C:
					default:
					}
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
		f.fanoutNew(m.Msg)
	}
}

// fanoutNew delivers MSG_NEW to every other conversation member, one frame
// per member addressed by user_id (multi-device delivery is the gateway's
// Broadcast(uid) job). The sender's own devices rely on the ack/outbox path.
func (f *flusher) fanoutNew(m store.PendingMsg) {
	if f.convs == nil {
		return
	}
	members, err := f.convs.ListMembers(context.Background(), m.Cid)
	if err != nil {
		f.lg.Warn("flusher: list members for MSG_NEW fanout failed", "cid", m.Cid, "err", err.Error())
		return
	}
	payload := buildMsgNewPayload(m)
	for _, member := range members {
		if member.UID == m.SenderID {
			continue
		}
		e := &env{Kind: uint32(kinds.KindMsgNew), ConvID: uint64(m.Cid), UserID: uint64(member.UID), Payload: payload}
		select {
		case f.out <- e:
		default:
			f.lg.Warn("flusher: outbound lane full; MSG_NEW dropped", "cid", m.Cid, "uid", member.UID)
		}
	}
}

// buildMsgNewPayload emits the client-facing snake_case JSON shape
// (MSG_NEW payload), embedding the stored message content as a JSON object
// rather than base64 bytes.
func buildMsgNewPayload(m store.PendingMsg) []byte {
	var c struct {
		ClientMsgID      string `json:"client_msg_id"`
		ClientMsgIDCamel string `json:"clientMsgId"`
		Text             string `json:"text"`
		ReplyTo          uint64 `json:"reply_to"`
		ReplyToCamel     uint64 `json:"replyTo"`
		Media            []struct {
			MediaID    string `json:"media_id"`
			MediaIDCam string `json:"mediaId"`
			MType      int32  `json:"mtype"`
			Name       string `json:"name"`
			Size       int64  `json:"size"`
			Mime       string `json:"mime"`
			Width      uint32 `json:"width"`
			Height     uint32 `json:"height"`
			DurationMs uint32 `json:"duration_ms"`
			DurationMc uint32 `json:"durationMs"`
		} `json:"media"`
	}
	if len(m.Content) > 0 {
		_ = json.Unmarshal(m.Content, &c)
	}
	clientMsgID := c.ClientMsgID
	if clientMsgID == "" {
		clientMsgID = c.ClientMsgIDCamel
	}
	replyTo := c.ReplyTo
	if replyTo == 0 {
		replyTo = c.ReplyToCamel
	}
	media := make([]map[string]any, 0, len(c.Media))
	for _, mm := range c.Media {
		id := mm.MediaID
		if id == "" {
			id = mm.MediaIDCam
		}
		dm := mm.DurationMs
		if dm == 0 {
			dm = mm.DurationMc
		}
		media = append(media, map[string]any{
			"media_id":    id,
			"mtype":       mm.MType,
			"name":        mm.Name,
			"size":        mm.Size,
			"mime":        mm.Mime,
			"width":       mm.Width,
			"height":      mm.Height,
			"duration_ms": dm,
		})
	}
	content, _ := json.Marshal(map[string]any{
		"client_msg_id": clientMsgID,
		"text":          c.Text,
		"reply_to":      replyTo,
		"media":         media,
		"mentions":      []any{},
	})
	out, _ := json.Marshal(struct {
		MsgID    uint64          `json:"msg_id"`
		Seq      uint64          `json:"seq"`
		SenderID uint64          `json:"sender_id"`
		SentAt   int64           `json:"sent_at"`
		ConvID   uint64          `json:"conv_id"`
		Content  json.RawMessage `json:"content"`
	}{
		MsgID: uint64(m.MsgID), Seq: uint64(m.Seq), SenderID: uint64(m.SenderID),
		SentAt: m.SentAt * 1000, ConvID: uint64(m.Cid), Content: content,
	})
	return out
}

// emit sends the ack env for one message (status 0 = ok) on the outbound
// lane. Non-blocking: the lane is bounded and the client's retry path
// (dedup memory + DB UNIQUE) is the safety net for a dropped ack.
func (f *flusher) emit(m store.PendingMsg, status uint32, reason string) {
	e := buildAckEnv(m.SenderID, m.Cid, m.ClientMsgID, m.MsgID, m.Seq, status)
	select {
	case f.out <- e:
	default:
		f.lg.Warn("flusher: outbound lane full; ack dropped (retry will dedup)")
	}
}
