package pg

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// AuditRow is one sys.audit_log row as read back by the cursor stream.
//
// It is a pg-local projection on purpose: the cold store must not import the
// admin plane (layering: data ← admin). The production adapter in
// admin/prod maps AuditRow onto service.AuditRecord.
type AuditRow struct {
	ID      int64
	Actor   string
	Action  string
	Subject string
	Detail  []byte // JSONB, nil when the column was NULL
	At      int64
}

// AuditListSQL is the ONLY read statement over the append-only journal.
//
// Semantics (docs §6 journalctl): keyset cursor only — id > $1 ascending,
// no offset, no random access, no mutation. $1 = since id, $2 = limit.
// Kept as an exported const so tests can assert its shape without a database.
const AuditListSQL = `SELECT id, actor, action, subject, detail, at ` +
	`FROM sys.audit_log WHERE id > $1 ORDER BY id ASC LIMIT $2`

// AuditReader is the read side of the cold audit journal.
//
// Red line: it exposes no write surface — appending lives only on
// ColdDB.Append (store.AuditJournal).
type AuditReader struct {
	db *sql.DB
}

// NewAuditReader wraps the cold handle. A nil cold DB yields a nil reader;
// callers treat nil as "cold store not configured" (degraded, never panic).
func NewAuditReader(c *ColdDB) *AuditReader {
	if c == nil || c.DB == nil {
		return nil
	}
	return &AuditReader{db: c.DB}
}

// ListAudit returns journal rows with id > sinceID in ascending id order,
// at most limit rows. limit is clamped to [1, 1000] (the admin service asks
// for limit+1 to learn has_more; the clamp leaves room for that).
func (r *AuditReader) ListAudit(ctx context.Context, sinceID int64, limit int) ([]AuditRow, error) {
	if r == nil || r.db == nil {
		return nil, ErrNotConfigured
	}
	query, args := auditQuery(sinceID, limit)
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("pg: list audit: %w", err)
	}
	defer rows.Close()

	out := make([]AuditRow, 0, 64)
	for rows.Next() {
		var a AuditRow
		if err := rows.Scan(&a.ID, &a.Actor, &a.Action, &a.Subject, &a.Detail, &a.At); err != nil {
			return nil, fmt.Errorf("pg: list audit scan: %w", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("pg: list audit rows: %w", err)
	}
	return out, nil
}

// auditQuery is the pure (statement, args) pair used by ListAudit. Extracted
// so the parameter ORDER is unit-testable without a database.
func auditQuery(sinceID int64, limit int) (string, []any) {
	if limit <= 0 {
		limit = 500
	}
	if limit > 1000 {
		limit = 1000
	}
	return AuditListSQL, []any{sinceID, limit}
}

// ErrNotConfigured signals "cold store absent" rather than "query failed".
var ErrNotConfigured = errors.New("pg: cold store not configured")

// Ping verifies the cold pool is reachable (doctor/diagnostics only; the
// request path never pings).
func (c *ColdDB) Ping(ctx context.Context) error {
	if c == nil || c.DB == nil {
		return ErrNotConfigured
	}
	return c.DB.PingContext(ctx)
}
