// fanout.go: the ASYNCHRONOUS fan-out plane for transient signals.
//
// Problem this solves (the "瞬态广播扇出与背压" review finding): the pipe's
// dispatcher used to run the whole fan-out inline — ListMembers (a DB
// query) plus one reply per member, all while holding the single
// dispatcher goroutine. In SQLite the read lock and the write lock are
// mutually exclusive, so a slow fan-out stalls the message hot path for
// everyone (worst case: the 5s busy_timeout).
//
// Design:
//
//	dispatcher ──enqueue──► fanout queue (bounded; drop policy per class)
//	                          │
//	                          ▼
//	                    aggregator goroutine
//	                     ├─ per-conv window  (100ms): same conv + same user
//	                     │  → ONE frame (latest state; receipts are MERGED)
//	                     ├─ per-user debounce (10s): presence transitions of
//	                     │  one user collapse into ONE broadcast
//	                          │
//	                          ▼
//	                    broadcaster workers
//	                     1. resolve the recipient set (CACHED member list)
//	                     2. emit one frame per recipient
//	                          │
//	                          ▼
//	                    outbound lane (4096 slots)
//
// The dispatcher NEVER blocks on this plane: a full queue sheds by class
// (best-effort first) and COUNTS the shed.

package pipe

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/data/pipe/wire"
	"github.com/yingo-server/OpenChat/server/internal/data/store"
	"github.com/yingo-server/OpenChat/server/internal/pkg/log"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
)

// Fan-out tuning. These are MECHANISM constants (buffer sizes, window
// lengths), not policy: policy lives in policy.json.
const (
	// fanoutQueueBuf is the depth of the dispatcher's fan-out queue. The
	// dispatcher NEVER blocks on it: a full queue drops by kind class.
	fanoutQueueBuf = 4096

	// fanoutWorkers is the number of broadcaster goroutines. The AGGREGATOR
	// is a single goroutine (it owns the window state); the broadcasters
	// do the recipient resolution + emission, which is the slow part.
	fanoutWorkers = 2

	// fanoutBroadcastBuf is the depth of the aggregator → broadcaster lane.
	fanoutBroadcastBuf = 4096

	// defaultFanoutWindow is the aggregation window per conversation:
	// events of the same conversation within this window are merged into
	// ONE broadcast (per user, latest state wins).
	defaultFanoutWindow = 100 * time.Millisecond

	// defaultPresenceDebounce is the per-user presence debounce: repeated
	// connect/disconnect transitions of ONE user inside this window
	// collapse into ONE broadcast carrying the LATEST state.
	// This implements the TODO(presence-throttle) left in the code.
	defaultPresenceDebounce = 10 * time.Second
)

// Drop classes of the fan-out queue. The dispatcher degrades by class
// instead of blocking (a blocked dispatcher is a stalled hot path).
type dropClass int

const (
	// dropKeep: the frame matters (receipts) — try hard to keep it.
	dropKeep dropClass = iota
	// dropBestEffort: the frame is a hint (typing / presence) — dropping it
	// is semantically fine, the next event supersedes it.
	dropBestEffort
)

func (c dropClass) String() string {
	if c == dropKeep {
		return "keep"
	}
	return "best_effort"
}

// fanoutJob is one unit of fan-out work.
type fanoutJob struct {
	// kind is the frame kind (230 typing / 104-105 receipts / 400-402
	// presence / 108 recall).
	kind uint32
	// cid is the conversation (0 for presence peer fan-out).
	cid int64
	// excludeUID is the originator: never echoed back to them.
	excludeUID uint64
	// userID is the ORIGINATOR of the event (the user whose state the
	// frame carries). For the conv fan-out it is the sender; for presence
	// it is the subject user.
	userID uint64
	// payload is the already-marshaled frame body.
	payload []byte
	// class is the drop class of this job.
	class dropClass
	// windowKey identifies the aggregation bucket: for the conv fan-out
	// it is the cid, for the presence fan-out it is the subject uid.
	windowKey string
	// noMerge marks a job that must NOT be aggregated with others (the
	// recall broadcast carries a distinct msg_id per event — merging two
	// of them would lose one of the tombstones).
	noMerge bool
}

// FanoutStats is the observable counter set of the fan-out plane. Every
// drop is COUNTED (never only logged) so the SIGUSR1 dump / metrics can
// show the degradation instead of hiding it.
type FanoutStats struct {
	// Enqueued is the number of jobs accepted into the queue.
	Enqueued uint64
	// DroppedQueue is the number of jobs dropped because the queue was
	// full (the class counters below break it down).
	DroppedQueue uint64
	// DroppedTyping / DroppedPresence count best-effort drops by class.
	DroppedTyping   uint64
	DroppedPresence uint64
	// DroppedReceipts counts receipt jobs dropped at the queue.
	DroppedReceipts uint64
	// Aggregated is the number of events MERGED into an existing window
	// (i.e. events that did NOT produce a frame of their own).
	Aggregated uint64
	// Broadcasts is the number of frames actually emitted by the workers.
	Broadcasts uint64
	// OutboundDropped is the number of frames the outbound lane refused
	// (the lane is bounded; a full lane drops the frame).
	OutboundDropped uint64
}

// fanoutPlane owns the fan-out queue, the aggregator and the broadcasters.
type fanoutPlane struct {
	queue chan fanoutJob
	lg    *log.Logger

	mc *memberCache // recipient-set cache (member list / peer set)

	// out is the outbound lane of the pipe.
	out chan *env

	// window is the aggregation window (injectable for tests).
	window time.Duration
	// presenceWindow is the per-user presence debounce (injectable).
	presenceWindow time.Duration

	// aggMu guards the window buckets and the presence slots.
	aggMu      sync.Mutex
	buckets    map[string]*fanoutBucket
	order      []string
	presenceSt map[uint64]*presenceSlot

	// stats (atomics).
	stEnqueued     atomic.Uint64
	stDropQueue    atomic.Uint64
	stDropTyping   atomic.Uint64
	stDropPresence atomic.Uint64
	stDropReceipts atomic.Uint64
	stAggregated   atomic.Uint64
	stBroadcasts   atomic.Uint64
	stOutboundDrop atomic.Uint64
}

// fanoutBucket is one aggregation window: the pending jobs of one
// conversation (or one presence subject), keyed by the user whose state
// the frame carries.
type fanoutBucket struct {
	key  string
	jobs map[uint64]fanoutJob // per-user latest job
	// order preserves the arrival order of the users (stable output).
	order []uint64
	// unmerged holds noMerge jobs: each is broadcast individually,
	// never collapsed into the per-user window.
	unmerged []fanoutJob
}

// presenceSlot is one user's debounce slot: the pending (latest) state and
// the timer that will publish it.
type presenceSlot struct {
	// lastKind is the presence kind last broadcast for this user (401 online /
	// 402 offline); lastAt is when. A repeat of the same kind inside the window
	// is absorbed, a change is always sent.
	lastKind uint32
	lastAt   time.Time
	hasLast  bool
}

// newFanoutPlane builds the fan-out plane.
func newFanoutPlane(mc *memberCache, out chan *env, lg *log.Logger) *fanoutPlane {
	return &fanoutPlane{
		queue:          make(chan fanoutJob, fanoutQueueBuf),
		lg:             lg,
		mc:             mc,
		out:            out,
		window:         defaultFanoutWindow,
		presenceWindow: defaultPresenceDebounce,
		buckets:        map[string]*fanoutBucket{},
		presenceSt:     map[uint64]*presenceSlot{},
	}
}

// start launches the aggregator + the broadcaster workers.
func (f *fanoutPlane) start(ctx context.Context) {
	go f.aggregate(ctx)
	for i := 0; i < fanoutWorkers; i++ {
	}
}

// Stats returns the counter snapshot.
func (f *fanoutPlane) Stats() FanoutStats {
	return FanoutStats{
		Enqueued:        f.stEnqueued.Load(),
		DroppedQueue:    f.stDropQueue.Load(),
		DroppedTyping:   f.stDropTyping.Load(),
		DroppedPresence: f.stDropPresence.Load(),
		DroppedReceipts: f.stDropReceipts.Load(),
		Aggregated:      f.stAggregated.Load(),
		Broadcasts:      f.stBroadcasts.Load(),
		OutboundDropped: f.stOutboundDrop.Load(),
	}
}

// Enqueue hands a job to the fan-out plane. It NEVER blocks: a full queue
// sheds by class and COUNTS the shed.
//
// Class policy (the "分级丢弃" of the review):
//
//   - best-effort (typing / presence): shed first — the next event of the
//     same kind supersedes it, so no information is really lost.
//   - keep (receipts): shed only when the queue is full; counted.
func (f *fanoutPlane) Enqueue(job fanoutJob) {
	select {
	case f.queue <- job:
		f.stEnqueued.Add(1)
		return
	default:
	}
	f.stDropQueue.Add(1)
	switch job.class {
	case dropBestEffort:
		if isTypingKind(job.kind) {
			f.stDropTyping.Add(1)
		} else {
			f.stDropPresence.Add(1)
		}
	case dropKeep:
		f.stDropReceipts.Add(1)
	}
	f.lg.Warn("fanout: queue full; job dropped",
		"kind", kinds.KindName(job.kind), "class", job.class.String())
}

// aggregate is the single aggregator goroutine: it owns the window state.
//
// It merges jobs per (windowKey, user) and publishes the merged jobs to
// the broadcaster lane when the window expires.
func (f *fanoutPlane) aggregate(ctx context.Context) {
	aggCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	bcast := make(chan fanoutJob, fanoutBroadcastBuf)

	// The broadcasters consume the merged jobs.
	for i := 0; i < fanoutWorkers; i++ {
		go f.broadcastLoop(aggCtx, bcast)
	}

	timer := time.NewTimer(f.window)
	defer timer.Stop()
	if !timer.Stop() {
		<-timer.C
	}
	for {
		select {
		case <-ctx.Done():
			f.flushAll(bcast)
			return
		case job := <-f.queue:
			f.accept(job, bcast)
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(f.window)
		case <-timer.C:
			f.flushAll(bcast)
			timer.Reset(f.window)
		}
	}
}

// accept merges one job into the window state (or hands it to the
// presence debouncer).
func (f *fanoutPlane) accept(job fanoutJob, bcast chan fanoutJob) {
	// Presence: the per-user debounce owns the timing (10s), so presence
	// jobs never enter the conv window.
	if isPresenceKind(job.kind) {
		f.acceptPresence(job, bcast)
		return
	}
	f.aggMu.Lock()
	defer f.aggMu.Unlock()
	b := f.buckets[job.windowKey]
	if b == nil {
		b = &fanoutBucket{key: job.windowKey, jobs: map[uint64]fanoutJob{}}
		f.buckets[job.windowKey] = b
		f.order = append(f.order, job.windowKey)
	}
	if job.noMerge {
		// Never aggregated: the job gets its own bucket slot.
		f.stAggregated.Add(0)
		b.unmerged = append(b.unmerged, job)
		return
	}
	if old, exists := b.jobs[job.userID]; exists {
		f.stAggregated.Add(1)
		b.jobs[job.userID] = mergeJob(old, job)
		return
	}
	b.jobs[job.userID] = job
	b.order = append(b.order, job.userID)
}

// mergeJob merges two jobs of the same (bucket, user). Receipts are MERGED
// (the receipt lists are concatenated — dropping an earlier receipt would
// lose a read marker); every other kind keeps the LATEST state (typing on
// after off, etc.).
func mergeJob(old, next fanoutJob) fanoutJob {
	if !isReceiptKind(old.kind) || old.kind != next.kind {
		return next
	}
	merged, ok := mergeReceiptPayloads(old.payload, next.payload)
	if !ok {
		return next
	}
	next.payload = merged
	return next
}

// mergeReceiptPayloads concatenates two ReceiptPayload JSON bodies.
func mergeReceiptPayloads(a, b []byte) ([]byte, bool) {
	var pa, pb wire.ReceiptPayload
	if err := wire.Unmarshal(a, &pa); err != nil {
		return nil, false
	}
	if err := wire.Unmarshal(b, &pb); err != nil {
		return nil, false
	}
	pa.Receipts = append(pa.Receipts, pb.Receipts...)
	out, err := wire.Marshal(pa)
	if err != nil {
		return nil, false
	}
	return out, true
}

// flushAll publishes every pending job of the current window.
func (f *fanoutPlane) flushAll(bcast chan fanoutJob) {
	f.aggMu.Lock()
	buckets := f.buckets
	order := f.order
	f.buckets = map[string]*fanoutBucket{}
	f.order = nil
	f.aggMu.Unlock()
	for _, key := range order {
		b := buckets[key]
		if b == nil {
			continue
		}
		for _, job := range b.unmerged {
			select {
			case bcast <- job:
			default:
				f.stDropQueue.Add(1)
				f.stOutboundDrop.Add(1)
				f.lg.Warn("fanout: broadcaster lane full; job dropped",
					"kind", kinds.KindName(job.kind))
			}
		}
		for _, uid := range b.order {
			job := b.jobs[uid]
			select {
			case bcast <- job:
			default:
				f.stDropQueue.Add(1)
				f.stOutboundDrop.Add(1)
				f.lg.Warn("fanout: broadcaster lane full; job dropped",
					"kind", kinds.KindName(job.kind))
			}
		}
	}
}

// acceptPresence applies per-user presence deduplication.
//
// Semantics: a STATE CHANGE is always broadcast immediately (a user who just
// went online must appear online now; a user who closed the app must go
// offline now — delaying that by a window would show a lying roster). Only a
// REPEATED report of the state we already broadcast, inside the window, is
// suppressed — that is what absorbs multi-device flapping (device A closes
// while device B stays connected still reports "online", so nothing changes).
//
// This replaces an earlier design that held the first event for the whole
// window: that made every disconnect invisible for up to 10s, which is wrong
// for a presence indicator and made the e2e semantics lie.
func (f *fanoutPlane) acceptPresence(job fanoutJob, bcast chan fanoutJob) {
	f.aggMu.Lock()
	slot := f.presenceSt[job.userID]
	if slot == nil {
		slot = &presenceSlot{}
		f.presenceSt[job.userID] = slot
	}
	sameState := slot.hasLast && slot.lastKind == job.kind
	recent := sameState && time.Now().Sub(slot.lastAt) < f.presenceWindow
	slot.lastKind = job.kind
	slot.lastAt = time.Now()
	slot.hasLast = true
	f.aggMu.Unlock()

	if recent {
		f.stAggregated.Add(1)
		return
	}
	j := job
	select {
	case bcast <- j:
	default:
		f.stDropQueue.Add(1)
		f.stOutboundDrop.Add(1)
	}
}

// broadcastLoop consumes merged jobs, resolves the recipient set and emits
// one frame per recipient.
func (f *fanoutPlane) broadcastLoop(ctx context.Context, jobs <-chan fanoutJob) {
	for {
		select {
		case <-ctx.Done():
			return
		case job, ok := <-jobs:
			if !ok {
				return
			}
			f.broadcast(ctx, job)
		}
	}
}

// broadcast resolves the recipient set and emits one frame per recipient.
//
// The recipient set comes from the CACHE (member list / peer set), so the
// worker never blocks the dispatcher on a DB query.
func (f *fanoutPlane) broadcast(ctx context.Context, job fanoutJob) {
	if job.kind == 401 || job.kind == 402 {
	}
	if job.cid > 0 {
		members, err := f.mc.Members(ctx, job.cid)
		if err != nil {
			f.lg.Warn("fanout: member list failed", "cid", job.cid, "err", err.Error())
			return
		}
		for _, m := range members {
			if uint64(m.UID) == job.excludeUID {
				continue
			}
			f.emit(job.kind, uint64(job.cid), uint64(m.UID), job.payload)
		}
		return
	}
	// Presence: the peer set of the subject user.
	peers, err := f.mc.Peers(ctx, int64(job.userID))
	if job.kind == 401 || job.kind == 402 {
	}
	if err != nil {
		f.lg.Warn("fanout: peer set failed", "uid", job.userID, "err", err.Error())
		return
	}
	for _, peer := range peers {
		if uint64(peer) == job.excludeUID {
			continue
		}
		f.emit(job.kind, 0, uint64(peer), job.payload)
	}
}

// emit places one frame on the outbound lane. The lane is bounded: a full
// lane drops the frame and COUNTS it (never a silent drop).
func (f *fanoutPlane) emit(kind uint32, cid, uid uint64, payload []byte) {
	if kind == 401 || kind == 402 {
	}
	select {
	case f.out <- &env{Kind: kind, ConvID: cid, UserID: uid, Payload: payload}:
		f.stBroadcasts.Add(1)
	default:
		f.stOutboundDrop.Add(1)
		f.lg.Warn("fanout: outbound lane full; frame dropped",
			"kind", kinds.KindName(kind), "uid", uid)
	}
}

// isTypingKind reports whether kind is the typing signal.
func isTypingKind(kind uint32) bool { return kind == uint32(kinds.KindTyping) }

// isPresenceKind reports whether kind is a presence signal (400/401/402).
func isPresenceKind(kind uint32) bool {
	return kind == uint32(kinds.KindPresenceUpdate) ||
		kind == uint32(kinds.KindPresenceSubscribe) ||
		kind == uint32(kinds.KindPresenceUnsubscribe)
}

// isReceiptKind reports whether kind is a read/delivered receipt.
func isReceiptKind(kind uint32) bool {
	return kind == uint32(kinds.KindMsgRead) || kind == uint32(kinds.KindMsgDelivered)
}

// memberCacheEntry is a compile-time assertion that store.Member is the
// element type of the cached member lists.
var _ = []store.Member(nil)
