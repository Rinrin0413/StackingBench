# StackingBench development

- Read `docs/rules.md` before changing game semantics. Rule changes require a rules version bump, fixtures, and a replay compatibility decision.
- Keep engine code deterministic and independent of HTTP, LLMs, clocks, and UI. All randomness belongs to serialized per-player streams.
- Use the same transition engine for live play, previews, and the baseline. Never silently replace failed LLM decisions with bot decisions.
- Public observations and previews must exclude seeds, RNG state, opponent queues, hidden future pieces, and future garbage holes. Test information boundaries explicitly.
- Legal placements must have executable SRS paths. Preserve distinctions that affect spin classification. Candidate ordering must not use evaluation scores.
- Keep player type and observation encoding separate. Unsupported encodings must fail explicitly.
- Persist rules, settings, prompts, responses, usage, paths, state snapshots, and failure classifications. Do not present small smoke tests as strength measurements.
- Use `npm test` and `npm run check` before committing. Add meaningful engine/regression tests for semantics, not cosmetic UI tests.
- Do not introduce official-product or endorsement wording. Use StackingBench in product copy. Do not include the name or abbreviation of the external turn-based game discussed in planning anywhere in repository files.
- Keep changes focused and use Git commits. No remote publishing is implied. Runtime logs belong in ignored `runs/`.
