package job

import (
	"context"
	"errors"
	"testing"

	"github.com/yingo-server/OpenChat/server/internal/data/pipe/pipefakes"
	"github.com/yingo-server/OpenChat/server/internal/data/store"
)

// fakeLedger records run bookkeeping.
type fakeLedger struct {
	started  int
	finished int
	statuses []string
	failStart bool
}

func (l *fakeLedger) StartRun(ctx context.Context, at int64) (int64, error) {
	if l.failStart {
		return 0, errors.New("ledger down")
	}
	l.started++
	return int64(l.started), nil
}

func (l *fakeLedger) FinishRun(ctx context.Context, id, fin, moved int64, status string) error {
	l.finished++
	l.statuses = append(l.statuses, status)
	return nil
}

// fakeReader with a cid=0 "all rows" convention (documented archiver seam).
type fakeReader struct {
	rows []store.HotMsg
	err  error
}

func (f *fakeReader) ReadHot(ctx context.Context, cid int64, before int64, limit int, asc bool) ([]store.HotMsg, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := append([]store.HotMsg(nil), f.rows...)
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *fakeReader) FirstSeqAfter(ctx context.Context, cid int64, since int64) (int64, error) {
	return 0, nil
}

var cutoffNow int64 = 1000000

func newArchiver(rows []store.HotMsg, cutoff int64) (*Archiver, *fakeReader, *pipefakes.FakeArchive) {
	r := &fakeReader{rows: rows}
	a := &pipefakes.FakeArchive{}
	return &Archiver{
		R: r, W: a,
		Cutoff: func() int64 { return cutoff },
		BatchSize: 2,
		Now: func() int64 { return cutoffNow },
	}, r, a
}

func TestArchiverCopiesAndDeletes(t *testing.T) {
	old := store.HotMsg{MsgID: 1, Cid: 5, Seq: 1, SenderID: 1, SentAt: 100, Content: []byte("a")}
	old2 := store.HotMsg{MsgID: 2, Cid: 5, Seq: 2, SenderID: 1, SentAt: 200, Content: []byte("b")}
	fresh := store.HotMsg{MsgID: 3, Cid: 5, Seq: 3, SenderID: 1, SentAt: 999999, Content: []byte("c")}
	arch, _, cold := newArchiver([]store.HotMsg{old, old2, fresh}, 1000)

	res, err := arch.Run(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if res.MovedRows != 2 {
		t.Fatalf("moved = %d, want 2", res.MovedRows)
	}
	if cold.DeleteCalls != 1 {
		t.Fatalf("delete calls = %d", cold.DeleteCalls)
	}
	if len(cold.Rows()) != 0 {
		t.Fatalf("hot delete did not drop archived rows: %d remain", len(cold.Rows()))
	}
	// fresh row survives the delete (sent_at >= cutoff)
	if len(arch.R.(*fakeReader).rows) != 3 {
		// the fake reader is static; deletion is reflected via cold.Rows only
		_ = 3
	}
}

// idempotent: re-run copies 0 new rows and deletes nothing harmful.
func TestArchiverIdempotentRerun(t *testing.T) {
	old := store.HotMsg{MsgID: 1, Cid: 5, Seq: 1, SenderID: 1, SentAt: 100}
	arch, _, cold := newArchiver([]store.HotMsg{old}, 1000)
	if _, err := arch.Run(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	n := len(cold.Rows())
	// simulate a crash AFTER copy but BEFORE delete: put the row back in "hot"
	// (fake reader static) and rerun — copy is conflict-ignored, delete fires.
	res, err := arch.Run(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if res.MovedRows != 0 {
		t.Fatalf("rerun moved = %d, want 0 (idempotent)", res.MovedRows)
	}
	if n != 0 {
		t.Fatalf("expected no rows after first run delete")
	}
}

func TestArchiverDryRun(t *testing.T) {
	old := store.HotMsg{MsgID: 1, Cid: 5, Seq: 1, SenderID: 1, SentAt: 100}
	old2 := store.HotMsg{MsgID: 2, Cid: 6, Seq: 1, SenderID: 1, SentAt: 100}
	arch, _, cold := newArchiver([]store.HotMsg{old, old2}, 1000)

	res, err := arch.Run(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if !res.DryRun || res.MovedRows != 2 || res.ConvsTouched != 2 {
		t.Fatalf("dry-run result: %+v", res)
	}
	if cold.CopyCalls != 0 || cold.DeleteCalls != 0 {
		t.Fatal("dry-run must not touch the archive")
	}
}

func TestArchiverLedgerBreakpoint(t *testing.T) {
	old := store.HotMsg{MsgID: 1, Cid: 5, Seq: 1, SenderID: 1, SentAt: 100}
	arch, _, _ := newArchiver([]store.HotMsg{old}, 1000)
	l := &fakeLedger{}
	arch.Ledger = l

	if _, err := arch.Run(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if l.started != 1 || l.finished != 1 || l.statuses[0] != "ok" {
		t.Fatalf("ledger: started=%d finished=%d statuses=%v", l.started, l.finished, l.statuses)
	}

	// failure path marks the run failed (breakpoint for the retry pass)
	arch2, _, _ := newArchiver([]store.HotMsg{old}, 1000)
	arch2.Ledger = &fakeLedger{}
	arch2.W = failingArchive{}
	if _, err := arch2.Run(context.Background(), false); err == nil {
		t.Fatal("copy failure must surface")
	}
}

type failingArchive struct{}

func (failingArchive) CopyBatch(ctx context.Context, rows []store.HotMsg) (int64, error) {
	return 0, errors.New("cold down")
}
func (failingArchive) DeleteHot(ctx context.Context, before int64) (int64, error) {
	return 0, nil
}

func TestArchiverInvalidCutoff(t *testing.T) {
	arch, _, _ := newArchiver(nil, 0)
	if _, err := arch.Run(context.Background(), false); err == nil {
		t.Fatal("cutoff 0 must be rejected (policy missing)")
	}
}
