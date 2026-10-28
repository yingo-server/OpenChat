package remote

import (
	"container/list"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Kind 别名：与 kinds 包一致使用 uint32 kind。
type Kind = uint32

// helloAckKind HELLO_ACK 复用 kind=902（HELLO 家族）：握手由"谁先发"区分角色，
// ACK 帧的 body 含服务端自身 nonce 供客户端反向验证。
const helloAckKind = 902

// HMACAuth 实现 BUS_SOCKET 层间认证（docs/bridge-design.md §2.4/§9）：
// 密码学只在 HELLO 握手——HMAC-SHA256 互验，时间窗 ±30s，nonce LRU 去重。
//
// 握手帧格式（BUS_SOCKET 帧的 body，kind=HELLO/HELLO_ACK）：
//
//	{
//	  "layer":    "user",                  // 发起端层名
//	  "nonce":    "32字节随机数的hex",      // 一次性，LRU 去重防重放
//	  "ts":       1719216000,              // Unix 秒，|now-ts| ≤ 30s
//	  "hmac":     "hex(HMAC-SHA256(key, layer|nonce|ts))",
//	  "subs":     ["sys.>", "user.in"],    // 可选：订阅 topic 列表
//	  "caps":     ["900..910"]             // 可选：能力集
//	}
//
// 流程：客户端发 HELLO → 服务端验证时间窗+nonce+HMAC → 回 HELLO_ACK
// （含服务端自身 nonce+ts+HMAC）→ 客户端验证 → 握手完成。任一步失败立即断开。
type HMACAuth struct {
	// Keys 共享密钥集（任意一把匹配即通过，支持轮换）。
	Keys [][]byte
	// Window 时间窗（默认 30s）。
	Window time.Duration
	// nonceCache 容量（默认 100000）。
	NonceCap int

	mu    sync.Mutex
	lru   *list.List               // element.Value = nonce string
	index map[string]*list.Element // nonce → element
}

// ErrHandshake 握手失败。
var ErrHandshake = errors.New("remote: handshake failed")

func (a *HMACAuth) window() time.Duration {
	if a.Window <= 0 {
		return 30 * time.Second
	}
	return a.Window
}

func (a *HMACAuth) nonceCap() int {
	if a.NonceCap <= 0 {
		return 100000
	}
	return a.NonceCap
}

func (a *HMACAuth) init() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.index == nil {
		a.index = make(map[string]*list.Element)
		a.lru = list.New()
	}
}

// helloPayload HELLO/HELLO_ACK 帧的 body 结构。
type helloPayload struct {
	Layer string   `json:"layer"`
	Nonce string   `json:"nonce"`
	TS    int64    `json:"ts"`
	HMAC  string   `json:"hmac"`
	Subs  []string `json:"subs,omitempty"`
	Caps  []string `json:"caps,omitempty"`
}

// computeMAC = HMAC-SHA256(key, layer|nonce|ts)。
func computeMAC(key []byte, layer, nonce string, ts int64) string {
	mac := hmac.New(sha256.New, key)
	fmt.Fprintf(mac, "%s|%s|%d", layer, nonce, ts)
	return hex.EncodeToString(mac.Sum(nil))
}

// newNonce 生成 32 字节随机数的 hex。
func newNonce() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// seenNonce 记录并查询 nonce 是否已出现（LRU，容量 nonceCap）。
func (a *HMACAuth) seenNonce(nonce string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.index == nil {
		a.index = make(map[string]*list.Element)
		a.lru = list.New()
	}
	if el, ok := a.index[nonce]; ok {
		a.lru.MoveToFront(el)
		return true // 重放
	}
	el := a.lru.PushFront(nonce)
	a.index[nonce] = el
	if a.lru.Len() > a.nonceCap() {
		back := a.lru.Back()
		if back != nil {
			delete(a.index, back.Value.(string))
			a.lru.Remove(back)
		}
	}
	return false
}

// ClientHello 构造客户端 HELLO body（未编码为帧）。
func (a *HMACAuth) ClientHello(layer string, subs []string) (helloPayload, error) {
	if len(a.Keys) == 0 {
		return helloPayload{}, fmt.Errorf("remote: no auth keys configured")
	}
	nonce, err := newNonce()
	if err != nil {
		return helloPayload{}, err
	}
	ts := time.Now().Unix()
	return helloPayload{
		Layer: layer,
		Nonce: nonce,
		TS:    ts,
		HMAC:  computeMAC(a.Keys[0], layer, nonce, ts),
		Subs:  subs,
	}, nil
}

// ServerAck 验证客户端 HELLO 并生成 HELLO_ACK body。
// 任何失败（时间窗、nonce 重放、HMAC 不匹配、无密钥）返回 ErrHandshake。
func (a *HMACAuth) ServerAck(client helloPayload, serverLayer string) (helloPayload, error) {
	fail := func() (helloPayload, error) { return helloPayload{}, ErrHandshake }
	if len(a.Keys) == 0 {
		return fail()
	}
	// 时间窗 ±30s
	drift := time.Since(time.Unix(client.TS, 0))
	if drift > a.window() || drift < -a.window() {
		return fail()
	}
	// nonce 重放
	if client.Nonce == "" || a.seenNonce(client.Nonce) {
		return fail()
	}
	// HMAC 匹配任一密钥
	ok := false
	for _, k := range a.Keys {
		if hmac.Equal([]byte(computeMAC(k, client.Layer, client.Nonce, client.TS)), []byte(client.HMAC)) {
			ok = true
			break
		}
	}
	if !ok {
		return fail()
	}
	// 服务端 ACK：自身 nonce+ts+HMAC（客户端亦验）
	nonce, err := newNonce()
	if err != nil {
		return fail()
	}
	ts := time.Now().Unix()
	return helloPayload{
		Layer: serverLayer,
		Nonce: nonce,
		TS:    ts,
		HMAC:  computeMAC(a.Keys[0], serverLayer, nonce, ts),
	}, nil
}

// VerifyAck 客户端验证服务端 HELLO_ACK。
func (a *HMACAuth) VerifyAck(ack helloPayload, serverLayer string) error {
	if len(a.Keys) == 0 {
		return ErrHandshake
	}
	drift := time.Since(time.Unix(ack.TS, 0))
	if drift > a.window() || drift < -a.window() {
		return ErrHandshake
	}
	if ack.Layer != serverLayer {
		return ErrHandshake
	}
	for _, k := range a.Keys {
		if hmac.Equal([]byte(computeMAC(k, ack.Layer, ack.Nonce, ack.TS)), []byte(ack.HMAC)) {
			return nil
		}
	}
	return ErrHandshake
}

// marshalHello 序列化为帧 body。
func marshalHello(h helloPayload) ([]byte, error) { return json.Marshal(h) }

// unmarshalHello 反序列化帧 body。
func unmarshalHello(b []byte) (helloPayload, error) {
	var h helloPayload
	err := json.Unmarshal(b, &h)
	return h, err
}
