package middleware

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
)

// CSRF implements the double-submit cookie pattern required by
// docs/security-spec.md §3.3:
//
//   - login sets a non-HttpOnly cookie `oc_admin_csrf` (SameSite=Strict)
//   - every unsafe request must echo the same value in X-CSRF-Token
//   - comparison is constant-time
//
// Default mode is strict: EVERY unsafe admin request must carry the
// double-submit pair, including Bearer-authenticated CLI calls (adminctl
// obtains csrf_token at login). ExemptBearer exists only as an explicit
// deployment escape hatch; production should leave it false.
type CSRF struct {
	CookieName   string
	HeaderName   string
	ExemptBearer bool
}

// NewCSRF builds the middleware with sane defaults.
func NewCSRF(cookieName, headerName string) *CSRF {
	if cookieName == "" {
		cookieName = "oc_admin_csrf"
	}
	if headerName == "" {
		headerName = "X-CSRF-Token"
	}
	return &CSRF{CookieName: cookieName, HeaderName: headerName, ExemptBearer: false}
}

// Equal compares two tokens in constant time (hashing first so length
// differences do not leak through).
func Equal(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ah := sha256.Sum256([]byte(a))
	bh := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ah[:], bh[:]) == 1
}

// Middleware enforces the check for unsafe methods.
func (c *CSRF) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
			next.ServeHTTP(w, r)
			return
		}
		if c.ExemptBearer && HasBearer(r) {
			next.ServeHTTP(w, r)
			return
		}
		cookie, err := r.Cookie(c.CookieName)
		if err != nil || cookie.Value == "" {
			WriteError(w, r, http.StatusForbidden, "csrf_invalid")
			return
		}
		header := r.Header.Get(c.HeaderName)
		if !Equal(cookie.Value, header) {
			WriteError(w, r, http.StatusForbidden, "csrf_invalid")
			return
		}
		next.ServeHTTP(w, r)
	})
}
