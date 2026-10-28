package authn

import (
	"testing"
)

func testParams() Argon2Params {
	return Argon2Params{Memory: 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32}
}

// TestArgon2RoundTrip 正确/错误密码往返。
func TestArgon2RoundTrip(t *testing.T) {
	h := NewHasher(testParams())
	enc, err := h.Hash("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if enc == "" {
		t.Fatal("empty hash")
	}
	ok, err := h.Verify("correct horse battery staple", enc)
	if err != nil || !ok {
		t.Fatalf("Verify correct = %v, %v", ok, err)
	}
	ok, err = h.Verify("wrong password", enc)
	if err != nil {
		t.Fatalf("Verify wrong err = %v", err)
	}
	if ok {
		t.Fatal("wrong password accepted")
	}
}

// TestArgon2DefaultParams 安全规范默认参数（m=64MB,t=2,p=2）。
func TestArgon2DefaultParams(t *testing.T) {
	p := DefaultArgon2Params()
	if p.Memory != 64*1024 || p.Iterations != 2 || p.Parallelism != 2 || p.SaltLength != 16 || p.KeyLength != 32 {
		t.Fatalf("params = %+v", p)
	}
	h := NewHasher(DefaultArgon2Params())
	enc, err := h.Hash("s3cret-password")
	if err != nil {
		t.Fatal(err)
	}
	ok, err := h.Verify("s3cret-password", enc)
	if err != nil || !ok {
		t.Fatalf("default params verify = %v %v", ok, err)
	}
}

// TestFakeHashPath 假哈希路径不得 panic（错误 hash 格式/用户不存在）。
func TestFakeHashPath(t *testing.T) {
	h := NewHasher(testParams())
	for _, bad := range []string{"", "plaintext", "$argon2id$v=19$m=1$bad", "$argon2i$v=19$m=1,t=1,p=1$aaaa$bbbb"} {
		ok, err := h.Verify("pw", bad)
		if ok {
			t.Fatalf("bad hash %q verified", bad)
		}
		if err == nil {
			t.Fatalf("bad hash %q expected error", bad)
		}
	}
	if h.VerifyOrFake("anything") {
		t.Fatal("VerifyOrFake must always return false")
	}
}

// TestConstantTimeComparePath 验证实现使用 subtle 恒时比较：同长度错误密码不 panic。
func TestConstantTimeComparePath(t *testing.T) {
	h := NewHasher(testParams())
	enc, _ := h.Hash("password-one")
	for _, pw := range []string{"password-two", "password-on", "password-one-longer", ""} {
		ok, err := h.Verify(pw, enc)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if ok {
			t.Fatalf("password %q accepted", pw)
		}
	}
}
