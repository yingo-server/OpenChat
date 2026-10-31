package pipe

// call.go: WebRTC call signaling relay (kinds 350-354).
//
// RED LINE: the data layer is a signaling switchboard ONLY. It never sees,
// inspects or relays media — there is no SFU, no transcoding, no SDP munging.
// An OFFER/ANSWER/CANDIDATE payload is an opaque JSON string carried verbatim
// to the peer; only the routing fields (callId/convId/toUserId) are read and
// only fromUserId is rewritten (to the authenticated sender, never trusted
// from the client).
//
// State is process-local (map[callId]*callState). A call is "ringing" from
// OFFER until ANSWER (then "active") or until the ring timeout fires, at which
// point both parties receive CALL_HANGUP{reason:"timeout"} and the entry is
// cleared. Mechanism, not policy: no call records, no history, no quotas.

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/data/pipe/wire"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
)

const (
	callStateRinging = "ringing"
	callStateActive  = "active"

	// defaultCallRingTimeout is the ring window before a caller/callee pair
	// is auto-hung-up. Exposed as a field (callRegistry.timeout) so tests can
	// inject a short value.
	defaultCallRingTimeout = 60 * time.Second
)

// callState is one in-progress call. convID/from/to are the routing identity;
// timer is the ring-timeout AfterFunc (stopped on answer/hangup/clear).
type callState struct {
	convID    int64
	from      int64
	to        int64
	startedAt time.Time
	state     string
	timer     *time.Timer
}

// callRegistry is the guarded in-process call table plus a reverse index
// (userInCall: uid → callId) used to answer "is this callee already busy?".
type callRegistry struct {
	mu         sync.Mutex
	calls      map[string]*callState
	userInCall map[int64]string
	timeout    time.Duration
}

func newCallRegistry() *callRegistry {
	return &callRegistry{
		calls:      make(map[string]*callState),
		userInCall: make(map[int64]string),
		timeout:    defaultCallRingTimeout,
	}
}

// busy reports whether uid is currently a party of a ringing/active call.
func (c *callRegistry) busy(uid int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.userInCall[uid]
	return ok
}

// create inserts a new ringing call and arms its ring-timeout timer. The timer
// callback runs onRingTimeout(callID, from, to, convID); it is created OUTSIDE
// the lock's critical send path (we set c.afterFunc then arm under lock).
func (c *callRegistry) create(callID string, convID, from, to int64, onRingTimeout func()) *callState {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := &callState{convID: convID, from: from, to: to, startedAt: time.Now(), state: callStateRinging}
	if c.timeout > 0 {
		id := callID
		st.timer = time.AfterFunc(c.timeout, func() { c.fireTimeout(id, onRingTimeout) })
	}
	c.calls[callID] = st
	c.userInCall[from] = callID
	c.userInCall[to] = callID
	return st
}

// fireTimeout runs on a timer goroutine: only fires if the call is still
// ringing (an ANSWER stops the timer, but a racing fire is guarded here).
func (c *callRegistry) fireTimeout(callID string, onRingTimeout func()) {
	c.mu.Lock()
	st, ok := c.calls[callID]
	if !ok || st.state != callStateRinging {
		c.mu.Unlock()
		return
	}
	delete(c.calls, callID)
	delete(c.userInCall, st.from)
	delete(c.userInCall, st.to)
	c.mu.Unlock()
	if onRingTimeout != nil {
		onRingTimeout()
	}
}

// get returns the call state (nil when absent).
func (c *callRegistry) get(callID string) *callState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls[callID]
}

// answer transitions ringing → active and stops the ring timer. Returns false
// when the call is missing.
func (c *callRegistry) answer(callID string) (*callState, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	st, ok := c.calls[callID]
	if !ok {
		return nil, false
	}
	if st.state != callStateRinging {
		return st, false
	}
	st.state = callStateActive
	if st.timer != nil {
		st.timer.Stop()
		st.timer = nil
	}
	return st, true
}

// remove deletes a call and clears the reverse index (HANGUP/BUSY). Returns the
// state (nil when absent) so the caller can forward to the peer.
func (c *callRegistry) remove(callID string) *callState {
	c.mu.Lock()
	defer c.mu.Unlock()
	st, ok := c.calls[callID]
	if !ok {
		return nil
	}
	delete(c.calls, callID)
	delete(c.userInCall, st.from)
	delete(c.userInCall, st.to)
	if st.timer != nil {
		st.timer.Stop()
		st.timer = nil
	}
	return st
}

// stopAll stops every armed timer (Drain). State is dropped with the process.
func (c *callRegistry) stopAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, st := range c.calls {
		if st.timer != nil {
			st.timer.Stop()
		}
	}
	c.calls = make(map[string]*callState)
	c.userInCall = make(map[int64]string)
}

// onCall is the dispatch entry for kinds 350-354.
func (p *Pipe) onCall(ctx context.Context, req Req) {
	if !p.callsEnabled(ctx) {
		p.reply(buildErrEnv(req, 403, "calls disabled"))
		return
	}
	var sig wire.CallSignal
	if len(req.Payload) > 0 {
		if err := wire.Unmarshal(req.Payload, &sig); err != nil {
			p.reply(buildErrEnv(req, 400, "bad payload"))
			return
		}
	}
	sender := int64(req.UserID)

	switch req.Kind {
	case uint32(kinds.KindCallOffer):
		p.onCallOffer(ctx, req, sig, sender)
	case uint32(kinds.KindCallAnswer):
		p.onCallAnswer(ctx, req, sig, sender)
	case uint32(kinds.KindCallCandidate):
		p.onCallRelay(ctx, req, sig, sender)
	case uint32(kinds.KindCallBusy), uint32(kinds.KindCallHangup):
		p.onCallTeardown(ctx, req, sig, sender)
	default:
		p.reply(buildErrEnv(req, 400, "bad call kind"))
	}
}

// onCallOffer: permission-gate both parties, auto-BUSY a busy callee, else
// open a ringing call and relay the offer to the callee.
func (p *Pipe) onCallOffer(ctx context.Context, req Req, sig wire.CallSignal, sender int64) {
	convID := int64(sig.ConvID)
	if convID == 0 {
		convID = int64(req.ConvID)
	}
	to := int64(sig.ToUserID)
	if convID == 0 || to == 0 || sender == 0 || sig.CallID == "" {
		p.reply(buildErrEnv(req, 400, "bad offer"))
		return
	}
	if !p.bothMembers(ctx, convID, sender, to) {
		p.reply(buildErrEnv(req, 403, "not a member"))
		return
	}
	// Callee already in a call → answer the caller with CALL_BUSY(busy).
	if p.calls.busy(to) {
		pl, _ := wire.Marshal(wire.CallSignal{CallID: sig.CallID, Reason: "busy", FromUserID: uint64(sender)})
		p.reply(&env{Kind: uint32(kinds.KindCallBusy), ConvID: uint64(convID), UserID: uint64(sender), Payload: pl})
		return
	}
	p.calls.create(sig.CallID, convID, sender, to, func() {
		p.sendCallTimeout(sig.CallID, convID, sender, to)
	})
	p.relayCall(req, sig, sender, to)
}

// onCallAnswer: the call must exist and still be ringing; flip to active and
// relay the answer to the caller.
func (p *Pipe) onCallAnswer(ctx context.Context, req Req, sig wire.CallSignal, sender int64) {
	st := p.calls.get(sig.CallID)
	if st == nil {
		p.reply(buildErrEnv(req, 404, "no such call"))
		return
	}
	// Authorize BEFORE mutating state (a forged answer must not flip the call).
	peer := peerOf(st, sender)
	if !p.bothMembers(ctx, st.convID, sender, peer) {
		p.reply(buildErrEnv(req, 403, "not a member"))
		return
	}
	if _, ok := p.calls.answer(sig.CallID); !ok {
		p.reply(buildErrEnv(req, 404, "no such call"))
		return
	}
	p.relayCall(req, sig, sender, peer)
}

// onCallRelay: CANDIDATE — no state change; locate the peer via the call table
// and forward verbatim.
func (p *Pipe) onCallRelay(ctx context.Context, req Req, sig wire.CallSignal, sender int64) {
	st := p.calls.get(sig.CallID)
	if st == nil {
		p.reply(buildErrEnv(req, 404, "no such call"))
		return
	}
	peer := peerOf(st, sender)
	if !p.bothMembers(ctx, st.convID, sender, peer) {
		p.reply(buildErrEnv(req, 403, "not a member"))
		return
	}
	p.relayCall(req, sig, sender, peer)
}

// onCallTeardown: BUSY/HANGUP — permission-gate, clear state, relay to peer.
func (p *Pipe) onCallTeardown(ctx context.Context, req Req, sig wire.CallSignal, sender int64) {
	st := p.calls.get(sig.CallID)
	if st == nil {
		p.reply(buildErrEnv(req, 404, "no such call"))
		return
	}
	peer := peerOf(st, sender)
	if !p.bothMembers(ctx, st.convID, sender, peer) {
		p.reply(buildErrEnv(req, 403, "not a member"))
		return
	}
	p.calls.remove(sig.CallID)
	p.relayCall(req, sig, sender, peer)
}

// relayCall rewrites FromUserID to the real sender and emits the frame to
// targetUID. The env.UserID IS the delivery target (installEmit turns it into
// Envelope.UserId, and the user gateway's downstream router delivers by uid).
func (p *Pipe) relayCall(req Req, sig wire.CallSignal, sender, targetUID int64) {
	sig.FromUserID = uint64(sender)
	pl, _ := wire.Marshal(sig)
	p.reply(&env{Kind: req.Kind, ConvID: sig.ConvID, UserID: uint64(targetUID), Payload: pl})
}

// sendCallTimeout fires from the ring timer: it emits CALL_HANGUP(timeout) to
// both parties and the entry has already been cleared by fireTimeout.
func (p *Pipe) sendCallTimeout(callID string, convID, from, to int64) {
	pl, _ := wire.Marshal(wire.CallSignal{
		CallID: callID, ConvID: uint64(convID), Reason: "timeout", FromUserID: uint64(from),
	})
	p.reply(&env{Kind: uint32(kinds.KindCallHangup), ConvID: uint64(convID), UserID: uint64(from), Payload: pl})
	p.reply(&env{Kind: uint32(kinds.KindCallHangup), ConvID: uint64(convID), UserID: uint64(to), Payload: pl})
}

// bothMembers is the security red line: BOTH the sender and the peer (callee or
// the other party) must belong to convID, else the signal is dropped (403).
func (p *Pipe) bothMembers(ctx context.Context, convID, a, b int64) bool {
	if a == 0 || b == 0 {
		return false
	}
	if _, err := p.hot.CheckMember(ctx, convID, a); err != nil {
		return false
	}
	if _, err := p.hot.CheckMember(ctx, convID, b); err != nil {
		return false
	}
	return true
}

// peerOf returns the OTHER party of a two-party call given one side.
func peerOf(st *callState, who int64) int64 {
	if who == st.to {
		return st.from
	}
	return st.to
}

// callsEnabled reads sys_feature_flags.call_enabled; absent = false (default
// off). The flag row holds JSON ("true"/"false") as written by bootstrapFlags.
func (p *Pipe) callsEnabled(ctx context.Context) bool {
	flags, err := p.hot.AllFlags(ctx)
	if err != nil {
		return false
	}
	for _, f := range flags {
		if f.Key != "call_enabled" {
			continue
		}
		var b bool
		if err := json.Unmarshal([]byte(f.Value), &b); err == nil {
			return b
		}
		return f.Value == "true"
	}
	return false
}
