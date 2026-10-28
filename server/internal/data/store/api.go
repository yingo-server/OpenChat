// Package store defines the per-domain storage interfaces (docs §3.3).
//
// Rule of the house: handler 中出现 SQL 字符串即打回 — store 包外无 SQL.
// Interfaces are deliberately small and per-domain so that components like the
// archiver depend only on MsgReader + ArchiveTarget, and swapping the hot
// store implementation (or its schema) touches no other component.
//
// Ownership of the authorization red line: EVERY method here assumes the
// caller has already enforced membership/permission (dispatcher does
// cache.member.Check before anything enters the write pipeline). Store methods
// are NOT authorization boundaries and must never become ones.
package store

import "context"

// ---------------------------------------------------------------- msg domain

// PendingMsg is a message that has passed dedupguard and been assigned its seq
// range by seqalloc, awaiting flusher's group commit. Fields align 1:1 with
// msg_messages_hot columns.
type PendingMsg struct {
	MsgID       int64  // snowflake, assigned before flush
	Cid         int64
	Seq         int64
	SenderID    int64
	ClientMsgID string // dedup key; UNIQUE(cid,sender_id,client_msg_id)
	Content     []byte // Envelope payload verbatim; store never parses it
	SentAt      int64
}

// HotMsg is a message row read from the hot store. Content is opaque bytes;
// interpretation belongs to the envelope layer.
type HotMsg struct {
	MsgID       int64
	Cid         int64
	Seq         int64
	SenderID    int64
	ClientMsgID string
	Content     []byte
	SentAt      int64
	Edited      int64
	Recalled    int64
}

// MsgWriter is the hot write path, used by flusher (group commit) and seqalloc.
//
// Red line: AppendMessages performs NO membership checks — dispatcher/cache
// checked membership before the batch entered the pipeline. It is a single
// transaction per batch: all rows or none, acks hang off the commit.
type MsgWriter interface {
	// AppendMessages inserts a batch in one transaction. Partial inserts are
	// rolled back. Idempotency conflicts (duplicate cid,sender,client_msg_id)
	// return the existing rows as a conflict error, not a hard failure.
	AppendMessages(ctx context.Context, batch []PendingMsg) error

	// AllocateSeq atomically reserves the next n sequence numbers for cid and
	// returns the inclusive start (range = [start, start+n-1]). Implemented as
	// UPDATE conv_seq ... RETURNING; must be safe under concurrent writers.
	AllocateSeq(ctx context.Context, cid int64, n int) (start int64, err error)
}

// MsgReader is the hot read path, used by readrouter and archiver.
type MsgReader interface {
	// ReadHot returns up to limit messages of cid ordered by seq.
	// asc=false (typical paging): rows with seq < beforeSeq, descending.
	// asc=true: rows with seq > beforeSeq, ascending (catch-up sync).
	// beforeSeq <= 0 means "no cursor" (from the respective end).
	ReadHot(ctx context.Context, cid int64, beforeSeq int64, limit int, asc bool) ([]HotMsg, error)

	// FirstSeqAfter returns the smallest seq in cid strictly greater than
	// since, or 0 when no such row exists. Used to locate archive/dedup
	// resume points.
	FirstSeqAfter(ctx context.Context, cid int64, since int64) (int64, error)
}

// ------------------------------------------------------------ identity domain

// User mirrors identity_users. Status: 0 normal, 1 banned, 2 deletion
// cooling-off, 3 deleted.
type User struct {
	UID           int64
	DisplayName   string
	AvatarMediaID int64
	Status        int
	CreatedAt     int64
	AnonymousAt   int64 // 0 = not anonymized (NULL in DDL; int64 zero sentinel)
}

// Identity mirrors identity_identities; IdValue is the HMAC index value.
type Identity struct {
	IDType    int
	IDValue   string
	UID       int64
	Verified  bool
	CreatedAt int64
}

// Ban mirrors identity_bans. Until=0 means permanent. Level tiers are policy,
// never hardcoded here.
type Ban struct {
	UID       int64
	Level     int
	Reason    string
	Until     int64
	CreatedBy string
	CreatedAt int64
}

// IdentityStore is the identity domain's storage surface.
//
// Red line: lookup by identity is by HMAC'd IdValue ONLY — implementations
// must never accept or store raw identifiers. SetBan trusts the caller for
// authorization (admin chain + RBAC); it only records.
type IdentityStore interface {
	// UpsertUser creates or refreshes a user profile row.
	UpsertUser(ctx context.Context, u *User) error

	// LookupByIdentity resolves (idType, hmacValue) to a uid. Returns a
	// not-found error when absent.
	LookupByIdentity(ctx context.Context, idType int, idValue string) (int64, error)

	// GetUser fetches one user profile; not-found error when absent.
	GetUser(ctx context.Context, uid int64) (*User, error)

	// GetBan returns the currently effective ban for uid, or nil when the
	// user is not banned. Expired bans are treated as absent (and may be
	// lazily ignored — callers re-check Until against now).
	GetBan(ctx context.Context, uid int64) (*Ban, error)

	// SetBan records (or, with Level<=0, lifts) a ban record. Append-style:
	// history rows are kept, effectiveness is derived by expiry.
	SetBan(ctx context.Context, b *Ban) error
}

// --------------------------------------------------------------- conv domain

// ConvMeta mirrors conv_conversations. CType: 1 direct, 2 group.
type ConvMeta struct {
	Cid           int64
	CType         int
	Title         string
	AvatarMediaID int64
	CreatedBy     int64
	CreatedAt     int64
}

// Member mirrors conv_members. Role: 0 member, 1 admin, 2 owner.
type Member struct {
	Cid       int64
	UID       int64
	Role      int
	JoinedAt  int64
	MutedUntil int64
}

// ConvStore is the conversation domain's storage surface.
//
// Red line: CheckMember is the primitive the dispatcher's cache is primed
// from; it answers "is uid in cid" and NOTHING more — mute/role enforcement is
// domain logic above the store. RemoveMember/SetMemberRole assume the caller
// proved actor authority (role checks live in domain/conv).
type ConvStore interface {
	// CreateConv inserts a conversation and its creator as owner member,
	// atomically. Returns the allocated cid.
	CreateConv(ctx context.Context, m *ConvMeta, creatorUID int64) (cid int64, err error)

	// AddMember inserts a membership row; idempotent (already-member is a
	// no-op success).
	AddMember(ctx context.Context, m *Member) error

	// RemoveMember deletes a membership row; removing a non-member succeeds
	// (idempotent). Removing the last owner is rejected by domain logic, not here.
	RemoveMember(ctx context.Context, cid, uid int64) error

	// CheckMember reports membership existence (and current role/mute state).
	CheckMember(ctx context.Context, cid, uid int64) (*Member, error)

	// ListMembers returns all members of cid.
	ListMembers(ctx context.Context, cid int64) ([]Member, error)

	// SetMemberRole updates one member's role. Authorization happened above.
	SetMemberRole(ctx context.Context, cid, uid int64, role int) error

	// GetConvMeta returns conversation metadata; not-found error when absent.
	GetConvMeta(ctx context.Context, cid int64) (*ConvMeta, error)

	// NextSeq returns cid's next unconsumed sequence number WITHOUT reserving
	// it (peek). Range reservation belongs to MsgWriter.AllocateSeq; this
	// exists for readers/inspect tooling.
	NextSeq(ctx context.Context, cid int64) (int64, error)
}

// -------------------------------------------------------------- media domain

// Media mirrors media_media. Status: 0 scanning, 1 usable, 2 violation.
type Media struct {
	MediaID    string // base64url, >= 22 chars
	UID        int64
	MType      int
	Name       string
	Size       int64
	Mime       string
	Width      int
	Height     int
	DurationMS int64
	Status     int
	SHA256     string
	CreatedAt  int64
	RefCount   int64
}

// MediaStore is the media domain's storage surface.
//
// Red line: callers must treat Status!=1 media as unusable; serving a file
// whose scan is pending or failed is a review-level violation. RefCount
// changes and file lifecycle (GC of zero-ref media) are separate mechanisms.
type MediaStore interface {
	// Insert registers a new media record (status 0 by convention).
	Insert(ctx context.Context, m *Media) error

	// Get fetches one media record; not-found error when absent.
	Get(ctx context.Context, mediaID string) (*Media, error)

	// UpdateStatus transitions scan state (0->1 usable, ->2 violation).
	UpdateStatus(ctx context.Context, mediaID string, status int) error

	// IncRefCount adjusts the reference count by delta (may be negative).
	IncRefCount(ctx context.Context, mediaID string, delta int64) error

	// AddRef is shorthand for IncRefCount(+1) after a message referencing the
	// media commits; implementations may assert existence.
	AddRef(ctx context.Context, mediaID string) error
}

// ---------------------------------------------------------------- sys domain

// Presence mirrors sys_presence.
type Presence struct {
	UID      int64
	Online   bool
	LastSeen int64
}

// Flag mirrors sys_feature_flags (972 flag chain = policy-as-flag storage).
type Flag struct {
	Key     string
	Value   string // JSON
	Version int
}

// RateWindow is a fixed-window counter result.
type RateWindow struct {
	Subject      string
	Action       string
	WindowStart  int64
	Count        int64
	WindowLength int64 // seconds, supplied by caller (policy)
}

// Penalty mirrors sys_rate_limit_penalty (e.g. subject-wide cooldowns).
type Penalty struct {
	Subject string
	Penalty string // e.g. "msg", "login"
	Until   int64
}

// SysStore is the system domain's storage surface.
//
// Red line: RateLimitIncr is ONLY a counter primitive. Whether a count is
// "too many" is decided by the caller reading policy — never by the store.
type SysStore interface {
	// UpsertFlag stores a feature flag / policy-flag document, bumping its
	// version for incremental frame fan-out.
	UpsertFlag(ctx context.Context, f *Flag) error

	// AllFlags returns every flag, for bridge cold start.
	AllFlags(ctx context.Context) ([]Flag, error)

	// UpsertPresence refreshes a user's presence row (upsert by uid).
	UpsertPresence(ctx context.Context, p *Presence) error

	// GetPresence returns a presence row; zero-value result (offline) when
	// the uid has never been seen is acceptable.
	GetPresence(ctx context.Context, uid int64) (*Presence, error)

	// RateLimitIncr atomically increments the (subject, action, windowStart)
	// bucket and returns the post-increment state. Limit evaluation is the
	// caller's job, driven by policy.
	RateLimitIncr(ctx context.Context, subject, action string, windowStart int64) (*RateWindow, error)

	// GetPenalty returns the active penalty for (subject, penalty) or nil.
	GetPenalty(ctx context.Context, subject, penalty string) (*Penalty, error)

	// SetPenalty upserts (or, with Until<=now semantics chosen by caller,
	// replaces) a penalty row. Durations/levels are policy, not store logic.
	SetPenalty(ctx context.Context, p *Penalty) error
}

// ------------------------------------------------------- archive (cold) target

// ArchiveTarget is what the archiver pushes hot rows into. The archiver knows
// ONLY this interface plus MsgReader — swap the cold schema, swap one impl.
type ArchiveTarget interface {
	// CopyBatch inserts rows into the cold archive idempotently
	// (ON CONFLICT DO NOTHING semantics); returns how many rows were newly
	// moved. Retries must be safe: re-copying a batch must not duplicate.
	CopyBatch(ctx context.Context, rows []HotMsg) (int64, error)

	// DeleteHot removes hot rows for the caller-provided cutoff boundary.
	// Careful: only ever called after CopyBatch committed for those rows —
	// the ordering is the archiver's contract, not this interface's.
	DeleteHot(ctx context.Context, before int64) (int64, error)
}

// ------------------------------------------------------------ audit (cold)

// AuditEvent is one append to the audit journal. PrevHash/RecordHash chain
// integrity is computed by the implementation; the caller supplies the
// semantic fields only.
type AuditEvent struct {
	Actor   string // admin/bridge actor id
	Action  string // e.g. "user.ban"
	Subject string // affected resource, e.g. "user:123"
	Detail  []byte // JSONB payload
	At      int64
}

// AuditJournal is the SINGLE write entry point for the audit trail
// (sys.audit_log, INSERT-only + hash chain). Audit reads are NOT here —
// reading is a cursor stream over the log (journalctl semantics), served by
// the admin query layer.
//
// Red line: implementations must never expose UPDATE/DELETE on audit rows.
type AuditJournal interface {
	Append(ctx context.Context, ev AuditEvent) error
}
