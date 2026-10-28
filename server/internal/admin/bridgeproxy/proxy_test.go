package bridgeproxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestInjectFrameSuccess(t *testing.T) {
	var got injectRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/inject" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("X-Test-Auth") != "yes" {
			t.Errorf("authorizer header missing")
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"topic":"user.42","kind":960}`))
	}))
	defer srv.Close()

	p, err := New(Config{BaseURL: srv.URL, Retries: -1, Authorizer: testAuth{}})
	if err != nil {
		t.Fatal(err)
	}
	res, err := p.InjectFrame(context.Background(), 960, Target{UserID: 42}, []byte(`{"op":"ban"}`))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 202 || res.Topic != "user.42" || res.Kind != 960 {
		t.Fatalf("result = %+v", res)
	}
	payload, _ := base64.StdEncoding.DecodeString(got.PayloadB64)
	if got.Kind != 960 || got.UserID != 42 || string(payload) != `{"op":"ban"}` {
		t.Fatalf("request = %+v payload=%s", got, payload)
	}
	st := p.Stats()
	if st.Requests != 1 || st.Successes != 1 || st.Attempts != 1 {
		t.Fatalf("stats = %+v", st)
	}
}

type testAuth struct{}

func (testAuth) Authorize(r *http.Request) error {
	r.Header.Set("X-Test-Auth", "yes")
	return nil
}

func TestInjectFrameRetriesThenSucceeds(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) < 3 {
			http.Error(w, "boom", http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"topic":"sys.admin","kind":960}`))
	}))
	defer srv.Close()
	p, err := New(Config{BaseURL: srv.URL, Retries: 2, Backoff: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.InjectFrame(context.Background(), 960, Target{}, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if n.Load() != 3 {
		t.Fatalf("attempts = %d, want 3", n.Load())
	}
	st := p.Stats()
	if st.Retries != 2 || st.Attempts != 3 {
		t.Fatalf("stats = %+v", st)
	}
}

func TestCircuitBreakerOpensAndRecovers(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if fail.Load() {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	now := time.Unix(1_700_000_000, 0)
	p, err := New(Config{
		BaseURL: srv.URL, Retries: -1, BreakerThreshold: 5,
		BreakerOpen: 30 * time.Second, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err := p.InjectFrame(context.Background(), 960, Target{}, nil); err == nil {
			t.Fatalf("attempt %d unexpectedly succeeded", i)
		}
	}
	before := hits.Load()
	_, err = p.InjectFrame(context.Background(), 960, Target{}, nil)
	if !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("err = %v, want ErrCircuitOpen", err)
	}
	if hits.Load() != before {
		t.Fatal("open circuit still hit the network")
	}
	st := p.Stats()
	if !st.CircuitOpen || st.CircuitOpened != 1 {
		t.Fatalf("stats = %+v", st)
	}

	// After 30s the breaker half-opens; with the backend healthy it closes.
	now = now.Add(31 * time.Second)
	fail.Store(false)
	if _, err := p.InjectFrame(context.Background(), 960, Target{}, nil); err != nil {
		t.Fatalf("half-open probe: %v", err)
	}
	if p.Stats().CircuitOpen {
		t.Fatal("breaker did not close after success")
	}
}

func TestTimeoutIsBounded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(100 * time.Millisecond)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()
	p, err := New(Config{BaseURL: srv.URL, Retries: -1, Timeout: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, err := p.InjectFrame(context.Background(), 960, Target{}, nil); err == nil {
		t.Fatal("expected timeout")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("timeout took %v", elapsed)
	}
}

func TestNonRetryable4xx(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		http.Error(w, "bad", http.StatusBadRequest)
	}))
	defer srv.Close()
	p, err := New(Config{BaseURL: srv.URL, Retries: 2, Backoff: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.InjectFrame(context.Background(), 960, Target{}, nil)
	var he *HTTPError
	if !errors.As(err, &he) || he.StatusCode != 400 {
		t.Fatalf("err = %v", err)
	}
	if n.Load() != 1 {
		t.Fatalf("4xx retried: attempts = %d", n.Load())
	}
}
