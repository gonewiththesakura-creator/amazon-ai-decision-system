# V2.2.1 MCP Quota & Local-First Plan

## Scope

Implement the supplied quota/local-first requirements on `codex/v2.2-real-data`.
Keep immutable observations, null semantics, Hard Gates and same-run certification
proof. Incremental reuse must never manufacture fresh Go Live evidence.
No real MCP calls are needed for implementation or automated verification.

## Implementation

1. Add forward-only storage for quota baseline, remote attempts, policy, local
   acquisitions and circuit state. The initial approximately 500 calls is an
   estimate, with 100 protected calls and no assumed reset date.
2. Separate incremental (default), certification and force. Add a call plan and
   explicit confirmation for certification/force and plans over 20 calls.
3. Resolve validated local observations before persistent cache and remote;
   reuse certified closed months permanently and apply configurable freshness
   periods to current market, owned SKU, competitors, discovery and identity.
4. Reuse capability definitions for seven days and connection diagnostics for
   thirty minutes. Detect schema changes and stop automatic affected calls.
5. Enforce quota at the transport boundary for each page/attempt, cap retries at
   one, coalesce identical concurrent requests and stop provider failure storms.
6. Add Admin quota calibration, estimates, plan/confirm controls and audit
   outcomes. Dashboard reads remain database-only.
7. Test the ten supplied scenarios and existing migration, empty/Demo,
   append-only Snapshot, needs_data, Evidence, Hard Gate, Reverse Review,
   Approval and V2 end-to-end behavior. Run lint, typecheck, test and build.

## Delivery

Report local reusable observations, stable months, incremental/certification
plans, observed hit rates, estimated remaining budget and skip/block reasons.
Existing pending roster and data gaps remain explicit. PR #1 stays open.
