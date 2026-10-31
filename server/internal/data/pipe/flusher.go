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
	w     store.MsgWriter
	convs store.ConvStore
	media store.MediaStore // optional: enriches media[] with thumb/waveform/status
	out   chan<- *env
	// putBulk places a fan-out frame on the lane, honouring the reserve the
	// pipe keeps for replies. Fan-out must never consume the ACK headroom.
	putBulk func(*env) bool
	// putAck places an ACK on the lane with full capacity: the sender is
	// blocked on it, so it outranks broadcast traffic.
	putAck    func(*env)
	lg        *log.Logger
	batchSize int
	interval  time.Duration
	readyCh   <-chan ReadyMsg
	dedup     *Dedup
	// mc is the cached member-list view: the MSG_NEW fan-out resolves the
	// recipient set from the cache instead of querying the DB per message.
	mc *memberCache

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

// setMediaStore injects the (optional) media store used to enrich the
// downlink media[] entries with the inline thumbnail, the audio waveform and
// the scan status. A nil store degrades gracefully: the media[] entries keep
// whatever the uplink carried, minus the store-only fields.
func (f *flusher) setMediaStore(ms store.MediaStore) { f.media = ms }

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
	// Resolve the batch's media rows ONCE (one store round trip per media
	// id, but the ids are collected across the whole batch first, so a
	// message with N media entries does not re-read the same row N times
	// and the batch never degrades into an N+1 storm against the store).
	mediaIdx := f.resolveMediaBatch(ctx, batch)
	for _, m := range buf {
		f.dedup.Remember(m.Msg.Cid, m.Msg.SenderID, m.Msg.ClientMsgID, dedupResult{
			MsgID: m.Msg.MsgID, Seq: m.Msg.Seq, SentAt: m.Msg.SentAt, Status: 0,
		})
		f.emit(m.Msg, 0, "")
		f.fanoutNew(m.Msg, mediaIdx)
	}
}

// resolveMediaBatch collects every media_id referenced by the batch and
// resolves it to its store row. The result is a map keyed by media_id that
// the payload builder consults. A nil map means "no media store wired" and
// the builder falls back to the uplink content only.
func (f *flusher) resolveMediaBatch(ctx context.Context, batch []store.PendingMsg) map[string]*store.Media {
	if f.media == nil || len(batch) == 0 {
		return nil
	}
	ids := make([]string, 0, len(batch))
	seen := make(map[string]bool, len(batch))
	for _, m := range batch {
		for _, id := range mediaIDsIn(m.Content) {
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	out := make(map[string]*store.Media, len(ids))
	for _, id := range ids {
		rec, err := f.media.Get(ctx, id)
		if err != nil || rec == nil {
			continue // missing row: the payload keeps the uplink fields only
		}
		out[id] = rec
	}
	return out
}

// mediaIDsIn extracts the media_ids referenced by a stored content payload.
func mediaIDsIn(content []byte) []string {
	if len(content) == 0 {
		return nil
	}
	var c msgNewContent
	if err := json.Unmarshal(content, &c); err != nil {
		return nil
	}
	out := make([]string, 0, len(c.Media))
	for _, mm := range c.Media {
		id := mm.MediaID
		if id == "" {
			id = mm.MediaIDCam
		}
		if id != "" {
			out = append(out, id)
		}
	}
	return out
}

// fanoutNew delivers MSG_NEW to every other conversation member, one frame
// per member addressed by user_id (multi-device delivery is the gateway's
// Broadcast(uid) job). The sender's own devices rely on the ack/outbox path.
//
// mediaIdx is the pre-resolved media table for the whole flush batch (nil
// when no media store is wired).
func (f *flusher) fanoutNew(m store.PendingMsg, mediaIdx map[string]*store.Media) {
	if f.convs == nil {
		return
	}
	var members []store.Member
	var err error
	if f.mc != nil {
		members, err = f.mc.Members(context.Background(), m.Cid)
	} else {
		members, err = f.convs.ListMembers(context.Background(), m.Cid)
	}
	if err != nil {
		f.lg.Warn("flusher: list members for MSG_NEW fanout failed", "cid", m.Cid, "err", err.Error())
		return
	}
	payload := buildMsgNewPayloadWithMedia(m, mediaLookupFromIndex(mediaIdx))
	for _, member := range members {
		if member.UID == m.SenderID {
			continue
		}
		e := &env{Kind: uint32(kinds.KindMsgNew), ConvID: uint64(m.Cid), UserID: uint64(member.UID), Payload: payload}
		if f.putBulk != nil && !f.putBulk(e) {
			f.lg.Warn("flusher: outbound lane at bulk high-water; MSG_NEW dropped", "cid", m.Cid, "uid", member.UID)
		}
	}
}

// mediaLookupFromIndex adapts the pre-resolved media table to the resolver
// signature the payload builder expects.
func mediaLookupFromIndex(idx map[string]*store.Media) func(string) (*store.Media, bool) {
	if idx == nil {
		return nil
	}
	return func(id string) (*store.Media, bool) {
		rec, ok := idx[id]
		return rec, ok && rec != nil
	}
}

// mediaView is the client-facing media entry of the MSG_NEW content.
//
// Field names are the frontend contract (apps/client/src/net/proto/payload.ts
// mapMedia): snake_case, matching proto/chat.proto's Media message.
type mediaView struct {
	MediaID    string `json:"media_id"`
	MType      int32  `json:"mtype"`
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	Mime       string `json:"mime"`
	Width      uint32 `json:"width"`
	Height     uint32 `json:"height"`
	DurationMs uint32 `json:"duration_ms"`
	// ThumbInline is the inline thumbnail (base64 data-URI or bare base64).
	// The frontend renders it as the low-res placeholder while the real
	// image loads; without it the list shows an empty box.
	ThumbInline string `json:"thumb_inline,omitempty"`
	// Waveform is the 24-sample 0-100 amplitude array (JSON array as stored
	// in media_media.waveform). The frontend draws the real scrubber from
	// it; without it the audio bubble falls back to a pseudo-random shape.
	Waveform []int `json:"waveform,omitempty"`
	// Status is the media scan state as a CLIENT-FACING string
	// ("pending"|"uploading"|"ready"|"expired"|"failed"), matching the
	// frontend's MediaStatus union — NOT the numeric media_media.status.
	Status string `json:"status,omitempty"`
}

// msgNewContent is the stored message content (the uplink MSG_SEND payload).
// Both snake_case and camelCase spellings are accepted on input (the uplink
// may come from a client that uses either), but the downlink is ALWAYS
// snake_case (the server's unified downlink convention).
type msgNewContent struct {
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
		// Fields the client MAY already carry inline (the optimistic upload
		// path attaches them to the message): they are used as a fallback
		// when the media row has no thumbnail/waveform yet.
		ThumbInline string `json:"thumb_inline"`
		Waveform    []int  `json:"waveform"`
		Status      string `json:"status"`
	} `json:"media"`
}

// buildMsgNewPayload emits the client-facing snake_case JSON shape
// (MSG_NEW payload), embedding the stored message content as a JSON object
// rather than base64 bytes.
//
// The media[] entries are ENRICHED with the store-only fields (thumb_inline,
// waveform, status): the uplink content carries only the media reference, so
// without this lookup the receiving client gets no thumbnail and no audio
// waveform — the two fields the image/audio renderers depend on.
//
// The batch flush path resolves the whole batch's media rows once
// (resolveMediaBatch) and calls buildMsgNewPayloadWithMedia directly; this
// method is the single-message path used by the SYNC gap replay, where one
// message's media rows are resolved on demand.
func (f *flusher) buildMsgNewPayload(m store.PendingMsg) []byte {
	return buildMsgNewPayloadWithMedia(m, f.mediaLookup)
}

// mediaLookup resolves one media_id to its store row. Errors are swallowed
// (the caller falls back to the uplink content) — a missing media row must
// never break the message downlink.
func (f *flusher) mediaLookup(mediaID string) (*store.Media, bool) {
	if f.media == nil || mediaID == "" {
		return nil, false
	}
	rec, err := f.media.Get(context.Background(), mediaID)
	if err != nil || rec == nil {
		return nil, false
	}
	return rec, true
}

// buildMsgNewPayloadWithMedia is the pure builder: it takes the media
// resolver as a function so the batch path can resolve MANY media ids with
// ONE store round trip (no N+1).
func buildMsgNewPayloadWithMedia(m store.PendingMsg, lookup func(string) (*store.Media, bool)) []byte {
	var c msgNewContent
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
	media := make([]mediaView, 0, len(c.Media))
	for _, mm := range c.Media {
		id := mm.MediaID
		if id == "" {
			id = mm.MediaIDCam
		}
		dm := mm.DurationMs
		if dm == 0 {
			dm = mm.DurationMc
		}
		v := mediaView{
			MediaID:    id,
			MType:      mm.MType,
			Name:       mm.Name,
			Size:       mm.Size,
			Mime:       mm.Mime,
			Width:      mm.Width,
			Height:     mm.Height,
			DurationMs: dm,
			// Fallbacks first: what the client already attached inline.
			ThumbInline: mm.ThumbInline,
			Waveform:    mm.Waveform,
			Status:      mm.Status,
		}
		if lookup != nil {
			if rec, ok := lookup(id); ok {
				applyMediaRecord(&v, rec)
			}
		}
		if v.Status == "" {
			v.Status = mediaStatusReady
		}
		media = append(media, v)
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
		Recalled int64           `json:"recalled,omitempty"`
		Content  json.RawMessage `json:"content"`
	}{
		MsgID: uint64(m.MsgID), Seq: uint64(m.Seq), SenderID: uint64(m.SenderID),
		SentAt: m.SentAt * 1000, ConvID: uint64(m.Cid),
		Recalled: m.Recalled, Content: content,
	})
	return out
}

// mediaStatus* are the client-facing media status strings (frontend's
// MediaStatus union). The numeric media_media.status maps onto them here.
const (
	mediaStatusPending   = "pending"
	mediaStatusUploading = "uploading"
	mediaStatusReady     = "ready"
	mediaStatusExpired   = "expired"
	mediaStatusFailed    = "failed"
)

// applyMediaRecord overlays the store row onto the downlink media entry.
// The store is the authority for thumb/waveform/status; the uplink content
// only fills the gaps.
func applyMediaRecord(v *mediaView, rec *store.Media) {
	if rec == nil {
		return
	}
	if rec.Mime != "" {
		v.Mime = rec.Mime
	}
	if rec.Name != "" {
		v.Name = rec.Name
	}
	if rec.Size > 0 {
		v.Size = rec.Size
	}
	if rec.Width > 0 {
		v.Width = uint32(rec.Width)
	}
	if rec.Height > 0 {
		v.Height = uint32(rec.Height)
	}
	if rec.DurationMS > 0 {
		v.DurationMs = uint32(rec.DurationMS)
	}
	if rec.ThumbData != "" {
		v.ThumbInline = rec.ThumbData
	}
	if w := parseWaveform(rec.Waveform); len(w) > 0 {
		v.Waveform = w
	}
	v.Status = mediaStatusFromStore(rec.Status)
}

// mediaStatusFromStore maps the numeric media_media.status to the client's
// string enum: 0 scanning → pending, 1 usable → ready, 2 violation → failed.
// An unknown value degrades to "pending" (never "ready": claiming a usable
// asset for a row we do not understand is the unsafe direction).
func mediaStatusFromStore(status int) string {
	switch status {
	case 1:
		return mediaStatusReady
	case 2:
		return mediaStatusFailed
	case 0:
		return mediaStatusPending
	default:
		return mediaStatusPending
	}
}

// parseWaveform parses the stored waveform column (a JSON array of 0-100
// ints) into a bounded int slice. A malformed column yields nil (the client
// then falls back to its pseudo-random shape) — never an error.
func parseWaveform(raw string) []int {
	if raw == "" {
		return nil
	}
	var out []int
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	if len(out) > maxWaveformSamples {
		out = out[:maxWaveformSamples]
	}
	for i, v := range out {
		if v < 0 {
			out[i] = 0
		}
		if v > 100 {
			out[i] = 100
		}
	}
	return out
}

// maxWaveformSamples bounds the waveform array (the frontend slices to 24).
const maxWaveformSamples = 24

// emit sends the ack env for one message (status 0 = ok) on the outbound
// lane. Non-blocking: the lane is bounded and the client's retry path
// (dedup memory + DB UNIQUE) is the safety net for a dropped ack.
func (f *flusher) emit(m store.PendingMsg, status uint32, reason string) {
	e := buildAckEnv(m.SenderID, m.Cid, m.ClientMsgID, m.MsgID, m.Seq, status)
	// ACK goes through the full-capacity path: bulk fan-out is capped below the
	// high-water mark so the round trip the client is waiting on always fits.
	f.putAck(e)
}
