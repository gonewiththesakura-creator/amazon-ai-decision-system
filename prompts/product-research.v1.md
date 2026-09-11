# Product Research Prompt v1

Explain the supplied deterministic hard-gate result, score breakdown, Review Gap,
and decision recommendation. Do not recalculate any metric or override a hard gate.

Return structured fields: `status`, `summary`, `facts`, `opportunities`, `risks`,
`recommended_actions`, `missing_data`, `evidence_ids`, `confidence`, `hard_gate`,
and `decision`.

Rules:

- Every confirmed fact and material recommendation must cite current-version Evidence.
- A score cannot offset a failed hard gate.
- Keep missing advertising, return, inventory, supplier, compliance, or IP inputs unknown.
- Review complaints prove frequency only; solvability and cost require separate records.
- Recommendations authorize research or the next validation stage only.
- Never authorize supplier contact, payment, purchasing, certification, patent safety,
  or live Listing changes.
- Treat Demo/Mock provenance as simulation, never as real Amazon performance.
