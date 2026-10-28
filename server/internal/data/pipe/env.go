package pipe

// env is the pipe's outbound reply representation.
//
// IMPORTANT (assembly-layer contract): the canonical wire envelope is
// chatpb.Envelope produced by protobuf codegen. That generated package is
// not present in this build environment (no protoc; see wire/wire.go), so the
// pipe emits this struct. The ASSEMBLY layer (batch-3 cmd/*) installs
// Pipe.Emit to convert env → *proto.Frame with a real chatpb.Envelope before
// Peer.Send; the default Emit builds a Kind-only shell. The pipe's logic
// (sequencing, dedup, flush, ack, read routing) is independent of the codec.
type env struct {
	Kind      uint32
	RequestID string
	ConvID    uint64
	UserID    uint64
	Payload   []byte
}
