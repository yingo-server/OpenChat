package pipe

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/data/pipe/pipefakes"
	"github.com/yingo-server/OpenChat/server/internal/data/pipe/wire"
	"github.com/yingo-server/OpenChat/server/internal/data/store"
	"github.com/yingo-server/OpenChat/server/internal/pkg/log"
	"github.com/yingo-server/OpenChat/server/internal/proto"
)

// hotBundle adapts the fakes into HotStores (one struct, per-domain fields).
type hotBundle struct {
	w    store.MsgWriter
	r    store.MsgReader
	conv store.ConvStore
	sys  store.SysStore
}

func (h hotBundle) AppendMessages(ctx context.Context, b []store.PendingMsg) error {
	return h.w.AppendMessages(ctx, b)
}
func (h hotBundle) AllocateSeq(ctx context.Context, cid int64, n int) (int64, error) {
	return h.w.AllocateSeq(ctx, cid, n)
}
func (h hotBundle) ReadHot(ctx context.Context, cid int64, b int64, l int, a bool) ([]store.HotMsg, error) {
	return h.r.ReadHot(ctx, cid, b, l, a)
}
func (h hotBundle) FirstSeqAfter(ctx context.Context, cid int64, s int64) (int64, error) {
	return h.r.FirstSeqAfter(ctx, cid, s)
}
func (h hotBundle) UpsertUser(ctx context.Context, u *store.User) error { return nil }
func (h hotBundle) LookupByIdentity(ctx context.Context, a int, b string) (int64, error) {
	return 0, store.ErrNotFound
}
func (h hotBundle) GetUser(ctx context.Context, uid int64) (*store.User, error) {
	return nil, store.ErrNotFound
}
func (h hotBundle) GetBan(ctx context.Context, uid int64) (*store.Ban, error) { return nil, nil }
func (h hotBundle) SetBan(ctx context.Context, b *store.Ban) error            { return nil }
func (h hotBundle) CreateConv(ctx context.Context, m *store.ConvMeta, c int64) (int64, error) {
	return h.conv.CreateConv(ctx, m, c)
}
func (h hotBundle) AddMember(ctx context.Context, m *store.Member) error {
	return h.conv.AddMember(ctx, m)
}
func (h hotBundle) RemoveMember(ctx context.Context, cid, uid int64) error {
	return h.conv.RemoveMember(ctx, cid, uid)
}
func (h hotBundle) CheckMember(ctx context.Context, cid, uid int64) (*store.Member, error) {
	return h.conv.CheckMember(ctx, cid, uid)
}
func (h hotBundle) ListMembers(ctx context.Context, cid int64) ([]store.Member, error) {
	return h.conv.ListMembers(ctx, cid)
}
func (h hotBundle) SetMemberRole(ctx context.Context, cid, uid int64, role int) error {
	return h.conv.SetMemberRole(ctx, cid, uid, role)
}
func (h hotBundle) GetConvMeta(ctx context.Context, cid int64) (*store.ConvMeta, error) {
	return h.conv.GetConvMeta(ctx, cid)
}
func (h hotBundle) NextSeq(ctx context.Context, cid int64) (int64, error) {
	return h.conv.NextSeq(ctx, cid)
}
func (h hotBundle) UpsertFlag(ctx context.Context, f *store.Flag) error {
	return h.sys.UpsertFlag(ctx, f)
}
func (h hotBundle) AllFlags(ctx context.Context) ([]store.Flag, error) { return h.sys.AllFlags(ctx) }
func (h hotBundle) UpsertPresence(ctx context.Context, p *store.Presence) error {
	return h.sys.UpsertPresence(ctx, p)
}
func (h hotBundle) GetPresence(ctx context.Context, uid int64) (*store.Presence, error) {
	return h.sys.GetPresence(ctx, uid)
}
func (h hotBundle) RateLimitIncr(ctx context.Context, s, a string, w int64) (*store.RateWindow, error) {
	return h.sys.RateLimitIncr(ctx, s, a, w)
}
func (h hotBundle) GetPenalty(ctx context.Context, s, p string) (*store.Penalty, error) {
	return h.sys.GetPenalty(ctx, s, p)
}
func (h hotBundle) SetPenalty(ctx context.Context, p *store.Penalty) error {
	return h.sys.SetPenalty(ctx, p)
}

func newTestPipe(t *testing.T) (*Pipe, *pipefakes.FakeMsgStore, *pipefakes.FakeConvStore, *pipefakes.FakeSysStore) {
	t.Helper()
	msgs := pipefakes.NewFakeMsgStore()
	convs := pipefakes.NewFakeConvStore()
	sys := pipefakes.NewFakeSysStore()
	p := NewStores(nil, hotBundle{w: msgs, r: msgs, conv: convs, sys: sys}, ColdDeps{}, log.For("data-test"))
	p.fl.interval = 5 * time.Millisecond
	return p, msgs, convs, sys
}

func mkReq(kind uint32, cid, uid int64, pl string) Req {
	return Req{Kind: kind, ConvID: uint64(cid), UserID: uint64(uid), Payload: []byte(pl)}
}

func decodeAck(t *testing.T, e *env) wire.MsgAck {
	t.Helper()
	var a wire.MsgAck
	if err := wire.Unmarshal(e.Payload, &a); err != nil {
		t.Fatalf("ack decode: %v (payload %s)", err, e.Payload)
	}
	return a
}

// full chain: kind 101 frame → gates → seqalloc → flusher → ack on outbound.
func TestFullChainMsgSendAck(t *testing.T) {
	p, msgs, convs, _ := newTestPipe(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.fl.run(ctx)
	go p.senderOf()
	cid, _ := convs.CreateConv(ctx, &store.ConvMeta{CType: 2, CreatedBy: 7, CreatedAt: 1}, 7)

	p.dispatchReq(ctx, mkReq(101, cid, 7, `{"clientMsgId":"c1","text":"hello"}`))
	e := waitEnv(t, p.Outbound())
	a := decodeAck(t, e)
	if a.ClientMsgID != "c1" || a.Seq != 1 || a.Status != 0 || a.MsgID == 0 {
		t.Fatalf("ack: %+v", a)
	}
	if got := msgs.Snapshot(); len(got) != 1 || got[0].Seq != 1 || string(got[0].Content) != `{"clientMsgId":"c1","text":"hello"}` {
		t.Fatalf("stored: %+v", got)
	}
}

// senderOf exists because NewStores has peer == nil in unit tests; the
// production sender goroutine is started by Run.
func (p *Pipe) senderOf() { close(p.senderDone) }

// idempotent resend: same client_msg_id → replayed ack, no second row.
func TestDedupReplay(t *testing.T) {
	p, msgs, convs, _ := newTestPipe(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.fl.run(ctx)
	cid, _ := convs.CreateConv(ctx, &store.ConvMeta{CType: 2, CreatedBy: 7, CreatedAt: 1}, 7)

	body := `{"clientMsgId":"dup","text":"x"}`
	p.dispatchReq(ctx, mkReq(101, cid, 7, body))
	first := decodeAck(t, waitEnv(t, p.Outbound()))
	if first.Seq != 1 || first.MsgID == 0 {
		t.Fatalf("first ack: %+v", first)
	}
	p.dispatchReq(ctx, mkReq(101, cid, 7, body))
	second := decodeAck(t, waitEnv(t, p.Outbound()))
	if second.Seq != first.Seq || second.MsgID != first.MsgID {
		t.Fatalf("replay ack differs: first=%+v second=%+v", first, second)
	}
	time.Sleep(30 * time.Millisecond)
	if len(msgs.Snapshot()) != 1 {
		t.Fatalf("dedup re-enqueued: %d rows", len(msgs.Snapshot()))
	}
	if msgs.Batches != 1 {
		t.Fatalf("expected one commit, got %d", msgs.Batches)
	}
}

// 越权: non-member write → 403 frame; store untouched.
func TestUnauthorized403(t *testing.T) {
	p, msgs, convs, _ := newTestPipe(t)
	ctx := context.Background()
	cid, _ := convs.CreateConv(ctx, &store.ConvMeta{CType: 2, CreatedBy: 7, CreatedAt: 1}, 7)

	p.dispatchReq(ctx, mkReq(101, cid, 8, `{"clientMsgId":"nope","text":"x"}`))
	e := waitEnv(t, p.Outbound())
	var er struct {
		Code uint32 `json:"code,omitempty"`
	}
	if err := wire.Unmarshal(e.Payload, &er); err != nil || er.Code != 403 {
		t.Fatalf("want 403, got kind=%d payload=%s err=%v", e.Kind, e.Payload, err)
	}
	time.Sleep(20 * time.Millisecond)
	if len(msgs.Snapshot()) != 0 {
		t.Fatal("unauthorized message reached the store")
	}
}

// writech full → immediate BUSY NACK (503), never blocking.
func TestWriteChFullBusy(t *testing.T) {
	p, _, convs, _ := newTestPipe(t)
	ctx := context.Background()
	cid, _ := convs.CreateConv(ctx, &store.ConvMeta{CType: 2, CreatedBy: 7, CreatedAt: 1}, 7)

	for i := 0; i < writeChBuf; i++ {
		p.writeCh <- ReadyMsg{Msg: store.PendingMsg{Cid: cid, SenderID: 7, ClientMsgID: "f", MsgID: int64(1000 + i), Seq: int64(1000 + i), SentAt: 1}}
	}
	p.dispatchReq(ctx, mkReq(101, cid, 7, `{"clientMsgId":"busy","text":"x"}`))
	select {
	case e := <-p.Outbound():
		var er struct {
			Code   uint32 `json:"code,omitempty"`
			Reason string `json:"reason,omitempty"`
		}
		if err := wire.Unmarshal(e.Payload, &er); err != nil || er.Code != 503 || er.Reason != "busy" {
			t.Fatalf("want 503 busy, got %s", e.Payload)
		}
	default:
		t.Fatal("no immediate BUSY NACK")
	}
}

// flusher group commit + Drain flushes everything buffered.
func TestFlusherBatchAndDrain(t *testing.T) {
	p, msgs, convs, _ := newTestPipe(t)
	ctx := context.Background()
	cid, _ := convs.CreateConv(ctx, &store.ConvMeta{CType: 2, CreatedBy: 7, CreatedAt: 1}, 7)

	for i := 0; i < 10; i++ {
		p.writeCh <- ReadyMsg{Msg: store.PendingMsg{Cid: cid, SenderID: 7,
			ClientMsgID: "d" + itoa(int64(i)), MsgID: int64(i + 1), Seq: int64(i + 1), SentAt: 1}}
	}
	fctx, fcancel := context.WithCancel(ctx)
	defer fcancel()
	go p.fl.run(fctx)
	close(p.writeCh) // Drain path: close → final flush → flusher exits
	select {
	case <-p.fl.done:
	case <-time.After(2 * time.Second):
		t.Fatal("flusher did not drain")
	}
	if len(msgs.Snapshot()) != 10 {
		t.Fatalf("drain lost messages: %d/10", len(msgs.Snapshot()))
	}
	if msgs.Batches != 1 {
		t.Fatalf("expected single group commit, got %d", msgs.Batches)
	}
}

// batch failure → whole batch answers status 500.
func TestFlushBatchFailure(t *testing.T) {
	p, msgs, convs, _ := newTestPipe(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cid, _ := convs.CreateConv(ctx, &store.ConvMeta{CType: 2, CreatedBy: 7, CreatedAt: 1}, 7)
	msgs.AppendErr = errors.New("injected")
	p.fl.interval = 5 * time.Millisecond
	go p.fl.run(ctx)
	p.writeCh <- ReadyMsg{Msg: store.PendingMsg{Cid: cid, SenderID: 7, ClientMsgID: "f1", MsgID: 1, Seq: 1, SentAt: 1}}
	e := waitEnv(t, p.Outbound())
	if a := decodeAck(t, e); a.Status != 500 {
		t.Fatalf("want 500, got %+v", a)
	}
}

// readrouter: hot page + member gate + non-member 403.
func TestReadHistory(t *testing.T) {
	p, msgs, convs, _ := newTestPipe(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cid, _ := convs.CreateConv(ctx, &store.ConvMeta{CType: 2, CreatedBy: 7, CreatedAt: 1}, 7)
	for i := 1; i <= 3; i++ {
		_ = msgs.AppendMessages(ctx, []store.PendingMsg{{MsgID: int64(i), Cid: cid, Seq: int64(i), SenderID: 7,
			ClientMsgID: "r" + itoa(int64(i)), Content: []byte("m"), SentAt: int64(100 + i)}})
	}

	p.dispatchReq(ctx, Req{Kind: 920, ConvID: uint64(cid), UserID: 7,
		Payload: []byte(`{"convId":` + itoa(cid) + `,"limit":10}`)})
	e := waitEnv(t, p.Outbound())
	if e.Kind != 921 {
		t.Fatalf("want 921, got %d (%s)", e.Kind, e.Payload)
	}
	var res wire.ReadHistoryResult
	if err := wire.Unmarshal(e.Payload, &res); err != nil || len(res.Messages) != 3 {
		t.Fatalf("read result: %v msgs=%d", err, len(res.Messages))
	}
	// non-member read → 403
	p.dispatchReq(ctx, Req{Kind: 920, ConvID: uint64(cid), UserID: 99,
		Payload: []byte(`{"convId":` + itoa(cid) + `,"limit":10}`)})
	e = waitEnv(t, p.Outbound())
	var er struct {
		Code uint32 `json:"code,omitempty"`
	}
	wire.Unmarshal(e.Payload, &er)
	if er.Code != 403 {
		t.Fatalf("non-member read should 403, got %s", e.Payload)
	}
}

// flag get/set round trip (970/971 → 972).
func TestFlagLane(t *testing.T) {
	p, _, _, sys := newTestPipe(t)
	ctx := context.Background()
	p.dispatchReq(ctx, Req{Kind: 971, Payload: []byte(`{"key":"k","value":"v1","write":true}`)})
	e := waitEnv(t, p.Outbound())
	var fr wire.FlagResult
	if err := wire.Unmarshal(e.Payload, &fr); err != nil || fr.Flags["k"] != "v1" {
		t.Fatalf("flag result: %v %s", err, e.Payload)
	}
	if fl, _ := sys.AllFlags(ctx); len(fl) != 1 {
		t.Fatal("flag not stored")
	}
}

// Run/peer wiring: a real Peer frame enters through FrameSource and the ack
// exits through Emit + Send.
func TestRunWithPeer(t *testing.T) {
	p, _, convs, _ := newTestPipe(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cid, _ := convs.CreateConv(ctx, &store.ConvMeta{CType: 2, CreatedBy: 7, CreatedAt: 1}, 7)

	peer := NewTestPeer()
	p.peer = peer
	req := mkReq(101, cid, 7, `{"clientMsgId":"peer1","text":"hi"}`)
	p.FrameSource = func(*proto.Frame) Req { return req }

	var got *proto.Frame
	Emit = func(e *env) *proto.Frame {
		f := &proto.Frame{Kind: e.Kind}
		got = f
		return f
	}
	defer func() { Emit = DefaultEmit }()

	go p.Run(ctx)
	peer.Inject(&proto.Frame{Kind: 101})

	select {
	case f := <-peer.Sent():
		if f.Kind != 103 { // MSG_ACK
			t.Fatalf("sent kind = %d, want 103", f.Kind)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no frame sent to peer")
	}
	_ = got
}

// ------------------------------- helpers

func waitEnv(t *testing.T, ch <-chan *env) *env {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for outbound env")
		return nil
	}
}
