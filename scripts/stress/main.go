// Command stress is the CI load generator for OpenChat: it boots a real chatd,
// then drives HTTP endpoints and the WebSocket channel concurrently and prints
// a compact result table. Deliberately single-file: this is a CI tool, not a
// product surface (see docs/architecture.md: tools are small and composed).
package main

import (
	"bytes"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	_ "github.com/mattn/go-sqlite3"
)

type stats struct {
	mu     sync.Mutex
	lat    []time.Duration
	ok     atomic.Int64
	fail   atomic.Int64
	errs   map[string]int
	byName map[string]*stats1
}

type stats1 struct {
	ok, fail int64
	lat      []time.Duration
}

func newStats() *stats {
	return &stats{errs: map[string]int{}, byName: map[string]*stats1{}}
}

func (s *stats) add(name string, d time.Duration, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.byName[name]
	if st == nil {
		st = &stats1{}
		s.byName[name] = st
	}
	if err != nil {
		s.fail.Add(1)
		st.fail++
		s.errs[err.Error()]++
		return
	}
	s.ok.Add(1)
	st.ok++
	st.lat = append(st.lat, d)
}

func pct(lat []time.Duration, p float64) time.Duration {
	if len(lat) == 0 {
		return 0
	}
	cp := append([]time.Duration(nil), lat...)
	for i := 1; i < len(cp); i++ {
		for j := i; j > 0 && cp[j] < cp[j-1]; j-- {
			cp[j], cp[j-1] = cp[j-1], cp[j]
		}
	}
	idx := int(float64(len(cp)-1) * p)
	return cp[idx]
}

// --- server boot -------------------------------------------------------------

func runChatd(dir string) (*exec.Cmd, string, error) {
	cfg := filepath.Join(dir, "chatd.toml")
	rl := os.Getenv("STRESS_RATE_LIMIT") != "false"
	toml := fmt.Sprintf(`mode = "embedded"
listen = "127.0.0.1:18080"
admin_listen = "127.0.0.1:17780"
admin_rest_listen = "127.0.0.1:17781"
hot_db = "%[1]s/hot.db"
admin_db = "%[1]s/admin.db"
policy_path = "%[1]s/policy.json"
jwt_key_path = "%[1]s/keys/jwt.pem"
media_dir = "%[1]s/media"
log_level = "info"
dev_otp = true
rate_limit_enabled = %[2]t
`, dir, rl)
	if err := os.WriteFile(cfg, []byte(toml), 0o600); err != nil {
		return nil, "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "policy.json"),
		[]byte(`{"hot_retention_days": 90}`), 0o600); err != nil {
		return nil, "", err
	}
	os.MkdirAll(filepath.Join(dir, "keys"), 0o750)
	os.MkdirAll(filepath.Join(dir, "media"), 0o750)

	cmd := exec.Command(os.Getenv("CHATD_BIN"), "-config", cfg)
	cmd.Env = append(os.Environ(), "APP_ENV=dev")
	logf, _ := os.Create(filepath.Join(dir, "chatd.log"))
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		return nil, "", err
	}
	base := "http://127.0.0.1:18080"
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if r, err := http.Get(base + "/healthz"); err == nil {
			r.Body.Close()
			if r.StatusCode == 200 {
				return cmd, base, nil
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return nil, "", fmt.Errorf("chatd did not become healthy")
}

// seedConv creates a single-chat conversation with both members directly in the
// hot DB; the user-plane CONV_CREATE path is exercised elsewhere, the stress
// tool only needs a valid cid to send into.
func seedConv(dbPath string, a, b int64) (int64, error) {
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return 0, err
	}
	defer db.Close()
	var cid int64
	now := time.Now().Unix()
	if err := db.QueryRow(`INSERT INTO conv_conversations(ctype,title,created_by,created_at) VALUES(1,'stress',?,?) RETURNING cid`, a, now).Scan(&cid); err != nil {
		return 0, err
	}
	for _, u := range []int64{a, b} {
		if _, err := db.Exec(`INSERT INTO conv_members(cid,uid,role,joined_at) VALUES(?,?,0,?)`, cid, u, now); err != nil {
			return 0, err
		}
	}
	if _, err := db.Exec(`INSERT INTO conv_seq(cid,next_seq) VALUES(?,1)`, cid); err != nil {
		return 0, err
	}
	return cid, nil
}

// --- HTTP load ---------------------------------------------------------------

type client struct {
	hc  *http.Client
	tok string
	uid int64
}

func guest(base string) (*client, error) {
	jar, _ := cookiejar.New(nil)
	hc := &http.Client{Jar: jar, Timeout: 10 * time.Second}
	resp, err := hc.Post(base+"/api/auth/guest", "application/json",
		bytes.NewReader([]byte(`{"device_id":"stress-`+randHex(6)+`"}`)))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
		UserID      int64  `json:"user_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &client{hc: hc, tok: out.AccessToken, uid: out.UserID}, nil
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)[:n]
}

func (c *client) do(method, url string, body []byte, hdr map[string]string) (*http.Response, error) {
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Cookie", "access_token="+c.tok)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	return c.hc.Do(req)
}

// --- WS load -----------------------------------------------------------------

// jsonEnvelope mirrors apps/client/src/net/proto/codec.ts envelopeToJson:
// snake_case fields, payload as base64.
type jsonEnvelope struct {
	ID        uint64 `json:"id,omitempty"`
	AckID     uint64 `json:"ack_id,omitempty"`
	Kind      uint32 `json:"kind"`
	Version   uint32 `json:"version,omitempty"`
	RequestID string `json:"request_id,omitempty"`
	Flags     uint32 `json:"flags,omitempty"`
	SentAt    uint64 `json:"sent_at,omitempty"`
	ConvID    uint64 `json:"conv_id,omitempty"`
	Payload   string `json:"payload,omitempty"`
}

func dialWS(base, token string) (*websocket.Conn, error) {
	u := "ws" + base[len("http"):] + "/ws"
	hdr := http.Header{"Cookie": []string{"access_token=" + token}}
	conn, _, err := websocket.DefaultDialer.Dial(u, hdr)
	return conn, err
}

func mkSend(cid uint64, text string) []byte {
	return mkSendWithID(cid, text, randHex(12))
}

// mkSendWithID builds a MSG_SEND envelope with an explicit client message id so
// the ACK can be correlated back to the send timestamp (send→ACK latency).
func mkSendWithID(cid uint64, text, cmid string) []byte {
	pl, _ := json.Marshal(map[string]any{"text": text, "clientMsgId": cmid})
	env := jsonEnvelope{ID: 1, Kind: 101, Version: 1, RequestID: randHex(10),
		SentAt: uint64(time.Now().UnixMilli()), ConvID: cid,
		Payload: base64.StdEncoding.EncodeToString(pl)}
	b, _ := json.Marshal(env)
	return b
}

// --- main --------------------------------------------------------------------

func main() {
	var (
		mode     = flag.String("mode", "both", "http|ws|both")
		conns    = flag.Int("conns", 64, "concurrent workers")
		secs     = flag.Int("duration", 10, "seconds per phase")
		skipBoot = flag.Bool("no-boot", false, "use an already-running chatd at -base")
		base     = flag.String("base", "http://127.0.0.1:18080", "chatd base URL")
		out      = flag.String("out", "result.json", "result file")
		assert   = flag.Bool("assert", false, "exit 1 when thresholds are missed")
		ladder   = flag.String("ladder", "", "auto-scale: comma conn counts; stop when availability < 70%")
	)
	flag.Parse()

	if *ladder != "" {
		runLadder(*base, *ladder, *secs, *out)
		return
	}

	dir, _ := os.MkdirTemp("", "ocstress-")
	defer os.RemoveAll(dir)
	var chatd *exec.Cmd
	if !*skipBoot {
		var err error
		chatd, *base, err = runChatd(dir)
		if err != nil {
			fmt.Println("boot:", err)
			os.Exit(2)
		}
		defer func() {
			if chatd != nil && chatd.Process != nil {
				chatd.Process.Signal(os.Interrupt)
				chatd.Process.Wait()
			}
		}()
	}

	// Prepare identities + a conversation to send into.
	a, _ := guest(*base)
	b, _ := guest(*base)
	dbPath := filepath.Join(dir, "hot.db")
	if *skipBoot {
		dbPath = os.Getenv("CHATD_DB")
	}
	cid, err := seedConv(dbPath, a.uid, b.uid)
	if err != nil {
		fmt.Println("seed conv:", err)
		os.Exit(2)
	}
	fmt.Printf("== stress: %s conns=%d duration=%ds conv=%d (a=%d b=%d) ==\n",
		*base, *conns, *secs, cid, a.uid, b.uid)

	st := newStats()
	deadline := time.Now().Add(time.Duration(*secs) * time.Second)

	var wg sync.WaitGroup
	// phase 1: HTTP API（独占跑完再开 WS，否则 guest 注册风暴会挤掉 WS 握手）
	if *mode != "ws" {
		for i := 0; i < *conns; i++ {
			wg.Add(1)
			go func(id int) {
				defer wg.Done()
				c := a
				for time.Now().Before(deadline) {
					t0 := time.Now()
					r, err := c.do("GET", *base+"/healthz", nil, nil)
					if err != nil {
						st.add("http.healthz", 0, err)
						continue
					}
					io.Copy(io.Discard, r.Body)
					r.Body.Close()
					st.add("http.healthz", time.Since(t0), nil)

					t0 = time.Now()
					r, err = c.do("POST", *base+"/api/auth/guest", []byte(`{"device_id":"w-`+randHex(6)+`"}`),
						map[string]string{"Content-Type": "application/json"})
					if err != nil {
						st.add("http.guest", 0, err)
						continue
					}
					io.Copy(io.Discard, r.Body)
					r.Body.Close()
					st.add("http.guest", time.Since(t0), nil)

					// media: small PNG round trip
					t0 = time.Now()
					png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde")
					boundary := "----stress" + randHex(8)
					body := bytes.NewBufferString("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"s.png\"\r\nContent-Type: image/png\r\n\r\n")
					body.Write(png)
					body.WriteString("\r\n--" + boundary + "--\r\n")
					r, err = c.do("POST", *base+"/api/media/upload", body.Bytes(),
						map[string]string{"Content-Type": "multipart/form-data; boundary=" + boundary})
					if err == nil {
						var up struct {
							MediaID string `json:"media_id"`
						}
						json.NewDecoder(r.Body).Decode(&up)
						r.Body.Close()
						if up.MediaID != "" {
							r2, err2 := c.do("GET", *base+"/api/media/"+up.MediaID, nil, nil)
							if err2 == nil {
								io.Copy(io.Discard, r2.Body)
								r2.Body.Close()
							}
							err = err2
						}
					}
					st.add("http.media", time.Since(t0), err)
				}
			}(i)
		}
	}

	wg.Wait()
	fmt.Println("== phase 2: WebSocket ==")

	// phase 2: WebSocket
	if *mode != "http" {
		for i := 0; i < *conns; i++ {
			wg.Add(1)
			go func(id int) {
				defer wg.Done()
				c := a
				if id%2 == 1 {
					c = b
				}
				var conn *websocket.Conn
				t0 := time.Now()
				// 压力下瞬时握手失败应重试（用户基数大 ≠ 攻击；这正是被测目标）。
				for attempt := 0; attempt < 5; attempt++ {
					var resp *http.Response
					var derr error
					u := "ws" + (*base)[len("http"):] + "/ws"
					hdr := http.Header{"Cookie": []string{"access_token=" + c.tok}}
					conn, resp, derr = websocket.DefaultDialer.Dial(u, hdr)
					if derr != nil && resp != nil {
						fmt.Printf("  dial fail: http=%d\n", resp.StatusCode)
					}
					if derr == nil {
						break
					}
					err = derr
					time.Sleep(300 * time.Millisecond)
				}
				st.add("ws.connect", time.Since(t0), err)
				if err != nil {
					return
				}
				defer conn.Close()
				var sent atomic.Int64
				var acked atomic.Int64
				// reader
				go func() {
					for {
						_, data, err := conn.ReadMessage()
						if err != nil {
							return
						}
						var env struct {
							Kind uint32 `json:"kind"`
						}
						if json.Unmarshal(data, &env) == nil {
							if env.Kind == 103 { // MSG_ACK
								acked.Add(1)
							}
						}
					}
				}()
				for time.Now().Before(deadline) {
					s0 := time.Now()
					if err := conn.WriteMessage(websocket.TextMessage, mkSend(uint64(cid), "s")); err != nil {
						// 服务端限流/心跳超时会断连（L4 语义，security-spec §1.2.3）；
						// 记录一次后退出本 worker，不再制造噪音。
						st.add("ws.send", 0, err)
						return
					}
					sent.Add(1)
					st.add("ws.send", time.Since(s0), nil)
					time.Sleep(125 * time.Millisecond)
					// heartbeat
					p0 := time.Now()
					ping := jsonEnvelope{ID: 2, Kind: 4, SentAt: uint64(time.Now().UnixMilli())}
					pb, _ := json.Marshal(ping)
					conn.WriteMessage(websocket.TextMessage, pb)
					st.add("ws.ping", time.Since(p0), nil)
				}
				fmt.Printf("  ws worker %d sent=%d acked=%d\n", id, sent.Load(), acked.Load())
			}(i)
		}
	}

	wg.Wait()

	// report
	fmt.Printf("\n%-20s %8s %8s %10s %10s %10s\n", "endpoint", "ok", "fail", "p50", "p95", "p99")
	for name, s := range st.byName {
		fmt.Printf("%-20s %8d %8d %10s %10s %10s\n", name, s.ok, s.fail,
			pct(s.lat, 0.50), pct(s.lat, 0.95), pct(s.lat, 0.99))
	}
	if len(st.errs) > 0 {
		fmt.Println("errors:")
		for e, n := range st.errs {
			fmt.Printf("  %4d x %s\n", n, e)
		}
	}
	res := map[string]any{"total_ok": st.ok.Load(), "total_fail": st.fail.Load(), "conns": *conns, "duration": *secs, "base": *base}
	for name, s := range st.byName {
		res[name] = map[string]any{"ok": s.ok, "fail": s.fail,
			"p50_ms": pct(s.lat, .5).Milliseconds(), "p95_ms": pct(s.lat, .95).Milliseconds(), "p99_ms": pct(s.lat, .99).Milliseconds()}
	}
	blob, _ := json.MarshalIndent(res, "", "  ")
	os.WriteFile(*out, blob, 0o644)
	fmt.Println("wrote", *out)

	if *assert {
		// conservative thresholds: this is a smoke load, not a benchmark rig.
		ws := st.byName["ws.send"]
		if ws != nil && pct(ws.lat, .99) > 500*time.Millisecond {
			fmt.Println("ASSERT FAIL: ws.send p99 > 500ms")
			os.Exit(1)
		}
		if st.fail.Load()*100 > st.ok.Load() {
			fmt.Println("ASSERT FAIL: error rate > 1%")
			os.Exit(1)
		}
	}
}

// runLadder boots one chatd, then scales concurrency geometrically (×2) until
// availability drops below 70% OR the host is saturated (all workers hit
// connection errors). No fixed ceiling — the ladder grows until the server
// breaks. Prints a capacity table; writes the curve to out.
// 全局 RPM 同时统计：每档记录 (成功发送+ACK)/分钟。
func runLadder(base, ladder string, secs int, out string) {
	// 自动扩展：从 start 倍增，无固定上限。start/max 可由 ladder 字符串覆盖
	//（"start=128,max=1_000_000" 形式），默认 256 → 直到崩。
	start, maxConns := 256, 1<<20
	n2 := 0
	for _, part := range strings.Split(ladder, ",") {
		part = strings.TrimSpace(part)
		if v, err := fmt.Sscanf(part, "start=%d", &n2); err == nil && v == 1 {
			start = n2
			continue
		}
		if v, err := fmt.Sscanf(part, "max=%d", &n2); err == nil && v == 1 {
			maxConns = n2
		}
	}
	dir, _ := os.MkdirTemp("", "ocladder-")
	defer os.RemoveAll(dir)

	cfg := filepath.Join(dir, "chatd.toml")
	toml := fmt.Sprintf(`mode = "embedded"
listen = "127.0.0.1:18080"
admin_listen = "127.0.0.1:17780"
admin_rest_listen = "127.0.0.1:17781"
hot_db = "%[1]s/hot.db"
admin_db = "%[1]s/admin.db"
policy_path = "%[1]s/policy.json"
jwt_key_path = "%[1]s/keys/jwt.pem"
media_dir = "%[1]s/media"
log_level = "info"
dev_otp = true
rate_limit_enabled = false
`, dir)
	os.WriteFile(cfg, []byte(toml), 0o600)
	os.WriteFile(filepath.Join(dir, "policy.json"), []byte(`{"hot_retention_days": 90}`), 0o600)
	os.MkdirAll(filepath.Join(dir, "keys"), 0o750)
	os.MkdirAll(filepath.Join(dir, "media"), 0o750)

	cmd := exec.Command(os.Getenv("CHATD_BIN"), "-config", cfg)
	cmd.Env = append(os.Environ(), "APP_ENV=dev")
	logf, _ := os.Create(filepath.Join(dir, "chatd.log"))
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		fmt.Println("boot:", err)
		os.Exit(2)
	}
	defer cmd.Process.Signal(os.Interrupt)
	baseURL := "http://127.0.0.1:18080"
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if r, err := http.Get(baseURL + "/healthz"); err == nil {
			r.Body.Close()
			if r.StatusCode == 200 {
				break
			}
		}
		time.Sleep(300 * time.Millisecond)
	}

	a2, _ := guest(baseURL)
	b2, _ := guest(baseURL)
	cid, err := seedConv(filepath.Join(dir, "hot.db"), a2.uid, b2.uid)
	if err != nil {
		fmt.Println("seed:", err)
		os.Exit(2)
	}
	fmt.Printf("%8s %10s %9s %12s %10s %6s %10s %10s %10s\n", "conns", "sends", "avail%", "global RPM", "conn p95", "samp", "avg lat", "p95 lat", "verdict")
	type row struct {
		Conns   int     `json:"conns"`
		Sends   int64   `json:"sends"`
		Fails   int64   `json:"fails"`
		Avail   float64 `json:"avail_pct"`
		RPM     float64 `json:"global_rpm"`
		ConnP95 int64   `json:"conn_p95_ms"`
		Pass    bool    `json:"pass"`
	}
	var rows []row
	limit := 0.70
	// 每档：先爬坡建连（ramp），再进入稳态发送窗口（measure）。
	// 关键修正：① ramp 阶段失败计入可用性（否则"啥都没发"会被算成 100% PASS）
	//          ② 发送窗口从"爬坡完成后"起算，测的是稳态吞吐而非建连开销
	//          ③ 时间驱动的 100 份延迟采样（send→ACK 全程）
	for n := start; n <= maxConns; n *= 2 {
		rampBudget := 60 * time.Second
		if n > 2048 {
			rampBudget = 120 * time.Second
		}

		type worker struct {
			conn *websocket.Conn
			tok  string
		}
		var (
			mu      sync.Mutex
			ready   []*worker
			rampErr int64
		)

		// ---- phase A: ramp ----
		rampStart := time.Now()
		var rwg sync.WaitGroup
		sem := make(chan struct{}, 512) // 限制同时在途的登录+握手，避免自我 DoS
		for i := 0; i < n; i++ {
			rwg.Add(1)
			go func() {
				defer rwg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()

				c, err := guest(baseURL)
				if err != nil {
					atomic.AddInt64(&rampErr, 1)
					return
				}
				var conn *websocket.Conn
				hdr := http.Header{"Cookie": []string{"access_token=" + c.tok}}
				for attempt := 0; attempt < 6; attempt++ {
					conn, _, err = websocket.DefaultDialer.Dial("ws"+baseURL[len("http"):]+"/ws", hdr)
					if err == nil {
						break
					}
					time.Sleep(250 * time.Millisecond)
				}
				if err != nil {
					atomic.AddInt64(&rampErr, 1)
					return
				}
				mu.Lock()
				ready = append(ready, &worker{conn: conn, tok: c.tok})
				mu.Unlock()
			}()
		}

		rampDone := make(chan struct{})
		go func() { rwg.Wait(); close(rampDone) }()
		rampTimedOut := false
		select {
		case <-rampDone:
		case <-time.After(rampBudget):
			rampTimedOut = true
		}

		mu.Lock()
		ok := len(ready)
		mu.Unlock()
		rampDur := time.Since(rampStart)
		rampPct := float64(ok) / float64(n) * 100

		// 爬坡成功率不足 70% → 该档已饱和，停止加压。
		if rampPct < 70 {
			fmt.Printf("%8d %10s %9.1f%% %12s %10s %6d %10s %10s %10s  (ramp %d/%d in %s, errs=%d)\n",
				n, "-", rampPct, "-", rampDur.Round(time.Millisecond).String(), 0, "-", "-", "SATURATED", ok, n, rampDur.Round(time.Millisecond), atomic.LoadInt64(&rampErr))
			rows = append(rows, row{Conns: n, Sends: 0, Fails: int64(n - ok), Avail: rampPct, RPM: 0, ConnP95: rampDur.Milliseconds(), Pass: false})
			break
		}
		if rampTimedOut {
			fmt.Printf("%8d %10s %9.1f%% %12s %10s %6d %10s %10s %10s  (ramp timeout %d/%d)\n",
				n, "-", rampPct, "-", rampDur.Round(time.Millisecond).String(), 0, "-", "-", "RAMP_TIMEOUT", ok, n)
			rows = append(rows, row{Conns: n, Sends: 0, Fails: int64(n - ok), Avail: rampPct, RPM: 0, ConnP95: rampDur.Milliseconds(), Pass: false})
			break
		}

		// ---- phase B: steady-state send ----
		var (
			sendOK     int64
			sendFail   int64
			globalSent int64
			lastLat    int64 // 最近一次 send→ACK 延迟（ns）
		)
		win := time.Duration(secs) * time.Second
		dl := time.Now().Add(win)
		for _, w := range ready {
			go func(w *worker) {
				pending := make(map[string]time.Time, 16)
				var pmu sync.Mutex
				// 读线程：ACK 到达即计算 send→ACK 延迟
				go func() {
					for {
						_, data, err := w.conn.ReadMessage()
						if err != nil {
							return
						}
						var env struct {
							Kind    uint32 `json:"kind"`
							Payload string `json:"payload"`
						}
						if json.Unmarshal(data, &env) != nil || env.Kind != 103 {
							continue
						}
						// ACK payload 里带 clientMsgId
						raw, derr := base64.StdEncoding.DecodeString(env.Payload)
						if derr != nil {
							continue
						}
						var ack struct {
							ClientMsgID string `json:"clientMsgId"`
						}
						if json.Unmarshal(raw, &ack) != nil {
							continue
						}
						pmu.Lock()
						if t0, found := pending[ack.ClientMsgID]; found {
							delete(pending, ack.ClientMsgID)
							atomic.StoreInt64(&lastLat, int64(time.Since(t0)))
						}
						pmu.Unlock()
					}
				}()

				for time.Now().Before(dl) {
					cmid := randHex(12)
					msg := mkSendWithID(uint64(cid), "l", cmid)
					pmu.Lock()
					pending[cmid] = time.Now()
					pmu.Unlock()
					if err := w.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
						atomic.AddInt64(&sendFail, 1)
						return
					}
					atomic.AddInt64(&sendOK, 1)
					atomic.AddInt64(&globalSent, 1)
					time.Sleep(20 * time.Millisecond)
				}
			}(w)
		}

		// 时间驱动采样：窗口内均匀取 100 个点
		samples := make([]time.Duration, 0, 100)
		sampleTick := win / 100
		if sampleTick < time.Millisecond {
			sampleTick = time.Millisecond
		}
		stk := time.NewTicker(sampleTick)
		for len(samples) < 100 {
			select {
			case <-stk.C:
				if v := atomic.LoadInt64(&lastLat); v > 0 {
					samples = append(samples, time.Duration(v))
				}
			case <-time.After(time.Until(dl) + 500*time.Millisecond):
				stk.Stop()
				goto sendDone
			}
		}
		stk.Stop()
	sendDone:
		time.Sleep(1500 * time.Millisecond) // 收尾 ACK

		total := sendOK + sendFail
		avail := 100.0
		if total > 0 {
			avail = float64(sendOK) / float64(total) * 100
		}
		// 分母为 0 = 一条消息都没发出去，这不是 100%，是失败。
		if total == 0 {
			avail = 0
		}
		rpm := float64(globalSent) / win.Seconds() * 60

		var avgLat time.Duration
		for _, d := range samples {
			avgLat += d
		}
		if len(samples) > 0 {
			avgLat /= time.Duration(len(samples))
		}
		p95Lat := pct(samples, .95)

		pass := avail >= limit*100
		verdict := "PASS"
		if !pass {
			verdict = "FAIL"
		}
		fmt.Printf("%8d %10d %9.1f%% %12.0f %10s %6d %10v %10v %10s  (ramp %d/%d %s)\n",
			n, sendOK, avail, rpm, rampDur.Round(time.Millisecond).String(), len(samples), avgLat.Round(time.Microsecond), p95Lat.Round(time.Microsecond), verdict, ok, n, rampDur.Round(time.Millisecond))
		rows = append(rows, row{Conns: n, Sends: sendOK, Fails: sendFail, Avail: avail, RPM: rpm, ConnP95: rampDur.Milliseconds(), Pass: pass})

		for _, w := range ready {
			w.conn.Close()
		}

		if !pass {
			break
		}
	}

	blob, _ := json.MarshalIndent(rows, "", "  ")
	os.WriteFile(out, blob, 0o644)
	fmt.Println("wrote", out)
}
