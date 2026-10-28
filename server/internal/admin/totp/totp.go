// Package totp implements RFC 6238 TOTP (RFC 4226 HOTP core) with SHA-1,
// 6 digits and a 30-second period, as mandated by docs/security-spec.md §3.3.
//
// It is intentionally dependency-free: HMAC-SHA1 and base32 come from the Go
// standard library. Do not replace this with a third-party dependency without
// a security review.
package totp

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

const (
	// Digits is the required code length.
	Digits = 6
	// Period is the TOTP time step.
	Period = 30 * time.Second
	// DefaultWindow is the allowed ±1 step clock skew.
	DefaultWindow = 1
)

// Generate returns the code for secret at time t.
func Generate(secret []byte, t time.Time) string {
	return GenerateDigits(secret, t, Digits)
}

// GenerateDigits is Generate with an explicit digit count (RFC test vectors
// use 8 digits; production uses 6).
func GenerateDigits(secret []byte, t time.Time, digits int) string {
	counter := uint64(t.Unix() / int64(Period/time.Second))
	return hotp(secret, counter, digits)
}

// hotp computes RFC 4226 HOTP.
func hotp(secret []byte, counter uint64, digits int) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)
	mac := hmac.New(sha1.New, secret)
	mac.Write(buf[:])
	sum := mac.Sum(nil)

	// Dynamic truncation (RFC 4226 §5.3).
	offset := sum[len(sum)-1] & 0x0f
	code := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])

	mod := uint32(1)
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, code%mod)
}

// Validate checks a user-supplied code against secretBase32 at time t with
// the default ±1 step window. Comparison is constant-time.
func Validate(secretBase32, code string, t time.Time) bool {
	return ValidateWindow(secretBase32, code, t, DefaultWindow)
}

// ValidateWindow is Validate with an explicit window (number of steps on each
// side; 0 means only the current step).
func ValidateWindow(secretBase32, code string, t time.Time, window int) bool {
	secret, err := DecodeSecret(secretBase32)
	if err != nil {
		return false
	}
	code = strings.TrimSpace(code)
	if len(code) != Digits {
		return false
	}
	// Reject non-digits early; still perform a full comparison loop below so
	// malformed input doesn't short-circuit into a different timing class.
	validShape := true
	for i := 0; i < len(code); i++ {
		if code[i] < '0' || code[i] > '9' {
			validShape = false
		}
	}
	if !validShape {
		return false
	}
	ok := 0
	for delta := -window; delta <= window; delta++ {
		step := t.Add(time.Duration(delta) * Period)
		want := Generate(secret, step)
		ok |= subtle.ConstantTimeCompare([]byte(want), []byte(code))
	}
	return ok == 1
}

// DecodeSecret decodes a base32 TOTP secret. Google-Authenticator-style
// secrets are usually uppercase and may contain spaces; padding is optional.
func DecodeSecret(s string) ([]byte, error) {
	s = strings.ToUpper(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "-", "")
	if s == "" {
		return nil, fmt.Errorf("totp: empty secret")
	}
	// RawStdEncoding accepts unpadded input; add padding when present so both
	// padded and unpadded secrets work.
	if m := len(s) % 8; m != 0 {
		s += strings.Repeat("=", 8-m)
	}
	return base32.StdEncoding.DecodeString(s)
}

// SecretFromASCII is a test/helper convenience: RFC 6238's reference secret is
// the ASCII bytes "12345678901234567890". It returns the base32 encoding.
func SecretFromASCII(s string) string {
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte(s))
}
