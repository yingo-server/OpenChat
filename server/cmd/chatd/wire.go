package main

// wire.go: the three wire-level adapters the assembly owns.
//
//  1. newFrameSource  — *proto.Frame (bridge → data) → pipe.Req. The data layer
//     is wire-agnostic, so unwrapping the InternalFrame routing header and
//     resolving the acting uid happens here.
//  2. installEmit     — pipe env → *proto.Frame (data → bridge), chatpb-backed.
//  3. buildRoutes     — the bridge route table: which kind goes to which layer.
//
// Plus the key loading helpers (Ed25519 PEM + HMAC index key).

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/yingo-server/OpenChat/server/internal/bridge/router"
	"github.com/yingo-server/OpenChat/server/internal/data/pipe"
	"github.com/yingo-server/OpenChat/server/internal/data/pipe/wire"
	"github.com/yingo-server/OpenChat/server/internal/pkg/log"
	"github.com/yingo-server/OpenChat/server/internal/proto"
	"github.com/yingo-server/OpenChat/server/internal/proto/gen/chatpb"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
	"github.com/yingo-server/OpenChat/server/internal/user/net/frame"
)

// uidResolver maps an entry connection id back to its authenticated uid.
// Supplied by the user layer's session table (the forwarder already carries
// conn_id end to end; the uid is never taken from the client envelope).
type uidResolver func(connID uint64) int64

// newFrameSource unwraps the InternalFrame header and fills pipe.Req.
func newFrameSource(resolve uidResolver, lg *log.Logger) pipe.FrameSource {
	return func(f *proto.Frame) pipe.Req {
		if f == nil {
			return pipe.Req{}
		}
		if f.Env != nil && len(f.Env.Payload) > 0 {
			if intf, err := frame.UnmarshalInternal(f.Env.Payload); err == nil && intf.GetEnvelope() != nil {
				env := intf.GetEnvelope()
				uid := int64(env.GetUserId())
				if uid == 0 && resolve != nil && intf.GetConnId() != 0 {
					uid = resolve(intf.GetConnId())
				}
				if uid == 0 && lg != nil {
					lg.Debug("frame without uid", "kind", kinds.KindName(env.Kind), "conn", intf.GetConnId())
				}
				return pipe.Req{
					Kind:      env.Kind,
					RequestID: env.GetRequestId(),
					ConvID:    env.GetConvId(),
					UserID:    uint64(uid),
					TraceID:   intf.GetTraceId(),
					Payload:   payloadForPipe(env.Kind, env.Payload),
					Frame:     f,
				}
			}
		}
		return pipe.ShellFrameSource(f)
	}
}

// payloadForPipe converts the protobuf payload of the kinds the data pipe
// parses into the pipe's placeholder wire structs (data/pipe/wire, JSON).
//
// Why here: the pipe is deliberately wire-agnostic ("the assembly installs the
// chatpb-backed FrameSource; when chatpb lands the FrameSource is the only code
// that changes" — data/pipe/req.go). This function is that adapter. Kinds the
// pipe does not parse are passed through verbatim.
//
// NOTE: MSG_SEND content is stored in the same form the pipe received it
// (currently the wire JSON), because the pipe persists req.Payload verbatim.
func payloadForPipe(kind uint32, payload []byte) []byte {
	switch kind {
	case kinds.KindMsgSend:
		var m chatpb.MessagePayload
		if err := m.Unmarshal(payload); err != nil {
			return payload
		}
		out, err := json.Marshal(wire.MessagePayload{
			ClientMsgID: m.GetClientMsgId(),
			Text:        m.GetText(),
			ReplyTo:     m.GetReplyTo(),
		})
		if err != nil {
			return payload
		}
		return out
	case kinds.KindReadHistory:
		var r chatpb.ReadHistory
		if err := r.Unmarshal(payload); err != nil {
			return payload
		}
		out, err := json.Marshal(wire.ReadHistory{
			ConvID:    r.GetConvId(),
			SinceSeq:  r.GetSinceSeq(),
			Limit:     r.GetLimit(),
			ColdMerge: r.GetColdMerge(),
		})
		if err != nil {
			return payload
		}
		return out
	}
	return payload
}

// installEmit installs the chatpb-backed outbound converter. SrcLayer is
// "data" (the verifier's capability table is keyed by it) and ConnID is left 0
// on purpose: the data layer does not know user connections, and a conn id from
// this process would collide with the gateway's own numbering.
func installEmit() {
	pipe.SetEmit(func(kind uint32, requestID string, convID, userID uint64, payload []byte) *proto.Frame {
		env := &chatpb.Envelope{
			Kind:      kind,
			RequestId: requestID,
			Payload:   payload,
		}
		switch {
		case userID != 0:
			env.SetUserId(userID)
		case convID != 0:
			env.SetConvId(convID)
		}
		return &proto.Frame{
			Kind: kind,
			Env:  env,
			Meta: &proto.FrameMeta{SrcLayer: "data", TraceID: requestID},
		}
	})
}

// buildRoutes starts from the bridge defaults and fills the data-plane
// precision routes the default table does not carry:
//
//	client → data : requests the data layer executes
//	data → user   : results addressed back to one user
//
// Without these, kind 101 falls into the 100-499 range rule (→ user layer) and
// an ack with both conv_id and user_id would be delivered twice.
func buildRoutes() map[uint32][]router.Target {
	rt := router.DefaultTable()
	toData := func(topic string) []router.Target {
		return []router.Target{{Layer: "data", Topic: topic}}
	}
	toUser := func(topic string) []router.Target {
		return []router.Target{{Layer: "user", Topic: topic}}
	}

	// Requests executed by the data layer.
	rt[kinds.KindMsgSend] = toData("data.101")
	rt[kinds.KindReadHistory] = toData("data.920")
	rt[kinds.KindConvDataRequest] = toData("data.930")
	rt[kinds.KindIdentityRequest] = toData("data.940")
	rt[kinds.KindSecurityRequest] = toData("data.960")
	rt[kinds.KindFlagGet] = toData("data.970")
	rt[kinds.KindFlagSet] = toData("data.971")
	rt[kinds.KindJobTrigger] = toData("data.980")

	// Results addressed to a single user (delivery in the gateway is by uid).
	rt[kinds.KindMsgAck] = toUser("sys.ack")
	rt[kinds.KindError] = toUser("sys.error")
	rt[kinds.KindReadHistoryResult] = toUser("sys.data.result")
	rt[kinds.KindConvDataResult] = toUser("sys.data.result")
	rt[kinds.KindIdentityResult] = toUser("sys.data.result")
	rt[kinds.KindFlagResult] = toUser("sys.data.result")
	rt[kinds.KindJobStatus] = toData("data.981")

	// 910 SHUTDOWN_NOTICE: the default table also targets "admin"; embedded
	// attaches no admin frame layer (management speaks HTTP AdminAPI), so keep
	// only the peers that exist.
	rt[kinds.KindShutdownNotice] = []router.Target{
		{Layer: "user", Topic: "sys.broadcast"},
		{Layer: "data", Topic: "data.910"},
	}

	// Feature-flag fan-out. Only the user layer is attached in embedded mode
	// (the management plane speaks HTTP AdminAPI, not the frame bus), so a
	// second "admin" target would just log "no such layer" on every publish.
	rt[kinds.KindFeatureFlags] = toUser("sys.broadcast")
	return rt
}

// ---------------------------------------------------------------- keys

// loadOrCreateSigningKey reads an Ed25519 PKCS#8 PEM private key. When the file
// is absent a fresh key is generated and written 0600 (first boot convenience;
// production provisions it with deploy/keygen and never regenerates it).
func loadOrCreateSigningKey(path string, lg *log.Logger) (ed25519.PrivateKey, error) {
	body, err := os.ReadFile(path)
	if err == nil {
		key, perr := parsePrivateKey(body)
		if perr != nil {
			return nil, fmt.Errorf("parse signing key %s: %w", path, perr)
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read signing key %s: %w", path, err)
	}
	_, priv, gerr := ed25519.GenerateKey(rand.Reader)
	if gerr != nil {
		return nil, fmt.Errorf("generate signing key: %w", gerr)
	}
	der, merr := x509.MarshalPKCS8PrivateKey(priv)
	if merr != nil {
		return nil, fmt.Errorf("marshal signing key: %w", merr)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("mkdir key dir: %w", err)
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, fmt.Errorf("write signing key %s: %w", path, err)
	}
	if lg != nil {
		lg.Warn("generated a new Ed25519 signing key (provision one before production)", "path", path)
	}
	return priv, nil
}

func parsePrivateKey(body []byte) (ed25519.PrivateKey, error) {
	if block, _ := pem.Decode(body); block != nil {
		key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		ed, ok := key.(ed25519.PrivateKey)
		if !ok {
			return nil, errors.New("not an Ed25519 private key")
		}
		return ed, nil
	}
	// Raw forms: 32-byte seed or 64-byte private key (optionally hex).
	trimmed := strings.TrimSpace(string(body))
	if raw, err := hex.DecodeString(trimmed); err == nil {
		switch len(raw) {
		case ed25519.SeedSize:
			return ed25519.NewKeyFromSeed(raw), nil
		case ed25519.PrivateKeySize:
			return ed25519.PrivateKey(raw), nil
		}
	}
	switch len(body) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(body), nil
	case ed25519.PrivateKeySize:
		return ed25519.PrivateKey(body), nil
	}
	return nil, errors.New("unsupported key format (want PKCS#8 PEM, 32-byte seed or 64-byte key)")
}

// loadOrCreateHMACKey reads the identifier index key (hex or raw). A missing
// file is generated and stored 0600 next to the JWT key. This key is separate
// from the signing key by design (security-spec §5.3: HMAC key != crypto key).
func loadOrCreateHMACKey(path string, lg *log.Logger) ([]byte, error) {
	body, err := os.ReadFile(path)
	if err == nil {
		key, perr := decodeKeyBytes(body)
		if perr != nil {
			return nil, fmt.Errorf("parse hmac key %s: %w", path, perr)
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read hmac key %s: %w", path, err)
	}
	key := make([]byte, 32)
	if _, rerr := rand.Read(key); rerr != nil {
		return nil, fmt.Errorf("generate hmac key: %w", rerr)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("mkdir key dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(key)+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("write hmac key %s: %w", path, err)
	}
	if lg != nil {
		lg.Warn("generated a new identifier HMAC key (provision one before production)", "path", path)
	}
	return key, nil
}

func decodeKeyBytes(body []byte) ([]byte, error) {
	if raw, err := hex.DecodeString(strings.TrimSpace(string(body))); err == nil && len(raw) >= 16 {
		return raw, nil
	}
	raw := []byte(strings.TrimRight(string(body), "\r\n"))
	if len(raw) < 16 {
		return nil, errors.New("key too short (want >= 16 bytes)")
	}
	// Normalize to 32 bytes so exported key files are interchangeable.
	sum := sha256.Sum256(raw)
	return sum[:], nil
}
