# Memory review follow-ups

This record distinguishes implemented behavior from unverified assumptions. The checkpoint
commit preserves the working retrieval and proposal implementation before these follow-ups.

| Review | Decision | Status |
|---|---|---|
| Q1 | Use a conservative allowance when the model window is unknown. | Implemented: 1,024 estimated tokens; regression passed |
| Q2 | Preserve document counts and summary entry points in tight-budget fallback. | Implemented within the available allowance; regression passed |
| Q3 | Retain both the beginning and recent tail of truncated summaries; mark the gap. | Implemented with explicit missing character offsets; regression passed |
| Q4 | Do not claim tokenizer accuracy without reproducible target-model measurements. | Calibration deferred; estimate remains heuristic |
| Q5 / B2 | Keep shared summaries in context and other shared notes available on demand; align copy. | Planned |
| Q6 | Exclude review artifacts from agent context, browsing, reads and ordinary search. Preserve human access. | Implemented; offline regression passed |
| Q7 | Require meaningful absolute character savings before creating a proposal. | Planned |
| Q8 | Preserve complete search results; do not silently cap candidates. Measure worst-case workloads before changing the pagination contract. | Performance evaluation pending |
| Q9 | Document normalized literal substring matching, including spaces. Multi-term AND is a separate feature. | Planned |
| Q10 | Add a read-only index health command and explicit post-deploy/rollback checks. Never backfill on startup. | Planned |
| Q11 | Reserve review paths from ordinary agent writes. | Implemented; offline regression passed |
| B1 | Label the root directory explicitly. | Implemented; regression passed |

Version deduplication prevents repeated proposals for the same document revision. It does not
bound growth when sources change regularly. A daily task examines the current version once,
not every revision written since the previous run. No retention cleanup is authorized here:
existing proposals and their history must remain available.

The proposal threshold controls review usefulness, not semantic completeness. Exact excerpts,
source hashes and complete snapshots also do not establish semantic completeness; human review
remains required before applying a proposal.
