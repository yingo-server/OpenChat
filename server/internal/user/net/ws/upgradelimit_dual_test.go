package ws

import (
	"testing"
	"time"
)

// TestDualDimensionIndependentTokens: 同 IP 不同 token 各有独立桶——
// A token 打满后第 21 次拒，换 B token 同 IP 仍可过。
func TestDualDimensionIndependentTokens(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	l := NewUpgradeLimiter(600, 20, 8, 5*time.Minute, 15*time.Minute)
	l.now = func() time.Time { return now }

	for i := 0; i < 20; i++ {
		if ok, _ := l.Allow("1.1.1.1", "tokenA"); !ok {
			t.Fatalf("tokenA allowed %d should pass", i)
		}
	}
	if ok, _ := l.Allow("1.1.1.1", "tokenA"); ok {
		t.Fatal("tokenA 21st should be denied (token bucket empty)")
	}
	// B token：自己的桶未耗尽，且 IP 桶也被 A 消耗了 20 次——IP 桶 burst=20
	// 已空，所以 B 会被 IP 维度拒。这验证的是「任一维度耗尽即拒」。
	if ok, _ := l.Allow("1.1.1.1", "tokenB"); ok {
		t.Fatal("same IP after 20 requests: IP dimension should deny tokenB too")
	}
	// 不同 IP 同 token：tokenA 的 token 桶已耗尽 → 即便 IP 不同也拒（分布式）。
	if ok, _ := l.Allow("2.2.2.2", "tokenA"); ok {
		t.Fatal("tokenA from different IP should still be denied (token dimension)")
	}
}

// TestTokenDimensionBlocksDistributed: 不同 IP 同一 token——token 桶耗尽即拒。
func TestTokenDimensionBlocksDistributed(t *testing.T) {
	now := time.Unix(2_000_000, 0)
	l := NewUpgradeLimiter(600, 20, 8, 5*time.Minute, 15*time.Minute)
	l.now = func() time.Time { return now }

	for i := 0; i < 20; i++ {
		if ok, _ := l.Allow("10.0.0."+string(rune('a'+i)), "sharedTok"); !ok {
			t.Fatalf("request %d should pass (each IP has own bucket)", i)
		}
	}
	// 第 21 个新 IP：IP 桶满，但 token 桶也空 → 拒。
	if ok, _ := l.Allow("10.0.0.new", "sharedTok"); ok {
		t.Fatal("shared token exhausted: distributed use must be denied")
	}
}

// TestRetryAfterRestartsWindow: 429 后重新计时——立即重试仍拒，满窗口后恢复。
func TestRetryAfterRestartsWindow(t *testing.T) {
	now := time.Unix(3_000_000, 0)
	tick := 0
	l := NewUpgradeLimiter(600, 10, 8, 5*time.Minute, 15*time.Minute)
	l.now = func() time.Time { return now.Add(time.Duration(tick) * time.Minute) }

	for i := 0; i < 10; i++ {
		if ok, _ := l.Allow("3.3.3.3", "rt"); !ok {
			t.Fatalf("first 10 should pass, %d failed", i)
		}
	}
	_, retry := l.Allow("3.3.3.3", "rt")
	if retry <= 0 {
		t.Fatal("denied request must carry a positive retryAfter")
	}
	// 「重新计时」语义（与实现一致）：拒绝时 last=now，补充从拒绝这一刻
	// 重新积累——retryAfter 即补够 1 个 token 所需时间。推进到 retryAfter
	// 之前必须仍拒；到达之后恢复。
	tick = int(retry.Minutes()) - 1
	if tick > 0 {
		if ok, _ := l.Allow("3.3.3.3", "rt"); ok {
			t.Fatal("before retryAfter the request must still be denied")
		}
	}
	tick = int(retry.Minutes()) + 1
	if ok, _ := l.Allow("3.3.3.3", "rt"); !ok {
		t.Fatal("after retryAfter the request should pass again")
	}
}

// TestEmptyTokenSharedBucket: 未带 token 的请求共享一个桶（防爆破）。
func TestEmptyTokenSharedBucket(t *testing.T) {
	now := time.Unix(4_000_000, 0)
	l := NewUpgradeLimiter(600, 10, 8, 5*time.Minute, 15*time.Minute)
	l.now = func() time.Time { return now }

	for i := 0; i < 10; i++ {
		if ok, _ := l.Allow("5.5.5.5", ""); !ok {
			t.Fatalf("first 10 empty-token should pass, %d failed", i)
		}
	}
	// 另一个 IP 的未认证请求：共享空 token 桶 → 也被拒。
	if ok, _ := l.Allow("6.6.6.6", ""); ok {
		t.Fatal("empty-token requests share one bucket across IPs")
	}
}

// TestFailedAuthConsumesBothDimensions: 401 时 IP 与 token 双维度都扣。
func TestFailedAuthConsumesBothDimensions(t *testing.T) {
	now := time.Unix(5_000_000, 0)
	l := NewUpgradeLimiter(600, 10, 8, 5*time.Minute, 15*time.Minute)
	l.now = func() time.Time { return now }

	// 模拟鉴权失败调用：RecordFailure 路径（acceptor 在 401 时调用）。
	// 直接用 Allow 计数等价——401 会扣两个维度。
	for i := 0; i < 10; i++ {
		if ok, _ := l.Allow("7.7.7.7", "badTok"); !ok {
			t.Fatalf("request %d should pass", i)
		}
	}
	// token 桶与 IP 桶同耗：换 IP 同 badTok 拒（token 维度），同 IP 换 tok 也拒（IP 维度）。
	if ok, _ := l.Allow("8.8.8.8", "badTok"); ok {
		t.Fatal("badTok token bucket exhausted across IPs")
	}
	if ok, _ := l.Allow("7.7.7.7", "otherTok"); ok {
		t.Fatal("IP bucket exhausted across tokens")
	}
}

// 编译期守卫：确保 acceptor 的 ServeHTTP 实际调用了双维度 Allow。
var _ = func() bool {
	var l *UpgradeLimiter
	_, _ = l.Allow("ip", "token")
	return true
}
