package policy

import (
	"fmt"
	"strings"
)

// TrimWhitelist is the closed set of tables the trimmer may ever touch.
// Anything else in policy.trim is rejected at load time — the trimmer only
// ever deletes with a fixed (table, expiry-column, TTL) plan, no dynamic SQL.
var TrimWhitelist = map[string]bool{
	"sys_rate_limit":         true,
	"identity_login_history": true,
}

// Validate checks semantic legality of a Policy and returns one error per
// offending field, in stable order. Empty result means valid.
func Validate(p Policy) []error {
	var errs []error

	if p.HotRetentionDays < 1 {
		errs = append(errs, fieldErr("hot_retention_days", "must be >= 1 (0 would archive everything immediately)"))
	}

	// archive
	if strings.TrimSpace(p.Archive.Cron) == "" {
		errs = append(errs, fieldErr("archive.cron", "must not be empty"))
	}
	if p.Archive.BatchSize < 1 || p.Archive.BatchSize > 50000 {
		errs = append(errs, fieldErr("archive.batch_size", "must be within 1..50000"))
	}
	if p.Archive.BatchPauseMS < 0 {
		errs = append(errs, fieldErr("archive.batch_pause_ms", "must be >= 0"))
	}

	// backup
	if strings.TrimSpace(p.Backup.Cron) == "" {
		errs = append(errs, fieldErr("backup.cron", "must not be empty"))
	}
	if strings.TrimSpace(p.Backup.Dir) == "" {
		errs = append(errs, fieldErr("backup.dir", "must not be empty"))
	}
	if p.Backup.KeepDays < 1 {
		errs = append(errs, fieldErr("backup.keep_days", "must be >= 1"))
	}

	// trim: whitelist + exactly-one-of ttl_hours/retention_days
	for i, r := range p.Trim {
		if !TrimWhitelist[r.Table] {
			errs = append(errs, fieldErr(fmt.Sprintf("trim[%d].table", i),
				fmt.Sprintf("table %q is not in the trim whitelist", r.Table)))
			continue
		}
		ttl, days := r.TTLHours >= 1, r.RetentionDays >= 1
		switch {
		case ttl && days:
			errs = append(errs, fieldErr(fmt.Sprintf("trim[%d]", i),
				"ttl_hours and retention_days are mutually exclusive"))
		case !ttl && !days:
			errs = append(errs, fieldErr(fmt.Sprintf("trim[%d]", i),
				"one of ttl_hours / retention_days is required (>=1)"))
		case r.TTLHours < 0 || r.RetentionDays < 0:
			errs = append(errs, fieldErr(fmt.Sprintf("trim[%d]", i), "negative value"))
		}
	}

	// rate_limit: non-positive means "no limit", which must be explicit policy,
	// not an accident of a missing field — reject.
	if p.RateLimit.MsgPerUserPerMin < 1 {
		errs = append(errs, fieldErr("rate_limit.msg_per_user_per_min", "must be >= 1"))
	}
	if p.RateLimit.LoginPerIPPerMin < 1 {
		errs = append(errs, fieldErr("rate_limit.login_per_ip_per_min", "must be >= 1"))
	}

	return errs
}

// fieldErr formats a single field error for Validate's result.
func fieldErr(field, msg string) error {
	return fmt.Errorf("policy: %s: %s", field, msg)
}
