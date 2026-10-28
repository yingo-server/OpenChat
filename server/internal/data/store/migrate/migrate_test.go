package migrate

import (
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// realMigrations points at the project's actual migration tree so Discover
// tests exercise the real SQL files (pure string/FS work, no database).
func realMigrations(t *testing.T) *fstest.MapFS {
	t.Helper()
	// Find the migration root relative to this file's location.
	abs, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "store", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	f := fstest.MapFS{}
	roots := []string{"hot", "cold", "admin"}
	for _, root := range roots {
		base := filepath.Join(abs, root)
		err := filepath.Walk(base, func(p string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || filepath.Ext(p) != ".sql" {
				return err
			}
			body, rerr := os.ReadFile(p)
			if rerr != nil {
				return rerr
			}
			rel, rerr := filepath.Rel(abs, p)
			if rerr != nil {
				return rerr
			}
			f[filepath.ToSlash(rel)] = &fstest.MapFile{Data: body}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", base, err)
		}
	}
	return &f
}

func TestDiscoverHotOrderingAndGrouping(t *testing.T) {
	r := &Runner{Dialect: DialectSQLite, Dir: realMigrations(t)}
	ms, err := r.Discover()
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 5 {
		t.Fatalf("hot should discover 5 migrations (one per domain), got %d", len(ms))
	}
	lastDomain := ""
	versions := map[string]int{}
	for _, m := range ms {
		if m.Domain < lastDomain {
			t.Fatalf("domains not sorted: %s after %s", m.Domain, lastDomain)
		}
		lastDomain = m.Domain
		if m.Version <= versions[m.Domain] {
			t.Fatalf("version not increasing in %s: %d after %d", m.Domain, m.Version, versions[m.Domain])
		}
		versions[m.Domain] = m.Version
		if len(m.Checksum) != 64 {
			t.Fatalf("checksum must be hex SHA256, got %q", m.Checksum)
		}
	}
	for _, d := range []string{"conv", "identity", "media", "msg", "sys"} {
		if versions[d] != 1 {
			t.Errorf("domain %s: want version 1, got %d", d, versions[d])
		}
	}
	// checksum stability: same file must yield the same checksum.
	ms2, _ := r.Discover()
	for i := range ms {
		if ms[i].Checksum != ms2[i].Checksum {
			t.Fatalf("checksum not deterministic for %s", ms[i].Name)
		}
	}
}

func TestDiscoverCold(t *testing.T) {
	r := &Runner{Dialect: DialectPostgres, Dir: realMigrations(t)}
	ms, err := r.Discover()
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 3 {
		t.Fatalf("cold should discover 3 migrations, got %d", len(ms))
	}
	got := map[string]int{}
	for _, m := range ms {
		got[m.Domain] = m.Version
	}
	for _, d := range []string{"identity", "msg", "sys"} {
		if got[d] != 1 {
			t.Errorf("cold domain %s: want version 1, got %d", d, got[d])
		}
	}
}

func TestDiscoverAdminRoot(t *testing.T) {
	r := &Runner{Dialect: DialectSQLite, Root: DirAdmin, Dir: realMigrations(t)}
	ms, err := r.Discover()
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 1 || ms[0].Domain != "adm" || ms[0].Version != 1 {
		t.Fatalf("admin root should discover adm/0001, got %+v", ms)
	}
}

func TestSortMigrations(t *testing.T) {
	ms := []Migration{
		{Domain: "msg", Version: 2},
		{Domain: "identity", Version: 1},
		{Domain: "conv", Version: 10},
		{Domain: "msg", Version: 1},
		{Domain: "conv", Version: 2},
	}
	got := SortMigrations(ms)
	want := []string{"identity/1", "conv/2", "conv/10", "msg/1", "msg/2"}
	for i, w := range want {
		g := got[i].Domain + "/" + string(rune('0'+got[i].Version))

		if g != w {
			t.Fatalf("pos %d: got %s want %s", i, g, w)
		}
	}
}

func TestParseVersion(t *testing.T) {
	for _, c := range []struct {
		name string
		v    int
		ok   bool
	}{
		{"0001_init.sql", 1, true},
		{"0012_add_col.sql", 12, true},
		{"9999_z.sql", 9999, true},
		{"init.sql", 0, false},
		{"1_init.sql", 0, false},
		{"00001_init.sql", 0, false},
		{"0001init.sql", 0, false},
		{"0001_init.txt", 0, false},
	} {
		v, ok := parseVersion(c.name)
		if ok != c.ok || (ok && v != c.v) {
			t.Errorf("parseVersion(%q) = (%d, %v), want (%d, %v)", c.name, v, ok, c.v, c.ok)
		}
	}
}

func TestVerifyChecksum(t *testing.T) {
	applied := map[string]string{"identity/0001": "aa"}
	ok := Migration{Domain: "identity", Version: 1, Checksum: "aa"}
	bad := Migration{Domain: "identity", Version: 1, Checksum: "bb"}
	fresh := Migration{Domain: "msg", Version: 1, Checksum: "cc"}
	if !VerifyChecksum(applied, ok) {
		t.Error("identical checksum must verify")
	}
	if VerifyChecksum(applied, bad) {
		t.Error("tampered checksum must fail")
	}
	if !VerifyChecksum(applied, fresh) {
		t.Error("unapplied migration must verify trivially")
	}
}

func TestDiscoverRejectsBadNamesAndDupes(t *testing.T) {
	f := fstest.MapFS{
		"hot/bad/init.sql":                  {Data: []byte("-- x")},
	}
	r := &Runner{Dialect: DialectSQLite, Dir: f}
	if _, err := r.Discover(); err == nil {
		t.Fatal("bad file name must be rejected")
	}

	f = fstest.MapFS{
		"hot/x/0001_a.sql": {Data: []byte("-- a")},
		"hot/x/0001_b.sql": {Data: []byte("-- b")},
	}
	r = &Runner{Dialect: DialectSQLite, Dir: f}
	if _, err := r.Discover(); err == nil {
		t.Fatal("duplicate version must be rejected")
	}

	// Misplaced depth (root/file.sql) must be rejected.
	f = fstest.MapFS{
		"hot/0001_x.sql": {Data: []byte("-- x")},
	}
	r = &Runner{Dialect: DialectSQLite, Dir: f}
	if _, err := r.Discover(); err == nil {
		t.Fatal("shallow layout must be rejected")
	}
}

func TestRelativePathResolves(t *testing.T) {
	abs, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "store", "migrations"))
	if err != nil { t.Fatal(err) }
	if _, err := os.Stat(abs); err != nil { t.Fatalf("migration dir not found at %s: %v", abs, err) }
}
