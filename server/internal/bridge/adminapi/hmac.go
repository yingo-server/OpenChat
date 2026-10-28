package adminapi

// This file implements the machine-to-machine authentication for the internal
// AdminAPI (docs/security-spec.md §3.3: 管理面独立密钥体系，与用户 JWT 隔离).
//
// Wire format:
//
//	Authorization: OC-HMAC <ts>:<nonce>:<hex hmac>
//	hmac = HMAC-SHA256(key, "<method>|<path>|<ts>")
//
//   - ts    unix seconds; accepted only inside a ±window (default 60s)
//   - nonce random, unique; a bounded LRU (100k entries) rejects replays
//   - path  r.URL.Path only (query string is not part of the canonical form;
//     callers must never put authority-bearing data in the query)
//
// Multiple keys are accepted at once so a rotation window can run two keys in
// parallel (security-spec §3.2: ipc_key_v1/v2 双钥并行 7 天).
//
// The canonical form is the contract fixed by the spec (method|path|ts). The
// nonce is therefore NOT covered by the MAC; replay protection rests on the
// uniqueness cache plus the ±window. BindNonce(true) switches to the stronger
// canonical form "<method>|<path>|<ts>|<nonce>" for deployments that can roll
// both sides at once.

import (
	"container/list"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AuthScheme is the Authorization scheme token for internal AdminAPI calls.
const AuthScheme = "OC-HMAC"

// Defaults for the verifier.
const (
	// DefaultHMACWindow is the accepted clock skew (spec §3.2 uses ±30s for
	// the IPC bus; the AdminAPI allowance is ±60s because it is driven by
	// operator tooling rather than a co-located process).
	DefaultHMACWindow = 60 * time.Second
	// DefaultNonceCapacity bounds the replay cache (100k, spec §3.2).
	DefaultNonceCapacity = 100000
)

// Verification errors. The HTTP handler collapses every one of them into 401
// (no oracle about which check failed); they exist for logs and tests.
var (
	// ErrMissingCredentials means no OC-HMAC Authorization header was sent.
	ErrMissingCredentials = errors.New("adminapi: missing OC-HMAC credentials")
	// ErrMalformed means the header did not parse as ts:nonce:mac.
	ErrMalformed = errors.New("adminapi: malformed OC-HMAC header")
	// ErrExpired means the timestamp fell outside the accepted window.
	ErrExpired = errors.New("adminapi: timestamp outside the accepted window")
	// ErrSignature means no configured key produced the presented MAC.
	ErrSignature = errors.New("adminapi: signature mismatch")
	// ErrReplay means the nonce was already seen inside the window.
	ErrReplay = errors.New("adminapi: nonce replayed")
	// ErrNoKeys means the authorizer was built without any key.
	ErrNoKeys = errors.New("adminapi: no HMAC keys configured")
)

// HMACAuthorizer verifies OC-HMAC requests. It is safe for concurrent use and
// satisfies Authorizer (the type injected into API.Auth).
type HMACAuthorizer struct {
	keys      [][]byte
	window    time.Duration
	capacity  int
	now       func() time.Time
	bindNonce bool

	mu     sync.Mutex
	nonces map[string]*list.Element
	order  *list.List // front = most recently used
}

// NewHMACAuthorizer builds the verifier over one or more shared keys. Empty
// or zero-length keys are ignored; if none remain, Authorize fails closed.
func NewHMACAuthorizer(keys [][]byte) *HMACAuthorizer {
	clean := make([][]byte, 0, len(keys))
	for _, k := range keys {
		if len(k) == 0 {
			continue
		}
		cp := make([]byte, len(k))
		copy(cp, k)
		clean = append(clean, cp)
	}
	return &HMACAuthorizer{
		keys:     clean,
		window:   DefaultHMACWindow,
		capacity: DefaultNonceCapacity,
		now:      time.Now,
		nonces:   make(map[string]*list.Element, 1024),
		order:    list.New(),
	}
}

// SetClock injects a clock (tests, NTP-skewed hosts).
func (a *HMACAuthorizer) SetClock(now func() time.Time) *HMACAuthorizer {
	if now != nil {
		a.now = now
	}
	return a
}

// SetWindow overrides the accepted skew.
func (a *HMACAuthorizer) SetWindow(d time.Duration) *HMACAuthorizer {
	if d > 0 {
		a.window = d
	}
	return a
}

// SetNonceCapacity overrides the replay cache bound (tests use tiny values to
// exercise eviction).
func (a *HMACAuthorizer) SetNonceCapacity(n int) *HMACAuthorizer {
	if n > 0 {
		a.capacity = n
	}
	return a
}

// BindNonce switches the canonical form to include the nonce. Both the signer
// and the verifier must agree; default is off (spec-literal).
func (a *HMACAuthorizer) BindNonce(on bool) *HMACAuthorizer {
	a.bindNonce = on
	return a
}

// Canonical is the MAC input: "method|path|ts" (+"|nonce" when bound).
// Pure function — the single source of truth shared with HMACSigner.
func Canonical(method, path string, ts int64) string {
	return strings.ToUpper(method) + "|" + path + "|" + strconv.FormatInt(ts, 10)
}

// CanonicalWithNonce is the hardened variant (BindNonce(true)).
func CanonicalWithNonce(method, path string, ts int64, nonce string) string {
	return Canonical(method, path, ts) + "|" + nonce
}

// Sign returns the lowercase hex HMAC-SHA256 of canonical under key.
func Sign(key []byte, canonical string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(canonical))
	return hex.EncodeToString(m.Sum(nil))
}

// Authorize verifies the request. Any error is a 401 at the handler.
func (a *HMACAuthorizer) Authorize(r *http.Request) error {
	if r == nil {
		return ErrMissingCredentials
	}
	if len(a.keys) == 0 {
		return ErrNoKeys
	}
	ts, nonce, mac, err := parseAuthHeader(r.Header.Get("Authorization"))
	if err != nil {
		return err
	}
	now := a.now().Unix()
	skew := int64(a.window / time.Second)
	if ts < now-skew || ts > now+skew {
		return ErrExpired
	}
	canonical := Canonical(r.Method, r.URL.Path, ts)
	if a.bindNonce {
		canonical = CanonicalWithNonce(r.Method, r.URL.Path, ts, nonce)
	}
	if !verifyAny(a.keys, canonical, mac) {
		return ErrSignature
	}
	// Only count a nonce after the MAC verified: an attacker must not be able
	// to burn an honest caller's nonce with an unsigned request.
	if !a.rememberNonce(nonce) {
		return ErrReplay
	}
	return nil
}

// parseAuthHeader splits "OC-HMAC <ts>:<nonce>:<hex>".
func parseAuthHeader(h string) (ts int64, nonce, mac string, err error) {
	h = strings.TrimSpace(h)
	if h == "" {
		return 0, "", "", ErrMissingCredentials
	}
	scheme, rest, ok := strings.Cut(h, " ")
	if !ok || !strings.EqualFold(scheme, AuthScheme) {
		return 0, "", "", ErrMissingCredentials
	}
	parts := strings.SplitN(strings.TrimSpace(rest), ":", 3)
	if len(parts) != 3 {
		return 0, "", "", ErrMalformed
	}
	ts, perr := strconv.ParseInt(parts[0], 10, 64)
	if perr != nil || ts <= 0 {
		return 0, "", "", ErrMalformed
	}
	nonce = parts[1]
	if len(nonce) < 8 || len(nonce) > 128 {
		return 0, "", "", ErrMalformed
	}
	mac = parts[2]
	if _, derr := hex.DecodeString(mac); derr != nil || len(mac) != sha256.Size*2 {
		return 0, "", "", ErrMalformed
	}
	return ts, nonce, mac, nil
}

// verifyAny accepts a MAC produced by ANY configured key (rotation window).
// Constant-time per key; the loop is over keys, not over attacker input.
func verifyAny(keys [][]byte, canonical, mac string) bool {
	got, err := hex.DecodeString(mac)
	if err != nil {
		return false
	}
	ok := false
	for _, k := range keys {
		want := hmac.New(sha256.New, k)
		want.Write([]byte(canonical))
		if subtle.ConstantTimeCompare(want.Sum(nil), got) == 1 {
			ok = true
		}
	}
	return ok
}

// rememberNonce records nonce, returning false when it was already present.
func (a *HMACAuthorizer) rememberNonce(nonce string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if el, ok := a.nonces[nonce]; ok {
		a.order.MoveToFront(el)
		return false
	}
	el := a.order.PushFront(nonce)
	a.nonces[nonce] = el
	for a.order.Len() > a.capacity {
		back := a.order.Back()
		if back == nil {
			break
		}
		a.order.Remove(back)
		delete(a.nonces, back.Value.(string))
	}
	return true
}

// NonceCount reports the current replay-cache size (metrics/tests).
func (a *HMACAuthorizer) NonceCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.order.Len()
}

// ---------------------------------------------------------------- signing

// HMACSigner signs OUTGOING AdminAPI requests (bridgeproxy.Authorizer). It is
// the client half of HMACAuthorizer: same canonical form, same key.
type HMACSigner struct {
	Key       []byte
	Window    time.Duration // unused for signing; kept for symmetry/documentation
	Now       func() time.Time
	NonceFunc func() (string, error)
	// BindNonce must match the verifier's setting.
	BindNonce bool
}

// NewHMACSigner builds a signer for one key.
func NewHMACSigner(key []byte) *HMACSigner {
	return &HMACSigner{Key: key, Now: time.Now}
}

// Authorize sets the OC-HMAC Authorization header (the Authorizer interface is
// shared by both directions in this codebase: bridgeproxy mutates, adminapi
// verifies).
func (s *HMACSigner) Authorize(r *http.Request) error {
	if r == nil {
		return errors.New("adminapi: nil request")
	}
	if len(s.Key) == 0 {
		return ErrNoKeys
	}
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	ts := now().Unix()
	nonce, err := s.newNonce()
	if err != nil {
		return err
	}
	canonical := Canonical(r.Method, r.URL.Path, ts)
	if s.BindNonce {
		canonical = CanonicalWithNonce(r.Method, r.URL.Path, ts, nonce)
	}
	mac := Sign(s.Key, canonical)
	r.Header.Set("Authorization", fmt.Sprintf("%s %d:%s:%s", AuthScheme, ts, nonce, mac))
	return nil
}

func (s *HMACSigner) newNonce() (string, error) {
	if s.NonceFunc != nil {
		return s.NonceFunc()
	}
	return RandomNonce()
}

// RandomNonce returns a 128-bit hex nonce (32 chars, inside the accepted
// length window).
func RandomNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("adminapi: nonce: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// compile-time assertion: both halves satisfy the Authorizer port.
var (
	_ Authorizer = (*HMACAuthorizer)(nil)
	_ Authorizer = (*HMACSigner)(nil)
)
