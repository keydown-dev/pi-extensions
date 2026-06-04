# Ralph handoff-out

Iteration: 3

## Summary

Implemented `subagent_loop_insert_todo_subtask` resolution chains for unfinished loop todos, including state metadata, deterministic flat sibling placement, run eligibility for queued resolution chains, resolution completion semantics, enriched handoff-in context, tests, and documentation updates.

## Changed files

- packages/loops/src/types.ts
- packages/loops/src/store.ts
- packages/loops/src/orchestrator.ts
- packages/loops/extensions/orchestrator.ts
- packages/loops/tests/orchestrator.test.ts
- packages/loops/README.md
- packages/loops/docs/protocol.md
- packages/loops/skills/subagent-loop/refs/tool-usage.md
- .ralph/orchestrator/loops/subagent-loop-recovery-tools/iterations/003/verification.md
- .ralph/orchestrator/loops/subagent-loop-recovery-tools/iterations/003/handoff-out.md

## Commit subject

feat: add resolution subtask chains

## Decisions

- Added a dedicated orchestrator method and Pi tool rather than overloading generic todo insertion.
- Resolution subtasks use explicit flat IDs (`NNN.1-...`, `NNN.2-...`) and normalize subtask targets back to the root chain.
- Failed resolution subtasks do not resolve parents, but a later queued sibling can make the chain runnable again.

## Risks

- The ID validation is intentionally lightweight and numeric-prefix based; unusual nonnumeric root IDs fall back to the whole root ID as the expected prefix.

## Next suggested task

Run the next planned issue slice after reviewing this implementation and artifacts.
