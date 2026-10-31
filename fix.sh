#!/bin/sh
# Idempotent reconciler for the known inconsistent files in data pipe.
set -e
D=server/internal/data/pipe

# --- policy: ensure hard-limit const present (with comment) ---
if ! grep -q 'MaxGroupMembersHardLimit = ' server/internal/data/policy/types.go; then
  cat >> server/internal/data/policy/types.go <<'EOF'

// MaxGroupMembersHardLimit is the absolute ceiling a policy may set for
// group.max_members. The full CONV_PAYLOAD snapshot costs ~60 bytes per member
// and the WS frame codec caps a frame at 64KB, so anything above ~1090 members
// cannot be delivered in one frame; 1000 keeps a safety margin.
const MaxGroupMembersHardLimit = 1000
EOF
fi

# --- conv.go: ensure memberLimit + invalidateMembers helpers exist ---
if ! grep -q 'func (d \*convDomain) memberLimit() int' $D/conv.go; then
  cat >> $D/conv.go <<'EOF'

// memberLimit returns the group member ceiling (0 = the default).
func (d *convDomain) memberLimit() int {
	if d.maxMembers > 0 {
		return d.maxMembers
	}
	return policy.Default().Group.MaxMembers
}
EOF
fi
if ! grep -q 'func (d \*convDomain) invalidateMembers(cid int64)' $D/conv.go; then
  cat >> $D/conv.go <<'EOF'

// invalidateMembers drops the cached member-list (and peer-set) views for cid
// after a membership mutation so the fan-out recipient set is rebuilt.
func (d *convDomain) invalidateMembers(cid int64) {
	if d.members != nil {
		d.members.InvalidateConv(cid)
		return
	}
	d.cache.InvalidateMemberList(cid)
}
EOF
fi
# ensure policy import present (memberLimit uses it)
if ! grep -q '"github.com/yingo-server/OpenChat/server/internal/data/policy"' $D/conv.go; then
  sed -i 's#"github.com/yingo-server/OpenChat/server/internal/data/cache"#"github.com/yingo-server/OpenChat/server/internal/data/cache"\n\t"github.com/yingo-server/OpenChat/server/internal/data/policy"#' $D/conv.go
fi

# --- fanout.go: bucket unmerged field ---
if ! grep -q 'unmerged \[\]fanoutJob' $D/fanout.go; then
  sed -i '/^\torder \[\]uint64$/a\	// unmerged holds noMerge jobs: each is broadcast individually,\n\t// never collapsed into the per-user window.\n\tunmerged []fanoutJob' $D/fanout.go
fi
# --- fanout.go: drop stray single-arg broadcastLoop call in start() ---
sed -i '/go f\.broadcastLoop(ctx)$/d' $D/fanout.go
# --- fanout.go: emit cid int64 -> uint64 ---
sed -i 's/f\.emit(job\.kind, job\.cid, uint64(m\.UID), job\.payload)/f.emit(job.kind, uint64(job.cid), uint64(m.UID), job.payload)/' $D/fanout.go

echo "=== gofmt ==="
gofmt -w $D/conv.go $D/fanout.go server/internal/data/policy/types.go 2>&1 || true
echo "=== build ==="
go build ./... 2>&1 | head -40
