// upgradelimit.go: /ws upgrade 的按 IP 限流 + 失败熔断（security-spec E-3/E-4
// 红线在应用层的落地）。
//
// 机制（写死）：
//   - 按来源 IP 的令牌桶：默认 10 次/分钟，burst 20；
//   - 失败熔断：滑动窗口内（默认 5 分钟）鉴权失败 ≥ 阈值（默认 8 次）→ 封禁
//     该 IP（默认 15 分钟）。
//
// 策略参数放在 ws.Config（UpgradeRatePerMin / UpgradeBurst /
// UpgradeFailureThreshold / UpgradeFailureWindow / UpgradeBanFor），可由
// user/core/policy 覆盖（policy 若有对应字段则透传，否则取 ws.Config 默认）。
//
// 判定发生在鉴权之前：被限 → 429 + Retry-After，不建连、不查 session。
// 鉴权失败（401）时额外扣一次 token —— 失败也消耗配额，防止暴力尝试。
package ws

import (
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// UpgradeLimiter 是按 IP 的升限流器。零值不可用，用 NewUpgradeLimiter。
type UpgradeLimiter struct {
	ratePerMin    float64       // 每分钟补充的 token 数
	burst         float64       // 令牌桶容量
	failThreshold int           // 熔断阈值（窗口内失败次数）
	failWindow    time.Duration // 失败统计的滑动窗口
	banFor        time.Duration // 命中断路后的封禁时长

	now func() time.Time // 可注入的时钟（测试用）

	mu  sync.Mutex
	ips map[string]*ipState
}

type ipState struct {
	tokens      float64
	last        time.Time
	failures    []time.Time
	bannedUntil time.Time
}

// NewUpgradeLimiter 构造限流器；<=0 的参数取默认值
// （10/min、burst 20、阈值 8、窗口 5min、封禁 15min）。
func NewUpgradeLimiter(ratePerMin, burst float64, failThreshold int, failWindow, banFor time.Duration) *UpgradeLimiter {
	if ratePerMin <= 0 {
		ratePerMin = 10
	}
	if burst <= 0 {
		burst = 20
	}
	if failThreshold <= 0 {
		failThreshold = 8
	}
	if failWindow <= 0 {
		failWindow = 5 * time.Minute
	}
	if banFor <= 0 {
		banFor = 15 * time.Minute
	}
	return &UpgradeLimiter{
		ratePerMin:    ratePerMin,
		burst:         burst,
		failThreshold: failThreshold,
		failWindow:    failWindow,
		banFor:        banFor,
		now:           time.Now,
		ips:           make(map[string]*ipState),
	}
}

// state returns (creating if needed) the per-IP bucket, lazily refilled.
// Caller must hold u.mu.
func (u *UpgradeLimiter) state(ip string, now time.Time) *ipState {
	st, ok := u.ips[ip]
	if !ok {
		st = &ipState{tokens: u.burst, last: now}
		u.ips[ip] = st
		return st
	}
	// refill by elapsed time.
	if elapsed := now.Sub(st.last); elapsed > 0 {
		st.tokens += elapsed.Minutes() * u.ratePerMin
		if st.tokens > u.burst {
			st.tokens = u.burst
		}
		st.last = now
	}
	// drop failures that slid out of the window (keeps the slice bounded).
	if len(st.failures) > 0 {
		cut := now.Add(-u.failWindow)
		kept := st.failures[:0]
		for _, t := range st.failures {
			if t.After(cut) {
				kept = append(kept, t)
			}
		}
		st.failures = kept
	}
	return st
}

// Allow reports whether an upgrade attempt from ip may proceed. When refused,
// retryAfter is the time until the next token (or until the ban lifts).
func (u *UpgradeLimiter) Allow(ip string) (allowed bool, retryAfter time.Duration) {
	now := u.now()
	u.mu.Lock()
	defer u.mu.Unlock()
	u.pruneLocked(now)

	st := u.state(ip, now)
	if now.Before(st.bannedUntil) {
		return false, st.bannedUntil.Sub(now)
	}
	if st.tokens >= 1 {
		st.tokens--
		return true, 0
	}
	// time to accumulate one token at the current rate.
	need := 1 - st.tokens
	secs := need / u.ratePerMin * 60.0
	if secs < 1 {
		secs = 1
	}
	return false, time.Duration(secs * float64(time.Second))
}

// RecordFailure consumes an extra token and records an auth failure for ip.
// Enough failures inside the window trip the circuit breaker (ban).
func (u *UpgradeLimiter) RecordFailure(ip string) {
	now := u.now()
	u.mu.Lock()
	defer u.mu.Unlock()

	st := u.state(ip, now)
	// 失败也消耗配额：除 Allow 已扣的 1 个 token 外再扣 1 个。
	st.tokens--
	st.failures = append(st.failures, now)
	if len(st.failures) >= u.failThreshold {
		st.bannedUntil = now.Add(u.banFor)
		st.failures = nil
	}
}

// pruneLocked evicts idle entries so the map cannot grow without bound.
// Caller must hold u.mu.
func (u *UpgradeLimiter) pruneLocked(now time.Time) {
	if len(u.ips) < 4096 {
		return
	}
	idle := now.Add(-u.failWindow)
	for ip, st := range u.ips {
		if now.Before(st.bannedUntil) {
			continue
		}
		if st.last.Before(idle) && len(st.failures) == 0 {
			delete(u.ips, ip)
		}
	}
}

// clientIP resolves the caller address for rate limiting. X-Forwarded-For is
// trusted only when the immediate peer is loopback (Caddy fronts the process).
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if isLoopbackHost(host) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			first := strings.TrimSpace(strings.Split(xff, ",")[0])
			if ip := net.ParseIP(first); ip != nil {
				return ip.String()
			}
		}
		if ip := net.ParseIP(strings.TrimSpace(r.Header.Get("X-Real-IP"))); ip != nil {
			return ip.String()
		}
	}
	return host
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// retryAfterSeconds renders a Retry-After value (seconds, >=1).
func retryAfterSeconds(d time.Duration) string {
	s := int(math.Ceil(d.Seconds()))
	if s < 1 {
		s = 1
	}
	return strconv.Itoa(s)
}
