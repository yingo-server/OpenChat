package signalset

import (
	"context"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestDefaultMappingSemantics(t *testing.T) {
	m := DefaultMapping()
	if m[syscall.SIGHUP] != Reload {
		t.Error("SIGHUP should map to Reload")
	}
	if m[syscall.SIGTERM] != Quit || m[syscall.SIGINT] != Quit {
		t.Error("SIGTERM/SIGINT should map to Quit")
	}
	if m[syscall.SIGUSR1] != Snapshot {
		t.Error("SIGUSR1 should map to Snapshot")
	}
	if m[syscall.SIGUSR2] != Custom {
		t.Error("SIGUSR2 should map to Custom")
	}
}

func TestWatchTranslatesInjectedSignals(t *testing.T) {
	s := NewSet()
	events := make(chan SignalEvent, 4)
	ch := make(chan os.Signal, 4)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Watch(ctx, ch, func(ev SignalEvent) { events <- ev })

	ch <- syscall.SIGHUP
	ch <- syscall.SIGUSR1
	ch <- syscall.SIGTERM
	ch <- syscall.SIGUSR2

	deadline := time.After(2 * time.Second)
	want := []Semantics{Reload, Snapshot, Quit, Custom}
	for _, w := range want {
		select {
		case ev := <-events:
			if ev.Semantics != w {
				t.Errorf("got semantics %v, want %v", ev.Semantics, w)
			}
		case <-deadline:
			t.Fatalf("timeout waiting for semantics %v", w)
		}
	}
}

func TestWatchUnknownSignalIgnored(t *testing.T) {
	s := NewSet()
	ch := make(chan os.Signal, 2)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	called := 0
	s.Watch(ctx, ch, func(SignalEvent) { called++ })
	ch <- syscall.SIGWINCH
	time.Sleep(50 * time.Millisecond)
	if called != 0 {
		t.Errorf("unknown signal should be ignored, handler called %d times", called)
	}
}

func TestRegisterOverride(t *testing.T) {
	s := NewSet()
	s.Register(syscall.SIGHUP, Custom)
	if s.Map()[syscall.SIGHUP] != Custom {
		t.Error("Register should override semantics")
	}
}
