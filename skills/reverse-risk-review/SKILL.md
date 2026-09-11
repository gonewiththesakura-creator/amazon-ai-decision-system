---
name: reverse-risk-review
description: Challenge a proposed Amazon product decision before approval by identifying evidence-backed failure modes, unresolved unknowns, and required validation.
---

# Reverse Risk Review

## Goal

Prevent a favorable score from hiding a fatal or unresolved product risk.

## Inputs

- ResearchJob, task book, hard-gate and score executions.
- Current Insight, Evidence, Review Gap and Missing Data.
- Locked RuleProfile and `prompts/reverse-review.v1.md`.

## Output

Verdict, up to five prioritized failure modes, severity, Evidence, resolution state, required actions and unknowns.

## Workflow

1. Check every mandatory risk category in the versioned prompt.
2. Separate evidenced risks from untested unknowns.
3. Mark a risk resolved only with a cited record.
4. Block `approved` while critical unresolved risks or required missing data remain.
5. Send the complete package to a human Approval Gate.

## Prohibited

- Declaring IP, compliance or certification safe.
- Resolving a risk from an AI assertion.
- Triggering external or financial actions.

## Failure Conditions

Use `needs_data` when required risk inputs are absent. Fail if referenced Evidence does not exist or belongs to another ResearchJob/data version.
