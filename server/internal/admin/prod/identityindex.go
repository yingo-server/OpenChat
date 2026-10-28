package prod

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// IDIndexHasher builds an Options.IDHasher that matches the identity index the
// auth path writes into identity_identities.id_value:
//
//	hex(HMAC-SHA256(key, "<idType>:<normalized identifier>"))
//
// The key is the deployment's PII index key (authsvc Deps.HMACKey, file
// phone_lookup_key). Multiple idTypes may be supplied — a query string that
// looks like a phone is then also probed as an email/username index, and every
// candidate is OR-matched in one parameterized statement.
//
// This package never holds the key itself: the caller injects the function.
func IDIndexHasher(key []byte, idTypes ...int) func(string) []string {
	types := append([]int(nil), idTypes...)
	return func(raw string) []string {
		normalized := NormalizeIdentifier(raw)
		if normalized == "" || len(types) == 0 || len(key) == 0 {
			return nil
		}
		out := make([]string, 0, len(types))
		for _, t := range types {
			mac := hmac.New(sha256.New, key)
			fmt.Fprintf(mac, "%d:%s", t, normalized)
			out = append(out, hex.EncodeToString(mac.Sum(nil)))
		}
		return out
	}
}

// NormalizeIdentifier matches the auth path's normalization: strip the visual
// separators phones are written with and lower-case the result (emails and
// usernames are case-insensitive).
func NormalizeIdentifier(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.NewReplacer(" ", "", "-", "", "(", "", ")", "").Replace(raw)
	return strings.ToLower(raw)
}

// Identity type constants mirrored from the auth path (documentation only —
// the adapter never branches on them).
const (
	IDTypePhone    = 1
	IDTypeEmail    = 2
	IDTypeUsername = 3
)
