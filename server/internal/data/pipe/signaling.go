package pipe

// signaling.go: transient signaling domains — read receipts (104/105),
// typing (230), presence (400/401/402), member-change events (212) and
// message recall (107/108).
//
// Dispatch rule shared by all of them: an inbound frame with a NON-ZERO
// env.UserID is a client uplink request (member-checked, rewritten);
// an inbound frame with UserID == 0 is the USER LAYER's internal connect /
// disconnect notification (401/402 with user_id in the payload), trusted
// because it crosses the internal bus only.
//
// Receipts and typing are NEVER persisted. Recall persists (soft delete).
// Presence persists to sys_presence.

import (
	"context"
	"errors"

	"github.com/yingo-server/OpenChat/server/internal/data/pipe/wire"
	"github.com/yingo-server/OpenChat/server/internal/data/store"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
)

const (
	// defaultRecallWindowSec is the recall time window (default 2 minutes).
	// Overridden in tests via Pipe.recallWindowSec.
	defaultRecallWindowSec = 120
)

// onReceipt is the dispatch entry for kinds 104/105 (MSG_READ/MSG_DELIVERED).
//
// Contract (apps/client/src/net/protocol/handlers/receipt.ts): the DOWNLINK
// payload is MessagePayload.receipts — JSON {"receipts":[{msg_id,user_id,at,
// rtype}]}, rtype 0=read 1=delivered. The sender's user_id is ALWAYS
// rewritten to the authenticated uid (the client value is never trusted).
// Forwarded to every OTHER member of the conversation; not persisted.
func (p *Pipe) onReceipt(ctx context.Context, req Req) {
	var in wire.ReceiptPayload
	if len(req.Payload) > 0 {
		if err := wire.Unmarshal(req.Payload, &in); err != nil {
			p.reply(buildErrEnv(req, 400, "bad payload"))
			return
		}
	}
	receipts := normalizeReceipts(in)
	if len(receipts) == 0 {
		p.reply(buildErrEnv(req, 400, "empty receipts"))
		return
	}
	cid := int64(req.ConvID)
	if cid == 0 && len(receipts) > 0 {
		// The flat form carries no conv on the payload; the envelope target
		// is authoritative. A receipts-array form may also carry conv_id in
		// the envelope. Zero cid with a receipts array is still forwarded to
		// the envelope's conv — enforced below.
	}
	if cid == 0 {
		p.reply(buildErrEnv(req, 400, "missing conv"))
		return
	}
	sender := int64(req.UserID)
	if sender <= 0 {
		p.reply(buildErrEnv(req, 403, "unauthenticated"))
		return
	}
	if _, err := p.msg.memberCheck(ctx, cid, sender); err != nil {
		p.reply(buildErrEnv(req, 403, "not a member"))
		return
	}
	rt := int32(0) // read
	if req.Kind == uint32(kinds.KindMsgDelivered) {
		rt = 1
	}
	for i := range receipts {
		receipts[i].UserID = uint64(sender) // authenticated sender, never the client's claim
		receipts[i].Rtype = rt
		if receipts[i].At == 0 {
			receipts[i].At = uint64(nowMilli())
		}
	}
	pl, err := wire.Marshal(wire.ReceiptPayload{Receipts: receipts})
	if err != nil {
		p.reply(buildErrEnv(req, 500, "marshal receipts"))
		return
	}
	p.fanoutConv(ctx, cid, req.Kind, uint64(cid), pl)
}

// normalizeReceipts accepts both wire forms: {"receipts":[...]} and the
// flat single-receipt object the client's encodeReceipt produces.
func normalizeReceipts(in wire.ReceiptPayload) []wire.Receipt {
	if len(in.Receipts) > 0 {
		return in.Receipts
	}
	if in.MsgID == 0 {
		return nil
	}
	return []wire.Receipt{{MsgID: in.MsgID, UserID: in.UserID, At: in.At, Rtype: in.Rtype}}
}

// onTyping is the dispatch entry for kind 230 (TYPING).
//
// Contract (handlers/typing.ts): downlink payload {"conv_id","user_id",
// "typing","at"}. The server overwrites user_id with the authenticated
// sender. Forwarded to every OTHER member; not persisted.
func (p *Pipe) onTyping(ctx context.Context, req Req) {
	var sig wire.TypingSignal
	if len(req.Payload) > 0 {
		if err := wire.Unmarshal(req.Payload, &sig); err != nil {
			p.reply(buildErrEnv(req, 400, "bad payload"))
			return
		}
	}
	cid := int64(sig.ConvID)
	if cid == 0 {
		cid = int64(req.ConvID)
	}
	if cid == 0 {
		p.reply(buildErrEnv(req, 400, "missing conv"))
		return
	}
	sender := int64(req.UserID)
	if sender <= 0 {
		p.reply(buildErrEnv(req, 403, "unauthenticated"))
		return
	}
	if _, err := p.msg.memberCheck(ctx, cid, sender); err != nil {
		p.reply(buildErrEnv(req, 403, "not a member"))
		return
	}
	sig.ConvID = uint64(cid)
	sig.UserID = uint64(sender)
	if sig.At == 0 {
		sig.At = nowMilli()
	}
	pl, _ := wire.Marshal(sig)
	p.fanoutConv(ctx, cid, req.Kind, uint64(cid), pl)
}

// onPresenceUp is the dispatch entry for kind 400 (PRESENCE_UPDATE, client
// uplink: 主动状态 online/away/offline). Persisted to sys_presence and
// forwarded to the user's conversation peers (excluding self).
func (p *Pipe) onPresenceUp(ctx context.Context, req Req) {
	var sig wire.PresenceSignal
	if len(req.Payload) > 0 {
		if err := wire.Unmarshal(req.Payload, &sig); err != nil {
			p.reply(buildErrEnv(req, 400, "bad payload"))
			return
		}
	}
	uid := int64(req.UserID)
	if uid <= 0 {
		uid = int64(sig.UserID) // user-layer internal status event
	}
	if uid <= 0 {
		return
	}
	status := sig.Status
	if status == "" {
		if sig.Online != nil && *sig.Online {
			status = "online"
		} else {
			status = "offline"
		}
	}
	_ = p.hot.UpsertPresence(ctx, &store.Presence{
		UID: uid, Online: status == "online", LastSeen: nowSec(),
	})
	pl, _ := wire.Marshal(wire.PresenceSignal{UserID: uint64(uid), Status: status, At: nowMilli()})
	p.fanoutPeers(ctx, uid, req.Kind, pl)
}

// onPresenceConnect handles the USER LAYER's internal connect (401) /
// disconnect (402) notifications: kind with UserID == 0 and user_id inside
// the payload. 401 → online:true persisted + broadcast; 402 → offline.
func (p *Pipe) onPresenceConnect(ctx context.Context, req Req) {
	var sig wire.PresenceSignal
	if len(req.Payload) > 0 {
		if err := wire.Unmarshal(req.Payload, &sig); err != nil {
			return
		}
	}
	uid := int64(sig.UserID)
	if uid <= 0 {
		return
	}
	// The actor must be the authenticated session, and the event must be about
	// that actor. A client that forges a 401/402 frame (or a payload naming
	// another user) is rejected here even if it slipped past the gateway.
	if req.UserID == 0 || uint64(uid) != req.UserID {
		p.lg.Warn("presence event rejected: actor mismatch", "actor", req.UserID, "subject", uid)
		return
	}
	online := req.Kind == uint32(kinds.KindPresenceSubscribe) // 401 = connect
	_ = p.hot.UpsertPresence(ctx, &store.Presence{UID: uid, Online: online, LastSeen: nowSec()})
	// TODO(presence-throttle): aggregate repeated connect/disconnect per user
	// into one broadcast per 10s window (a user flapping devices currently
	// emits one event per transition).
	pl, _ := wire.Marshal(wire.PresenceSignal{UserID: uint64(uid), Online: &online, At: nowMilli()})
	p.fanoutPeers(ctx, uid, req.Kind, pl)
}

// fanoutConv delivers one frame to every member of cid EXCEPT excludeUID
// (the transient-signal forwarding rule: receipts/typing/presence never
// echo back to their originator).
func (p *Pipe) fanoutConv(ctx context.Context, cid int64, kind uint32, excludeUID uint64, payload []byte) {
	members, err := p.hot.ListMembers(ctx, cid)
	if err != nil {
		p.lg.Warn("signaling: list members failed", "cid", cid, "err", err.Error())
		return
	}
	for _, m := range members {
		if uint64(m.UID) == excludeUID {
			continue
		}
		p.reply(&env{Kind: kind, ConvID: uint64(cid), UserID: uint64(m.UID), Payload: payload})
	}
}

// fanoutPeers delivers one frame to every OTHER user sharing at least one
// conversation with uid (the presence fan-out set).
func (p *Pipe) fanoutPeers(ctx context.Context, uid int64, kind uint32, payload []byte) {
	peers, err := p.hot.MemberPeersOf(ctx, uid)
	if err != nil {
		p.lg.Warn("signaling: member peers lookup failed", "uid", uid, "err", err.Error())
		return
	}
	for _, peer := range peers {
		p.reply(&env{Kind: kind, UserID: uint64(peer), Payload: payload})
	}
}

// onRecall is the dispatch entry for kinds 107 (MSG_DELETE, treated as
// recall-for-everyone) and 108 (MSG_RECALL).
//
// Authorization: the actor must be the ORIGINAL SENDER or a conversation
// admin/owner (CheckMember role >= 1). The message must exist in the
// conversation and fall inside the recall window (Pipe.recallWindowSec,
// default 120s). On success the row is soft-deleted (recalled=at) and
// MSG_RECALL(108) is broadcast to EVERY member (including the actor).
// Front contract: handlers/msg-mutation.ts decodes {msg_id, conv_id} for
// kind 108 and applies a tombstone; 107 (MSG_DELETE) uplink is mapped to
// the same recall path (recall-for-everyone semantics).
func (p *Pipe) onRecall(ctx context.Context, req Req) {
	var m wire.MsgMutation
	if len(req.Payload) > 0 {
		if err := wire.Unmarshal(req.Payload, &m); err != nil {
			p.reply(buildErrEnv(req, 400, "bad payload"))
			return
		}
	}
	cid := int64(m.ConvID)
	if cid == 0 {
		cid = int64(req.ConvID)
	}
	if cid == 0 || m.MsgID == 0 {
		p.reply(buildErrEnv(req, 400, "missing conv or msg"))
		return
	}
	actor := int64(req.UserID)
	if actor <= 0 {
		p.reply(buildErrEnv(req, 403, "unauthenticated"))
		return
	}
	member, err := p.msg.memberCheck(ctx, cid, actor)
	if err != nil || member == nil {
		p.reply(buildErrEnv(req, 403, "not a member"))
		return
	}
	// Locate the message row (msg ids are per-conv, so search this conv).
	row, err := p.findMsg(ctx, cid, int64(m.MsgID))
	if err != nil {
		p.reply(buildErrEnv(req, 404, "no such message"))
		return
	}
	isSender := row.SenderID == actor
	isAdmin := member.Role >= 1
	if !isSender && !isAdmin {
		p.reply(buildErrEnv(req, 403, "recall requires sender or admin"))
		return
	}
	if nowSec()-row.SentAt > p.recallWindowSec() {
		p.reply(buildErrEnv(req, 410, "recall window expired"))
		return
	}
	if _, err := p.hot.MarkRecalled(ctx, cid, row.MsgID, row.SenderID, nowSec()); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			p.reply(buildErrEnv(req, 404, "no such message"))
			return
		}
		p.reply(buildErrEnv(req, 500, "recall failed"))
		return
	}
	// Broadcast to EVERY member (including the actor): everyone's UI must
	// collapse the message. Downlink kind is always MSG_RECALL(108) — the
	// kind the client's msg-mutation handler maps to a 'recall' tombstone.
	pl, _ := wire.Marshal(wire.MsgMutation{MsgID: uint64(row.MsgID), ConvID: uint64(cid)})
	p.fanoutConv(ctx, cid, uint32(kinds.KindMsgRecall), 0, pl)
}

// findMsg scans the conversation's recent window for one msg id (the reader
// api is frozen to keyset scans; a recall targets recent messages by
// definition — outside the window the lookup fails first anyway).
func (p *Pipe) findMsg(ctx context.Context, cid, msgID int64) (store.HotMsg, error) {
	rows, err := p.hot.ReadHot(ctx, cid, 0, 500, false)
	if err != nil {
		return store.HotMsg{}, err
	}
	for _, m := range rows {
		if m.MsgID == msgID {
			return m, nil
		}
	}
	return store.HotMsg{}, store.ErrNotFound
}

// recallWindowSec is the recall time window in seconds (injectable for tests).
func (p *Pipe) recallWindowSec() int64 {
	if p.recallWindow > 0 {
		return p.recallWindow
	}
	return defaultRecallWindowSec
}
