package web

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

var t0 = time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)

func fixture() fstest.MapFS {
	return fstest.MapFS{
		"index.html":            {Data: []byte("<!doctype html><div id=root></div>"), ModTime: t0},
		"assets/app-abc123.js":  {Data: []byte("console.log(1)"), ModTime: t0},
		"assets/app-abc123.css": {Data: []byte("body{}"), ModTime: t0},
		"favicon.ico":           {Data: []byte("ico"), ModTime: t0},
	}
}

func get(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestClientSPAFallback(t *testing.T) {
	h := newHandler(false, fixture(), fixture())

	for _, target := range []string{"/", "/login", "/chat/42", "/settings/profile"} {
		rec := get(t, h, target)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", target, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "<div id=root>") {
			t.Fatalf("%s: body is not index.html: %q", target, rec.Body.String())
		}
		if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
			t.Fatalf("%s: index Cache-Control = %q, want no-store", target, cc)
		}
	}
}

func TestAdminMountAndFallback(t *testing.T) {
	h := newHandler(true, fixture(), fixture())

	rec := get(t, h, "/admin")
	if rec.Code != http.StatusMovedPermanently || rec.Header().Get("Location") != "/admin/" {
		t.Fatalf("/admin: status=%d location=%q", rec.Code, rec.Header().Get("Location"))
	}

	rec = get(t, h, "/admin/users")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<div id=root>") {
		t.Fatalf("/admin/users: status=%d body=%q", rec.Code, rec.Body.String())
	}

	rec = get(t, h, "/admin/assets/app-abc123.js")
	if rec.Code != http.StatusOK || rec.Body.String() != "console.log(1)" {
		t.Fatalf("/admin/assets/app-abc123.js: status=%d body=%q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("js Content-Type = %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("hashed asset Cache-Control = %q, want immutable", cc)
	}
}

func TestAdminDisabledReturns404(t *testing.T) {
	h := newHandler(false, fixture(), fixture())

	for _, target := range []string{"/admin", "/admin/", "/admin/users"} {
		if rec := get(t, h, target); rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, want 404", target, rec.Code)
		}
	}
}

func TestMissingAssetIs404(t *testing.T) {
	h := newHandler(true, fixture(), fixture())

	if rec := get(t, h, "/assets/missing-xyz.js"); rec.Code != http.StatusNotFound {
		t.Fatalf("missing js: status = %d, want 404 (never index.html)", rec.Code)
	}
	if rec := get(t, h, "/admin/assets/missing-xyz.css"); rec.Code != http.StatusNotFound {
		t.Fatalf("missing css: status = %d, want 404", rec.Code)
	}
}

func TestUnbuiltUIReturns503(t *testing.T) {
	// 只有 .gitkeep 的目录：与仓库未执行 make web 时的状态一致。
	empty := fstest.MapFS{".gitkeep": {Data: nil}}
	h := newHandler(true, empty, empty)

	rec := get(t, h, "/")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unbuilt UI: status = %d, want 503", rec.Code)
	}
}

func TestMethodsAndTraversal(t *testing.T) {
	h := newHandler(true, fixture(), fixture())

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /: status = %d, want 405", rec.Code)
	}

	// ServeMux 会先把含 ".." 的路径 301 规范化；直接打到 SPA 上也不能逃出 fs.FS。
	if rec := get(t, h, "/../../etc/passwd"); rec.Code != http.StatusMovedPermanently {
		t.Fatalf("mux traversal: status = %d, want 301 canonical redirect", rec.Code)
	}
	direct := newSPA("client", fixture())
	rec = get(t, direct, "/../../etc/passwd")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<div id=root>") {
		t.Fatalf("spa traversal: status=%d body=%q", rec.Code, rec.Body.String())
	}
}

// TestEmbeddedAssets 只在 `make web` 之后有效；CI 的 go job 没构建前端时跳过。
func TestEmbeddedAssets(t *testing.T) {
	for name, fsys := range map[string]fs.FS{"client": ClientFS, "admin": AdminFS} {
		data, err := fs.ReadFile(fsys, indexFile)
		if err != nil {
			t.Logf("%s: index.html 未构建（.gitkeep only），跳过", name)
			continue
		}
		if len(data) < 100 {
			t.Fatalf("%s: index.html too small (%d bytes)", name, len(data))
		}
		if !strings.Contains(strings.ToLower(string(data)), "<!doctype html>") {
			t.Fatalf("%s: index.html is not an HTML document", name)
		}
	}
}
