package adminapi

import (
	"bytes"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

var testKey = []byte("0123456789abcdef0123456789abcdef")

func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

func nonceFor(i int) string { return "nonce-00000000" + strconv.Itoa(i) }

// signedRequest builds a POST /admin/inject request signed with key at ts.
func signedRequest(t *testing.T, key []byte, ts time.Time, nonce string) *http.Request {
	t.Helper()
	body := `{"kind":101,"conv_id":1,"payload_b64":"` + base64.StdEncoding.EncodeToString([]byte("hi")) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/admin/inject", bytes.NewBufferString(body))
	mac := Sign(key, Canonical(r.Method, r.URL.Path, ts.Unix()))
	r.Header.Set("Authorization", AuthScheme+" "+strconv.FormatInt(ts.Unix(), 10)+":"+nonce+":"+mac)
	return r
}

func TestHMACAuthorizerValidSignature(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	auth := NewHMACAuthorizer([][]byte{testKey}).SetClock(fixedClock(now))
	fb := &fakeBus{}
	api := New(auth, fb)

	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, signedRequest(t, testKey, now, nonceFor(1)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("valid signature code = %d body=%s, want 202", rec.Code, rec.Body.String())
	}
	if len(fb.frames) != 1 {
		t.Fatalf("frames = %d, want 1 (valid request must reach the bus)", len(fb.frames))
	}
	if auth.NonceCount() != 1 {
		t.Fatalf("nonce cache = %d, want 1", auth.NonceCount())
	}
}

func TestHMACAuthorizerWrongSignature(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	auth := NewHMACAuthorizer([][]byte{testKey}).SetClock(fixedClock(now))
	fb := &fakeBus{}
	api := New(auth, fb)

	wrongKey := []byte("ffffffffffffffffffffffffffffffff")
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, signedRequest(t, wrongKey, now, nonceFor(2)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong signature code = %d, want 401", rec.Code)
	}
	if len(fb.frames) != 0 {
		t.Fatal("unauthorized request must not inject")
	}
	if auth.NonceCount() != 0 {
		t.Fatal("failed verification must not consume a nonce")
	}
}

func TestHMACAuthorizerExpiredTimestamp(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	auth := NewHMACAuthorizer([][]byte{testKey}).SetClock(fixedClock(now))
	fb := &fakeBus{}
	api := New(auth, fb)

	tooOld := now.Add(-time.Minute - time.Second)
	tooNew := now.Add(time.Minute + time.Second)
	for i, ts := range []time.Time{tooOld, tooNew} {
		rec := httptest.NewRecorder()
		api.ServeHTTP(rec, signedRequest(t, testKey, ts, nonceFor(10+i)))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("ts %v code = %d, want 401", ts, rec.Code)
		}
	}
	// Exactly at the window edge is still accepted (±60s inclusive).
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, signedRequest(t, testKey, now.Add(-time.Minute), "nonce-edge-000001"))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("edge timestamp code = %d, want 202", rec.Code)
	}
	if len(fb.frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(fb.frames))
	}
}

func TestHMACAuthorizerReplayRejected(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	auth := NewHMACAuthorizer([][]byte{testKey}).SetClock(fixedClock(now))
	fb := &fakeBus{}
	api := New(auth, fb)

	first := signedRequest(t, testKey, now, "nonce-replayed-0001")
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, first)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first use code = %d, want 202", rec.Code)
	}

	// Byte-identical replay (same ts, same nonce, same MAC).
	replay := httptest.NewRequest(http.MethodPost, "/admin/inject", bytes.NewBufferString(`{"kind":101}`))
	replay.Header.Set("Authorization", first.Header.Get("Authorization"))
	rec = httptest.NewRecorder()
	api.ServeHTTP(rec, replay)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("replay code = %d, want 401", rec.Code)
	}
	if len(fb.frames) != 1 {
		t.Fatalf("frames = %d, want 1 (replay must not inject)", len(fb.frames))
	}
}

func TestHMACAuthorizerHeaderForms(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	auth := NewHMACAuthorizer([][]byte{testKey}).SetClock(fixedClock(now))
	cases := []struct {
		header string
		want   error
	}{
		{"", ErrMissingCredentials},
		{"Bearer abc", ErrMissingCredentials},
		{"OC-HMAC", ErrMissingCredentials},
		{"OC-HMAC nots:nonce-00000001:" + strings.Repeat("a", 64), ErrMalformed},
		{"OC-HMAC 1700000000:n:0011", ErrMalformed},
		{"OC-HMAC 1700000000:nonce-00000001", ErrMalformed},
		{"OC-HMAC 1700000000:nonce-0000001:zz", ErrMalformed},
		{"OC-HMAC 1700000000:nonce-0000001:" + strings.Repeat("0", 64), ErrSignature},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPost, "/admin/inject", nil)
		if c.header != "" {
			r.Header.Set("Authorization", c.header)
		}
		if err := auth.Authorize(r); !errors.Is(err, c.want) {
			t.Fatalf("header %q err = %v, want %v", c.header, err, c.want)
		}
	}
}

func TestHMACAuthorizerNoKeysFailsClosed(t *testing.T) {
	auth := NewHMACAuthorizer(nil)
	r := httptest.NewRequest(http.MethodGet, "/admin/inject", nil)
	if err := auth.Authorize(r); !errors.Is(err, ErrNoKeys) {
		t.Fatalf("err = %v, want ErrNoKeys", err)
	}
}

func TestHMACKeyRotationBothKeysAccepted(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	oldKey := []byte("old-key-0123456789abcdef012345")
	newKey := []byte("new-key-0123456789abcdef012345")
	auth := NewHMACAuthorizer([][]byte{newKey, oldKey}).SetClock(fixedClock(now))
	for i, k := range [][]byte{oldKey, newKey} {
		r := signedRequest(t, k, now, "rot-nonce-000"+strconv.Itoa(i))
		if err := auth.Authorize(r); err != nil {
			t.Fatalf("key %d rejected: %v", i, err)
		}
	}
}

func TestHMACNonceCacheEviction(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	auth := NewHMACAuthorizer([][]byte{testKey}).SetClock(fixedClock(now)).SetNonceCapacity(2)
	for i := 1; i <= 2; i++ {
		if err := auth.Authorize(signedRequest(t, testKey, now, nonceFor(i))); err != nil {
			t.Fatalf("nonce %d: %v", i, err)
		}
	}
	if auth.NonceCount() != 2 {
		t.Fatalf("cache = %d, want 2", auth.NonceCount())
	}
	// Third nonce evicts the LRU entry; the cache stays bounded.
	if err := auth.Authorize(signedRequest(t, testKey, now, nonceFor(3))); err != nil {
		t.Fatalf("third nonce: %v", err)
	}
	if auth.NonceCount() != 2 {
		t.Fatalf("cache = %d after eviction, want 2", auth.NonceCount())
	}
}

func TestHMACSignerVerifierRoundTrip(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	signer := NewHMACSigner(testKey)
	signer.Now = fixedClock(now)
	auth := NewHMACAuthorizer([][]byte{testKey}).SetClock(fixedClock(now))

	for i := 0; i < 2; i++ { // second call proves fresh nonces (no self-replay)
		r := httptest.NewRequest(http.MethodGet, "/admin/inject", nil)
		if err := signer.Authorize(r); err != nil {
			t.Fatalf("sign %d: %v", i, err)
		}
		if got := r.Header.Get("Authorization"); !strings.HasPrefix(got, AuthScheme+" ") {
			t.Fatalf("header = %q", got)
		}
		if err := auth.Authorize(r); err != nil {
			t.Fatalf("verify %d: %v", i, err)
		}
	}
}

func TestHMACBindNonceMode(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	signer := NewHMACSigner(testKey)
	signer.Now = fixedClock(now)
	signer.BindNonce = true
	auth := NewHMACAuthorizer([][]byte{testKey}).SetClock(fixedClock(now)).BindNonce(true)

	r := httptest.NewRequest(http.MethodPost, "/admin/inject", nil)
	if err := signer.Authorize(r); err != nil {
		t.Fatalf("sign: %v", err)
	}
	if err := auth.Authorize(r); err != nil {
		t.Fatalf("verify bound nonce: %v", err)
	}

	// Swapping the nonce invalidates a bound MAC (that is the whole point).
	parts := strings.SplitN(strings.TrimPrefix(r.Header.Get("Authorization"), AuthScheme+" "), ":", 3)
	r2 := httptest.NewRequest(http.MethodPost, "/admin/inject", nil)
	r2.Header.Set("Authorization", AuthScheme+" "+parts[0]+":nonce-tampered-0001:"+parts[2])
	if err := auth.Authorize(r2); !errors.Is(err, ErrSignature) {
		t.Fatalf("tampered nonce err = %v, want ErrSignature", err)
	}
}

func TestCanonicalForm(t *testing.T) {
	if got, want := Canonical("post", "/admin/inject", 1700000000), "POST|/admin/inject|1700000000"; got != want {
		t.Fatalf("Canonical = %q, want %q", got, want)
	}
	if got, want := CanonicalWithNonce("GET", "/x", 1, "abc"), "GET|/x|1|abc"; got != want {
		t.Fatalf("CanonicalWithNonce = %q, want %q", got, want)
	}
	if Sign(testKey, "POST|/admin/inject|1700000000") == Sign(testKey, "POST|/admin/inject|1700000001") {
		t.Fatal("different timestamps must produce different MACs")
	}
}

func TestRandomNonce(t *testing.T) {
	a, err := RandomNonce()
	if err != nil {
		t.Fatal(err)
	}
	b, err := RandomNonce()
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("nonces repeat")
	}
	if len(a) != 32 {
		t.Fatalf("nonce length = %d, want 32", len(a))
	}
}
