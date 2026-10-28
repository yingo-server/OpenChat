package middleware

import (
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// LockPolicy is the login failure escalation policy (docs/security-spec A-1).
// It is data, not hardcoded into the limiter logic.
type LockPolicy struct {
	Threshold int             // failures per step
	Durations []time.Duration // 15m, 1h, 24h
}

// DefaultLockPolicy returns the security-spec baseline.
func DefaultLockPolicy() LockPolicy {
	return LockPolicy{
		Threshold: 5,
		Durations: []time.Duration{15 * time.Minute, time.Hour, 24 * time.Hour},
	}
}

type failureState struct {
	failures    int
	stage       int
	lockedUntil time.Time
}

// LockStatus is the answer to "can this login proceed?".
type LockStatus struct {
	Locked     bool
	Until      time.Time
	RetryAfter time.Duration
}

// LoginLimiter implements A-1: exponential lockout counted on BOTH the
// account and the source fingerprint, with 5 failures per escalation step.
type LoginLimiter struct {
	mu     sync.Mutex
	policy LockPolicy
	now    func() time.Time

	accounts     map[string]*failureState
	fingerprints map[string]*failureState

	failures atomic.Uint64
	lockouts atomic.Uint64
}

// NewLoginLimiter builds a limiter; zero policy falls back to the default.
func NewLoginLimiter(p LockPolicy) *LoginLimiter {
	if p.Threshold <= 0 || len(p.Durations) == 0 {
		p = DefaultLockPolicy()
	}
	return &LoginLimiter{
		policy: p, now: time.Now,
		accounts: map[string]*failureState{}, fingerprints: map[string]*failureState{},
	}
}

// SetClock injects a test clock.
func (l *LoginLimiter) SetClock(now func() time.Time) {
	if now != nil {
		l.now = now
	}
}

func normalizeAccount(a string) string {
	return strings.ToLower(strings.TrimSpace(a))
}

// Check reports whether account or fingerprint is currently locked. Both
// dimensions are evaluated; the longer remaining lock wins.
func (l *LoginLimiter) Check(account, fingerprint string) LockStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.checkLocked(account, fingerprint)
}

func (l *LoginLimiter) checkLocked(account, fingerprint string) LockStatus {
	now := l.now()
	var best LockStatus
	for _, st := range []*failureState{
		l.accounts[normalizeAccount(account)],
		l.fingerprints[fingerprint],
	} {
		if st == nil || st.lockedUntil.IsZero() {
			continue
		}
		if now.Before(st.lockedUntil) {
			remain := st.lockedUntil.Sub(now)
			if remain > best.RetryAfter {
				best = LockStatus{Locked: true, Until: st.lockedUntil, RetryAfter: remain}
			}
		}
	}
	return best
}

// Failure records one failed attempt on both dimensions and returns the
// resulting lock state (zero when no lock is active yet).
func (l *LoginLimiter) Failure(account, fingerprint string) LockStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failures.Add(1)
	now := l.now()
	account = normalizeAccount(account)
	l.bump(l.accounts, account, now)
	l.bump(l.fingerprints, fingerprint, now)
	status := l.checkLocked(account, fingerprint)
	if status.Locked {
		l.lockouts.Add(1)
	}
	return status
}

func (l *LoginLimiter) bump(m map[string]*failureState, key string, now time.Time) {
	if key == "" {
		return
	}
	st := m[key]
	if st == nil {
		st = &failureState{}
		m[key] = st
	}
	st.failures++
	if st.failures < l.policy.Threshold {
		return
	}
	st.failures = 0
	st.stage++
	idx := st.stage - 1
	if idx >= len(l.policy.Durations) {
		idx = len(l.policy.Durations) - 1
	}
	st.lockedUntil = now.Add(l.policy.Durations[idx])
}

// Success clears both counters for the successful principal. A successful
// login is proof the account holder knows the password + TOTP; keeping the
// account locked would be a self-inflicted denial of service.
func (l *LoginLimiter) Success(account, fingerprint string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.accounts, normalizeAccount(account))
	delete(l.fingerprints, fingerprint)
}

// Stats returns (failed attempts, lock events) for metrics.
func (l *LoginLimiter) Stats() (failures, lockouts uint64) {
	return l.failures.Load(), l.lockouts.Load()
}

// Reset clears all state (test seam).
func (l *LoginLimiter) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.accounts = map[string]*failureState{}
	l.fingerprints = map[string]*failureState{}
}

// OpLimiterConfig holds management-operation budgets (A-3).
type OpLimiterConfig struct {
	PerMinute         int
	HighRiskPerMinute int
	Window            time.Duration
}

// DefaultOpLimiterConfig is the security-spec baseline: 60 op/min normal,
// 10 op/min for high-risk actions.
func DefaultOpLimiterConfig() OpLimiterConfig {
	return OpLimiterConfig{PerMinute: 60, HighRiskPerMinute: 10, Window: time.Minute}
}

type opBucket struct {
	start time.Time
	count int
}

// OpLimiter is an in-memory fixed-window limiter per admin and risk class.
// (Per-process is acceptable: admin instances are deployed as a single
// process behind Caddy; the bridge remains the cross-process authority.)
type OpLimiter struct {
	mu      sync.Mutex
	cfg     OpLimiterConfig
	now     func() time.Time
	buckets map[string]*opBucket
	hits    atomic.Uint64
}

// NewOpLimiter builds an operation limiter.
func NewOpLimiter(cfg OpLimiterConfig) *OpLimiter {
	if cfg.PerMinute <= 0 {
		cfg.PerMinute = 60
	}
	if cfg.HighRiskPerMinute <= 0 {
		cfg.HighRiskPerMinute = 10
	}
	if cfg.Window <= 0 {
		cfg.Window = time.Minute
	}
	return &OpLimiter{cfg: cfg, now: time.Now, buckets: map[string]*opBucket{}}
}

// SetClock injects a test clock.
func (l *OpLimiter) SetClock(now func() time.Time) {
	if now != nil {
		l.now = now
	}
}

// Allow consumes one token and reports whether the call may proceed plus the
// Retry-After duration on rejection.
func (l *OpLimiter) Allow(adminID int64, highRisk bool) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	limit := l.cfg.PerMinute
	kind := "normal"
	if highRisk {
		limit = l.cfg.HighRiskPerMinute
		kind = "high"
	}
	key := itoa64(adminID) + ":" + kind
	now := l.now()
	b := l.buckets[key]
	if b == nil || now.Sub(b.start) >= l.cfg.Window {
		b = &opBucket{start: now}
		l.buckets[key] = b
	}
	if b.count >= limit {
		l.hits.Add(1)
		return false, b.start.Add(l.cfg.Window).Sub(now)
	}
	b.count++
	return true, 0
}

// Hits returns the number of rejected operations (metrics).
func (l *OpLimiter) Hits() uint64 { return l.hits.Load() }

// Middleware enforces the budget for one route class.
func (l *OpLimiter) Middleware(highRisk bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			admin := IdentityFrom(r.Context())
			if admin == nil {
				WriteError(w, r, http.StatusUnauthorized, "unauthenticated")
				return
			}
			ok, retry := l.Allow(admin.AdminID, highRisk)
			if !ok {
				secs := int(retry.Seconds())
				if secs < 1 {
					secs = 1
				}
				w.Header().Set("Retry-After", itoa64(int64(secs)))
				WriteError(w, r, http.StatusTooManyRequests, "rate_limited")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func itoa64(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
