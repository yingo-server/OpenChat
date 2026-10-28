// Package frame 是 usergw 的帧编解码层（docs/user-frontend-design.md §1.1 codec）：
// bytes ⇄ chatpb.Envelope，以及 Envelope → chatpb.InternalFrame 的内部帧封装。
//
// 明确不做：不含任何业务分支（不 switch kind），不涉及连接、不限流。
// 这是 net 层，不知道 user/session 概念。
package frame

import (
	"errors"
	"fmt"

	chatpb "github.com/yingo-server/OpenChat/server/internal/proto/gen/chatpb"
)

const (
	// MaxFrameBytes 单帧 WS 上限 64KB（security-spec §1.2.2 / acceptor ReadLimit 同源）。
	MaxFrameBytes = 64 << 10
	// MaxInternalFrameBytes 内部帧上限：Envelope 之外还有路由头，取 256KB
	// （与 bridge BUS_SOCKET MaxBodyLen 一致）。
	MaxInternalFrameBytes = 256 << 10
	// SrcLayerUser 本层在内部帧中的层标识。
	SrcLayerUser = "user"
)

var (
	// ErrFrameTooLarge 帧超过上限。
	ErrFrameTooLarge = errors.New("frame: too large")
	// ErrBadFrame 坏数据（protobuf 解析失败/空帧）。
	ErrBadFrame = errors.New("frame: bad frame")
	// ErrUnknownField Envelope 携带未知字段（严格模式：拒绝而非静默忽略）。
	ErrUnknownField = errors.New("frame: unknown envelope field")
	// ErrNilEnvelope 空 Envelope。
	ErrNilEnvelope = errors.New("frame: nil envelope")
)

// envelopeFields 是 chatpb.Envelope 已定义字段号白名单（proto/chat.proto）。
var envelopeFields = map[int]bool{
	1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true,
	10: true, 11: true, 15: true,
}

// Decode 把 WS 二进制消息解码为 Envelope。
// 空帧、超长、protobuf 坏数据、未知字段一律返回错误（acceptor 据此断连）。
func Decode(b []byte) (*chatpb.Envelope, error) {
	if len(b) == 0 {
		return nil, fmt.Errorf("%w: empty", ErrBadFrame)
	}
	if len(b) > MaxFrameBytes {
		return nil, fmt.Errorf("%w: %d > %d", ErrFrameTooLarge, len(b), MaxFrameBytes)
	}
	if err := checkEnvelopeFields(b); err != nil {
		return nil, err
	}
	env := &chatpb.Envelope{}
	if err := env.Unmarshal(b); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadFrame, err)
	}
	if env.Kind == 0 {
		return nil, fmt.Errorf("%w: kind=0", ErrBadFrame)
	}
	return env, nil
}

// Encode 把 Envelope 编码为 WS 二进制消息。
func Encode(env *chatpb.Envelope) ([]byte, error) {
	if env == nil {
		return nil, ErrNilEnvelope
	}
	b, err := env.Marshal()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadFrame, err)
	}
	if len(b) > MaxFrameBytes {
		return nil, fmt.Errorf("%w: %d > %d", ErrFrameTooLarge, len(b), MaxFrameBytes)
	}
	return b, nil
}

// Wrap 把业务 Envelope 包成内部帧：src_layer=user + trace_id + conn_id 路由头。
// 这是「一切皆流」的统一内部货币，桥接侧只认这个结构。
func Wrap(env *chatpb.Envelope, traceID string, connID uint64) *chatpb.InternalFrame {
	if env == nil {
		return nil
	}
	return &chatpb.InternalFrame{
		Envelope: env,
		SrcLayer: SrcLayerUser,
		ConnId:   connID,
		TraceId:  traceID,
	}
}

// MarshalInternal 编码内部帧（含路由头），供 forwarder 投递桥接。
func MarshalInternal(f *chatpb.InternalFrame) ([]byte, error) {
	if f == nil {
		return nil, ErrNilEnvelope
	}
	b, err := f.Marshal()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadFrame, err)
	}
	if len(b) > MaxInternalFrameBytes {
		return nil, fmt.Errorf("%w: %d > %d", ErrFrameTooLarge, len(b), MaxInternalFrameBytes)
	}
	return b, nil
}

// UnmarshalInternal 解码内部帧。
func UnmarshalInternal(b []byte) (*chatpb.InternalFrame, error) {
	if len(b) == 0 {
		return nil, fmt.Errorf("%w: empty internal frame", ErrBadFrame)
	}
	if len(b) > MaxInternalFrameBytes {
		return nil, fmt.Errorf("%w: %d > %d", ErrFrameTooLarge, len(b), MaxInternalFrameBytes)
	}
	f := &chatpb.InternalFrame{}
	if err := f.Unmarshal(b); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadFrame, err)
	}
	return f, nil
}

// Unwrap 取出内部帧里的业务 Envelope。
func Unwrap(f *chatpb.InternalFrame) (*chatpb.Envelope, error) {
	if f == nil || f.Envelope == nil {
		return nil, ErrNilEnvelope
	}
	return f.Envelope, nil
}

// checkEnvelopeFields 严格扫描 tag：出现未定义字段即拒绝（协议演进时必须先升级
// proto 与本白名单，避免「静默忽略导致的行为不一致」）。
func checkEnvelopeFields(b []byte) error {
	for len(b) > 0 {
		tag, wire, rest, ok := scanTag(b)
		if !ok {
			return fmt.Errorf("%w: truncated tag", ErrBadFrame)
		}
		if !envelopeFields[tag] {
			return fmt.Errorf("%w: field %d", ErrUnknownField, tag)
		}
		b = rest
		skipped, ok := skipValue(b, wire)
		if !ok {
			return fmt.Errorf("%w: truncated field %d", ErrBadFrame, tag)
		}
		b = skipped
	}
	return nil
}

func scanTag(b []byte) (tag, wire int, rest []byte, ok bool) {
	var v uint64
	var s uint
	for i := 0; i < len(b); i++ {
		c := b[i]
		if c < 0x80 {
			if i > 9 {
				return 0, 0, nil, false
			}
			v |= uint64(c) << s
			return int(v >> 3), int(v & 7), b[i+1:], true
		}
		v |= uint64(c&0x7f) << s
		s += 7
	}
	return 0, 0, nil, false
}

func skipValue(b []byte, wire int) ([]byte, bool) {
	switch wire {
	case 0:
		for i := 0; i < len(b); i++ {
			if b[i] < 0x80 {
				return b[i+1:], true
			}
		}
		return nil, false
	case 1:
		if len(b) < 8 {
			return nil, false
		}
		return b[8:], true
	case 2:
		var n uint64
		var s uint
		for i := 0; i < len(b); i++ {
			c := b[i]
			if c < 0x80 {
				n |= uint64(c) << s
				if uint64(len(b)-i-1) < n {
					return nil, false
				}
				return b[i+1+int(n):], true
			}
			n |= uint64(c&0x7f) << s
			s += 7
		}
		return nil, false
	case 5:
		if len(b) < 4 {
			return nil, false
		}
		return b[4:], true
	default:
		return nil, false
	}
}
