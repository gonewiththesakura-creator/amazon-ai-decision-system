---
name: amazon-product-research
description: Run adjacent-product or new-opportunity research from a task book through hard gates, scoring, reverse review, and human approval.
---

# Amazon Product Research

## Goal

Turn a product idea into a reproducible decision package without allowing score or AI enthusiasm to bypass hard constraints.

## Inputs

- Complete Research Task Book.
- Normalized market, product, keyword, review, cost, supply-chain, compliance and IP inputs.
- Locked new-product RuleProfile.

## Output

Hard-gate result, score breakdown, Evidence, Missing Data, Review Gap, Reverse Review and Approval Request.

## Workflow

1. Create/validate the task book.
2. Collect through adapters and normalize units.
3. Stop at `needs_data` for missing critical fields.
4. Execute hard gates before scoring; rejection is not averaged away.
5. Calculate score components in code.
6. Run Review Gap and Reverse Review.
7. Open Approval Gate with facts, unknowns, risk and next action.

## Prohibited

- Automatic supplier contact, payment, purchase, certification or patent approval.
- Scoring before hard-gate validation.
- Inventing profit, MOQ, ad, return, logistics or compliance inputs.

## Failure Conditions

Reject on configured critical hard gates. Use `needs_data` when a required gate cannot be evaluated. Fail malformed or untraceable data.
