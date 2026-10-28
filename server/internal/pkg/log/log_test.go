package log

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// capture 重定向输出并收集写入的行。
func capture(t *testing.T, fn func()) map[string]any {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := out
	SetOutput(w)
	defer func() { out = old }()
	done := make(chan string)
	go func() {
		buf := make([]byte, 1<<16)
		n, _ := r.Read(buf)
		done <- string(buf[:n])
	}()
	fn()
	w.Close()
	raw := <-done
	var rec map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &rec); err != nil {
		t.Fatalf("output not JSON lines: %v\nraw: %s", err, raw)
	}
	return rec
}

func TestRedactPhone(t *testing.T) {
	got := RedactPhone("13812341234").Redacted()
	if got != "138****1234" {
		t.Errorf("phone = %q, want 138****1234", got)
	}
	if RedactPhone("123").Redacted() != "****" {
		t.Errorf("short phone should be fully masked")
	}
}

func TestRedactToken(t *testing.T) {
	got := RedactToken("abcdefghijklmnop").Redacted()
	if got != "abcdefgh…" {
		t.Errorf("token = %q, want abcdefgh…", got)
	}
	if RedactToken("short").Redacted() != "****" {
		t.Errorf("short token should be fully masked")
	}
}

func TestLoggerRedactedOutput(t *testing.T) {
	rec := capture(t, func() {
		For("test").Info("user auth",
			"phone", RedactPhone("13812341234"),
			"token", RedactToken("0123456789abcdef"))
	})
	if rec["component"] != "test" || rec["msg"] != "user auth" {
		t.Errorf("bad record: %v", rec)
	}
	f, ok := rec["fields"].(map[string]any)
	if !ok {
		t.Fatalf("fields missing: %v", rec)
	}
	if f["phone"] != "138****1234" {
		t.Errorf("phone field = %v, want 138****1234", f["phone"])
	}
	if f["token"] != "01234567…" {
		t.Errorf("token field = %v, want 01234567…", f["token"])
	}
}

func TestLevelFiltering(t *testing.T) {
	SetLevel(WarnLevel)
	defer SetLevel(InfoLevel)
	rec := capture(t, func() {
		For("t").Info("should be dropped")
		For("t").Error("kept")
	})
	if rec["msg"] != "kept" {
		t.Errorf("expected only error record, got %v", rec)
	}
}
