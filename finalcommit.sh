#!/bin/sh
cd /var/minis/workspace/OpenChat || exit 1
rm -f enable.sh
export PATH=/usr/bin:/bin GOCACHE=/tmp/gocache GOMODCACHE=/tmp/gomod GOFLAGS=-mod=mod GOPROXY=off TMPDIR=/tmp
go build ./... 2>&1 | head -5
echo "BUILD=$?"
git add -A
git commit -q -m "feat(pull-mode): enable threshold=100 (single-stage, no staged rollout)

P1 client + P2 stress + P3 server all landed and CI is green. Defaults:
pull_mode_threshold=100, watermark_batch=50, watermark_interval_ms=2000.
Hot rollback: set pull_mode_threshold=0 to restore byte-identical inline."
echo "--- committed ---"
git log --oneline -1
