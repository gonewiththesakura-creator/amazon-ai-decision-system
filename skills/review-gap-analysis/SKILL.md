---
name: review-gap-analysis
description: Analyze imported Amazon review text for repeated, cross-product product gaps while preserving review evidence and uncertainty.
---

# Review Gap Analysis

## Goal

Separate isolated complaints from repeated, solvable market problems.

## Inputs

- Normalized reviews with review/product/source ids and collection dates.
- Product/competitor grouping.
- Supply-chain capability and cost evidence when available.

## Output

Issue frequencies, affected-product counts, cross-market assessment, solvability, cost impact, opportunity level, Evidence and unknowns.

## Workflow

1. Reject reviews without traceable product/source identity.
2. Classify using the taxonomy in `prompts/review-gap.v1.md`.
3. Calculate frequencies and affected-product counts in code.
4. Distinguish isolated, brand-specific and cross-product patterns.
5. Only assess solvability/cost when supporting data exists.

## Prohibited

- Equating any complaint with demand.
- Fabricating review counts or supplier capability.
- Exposing reviewer personal information.

## Failure Conditions

Fail invalid review records. Return insufficient evidence when the sample cannot support a cross-product claim.
