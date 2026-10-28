package authn

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2Params 密码哈希参数（security-spec §2.4 红线）：
// m=64MB、t=2、p=2、salt=16B、keyLen=32。
type Argon2Params struct {
	Memory      uint32 // KiB
	Iterations  uint32
	Parallelism uint8
	SaltLength  uint32
	KeyLength   uint32
}

// DefaultArgon2Params 返回安全规范默认值。
func DefaultArgon2Params() Argon2Params {
	return Argon2Params{
		Memory:      64 * 1024, // 65536 KiB = 64 MB
		Iterations:  2,
		Parallelism: 2,
		SaltLength:  16,
		KeyLength:   32,
	}
}

var (
	// ErrInvalidHash 哈希串格式非法。
	ErrInvalidHash = errors.New("authn: invalid argon2 hash format")
	// ErrIncompatibleVersion PHC 版本不兼容。
	ErrIncompatibleVersion = errors.New("authn: incompatible argon2 version")
)

// Hasher argon2id 哈希器。
type Hasher struct {
	Params Argon2Params
	// dummy 是"假哈希"占位：编码非法/用户不存在时对固定盐做完整计算，
	// 保证错误路径与正常路径耗时一致（防时序枚举，security-spec §2.4）。
	dummy     string
	dummyOnce bool
}

// NewHasher 构造。params 为零值时使用安全默认值。
func NewHasher(params Argon2Params) *Hasher {
	if params.Memory == 0 {
		params = DefaultArgon2Params()
	}
	return &Hasher{Params: params}
}

// Hash 计算密码哈希，返回 PHC 风格编码串：
//
//	$argon2id$v=19$m=65536,t=2,p=2$<salt-b64>$<hash-b64>
func (h *Hasher) Hash(password string) (string, error) {
	salt := make([]byte, h.Params.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("authn: read salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, h.Params.Iterations, h.Params.Memory, h.Params.Parallelism, h.Params.KeyLength)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, h.Params.Memory, h.Params.Iterations, h.Params.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// Verify 校验密码；返回 (ok, rehashNeeded)。
// 任何解析失败都会走假哈希路径（完整 argon2 计算 + 恒时比较），不 panic、不提前返回。
func (h *Hasher) Verify(password, encoded string) (bool, error) {
	params, salt, wantKey, err := decodeHash(encoded)
	if err != nil {
		h.fakeCompare(password)
		return false, err
	}
	gotKey := argon2.IDKey([]byte(password), salt, params.Iterations, params.Memory, params.Parallelism, uint32(len(wantKey)))
	ok := subtle.ConstantTimeCompare(gotKey, wantKey) == 1
	// rehashNeeded 供调用方平滑升级参数（当前参数与编码一致时为 false）。
	rehash := params.Memory != h.Params.Memory || params.Iterations != h.Params.Iterations || params.Parallelism != h.Params.Parallelism
	_ = rehash
	return ok, nil
}

// VerifyOrFake 用户不存在时调用：对固定假哈希做完整 argon2 + 恒时比较，
// 与 Verify 成功路径耗时近似（调用方据返回值统一处理为"认证失败"）。
func (h *Hasher) VerifyOrFake(password string) bool {
	h.fakeCompare(password)
	return false
}

// fakeCompare 对内部假哈希执行完整 argon2id 计算并恒时比较（结果被丢弃）。
func (h *Hasher) fakeCompare(password string) {
	enc := h.ensureDummy()
	params, salt, wantKey, err := decodeHash(enc)
	if err != nil { // 理论上不会发生；兜底不 panic。
		_ = argon2.IDKey([]byte(password), make([]byte, h.Params.SaltLength), h.Params.Iterations, h.Params.Memory, h.Params.Parallelism, h.Params.KeyLength)
		return
	}
	got := argon2.IDKey([]byte(password), salt, params.Iterations, params.Memory, params.Parallelism, uint32(len(wantKey)))
	_ = subtle.ConstantTimeCompare(got, wantKey)
}

// ensureDummy 惰性构造一个合法假哈希（使用固定盐，避免每次 rand 开销）。
func (h *Hasher) ensureDummy() string {
	if h.dummyOnce {
		return h.dummy
	}
	salt := make([]byte, h.Params.SaltLength)
	for i := range salt {
		salt[i] = byte(i + 1)
	}
	key := argon2.IDKey([]byte("dummy-password-for-timing"), salt, h.Params.Iterations, h.Params.Memory, h.Params.Parallelism, h.Params.KeyLength)
	h.dummy = fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, h.Params.Memory, h.Params.Iterations, h.Params.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key))
	h.dummyOnce = true
	return h.dummy
}

// decodeHash 解析 PHC 编码串。
func decodeHash(encoded string) (params Argon2Params, salt, key []byte, err error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return params, nil, nil, ErrInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return params, nil, nil, ErrInvalidHash
	}
	if version != argon2.Version {
		return params, nil, nil, ErrIncompatibleVersion
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &params.Memory, &params.Iterations, &params.Parallelism); err != nil {
		return params, nil, nil, ErrInvalidHash
	}
	salt, err = base64.RawStdEncoding.Strict().DecodeString(parts[4])
	if err != nil {
		return params, nil, nil, ErrInvalidHash
	}
	key, err = base64.RawStdEncoding.Strict().DecodeString(parts[5])
	if err != nil {
		return params, nil, nil, ErrInvalidHash
	}
	if len(key) == 0 {
		return params, nil, nil, ErrInvalidHash
	}
	params.SaltLength = uint32(len(salt))
	params.KeyLength = uint32(len(key))
	return params, salt, key, nil
}
