// Package remote 实现 BUS_SOCKET 帧编解码 + TCP/UDS Listener/Dialer
// + HMAC 握手 + 重连（docs/bridge-design.md §2/§4）。
//
// BUS_SOCKET 帧格式（wire）：
//
//	 0        4  5      7  7         9  9              13  13       13+len
//	┌──────────┬─────────┬───────────┬────────────────┬──────────────────┐
//	│ "OCHT"   │ version │   kind    │  length (BE32) │  body (JSON)     │
//	│ 4 bytes  │ 1 byte  │ 2 bytes BE│  4 bytes       │  length bytes    │
//	└──────────┴─────────┴───────────┴────────────────┴──────────────────┘
//
// body 为 JSON 编码的 internal Frame 结构体（简单可靠；proto.Frame 的
// Envelope 字段以 protojson 兼容方式序列化由 chatpb 侧 Envelope 承担）。
package remote

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/yingo-server/OpenChat/server/internal/proto"
)

// 线路常量。
const (
	Magic     = "OCHT" // 4 字节魔数
	Version1  = 1      // 当前版本
	HeaderLen = 11     // 4 magic + 1 ver + 2 kind + 4 length

	// MaxBodyLen 单帧 body 上限（>256KB 判非法帧断连，FrameRW 契约）。
	MaxBodyLen = 256 * 1024
)

// ErrBadFrame 非法帧（magic/版本/超长）。
var ErrBadFrame = errors.New("remote: bad frame")

// frameWire 是 body 的 JSON 结构（internal frame 结构体）。
type frameWire struct {
	Seq      uint32          `json:"seq"`
	Kind     uint16          `json:"kind"`
	Envelope json.RawMessage `json:"envelope,omitempty"`
	TraceID  string          `json:"trace_id,omitempty"`
	ConnID   string          `json:"conn_id,omitempty"`
	UserID   string          `json:"user_id,omitempty"`
	DeviceID string          `json:"device_id,omitempty"`
}

// rawWire 无 Envelope 的裸 body（握手等控制帧用）。
type rawWire struct {
	Seq  uint32          `json:"seq"`
	Kind uint16          `json:"kind"`
	Body json.RawMessage `json:"body,omitempty"`
}

// EncodeFrame 把 internal Frame 编成 BUS_SOCKET 帧字节。
// kind 非 0 时以 kind 覆盖帧内 Kind（握手帧场景）。
func EncodeFrame(f *proto.Frame, kindOverride uint16) ([]byte, error) {
	fw := frameWire{
		Seq:      f.Seq,
		Kind:     f.Kind,
		TraceID:  frameTraceID(f),
		ConnID:   frameConnID(f),
		UserID:   frameUserID(f),
		DeviceID: frameDeviceID(f),
	}
	if f.Envelope != nil {
		b, err := protojson.Marshal(f.Envelope)
		if err != nil {
			return nil, fmt.Errorf("remote: marshal envelope: %w", err)
		}
		fw.Envelope = b
	}
	body, err := json.Marshal(fw)
	if err != nil {
		return nil, err
	}
	if len(body) > MaxBodyLen {
		return nil, ErrBadFrame
	}
	kind := f.Kind
	if kindOverride != 0 {
		kind = kindOverride
	}
	buf := make([]byte, HeaderLen+len(body))
	copy(buf, Magic)
	buf[4] = Version1
	binary.BigEndian.PutUint16(buf[5:7], kind)
	binary.BigEndian.PutUint32(buf[7:11], uint32(len(body)))
	copy(buf[HeaderLen:], body)
	return buf, nil
}

// DecodeFrame 从连接读一帧并解码为 internal Frame。
// 非法 magic/版本/超长 → ErrBadFrame（调用方应断开连接）。
func DecodeFrame(r io.Reader) (*proto.Frame, error) {
	hdr := make([]byte, HeaderLen)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return nil, err
	}
	if string(hdr[:4]) != Magic {
		return nil, ErrBadFrame
	}
	if hdr[4] != Version1 {
		return nil, ErrBadFrame
	}
	kind := binary.BigEndian.Uint16(hdr[5:7])
	length := binary.BigEndian.Uint32(hdr[7:11])
	if length > MaxBodyLen {
		return nil, ErrBadFrame
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return decodeBody(kind, body)
}

// DecodeFrameKind 从连接读一帧，返回 (frame, wireKind)。wireKind 是线路
// 头部的 kind（握手帧的 kind 在头部而非 body）。
func DecodeFrameKind(r io.Reader) (*proto.Frame, uint16, error) {
	hdr := make([]byte, HeaderLen)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return nil, 0, err
	}
	if string(hdr[:4]) != Magic || hdr[4] != Version1 {
		return nil, 0, ErrBadFrame
	}
	kind := binary.BigEndian.Uint16(hdr[5:7])
	length := binary.BigEndian.Uint32(hdr[7:11])
	if length > MaxBodyLen {
		return nil, 0, ErrBadFrame
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, 0, err
	}
	f, err := decodeBody(kind, body)
	return f, kind, err
}

func decodeBody(kind uint16, body []byte) (*proto.Frame, error) {
	var fw frameWire
	if err := json.Unmarshal(body, &fw); err != nil {
		return nil, fmt.Errorf("remote: bad body: %w", err)
	}
	f := &proto.Frame{Seq: fw.Seq, Kind: kind}
	meta := &proto.FrameMeta{}
	if fw.TraceID != "" {
		meta.TraceID = fw.TraceID
	}
	if fw.ConnID != "" {
		meta.ConnID = fw.ConnID
	}
	if fw.UserID != "" {
		meta.UserID = fw.UserID
	}
	if fw.DeviceID != "" {
		meta.DeviceID = fw.DeviceID
	}
	f.Meta = meta
	if len(fw.Envelope) > 0 {
		env := &chatpb.Envelope{}
		if err := protojson.Unmarshal(fw.Envelope, env); err != nil {
			return nil, fmt.Errorf("remote: bad envelope: %w", err)
		}
		f.Envelope = env
	}
	return f, nil
}

// EncodeControl 编一个控制帧（握手等）：kind 在线路头部，body 为任意
// JSON 可序列化对象。
func EncodeControl(seq uint32, kind uint16, body any) ([]byte, error) {
	var raw json.RawMessage
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		raw = b
	}
	w := rawWire{Seq: seq, Kind: kind, Body: raw}
	b, err := json.Marshal(w)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, HeaderLen+len(b))
	copy(buf, Magic)
	buf[4] = Version1
	binary.BigEndian.PutUint16(buf[5:7], kind)
	binary.BigEndian.PutUint32(buf[7:11], uint32(len(b)))
	copy(buf[HeaderLen:], b)
	return buf, nil
}

// DecodeControl 读一帧并按 rawWire 解析（握手用，不构造 proto.Frame）。
func DecodeControl(r io.Reader) (rawWire, error) {
	var w rawWire
	hdr := make([]byte, HeaderLen)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return w, err
	}
	if string(hdr[:4]) != Magic || hdr[4] != Version1 {
		return w, ErrBadFrame
	}
	length := binary.BigEndian.Uint32(hdr[7:11])
	if length > MaxBodyLen {
		return w, ErrBadFrame
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return w, err
	}
	err := json.Unmarshal(body, &w)
	return w, err
}

// connWriter 带写锁的帧写出器（与 FrameRW 共享连接写锁契约）。
type connWriter struct {
	mu  sync.Mutex
	w   io.Writer
	err error
}

func newConnWriter(w io.Writer) *connWriter { return &connWriter{w: w} }

func (cw *connWriter) write(b []byte) error {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	if cw.err != nil {
		return cw.err
	}
	_, err := cw.w.Write(b)
	if err != nil {
		cw.err = err
	}
	return err
}
