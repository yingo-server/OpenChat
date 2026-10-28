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
