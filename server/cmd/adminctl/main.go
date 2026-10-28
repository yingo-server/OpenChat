// Command adminctl is the management-plane CLI. It is a pure API client:
// every operation goes through the same HTTP/鉴权 path as the browser console
// (docs/admin-data-design.md §7: CLI 是 API 的第二皮肤，不是旁路).
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

var errUsage = errors.New("usage")

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, in io.Reader, out, errw io.Writer) int {
	g, rest, err := parseGlobals(args)
	if err != nil {
		fmt.Fprintf(errw, "adminctl: %v\n\n", err)
		printUsage(errw)
		return exitUsage
	}
	if len(rest) == 0 {
		printUsage(errw)
		return exitUsage
	}
	switch rest[0] {
	case "help", "-h", "--help":
		printUsage(out)
		return exitOK
	case "completion":
		if err := cmdCompletion(rest[1:], out); err != nil {
			printError(errw, err)
			return exitCodeFor(err)
		}
		return exitOK
	}
	if err := resolveGlobals(&g); err != nil {
		printError(errw, err)
		return exitCodeFor(err)
	}

	switch rest[0] {
	case "login":
		err = cmdLogin(g, rest[1:], in, out, errw)
	case "whoami":
		err = cmdWhoami(g, rest[1:], out)
	case "users":
		err = cmdUsers(g, rest[1:], out)
	case "kick":
		err = cmdKick(g, rest[1:], out)
	case "reports":
		err = cmdReports(g, rest[1:], out)
	case "messages":
		err = cmdMessages(g, rest[1:], out)
	case "broadcast":
		err = cmdBroadcast(g, rest[1:], out)
	case "flags":
		err = cmdFlags(g, rest[1:], out)
	case "audit":
		err = cmdAudit(g, rest[1:], out)
	case "archive":
		err = cmdArchive(g, rest[1:], out)
	default:
		fmt.Fprintf(errw, "adminctl: unknown command %q\n\n", rest[0])
		printUsage(errw)
		return exitUsage
	}
	if err != nil {
		printError(errw, err)
		return exitCodeFor(err)
	}
	return exitOK
}

// parseGlobals extracts global flags wherever they appear; everything else is
// preserved for the subcommand parser.
func parseGlobals(args []string) (globals, []string, error) {
	var g globals
	var rest []string
	take := func(i *int, inline, name string) (string, error) {
		if inline != "" {
			return inline, nil
		}
		if *i+1 >= len(args) {
			return "", &usageError{msg: "missing value for " + name}
		}
		*i++
		return args[*i], nil
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		var val string
		var err error
		switch {
		case a == "--server" || a == "-server":
			g.Server, err = take(&i, "", a)
		case strings.HasPrefix(a, "--server=") || strings.HasPrefix(a, "-server="):
			g.Server = a[strings.IndexByte(a, '=')+1:]
		case a == "--token":
			g.Token, err = take(&i, "", a)
		case strings.HasPrefix(a, "--token="):
			g.Token = a[len("--token="):]
		case a == "--csrf-token":
			g.CSRF, err = take(&i, "", a)
		case strings.HasPrefix(a, "--csrf-token="):
			g.CSRF = a[len("--csrf-token="):]
		case a == "--output" || a == "-o":
			g.Output, err = take(&i, "", a)
		case strings.HasPrefix(a, "--output=") || strings.HasPrefix(a, "-o="):
			val = a[strings.IndexByte(a, '=')+1:]
			g.Output = val
		case a == "--idempotency-key":
			g.IdemKey, err = take(&i, "", a)
		case strings.HasPrefix(a, "--idempotency-key="):
			g.IdemKey = a[len("--idempotency-key="):]
		case a == "--no-save":
			g.NoSave = true
		default:
			rest = append(rest, a)
		}
		if err != nil {
			return g, nil, err
		}
	}
	if g.Output == "" || g.Output == "table" {
		g.Output = "table"
	}
	if g.Output != "table" && g.Output != "json" {
		return g, nil, &usageError{msg: "invalid --output (want json or table)"}
	}
	return g, rest, nil
}

func resolveGlobals(g *globals) error {
	// A malformed/absent credentials file must not block explicit flags or
	// commands that do not need auth; treat it as empty.
	creds, _ := loadCredentials()
	if g.Server == "" {
		g.Server = os.Getenv("OPENCHAT_ADMIN_URL")
	}
	if g.Server == "" {
		g.Server = creds.Server
	}
	if g.Server == "" {
		g.Server = "http://127.0.0.1:7781"
	}
	if g.Token == "" {
		g.Token = os.Getenv("OPENCHAT_ADMIN_TOKEN")
	}
	if g.Token == "" {
		g.Token = creds.Token
	}
	if g.CSRF == "" {
		g.CSRF = os.Getenv("OPENCHAT_ADMIN_CSRF")
	}
	if g.CSRF == "" {
		g.CSRF = creds.CSRF
	}
	return nil
}

func printUsage(w io.Writer) {
	fmt.Fprint(w, `adminctl — OpenChat management API client

Usage:
  adminctl [global flags] <command> [args]

Commands:
  login                       Interactive password + TOTP login; prints a token
  whoami                      Show the current admin identity
  users list|show|ban|unban   User administration
  kick <uid>                  Disconnect all of a user's sessions
  reports list|show|handle    Report queue / state machine
  messages search|recall      Message search / forced recall
  broadcast preview|send      Broadcast preview (dry run) / send
  flags list|set              Feature flags / policy-as-flag
  audit --since-id <id>       Sequential audit cursor stream
  archive status              Archive job ledger
  completion bash             Print bash completion

Global flags:
  --server <url>              Admin API base URL (env OPENCHAT_ADMIN_URL)
  --token <token>             Bearer token (env OPENCHAT_ADMIN_TOKEN)
  --csrf-token <token>        CSRF token (env OPENCHAT_ADMIN_CSRF)
  --output json|table         Output format (default table)
  --idempotency-key <key>     Explicit key for a write operation
  --no-save                   login only: do not persist credentials

Exit codes: 0 ok, 1 error, 64 usage, 65 not found, 77 permission denied.
`)
}
