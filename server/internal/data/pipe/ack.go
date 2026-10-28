package pipe

// ack construction: the flusher and dedup replay both emit MSG_ACK-shaped
// envelopes {msg_id, seq, client_msg_id, status}.

import (
	"github.com/yingo-server/OpenChat/server/internal/data/pipe/wire"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
)

// buildAckEnv composes the ack env for a committed (or replayed) message.
// status 0 = OK; non-zero is the failure code (flusher nack path).
func buildAckEnv(cid int64, clientMsgID string, msgID, seq int64, status uint32) *env {
	ack := wire.MsgAck{
		MsgID:       uint64(msgID),
		Seq:         uint64(seq),
		ClientMsgID: clientMsgID,
		Status:      status,
	}
	pl, _ := wire.Marshal(ack)
	return &env{Kind: uint32(kinds.KindMsgAck), ConvID: uint64(cid), Payload: pl}
}

// buildErrEnv composes an ERROR envelope reply.
func buildErrEnv(req Req, code uint32, reason string) *env {
	pl, _ := wire.Marshal(struct {
		Code   uint32 `json:"code,omitempty"`
		Reason string `json:"reason,omitempty"`
	}{code, reason})
	return &env{Kind: uint32(kinds.KindError), RequestID: req.RequestID,
		ConvID: req.ConvID, UserID: req.UserID, Payload: pl}
}

// buildResultEnv composes a generic result envelope.
func buildResultEnv(req Req, kind uint32, payload []byte) *env {
	return &env{Kind: kind, RequestID: req.RequestID,
		ConvID: req.ConvID, UserID: req.UserID, Payload: payload}
}
