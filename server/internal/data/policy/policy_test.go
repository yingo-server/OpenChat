package policy

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func writePolicy(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

const goodPolicy = `{
  "hot_retention_days": 30,
  "archive": {"cron": "0 4 * * *", "batch_size": 500, "batch_pause_ms": 50, "active_exempt": true},
  "backup": {"cron": "0 3 * * *", "dir": "/var/backups", "keep_days": 7},
  "trim": [{"table": "sys_rate_limit", "retention_days": 7}],
  "rate_limit": {"msg_per_user_per_min": 60, "login_per_ip_per_min": 10}
}`

func TestLoadGood(t *testing.T) {
	p, err := Load([]byte(goodPolicy))
	if err != nil {
		t.Fatal(err)
	}
	if p.HotRetentionDays != 30 || p.Archive.BatchSize != 500 || !p.Archive.ActiveExempt {
		t.Fatalf("unexpected parse: %+v", p)
	}
	if p.Backup.Dir != "/var/backups" || len(p.Trim) != 1 || p.Trim[0].Table != "sys_rate_limit" {
		t.Fatalf("unexpected parse: %+v", p)
	}
}

func TestValidate(t *testing.T) {
	if errs := Validate(Default()); len(errs) != 0 {
		t.Fatalf("Default() must validate, got %v", errs)
	}
	bad := Default()
	bad.HotRetentionDays = 0
	bad.Archive.BatchSize = 100001
	bad.Archive.Cron = ""
	bad.Backup.KeepDays = 0
	bad.Trim = append(bad.Trim, TrimRule{Table: "msg_messages_hot", RetentionDays: 1})
	bad.RateLimit.MsgPerUserPerMin = 0
	errs := Validate(bad)
	if len(errs) < 6 {
		t.Fatalf("expected >=6 field errors, got %d: %v", len(errs), errs)
	}
	msg := errors.Join(errs...).Error()
	for _, want := range []string{"hot_retention_days", "archive.batch_size", "archive.cron", "backup.keep_days", "whitelist", "msg_per_user_per_min"} {
		if !contains(msg, want) {
			t.Errorf("missing field error mentioning %q in:\n%s", want, msg)
		}
	}
	// ttl/retention exclusivity
	errs = Validate(Policy{HotRetentionDays: 1,
		Archive: ArchiveConfig{Cron: "x", BatchSize: 1},
		Backup:  BackupConfig{Cron: "x", Dir: "d", KeepDays: 1},
		RateLimit: RateLimitConfig{MsgPerUserPerMin: 1, LoginPerIPPerMin: 1},
		Trim: []TrimRule{{Table: "sys_rate_limit", TTLHours: 5, RetentionDays: 5}}})
	if len(errs) != 1 {
		t.Fatalf("expected exactly 1 trim error, got %v", errs)
	}
	errs = Validate(Policy{HotRetentionDays: 1,
		Archive: ArchiveConfig{Cron: "x", BatchSize: 1},
		Backup:  BackupConfig{Cron: "x", Dir: "d", KeepDays: 1},
		RateLimit: RateLimitConfig{MsgPerUserPerMin: 1, LoginPerIPPerMin: 1},
		Trim: []TrimRule{{Table: "sys_rate_limit"}}})
	if len(errs) != 1 {
		t.Fatalf("expected exactly 1 trim error (missing ttl/retention), got %v", errs)
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func TestStoreKeepOldOnBadReload(t *testing.T) {
	path := writePolicy(t, goodPolicy)
	s, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	before := s.Current()
	if before.Version != 1 {
		t.Fatalf("initial version = %d, want 1", before.Version)
	}

	// 1. bad JSON
	if err := os.WriteFile(path, []byte(`{ not json`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reload(); err == nil {
		t.Fatal("bad JSON reload must fail")
	}
	if cur := s.Current(); cur.Version != 1 || cur.Policy != before.Policy {
		t.Fatal("snapshot must be unchanged after failed reload")
	}

	// 2. invalid policy (retention 0, bad trim table)
	bad := map[string]any{"hot_retention_days": 0, "trim": []map[string]any{{"table": "evil", "retention_days": 1}}}
	body, _ := json.Marshal(bad)
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reload(); err == nil {
		t.Fatal("invalid policy reload must fail")
	}
	if cur := s.Current(); cur.Version != 1 || cur.Policy != before.Policy {
		t.Fatal("snapshot must be unchanged after invalid reload")
	}

	// 3. good reload bumps version and reports the changed key
	newBody := goodPolicy[:14] + `"hot_retention_days": 45,` + goodPolicy[14:]
	_ = newBody
	changed := `{"hot_retention_days": 45}`
	if err := os.WriteFile(path, []byte(changed), 0o644); err != nil {
		t.Fatal(err)
	}
	changedKeys, err := s.Reload()
	if err != nil {
		t.Fatal(err)
	}
	cur := s.Current()
	if cur.Version != 2 {
		t.Fatalf("version = %d, want 2", cur.Version)
	}
	if cur.Policy.HotRetentionDays != 45 {
		t.Fatalf("hot_retention_days = %d, want 45 (partial doc must merge into defaults)", cur.Policy.HotRetentionDays)
	}
	if len(changedKeys) != 1 || changedKeys[0] != "hot_retention_days" {
		t.Fatalf("changed keys = %v, want [hot_retention_days]", changedKeys)
	}

	// 4. New() on a bad file fails outright
	badPath := writePolicy(t, `}`)
	if _, err := New(badPath); err == nil {
		t.Fatal("New on invalid file must fail")
	}
}
