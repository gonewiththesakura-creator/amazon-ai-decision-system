# V2.2 Real Data Plan

## Goal

Run one stable, correct, traceable production-data chain from SellerSprite MCP through normalization, immutable snapshots, deterministic rules, dashboard reads, and Evidence. Preserve the existing V2 workflow and V2.1.1 executive dashboard.

## Current Database Impact

- Keep the incremental SQLite migration model and all existing product, market, workflow, rule, prompt, evidence, approval, and decision records.
- Extend product master records with lifecycle and variation identity fields; do not encode a fixed SKU count.
- Add explicit observation dates and stable deduplication keys to market and product snapshots while keeping `collected_at` as acquisition time.
- Store facts from different sources independently. Resolve display authority at read/analysis time instead of overwriting lower-priority facts.
- Add MCP capability snapshots, call ledger, response cache, competitor candidates, and refresh coverage records. No table may contain credentials.

## Migration

- Add a new transactional, forward-only migration after the current schema version.
- Backfill legacy snapshot observation dates from their existing business `date`, not from `collected_at`.
- Backfill deterministic deduplication keys and create uniqueness constraints that prevent duplicate observations for the same marketplace, entity, business date, source, and period.
- Add indexes for product identity, observation lookups, candidate review, MCP audit, cache expiry, and coverage reads.
- Cover fresh database creation and upgrade from the current V2.1.1 schema with migration tests.

## Product Master And Variation

- Extend product master with `status`, `updated_at`, `variation_family_id`, `parent_asin`, `is_parent`, and structured variation attributes.
- Add `variation_families` with marketplace-scoped parent ASIN identity.
- Implement a deterministic `ProductIdentityResolver` for marketplace + ASIN/SKU and parent/child/family association.
- Preserve inactive product history; deactivation is a status transition, not physical deletion.
- Avoid parent/child double counting in portfolio aggregates.

## MCP Transport

- Replace the unavailable adapter stub with a server-only Streamable HTTP client.
- Read only `SELLERSPRITE_MCP_URL` and `SELLERSPRITE_MCP_SECRET`; redact query credentials, authorization headers, tokens, and secrets from errors and logs.
- Implement connection diagnostics, `listTools`, `callTool`, timeout, bounded retry with exponential backoff, rate limiting, schema validation, cache, and typed error mapping.
- Persist sanitized capability snapshots and one ledger record for every attempted remote call.
- Keep dashboard GET requests database-only. MCP calls run only from explicit sync/data-task/research workflows.

## First Tool Mapping

Discover the runtime schemas before mapping. Stable internal capabilities are:

- `MARKET_RESEARCH`
- `MARKET_STATISTICS`
- `PRODUCT_CONCENTRATION`
- `ASIN_SALES_TREND`
- `ASIN_COMPETITOR_DISCOVERY`

The registry maps these capabilities to actual SellerSprite tools and validates required arguments from the discovered schemas. Business services never scatter remote tool-name strings.

## Real Data Pipeline

- Market sync: actual market/statistics/concentration response -> validate -> normalize -> deduplicate -> market snapshots and product facts.
- Owned ASIN sync: actual trend response -> validate -> preserve business observation dates -> product snapshots.
- Competitor discovery: actual response -> candidate records only. Human confirmation is required before promotion to a core direct competitor.
- Critical refresh (primary market + all active owned products) is atomic. Secondary competitor refresh can be partial and records coverage.
- Rule Engine and Evidence consume only persisted, versioned facts; missing fields remain null and can block analysis.

## Run-Level Traceability

- Every critical refresh creates one server-generated `runId`. Its fresh `listTools`, capability snapshot, current and previous month market calls, every active real owned-ASIN call, candidate/direct-competitor coverage, tasks, immutable observation links, and downstream Evidence retain that run identity.
- Go Live accepts only one complete critical run for the current marketplace, verified node path, and current owned-SKU roster. Independent successes from different runs cannot be assembled into proof.
- Critical market tools must declare the requested `month` in their discovered schemas, and statistics/concentration responses must echo the matching month before persistence.
- Live reads reject Mock and failed/running MCP observations. A failed refresh retains the last legal real Snapshot and reports partial update; it never falls back to Mock.
- Demo/manual history is itemized in Cleanup Dry Run and is not deleted merely because it appears in the review list.

## Import Strategy

- Retain CSV/XLSX as historical backfill and outage fallback through adapters, normalization, identity resolution, deduplication, and snapshots.
- Add product-master import fields for marketplace, ASIN, SKU, internal name, brand, product type, parent ASIN, variation theme, market node, and monitoring status.
- Separate preview from confirmation. Preview reports detected type, new rows, duplicates, and errors; unknown files require explicit type confirmation.
- Reimporting identical observations is idempotent and never doubles metrics.

## Demo Cleanup Strategy

- Add `GoLiveMigrationService.preview`, `backup`, `clearDemoObservations`, `verify`, and `activateLiveMode`.
- Prove connection, tool discovery, real market/ASIN calls, isolated snapshot writes, and data correctness before cleanup.
- Dry run reports exact deletion and preservation counts. Cleanup deletes only explicitly demo/mock observations and seeded demo descendants; it preserves product master, rules/settings, and all real workflow lineage.
- Activation fails unless no mock observations remain and minimum real-data coverage is present. Live mode never falls back to MockAdapter.

## Data Authority

- Owned sales: Amazon API actual > Amazon report import > SellerSprite estimate.
- Market and competitor metrics: SellerSprite MCP > SellerSprite import > other third party.
- Ads: Amazon Ads API > Amazon Ads report.
- Cost/supply chain: internal system > reviewed manual/import data.
- The resolver returns the selected fact, source, alternatives, and an explicit reason.

## Dynamic SKU And Coverage

- All active owned products come from product master. Validate 0, 1, 4, 5, 12, and 50 SKU cases.
- Trend charts render at most five selected/focus SKUs plus market; dense portfolios use ranked/focus views and the complete owned-products page.
- Admin coverage exposes primary market, owned SKU, core competitor, history, and actual Amazon-data coverage. The executive dashboard shows only concise freshness/partial status.

## Test Plan

- Migration from V2.1.1 and fresh database.
- Observation-date preservation and snapshot idempotency.
- Product identity and parent/child aggregation safety.
- Metric authority with simultaneous actual and estimated facts.
- Mocked MCP transport contract, schema drift, auth/rate-limit/timeout/tool-not-found mapping, retry, cache, rate limit, ledger, and redaction.
- Live mode no-mock fallback and database-only dashboard GET.
- Go Live dry run, scoped cleanup, verification, and activation guards.
- Single-run Go Live proof, cross-run Evidence rejection, current-roster drift, and failed-run observation readability.
- Import detection/preview/confirmation/idempotency and historical backfill.
- Dynamic 0/1/4/5/12/50 SKU regression and coverage behavior.
- Real smoke checks: connection, discovered schemas, one memory-foam market, one owned ASIN when supplied in product master, competitor candidates, snapshots, rule output, dashboard, and Evidence.
- Final commands: `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.

## Explicitly Out Of Scope

- Full SellerSprite tool catalog, Amazon Ads, automated advertising, purchasing, replenishment, finance systems, autonomous procurement/payment, patent-safety decisions, online Listing changes, full SP-API implementation, a scheduler, broad agent-selected MCP calls, and another dashboard redesign.

## Delivery And Security

- Commit only code, migrations, tests, empty environment-variable examples, import templates, and sanitized verification artifacts.
- Never commit or return the SellerSprite secret. Real-data fixtures and screenshots must not expose private business data unless explicitly approved.
- Report actual live-test coverage separately from mocked-contract coverage; never label Demo/Mock data as real.
