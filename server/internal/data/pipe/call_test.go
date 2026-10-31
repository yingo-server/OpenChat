package pipe

// call_test.go: unit coverage for the WebRTC call-signaling relay (kinds
// 350-354). These exercise the dispatcher directly (no peer): state machine,
// permission red line, auto-BUSY, teardown, ring timeout and the flag gate.

import (
	"context"
	"testing"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/data/pipe/wire"
	"github.com/yingo-server/OpenChat/server/internal/data/store"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
)

// enableCalls flips sys_feature_flags.call_enabled on in the fake sys store.
func enableCalls(t *testing.T, sys interface {
	UpsertFlag(context.Context, *store.Flag) error
}) {
	t.Helper()
	if err := sys.UpsertFlag(context.Background(), &store.Flag{Key: "call_enabled", Value: "true"}); err != nil {
		t.Fatalf("enable calls: %v", err)
	}
}

// twoMemberConv creates a conversation owned by 7 with 8 added as a member.
func twoMemberConv(t *testing.T, p *Pipe, convs interface {
	CreateConv(context.Context, *store.ConvMeta, int64) (int64, error)
	AddMember(context.Context, *store.Member) error
}) int64 {
	t.Helper()
	ctx := context.Background()
	cid, err := convs.CreateConv(ctx, &store.ConvMeta{CType: 2, CreatedBy: 7, CreatedAt: 1}, 7)
	if err != nil {
		t.Fatalf("create conv: %v", err)
	}
	if err := convs.AddMember(ctx, &store.Member{Cid: cid, UID: 8, Role: 1, JoinedAt: 1}); err != nil {
		t.Fatalf("add member: %v", err)
	}
	return cid
}

func offerPayload(cid int64, callID string, from, to int64) string {
	b, _ := wire.Marshal(wire.CallSignal{
		CallID: callID, ConvID: uint64(cid), ToUserID: uint64(to),
		SDP: "v=0 offer", Media: "audio", FromUserID: uint64(from), // bogus from, must be ignored
	})
	return string(b)
}

func decodeCall(t *testing.T, e *env) wire.CallSignal {
	t.Helper()
	var s wire.CallSignal
	if err := wire.Unmarshal(e.Payload, &s); err != nil {
		t.Fatalf("decode call signal: %v (payload %s)", err, e.Payload)
	}
	return s
}

// TestCallSignalRelay: A→B offer is forwarded to B with fromUserId forced to A.
func TestCallSignalRelay(t *testing.T) {
	p, _, convs, sys := newTestPipe(t)
	enableCalls(t, sys)
	cid := twoMemberConv(t, p, convs)
	ctx := context.Background()

	// Client lies: fromUserId=999 in the payload.
	p.dispatchReq(ctx, mkReq(uint32(kinds.KindCallOffer), cid, 7, offerPayload(cid, "c-relay", 999, 8)))
	e := waitEnv(t, p.Outbound())
	if e.Kind != uint32(kinds.KindCallOffer) {
		t.Fatalf("relayed kind = %d, want 350 (%s)", e.Kind, e.Payload)
	}
	if e.UserID != 8 {
		t.Fatalf("relayed target = %d, want 8 (callee)", e.UserID)
	}
	sig := decodeCall(t, e)
	if sig.FromUserID != 7 {
		t.Fatalf("fromUserId = %d, want 7 (server must backfill real sender)", sig.FromUserID)
	}
	if sig.CallID != "c-relay" || sig.SDP != "v=0 offer" {
		t.Fatalf("payload mutated: %+v", sig)
	}
}

// TestCallNonMemberRejected: a non-member OFFER gets 403 and is not forwarded.
func TestCallNonMemberRejected(t *testing.T) {
	p, _, convs, sys := newTestPipe(t)
	enableCalls(t, sys)
	ctx := context.Background()
	// Conv owned by 7; user 8 is NOT a member.
	cid, _ := convs.CreateConv(ctx, &store.ConvMeta{CType: 2, CreatedBy: 7, CreatedAt: 1}, 7)

	p.dispatchReq(ctx, mkReq(uint32(kinds.KindCallOffer), cid, 7, offerPayload(cid, "c-nonmember", 7, 8)))
	e := waitEnv(t, p.Outbound())
	if e.Kind != uint32(kinds.KindError) {
		t.Fatalf("kind = %d, want ERROR (%s)", e.Kind, e.Payload)
	}
	var er struct {
		Code uint32 `json:"code"`
	}
	_ = wire.Unmarshal(e.Payload, &er)
	if er.Code != 403 {
		t.Fatalf("code = %d, want 403 (%s)", er.Code, e.Payload)
	}
	// Nothing else must be emitted (no forwarding).
	select {
	case extra := <-p.Outbound():
		t.Fatalf("unexpected extra frame (kind %d) — non-member offer was forwarded", extra.Kind)
	default:
	}
}

// TestCallBusyWhenPeerInCall: offering to a callee already ringing answers the
// second caller with CALL_BUSY(busy) instead of forwarding.
func TestCallBusyWhenPeerInCall(t *testing.T) {
	p, _, convs, sys := newTestPipe(t)
	enableCalls(t, sys)
	ctx := context.Background()
	cid, _ := convs.CreateConv(ctx, &store.ConvMeta{CType: 2, CreatedBy: 7, CreatedAt: 1}, 7)
	_ = convs.AddMember(ctx, &store.Member{Cid: cid, UID: 8, Role: 1, JoinedAt: 1})
	_ = convs.AddMember(ctx, &store.Member{Cid: cid, UID: 9, Role: 1, JoinedAt: 1})

	// 7 → 8 (callee 8 now ringing).
	p.dispatchReq(ctx, mkReq(uint32(kinds.KindCallOffer), cid, 7, offerPayload(cid, "c-first", 7, 8)))
	first := waitEnv(t, p.Outbound())
	if first.Kind != uint32(kinds.KindCallOffer) || first.UserID != 8 {
		t.Fatalf("first offer not relayed to 8: kind=%d uid=%d", first.Kind, first.UserID)
	}

	// 9 → 8: callee busy → CALL_BUSY(busy) back to 9.
	p.dispatchReq(ctx, mkReq(uint32(kinds.KindCallOffer), cid, 9, offerPayload(cid, "c-second", 9, 8)))
	e := waitEnv(t, p.Outbound())
	if e.Kind != uint32(kinds.KindCallBusy) {
		t.Fatalf("kind = %d, want CALL_BUSY 353 (%s)", e.Kind, e.Payload)
	}
	if e.UserID != 9 {
		t.Fatalf("busy target = %d, want 9 (second caller)", e.UserID)
	}
	sig := decodeCall(t, e)
	if sig.Reason != "busy" {
		t.Fatalf("reason = %q, want busy", sig.Reason)
	}
}

// TestCallHangupClearsState: HANGUP is relayed to the peer and clears the table
// so the callee is free again.
func TestCallHangupClearsState(t *testing.T) {
	p, _, convs, sys := newTestPipe(t)
	enableCalls(t, sys)
	cid := twoMemberConv(t, p, convs)
	ctx := context.Background()

	p.dispatchReq(ctx, mkReq(uint32(kinds.KindCallOffer), cid, 7, offerPayload(cid, "c-hang", 7, 8)))
	if e := waitEnv(t, p.Outbound()); e.Kind != uint32(kinds.KindCallOffer) {
		t.Fatalf("offer not relayed: kind=%d", e.Kind)
	}
	if p.calls.get("c-hang") == nil {
		t.Fatal("call state not created on OFFER")
	}

	hp, _ := wire.Marshal(wire.CallSignal{CallID: "c-hang", Reason: "hangup", FromUserID: 7})
	p.dispatchReq(ctx, mkReq(uint32(kinds.KindCallHangup), 0, 7, string(hp)))
	e := waitEnv(t, p.Outbound())
	if e.Kind != uint32(kinds.KindCallHangup) {
		t.Fatalf("hangup kind = %d, want 354 (%s)", e.Kind, e.Payload)
	}
	if e.UserID != 8 {
		t.Fatalf("hangup target = %d, want 8", e.UserID)
	}
	if p.calls.get("c-hang") != nil {
		t.Fatal("call state not cleared after HANGUP")
	}
	if p.calls.busy(8) {
		t.Fatal("callee still marked busy after HANGUP")
	}
}

// TestCallDisabledByFlag: with call_enabled=false every signal answers 403 and
// nothing is relayed.
func TestCallDisabledByFlag(t *testing.T) {
	p, _, convs, _ := newTestPipe(t) // no enableCalls → flag absent → default false
	cid := twoMemberConv(t, p, convs)
	ctx := context.Background()

	p.dispatchReq(ctx, mkReq(uint32(kinds.KindCallOffer), cid, 7, offerPayload(cid, "c-off", 7, 8)))
	e := waitEnv(t, p.Outbound())
	if e.Kind != uint32(kinds.KindError) {
		t.Fatalf("kind = %d, want ERROR (%s)", e.Kind, e.Payload)
	}
	var er struct {
		Code   uint32 `json:"code"`
		Reason string `json:"reason"`
	}
	_ = wire.Unmarshal(e.Payload, &er)
	if er.Code != 403 || er.Reason != "calls disabled" {
		t.Fatalf("got %+v, want 403 calls disabled", er)
	}
	select {
	case extra := <-p.Outbound():
		t.Fatalf("call forwarded while disabled (kind %d)", extra.Kind)
	default:
	}
}

// TestCallRingTimeout: an unanswered ringing call is auto-hung-up to BOTH
// parties with reason=timeout after the (injected, short) ring window.
func TestCallRingTimeout(t *testing.T) {
	p, _, convs, sys := newTestPipe(t)
	enableCalls(t, sys)
	cid := twoMemberConv(t, p, convs)
	ctx := context.Background()

	// Injected short ring window (production default is 60s).
	p.calls.timeout = 30 * time.Millisecond

	p.dispatchReq(ctx, mkReq(uint32(kinds.KindCallOffer), cid, 7, offerPayload(cid, "c-timeout", 7, 8)))
	if e := waitEnv(t, p.Outbound()); e.Kind != uint32(kinds.KindCallOffer) {
		t.Fatalf("offer not relayed: kind=%d", e.Kind)
	}

	// Expect a CALL_HANGUP(reason=timeout) for each party (uid 7 and uid 8).
	got := map[uint64]bool{}
	deadline := time.After(2 * time.Second)
	for len(got) < 2 {
		select {
		case e := <-p.Outbound():
			if e.Kind != uint32(kinds.KindCallHangup) {
				continue
			}
			sig := decodeCall(t, e)
			if sig.Reason != "timeout" {
				t.Fatalf("timeout reason = %q", sig.Reason)
			}
			got[e.UserID] = true
		case <-deadline:
			t.Fatalf("ring timeout did not fire; got %v", got)
		}
	}
	if !got[7] || !got[8] {
		t.Fatalf("timeout not delivered to both parties: %v", got)
	}
	if p.calls.get("c-timeout") != nil {
		t.Fatal("timed-out call not cleared")
	}
}
