package ws

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func validAuthn(string) (*Identity, error) { return &Identity{UserID: 42, DeviceID: "dev"}, nil }
func failAuthn(string) (*Identity, error)  { return nil, errors.New("bad token") }

// TestUpgradeRateLimitHTTP: 同一 IP 连打 11 次，burst=10 → 第 11 次 429；
// 推进时钟一个 token 的补充窗口后恢复。
func TestUpgradeRateLimitHTTP(t *testing.T) {
	acc := NewAcceptor(Config{
		CookieName:              "access_token",
		UpgradeRatePerMin:       10,
		UpgradeBurst:            10,
		UpgradeFailureThreshold: 1000, // disable ban: isolate the token bucket
	}, validAuthn, nil)

	ip := "203.0.113.9"
	do := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/ws", nil)
		req.RemoteAddr = ip + ":12345"
		req.AddCookie(&http.Cookie{Name: "access_token", Value: "tok"})
		rec := httptest.NewRecorder()
		acc.ServeHTTP(rec, req)
		return rec
	}

	for i := 1; i <= 10; i++ {
		if rec := do(); rec.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d rate-limited too early (code=%d)", i, rec.Code)
		}
	}
	rec := do()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("11th request code = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("429 response missing Retry-After header")
	}

	// advance the clock past one refill: a token (10/min → 6s/token) is back.
	acc.limiter.now = func() time.Time { return time.Now().Add(7 * time.Second) }
	if rec := do(); rec.Code == http.StatusTooManyRequests {
		t.Fatalf("after refill window still 429 (code=%d)", rec.Code)
	}
}

// TestUpgradeFailureConsumesQuota: 鉴权失败额外扣一次 token（失败也消耗配额）。
// 同 burst 下：成功路径放行 N 次，失败路径只放行 ceil(N/2) 次。
func TestUpgradeFailureConsumesQuota(t *testing.T) {
	newAcc := func(authn Authn) *Acceptor {
		return NewAcceptor(Config{
			CookieName:              "access_token",
			UpgradeRatePerMin:       0.0001, // effectively no refill
			UpgradeBurst:            2,
			UpgradeFailureThreshold: 1000, // no ban: isolate the token accounting
		}, authn, nil)
	}
	call := func(acc *Acceptor, ip string) int {
		req := httptest.NewRequest(http.MethodGet, "/ws", nil)
		req.RemoteAddr = ip + ":1111"
		req.AddCookie(&http.Cookie{Name: "access_token", Value: "x"})
		rec := httptest.NewRecorder()
		acc.ServeHTTP(rec, req)
		return rec.Code
	}

	const ip = "198.51.100.1"

	// failure path: burst 2, first failed attempt costs 2 tokens → 2nd call 429.
	failAcc := newAcc(failAuthn)
	if c := call(failAcc, ip); c != http.StatusUnauthorized {
		t.Fatalf("first failed-auth code = %d, want 401", c)
	}
	if c := call(failAcc, ip); c != http.StatusTooManyRequests {
		t.Fatalf("second failed-auth code = %d, want 429 (a failure costs an extra token)", c)
	}

	// success path: burst 2 → two attempts pass, third is limited.
	okAcc := newAcc(validAuthn)
	if c := call(okAcc, ip); c == http.StatusTooManyRequests {
		t.Fatalf("success call 1 unexpectedly limited (code=%d)", c)
	}
	if c := call(okAcc, ip); c == http.StatusTooManyRequests {
		t.Fatalf("success call 2 unexpectedly limited (code=%d)", c)
	}
	if c := call(okAcc, ip); c != http.StatusTooManyRequests {
		t.Fatalf("success call 3 code = %d, want 429", c)
	}
}

// TestUpgradeFailureBan: 窗口内失败达阈值 → 封禁；封禁到期后恢复。
func TestUpgradeFailureBan(t *testing.T) {
	acc := NewAcceptor(Config{
		CookieName:              "access_token",
		UpgradeRatePerMin:       1000,
		UpgradeBurst:            1000,
		UpgradeFailureThreshold: 3,
		UpgradeFailureWindow:    time.Minute,
		UpgradeBanFor:           time.Minute,
	}, failAuthn, nil)

	const ip = "198.51.100.7"
	call := func() int {
		req := httptest.NewRequest(http.MethodGet, "/ws", nil)
		req.RemoteAddr = ip + ":2222"
		req.AddCookie(&http.Cookie{Name: "access_token", Value: "x"})
		rec := httptest.NewRecorder()
		acc.ServeHTTP(rec, req)
		return rec.Code
	}

	for i := 0; i < 3; i++ {
		if c := call(); c != http.StatusUnauthorized {
			t.Fatalf("failure %d code = %d, want 401", i+1, c)
		}
	}
	// circuit is now open: even with tokens available, the IP is banned.
	if c := call(); c != http.StatusTooManyRequests {
		t.Fatalf("banned IP code = %d, want 429", c)
	}

	// ban expires after BanFor → traffic resumes.
	acc.limiter.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if c := call(); c == http.StatusTooManyRequests {
		t.Fatalf("after ban expiry still 429 (code=%d)", c)
	}
}
