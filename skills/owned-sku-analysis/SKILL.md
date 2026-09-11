---
name: owned-sku-analysis
description: Diagnose an owned Amazon SKU against its market and competitor cohorts when a Research Job needs relative performance and actionable evidence.
---

# Owned SKU Analysis

## Goal

Determine whether an owned SKU is outperforming its market and explain only what the available evidence supports.

## Inputs

- Owned ProductSnapshot history.
- Linked MarketNode and valid market-growth baseline.
- Verified direct, TOP100, benchmark and fast-growth relations.
- Locked relative-performance RuleProfile.

## Output

Code-calculated relative performance, competitor deltas, anomalies, Evidence, missing data and a structured SKU Insight.

## Workflow

1. Verify SKU and market snapshots use comparable periods.
2. Calculate `SKU growth - market growth` using the locked thresholds.
3. Calculate competitor cohort statistics and record sample sizes.
4. Create Evidence with the exact calculation and source records.
5. Explain with `prompts/owned-sku-analysis.v1.md`.
6. List unavailable ads, Sessions, CVR, returns or Listing inputs as unknowns.

## Prohibited

- Assigning `in_line` when either side lacks data.
- Attributing a cause from performance correlation alone.
- Using unverified competitor relationships as facts.

## Failure Conditions

Use `needs_data` for missing comparable snapshots. Fail for cross-market links, invalid periods or untraceable sources.
