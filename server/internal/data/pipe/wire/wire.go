// Package wire is the data layer's minimal payload codec for internal frames.
//
// Why it exists: the canonical contract source is proto/chat.proto, but the
// generated chatpb package is not present in this environment (no protoc /
// no module cache). This package provides hand-written, JSON-codec structs
// matching the proto field numbers' SEMANTICS for exactly the payloads the
// data layer needs. When chatpb is generated, this package is deleted and the
// domain handlers swap the struct types for the generated ones — the handler
// logic, store calls and frame flow do not change.
//
// Field names match the proto messages so the JSON wire form (protojson
// lowerCamelCase) is byte-compatible with the generated codec for these
// messages.
package wire

import "encoding/json"

// Envelope mirrors the frame's envelope header (subset the data layer reads).
// Frames arrive as *proto.Frame from transport; domain handlers rebuild this
// view from Frame.Env where needed.
type Envelope struct {
	ID        uint64 `json:"id,omitempty"`
	Kind      uint32 `json:"kind,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	ConvID    uint64 `json:"convId,omitempty"`
	UserID    uint64 `json:"userId,omitempty"`
	Payload   []byte `json:"payload,omitempty"`
}

// MessagePayload mirrors chat.v1.MessagePayload (MSG_SEND 101).
type MessagePayload struct {
	ClientMsgID string          `json:"clientMsgId,omitempty"`
	Text        string          `json:"text,omitempty"`
	ReplyTo     uint64          `json:"replyTo,omitempty"`
	Raw         json.RawMessage `json:"-"`
}

// MsgAck mirrors chat.v1.MsgAck (MSG_ACK 103).
type MsgAck struct {
	MsgID       uint64 `json:"msgId,omitempty"`
	Seq         uint64 `json:"seq,omitempty"`
	ClientMsgID string `json:"clientMsgId,omitempty"`
	Status      uint32 `json:"status,omitempty"`
}

// Error mirrors chat.v1.Error.
type Error struct {
	Code         uint32 `json:"code,omitempty"`
	Reason       string `json:"reason,omitempty"`
	RetryAfterMS uint32 `json:"retryAfterMs,omitempty"`
}

// ReadHistory mirrors chat.v1.ReadHistory (920).
type ReadHistory struct {
	ConvID    uint64 `json:"convId,omitempty"`
	SinceSeq  uint64 `json:"sinceSeq,omitempty"`
	Limit     uint32 `json:"limit,omitempty"`
	ColdMerge bool   `json:"coldMerge,omitempty"`
}

// MsgNew mirrors chat.v1.MsgNew (used inside ReadHistoryResult 921).
type MsgNew struct {
	MsgID    uint64 `json:"msgId,omitempty"`
	Seq      uint64 `json:"seq,omitempty"`
	SenderID uint64 `json:"senderId,omitempty"`
	SentAt   int64  `json:"sentAt,omitempty"`
	// Content is the opaque Envelope payload, base64-encoded on the wire
	// (same as protobuf bytes -> JSON). Never embed raw bytes as JSON.
	Content []byte `json:"content,omitempty"`
}

// ReadHistoryResult mirrors chat.v1.ReadHistoryResult (921).
type ReadHistoryResult struct {
	ConvID   uint64   `json:"convId,omitempty"`
	Messages []MsgNew `json:"messages,omitempty"`
	FromCold bool     `json:"fromCold,omitempty"`
	HasMore  bool     `json:"hasMore,omitempty"`
}

// DataResult mirrors chat.v1.DataResult (931/941/961…).
type DataResult struct {
	Op        uint32 `json:"op,omitempty"`
	Ok        bool   `json:"ok,omitempty"`
	Error     string `json:"error,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

// FlagRequest mirrors chat.v1.FlagRequest (970/971).
type FlagRequest struct {
	Key       string `json:"key,omitempty"`
	Value     string `json:"value,omitempty"`
	Write     bool   `json:"write,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

// FlagResult mirrors chat.v1.FlagResult (972).
type FlagResult struct {
	Flags     map[string]string `json:"flags,omitempty"`
	RequestID string            `json:"requestId,omitempty"`
}

// JobTrigger mirrors chat.v1.JobTrigger (980).
type JobTrigger struct {
	Job       string `json:"job,omitempty"`
	DryRun    bool   `json:"dryRun,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

// JobStatus mirrors chat.v1.JobStatus (981).
type JobStatus struct {
	Job    string `json:"job,omitempty"`
	State  string `json:"state,omitempty"`
	At     int64  `json:"at,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// Member mirrors chat.v1.Member.
type Member struct {
	UserID     uint64 `json:"userId,omitempty"`
	Role       uint32 `json:"role,omitempty"`
	JoinedAt   int64  `json:"joinedAt,omitempty"`
	MutedUntil int64  `json:"mutedUntil,omitempty"`
}

// ConvPayload mirrors chat.v1.ConvPayload.
type ConvPayload struct {
	ConvID    uint64   `json:"convId,omitempty"`
	Title     string   `json:"title,omitempty"`
	ConvType  uint32   `json:"convType,omitempty"`
	CreatedAt int64    `json:"createdAt,omitempty"`
	Members   []Member `json:"members,omitempty"`
}

// MemberOp mirrors chat.v1.MemberOp (generic member ops inside ConvData).
type MemberOp struct {
	ConvID  uint64   `json:"convId,omitempty"`
	UserIDs []uint64 `json:"userIds,omitempty"`
	Role    uint32   `json:"role,omitempty"`
}

// IdentityRequest mirrors chat.v1.IdentityRequest (940).
type IdentityRequest struct {
	Op        uint32 `json:"op,omitempty"`
	UserID    uint64 `json:"userId,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

// SecurityRequest mirrors chat.v1.SecurityRequest (960).
type SecurityRequest struct {
	Op        uint32 `json:"op,omitempty"`
	UserID    uint64 `json:"userId,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

// Marshal is json.Marshal with the error passed through.
func Marshal(v any) ([]byte, error) { return json.Marshal(v) }

// Unmarshal is json.Unmarshal with the error passed through.
func Unmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
