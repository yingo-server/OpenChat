package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoginLockoutEscalation(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := NewLoginLimiter(DefaultLockPolicy())
	l.SetClock(func() time.Time { return now })

	// First 5 failures -> 15m lock.
	for i := 0; i < 5; i++ {
		st := l.Failure("alice", "fp-a")
		if i < 4 && st.Locked {
			t.Fatalf("locked too early at failure %d", i+1)
		}
	}
	st := l.Check("alice", "fp-a")
	if !st.Locked {
		t.Fatal("not locked after 5 failures")
	}
	if d := st.RetryAfter; d < 14*time.Minute || d > 15*time.Minute {
		t.Fatalf("first lock duration = %v, want 15m", d)
	}

	// After expiry, 5 more -> 1h.
	now = now.Add(15*time.Minute + time.Second)
	if st := l.Check("alice", "fp-a"); st.Locked {
		t.Fatal("still locked after 15m")
	}
	for i := 0; i < 5; i++ {
		l.Failure("alice", "fp-a")
	}
	st = l.Check("alice", "fp-a")
	if !st.Locked || st.RetryAfter < 59*time.Minute || st.RetryAfter > time.Hour {
		t.Fatalf("second lock = %v locked=%v, want 1h", st.RetryAfter, st.Locked)
	}

	// After expiry, 5 more -> 24h.
	now = now.Add(time.Hour + time.Second)
	if st := l.Check("alice", "fp-a"); st.Locked {
		t.Fatal("still locked after 1h")
	}
	for i := 0; i < 5; i++ {
		l.Failure("alice", "fp-a")
	}
	st = l.Check("alice", "fp-a")
	if !st.Locked || st.RetryAfter < 23*time.Hour || st.RetryAfter > 24*time.Hour {
		t.Fatalf("third lock = %v locked=%v, want 24h", st.RetryAfter, st.Locked)
	}

	// Stage is capped at the last duration.
	now = now.Add(24*time.Hour + time.Second)
	for i := 0; i < 5; i++ {
		l.Failure("alice", "fp-a")
	}
	st = l.Check("alice", "fp-a")
	if !st.Locked || st.RetryAfter > 24*time.Hour {
		t.Fatalf("cap lock = %v, want <=24h", st.RetryAfter)
	}
}

func TestLoginLockoutDualDimension(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := NewLoginLimiter(DefaultLockPolicy())
	l.SetClock(func() time.Time { return now })

	// Account A from fingerprint X causes the fingerprint to lock too.
	for i := 0; i < 5; i++ {
		l.Failure("alice", "fp-shared")
	}
	if st := l.Check("bob", "fp-shared"); !st.Locked {
		t.Fatal("shared fingerprint did not lock a different account")
	}
	if st := l.Check("alice", "fp-other"); !st.Locked {
		t.Fatal("locked account not rejected from another fingerprint")
	}
	// Unrelated account+fingerprint unaffected.
	if st := l.Check("carol", "fp-other"); st.Locked {
		t.Fatal("unrelated principal locked")
	}
	// Success clears both dimensions (documented behavior).
	l.Success("alice", "fp-shared")
	if st := l.Check("alice", "fp-shared"); st.Locked {
		t.Fatal("success did not clear lock state")
	}
}

func TestOpLimiterBudgets(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := NewOpLimiter(OpLimiterConfig{PerMinute: 60, HighRiskPerMinute: 10, Window: time.Minute})
	l.SetClock(func() time.Time { return now })

	for i := 0; i < 60; i++ {
		if ok, _ := l.Allow(1, false); !ok {
			t.Fatalf("normal op %d rejected", i+1)
		}
	}
	if ok, retry := l.Allow(1, false); ok || retry <= 0 {
		t.Fatalf("61st normal op allowed or retry=%v", retry)
	}
	for i := 0; i < 10; i++ {
		if ok, _ := l.Allow(1, true); !ok {
			t.Fatalf("high-risk op %d rejected", i+1)
		}
	}
	if ok, _ := l.Allow(1, true); ok {
		t.Fatal("11th high-risk op allowed")
	}
	// Separate admin has its own budget.
	if ok, _ := l.Allow(2, true); !ok {
		t.Fatal("admin 2 high-risk op rejected")
	}
	// New window resets.
	now = now.Add(time.Minute)
	if ok, _ := l.Allow(1, true); !ok {
		t.Fatal("new window did not reset")
	}
}

func TestFingerprintStableAndUASensitive(t *testing.T) {
	mk := func(ua string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/login", nil)
		r.RemoteAddr = "203.0.113.5:49152"
		r.Header.Set("User-Agent", ua)
		return r
	}
	f1 := Fingerprint(mk("Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0"), false)
	f2 := Fingerprint(mk("Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0"), false)
	f3 := Fingerprint(mk("curl/8.5.0"), false)
	if f1 != f2 {
		t.Fatal("fingerprint not stable for identical inputs")
	}
	if f1 == f3 {
		t.Fatal("fingerprint ignores User-Agent")
	}

	r := mk("ua")
	r.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.1")
	if Fingerprint(r, false) == Fingerprint(r, true) {
		t.Fatal("trustProxy did not change the fingerprint source")
	}
	if ClientIP(r, true) != "198.51.100.9" {
		t.Fatalf("ClientIP trustProxy = %q", ClientIP(r, true))
	}
	if ClientIP(r, false) != "203.0.113.5" {
		t.Fatalf("ClientIP !trustProxy = %q", ClientIP(r, false))
	}
}
