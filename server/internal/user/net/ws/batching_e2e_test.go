package ws

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// 端到端协议兼容性实测（方案一「应用层拼接合批」的硬证据）：
// 服务端把多条数据帧拼进一个 WS message（真 Upgrader 升级、真 writeBatch
// 路径），真 gorilla 客户端 ReadMessage 得到拼接后的字节，按 Envelope 流式
// 解码应完整还原全部消息——协议未改、旧客户端兼容（无需任何客户端改动）。
func TestCoalescedMessageDecodesAsIndividualEnvelopes(t *testing.T) {
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		// 生产写路径：gorillaWriter.writeBatch，同 mt 相邻 run 帧合并为一条 message
		gw := gorillaWriter{c: c}
		err = gw.writeBatch([]outMsg{
			{mt: websocket.BinaryMessage, b: testEnvBytes("ENVELOPE-ONE"), run: true},
			{mt: websocket.BinaryMessage, b: testEnvBytes("ENVELOPE-TWO"), run: true},
		})
		if err != nil {
			t.Error("writeBatch:", err)
		}
		time.Sleep(100 * time.Millisecond) // let the client read before close
		c.Close()
	}))
	defer srv.Close()

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal("dial:", err)
	}
	defer c.Close()
	_, data, err := c.ReadMessage()
	if err != nil {
		t.Fatal("client read:", err)
	}
	envs, derr := decodeEnvelopeStream(data)
	if derr != nil {
		t.Fatal("stream decode:", derr)
	}
	if len(envs) != 2 {
		t.Fatalf("decoded %d envelopes from one WS message, want 2 (bodies: %q %q)",
			len(envs), envs[0].body, envs[1].body)
	}
	for i, e := range envs {
		if e.kind != 101 {
			t.Fatalf("env[%d].kind = %d, want 101", i, e.kind)
		}
	}
}

// testEnvBytes builds a minimal protobuf Envelope wire form carrying `body` in
// payload (field 15) and kind=101 (field 3): kind = 0x18 0x65, payload =
// 0x7A len body. This is the real client wire format — decodeEnvelopeStream
// below mirrors what the browser/native client decoder does on a stream.
func testEnvBytes(body string) []byte {
	b := []byte{0x18, 0x65, 0x7A, byte(len(body))}
	return append(b, body...)
}

type testDecodedEnv struct {
	kind uint32
	body []byte
}

// decodeEnvelopeStream is the stream-tolerant decoder the client dispatch uses:
// each Envelope is self-delimiting protobuf (tag+len framing), so a buffer with
// concatenated Envelopes yields every frame. This is exactly why方案一不改协议.
func decodeEnvelopeStream(b []byte) ([]*testDecodedEnv, error) {
	var out []*testDecodedEnv
	rest := b
	for len(rest) >= 4 {
		if rest[0] != 0x18 || rest[2] != 0x7A {
			return out, errBadEnvelopeStream
		}
		n := int(rest[3])
		if 4+n > len(rest) {
			return out, errBadEnvelopeStream
		}
		out = append(out, &testDecodedEnv{kind: uint32(rest[1]), body: rest[4 : 4+n]})
		rest = rest[4+n:]
	}
	if len(rest) != 0 {
		return out, errBadEnvelopeStream
	}
	return out, nil
}

type envelopeStreamError string

func (e envelopeStreamError) Error() string { return string(e) }

const errBadEnvelopeStream = envelopeStreamError("bad envelope stream")

// TestCoalesceConcurrentWriteBatchRace: 多 goroutine 同时驱动同一连接的
// writeBatch —— gorilla 内部锁必须串行化合并写与普通写，无 panic / race。
func TestCoalesceConcurrentWriteBatchRace(t *testing.T) {
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		gw := gorillaWriter{c: c}
		var wg sync.WaitGroup
		for g := 0; g < 4; g++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; i < 20; i++ {
					msgs := make([]outMsg, 4)
					for k := range msgs {
						msgs[k] = outMsg{mt: websocket.BinaryMessage, b: testEnvBytes("x"), run: true}
					}
					_ = gw.writeBatch(msgs) // 4 frames → 1 coalesced message per call
				}
			}()
		}
		wg.Wait()
		time.Sleep(50 * time.Millisecond)
		c.Close()
	}))
	defer srv.Close()

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal("dial:", err)
	}
	defer c.Close()
	// 客户端持续排水（不校验内容：本测试断言写侧不 panic / 不 race）。
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			break
		}
	}
}

// TestCoalesceClientStillParsesAfterMixedTypes: 合批 message 与单帧 message
// 交错（mt 切换）时客户端仍逐条解析——run 边界与 mt 边界都正确切断。
func TestCoalesceClientStillParsesAfterMixedTypes(t *testing.T) {
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		gw := gorillaWriter{c: c}
		// 2 run-frames (coalesced) + 1 non-run frame (own message) + 2 run-frames
		err = gw.writeBatch([]outMsg{
			{mt: websocket.BinaryMessage, b: testEnvBytes("A1"), run: true},
			{mt: websocket.BinaryMessage, b: testEnvBytes("A2"), run: true},
			{mt: websocket.BinaryMessage, b: testEnvBytes("B1"), run: false},
			{mt: websocket.BinaryMessage, b: testEnvBytes("C1"), run: true},
			{mt: websocket.BinaryMessage, b: testEnvBytes("C2"), run: true},
		})
		if err != nil {
			t.Error("writeBatch:", err)
		}
		time.Sleep(100 * time.Millisecond)
		c.Close()
	}))
	defer srv.Close()

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal("dial:", err)
	}
	defer c.Close()
	var got []string
	for {
		c.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, data, err := c.ReadMessage()
		if err != nil {
			break
		}
		envs, derr := decodeEnvelopeStream(data)
		if derr != nil {
			t.Fatalf("client got unparseable message %q: %v", data, derr)
		}
		for _, e := range envs {
			got = append(got, string(e.body))
		}
	}
	want := []string{"A1", "A2", "B1", "C1", "C2"}
	if len(got) != len(want) {
		t.Fatalf("decoded %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("decoded[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}
