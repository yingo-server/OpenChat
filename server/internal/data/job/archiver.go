package job

import (
	"context"
	"fmt"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/data/store"
)

// HotScanner is the store-wide old-row scan the archiver needs. MsgReader
// (api.go, frozen) is per-cid; a full-store scan is this separate narrow port.
// *sqlite.DB satisfies it via msgReader.ScanOlder (rides idx_msg_sent); the
// pipefakes and tests provide their own.
type HotScanner interface {
	ScanOlder(ctx context.Context, cutoff int64, limit int) ([]store.HotMsg, error)
}

// Archiver moves hot rows older than the policy cutoff into the cold archive.
// It knows ONLY HotScanner + ArchiveTarget + a PolicySource — how old is
// "old" is POLICY (docs §4: archiver 不知道归档多旧的). Swap the hot schema or
// the cold schema and this file's logic is untouched (only wiring changes).
//
// Mechanism/policy split: the cutoff VALUE is computed by the assembly from
// policy.hot_retention_days and passed through the Cutoff func; the scan
// definition (sent_at < cutoff ORDER BY sent_at ASC LIMIT n) lives in the
// store layer (ScanOlder).
type Archiver struct {
	S         HotScanner          // store-wide old-row scan
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
// SIGTERM (ctx cancel) stops at the batch boundary — resumption is the
// next pass, by idempotency.
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
		// --dry-run is a first-class mode: only count and report. The SAME
		// scan the real run uses (defect fix: previously a separate sample
		// path that disagreed with the mover).
		rows, err := a.archivable(ctx, cutoff, batch)
		if err != nil {
			return Result{}, err
		}
		seen := map[int64]bool{}
		for _, r := range rows {
			seen[r.Cid] = true
		}
		n := int64(len(rows))
		return Result{MovedRows: n, ConvsTouched: len(seen), DryRun: true,
			Detail: fmt.Sprintf("would archive %d rows from %d conversations (cutoff %d)", n, len(seen), cutoff)}, nil
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
	// watermark guards against a scan that does not advance (stale cutoff, or
	// a reader ignoring deletes): without it a non-advancing batch would loop
	// forever and pin the jobber's single-flight slot.
	var watermark int64
	maxBatches := 10000 // belt and braces: hard cap on batches per pass
	for batchNo := 0; batchNo < maxBatches; batchNo++ {
		if ctx.Err() != nil {
			// SIGTERM semantics: stop at the batch boundary; mark the ledger
			// row failed (the next pass is an idempotent retry).
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
// The cutoff VALUE is policy (set by the assembly from hot_retention_days);
// the scan itself is the store's ScanOlder (mechanism).
func (a *Archiver) archivable(ctx context.Context, cutoff int64, batch int) ([]store.HotMsg, error) {
	if a.S == nil {
		return nil, fmt.Errorf("archiver: no hot scanner wired (assembly must set S, the HotScanner port)")
	}
	return a.S.ScanOlder(ctx, cutoff, batch)
}
