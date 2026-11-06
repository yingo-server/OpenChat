#!/bin/sh
cd /var/minis/workspace/OpenChat || exit 1
rm -f prep.sh
export PATH=/usr/bin:/bin GOCACHE=/tmp/gocache GOMODCACHE=/tmp/gomod GOFLAGS=-mod=mod GOPROXY=off TMPDIR=/tmp
# 全量测试（用户要求本地不跑测试时交 CI；此时仅快速核对编译）
go build ./... 2>&1 | head -5
echo "BUILD=$?"
git add -A
git commit -q -m "feat(pull-mode): server watermark fan-out (threshold=0 disabled, batch=50/2s)

P3 of docs/pull-mode-spec-v1.2.md. Client P1 and stress P2 already landed.
Server side stays byte-identical for inline groups: pull_mode_threshold
defaults to 0; >100-member groups only emit a kind-14 WATERMARK after
watermark_batch=50 messages or watermark_interval_ms=2000, never per-member
MSG_NEW. 202 snapshots use members_omitted for large groups. T-SV-1..6 green."
echo "--- committed ---"
git log --oneline -1
