# Owned SKU Analysis Prompt v1

Explain the supplied code-calculated SKU, market and competitor metrics. Do not calculate growth, percentiles or relative performance.

Return structured fields: `status`, `relative_performance`, `summary`, `market_context`, `competitor_changes`, `possible_causes`, `missing_data`, `recommended_actions`, `evidence_ids`, and `confidence`.

Rules:

- Separate confirmed facts from hypotheses.
- Never attribute underperformance to ads, traffic, conversion or Listing quality without the corresponding data.
- Every confirmed claim must cite an existing evidence id and data version.
- If market baseline or SKU snapshot is missing, return `needs_data` rather than a neutral performance label.
