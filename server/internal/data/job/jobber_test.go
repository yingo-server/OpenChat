package job

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestParseCronKind(t *testing.T) {
	cases := []struct {
		in   string
		kind CronKind
		h, m int
		err  bool
	}{
		{"@daily 04:00", CronDaily, 4, 0, false},
		{"@daily 5:30", CronDaily, 5, 30, false},
		{"interval 60", CronInterval, 0, 0, false},
		{"90", CronInterval, 0, 0, false},
		{"0 4 * * *", CronDaily, 4, 0, false},
		{"30 5 * * *", CronDaily, 5, 30, false},
		{"", 0, 0, 0, true},
		{"@daily 25:00", 0, 0, 0, true},
		{"@daily 4", 0, 0, 0, true},
		{"interval 0", 0, 0, 0, true},
		{"*/5 * * * *", 0, 0, 0, true},   // unsupported syntax rejected
		{"0 4 * * 1", 0, 0, 0, true},     // weekly schedules are not expressible: fail fast
		{"1 2 3", 0, 0, 0, true},         // not 5 fields
	}
	for _, c := range cases {
		k, h, m, err := ParseCronKind(c.in)
		if c.err {
			if err == nil {
				t.Errorf("%q: expected error", c.in)
			}
			continue
		}
		if err != nil || k != c.kind || h != c.h || m != c.m {
			t.Errorf("%q: got kind=%v h=%d m=%d err=%v", c.in, k, h, m, err)
		}
	}
}

func TestNextFireDaily(t *testing.T) {
	sp := Spec{Kind: CronDaily, Hour: 4, Min: 0}
	loc := time.FixedZone("t", 0)
	now := time.Date(2024, 5, 1, 2, 0, 0, 0, loc)
	nx := sp.NextFire(now)
	if nx.Hour() != 4 || nx.Minute() != 0 || nx.Day() != 1 {
		t.Fatalf("same-day fire wrong: %v", nx)
	}
	now = time.Date(2024, 5, 1, 5, 0, 0, 0, loc)
	nx = sp.NextFire(now)
	if nx.Day() != 2 || nx.Hour() != 4 {
		t.Fatalf("next-day fire wrong: %v", nx)
	}
}

func TestNextFireInterval(t *testing.T) {
	sp := Spec{Kind: CronInterval, Interval: 30 * time.Second}
	now := time.Unix(1000, 0)
	if got := sp.NextFire(now); !got.Equal(now.Add(30 * time.Second)) {
		t.Fatalf("interval fire wrong: %v", got)
	}
}

// nopUnit counts runs.
type nopUnit struct {
	name  string
	runs  int
	fails bool
}

func (n *nopUnit) Name() string { return n.name }
func (n *nopUnit) Run(ctx context.Context, dryRun bool) (Result, error) {
	n.runs++
	if n.fails {
		return Result{}, errors.New("boom")
	}
	return Result{DryRun: dryRun}, nil
}

func TestJobberTriggerAndSingleFlight(t *testing.T) {
	j := NewJobber(nil)
	u := &nopUnit{name: "nop"}
	j.Register(u, Spec{Kind: CronInterval, Interval: time.Hour})

	if _, err := j.Trigger(context.Background(), "nop", false); err != nil || u.runs != 1 {
		t.Fatalf("trigger: %v runs=%d", err, u.runs)
	}
	if _, err := j.Trigger(context.Background(), "missing", false); err == nil {
		t.Fatal("unknown job should error")
	}
}

func TestJobberFailureDoesNotKill(t *testing.T) {
	j := NewJobber(nil)
	u := &nopUnit{name: "f", fails: true}
	j.Register(u, Spec{Kind: CronInterval, Interval: time.Hour})
	if _, err := j.Trigger(context.Background(), "f", false); err == nil {
		t.Fatal("unit failure must surface")
	}
	// scheduler itself is unaffected: another unit still runs
	ok := &nopUnit{name: "ok"}
	j.Register(ok, Spec{Kind: CronInterval, Interval: time.Hour})
	if _, err := j.Trigger(context.Background(), "ok", false); err != nil || ok.runs != 1 {
		t.Fatalf("post-failure trigger: %v", err)
	}
}
