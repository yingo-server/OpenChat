package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWhoamiJSONAndAuthHeader(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"admin_id":1,"username":"root","role":"super"}`))
	}))
	defer srv.Close()

	var out, errb bytes.Buffer
	code := run([]string{"--server", srv.URL, "--token", "tok", "--output", "json", "whoami"}, nil, &out, &errb)
	if code != exitOK {
		t.Fatalf("whoami exit=%d err=%s", code, errb.String())
	}
	var v map[string]any
	if err := json.Unmarshal(out.Bytes(), &v); err != nil {
		t.Fatalf("output json: %v (%s)", err, out.String())
	}
	if v["username"] != "root" {
		t.Fatalf("output = %v", v)
	}
	if gotAuth != "Bearer tok" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
}

func TestExitCodeMapping(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/whoami":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"code":403,"reason":"permission_denied","request_id":"r2"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":404,"reason":"not_found","request_id":"r3"}`))
		}
	}))
	defer srv.Close()

	c, err := newClient(globals{Server: srv.URL, Token: "tok"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.do("GET", "/api/v1/whoami", nil, false)
	if code := exitCodeFor(err); code != exitDenied {
		t.Fatalf("403 exit=%d want %d", code, exitDenied)
	}
	_, err = c.do("GET", "/api/v1/nope", nil, false)
	if code := exitCodeFor(err); code != exitNotFound {
		t.Fatalf("404 exit=%d want %d", code, exitNotFound)
	}
	if code := exitCodeFor(&usageError{msg: "bad"}); code != exitUsage {
		t.Fatalf("usage exit=%d", code)
	}
}

func TestLoginSavesCredentialsAndPrintsToken(t *testing.T) {
	credFile := filepath.Join(t.TempDir(), "adminctl.json")
	t.Setenv("OPENCHAT_ADMIN_CREDENTIALS", credFile)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/login" || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var req map[string]string
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req["username"] != "root" || req["password"] != "secret" || req["totp"] != "123456" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"code":401,"reason":"invalid_credentials"}`))
			return
		}
		_, _ = w.Write([]byte(`{"token":"tok-123","csrf_token":"csrf-123","expires_at":1700000000,"admin":{"username":"root","role":"super"}}`))
	}))
	defer srv.Close()

	var out, errb bytes.Buffer
	code := run([]string{"--server", srv.URL, "--no-save", "login", "--username", "root", "--password-stdin", "--totp", "123456"},
		strings.NewReader("secret\n"), &out, &errb)
	if code != exitOK {
		t.Fatalf("login exit=%d err=%s", code, errb.String())
	}
	if strings.TrimSpace(out.String()) != "tok-123" {
		t.Fatalf("login stdout = %q", out.String())
	}
	if _, err := os.Stat(credFile); !os.IsNotExist(err) {
		t.Fatalf("--no-save still wrote credentials: %v", err)
	}

	// Same login without --no-save persists mode-0600 credentials.
	out.Reset()
	errb.Reset()
	code = run([]string{"--server", srv.URL, "login", "--username", "root", "--password-stdin", "--totp", "123456"},
		strings.NewReader("secret\n"), &out, &errb)
	if code != exitOK {
		t.Fatalf("login save exit=%d err=%s", code, errb.String())
	}
	info, err := os.Stat(credFile)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials mode = %o, want 600", info.Mode().Perm())
	}
	creds, err := loadCredentials()
	if err != nil || creds.Token != "tok-123" || creds.CSRF != "csrf-123" {
		t.Fatalf("credentials = %+v err=%v", creds, err)
	}
}

func TestCompletionBash(t *testing.T) {
	var out, errb bytes.Buffer
	if code := run([]string{"completion", "bash"}, nil, &out, &errb); code != exitOK {
		t.Fatalf("completion exit=%d err=%s", code, errb.String())
	}
	if !strings.Contains(out.String(), "complete -F _adminctl adminctl") {
		t.Fatalf("completion output = %s", out.String())
	}
}
