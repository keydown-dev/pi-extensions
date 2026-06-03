# Ralph handoff-out

Iteration: 2

## Summary

Implemented `subagent_loop_request_help` for worker escalation. The tool records markdown/JSON help artifacts, stores compact help-request state, pauses the loop, interrupts the running todo, and provides stop-after-artifacts guidance. Worker finalization now preserves interrupted help-request state after exit, and status/plan output surfaces the help request artifact path.

## Changed files

- packages/loops/src/types.ts
- packages/loops/src/orchestrator.ts
- packages/loops/src/store.ts
- packages/loops/extensions/orchestrator.ts
- packages/loops/src/pi-json-worker.ts
- packages/loops/skills/subagent-loop/refs/pickup.md
- packages/loops/skills/subagent-loop/refs/tool-usage.md
- packages/loops/README.md
- packages/loops/docs/protocol.md
- packages/loops/tests/orchestrator.test.ts
- .ralph/orchestrator/loops/subagent-loop-recovery-tools/iterations/002/verification.md
- .ralph/orchestrator/loops/subagent-loop-recovery-tools/iterations/002/handoff-out.md

## Commit subject

feat: add worker request help tool

## Decisions

- Used existing `interrupted` todo status and `aborted` iteration status; no new blocked status was added.
- Stored rich request details in `help-request.md`/`.json` and only a compact `helpRequest` summary in state.
- Preserved help-request interruption after worker exit even when the child returns verification results, preventing accidental conversion to `failed`/`complete`.

## Risks

- The child Pi process must have the loops extension loaded for the worker-facing tool to be callable.
- Follow-up resolution subtask tooling is intentionally not implemented in this slice.

## Next suggested task

Complete Issue 015 for inserting resolution subtasks that answer open help requests.
