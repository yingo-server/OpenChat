package pg

import (
	"strings"
	"testing"
)

// The cold store is never connected in tests (no postgres driver in go.mod by
// contract): these tests pin the SQL SHAPE and the parameter ORDER instead.
func TestAuditListSQLShape(t *testing.T) {
	for _, want := range []string{
		"SELECT id, actor, action, subject, detail, at",
		"FROM sys.audit_log",
		"WHERE id > $1",
		"ORDER BY id ASC",
		"LIMIT $2",
	} {
		if !strings.Contains(AuditListSQL, want) {
			t.Fatalf("AuditListSQL missing %q:\n%s", want, AuditListSQL)
		}
	}
	// No string-concatenated values: the statement must be pure SQL with
	// exactly two placeholders and no quoted literals other than identifiers.
	if strings.Contains(AuditListSQL, "'") {
		t.Fatalf("AuditListSQL contains a quoted literal:\n%s", AuditListSQL)
	}
	if strings.Contains(AuditListSQL, "OFFSET") {
		t.Fatalf("audit cursor must not use OFFSET (journalctl semantics):\n%s", AuditListSQL)
	}
	if n := strings.Count(AuditListSQL, "$"); n != 2 {
		t.Fatalf("placeholder count = %d, want 2", n)
	}
}

func TestAuditQueryArgsOrder(t *testing.T) {
	q, args := auditQuery(42, 7)
	if q != AuditListSQL {
		t.Fatalf("query mismatch")
	}
	if len(args) != 2 {
		t.Fatalf("args = %d, want 2", len(args))
	}
	since, ok := args[0].(int64)
	if !ok || since != 42 {
		t.Fatalf("args[0] = %v (%T), want int64(42) — $1 is the since id", args[0], args[0])
	}
	limit, ok := args[1].(int)
	if !ok || limit != 7 {
		t.Fatalf("args[1] = %v (%T), want int(7) — $2 is the limit", args[1], args[1])
	}
}

func TestAuditQueryLimitClamp(t *testing.T) {
	cases := []struct{ in, want int }{
		{-5, 500}, {0, 500}, {1, 1}, {500, 500}, {1000, 1000}, {5000, 1000},
	}
	for _, c := range cases {
		_, args := auditQuery(0, c.in)
		if got := args[1].(int); got != c.want {
			t.Fatalf("limit(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestAuditReaderNilIsNotConfigured(t *testing.T) {
	var r *AuditReader
	if _, err := r.ListAudit(nil, 0, 10); err == nil {
		t.Fatal("nil reader must report ErrNotConfigured")
	}
	if NewAuditReader(nil) != nil {
		t.Fatal("NewAuditReader(nil) must be nil")
	}
	if err := (*ColdDB)(nil).Ping(nil); err == nil {
		t.Fatal("Ping on nil cold DB must report ErrNotConfigured")
	}
}
