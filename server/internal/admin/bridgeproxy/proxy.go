package bridgeproxy

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Authorizer adds authentication to outgoing bridge AdminAPI requests
// (structural match with bridge/adminapi.Authorizer).
type Authorizer interface {
	Authorize(r *http.Request) error
}

// Target is the routing target of an injected frame.
type Target struct {
	ConvID uint64
	UserID uint64
}

// Result is a successful injection response.
type Result struct {
	StatusCode int
	Topic      string
	Kind       uint32
}

// Stats is a point-in-time circuit/transport snapshot.
type Stats struct {
	Requests      uint64
	Attempts      uint64
	Successes     uint64
	Failures      uint64
	Retries       uint64
	CircuitOpened uint64
	CircuitOpen   bool
	Consecutive   int
}

// Config controls transport and breaker behavior.
type Config struct {
	BaseURL          string
	Timeout          time.Duration // per attempt; default 5s
	Retries          int           // retries after first attempt; default 2, -1 = none
	BreakerThreshold int           // consecutive logical failures; default 5
	BreakerOpen      time.Duration // open duration; default 30s
	Backoff          time.Duration // first retry delay; default 100ms
	Authorizer       Authorizer
	HTTPClient       *http.Client
	Now              func() time.Time
}

var (
	// ErrCircuitOpen means the breaker is open; callers should return 503.
	ErrCircuitOpen = errors.New("bridgeproxy: circuit open")
	// ErrUnavailable means all retry attempts failed.
	ErrUnavailable = errors.New("bridgeproxy: bridge unavailable")
)

// HTTPError is a non-retryable bridge response (4xx).
type HTTPError struct {
	StatusCode int
	Body       string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("bridgeproxy: bridge returned %d: %s", e.StatusCode, truncate(e.Body, 200))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// Proxy is a concurrent-safe client for bridge AdminAPI.
type Proxy struct {
	cfg    Config
	client *http.Client

	mu          sync.Mutex
	consecutive int
	openUntil   time.Time

	requests      atomic.Uint64
	attempts      atomic.Uint64
	successes     atomic.Uint64
	failures      atomic.Uint64
	retries       atomic.Uint64
	circuitOpened atomic.Uint64
}

// New validates config and builds a proxy.
func New(cfg Config) (*Proxy, error) {
	if strings.TrimSpace(cfg.BaseURL) == "" {
		return nil, errors.New("bridgeproxy: BaseURL required")
	}
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("bridgeproxy: invalid BaseURL %q", cfg.BaseURL)
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Second
	}
	if cfg.Retries < 0 {
		cfg.Retries = 0
	} else if cfg.Retries == 0 {
		// zero value default is 2; callers wanting none set -1
		cfg.Retries = 2
	}
	if cfg.BreakerThreshold <= 0 {
		cfg.BreakerThreshold = 5
	}
	if cfg.BreakerOpen <= 0 {
		cfg.BreakerOpen = 30 * time.Second
	}
	if cfg.Backoff <= 0 {
		cfg.Backoff = 100 * time.Millisecond
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: cfg.Timeout}
	}
	return &Proxy{cfg: cfg, client: cfg.HTTPClient}, nil
}

type injectRequest struct {
	Kind       uint32 `json:"kind"`
	ConvID     uint64 `json:"conv_id,omitempty"`
	UserID     uint64 `json:"user_id,omitempty"`
	PayloadB64 string `json:"payload_b64"`
}

type injectResponse struct {
	Topic string `json:"topic"`
	Kind  uint32 `json:"kind"`
}

// InjectFrame is the generic injection primitive: kind + target + opaque
// payload bytes. It is the only method that performs HTTP.
func (p *Proxy) InjectFrame(ctx context.Context, kind uint32, target Target, payload []byte) (Result, error) {
	if kind == 0 {
		return Result{}, errors.New("bridgeproxy: kind required")
	}
	p.requests.Add(1)
	if err := p.breakerCheck(); err != nil {
		return Result{}, err
	}

	body, err := json.Marshal(injectRequest{
		Kind:       kind,
		ConvID:     target.ConvID,
		UserID:     target.UserID,
		PayloadB64: base64.StdEncoding.EncodeToString(payload),
	})
	if err != nil {
		return Result{}, fmt.Errorf("bridgeproxy: marshal request: %w", err)
	}

	maxAttempts := p.cfg.Retries + 1
	endpoint := strings.TrimRight(p.cfg.BaseURL, "/") + "/admin/inject"
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			p.retries.Add(1)
			if err := sleepCtx(ctx, p.cfg.Backoff*time.Duration(1<<(attempt-2))); err != nil {
				return Result{}, err
			}
		}
		p.attempts.Add(1)

		res, err := p.doOnce(ctx, endpoint, body)
		if err == nil {
			p.breakerSuccess()
			p.successes.Add(1)
			return res, nil
		}
		lastErr = err
		if !retryable(err) {
			break
		}
	}

	p.failures.Add(1)
	if lastErr == nil {
		lastErr = ErrUnavailable
	}
	// Semantic rejects (4xx / auth) are not bridge availability signals and
	// must not open the breaker.
	var he *HTTPError
	if errors.As(lastErr, &he) {
		return Result{}, lastErr
	}
	var ae *authError
	if errors.As(lastErr, &ae) {
		return Result{}, lastErr
	}
	p.breakerFailure()
	if errors.Is(lastErr, context.DeadlineExceeded) || errors.Is(lastErr, context.Canceled) {
		return Result{}, lastErr
	}
	return Result{}, fmt.Errorf("%w: %v", ErrUnavailable, lastErr)
}

func (p *Proxy) doOnce(ctx context.Context, endpoint string, body []byte) (Result, error) {
	actx := ctx
	var cancel context.CancelFunc
	if p.cfg.Timeout > 0 {
		actx, cancel = context.WithTimeout(ctx, p.cfg.Timeout)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(actx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.cfg.Authorizer != nil {
		if err := p.cfg.Authorizer.Authorize(req); err != nil {
			return Result{}, &authError{err: err}
		}
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
			return Result{}, fmt.Errorf("bridge status %d: %s", resp.StatusCode, truncate(string(raw), 200))
		}
		return Result{}, &HTTPError{StatusCode: resp.StatusCode, Body: string(raw)}
	}
	var out injectResponse
	_ = json.Unmarshal(raw, &out)
	return Result{StatusCode: resp.StatusCode, Topic: out.Topic, Kind: out.Kind}, nil
}

type authError struct{ err error }

func (e *authError) Error() string { return fmt.Sprintf("bridgeproxy: authorize: %v", e.err) }
func (e *authError) Unwrap() error { return e.err }

func retryable(err error) bool {
	var he *HTTPError
	if errors.As(err, &he) {
		return false // 4xx is a semantic reject; retrying cannot help
	}
	var ae *authError
	if errors.As(err, &ae) {
		return false
	}
	return true
}

func (p *Proxy) breakerCheck() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.openUntil.IsZero() {
		return nil
	}
	if p.cfg.Now().Before(p.openUntil) {
		return ErrCircuitOpen
	}
	// Half-open: allow one probe; a failure re-opens via breakerFailure.
	p.openUntil = time.Time{}
	return nil
}

func (p *Proxy) breakerSuccess() {
	p.mu.Lock()
	p.consecutive = 0
	p.openUntil = time.Time{}
	p.mu.Unlock()
}

func (p *Proxy) breakerFailure() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.consecutive++
	if p.consecutive >= p.cfg.BreakerThreshold {
		p.openUntil = p.cfg.Now().Add(p.cfg.BreakerOpen)
		p.circuitOpened.Add(1)
	}
}

// Stats returns a snapshot.
func (p *Proxy) Stats() Stats {
	p.mu.Lock()
	open := !p.openUntil.IsZero() && p.cfg.Now().Before(p.openUntil)
	consecutive := p.consecutive
	p.mu.Unlock()
	return Stats{
		Requests:      p.requests.Load(),
		Attempts:      p.attempts.Load(),
		Successes:     p.successes.Load(),
		Failures:      p.failures.Load(),
		Retries:       p.retries.Load(),
		CircuitOpened: p.circuitOpened.Load(),
		CircuitOpen:   open,
		Consecutive:   consecutive,
	}
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
