// Package authn 提供 JWT 验签与密码哈希（docs/security-spec.md §2.1/§2.4）。
//
// 无状态纯函数：不查 DB、不管理连接、不踢人。所有状态在数据层。
package authn

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var (
	// ErrInvalidToken token 非法/签名错误/格式错误。
	ErrInvalidToken = errors.New("authn: invalid token")
	// ErrExpired token 过期。
	ErrExpired = errors.New("authn: token expired")
	// ErrWrongType typ 不是 access。
	ErrWrongType = errors.New("authn: wrong token type")
	// ErrNoKey 验签公钥缺失。
	ErrNoKey = errors.New("authn: missing public key")
)

// Identity 是验签通过后的身份（最小集，绝不含 PII）。
type Identity struct {
	UserID   int64
	DeviceID string
}

// Claims 是 access/refresh token 的 claims（security-spec §2.1 最小集）。
type Claims struct {
	Sub string `json:"sub"` // uid（字符串形式，兼容 JWT 规范）
	Jti string `json:"jti"` // 随机 128bit
	Did string `json:"did"` // 设备 ID
	Typ string `json:"typ"` // "access" / "refresh"
	Ver int    `json:"ver"` // 令牌格式版本
	jwt.RegisteredClaims
}

// UserIDInt 解析 sub 为 int64。
func (c *Claims) UserIDInt() (int64, error) {
	if c.Sub == "" {
		return 0, ErrInvalidToken
	}
	id, err := strconv.ParseInt(c.Sub, 10, 64)
	if err != nil || id <= 0 {
		return 0, ErrInvalidToken
	}
	return id, nil
}

// Verifier Ed25519 验签器（security-spec §2.1：alg 白名单 ["EdDSA"]）。
type Verifier struct {
	pub  ed25519.PublicKey
	opts []jwt.ParserOption
	now  func() time.Time
}

// NewVerifier 用公钥构造。pub 为 nil 时 Verify 一律失败（fail-closed）。
func NewVerifier(pub ed25519.PublicKey) *Verifier {
	v := &Verifier{pub: pub, now: time.Now}
	v.opts = []jwt.ParserOption{
		// 【红线】固定 alg 白名单，拒绝 alg 混淆（HS256 用公钥当 HMAC 密钥等）。
		jwt.WithValidMethods([]string{"EdDSA"}),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(30 * time.Second),
		jwt.WithTimeFunc(func() time.Time { return v.now() }),
	}
	return v
}

// SetTimeFunc 测试注入时钟。
func (v *Verifier) SetTimeFunc(f func() time.Time) { v.now = f }

// Verify 校验 access token 并返回 Identity。
// 校验项：签名（EdDSA/Ed25519）、exp、sub、jti、did、typ。
func (v *Verifier) Verify(token string) (*Identity, error) {
	return v.verify(token, "access")
}

// VerifyRefresh 校验 refresh token（供数据层刷新流程复用）。
func (v *Verifier) VerifyRefresh(token string) (*Identity, error) {
	return v.verify(token, "refresh")
}

func (v *Verifier) verify(token, wantTyp string) (*Identity, error) {
	if v.pub == nil {
		return nil, ErrNoKey
	}
	claims := &Claims{}
	parser := jwt.NewParser(v.opts...)
	tok, err := parser.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		// 双保险：keyfunc 再检查 alg（解析器白名单之外的最后一道闸）。
		if t.Method == nil || t.Method.Alg() != "EdDSA" {
			return nil, ErrInvalidToken
		}
		if _, ok := t.Method.(*jwt.SigningMethodEd25519); !ok {
			return nil, ErrInvalidToken
		}
		return v.pub, nil
	})
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return nil, ErrExpired
		}
		return nil, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	if tok == nil || !tok.Valid {
		return nil, ErrInvalidToken
	}
	if claims.Typ != wantTyp {
		return nil, fmt.Errorf("%w: %s", ErrWrongType, claims.Typ)
	}
	if claims.Jti == "" || claims.Did == "" {
		return nil, fmt.Errorf("%w: missing jti/did", ErrInvalidToken)
	}
	uid, err := claims.UserIDInt()
	if err != nil {
		return nil, err
	}
	return &Identity{UserID: uid, DeviceID: claims.Did}, nil
}

// Signer 是测试/开发用签发器（生产由身份服务持有私钥）。
// 用 ed25519 私钥签发 access/refresh，claims 与 Verifier 完全对称。
type Signer struct {
	priv ed25519.PrivateKey
	kid  string
	now  func() time.Time
}

// NewSigner 构造签发器。
func NewSigner(priv ed25519.PrivateKey) *Signer {
	return &Signer{priv: priv, now: time.Now}
}

// WithKID 设置 header kid（密钥轮换标识）。
func (s *Signer) WithKID(kid string) *Signer {
	s.kid = kid
	return s
}

// SetTimeFunc 测试注入时钟。
func (s *Signer) SetTimeFunc(f func() time.Time) { s.now = f }

// SignAccess 签发 access token（默认 TTL 15min，security-spec §2.1）。
func (s *Signer) SignAccess(uid int64, deviceID string, ttl time.Duration) (string, error) {
	return s.sign(uid, deviceID, "access", ttl)
}

// SignRefresh 签发 refresh token（默认 TTL 30 天）。
func (s *Signer) SignRefresh(uid int64, deviceID string, ttl time.Duration) (string, error) {
	return s.sign(uid, deviceID, "refresh", ttl)
}

func (s *Signer) sign(uid int64, deviceID, typ string, ttl time.Duration) (string, error) {
	if s.priv == nil {
		return "", errors.New("authn: missing private key")
	}
	if ttl <= 0 {
		if typ == "refresh" {
			ttl = 30 * 24 * time.Hour
		} else {
			ttl = 15 * time.Minute
		}
	}
	now := s.now()
	claims := &Claims{
		Sub: strconv.FormatInt(uid, 10),
		Jti: newJTI(),
		Did: deviceID,
		Typ: typ,
		Ver: 1,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	if s.kid != "" {
		tok.Header["kid"] = s.kid
	}
	return tok.SignedString(s.priv)
}
