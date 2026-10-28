// Package web 把两套 SPA 产物编译进 Go 二进制：
//
//	server/web/client  ← apps/client/dist   （用户端，挂在 /）
//	server/web/admin   ← apps/admin/dist    （管理后台，挂在 /admin/）
//
// 产物由 `make web` 从 apps/*/dist 复制而来（Makefile 里 rm -rf 后整目录替换，
// 不允许手改）。目录内只保留 .gitkeep 时包依然可以编译：Handler 会对缺失的
// index.html 返回 503，而不是 panic。
//
// 路由契约（与 deploy/Caddyfile 一致）：
//   - "/" 及其子路径 → 用户端；找不到的「非文件」路径回退 index.html（SPA）
//   - "/admin/" 及其子路径 → 管理后台；admin=false 时整段 404
//   - 带扩展名但磁盘上不存在的路径 → 404（避免把 JS/CSS 请求回成 HTML）
//   - index.html 不缓存；/assets/ 下带 hash 的静态资源长缓存（immutable）
//
// 典型用法（由 HTTP 装配层调用，本包不碰业务路由）：
//
//	mux.Handle("/", web.Handler(true))       // embedded 单进程：同时托管两端
//	mux.Handle("/ui/", web.Handler(false))   // 或只托管用户端
package web

import (
	"bytes"
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

// 两套产物都必须在编译期存在（.gitkeep 保证空目录也能 embed）。
//
//go:embed all:client all:admin
var assets embed.FS

var (
	// ClientFS 是用户端产物根（server/web/client）。
	ClientFS fs.FS
	// AdminFS 是管理后台产物根（server/web/admin）。
	AdminFS fs.FS
)

const (
	// indexFile 是 SPA 入口，同时也是「无缓存」判定的唯一名字。
	indexFile = "index.html"
	// immutableAssets 是 Vite 的 hashed 资源目录前缀。
	immutableAssets = "assets/"
)

func init() {
	var err error
	if ClientFS, err = fs.Sub(assets, "client"); err != nil {
		panic("web: embed client: " + err.Error())
	}
	if AdminFS, err = fs.Sub(assets, "admin"); err != nil {
		panic("web: embed admin: " + err.Error())
	}
	registerMIME()
}

// Handler 返回同时托管用户端与管理后台的 http.Handler。
//
// admin=false 时 /admin 与 /admin/* 一律 404（例如 split 部署下管理后台由独立
// 进程/域名承载），其余路径仍然按用户端 SPA 处理。
func Handler(admin bool) http.Handler {
	return newHandler(admin, ClientFS, AdminFS)
}

func newHandler(admin bool, clientFS, adminFS fs.FS) http.Handler {
	mux := http.NewServeMux()
	if admin {
		// /admin（无斜杠）→ /admin/：index.html 里的资源是 /admin/assets/... 绝对路径，
		// 但保持 URL 规范，避免相对路径二次解析出错。
		mux.Handle("/admin", http.RedirectHandler("/admin/", http.StatusMovedPermanently))
		mux.Handle("/admin/", http.StripPrefix("/admin", newSPA("admin", adminFS)))
	} else {
		notFound := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
		mux.Handle("/admin", notFound)
		mux.Handle("/admin/", notFound)
	}
	mux.Handle("/", newSPA("client", clientFS))
	return mux
}

// spa 是单个前端的静态文件处理器：文件命中则直出，否则回退 index.html。
type spa struct {
	name string
	fsys fs.FS
}

func newSPA(name string, fsys fs.FS) http.Handler { return &spa{name: name, fsys: fsys} }

func (s *spa) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// path.Clean 折叠 //、/./、/../；TrimPrefix 后再拼一个 "/" 防止 ".." 逃逸。
	rel := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if rel == "" || rel == "." {
		s.serveIndex(w, r)
		return
	}

	if data, modTime, ok := s.readFile(rel); ok {
		s.write(w, r, rel, data, modTime)
		return
	}

	// 带扩展名的请求视为静态资源：缺失就是 404，绝不回 index.html
	// （否则浏览器会把 HTML 当 JS 执行，报 "Unexpected token '<'"）。
	if path.Ext(rel) != "" {
		http.NotFound(w, r)
		return
	}

	s.serveIndex(w, r)
}

func (s *spa) serveIndex(w http.ResponseWriter, r *http.Request) {
	data, modTime, ok := s.readFile(indexFile)
	if !ok {
		http.Error(w, s.name+" UI is not embedded (run `make web` before `go build`)", http.StatusServiceUnavailable)
		return
	}
	s.write(w, r, indexFile, data, modTime)
}

// readFile 读取并校验一个普通文件；目录返回 false。
func (s *spa) readFile(name string) ([]byte, time.Time, bool) {
	f, err := s.fsys.Open(name)
	if err != nil {
		return nil, time.Time{}, false
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return nil, time.Time{}, false
	}
	data, err := fs.ReadFile(s.fsys, name)
	if err != nil {
		return nil, time.Time{}, false
	}
	return data, st.ModTime(), true
}

// write 统一写入：显式 MIME + 缓存策略 + nosniff。
func (s *spa) write(w http.ResponseWriter, r *http.Request, name string, data []byte, modTime time.Time) {
	h := w.Header()
	h.Set("Content-Type", contentType(name))
	h.Set("X-Content-Type-Options", "nosniff")
	setCache(h, name)

	// embed.FS 的 ModTime 为零值：ServeContent 会跳过 Last-Modified，
	// 缓存策略完全由 Cache-Control 决定；测试用的 fstest.MapFS 则能带上真实时间。
	http.ServeContent(w, r, name, modTime, bytes.NewReader(data))
}

// setCache 落实「index 不缓存、hash 资源长缓存」。
func setCache(h http.Header, name string) {
	switch {
	case name == indexFile:
		h.Set("Cache-Control", "no-cache, no-store, must-revalidate")
		h.Set("Pragma", "no-cache")
		h.Set("Expires", "0")
	case strings.HasPrefix(name, immutableAssets):
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	default:
		// favicon/robots 等无 hash 的根文件：短缓存，升级后最多 1 小时可见旧值。
		h.Set("Cache-Control", "public, max-age=3600")
	}
}

// contentType 优先使用显式表，避免精简系统缺少 /etc/mime.types 时
// .js 被识别成 text/plain（浏览器会拒绝执行 module）。
func contentType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json", ".map":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".avif":
		return "image/avif"
	case ".ico":
		return "image/x-icon"
	case ".woff":
		return "font/woff"
	case ".woff2":
		return "font/woff2"
	case ".ttf":
		return "font/ttf"
	case ".otf":
		return "font/otf"
	case ".wasm":
		return "application/wasm"
	case ".txt":
		return "text/plain; charset=utf-8"
	case ".webmanifest":
		return "application/manifest+json"
	case ".xml":
		return "application/xml; charset=utf-8"
	}
	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// registerMIME 把关键类型注册进 mime 包，ServeContent 在未显式设置时也能正确回源。
func registerMIME() {
	for ext, ct := range map[string]string{
		".js":          "text/javascript; charset=utf-8",
		".mjs":         "text/javascript; charset=utf-8",
		".css":         "text/css; charset=utf-8",
		".json":        "application/json; charset=utf-8",
		".map":         "application/json; charset=utf-8",
		".svg":         "image/svg+xml",
		".webp":        "image/webp",
		".avif":        "image/avif",
		".woff2":       "font/woff2",
		".wasm":        "application/wasm",
		".webmanifest": "application/manifest+json",
	} {
		_ = mime.AddExtensionType(ext, ct)
	}
}
