// Package policy loads, validates and snapshots the operational policy
// document (policy.json). It is the SINGLE source of policy truth for the data
// layer: components ask "what is the current retention?", never hardcode
// numbers. It never executes policy — that is each job component's job.
package policy

// Policy is the wire format of /etc/chat/policy.json (docs §4.2).
// All time/duration units are integer seconds/days; crons are 5-field cron.
type Policy struct {
	// HotRetentionDays: messages older than this many days are archivable.
	// The archiver itself never decides how old is old — it reads this.
	HotRetentionDays int `json:"hot_retention_days"`

	// Archive controls the hot->cold copy job (mechanism: jobber+archiver).
	Archive ArchiveConfig `json:"archive"`

	// Backup controls the hot-DB backup job (VACUUM INTO given dir).
	Backup BackupConfig `json:"backup"`

	// Trim lists tables the trimmer deletes expired rows from.
	// Table names are validated against a whitelist — never arbitrary SQL.
	Trim []TrimRule `json:"trim"`

	// RateLimit holds per-bucket thresholds. The rate_limit table provides
	// the counting primitive; these are the limits.
	RateLimit RateLimitConfig `json:"rate_limit"`
}

// ArchiveConfig is the archive job policy.
type ArchiveConfig struct {
	Cron string `json:"cron"` // e.g. "0 4 * * *"
	// NOTE (jobber contract): the job scheduler does NOT implement full cron.
	// It accepts exactly three forms: "@daily HH:00", "@daily HH:MM" and
	// "interval N" (seconds). Classic 5-field values like "0 4 * * *" are
	// ALSO accepted by job.ParseCronKind but reduced to their hour:minute
	// (daily semantics); fields with */n or lists are rejected at parse time.
	// Complex schedules must be simplified by the ASSEMBLY layer into the
	// "@daily HH:MM" form before registering the job unit.
	BatchSize    int    `json:"batch_size"`    // rows per copy transaction, 1..50000
	BatchPauseMS int    `json:"batch_pause_ms"` // pause between batches, 0 allowed
	// ActiveExempt: conversations with recent activity are skipped this run.
	ActiveExempt bool `json:"active_exempt"`
}

// BackupConfig is the backup job policy.
type BackupConfig struct {
	Cron     string `json:"cron"`
	Dir      string `json:"dir"`
	KeepDays int    `json:"keep_days"`
}

// TrimRule is one table's expiry rule. Exactly one of TTLHours /
// RetentionDays must be set (>=1).
type TrimRule struct {
	Table         string `json:"table"` // must be in the trim whitelist
	TTLHours      int    `json:"ttl_hours,omitempty"`
	RetentionDays int    `json:"retention_days,omitempty"`
}

// RateLimitConfig holds bucket thresholds.
type RateLimitConfig struct {
	MsgPerUserPerMin  int `json:"msg_per_user_per_min"`
	LoginPerIPPerMin  int `json:"login_per_ip_per_min"`
}

// Snapshot pairs a Policy with its version, so callers can detect reloads.
type Snapshot struct {
	Policy  Policy
	Version int // monotonically increasing; bumps on every successful Reload
}

// Default returns the built-in baseline policy. Real deployments override
// via policy.json; defaults exist so a missing field degrades predictably.
func Default() Policy {
	return Policy{
		HotRetentionDays: 90,
		Archive: ArchiveConfig{
			Cron:         "0 4 * * *",
			BatchSize:    1000,
			BatchPauseMS: 100,
			ActiveExempt: true,
		},
		Backup: BackupConfig{
			Cron:     "0 3 * * *",
			Dir:      "/var/lib/chat/backup",
			KeepDays: 14,
		},
		Trim: []TrimRule{
			{Table: "sys_rate_limit", RetentionDays: 7},
			{Table: "identity_login_history", RetentionDays: 180},
		},
		RateLimit: RateLimitConfig{
			MsgPerUserPerMin: 60,
			LoginPerIPPerMin: 10,
		},
	}
}
