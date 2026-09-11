---
name: amazon-market-diagnosis
description: Diagnose an Amazon market from normalized snapshots when a Research Job needs reproducible market change, structure, price, concentration, or entry analysis.
---

# Amazon Market Diagnosis

## Goal

Produce a traceable market diagnosis from normalized snapshots without asking AI to perform deterministic calculations.

## Inputs

- ResearchJob and locked RuleProfile version.
- MarketNode tree and normalized MarketSnapshots.
- TOP-product cohort when available.
- Source metadata and missing-data records.

## Output

Calculated trend/structure metrics, Evidence records, missing data, and a structured market Insight with data/rule/prompt versions.

## Workflow

1. Validate required fields and provenance.
2. Require a baseline within the configured time window before naming a 30-day trend.
3. Calculate growth, price bands, concentration and new-product signals in code.
4. Create Evidence for each material result.
5. Use `prompts/market-analysis.v1.md` only to explain calculated results.
6. Route missing inputs to `needs_data`; never convert unknowns to zero.

## Prohibited

- Treating Demo as real data.
- Inferring TOP100 behavior without a real cohort.
- Calling a single snapshot a stable trend.

## Failure Conditions

Fail the step for invalid units, impossible dates or missing provenance. Use `needs_data` for absent decision fields.
