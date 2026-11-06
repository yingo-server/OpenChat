package featureflags

import (
	"sync"
	"testing"
)

func TestDefaults(t *testing.T) {
	s := New().Snapshot()
	for k, want := range map[string]any{
		KeyVideoEnabled: false, KeyE2EE: false, KeyRegistration: true,
		KeyReadonly: false, KeyCallEnabled: false,
	} {
		if s[k] != want {
			t.Errorf("default %s = %v, want %v", k, s[k], want)
		}
	}
}

// TestPullModeThresholdDefaultsToZero 锁定规范 §6.4 的中间态铁律：
// 服务端代码合入时 pull_mode_threshold 必须默认 0（禁用），因此合并后行为
// 与主干逐字节一致；启用是后续单独的一次 flag 变更。
func TestPullModeThresholdDefaultsToZero(t *testing.T) {
	if got := New().Int(KeyPullModeThreshold, -1); got != 0 {
		t.Fatalf("pull_mode_threshold default = %d, want 0 (disabled)", got)
	}
	if got, ok := Defaults()[KeyPullModeThreshold]; !ok || got != 0 {
		t.Fatalf("Defaults()[%s] = %v (present=%v), want 0", KeyPullModeThreshold, got, ok)
	}
}

// TestPullModeThrottleDefaults 锁定频控默认值（2026-11 定调：push 次数最小化）。
func TestPullModeThrottleDefaults(t *testing.T) {
	f := New()
	for k, want := range map[string]int{
		KeyWatermarkBatch:      50,
		KeyWatermarkIntervalMS: 2000,
		KeyWatermarkJitterMS:   2000,
	} {
		if got := f.Int(k, -1); got != want {
			t.Errorf("default %s = %d, want %d", k, got, want)
		}
	}
}

// TestIntCoercion 覆盖 flag 值的三种来源：Go 默认(int)、DB/JSON 装载(float64)、
// 911 下发的字符串。类型不符时回退 def，绝不 panic。
func TestIntCoercion(t *testing.T) {
	f := NewFromMap(map[string]any{
		"as_int":     int(7),
		"as_int64":   int64(8),
		"as_float":   float64(100),
		"as_string":  " 200 ",
		"as_bool":    true,
		"as_garbage": []string{"nope"},
	})
	for k, want := range map[string]int{
		"as_int": 7, "as_int64": 8, "as_float": 100, "as_string": 200, "as_bool": 1,
	} {
		if got := f.Int(k, -1); got != want {
			t.Errorf("Int(%s) = %d, want %d", k, got, want)
		}
	}
	if got := f.Int("as_garbage", 42); got != 42 {
		t.Errorf("Int(garbage) = %d, want fallback 42", got)
	}
	if got := f.Int("absent", 43); got != 43 {
		t.Errorf("Int(absent) = %d, want fallback 43", got)
	}
}

func TestApplyBumpsVersion(t *testing.T) {
	f := New()
	v1 := f.Apply(map[string]any{KeyE2EE: true})
	if v1 != 1 || f.Version() != 1 {
		t.Errorf("version = %d/%d, want 1/1", v1, f.Version())
	}
	if !f.Bool(KeyE2EE, false) {
		t.Error("e2ee should be true after Apply")
	}
	// 未覆盖的 key 保留
	if !f.Bool(KeyRegistration, false) {
		t.Error("registration should remain default true")
	}
}

func TestSnapshotIsCopy(t *testing.T) {
	f := New()
	s := f.Snapshot()
	s[KeyReadonly] = true
	if f.Bool(KeyReadonly, false) {
		t.Error("mutating Snapshot must not affect store")
	}
}

// TestConcurrentReadWrite 在 -race 下验证原子快照读写无数据竞态。
func TestConcurrentReadWrite(t *testing.T) {
	f := New()
	var wg sync.WaitGroup
	stop := make(chan struct{})

	for i := 0; i < 8; i++ { // writers
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				select {
				case <-stop:
					return
				default:
				}
				f.Apply(map[string]any{KeyVideoEnabled: j%2 == 0, "w": n*1000 + j})
			}
		}(i)
	}
	for i := 0; i < 8; i++ { // readers
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 500; j++ {
				select {
				case <-stop:
					return
				default:
				}
				_ = f.Snapshot()
				_ = f.Bool(KeyRegistration, false)
				_ = f.Version()
			}
		}()
	}
	wg.Wait()
	close(stop)
	// 终态一致性：版本 = 成功 Apply 次数之和（每次都返回递增值）
	final := f.Version()
	if final == 0 || final > 8*200 {
		t.Errorf("final version %d out of range", final)
	}
}
