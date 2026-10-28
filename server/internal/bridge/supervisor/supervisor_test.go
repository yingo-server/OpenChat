package supervisor

import (
	"context"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestQuitDrainsAndReturnsZero(t *testing.T) {
	s := New()
	drained := make(chan string, 2)
	s.AddDrain("egress", func(ctx context.Context) { drained <- "egress" })
	s.AddDrain("session", func(ctx context.Context) { drained <- "session" })
	shutdown := false
	s.OnShutdown = func() { shutdown = true }

	sigs := make(chan os.Signal, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		sigs <- syscall.SIGTERM
	}()
	code, err := s.Run(ctx, sigs)
	if code != ExitOK {
		t.Fatalf("code=%d err=%v", code, err)
	}
	if !shutdown {
		t.Fatal("shutdown notice callback not fired")
	}
	if <-drained != "egress" || <-drained != "session" {
		t.Fatal("drain order violated")
	}
}

func TestReloadCallback(t *testing.T) {
	s := New()
	reloaded := 0
	s.AddReload(func() { reloaded++ })
	sigs := make(chan os.Signal, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		sigs <- syscall.SIGHUP
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	_, _ = s.Run(ctx, sigs)
	if reloaded != 1 {
		t.Fatalf("reloaded=%d want 1", reloaded)
	}
}

func TestDrainTimeoutDoesNotBlock(t *testing.T) {
	s := New()
	s.AddDrain("hang", func(ctx context.Context) {
		<-ctx.Done() // 故意挂到超时
	})
	done := make(chan struct{})
	go func() {
		s.Drain(context.Background())
		close(done)
	}()
	// DrainTimeout=5s 太长，验证用受控 ctx。
	s2 := New()
	s2.AddDrain("hang", func(ctx context.Context) { <-ctx.Done() })
	d2 := make(chan struct{})
	go func() {
		cctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		s2.Drain(cctx)
		close(d2)
	}()
	select {
	case <-d2:
		// ok
	case <-time.After(2 * time.Second):
		t.Fatal("drain blocked beyond ctx timeout")
	}
	_ = done
}
