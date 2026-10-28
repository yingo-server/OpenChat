package totp

import (
	"testing"
	"time"
)

// RFC 6238 Appendix B test vectors (SHA-1, secret = ASCII
// "12345678901234567890"). The reference vectors are 8 digits; production
// codes are the same HOTP value truncated to 6 digits.
func TestRFC6238Vectors(t *testing.T) {
	secret := []byte("12345678901234567890")
	cases := []struct {
		unix int64
		want string
	}{
		{59, "94287082"},
		{1111111109, "07081804"},
		{1111111111, "14050471"},
		{1234567890, "89005924"},
		{2000000000, "69279037"},
		{20000000000, "65353130"},
	}
	for _, c := range cases {
		got := GenerateDigits(secret, time.Unix(c.unix, 0), 8)
		if got != c.want {
			t.Fatalf("T=%d: got %s want %s", c.unix, got, c.want)
		}
	}
}

func TestValidateSixDigitsAndWindow(t *testing.T) {
	secret := SecretFromASCII("12345678901234567890")
	now := time.Unix(59, 0)
	if code := Generate([]byte("12345678901234567890"), now); code != "287082" {
		t.Fatalf("6-digit code at T=59 = %s, want 287082", code)
	}
	if !Validate(secret, "287082", now) {
		t.Fatal("current-step code rejected")
	}
	if !Validate(secret, "287082", now.Add(30*time.Second)) {
		t.Fatal("−1 window code rejected")
	}
	if !Validate(secret, "287082", now.Add(-30*time.Second)) {
		t.Fatal("+1 window code rejected")
	}
	if Validate(secret, "287082", now.Add(60*time.Second)) {
		t.Fatal("code outside ±1 window accepted")
	}
	if Validate(secret, "000000", now) {
		t.Fatal("wrong code accepted")
	}
}

func TestDecodeSecretPaddedAndUnpadded(t *testing.T) {
	padded := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	unpadded := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	for _, s := range []string{padded, unpadded, "gezd gnbv gy3t qojq gezd gnbv gy3t qojq"} {
		b, err := DecodeSecret(s)
		if err != nil {
			t.Fatalf("decode %q: %v", s, err)
		}
		if string(b) != "12345678901234567890" {
			t.Fatalf("decode %q = %q", s, string(b))
		}
	}
}
