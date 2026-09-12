# V2.1.1 Correctness Patch Plan

## Scope

This patch corrects executive-dashboard semantics without changing the V2 workflow invariants. It separates business-data freshness from task synchronization, compares trends on a shared baseline, separates system recommendations from human approval, and makes live refreshes route through explicit data adapters.

## Workstreams

### 1. Core freshness and sync state

- Add a dashboard freshness service that derives required entities from the configured main market, owned products, and direct competitors used by the dashboard.
- Use the latest immutable snapshot for every required entity. `oldestRequiredSnapshotAt` is the dashboard freshness time; missing snapshots remain missing rather than becoming zero.
- Mark complete but materially misaligned snapshot sets as stale, and preserve old charts when a relevant refresh fails.
- Scope relevant task failures to the entities and marketplace used by the dashboard.
- Return system-wide sync state separately so an unrelated task failure cannot change business-data freshness.

Acceptance cases:

- A failed task for another market does not change the main dashboard freshness.
- Different dates for market and owned-product snapshots produce a stale/partial business status and the oldest required timestamp.
- A relevant refresh failure leaves existing metrics visible and reports the fallback to old snapshots.
- A required entity without a snapshot produces `insufficient`/`needs_data`, never a fabricated zero.

### 2. Shared trend baseline

- Build a pure server-side common-baseline indexer.
- Prefer the first positive date shared by all eligible participating series.
- Exclude series with insufficient history; when a full cohort has no common date, degrade only to a market plus a valid owned-SKU subset (at least two SKUs on the dashboard).
- For SKU Focus, require the SKU and market; include the direct-competitor average only when it shares the same valid baseline.
- Return the common baseline date and excluded-series metadata.
- Calculate `relativeToMarket` only on the server and remove all client-side fallback calculations.

Acceptance cases:

- SKU A beginning on 09-01 and SKU B beginning on 09-10 both index to 100 on the shared 09-10 baseline.
- A one-point SKU series is excluded and reported.
- No configured market never causes an owned SKU to be labelled as the market baseline.

### 3. Recommendation and approval semantics

- Replace the overloaded recommendation field with `systemRecommendation`, derived from the current versioned Rule/Score/AI workflow output.
- Add independent `approvalStatus` and optional `approvedAction` from the current ApprovalRecord/ResearchJob.
- Preserve a valid score after a human watch/reject decision.
- Aggregate research-status counts from `systemRecommendation` only.
- Display system advice and approval state as two separate labels.

Acceptance cases:

- A `test` system recommendation awaiting approval remains `test` plus `waiting`.
- Human watch/reject does not rewrite the system recommendation or erase its score.
- A hard-gate rejection reports approval as `not_required`.

### 4. Data-source routing

- Add a `DataSourceRouter` over the adapter registry, keyed by task type, entity type, mode, and optional explicit source preference.
- Demo refreshes may resolve to Mock; live refreshes must resolve to a configured real/import adapter or fail explicitly.
- Pass the resolved adapter into snapshot refresh methods; remove direct MockAdapter ownership from the service.
- Store the resolved adapter identity and provenance in DataTask/Snapshot records.

Acceptance cases:

- Demo dashboard refresh appends snapshots through MockAdapter.
- Live `manual_refresh` or dashboard refresh never falls back to MockAdapter.
- An unavailable live source creates a clear failed task and appends no snapshot.

### 5. UI correctness and CI

- Replace fixed “4 SKU” navigation/page copy with data-driven or generic wording.
- Show “尚未设置主市场” and a Settings action when no main market exists.
- Add Node 22 CI for install, lint, typecheck, tests, and build.
- Add targeted service, route, and component regressions for all corrected semantics.

## Verification

Run:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

Also verify migration tests, empty mode, Demo labels, two append-only refreshes, `needs_data`, Hard Gate rejection, Evidence lineage, Reverse Review, Approval, and both V2 end-to-end workflows. Capture desktop screenshots for the dashboard, SKU Focus, and development recommendation status.
