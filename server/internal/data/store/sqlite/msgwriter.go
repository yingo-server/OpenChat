package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/yingo-server/OpenChat/server/internal/data/store"
)

// msgWriter implements store.MsgWriter (hot write path: flusher + seqalloc).

type msgWriter struct{ db *sql.DB }

const insertMsgSQL = `INSERT INTO msg_messages_hot
(msg_id, cid, seq, sender_id, client_msg_id, content, sent_at, edited, recalled)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

// AppendMessages inserts a batch in ONE transaction: all rows or none.
// A duplicate (cid, sender_id, client_msg_id) or (cid, seq) unique violation
// aborts the whole batch and is surfaced as store.ErrDuplicate (wrapped), so
// the flusher can reply code=409-equivalent / dedupguard can translate it into
// the old ack. NO membership checks here (api.go red line).
func (w *msgWriter) AppendMessages(ctx context.Context, batch []store.PendingMsg) error {
	if len(batch) == 0 {
		return nil
	}
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("sqlite: append begin: %w", err)
	}
	defer tx.Rollback() // no-op after commit

	err = BatchExec(ctx, tx, insertMsgSQL, batch, func(stmt *sql.Stmt, m store.PendingMsg) error {
		if _, err := stmt.ExecContext(ctx, m.MsgID, m.Cid, m.Seq, m.SenderID, m.ClientMsgID, m.Content, m.SentAt, 0, 0); err != nil {
			if isDup(err) {
				return fmt.Errorf("sqlite: duplicate msg (cid=%d sender=%d client_msg_id=%q): %w",
					m.Cid, m.SenderID, m.ClientMsgID, store.ErrDuplicate)
			}
			return fmt.Errorf("sqlite: insert msg cid=%d seq=%d: %w", m.Cid, m.Seq, err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("sqlite: append commit: %w", err)
	}
	return nil
}

// AllocateSeq atomically reserves the next n sequence numbers for cid and
// returns the inclusive start: the caller owns [start, start+n-1].
//
// Preferred form (SQLite >= 3.35):
//
//	UPDATE conv_seq SET next_seq = next_seq + ? WHERE cid = ? RETURNING next_seq - ?
//
// RETURNING makes it a single atomic statement, safe under concurrent writers.
// If the bundled system sqlite3 is older than 3.35 the RETURNING statement
// fails at runtime — we then fall back to the equivalent BEGIN IMMEDIATE
// transaction (SELECT inside a write-locked tx, then UPDATE), which is atomic
// because SQLite write transactions are serialized. Either path guarantees
// no two concurrent AllocateSeq calls ever hand out overlapping ranges.
func (w *msgWriter) AllocateSeq(ctx context.Context, cid int64, n int) (int64, error) {
	if n <= 0 {
		return 0, fmt.Errorf("sqlite: AllocateSeq: n must be >= 1 (cid=%d n=%d)", cid, n)
	}
	// Fast path: single atomic statement.
	var next int64
	err := w.db.QueryRowContext(ctx,
		`UPDATE conv_seq SET next_seq = next_seq + ? WHERE cid = ? RETURNING next_seq - ?`,
		n, cid, n).Scan(&next)
	if err == nil {
		return next, nil
	}
	if !errors.Is(err, sql.ErrNoRows) && !isReturningUnsupported(err) {
		return 0, fmt.Errorf("sqlite: allocate seq cid=%d: %w", cid, err)
	}
	// Missing row: create the allocator row, then retry.
	if errors.Is(err, sql.ErrNoRows) {
		if _, ierr := w.db.ExecContext(ctx,
			`INSERT OR IGNORE INTO conv_seq (cid, next_seq) VALUES (?, 1)`, cid); ierr != nil {
			return 0, fmt.Errorf("sqlite: init conv_seq cid=%d: %w", cid, ierr)
		}
	}
	return w.allocateSeqTx(ctx, cid, n)
}

// allocateSeqTx is the pre-3.35 fallback: BEGIN IMMEDIATE serializes writers,
// so read-then-update inside the transaction is atomic.
func (w *msgWriter) allocateSeqTx(ctx context.Context, cid int64, n int) (int64, error) {
	tx, err := w.db.BeginTx(ctx, &sql.TxOptions{}) // mattn maps this to BEGIN DEFERRED; we lock via UPDATE first below
	if err != nil {
		return 0, fmt.Errorf("sqlite: alloc begin: %w", err)
	}
	defer tx.Rollback()

	// Take the write lock FIRST (UPDATE of the row), then read back — under
	// SQLite's database-level write lock this is equivalent to BEGIN IMMEDIATE.
	res, err := tx.ExecContext(ctx, `UPDATE conv_seq SET next_seq = next_seq + ? WHERE cid = ?`, n, cid)
	if err != nil {
		return 0, fmt.Errorf("sqlite: alloc update: %w", err)
	}
	ra, _ := res.RowsAffected()
	if ra == 0 {
		if _, ierr := tx.ExecContext(ctx, `INSERT INTO conv_seq (cid, next_seq) VALUES (?, ?)`, cid, int64(n)+1); ierr != nil {
			return 0, fmt.Errorf("sqlite: alloc insert: %w", ierr)
		}
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("sqlite: alloc commit: %w", err)
		}
		return 1, nil
	}
	var next int64
	if err := tx.QueryRowContext(ctx, `SELECT next_seq FROM conv_seq WHERE cid = ?`, cid).Scan(&next); err != nil {
		return 0, fmt.Errorf("sqlite: alloc select: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("sqlite: alloc commit: %w", err)
	}
	return next - int64(n), nil
}

// isReturningUnsupported reports whether err smells like "RETURNING not
// implemented" (older sqlite3: "syntax error" near RETURNING).
func isReturningUnsupported(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, `near "RETURNING"`) ||
		(strings.Contains(msg, "RETURNING") && strings.Contains(msg, "syntax error"))
}
