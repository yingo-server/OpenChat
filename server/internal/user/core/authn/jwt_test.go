package authn

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func newKeyPair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

// TestSignVerifyRoundTrip Ed25519 签发 → 验签往返。
func TestSignVerifyRoundTrip(t *testing.T) {
	pub, priv := newKeyPair(t)
	signer := NewSigner(priv).WithKID("k1")
	tok, err := signer.SignAccess(12345, "device-a", 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	id, err := NewVerifier(pub).Verify(tok)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if id.UserID != 12345 || id.DeviceID != "device-a" {
		t.Fatalf("identity = %+v", id)
	}
}

// TestExpiredRejected 过期 token 必须拒绝。
func TestExpiredRejected(t *testing.T) {
	pub, priv := newKeyPair(t)
	base := time.Unix(1_700_000_000, 0)
	signer := NewSigner(priv)
	signer.SetTimeFunc(func() time.Time { return base })
	tok, err := signer.SignAccess(1, "d", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	v := NewVerifier(pub)
	v.SetTimeFunc(func() time.Time { return base.Add(2 * time.Minute) })
	if _, err := v.Verify(tok); err == nil {
		t.Fatal("expired token accepted")
	} else if err != ErrExpired {
		t.Fatalf("err = %v, want ErrExpired", err)
	}
}

// TestAlgConfusionRejected HS256 签的 token 用 EdDSA 验签必须失败（红线）。
func TestAlgConfusionRejected(t *testing.T) {
	pub, _ := newKeyPair(t)
	claims := &Claims{
		Sub: "1", Jti: "j", Did: "d", Typ: "access", Ver: 1,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	// 攻击者把 Ed25519 公钥字节当 HMAC 密钥签 HS256。
	hs := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	forged, err := hs.SignedString([]byte(pub))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewVerifier(pub).Verify(forged); err == nil {
		t.Fatal("alg-confusion token accepted: MUST fail")
	}

	// alg=none 同样必须拒绝。
	none := jwt.NewWithClaims(jwt.SigningMethodNone, claims)
	noneTok, err := none.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewVerifier(pub).Verify(noneTok); err == nil {
		t.Fatal("alg=none token accepted: MUST fail")
	}
}

// TestTypAndClaims 校验 typ/jti/did/sub 缺失或错类型。
func TestTypAndClaims(t *testing.T) {
	pub, priv := newKeyPair(t)
	signer := NewSigner(priv)
	rt, err := signer.SignRefresh(7, "d", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	v := NewVerifier(pub)
	if _, err := v.Verify(rt); err == nil {
		t.Fatal("refresh token accepted as access")
	}
	if id, err := v.VerifyRefresh(rt); err != nil || id.UserID != 7 {
		t.Fatalf("VerifyRefresh = %+v, %v", id, err)
	}
}

// TestWrongKeyRejected 换一把公钥验签必须失败。
func TestWrongKeyRejected(t *testing.T) {
	_, priv := newKeyPair(t)
	otherPub, _ := newKeyPair(t)
	tok, _ := NewSigner(priv).SignAccess(1, "d", time.Minute)
	if _, err := NewVerifier(otherPub).Verify(tok); err == nil {
		t.Fatal("token accepted with wrong key")
	}
}
