package chatpb

import (
	"bytes"
	"testing"
)

func TestEnvelopeRoundTrip(t *testing.T) {
	m := &Envelope{
		Id: 7, AckId: 3, Kind: 101, Version: 1, RequestId: "req-1",
		Flags: 2, SentAt: 1234567890, Target: &Envelope_UserId{UserId: 42},
		Payload: []byte("hello payload"),
	}
	b, err := m.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	var got Envelope
	if err := got.Unmarshal(b); err != nil {
		t.Fatal(err)
	}
	if got.Id != 7 || got.Kind != 101 || got.RequestId != "req-1" || got.SentAt != 1234567890 {
		t.Fatalf("scalar mismatch: %+v", &got)
	}
	if got.GetUserId() != 42 {
		t.Fatalf("oneof user_id mismatch: %v", got.GetTarget())
	}
	if !bytes.Equal(got.Payload, m.Payload) {
		t.Fatal("payload mismatch")
	}
}

func TestInternalFrameRoundTrip(t *testing.T) {
	m := &InternalFrame{
		Envelope: &Envelope{Kind: 102, Target: &Envelope_ConvId{ConvId: 9}, Payload: []byte("x")},
		SrcLayer: "user", DstLayer: "data", SrcNode: "u1", DstNode: "d1",
		ConnId: 77, TraceId: "trace-1",
	}
	b, err := m.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	var got InternalFrame
	if err := got.Unmarshal(b); err != nil {
		t.Fatal(err)
	}
	if got.SrcLayer != "user" || got.ConnId != 77 || got.TraceId != "trace-1" {
		t.Fatalf("route header mismatch: %+v", &got)
	}
	if got.Envelope == nil || got.Envelope.GetConvId() != 9 {
		t.Fatalf("nested envelope mismatch: %+v", got.Envelope)
	}
}

func TestUnknownFieldsSkipped(t *testing.T) {
	// tag 99 varint (unknown) + valid field 1
	raw := []byte{0xf8, 0x06, 1, 0x08, 7} // tag 99 varint(1) + field1 varint(7)
	var got Envelope
	if err := got.Unmarshal(raw); err != nil {
		t.Fatal(err)
	}
	if got.Id != 7 {
		t.Fatalf("id mismatch: %d", got.Id)
	}
}

func TestBadWireRejected(t *testing.T) {
	var got Envelope
	if err := got.Unmarshal([]byte{0xff}); err == nil {
		t.Fatal("expected error for truncated varint")
	}
}
