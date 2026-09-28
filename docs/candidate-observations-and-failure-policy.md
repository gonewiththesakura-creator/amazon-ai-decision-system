# Candidate observations and sync failure policy

Migration V35 separates candidate identity/review state from provider observations.

- The candidate key remains `(marketplace, source_product_id, asin)`. New candidate payloads contain only the ASIN. `first_seen_at` and `last_seen_at` track identity sightings; manual review status is preserved.
- Price, estimated sales, revenue, rating, review count, BSR, title and brand live in append-only `competitor_candidate_observations`. Each acquisition has its own ID, collection time, normalized payload, provenance and run ID. A schema hash is copied only from the matching local acquisition; unknown hashes remain null.
- Repeated identities create a new observation and a run link referencing that observation. Price/sales changes are expected. Changed non-null title, brand or parent ASIN sets `identity_review_required`, without discarding observations or resetting manual review.
- V35 copies legacy candidate payloads into immutable observations marked `legacy=1`; it does not invent provenance or new verification links. The old payload column remains for backward compatibility, not as the current dynamic-data store. Candidate listing and confirmation read the latest observation.
- Fresh incremental discovery may reuse a prior observation link without pretending it was acquired again. New Certification coverage requires non-legacy observations belonging to that run. Legacy coverage retains its existing validation contract.

Certification and force stop at the first required failure. No remaining Discovery or secondary refresh calls run after the failure. Validated observations already persisted remain audit records; the parent run is failed and cannot satisfy Go Live. Database triggers prevent failed MCP tasks from returning to running/success and prevent failed coverage from being completed.

Incremental Discovery and secondary refresh retain partial/continue behavior. Incremental primary Trend also continues after individual failures: a partially completed primary batch remains partial with incomplete coverage. If every Trend fails, the batch fails. Strict modes persist each validated primary observation before advancing, so later failures do not erase successful audit data.

Regression coverage includes changed prices, stable candidate identity, current-run observation links, immutable history, identity review flags, latest-observation reads, strict-mode short-circuiting, incremental partial results, mid-run audit retention and failed-run Go Live exclusion. Real-response replay must use an isolated database copy and an injected offline port; never instantiate a remote adapter or resume a failed production run.
