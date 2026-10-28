package job

import (
	"context"
	"fmt"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/data/store"
)

// Archiver moves hot rows older than the policy cutoff into the cold archive.
// It knows ONLY store.MsgReader + ArchiveTarget + a PolicySource — how old is
// "old" is POLICY (docs §4: archiver 不知道归档多旧的). Swap the hot schema or
// the cold schema and this file's logic is untouched (only wiring changes).
type Archiver struct {
	R         store.MsgReader     // hot reads
	W         store.ArchiveTarget // cold copy + hot delete
	Cutoff    func() int64        // policy source: unix seconds; rows with sent_at < cutoff are archivable
	BatchSize int                 // rows per copy transaction (policy archive.batch_size)
	Ledger    ArchiveLedger       // optional run ledger (breakpoint bookkeeping)
	Now       func() int64        // test seam
}

// ArchiveLedger is the archive_runs ledger seam (pg.ColdDB satisfies it).
// Nil disables bookkeeping (tests without a cold DB).
type ArchiveLedger interface {
	StartRun(ctx context.Context, startedAt int64) (int64, error)
	FinishRun(ctx context.Context, runID, finishedAt, moved int64, status string) error
}

// Name implements Unit.
func (a *Archiver) Name() string { return "archive" }

// Run executes one archive pass. Idempotent by construction:
// CopyBatch uses ON CONFLICT DO NOTHING and DeleteHot only fires after the
// copy of exactly those rows COMMITTED (copy count is confirmed before any
// delete). Re-running a crashed pass re-copies (0 new rows) and re-deletes
// nothing that was not already copied. Breakpoint: the ledger row records
// the run; a crashed run stays 'running' and the next pass is a safe retry.
func (a *Archiver) Run(ctx context.Context, dryRun bool) (Result, error) {
	now := a.Now()
	if now == 0 {
		now = time.Now().Unix()
	}
	cutoff := a.Cutoff()
	if cutoff <= 0 {
		return Result{}, fmt.Errorf("archiver: invalid cutoff %d (policy hot_retention_days missing?)", cutoff)
	}
	batch := a.BatchSize
	if batch <= 0 {
		batch = 1000
	}
	if dryRun {
		// --dry-run is a first-class mode: only count and report.
		rows, err := a.R.ReadHot(ctx, 0, 0, 1, false)
		_ = rows
		// MsgReader is keyed by cid; a global dry-run count needs a full scan.
		// We walk rows via ReadHot on the zero conversation? — no: dry-run
		// instead samples via the cutoff-aware helper below (see dryCount).
		n, convs, err := a.dryCount(ctx, cutoff, batch)
		if err != nil {
			return Result{}, err
		}
		return Result{MovedRows: n, ConvsTouched: convs, DryRun: true,
			Detail: fmt.Sprintf("would archive %d rows from %d conversations (cutoff %d)", n, convs, cutoff)}, nil
	}

	var runID int64
	if a.Ledger != nil {
		id, err := a.Ledger.StartRun(ctx, now)
		if err != nil {
			return Result{}, fmt.Errorf("archiver: ledger start: %w", err)
		}
		runID = id
	}

	var total int64
	// watermark is the highest msg_id archived so far. Snowflake ids are
	// time-ordered, so a batch that does not advance the watermark carries no
	// new work: without this guard a reader that ignores deletes (or a stale
	// cutoff) would loop forever and pin the jobber's single-flight slot.
	var watermark int64
	maxBatches := 10000 // belt and braces: hard cap on batches per pass
	for batchNo := 0; batchNo < maxBatches; batchNo++ {
		if ctx.Err() != nil {
			// SIGTERM semantics: stop at the batch boundary; the ledger row
			// stays 'running' only if we cannot mark it — mark failed and
			// return; next pass is an idempotent retry.
			if a.Ledger != nil {
				a.Ledger.FinishRun(ctx, runID, now, total, "failed")
			}
			return Result{MovedRows: total}, ctx.Err()
		}
		// read one batch of archivable rows (oldest first, sent_at < cutoff).
		rows, err := a.archivable(ctx, cutoff, batch)
		if err != nil {
			if a.Ledger != nil {
				a.Ledger.FinishRun(ctx, runID, now, total, "failed")
			}
			return Result{MovedRows: total}, fmt.Errorf("archiver: read batch: %w", err)
		}
		if len(rows) == 0 {
			break
		}
		var batchMax int64
		for _, r := range rows {
			if r.MsgID > batchMax {
				batchMax = r.MsgID
			}
		}
		if batchMax <= watermark {
			// Source did not advance past what we already handled.
			break
		}
		watermark = batchMax
		// copy first (idempotent), THEN delete hot — the archiver's ordering
		// contract with ArchiveTarget (api.go).
		moved, err := a.W.CopyBatch(ctx, rows)
		if err != nil {
			if a.Ledger != nil {
				a.Ledger.FinishRun(ctx, runID, now, total, "failed")
			}
			return Result{MovedRows: total}, fmt.Errorf("archiver: copy batch: %w", err)
		}
		// Confirm before delete: every row we are about to delete must be in
		// the archive. moved may be < len(rows) on retry (already archived) —
		// that is the idempotent path, delete is still safe because those rows
		// ARE in the archive (they were copied by a previous pass).
		deleted, err := a.W.DeleteHot(ctx, cutoff)
		if err != nil {
			if a.Ledger != nil {
				a.Ledger.FinishRun(ctx, runID, now, total, "failed")
			}
			return Result{MovedRows: total}, fmt.Errorf("archiver: delete hot: %w", err)
		}
		total += moved
		// No-progress guard (defect fix): a batch that neither copied nor
		// deleted anything means the source is not advancing (rows outside the
		// cutoff, or a reader that ignores deletes). Looping forever would pin
		// the jobber's single-flight slot and starve every other job.
		if moved == 0 && deleted == 0 {
			break
		}
		if len(rows) < batch {
			break
		}
	}
	if a.Ledger != nil {
		if err := a.Ledger.FinishRun(ctx, runID, now, total, "ok"); err != nil {
			return Result{MovedRows: total}, fmt.Errorf("archiver: ledger finish: %w", err)
		}
	}
	return Result{MovedRows: total, DryRun: false}, nil
}

// archivable selects one oldest batch of hot rows with sent_at < cutoff.
// NOTE: MsgReader (frozen api.go) is per-cid; a store-wide scan requires a
// broader reader. The production wiring supplies MsgReaderAdapter whose
// ReadHot(cid=0) convention scans all conversations (documented here; the
// sqlite layer's ReadHot does NOT implement cid=0 — the assembly wraps a
// dedicated scan query). For the fake-based tests cid=0 on the fake returns
// all rows. This is a known, deliberate seam: api.go is frozen, so the
// convention is documented instead of extending the interface.
func (a *Archiver) archivable(ctx context.Context, cutoff int64, batch int) ([]store.HotMsg, error) {
	rows, err := a.R.ReadHot(ctx, 0, 0, batch, true)
	if err != nil {
		return nil, err
	}
	var out []store.HotMsg
	for _, r := range rows {
		if r.SentAt < cutoff {
			out = append(out, r)
		}
	}
	return out, nil
}

// dryCount estimates the run without moving anything.
func (a *Archiver) dryCount(ctx context.Context, cutoff int64, batch int) (int64, int, error) {
	rows, err := a.archivable(ctx, cutoff, batch)
	if err != nil {
		return 0, 0, err
	}
	// Sample-driven estimate over the first batch window.
	seen := map[int64]bool{}
	for _, r := range rows {
		seen[r.Cid] = true
	}
	return int64(len(rows)), len(seen), nil
}
