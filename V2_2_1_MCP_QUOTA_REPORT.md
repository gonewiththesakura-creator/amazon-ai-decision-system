# V2.2.1 MCP Quota & Local-First delivery

## Behavior

Incremental is the default. Valid immutable snapshots are read before validated
local capability acquisitions and persistent raw cache. Closed month acquisitions
are stable after a successful collection in a later month. Original acquisition
timestamps are preserved. Certification reuses certified closed-month market snapshots
with immutable current-run lineage; other certification acquisitions and force bypass reuse, require a reviewed,
single-use, ten-minute plan, and are recorded separately. Incremental and force
coverage cannot satisfy the Go Live certification check.

LIST_TOOLS is not refreshed per small task. Within the original snapshot TTL,
restore the requested capability locally, even when unrelated tools contain
redacted fields. Refresh only for expiry, missing requested tools, a requested
schema mismatch, explicitly fresh Certification, or an administrator refresh.
Loading a snapshot does not extend its TTL. Targeted schema redaction is treated
as a mismatch; it is never repaired by guessing hidden parameter names.

The plan is a conservative estimate; retries and tool-list pagination are bounded
by a separate displayed maximum. Every actual tool/page/attempt decrements the
SQLite quota estimate atomically. Incremental confirmations never bypass the
100-call reserve. Explicit certification/force can use the reserve. No reset date
is assumed. A task may stop after partial acquisition when another task consumes
the remaining budget; immutable business observations are retained.

Identical calls coalesce before rate limiting. Persistent cache fills additionally
use renewable SQLite leases across clients/processes. Certification runs retain
separate run identities. Retries are limited to one. Three consecutive failures
of the same kind open a fifteen-minute circuit; only one half-open probe is allowed.

Discovery reuses its candidate pool for fourteen days, including a successful empty
result. Core competitor TTL is seven days, doubled in conserve mode. Below 150,
secondary remote calls stop; below the reserve automatic remote calls stop.
Schema changes pause the affected capability until an Admin reviews the exact
schema hash. Older privacy-masked capability snapshots need one discovery to
recover callable argument structure. Credentials and business values stay redacted.

Dashboard refresh reads the database only. Data-source settings expose quota,
calibration, configurable TTLs, audit details, preview/confirm modes, circuit reset
and schema review. The real acceptance CLI defaults to a dry plan; executing
requires `--confirm-plan <id>` after reviewing it.

## Business database inventory (2026-09-24)

Measured against a consistent temporary copy of
`data/real-chain-market-research-20260922.db`; the reporting command does not mutate
or migrate the source database and does not construct an MCP transport.

| Requested result | Observed result |
| --- | --- |
| Existing local data | 2 MCP market snapshots, 5 product snapshots, 59 metric facts, 17 candidates |
| Currently reusable acquisitions | 2 market snapshots; product acquisitions exceed the 24-hour TTL |
| Stable historical months | July and August 2026; incremental market sync does not re-fetch them |
| Ordinary September sync estimate | At most 6 base calls; maximum 14 including retry/pagination |
| Certification estimate | 9 base calls; maximum 20 including retry/pagination |
| Local hit rate | No production sample yet; do not report a fabricated 80% |
| Remaining quota estimate | Approximately 500, manually supplied baseline; 100 reserved; reset unknown |
| Freshness skips | August's three market capabilities are reused in the September plan |
| Budget blocks | None in the read-only production inspection; offline tests verify 70-call balance and circuit blocking |

The estimates cover the **currently active single owned SKU**, not the intended
five-SKU roster. The expected roster remains `pending_validation`, so both plans
are blocked before remote execution. A complete five-SKU import/confirmation
changes the scope and requires a new plan. No real certification, Demo cleanup,
Live activation, or PR merge was performed. No real MCP calls were made.

## Verification and operation

Verified: lint, typecheck, production build, and **850 tests across 58 files**.
Commands: `npm run lint`, `npm run typecheck`, `npm test -- --maxWorkers=4`, and
`npm run build`. The worker limit avoids Windows CPU contention causing an existing
five-second test timeout. Coverage includes the ten quota acceptance scenarios,
cross-client deduplication, shortened policy invalidation, UI confirmation,
migrations, immutable observations, empty/Demo state, needs_data, Evidence,
Hard Gates, Reverse Review, Approval, and existing V2 end-to-end workflows.

To reproduce the private local inventory without modifying business state:

```powershell
npx tsx server/scripts/quota-report.ts data/real-chain-market-research-20260922.db
```

V32 migration is additive. Back up the runtime database before starting the new
server. Business snapshots/facts are never deleted or overwritten. This patch
does not include local databases, migration archives, `.env`, or unrelated edits.
