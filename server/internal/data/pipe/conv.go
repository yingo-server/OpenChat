// conv.go: the 930 CONV_DATA domain handler (review P1-8 note).
//
// The identity domain (940/941) has been split out into
// data/domain/identity. The conv domain intentionally STAYS in the pipe for
// now: it is entangled with the pipe's own mechanisms (member checks feed
// the same cache lineage the msg domain uses; snapshot payloads mirror the
// read router's result shape), so a mechanical move risks behavior drift.
// The pipe keeps the pipeline skeleton (dedup/seq/flush/read) and dispatch;
// this file is domain logic only — no pipe-internal state is touched.

package pipe

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/yingo-server/OpenChat/server/internal/data/cache"
	"github.com/yingo-server/OpenChat/server/internal/data/pipe/wire"
	"github.com/yingo-server/OpenChat/server/internal/data/store"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
)

// ops for the 930 CONV_DATA lane.
const (
	convOpCreate       = 1
	convOpAddMember    = 2
	convOpRemoveMember = 3
	convOpSetRole      = 4
	convOpGetMeta      = 5
	convOpListMembers  = 6
)

// Conversation types (proto chat.v1: 1 direct, 2 group).
const (
	convTypeDirect    = 1
	convTypeGroup     = 2
	convMaxTitleRunes = 30
)

// convDomain serves kind 930 (CONV_DATA_REQUEST) → 931 (CONV_DATA_RESULT).
//
// Authorization is enforced HERE, in the pipe: the user-facing kinds
// (CONV_CREATE/MEMBER_ADD/...) are client requests and are never trusted.
// Every mutation checks the actor's current member role via ListMembers;
// getMeta/listMembers check membership before reading. The store itself never
// does role enforcement (api.go red line).
//
// Membership changes additionally emit one 202 CONV_PAYLOAD event PER MEMBER
// (not a conv.{cid} topic publish) so offline members get their own frame when
// the gateway broadcasts by user_id.
type convDomain struct {
	conv  store.ConvStore
	id    store.IdentityStore
	cache *cache.Cache
}

type convEvent struct {
	Kind    uint32
	UserID  uint64
	ConvID  uint64
	Payload []byte
}

type convResult struct {
	Op      uint32
	OK      bool
	Error   string
	Cid     int64
	Payload []byte
	Events  []convEvent
}

func (d *convDomain) handle(ctx context.Context, senderUID int64, op uint32, cid uint64, body []byte) convResult {
	switch op {
	case convOpCreate:
		return d.create(ctx, senderUID, body)
	case convOpAddMember:
		return d.addMember(ctx, senderUID, cid, body)
	case convOpRemoveMember:
		return d.removeMember(ctx, senderUID, cid, body)
	case convOpSetRole:
		return d.setRole(ctx, senderUID, cid, body)
	case convOpGetMeta:
		return d.getMeta(ctx, senderUID, cid)
	case convOpListMembers:
		return d.listMembers(ctx, senderUID, cid)
	}
	return convResult{Op: op, Error: "unknown op"}
}

func (d *convDomain) create(ctx context.Context, actor int64, body []byte) convResult {
	if actor <= 0 {
		return convResult{Op: convOpCreate, Error: "unauthenticated"}
	}
	var p wire.ConvPayload
	if err := wire.Unmarshal(body, &p); err != nil {
		return convResult{Op: convOpCreate, Error: "bad payload"}
	}
	if p.ConvType != convTypeDirect && p.ConvType != convTypeGroup {
		return convResult{Op: convOpCreate, Error: "bad conv type"}
	}

	if p.ConvType == convTypeDirect {
		if len(p.Members) == 0 || p.Members[0].UserID == 0 {
			return convResult{Op: convOpCreate, Error: "direct chat requires target user"}
		}
		target, err := d.checkedUser(ctx, int64(p.Members[0].UserID))
		if err != nil {
			return convResult{Op: convOpCreate, Error: err.Error()}
		}
		// Dedupe: one direct conversation per pair. Returns the existing cid.
		if existing, err := d.conv.SingleChatBetween(ctx, actor, target.UID); err == nil && existing > 0 {
			pl, members, err := d.snapshot(ctx, existing)
			if err != nil {
				return convResult{Op: convOpCreate, Error: err.Error()}
			}
			return convResult{Op: convOpCreate, OK: true, Cid: existing, Payload: pl,
				Events: convEvents(existing, members, pl)}
		} else if err != nil && !errors.Is(err, store.ErrNotFound) {
			return convResult{Op: convOpCreate, Error: err.Error()}
		}
		title := strings.TrimSpace(p.Title)
		if title == "" {
			title = target.DisplayName
		}
		newCid, err := d.conv.CreateConv(ctx, &store.ConvMeta{
			CType: convTypeDirect, Title: title, CreatedBy: actor, CreatedAt: nowSec(),
		}, actor)
		if err != nil {
			return convResult{Op: convOpCreate, Error: err.Error()}
		}
		if err := d.conv.AddMember(ctx, &store.Member{
			Cid: newCid, UID: target.UID, Role: 0, JoinedAt: nowSec(),
		}); err != nil {
			return convResult{Op: convOpCreate, Error: err.Error()}
		}
		pl, members, err := d.snapshot(ctx, newCid)
		if err != nil {
			return convResult{Op: convOpCreate, Error: err.Error()}
		}
		return convResult{Op: convOpCreate, OK: true, Cid: newCid, Payload: pl,
			Events: convEvents(newCid, members, pl)}
	}

	// Group chat: title is mandatory and at most 30 runes; creator becomes
	// role=2 owner through CreateConv.
	title := strings.TrimSpace(p.Title)
	if title == "" {
		return convResult{Op: convOpCreate, Error: "group title required"}
	}
	if utf8.RuneCountInString(title) > convMaxTitleRunes {
		return convResult{Op: convOpCreate, Error: "group title too long"}
	}
	seen := map[int64]bool{actor: true}
	targets := make([]int64, 0, len(p.Members))
	for _, m := range p.Members {
		uid := int64(m.UserID)
		if uid <= 0 || seen[uid] {
			continue
		}
		if _, err := d.checkedUser(ctx, uid); err != nil {
			return convResult{Op: convOpCreate, Error: err.Error()}
		}
		seen[uid] = true
		targets = append(targets, uid)
	}
	newCid, err := d.conv.CreateConv(ctx, &store.ConvMeta{
		CType: convTypeGroup, Title: title, CreatedBy: actor, CreatedAt: nowSec(),
	}, actor)
	if err != nil {
		return convResult{Op: convOpCreate, Error: err.Error()}
	}
	for _, uid := range targets {
		if err := d.conv.AddMember(ctx, &store.Member{
			Cid: newCid, UID: uid, Role: 0, JoinedAt: nowSec(),
		}); err != nil {
			return convResult{Op: convOpCreate, Error: err.Error()}
		}
		d.cache.InvalidateMember(cache.MemberKey{Cid: newCid, UID: uid})
	}
	pl, members, err := d.snapshot(ctx, newCid)
	if err != nil {
		return convResult{Op: convOpCreate, Error: err.Error()}
	}
	return convResult{Op: convOpCreate, OK: true, Cid: newCid, Payload: pl,
		Events: convEvents(newCid, members, pl)}
}

func (d *convDomain) addMember(ctx context.Context, actor int64, cid uint64, body []byte) convResult {
	var p wire.MemberOp
	if err := wire.Unmarshal(body, &p); err != nil {
		return convResult{Op: convOpAddMember, Error: "bad payload"}
	}
	if cid == 0 {
		cid = p.ConvID
	}
	if _, err := d.conv.GetConvMeta(ctx, int64(cid)); err != nil {
		return convResult{Op: convOpAddMember, Error: err.Error()}
	}
	actorMember, err := d.conv.CheckMember(ctx, int64(cid), actor)
	if err != nil || actorMember.Role < 1 {
		return convResult{Op: convOpAddMember, Error: "forbidden: requires admin or owner"}
	}
	role := int(p.Role)
	if role < 0 || role > int(actorMember.Role) {
		role = 0
	}
	for _, rawUID := range p.UserIDs {
		uid := int64(rawUID)
		if _, err := d.checkedUser(ctx, uid); err != nil {
			return convResult{Op: convOpAddMember, Error: err.Error()}
		}
		if err := d.conv.AddMember(ctx, &store.Member{
			Cid: int64(cid), UID: uid, Role: role, JoinedAt: nowSec(),
		}); err != nil {
			return convResult{Op: convOpAddMember, Error: err.Error()}
		}
		d.cache.InvalidateMember(cache.MemberKey{Cid: int64(cid), UID: uid})
	}
	pl, members, err := d.snapshot(ctx, int64(cid))
	if err != nil {
		return convResult{Op: convOpAddMember, Error: err.Error()}
	}
	return convResult{Op: convOpAddMember, OK: true, Cid: int64(cid), Payload: pl,
		Events: convEvents(int64(cid), members, pl)}
}

func (d *convDomain) removeMember(ctx context.Context, actor int64, cid uint64, body []byte) convResult {
	var p wire.MemberOp
	if err := wire.Unmarshal(body, &p); err != nil {
		return convResult{Op: convOpRemoveMember, Error: "bad payload"}
	}
	if cid == 0 {
		cid = p.ConvID
	}
	if _, err := d.conv.GetConvMeta(ctx, int64(cid)); err != nil {
		return convResult{Op: convOpRemoveMember, Error: err.Error()}
	}
	actorMember, err := d.conv.CheckMember(ctx, int64(cid), actor)
	if err != nil || actorMember.Role < 1 {
		return convResult{Op: convOpRemoveMember, Error: "forbidden: requires admin or owner"}
	}
	for _, rawUID := range p.UserIDs {
		uid := int64(rawUID)
		if _, err := d.checkedUser(ctx, uid); err != nil {
			return convResult{Op: convOpRemoveMember, Error: err.Error()}
		}
		if err := d.conv.RemoveMember(ctx, int64(cid), uid); err != nil {
			return convResult{Op: convOpRemoveMember, Error: err.Error()}
		}
		d.cache.InvalidateMember(cache.MemberKey{Cid: int64(cid), UID: uid})
	}
	pl, members, err := d.snapshot(ctx, int64(cid))
	if err != nil {
		return convResult{Op: convOpRemoveMember, Error: err.Error()}
	}
	return convResult{Op: convOpRemoveMember, OK: true, Cid: int64(cid), Payload: pl,
		Events: convEvents(int64(cid), members, pl)}
}

func (d *convDomain) setRole(ctx context.Context, actor int64, cid uint64, body []byte) convResult {
	var p wire.MemberOp
	if err := wire.Unmarshal(body, &p); err != nil {
		return convResult{Op: convOpSetRole, Error: "bad payload"}
	}
	if cid == 0 {
		cid = p.ConvID
	}
	actorMember, err := d.conv.CheckMember(ctx, int64(cid), actor)
	if err != nil || actorMember.Role < 1 {
		return convResult{Op: convOpSetRole, Error: "forbidden: requires admin or owner"}
	}
	if int(p.Role) > int(actorMember.Role) {
		return convResult{Op: convOpSetRole, Error: "forbidden: cannot grant a role above own"}
	}
	for _, rawUID := range p.UserIDs {
		if err := d.conv.SetMemberRole(ctx, int64(cid), int64(rawUID), int(p.Role)); err != nil {
			return convResult{Op: convOpSetRole, Error: err.Error()}
		}
		d.cache.InvalidateMember(cache.MemberKey{Cid: int64(cid), UID: int64(rawUID)})
	}
	return convResult{Op: convOpSetRole, OK: true, Cid: int64(cid)}
}

func (d *convDomain) getMeta(ctx context.Context, actor int64, cid uint64) convResult {
	if _, err := d.conv.CheckMember(ctx, int64(cid), actor); err != nil {
		return convResult{Op: convOpGetMeta, Error: "forbidden: not a member"}
	}
	meta, err := d.conv.GetConvMeta(ctx, int64(cid))
	if err != nil {
		return convResult{Op: convOpGetMeta, Error: err.Error()}
	}
	pl, _ := wire.Marshal(wire.ConvPayload{
		ConvID: uint64(meta.Cid), Title: meta.Title, ConvType: uint32(meta.CType),
		CreatedAt: meta.CreatedAt,
	})
	return convResult{Op: convOpGetMeta, OK: true, Cid: int64(cid), Payload: pl}
}

func (d *convDomain) listMembers(ctx context.Context, actor int64, cid uint64) convResult {
	if _, err := d.conv.CheckMember(ctx, int64(cid), actor); err != nil {
		return convResult{Op: convOpListMembers, Error: "forbidden: not a member"}
	}
	meta, err := d.conv.GetConvMeta(ctx, int64(cid))
	if err != nil {
		return convResult{Op: convOpListMembers, Error: err.Error()}
	}
	ms, err := d.conv.ListMembers(ctx, int64(cid))
	if err != nil {
		return convResult{Op: convOpListMembers, Error: err.Error()}
	}
	out := wire.ConvPayload{ConvID: cid, Title: meta.Title, ConvType: uint32(meta.CType), CreatedAt: meta.CreatedAt}
	for _, m := range ms {
		out.Members = append(out.Members, wire.Member{
			UserID: uint64(m.UID), Role: uint32(m.Role), JoinedAt: m.JoinedAt, MutedUntil: m.MutedUntil,
		})
	}
	pl, _ := wire.Marshal(out)
	return convResult{Op: convOpListMembers, OK: true, Cid: int64(cid), Payload: pl}
}

// snapshot returns the full ConvPayload and current member rows for cid.
func (d *convDomain) snapshot(ctx context.Context, cid int64) ([]byte, []store.Member, error) {
	meta, err := d.conv.GetConvMeta(ctx, cid)
	if err != nil {
		return nil, nil, err
	}
	ms, err := d.conv.ListMembers(ctx, cid)
	if err != nil {
		return nil, nil, err
	}
	out := wire.ConvPayload{
		ConvID: uint64(meta.Cid), Title: meta.Title, ConvType: uint32(meta.CType), CreatedAt: meta.CreatedAt,
	}
	for _, m := range ms {
		out.Members = append(out.Members, wire.Member{
			UserID: uint64(m.UID), Role: uint32(m.Role), JoinedAt: m.JoinedAt, MutedUntil: m.MutedUntil,
		})
	}
	pl, err := wire.Marshal(out)
	return pl, ms, err
}

func convEvents(cid int64, members []store.Member, payload []byte) []convEvent {
	evs := make([]convEvent, 0, len(members))
	for _, m := range members {
		evs = append(evs, convEvent{
			Kind: uint32(kinds.KindConvPayload), UserID: uint64(m.UID), ConvID: uint64(cid), Payload: payload,
		})
	}
	return evs
}

// checkedUser rejects missing/inactive/banned target users. It is called for
// every member a client asks to add — the client is never trusted.
func (d *convDomain) checkedUser(ctx context.Context, uid int64) (*store.User, error) {
	if uid <= 0 {
		return nil, fmt.Errorf("invalid user id")
	}
	u, err := d.id.GetUser(ctx, uid)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("user %d not found", uid)
		}
		return nil, err
	}
	if u == nil {
		return nil, fmt.Errorf("user %d not found", uid)
	}
	if u.Status != 0 {
		return nil, fmt.Errorf("user %d is not active", uid)
	}
	ban, err := d.id.GetBan(ctx, uid)
	if err != nil {
		return nil, err
	}
	if ban != nil && ban.Level > 0 {
		return nil, fmt.Errorf("user %d is banned", uid)
	}
	return u, nil
}

// ops for the 970 FLAG lane.
const (
	flagOpGet = 0
	flagOpSet = 1
)

// sysDomain serves kinds 970/971 (flag get/set) and 400-adjacent presence ops
// that arrive on the data lane, plus rate-limit/penalty primitives used by
// callers that enforce policy (thresholds live in policy, never here).
type sysDomain struct {
	sys store.SysStore
}

func (d *sysDomain) handleFlag(ctx context.Context, req wire.FlagRequest) (wire.FlagResult, error) {
	if req.Write {
		if err := d.sys.UpsertFlag(ctx, &store.Flag{Key: req.Key, Value: req.Value}); err != nil {
			return wire.FlagResult{RequestID: req.RequestID}, err
		}
	}
	flags, err := d.sys.AllFlags(ctx)
	if err != nil {
		return wire.FlagResult{RequestID: req.RequestID}, err
	}
	m := map[string]string{}
	for _, f := range flags {
		m[f.Key] = f.Value
	}
	return wire.FlagResult{Flags: m, RequestID: req.RequestID}, nil
}

var _ = kinds.KindFlagSet
