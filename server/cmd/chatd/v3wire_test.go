// v3wire_test.go —— P3c 主干装配层验证（docs/v3-bus-design.md §6/§9）：
//
//	(a) 默认 flag-off：assembly.v3 非 nil 但 Enabled()=false，且现有全量
//	    e2e（TestE2EReceiptReadForwarded）在装配改动后仍然绿；
//	(b) 热改 v3_bus_enabled=true / v3_bus_percent=100 后 Enabled()=true
//	    且 InBucket(uid) 稳定（与连接/重启无关）；
//	(c) Hub.Offer 一条后 mailbox_entries 有行；Restore 后 head/cursor 不回退
//	    （S-5）。
//
// 用 startAssembly helper（现有临时 hot.db + 真实迁移树），不额外造库。
package main

import (
	"context"
	"testing"

	"github.com/yingo-server/OpenDiscord/server/internal/bus/mailbox"
	"github.com/yingo-server/OpenDiscord/server/internal/pkg/featureflags"
)

// (a) 默认中间态：构造成功、Enabled=false、Offer 为 no-op（不落库）。
func TestV3WireDefaultOff(t *testing.T) {
	a, _ := startAssembly(t)
	if a.v3 == nil {
		t.Fatal("assembly.v3 must be non-nil after newAssembly (P3c construct)")
	}
	if a.v3.Enabled() {
		t.Fatal("default flags: Enabled() must be false")
	}
	if featureflags.BoolMap(a.flags.Snapshot(), featureflags.KeyV3BusEnabled) {
		t.Fatal("default v3_bus_enabled must be false")
	}
	seq, err := a.v3.Hub.Offer(context.Background(), testUID,
		mailbox.Envelope{Kind: 103, MsgID: 1, Blob: []byte("x")})
	if err != nil || seq != 0 {
		t.Fatalf("offer(flag-off): seq=%d err=%v, want no-op", seq, err)
	}
	var n int
	if err := a.hot.DB.QueryRow(`SELECT COUNT(*) FROM mailbox_entries`).Scan(&n); err != nil {
		t.Fatalf("count mailbox_entries: %v", err)
	}
	if n != 0 {
		t.Fatalf("flag-off offer must not persist rows, got %d", n)
	}
}

// (b) 热改 flag：Enabled 翻转 + InBucket 稳定分桶（同一进程内快照热生效）。
func TestV3WireHotToggle(t *testing.T) {
	a, _ := startAssembly(t)
	ctx := context.Background()
	const uid = int64(77)

	a.flags.Apply(map[string]any{
		featureflags.KeyV3BusEnabled: true,
		featureflags.KeyV3BusPercent: 100,
	})
	if !a.v3.Enabled() {
		t.Fatal("after hot toggle enabled=true/percent=100: Enabled() must be true")
	}
	if !a.v3.InBucket(uid) {
		t.Fatal("percent=100: uid must be in bucket")
	}
	for i := 0; i < 10; i++ {
		if !a.v3.InBucket(uid) {
			t.Fatal("InBucket must be stable across repeated reads")
		}
	}
	// 热改后 Offer 真落库（hub 与 wire 共用同一 flagsFn 快照源）。
	seq, err := a.v3.Hub.Offer(ctx, uid, mailbox.Envelope{Kind: 103, MsgID: 9, Blob: []byte("y")})
	if err != nil || seq == 0 {
		t.Fatalf("offer(after toggle): seq=%d err=%v", seq, err)
	}
	// 收尾把开关关回去，验证 kill-switch 立即生效。
	a.flags.Apply(map[string]any{featureflags.KeyV3BusEnabled: false})
	if a.v3.Enabled() {
		t.Fatal("kill-switch: Enabled() must be false again")
	}
}

// (c)+(S-5)：Offer 落库、Ack 推进、Restore 后 head/cursor 不回退。
func TestV3WireOfferRestore(t *testing.T) {
	a, _ := startAssembly(t)
	ctx := context.Background()
	const uid = int64(88)

	a.flags.Apply(map[string]any{
		featureflags.KeyV3BusEnabled: true,
		featureflags.KeyV3BusPercent: 100,
	})

	var lastSeq int64
	for i := int64(1); i <= 3; i++ {
		seq, err := a.v3.Hub.Offer(ctx, uid, mailbox.Envelope{Kind: 103, MsgID: i, Blob: []byte("m")})
		if err != nil || seq == 0 {
			t.Fatalf("offer %d: seq=%d err=%v", i, seq, err)
		}
		lastSeq = seq
	}
	var n int
	if err := a.hot.DB.QueryRow(`SELECT COUNT(*) FROM mailbox_entries WHERE user_id = ?`, uid).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 3 {
		t.Fatalf("expected 3 mailbox rows, got %d", n)
	}
	if err := a.v3.Hub.Ack(ctx, uid, 2); err != nil {
		t.Fatalf("ack: %v", err)
	}
	if got := a.v3.Hub.Cursor(uid); got != 2 {
		t.Fatalf("cursor after ack = %d, want 2", got)
	}

	// 模拟重启：同一热库、全新 Hub/Store 实例 + Restore（S-5：不回退）。
	store := mailbox.NewStore(a.hot.DB)
	hub2 := mailbox.NewHub(store, a.flags.Snapshot, mailbox.HubConfig{})
	if err := hub2.Restore(ctx, uid); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if got := hub2.Head(uid); got != lastSeq {
		t.Fatalf("post-restore head=%d, want %d (no regression)", got, lastSeq)
	}
	if got := hub2.Cursor(uid); got != 2 {
		t.Fatalf("post-restore cursor=%d, want 2 (no regression)", got)
	}
	// 后退 Ack 幂等忽略：cursor 不回退。
	if err := hub2.Ack(ctx, uid, 1); err != nil {
		t.Fatalf("stale ack: %v", err)
	}
	if got := hub2.Cursor(uid); got != 2 {
		t.Fatalf("cursor regressed after stale ack: %d", got)
	}
}
