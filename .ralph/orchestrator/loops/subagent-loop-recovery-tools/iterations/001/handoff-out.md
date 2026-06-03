# Ralph handoff-out

Iteration: 1

## Summary

Implemented first-class Subagent Loop restart support via `RalphOrchestrator.restartTodo`, `subagent_loop_restart`, and `/loop-restart`. Restart dry-runs report the selected todo/iteration refs, rescue ref, HEAD, and dirty state; real restarts create a rescue ref, hard-reset to the attempt `beforeRef`, requeue the same failed/interrupted todo, and preserve iteration history.

## Changed files

- packages/loops/src/types.ts
- packages/loops/src/git.ts
- packages/loops/src/orchestrator.ts
- packages/loops/extensions/orchestrator.ts
- packages/loops/tests/orchestrator.test.ts
- packages/loops/README.md
- packages/loops/docs/protocol.md
- packages/loops/skills/subagent-loop/refs/tool-usage.md
- .ralph/orchestrator/loops/subagent-loop-recovery-tools/iterations/001/verification.md
- .ralph/orchestrator/loops/subagent-loop-recovery-tools/iterations/001/handoff-out.md

## Commit subject

feat: add loop todo restart recovery

## Verification performed

- `npm --workspace @keydown-dev/pi-loops test -- --test-name-pattern restart` passed.
- `npm run typecheck` passed.

## Decisions made

- Kept restart on existing todo statuses (`failed`/`interrupted`) without adding new state statuses.
- Treated resolution subtasks as todo IDs prefixed with `<todoId>.` and refused restart when present.
- Used the requested legacy-compatible rescue ref format `ralph/<loop>/restart-rescue-<todo-id>-<timestamp>`.

## Risks or blockers

- Restart creates a rescue ref at current `HEAD`, matching the issue text, but uncommitted dirty worktree edits are only reported and will still be discarded by `git reset --hard` if the caller proceeds.

## Next suggested task

Review whether real restart should refuse dirty worktrees or create an additional patch/stash before hard reset to protect uncommitted interrupted edits.
