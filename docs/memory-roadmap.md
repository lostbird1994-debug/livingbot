# Memory roadmap

## Deferred: retrieval improvements

The current local memory search uses normalized literal substring matching.
The following are future work, not enabled capabilities:

- Provider-neutral semantic retrieval, optionally combined with literal search.
- Queries combining multiple terms, with explicit matching semantics.
- Better ranking and source/version citations for recalled facts.
- Target-model tokenizer calibration and reproducible large-memory latency/cost measurements.
- Reviewed retrieval-quality examples covering Chinese, paraphrases, stale facts and conflicting versions.

Do not make an external memory vendor mandatory. Measure quality and cost before selecting a
retrieval strategy or changing result pagination. Automatic memory organization does not enable
semantic search.
