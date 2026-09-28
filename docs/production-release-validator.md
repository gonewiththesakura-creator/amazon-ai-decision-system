# Production Live validation

The validator is read-only and never activates Live, migrates, calls a provider, or repairs data.

Before activation stop service connections, create an independent SQLite backup, verify integrity/FKs and Golden evidence, and preserve its physical hash and rollback path. Production cleanup is SKIPPED_NOOP. Activation is separately authorized and may change only `app_settings.id=1.mode` from `empty` to `live`.

Run `npx --no-install tsx server/scripts/production-release-validator.ts activation PRE_LIVE_BACKUP PRODUCTION_DB` immediately after activation. Then run read-only page smoke with outbound requests blocked. Any failure requires stopping connections and restoring the backup, preserving failed DB/WAL/SHM for audit; do not retry automatically. Run the same validator with `rollback` to prove restoration.

Comparison canonicalizes own object keys, ignores JavaScript prototypes, preserves scalar types, nulls and array order, and compares all schema/table content. Row order is canonicalized for database reads. Per-table counts and logical hashes must match except the one permitted mode field. File SHA may change after activation; it is a backup identity, not an activation equality criterion.

The pinned Golden run, PASS, Evidence 4/4, LIMITED/LIMITED, roster 5, competitors 5, relations 9, zero Mock and unchanged MCP call/usage ledgers remain mandatory. No acquisition, V38 schema, mapping, Evidence or Sufficiency rules are modified by this validator.
