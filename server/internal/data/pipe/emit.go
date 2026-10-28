package pipe

import (
	"context"
)

// emit.go: test-shell injection of Req frames with full routing fields.
// The production FrameSource reads chatpb fields; tests use these helpers to
// feed the dispatcher directly (bypassing the shell-only default source).

// dispatchReq feeds one Req straight to the dispatcher (test seam; the
// production path goes through Run/FrameSource).
func (p *Pipe) dispatchReq(ctx context.Context, r Req) { p.dispatch(ctx, r) }
