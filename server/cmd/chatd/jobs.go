package main

// jobs.go: the data layer's job plane wiring (mechanism assembled here,
// policy read from policy.json — docs §4 机制/策略分离).
//
//   - Archiver (job.Unit) reads hot rows older than policy.hot_retention_days
//     via sqlite.ScanOlder and moves them through pg.ColdDB
//     (store.ArchiveTarget) with the archive_runs ledger for breakpoints.
//   - Jobber fires it per policy.archive.cron (job.ParseCronKind) and serves
//     manual triggers: a 980 JOB_TRIGGER frame on the data lane becomes
//     jobber.Trigger (pipe.Trunkee), replied with 981 JOB_STATUS.
//
// Degradation: without a cold DB the archiver is still registered and
// runnable as a DRY RUN (estimate-only), but a real run fails fast with a
// clear error — never silently pretend rows were archived. No cold DB is a
// documented skeleton deployment form (docs/deploy.md 附录 A).

import (
	"context"
	"fmt"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/data/job"
	"github.com/yingo-server/OpenChat/server/internal/data/policy"
	"github.com/yingo-server/OpenChat/server/internal/data/store/pg"
	"github.com/yingo-server/OpenChat/server/internal/data/store/sqlite"
	"github.com/yingo-server/OpenChat/server/internal/pkg/log"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
)

// jobPlane bundles the scheduler and its units.
type jobPlane struct {
	jobber   *job.Jobber
	archiver *job.Archiver
	cancel   context.CancelFunc
}

// archiveCutoff turns policy.hot_retention_days into a unix-seconds cutoff
// (POLICY — the archiver only consumes the number).
func archiveCutoff(pol *policy.Store, now func() time.Time) func() int64 {
	return func() int64 {
		days := 0
		if pol != nil {
			days = pol.Current().Policy.HotRetentionDays
		}
		if days <= 0 {
			days = 90 // matches policy.Default(); a missing policy must not archive everything
		}
		return now().Unix() - int64(days)*24*3600
	}
}

// newJobPlane builds the jobber + archiver. cold may be nil (degraded mode:
// dry-run works, a real run reports the missing archive target).
func newJobPlane(hot *sqlite.DB, cold *pg.ColdDB, pol *policy.Store, lg *log.Logger) *jobPlane {
	now := time.Now
	batch := 1000
	if pol != nil {
		if b := pol.Current().Policy.Archive.BatchSize; b > 0 {
			batch = b
		}
	}
	arch := &job.Archiver{S: hot, // *sqlite.DB implements job.HotScanner via ScanOlder
		W:         cold,
		Cutoff:    archiveCutoff(pol, now),
		BatchSize: batch,
	}
	if cold != nil {
		arch.Ledger = cold // archive_runs ledger (breakpoint bookkeeping)
	}
	jb := job.NewJobber(lg)
	jb.Register(arch, archiveSpec(pol, lg))
	return &jobPlane{jobber: jb, archiver: arch}
}

// archiveSpec parses policy.archive.cron. A malformed cron is a loud WARN +
// the documented default "0 4 * * *" (daily 04:00) — policy problems must be
// visible, but a job must still be schedulable.
func archiveSpec(pol *policy.Store, lg *log.Logger) job.Spec {
	cron := ""
	if pol != nil {
		cron = pol.Current().Policy.Archive.Cron
	}
	kind, h, m, err := job.ParseCronKind(cron)
	if err != nil {
		if lg != nil {
			lg.Warn("archive cron invalid; falling back to daily 04:00", "cron", cron, "err", err.Error())
		}
		return job.Spec{Kind: job.CronDaily, Hour: 4, Min: 0}
	}
	_ = kinds.KindJobTrigger // doc link
	switch kind {
	case job.CronInterval:
		return job.Spec{Kind: job.CronInterval, Interval: time.Duration(h) * time.Second}
	default:
		return job.Spec{Kind: job.CronDaily, Hour: h, Min: m}
	}
}

// start launches the scheduler loop. jobber.Run returns when ctx is canceled
// (SIGTERM): running archives stop at the batch boundary (archiver checks
// ctx.Err per batch) and resume idempotently on the next start.
func (jp *jobPlane) start(ctx context.Context) {
	if jp == nil || jp.jobber == nil {
		return
	}
	jctx, cancel := context.WithCancel(ctx)
	jp.cancel = cancel
	go jp.jobber.Run(jctx)
}

// stop cancels the scheduler (idempotent).
func (jp *jobPlane) stop() {
	if jp != nil && jp.cancel != nil {
		jp.cancel()
	}
}

// triggerJob implements pipe.Trunkee: kind 980 → jobber.Trigger, single-flight
// (concurrent triggers answer job.ErrRunning, which the pipe maps to a busy
// 981 status).
func (jp *jobPlane) TriggerJob(ctx context.Context, name string, dryRun bool) (job.Result, error) {
	return jp.triggerJob(ctx, name, dryRun)
}

func (jp *jobPlane) triggerJob(ctx context.Context, name string, dryRun bool) (job.Result, error) {
	if jp == nil || jp.jobber == nil {
		return job.Result{}, fmt.Errorf("job plane not wired")
	}
	return jp.jobber.Trigger(ctx, name, dryRun)
}
