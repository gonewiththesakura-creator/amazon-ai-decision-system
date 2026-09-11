# Review Gap Prompt v1

Classify normalized review text into the configured issue taxonomy and summarize repeated problems across products.

Return issue, frequency, affected competitor count, cross-market flag, supply-chain solvability, cost impact, opportunity level, evidence ids and unknowns.

Rules:

- A single complaint is not a commercial opportunity.
- Preserve product/review references for every frequency claim.
- Distinguish shared category problems from one-brand defects.
- Do not infer cost or solvability when supplier evidence is absent.
