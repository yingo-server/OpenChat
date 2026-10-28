package store

// Sentinel errors shared by store implementations and their consumers.
// api.go is frozen (interface signatures are final); shared error values live
// here so that pipe/job can use errors.Is without importing a concrete driver
// package (fake stores in tests must be able to produce them too).

import "errors"

// ErrDuplicate is the idempotency-conflict sentinel: the write collided with
// an existing UNIQUE key (e.g. cid,sender_id,client_msg_id dedup, or cid,seq).
// It is NOT a hard failure — callers translate it into "return the old ack".
var ErrDuplicate = errors.New("store: duplicate key conflict")

// ErrNotFound is the absent-row sentinel (user/conv/member/media lookups).
var ErrNotFound = errors.New("store: not found")
