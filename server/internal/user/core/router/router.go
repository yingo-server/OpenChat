// Package router 是 usergw 的收发调度器（docs/user-frontend-design.md §1.1 router）：
//
//	上行：acceptor 的 Envelope → limiter 判定 → 本地白名单 or Wrap 内部帧 → forwarder
//	下行：forwarder 的内部帧 → Unwrap → 按 conn_id / user_id 定位 → session 投递
//
// 明确不做：不编解码（codec 负责）、不碰读写缓冲（acceptor/session 负责）、
// 不计算限流（limiter 负责）。
package router

import (
	"context"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/pkg/featureflags"
	"github.com/yingo-server/OpenChat/server/internal/pkg/log"
	"github.com/yingo-server/OpenChat/server/internal/proto"
	"github.com/yingo-server/OpenChat/server/internal/proto/gen/chatpb"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
	"github.com/yingo-server/OpenChat/server/internal/user/core/policy"
	"github.com/yingo-server/OpenChat/server/internal/user/core/session"
	"github.com/yingo-server/OpenChat/server/internal/user/net/bridge"
	"github.com/yingo-server/OpenChat/server/internal/user/net/frame"
	"github.com/yingo-server/OpenChat/server/internal/user/net/limit"
	"github.com/yingo-server/OpenChat/server/internal/user/net/ws"
)

// Session 是 router 依赖的连接表只读视图（测试用 fake session 实现）。
type Session interface {
	Lookup(connID uint64) session.Conn
	GetByUser(uid int64) []session.Conn
	Broadcast(uid int64, b []byte) int
}

// Router 上行/下行调度器。零值不可用，用 New。
type Router struct {
	sess   Session
	lim    *limit.Limiter
	pol    *policy.Policy
	fwd    *bridge.Forwarder
	flags  *featureflags.Flags
	logger *log.Logger

	// Metrics 可选钩子（nil 安全）。
	OnDrop    func(kind uint32, verdict limit.Verdict)
	OnForward func(kind uint32)
	OnDeliver func(kind uint32, connID uint64)
	OnKick    func(uid int64, reason string)
}

// New 构造 router。
func New(sess Session, lim *limit.Limiter, pol *policy.Policy, fwd *bridge.Forwarder, flags *featureflags.Flags, logger *log.Logger) *Router {
	return &Router{sess: sess, lim: lim, pol: pol, fwd: fwd, flags: flags, logger: logger}
}

// UpEvent 是 router 的上行事件视图（acceptor 的 ws.FrameEvent 适配而来，
// 解耦测试与 net 层具体类型）。
type UpEvent struct {
	Conn   session.Conn
	Env    *chatpb.Envelope
	RecvAt time.Time
}

// RunUpstream 消费 acceptor 上行帧直到 ctx 取消。
func (r *Router) RunUpstream(ctx context.Context, upstream <-chan *ws.FrameEvent) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-upstream:
			if ev == nil {
				continue
			}
			r.HandleUpstream(&UpEvent{Conn: ev.Conn, Env: ev.Env, RecvAt: ev.RecvAt})
		}
	}
}

// RunDownstream 消费桥接下行帧直到 ctx 取消，并监听重连 Resync。
func (r *Router) RunDownstream(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case fr := <-r.fwd.Downstream:
			r.HandleDownstream(fr)
		case <-r.fwd.Resync:
			r.onResync()
		}
	}
}

// HandleUpstream 处理一帧上行（纯函数式过滤/变换，无阻塞）。
func (r *Router) HandleUpstream(ev *UpEvent) {
	if ev == nil || ev.Conn == nil || ev.Env == nil {
		return
	}
	env := ev.Env
	kind := env.Kind
	bucketKind := kind
	if env.Flags&limit.PriorityFlag != 0 {
		bucketKind = limit.KindPriority
	}
	verdict := r.lim.Allow(ev.Conn.ID(), ev.Conn.UserID(), bucketKind, len(env.Payload))
	switch verdict {
	case limit.Drop:
		r.drop(kind, verdict)
		return
	case limit.Throttle:
		r.drop(kind, verdict)
		r.writeRateLimited(ev.Conn, kind)
		return
	case limit.Kill:
		r.drop(kind, verdict)
		if r.logger != nil {
			r.logger.Warn("rate limit kill", "uid", ev.Conn.UserID(), "conn", ev.Conn.ID(), "kind", kinds.KindName(kind))
		}
		_ = ev.Conn.Write(buildError(4290, "rate limit exceeded", 60000))
		_ = ev.Conn.Close()
		return
	}

	// 本地处理白名单（policy 数据驱动）。
	if r.isLocal(kind) {
		r.handleLocal(ev)
		return
	}
	r.forward(ev, env)
}

func (r *Router) isLocal(kind uint32) bool {
	if r.pol != nil {
		return r.pol.IsLocal(kind)
	}
	return policy.Default().LocalKinds[kind]
}

// handleLocal 处理白名单帧。
func (r *Router) handleLocal(ev *UpEvent) {
	env := ev.Env
	switch env.Kind {
	case kinds.KindPing:
		var ping chatpb.Ping
		if len(env.Payload) > 0 {
			_ = ping.Unmarshal(env.Payload)
		}
		out := &chatpb.Pong{ClientMs: ping.ClientMs, ServerMs: uint64(time.Now().UnixMilli())}
		payload, _ := out.Marshal()
		r.writeEnv(ev.Conn, &chatpb.Envelope{Kind: kinds.KindPong, AckId: env.Id, Payload: payload})
	case kinds.KindPong:
		// 客户端 pong：读超时已由 acceptor 的 pong handler 续期，这里无需处理。
	case kinds.KindHello:
		// 连接生命周期状态由 acceptor 持有；HELLO 只记录客户端版本。
		if r.logger != nil {
			var hello chatpb.Hello
			_ = hello.Unmarshal(env.Payload)
			r.logger.Debug("hello", "conn", ev.Conn.ID(), "client", hello.ClientVersion, "device", ev.Conn.DeviceID())
		}
	case kinds.KindAuth:
		// upgrade 前已完成鉴权；帧内 AUTH 视为幂等确认。
		payload, _ := (&chatpb.AuthResult{Ok: true, UserId: uint64(ev.Conn.UserID())}).Marshal()
		r.writeEnv(ev.Conn, &chatpb.Envelope{Kind: kinds.KindAuthResult, AckId: env.Id, Payload: payload})
	case kinds.KindResume:
		// 补拉需要数据层 seq：本地不处理，转交桥接（RESUME 白名单只免限流）。
		r.forward(ev, env)
	case kinds.KindFeatureFlags:
		// 订阅：直接回当前进程 flag 快照（写库 ack 由数据层负责）。
		flags := map[string]string{}
		version := uint32(1)
		if r.flags != nil {
			version = uint32(r.flags.Version())
			for k, v := range r.flags.Snapshot() {
				flags[k] = flagString(v)
			}
		}
		payload, _ := (&chatpb.FeatureFlags{Version: version, Flags: flags}).Marshal()
		r.writeEnv(ev.Conn, &chatpb.Envelope{Kind: kinds.KindFeatureFlags, AckId: env.Id, Payload: payload})
	case kinds.KindPresenceSubscribe, kinds.KindPresenceUnsubscribe:
		// 401/402 are USER-LAYER INTERNAL events (a connection opened/closed).
		// Accepting them from a client would let anyone forge another user's
		// online state (P0 in the security review), so they are refused here.
		r.writeEnv(ev.Conn, &chatpb.Envelope{Kind: kinds.KindError,
			Payload: mustMarshal(&chatpb.Error{Code: 4003, Reason: "presence events are server-originated"})})
	default:
		r.forward(ev, env)
	}
}

// mustMarshal is a tiny helper for locally built error payloads.
func mustMarshal(m interface{ Marshal() ([]byte, error) }) []byte {
	b, _ := m.Marshal()
	return b
}

// forward 把业务帧 Wrap 成内部帧交给 forwarder。
func (r *Router) forward(ev *UpEvent, env *chatpb.Envelope) {
	if r.fwd == nil {
		r.drop(env.Kind, limit.Drop)
		return
	}
	intf := frame.Wrap(env, traceID(env), ev.Conn.ID())
	intf.DstLayer = dstLayer(env.Kind)
	body, err := frame.MarshalInternal(intf)
	if err != nil {
		if r.logger != nil {
			r.logger.Warn("wrap internal frame failed", "kind", kinds.KindName(env.Kind), "err", err.Error())
		}
		r.drop(env.Kind, limit.Drop)
		return
	}
	if !r.fwd.Send(&bridge.UpstreamFrame{Kind: env.Kind, TraceID: traceID(env), ConnID: ev.Conn.ID(), Body: body}) {
		r.drop(env.Kind, limit.Drop)
		return
	}
	if r.OnForward != nil {
		r.OnForward(env.Kind)
	}
}

// HandleDownstream 处理一帧桥接下行。
func (r *Router) HandleDownstream(fr *proto.Frame) {
	if fr == nil || fr.Env == nil {
		return
	}
	env := fr.Env
	connID := uint64(0)
	if fr.Meta != nil {
		connID = fr.Meta.ConnID
	}
	// 下行优先按 InternalFrame 解包（bridge 统一封装路由头）。
	if intf, err := frame.UnmarshalInternal(env.Payload); err == nil && intf.Envelope != nil {
		env = intf.Envelope
		if intf.ConnId != 0 {
			connID = intf.ConnId
		}
	}

	if env.Kind == kinds.KindKicked {
		r.executeKicked(env)
		return
	}
	r.deliver(env, connID)
}

// deliver 定位并投递：显式 user_id 优先（数据面结果/事件按用户投递，
// 且 bridge 的 conn_id 属于来源层，不能当作 usergw 连接号使用）；
// 无 user_id 时再按 conn_id 精确定位。
func (r *Router) deliver(env *chatpb.Envelope, connID uint64) {
	b, err := frame.Encode(env)
	if err != nil {
		return
	}
	if uid := int64(env.GetUserId()); uid > 0 {
		if n := r.sess.Broadcast(uid, b); n > 0 {
			if r.OnDeliver != nil {
				r.OnDeliver(env.Kind, 0)
			}
			return
		}
	}
	if connID != 0 {
		if c := r.sess.Lookup(connID); c != nil {
			c.Write(b)
			if r.OnDeliver != nil {
				r.OnDeliver(env.Kind, connID)
			}
			return
		}
		// 连接已断（客户端可能已换新连接）：降级为按 user_id 广播。
	}
	if r.logger != nil {
		r.logger.Debug("downstream unroutable", "kind", kinds.KindName(env.Kind), "conn", connID)
	}
}

// executeKicked 执行 KICKED 策略：查 session → 写 Kicked 帧 → 断连。
func (r *Router) executeKicked(env *chatpb.Envelope) {
	uid := int64(env.GetUserId())
	if uid <= 0 {
		return
	}
	var kicked chatpb.Kicked
	if len(env.Payload) > 0 {
		_ = kicked.Unmarshal(env.Payload)
	}
	payload, _ := kicked.Marshal()
	frameBytes, err := frame.Encode(&chatpb.Envelope{Kind: kinds.KindKicked, Target: &chatpb.Envelope_UserId{UserId: uint64(uid)}, Payload: payload})
	if err != nil {
		return
	}
	conns := r.sess.GetByUser(uid)
	for _, c := range conns {
		c.Write(frameBytes)
		_ = c.Close()
	}
	if r.OnKick != nil {
		r.OnKick(uid, kicked.Reason)
	}
	if r.logger != nil {
		r.logger.Info("kicked", "uid", uid, "conns", len(conns), "reason", kicked.Reason)
	}
}

// onResync 桥接重连后：向全部连接下发 RESUME 补拉标记，让客户端按 last_seq 补齐缺口。
func (r *Router) onResync() {
	payload, _ := (&chatpb.Resume{}).Marshal()
	b, err := frame.Encode(&chatpb.Envelope{Kind: kinds.KindResume, Payload: payload})
	if err != nil {
		return
	}
	// Session 没有 All 方法时可退化为按已知 uid 广播；session 实现提供了 All。
	type aller interface{ All() []session.Conn }
	if a, ok := r.sess.(aller); ok {
		for _, c := range a.All() {
			c.Write(b)
		}
	}
	if r.logger != nil {
		r.logger.Info("bridge resynced, RESUME marks sent")
	}
}

func (r *Router) writeEnv(c session.Conn, env *chatpb.Envelope) {
	b, err := frame.Encode(env)
	if err != nil {
		return
	}
	c.Write(b)
}

func (r *Router) writeRateLimited(c session.Conn, kind uint32) {
	payload, _ := (&chatpb.RateLimited{Scope: "conn", Limit: 1, RetryAfterMs: 500}).Marshal()
	r.writeEnv(c, &chatpb.Envelope{Kind: kinds.KindRateLimited, Payload: payload})
}

func (r *Router) drop(kind uint32, v limit.Verdict) {
	if r.OnDrop != nil {
		r.OnDrop(kind, v)
	}
}

func buildError(code uint32, reason string, retryAfter uint32) []byte {
	payload, _ := (&chatpb.Error{Code: code, Reason: reason, RetryAfterMs: retryAfter}).Marshal()
	b, _ := frame.Encode(&chatpb.Envelope{Kind: kinds.KindError, Payload: payload})
	return b
}

func traceID(env *chatpb.Envelope) string {
	if env == nil {
		return ""
	}
	return env.RequestId
}

func dstLayer(kind uint32) string {
	if kinds.IsInternal(kind) {
		return "data"
	}
	return "data"
}

func flagString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}
