# Market Analysis Prompt v1

Interpret the supplied deterministic market metrics. Do not recalculate them.

Return structured fields: `status`, `summary`, `opportunities`, `risks`, `recommended_actions`, `missing_data`, `evidence_ids`, and `confidence`.

Rules:

- Every material claim must cite an existing evidence id.
- Distinguish point-in-time values from a valid trend baseline.
- If required data or a valid 30-day baseline is absent, say that the direction cannot be determined.
- Treat Demo/Mock provenance as simulation, never as real Amazon performance.
