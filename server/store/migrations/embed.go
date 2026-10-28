// Package migrations embeds the canonical migration SQL tree.
//
// Layout (docs/admin-data-design.md §3.2):
//
//	hot/{identity,conv,msg,media,sys}/{NNNN}_{name}.sql   -- SQLite, hot DB
//	cold/{msg,identity,sys}/{NNNN}_{name}.sql             -- PostgreSQL, cold DB
//	admin/adm/{NNNN}_{name}.sql                           -- SQLite, standalone admin.db
//
// Each domain owns an independent version sequence. The migrate.Runner
// consumes this FS; SQL files are the single source of truth for DDL.
package migrations

import "embed"

//go:embed hot cold admin
var FS embed.FS
