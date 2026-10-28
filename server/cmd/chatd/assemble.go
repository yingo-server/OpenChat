package main

// assemble.go: the embedded assembly. Everything here is wiring — construct,
// attach, inject. No business rules, no branching on message semantics.
//
// Layer graph (docs/architecture.md, embedded form):
//
//	HTTP/WS :listen ──► usergw(acceptor→router→forwarder) ──► userPeer ┐
//	     └─ /api/auth/* ──► authsvc (same port)                        │
//	                                                                   ▼
//	                       embedded.Bridge (fan-in ⇄ SendTo fan-out) ──┐
//	                                                                   │
//	                     dataPeer ◄── pipe.Run ◄───────────────────────┘
//	                          └──► SQLite (hot DB, WAL)
//	admin :admin_listen ──► AdminAPI(/admin/inject) + /api/admin/* (TODO)
//
// and on SIGTERM: usergw.Drain → pipe.Drain → pipeline.Drain → close.

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/yingo-server/OpenChat/server/internal/admin"
	adminstore "github.com/yingo-server/OpenChat/server/internal/admin/store"
	"github.com/yingo-server/OpenChat/server/internal/authsvc"
	"github.com/yingo-server/OpenChat/server/internal/bridge"
	"github.com/yingo-server/OpenChat/server/internal/bridge/adminapi"
	"github.com/yingo-server/OpenChat/server/internal/data/pipe"
	"github.com/yingo-server/OpenChat/server/internal/data/policy"
	"github.com/yingo-server/OpenChat/server/internal/data/store"
	"github.com/yingo-server/OpenChat/server/internal/data/store/sqlite"
	"github.com/yingo-server/OpenChat/server/internal/pkg/featureflags"
	"github.com/yingo-server/OpenChat/server/internal/pkg/log"
	"github.com/yingo-server/OpenChat/server/internal/proto/gen/chatpb"
	"github.com/yingo-server/OpenChat/server/internal/proto/kinds"
	"github.com/yingo-server/OpenChat/server/internal/transport/embedded"
	"github.com/yingo-server/OpenChat/server/internal/user/app"
	"github.com/yingo-server/OpenChat/server/internal/user/core/authn"
	"github.com/yingo-server/OpenChat/server/internal/user/net/frame"
	"github.com/yingo-server/OpenChat/server/internal/user/net/ws"
	"github.com/yingo-server/OpenChat/server/web"
)

type assembly struct {
	cfg *config
	lg  *log.Logger

	hot     *sqlite.DB
	adminDB *adminstore.DB
	policy  *policy.Store
	flags   *featureflags.Flags

	bridge   *embedded.Bridge
	userPeer *layerPeer
	dataPeer *layerPeer

	pipeline  *bridge.Pipeline
	pipe      *pipe.Pipe
	user      *app.Server
	auth      *authsvc.Service
	admin     *adminPlane
	adminREST *admin.Server
	adminKey  []byte

	started time.Time
}

// newAssembly builds every component and wires them. Nothing starts running
// here (no listener, no goroutine): run() is the only place that does.
func newAssembly(cfg *config, lg *log.Logger) (*assembly, error) {
	a := &assembly{cfg: cfg, lg: lg, started: time.Now()}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// 1. hot database (+ migrations).
	if err := os.MkdirAll(filepath.Dir(cfg.HotDB), 0o750); err != nil {
		return nil, fmt.Errorf("chatd: create hot db dir: %w", err)
	}
	hot, err := sqlite.Open(cfg.HotDB)
	if err != nil {
		return nil, fmt.Errorf("chatd: open hot db: %w", err)
	}
	if err := hot.Migrate(ctx); err != nil {
		_ = hot.Close()
		return nil, fmt.Errorf("chatd: migrate hot db: %w", err)
	}
	a.hot = hot

	// 2. admin database (+ migrations), a separate file with its own schema.
	if err := os.MkdirAll(filepath.Dir(cfg.AdminDB), 0o750); err != nil {
		return nil, fmt.Errorf("chatd: create admin db dir: %w", err)
	}
	adb, err := adminstore.Open(cfg.AdminDB)
	if err != nil {
		return nil, fmt.Errorf("chatd: open admin db: %w", err)
	}
	if err := adb.Migrate(ctx); err != nil {
		return nil, fmt.Errorf("chatd: migrate admin db: %w", err)
	}
	a.adminDB = adb

	// 3. policy (mechanism/policy separation: the data layer reads snapshots).
	// A *missing* file degrades to policy.Default() with a warning (first run);
	// an existing but invalid file is a hard config error (exit 1) — a
	// half-understood policy must never be silently replaced.
	switch {
	case cfg.PolicyPath == "":
		lg.Warn("no policy_path configured; using built-in policy defaults")
	default:
		if _, statErr := os.Stat(cfg.PolicyPath); errors.Is(statErr, os.ErrNotExist) {
			lg.Warn("policy file not found; using built-in defaults", "path", cfg.PolicyPath)
			break
		}
		pol, perr := policy.New(cfg.PolicyPath)
		if perr != nil {
			return nil, fmt.Errorf("chatd: load policy: %w", perr)
		}
		a.policy = pol
	}

	// 4. media directory (LUKS mount point in production; unused this batch).
	if cfg.MediaDir != "" {
		if err := os.MkdirAll(cfg.MediaDir, 0o750); err != nil {
			return nil, fmt.Errorf("chatd: create media dir: %w", err)
		}
	}

	// 5. keys + crypto primitives (single owner: this assembly).
	priv, err := loadOrCreateSigningKey(cfg.JWTKeyPath, lg)
	if err != nil {
		return nil, err
	}
	hmacKey, err := loadOrCreateHMACKey(cfg.PIIKeyPath, lg)
	if err != nil {
		return nil, err
	}
	// The admin plane's injector and the REST layer's outbound proxy share one
	// HMAC key: without it any local process could inject management frames.
	adminKey, err := loadOrCreateHMACKey(adminKeyPath(cfg), lg)
	if err != nil {
		return nil, err
	}
	a.adminKey = adminKey
	signer := authn.NewSigner(priv).WithKID("k1")
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("chatd: signing key is not Ed25519")
	}
	verifier := authn.NewVerifier(pub)
	hasher := authn.NewHasher(authn.DefaultArgon2Params())

	// 6. feature flags: seed missing keys, then load the effective set.
	if err := a.bootstrapFlags(ctx); err != nil {
		return nil, err
	}

	// 7. embedded transport + bridge pipeline.
	a.userPeer = newLayerPeer("user")
	a.dataPeer = newLayerPeer("data")
	br := embedded.NewBridge(nil)
	br.Attach(a.userPeer)
	br.Attach(a.dataPeer)
	a.bridge = br

	pl, err := bridge.Assemble(bridge.Config{
		RouteTable: buildRoutes(),
		Sender:     br.SendTo,
		Signals:    neverFires(), // chatd owns signal handling (cross-layer drain order)
		// Loopback is not an authorization boundary: the injector verifies the
		// same HMAC the REST layer signs (docs/security-spec.md §3.2).
		AdminAuth: adminapi.NewHMACAuthorizer([][]byte{adminKey}),
	}, br.Peer())
	if err != nil {
		return nil, fmt.Errorf("chatd: assemble bridge: %w", err)
	}
	a.pipeline = pl

	// 8. data layer: pipe + the two wire adapters.
	installEmit()
	p := pipe.New(a.dataPeer, hot, pipe.ColdDeps{}, a.policy, log.For("data"))
	p.FrameSource = newFrameSource(func(connID uint64) int64 {
		// Late binding: the gateway exists only after step 9.
		if a.user == nil {
			return 0
		}
		if c := a.user.Session().Lookup(connID); c != nil {
			return c.UserID()
		}
		return 0
	}, log.For("chatd"))
	a.pipe = p

	// 9. auth service (same HTTP port as the gateway).
	authSvc, err := authsvc.New(authsvc.Deps{
		DB:       hot.DB,
		Identity: hot,
		Sys:      hot,
		Signer:   signer,
		Verifier: verifier,
		Hasher:   hasher,
		HMACKey:  hmacKey,
	}, authsvc.Config{
		PublicOrigin:  cfg.PublicOrigin,
		AccessTTL:     time.Duration(cfg.AccessTTLSec) * time.Second,
		RefreshTTL:    time.Duration(cfg.RefreshTTLSec) * time.Second,
		DevOTP:        cfg.DevOTP,
		SecureCookies: strings.HasPrefix(cfg.PublicOrigin, "https://"),
		Logger:        log.For("authsvc"),
	})
	if err != nil {
		return nil, fmt.Errorf("chatd: auth service: %w", err)
	}
	a.auth = authSvc

	// 10. user layer gateway: /ws + /api/auth/* + /healthz + SPA on one port.
	userCfg := app.DefaultConfig()
	userCfg.ListenAddr = cfg.Listen
	userCfg.PublicOrigin = cfg.PublicOrigin
	userCfg.BridgeAddr = "embedded"
	userCfg.LogLevel = cfg.LogLevel
	userCfg.ExtraRoutes = a.buildHTTP(authSvc.Routes())
	userCfg.Flags = a.flags

	srv, err := app.New(userCfg, func(token string) (*ws.Identity, error) {
		id, verr := verifier.Verify(token)
		if verr != nil {
			return nil, verr
		}
		return &ws.Identity{UserID: id.UserID, DeviceID: id.DeviceID}, nil
	}, a.userPeer)
	if err != nil {
		return nil, fmt.Errorf("chatd: user gateway: %w", err)
	}
	a.user = srv

	// 11. management surfaces: frame injector (:admin_listen) and the RBAC REST
	// layer (:admin_rest_listen) that reaches the bus through the injector.
	plane, err := newAdminPlane(cfg.AdminListen, pl.AdminAPI().Handler(), log.For("admin"))
	if err != nil {
		return nil, err
	}
	a.admin = plane

	rest, err := newAdminREST(cfg, hot, adb, nil, a.policy, adminKey, log.For("admin-rest"))
	if err != nil {
		return nil, err
	}
	a.adminREST = rest

	if cfg.ColdDSN != "" && lg != nil {
		lg.Warn("cold_dsn configured but the cold store is not wired in this build", "effect", "hot-only reads, no audit")
	}
	return a, nil
}

// bootstrapFlags seeds sys_feature_flags with the compiled/config defaults for
// keys that are not in the DB yet, then loads the effective set. Existing
// values always win (flags are policy data: an admin change must survive a
// restart).
func (a *assembly) bootstrapFlags(ctx context.Context) error {
	seed := featureflags.Defaults()
	for k, v := range a.cfg.Flags {
		seed[k] = v
	}
	merged := map[string]any{}
	for k, v := range seed {
		merged[k] = v
	}
	existing, err := a.hot.AllFlags(ctx)
	if err != nil {
		return fmt.Errorf("chatd: read feature flags: %w", err)
	}
	have := map[string]bool{}
	for _, f := range existing {
		have[f.Key] = true
		var v any
		if err := json.Unmarshal([]byte(f.Value), &v); err == nil {
			merged[f.Key] = v
		}
	}
	for k, v := range seed {
		if have[k] {
			continue
		}
		body, err := json.Marshal(v)
		if err != nil {
			continue
		}
		if err := a.hot.UpsertFlag(ctx, &store.Flag{Key: k, Value: string(body)}); err != nil {
			return fmt.Errorf("chatd: seed feature flag %s: %w", k, err)
		}
	}
	a.flags = featureflags.NewFromMap(merged)
	return nil
}

// buildHTTP is the single user-facing mux: everything the browser talks to
// lives on one port (Caddy proxies one upstream).
func (a *assembly) buildHTTP(auth http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/auth/", auth)
	mux.HandleFunc("GET /healthz", a.healthz)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSONStatus(w, http.StatusNotFound, map[string]any{"error": "unknown api path", "code": "NOT_FOUND"})
	})
	// SPA: / and every non-file path fall back to index.html (the web package
	// answers 503 when the dist has not been built, never panics).
	mux.Handle("/", web.Handler(true))
	return mux
}

func (a *assembly) healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	body := map[string]any{
		"ok":        true,
		"mode":      a.cfg.Mode,
		"uptime_ms": time.Since(a.started).Milliseconds(),
	}
	if a.user != nil {
		body["conns"] = a.user.Session().Count()
	}
	if err := a.hot.PingContext(ctx); err != nil {
		body["ok"] = false
		body["db"] = "unavailable"
		writeJSONStatus(w, http.StatusServiceUnavailable, body)
		return
	}
	body["db"] = "ok"
	writeJSONStatus(w, http.StatusOK, body)
}

// run starts the four long-lived components and blocks until one of them fails
// or ctx is canceled.
func (a *assembly) run(ctx context.Context) error {
	errCh := make(chan error, 4)
	go func() { errCh <- a.user.Run(ctx) }()
	go func() { a.pipe.Run(ctx); errCh <- nil }()
	go func() { errCh <- a.pipeline.Run(ctx) }()
	go func() { errCh <- a.admin.Run(ctx) }()
	go func() { errCh <- a.adminREST.Run(ctx) }()

	a.lg.Info("chatd ready",
		"mode", a.cfg.Mode,
		"listen", a.user.Addr(),
		"admin_listen", a.admin.Addr(),
		"admin_rest_listen", a.cfg.AdminRESTListen,
		"hot_db", a.cfg.HotDB,
		"flags", a.flags.Version())

	select {
	case <-ctx.Done():
		return nil
	case err := <-errCh:
		if err != nil {
			return err
		}
		return nil
	}
}

// shutdown implements the cross-layer SIGTERM order:
//
//	usergw.Drain (stop accept, ERROR{SHUTDOWN}, flush forwarder, BYE)
//	→ pipe.Drain (final group commit; acks flushed)
//	→ pipeline.Drain (bridge peers/egress)
//
// The caller cancels the root ctx afterwards so every Run() returns.
func (a *assembly) shutdown() {
	timeout := time.Duration(a.cfg.ShutdownTimeout) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	a.lg.Info("draining", "timeout_s", int(timeout/time.Second))

	if a.user != nil {
		if err := a.user.Drain(ctx); err != nil {
			a.lg.Warn("usergw drain", "err", err.Error())
		}
	}
	// Give the dispatcher a moment to finish frames that were already handed
	// to the pipe; the pipe's Drain is the only place allowed to close writeCh.
	select {
	case <-time.After(50 * time.Millisecond):
	case <-ctx.Done():
	}
	if a.pipe != nil {
		a.pipe.Drain(ctx)
	}
	if a.pipeline != nil {
		a.pipeline.Drain(ctx)
	}
	if a.adminREST != nil {
		_ = a.adminREST.Close()
	}
	if a.admin != nil {
		_ = a.admin.Close()
	}
	if a.bridge != nil {
		_ = a.bridge.Close()
	}
	a.lg.Info("drain complete")
}

// close releases the databases (last step, after every layer stopped).
func (a *assembly) close() {
	if a.hot != nil {
		_ = a.hot.Close()
	}
	if a.adminDB != nil {
		_ = a.adminDB.Close()
	}
}

// reload implements SIGHUP (whitelist: policy + feature flags).
// Anything else (listen address, keys, DB paths) requires a restart.
func (a *assembly) reload(ctx context.Context) {
	if a.policy != nil {
		changed, err := a.policy.Reload()
		if err != nil {
			a.lg.Warn("policy reload failed; keeping previous snapshot", "err", err.Error())
		} else {
			a.lg.Info("policy reloaded", "changed", strings.Join(changed, ","), "version", a.policy.Current().Version)
		}
	}
	stored, err := a.hot.AllFlags(ctx)
	if err != nil {
		a.lg.Warn("flag reload failed", "err", err.Error())
		return
	}
	next := map[string]any{}
	for _, f := range stored {
		var v any
		if err := json.Unmarshal([]byte(f.Value), &v); err == nil {
			next[f.Key] = v
		}
	}
	version := a.flags.Apply(next)

	// Re-publish to every live connection (embedded: all users are here).
	if a.user == nil {
		return
	}
	flags := make(map[string]string, len(next))
	for k, v := range next {
		if s, ok := v.(string); ok {
			flags[k] = s
			continue
		}
		if b, merr := json.Marshal(v); merr == nil {
			flags[k] = strings.Trim(string(b), `"`)
		}
	}
	payload, merr := (&chatpb.FeatureFlags{Version: uint32(version), Flags: flags}).Marshal()
	if merr != nil {
		a.lg.Warn("flag frame encode failed", "err", merr.Error())
		return
	}
	body, ferr := frame.Encode(&chatpb.Envelope{Kind: kinds.KindFeatureFlags, Payload: payload})
	if ferr != nil {
		return
	}
	sent := a.user.Broadcast(body)
	a.lg.Info("feature flags republished", "version", version, "conns", sent)
}

// dump is the SIGUSR1 status snapshot (stdout, one JSON line).
func (a *assembly) dump(w io.Writer) {
	snap := map[string]any{
		"mode":        a.cfg.Mode,
		"uptime_ms":   time.Since(a.started).Milliseconds(),
		"goroutines":  runtime.NumGoroutine(),
		"listen":      a.user.Addr(),
		"admin_addr":  a.admin.Addr(),
		"conns":       a.user.Session().Count(),
		"flags_ver":   a.flags.Version(),
		"forwarder":   fmt.Sprintf("%+v", a.user.Forwarder().Stats()),
		"bridge":      a.pipeline.Snapshot(),
		"policy_path": a.cfg.PolicyPath,
	}
	if a.policy != nil {
		snap["policy_version"] = a.policy.Current().Version
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"event":  "status_dump",
		"at":     time.Now().UTC().Format(time.RFC3339Nano),
		"status": snap,
	})
}

// neverFires is a signal channel that never receives: the bridge supervisor is
// told "someone else owns signals", so SIGTERM reaches the ordered drain above
// instead of racing a partial bridge-only drain.
func neverFires() <-chan os.Signal { return make(chan os.Signal) }
