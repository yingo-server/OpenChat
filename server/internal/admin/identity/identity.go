// Package identity holds the admin-plane principal types shared by the
// middleware, service and handler layers.
//
// Administration identities are deliberately a different type from the user
// plane's authn claims: the security spec (§3.3) requires the admin API to
// use a separate key system and middleware chain. Nothing here imports the
// user JWT/Ed25519 code path.
package identity

import "fmt"

// Role is the admin RBAC role. The numeric values match the adm.adm_admins
// DDL comment (0 superadmin / 1 ops / 2 moderator=review).
type Role int

const (
	RoleSuper  Role = 0 // super: every permission
	RoleOps    Role = 1 // ops: operations, but not policy/flag writes
	RoleReview Role = 2 // review: content governance only
)

// String returns the stable role name used by the API/CLI.
func (r Role) String() string {
	switch r {
	case RoleSuper:
		return "super"
	case RoleOps:
		return "ops"
	case RoleReview:
		return "review"
	default:
		return fmt.Sprintf("unknown(%d)", int(r))
	}
}

// ParseRole maps the API/CLI spelling to a Role. Unknown values are rejected;
// callers must not silently elevate.
func ParseRole(s string) (Role, bool) {
	switch s {
	case "super", "superadmin":
		return RoleSuper, true
	case "ops":
		return RoleOps, true
	case "review", "moderator":
		return RoleReview, true
	default:
		return RoleReview, false
	}
}

// RoleFromInt converts a stored value. Unknown values degrade to the least
// privileged role (review) — never to super.
func RoleFromInt(v int) Role {
	switch Role(v) {
	case RoleSuper:
		return RoleSuper
	case RoleOps:
		return RoleOps
	default:
		return RoleReview
	}
}

// Admin is the authenticated principal injected into a request context.
type Admin struct {
	AdminID   int64  `json:"admin_id"`
	Username  string `json:"username"`
	Role      Role   `json:"-"`
	SessionID string `json:"-"` // hashed session id; never serialized
	CSRF      string `json:"-"` // session CSRF token; never serialized
	ExpiresAt int64  `json:"expires_at"`
}

// RoleName exposes the role as a stable string for JSON responses.
func (a *Admin) RoleName() string {
	if a == nil {
		return ""
	}
	return a.Role.String()
}
