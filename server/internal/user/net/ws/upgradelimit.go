// upgradelimit.go: /ws upgrade 的按 IP + token 双维度限流 + 失败熔断
// （security-spec E-3/E-4 红线在应用层的落地）。
//
// 机制（写死）：
//   - 双维度令牌桶：IP 维度 + token 维度各自独立令牌桶，任一耗尽即拒
//     （更严格者胜）。token 维度的 key 为原始 token 串的 sha256 前 16 hex
//     （无需解密 JWT）；未带 token 的请求共享 key="" 的一个桶（防爆破）。
//   - 429 后重新计时：一旦触发 429（任一维度），该维度的计时窗口从拒绝那
//     一刻重新开始 —— last=now 但 tokens 不补，须再等一个满窗口才能过。
//     防止持续小批量试探烧穿。IP 与 token 两个维度在被拒时各自都重新计时。
//   - 失败熔断：滑动窗口内（默认 5 分钟）鉴权失败 ≥ 阈值（默认 8 次）→
//     封禁（默认 15 分钟）。IP 与 token 各自独立熔断，任一封即拒。
//
// 策略参数放在 ws.Config（UpgradeRatePerMin / UpgradeBurst /
// UpgradeFailureThreshold / UpgradeFailureWindow / UpgradeBanFor），可由
// user/core/policy 覆盖（policy 若有对应字段则透传，否则取 ws.Config 默认）。
// 两个维度共用同一组参数（简单起见，见 NewUpgradeLimiter 注释）。
//
// 判定发生在鉴权之前：被限 → 429 + Retry-After，不建连、不查 session。
// 鉴权失败（401）时额外扣一次 token —— 失败也消耗配额，防止暴力尝试，
// IP 与 token 两个维度同时扣。
package ws

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// UpgradeLimiter 是按 IP + token 双维度的升限流器。零值不可用，用
// NewUpgradeLimiter。
type UpgradeLimiter struct {
	ratePerMin    float64       // 每分钟补充的 token 数（两维度同参）
	burst         float64       // 令牌桶容量（两维度同参）
	failThreshold int           // 熔断阈值（窗口内失败次数）
	failWindow    time.Duration // 失败统计的滑动窗口
	banFor        time.Duration // 命中断路后的封禁时长

	now func() time.Time // 可注入的时钟（测试用）

	mu     sync.Mutex
	ips    map[string]*bucketState
	tokens map[string]*bucketState
}

// bucketState 是一个维度（IP 或 token）下某个 subject 的独立令牌桶 +
// 失败熔断状态。两个维度共用同一结构。
type bucketState struct {
	tokens      float64
	last        time.Time
	failures    []time.Time
	bannedUntil time.Time
}

// NewUpgradeLimiter 构造限流器；<=0 的参数取默认值
// （10/min、burst 20、阈值 8、窗口 5min、封禁 15min）。IP 与 token 两个维度
// 共用同一组参数（简单起见；如需各自独立可配，扩 Config 即可）。
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
		ips:           make(map[string]*bucketState),
		tokens:        make(map[string]*bucketState),
	}
}

// state returns (creating if needed) the bucket for key in m, lazily refilled.
// Caller must hold u.mu.
func (u *UpgradeLimiter) state(m map[string]*bucketState, key string, now time.Time) *bucketState {
	st, ok := m[key]
	if !ok {
		st = &bucketState{tokens: u.burst, last: now}
		m[key] = st
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

// tokenKey derives the token-dimension bucket key: sha256 of the raw token
// string, first 16 hex chars. No JWT parsing needed (the limiter runs before
// auth). Empty token (not presented) maps to the shared key "" — one bucket
// shared by all unauthenticated requests (blast-radius control).
func tokenKey(rawToken string) string {
	if rawToken == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(rawToken))
	return hex.EncodeToString(sum[:8])
}

// Allow reports whether an upgrade attempt from ip with rawToken may proceed.
// Dual verdict: both the IP bucket and the token bucket must have >= 1 token;
// either exhausted → refused (the stricter wins). When refused, the buckets
// that triggered the refusal have their timing windows restarted (last = now
// WITHOUT refilling tokens), so the subject must wait a full window again —
// "触发一次就从头再等", preventing sustained probing. Both dimensions restart
// when both trigger. retryAfter is the time until the next token (or until a
// ban lifts).
func (u *UpgradeLimiter) Allow(ip, rawToken string) (allowed bool, retryAfter time.Duration) {
	now := u.now()
	u.mu.Lock()
	defer u.mu.Unlock()
	u.pruneLocked(now)

	ipSt := u.state(u.ips, ip, now)
	tokSt := u.state(u.tokens, tokenKey(rawToken), now)

	// 熔断（任一封即拒）。
	if now.Before(ipSt.bannedUntil) {
		return false, ipSt.bannedUntil.Sub(now)
	}
	if now.Before(tokSt.bannedUntil) {
		return false, tokSt.bannedUntil.Sub(now)
	}

	ipOK := ipSt.tokens >= 1
	tokOK := tokSt.tokens >= 1
	if ipOK && tokOK {
		ipSt.tokens--
		tokSt.tokens--
		return true, 0
	}

	// 任一维度耗尽 → 拒。触发拒绝的维度把时间戳重置为 now（tokens 不补），
	// 计时窗口从拒绝这一刻重新开始 —— 语义即「重新计时」：要再等一个满
	// 窗口（burst/rate 分钟）才能重新攒够。两个维度都触发时各自都重新计时。
	var retry time.Duration
	if !ipOK {
		ipSt.last = now // restart the IP window
		retry = u.retryAfterLocked(ipSt, now)
	}
	if !tokOK {
		tokSt.last = now // restart the token window
		if r := u.retryAfterLocked(tokSt, now); r > retry {
			retry = r
		}
	}
	return false, retry
}

// retryAfterLocked estimates the wait until one token is available.
// Caller must hold u.mu.
func (u *UpgradeLimiter) retryAfterLocked(st *bucketState, now time.Time) time.Duration {
	need := 1 - st.tokens
	secs := need / u.ratePerMin * 60.0
	if secs < 1 {
		secs = 1
	}
	return time.Duration(secs * float64(time.Second))
}

// RecordFailure consumes an extra token and records an auth failure for both
// the IP and the token dimension. Enough failures inside the window trip that
// dimension's circuit breaker (ban). Failure refusals also restart both
// windows (same "重新计时" semantics as Allow).
func (u *UpgradeLimiter) RecordFailure(ip, rawToken string) {
	now := u.now()
	u.mu.Lock()
	defer u.mu.Unlock()

	ipSt := u.state(u.ips, ip, now)
	tokSt := u.state(u.tokens, tokenKey(rawToken), now)

	for _, st := range []*bucketState{ipSt, tokSt} {
		// 失败也消耗配额：除 Allow 已扣的 1 个 token 外再扣 1 个。
		st.tokens--
		// 计时窗口重新开始（见 Allow 的注释）。
		st.last = now
		st.failures = append(st.failures, now)
		if len(st.failures) >= u.failThreshold {
			st.bannedUntil = now.Add(u.banFor)
			st.failures = nil
		}
	}
}

// pruneLocked evicts idle entries so the maps cannot grow without bound.
// Caller must hold u.mu.
func (u *UpgradeLimiter) pruneLocked(now time.Time) {
	idle := now.Add(-u.failWindow)
	if len(u.ips) >= 4096 {
		for ip, st := range u.ips {
			if now.Before(st.bannedUntil) {
				continue
			}
			if st.last.Before(idle) && len(st.failures) == 0 {
				delete(u.ips, ip)
			}
		}
	}
	if len(u.tokens) >= 4096 {
		for key, st := range u.tokens {
			if now.Before(st.bannedUntil) {
				continue
			}
			if st.last.Before(idle) && len(st.failures) == 0 {
				delete(u.tokens, key)
			}
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
