package pipe

import (
	"context"

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

// convDomain serves kind 930 (CONV_DATA_REQUEST) → 931 (CONV_DATA_RESULT).
// Authorization: callers prove actor authority upstream (admin chain / domain
// role logic); the store itself never does role enforcement (api.go red line).
// The membership CACHE is explicitly invalidated on every mutation — that is
// this layer's job, not the cache's (cache 是原语，写路径显式失效).
type convDomain struct {
	conv  store.ConvStore
	cache *cache.Cache
}

type convResult struct {
	Op     uint32
	OK     bool
	Error  string
	Cid    int64
	Payload []byte
}

func (d *convDomain) handle(ctx context.Context, senderUID int64, op uint32, cid uint64, body []byte) convResult {
	switch op {
	case convOpCreate:
		var p wire.ConvPayload
		if err := wire.Unmarshal(body, &p); err != nil {
			return convResult{Op: op, Error: "bad payload"}
		}
		meta := &store.ConvMeta{
			CType: int(p.ConvType), Title: p.Title, CreatedBy: senderUID, CreatedAt: nowSec(),
		}
		newCid, err := d.conv.CreateConv(ctx, meta, senderUID)
		if err != nil {
			return convResult{Op: op, Error: err.Error()}
		}
		return convResult{Op: op, OK: true, Cid: newCid}

	case convOpAddMember:
		var p wire.MemberOp
		if err := wire.Unmarshal(body, &p); err != nil {
			return convResult{Op: op, Error: "bad payload"}
		}
		for _, uid := range p.UserIDs {
			m := &store.Member{Cid: int64(cid), UID: int64(uid), Role: int(p.Role), JoinedAt: nowSec()}
			if err := d.conv.AddMember(ctx, m); err != nil {
				return convResult{Op: op, Error: err.Error()}
			}
			d.cache.InvalidateMember(cache.MemberKey{Cid: int64(cid), UID: int64(uid)})
		}
		return convResult{Op: op, OK: true, Cid: int64(cid)}

	case convOpRemoveMember:
		var p wire.MemberOp
		if err := wire.Unmarshal(body, &p); err != nil {
			return convResult{Op: op, Error: "bad payload"}
		}
		for _, uid := range p.UserIDs {
			if err := d.conv.RemoveMember(ctx, int64(cid), int64(uid)); err != nil {
				return convResult{Op: op, Error: err.Error()}
			}
			d.cache.InvalidateMember(cache.MemberKey{Cid: int64(cid), UID: int64(uid)})
		}
		return convResult{Op: op, OK: true, Cid: int64(cid)}

	case convOpSetRole:
		var p wire.MemberOp
		if err := wire.Unmarshal(body, &p); err != nil {
			return convResult{Op: op, Error: "bad payload"}
		}
		for _, uid := range p.UserIDs {
			if err := d.conv.SetMemberRole(ctx, int64(cid), int64(uid), int(p.Role)); err != nil {
				return convResult{Op: op, Error: err.Error()}
			}
			d.cache.InvalidateMember(cache.MemberKey{Cid: int64(cid), UID: int64(uid)})
		}
		return convResult{Op: op, OK: true, Cid: int64(cid)}

	case convOpGetMeta:
		meta, err := d.conv.GetConvMeta(ctx, int64(cid))
		if err != nil {
			return convResult{Op: op, Error: err.Error()}
		}
		pl, _ := wire.Marshal(wire.ConvPayload{
			ConvID: uint64(meta.Cid), Title: meta.Title, ConvType: uint32(meta.CType),
			CreatedAt: meta.CreatedAt,
		})
		return convResult{Op: op, OK: true, Cid: int64(cid), Payload: pl}

	case convOpListMembers:
		ms, err := d.conv.ListMembers(ctx, int64(cid))
		if err != nil {
			return convResult{Op: op, Error: err.Error()}
		}
		var out wire.ConvPayload
		out.ConvID = cid
		for _, m := range ms {
			out.Members = append(out.Members, wire.Member{
				UserID: uint64(m.UID), Role: uint32(m.Role), JoinedAt: m.JoinedAt, MutedUntil: m.MutedUntil,
			})
		}
		pl, _ := wire.Marshal(out)
		return convResult{Op: op, OK: true, Cid: int64(cid), Payload: pl}
	}
	return convResult{Op: op, Error: "unknown op"}
}

// ops for the 940 IDENTITY lane.
const (
	idOpUpsertUser = 1
	idOpGetUser    = 2
	idOpGetBan     = 3
	idOpSetBan     = 4
)

// identityDomain serves kind 940 → 941.
type identityDomain struct {
	id    store.IdentityStore
	cache *cache.Cache
}

type idResult struct {
	Op      uint32
	OK      bool
	Error   string
	Payload []byte
}

func (d *identityDomain) handle(ctx context.Context, op uint32, uid uint64, body []byte) idResult {
	switch op {
	case idOpUpsertUser:
		var u store.User
		if err := wire.Unmarshal(body, &u); err != nil {
			return idResult{Op: op, Error: "bad payload"}
		}
		if err := d.id.UpsertUser(ctx, &u); err != nil {
			return idResult{Op: op, Error: err.Error()}
		}
		d.cache.InvalidateUser(cache.UserKey(uid))
		return idResult{Op: op, OK: true}

	case idOpGetUser:
		u, err := d.id.GetUser(ctx, int64(uid))
		if err != nil {
			return idResult{Op: op, Error: err.Error()}
		}
		pl, _ := wire.Marshal(u)
		return idResult{Op: op, OK: true, Payload: pl}

	case idOpGetBan:
		b, err := d.id.GetBan(ctx, int64(uid))
		if err != nil {
			return idResult{Op: op, Error: err.Error()}
		}
		var pl []byte
		if b != nil {
			pl, _ = wire.Marshal(b)
		}
		return idResult{Op: op, OK: true, Payload: pl}

	case idOpSetBan:
		var b store.Ban
		if err := wire.Unmarshal(body, &b); err != nil {
			return idResult{Op: op, Error: "bad payload"}
		}
		b.UID = int64(uid)
		if err := d.id.SetBan(ctx, &b); err != nil {
			return idResult{Op: op, Error: err.Error()}
		}
		// ban affects identity/profile cache lineage
		d.cache.InvalidateUser(cache.UserKey(uid))
		return idResult{Op: op, OK: true}
	}
	return idResult{Op: op, Error: "unknown op"}
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
