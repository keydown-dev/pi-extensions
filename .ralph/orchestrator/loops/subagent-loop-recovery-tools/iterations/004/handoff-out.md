# Subagent Loop handoff-out

## Summary

Completed issue 016 by updating Subagent Loop docs/skill refs and the generated worker prompt with recovery guidance for request-help, resolution subtasks, restart, clarification policy, and orchestrator help-request handling. Added a static regression test that checks the docs and worker prompt mention the required recovery primitives and avoid recommending normal hand-edits to `state.json`.

## Changed files

- `packages/loops/README.md`
- `packages/loops/docs/protocol.md`
- `packages/loops/skills/subagent-loop/refs/artifact-protocol.md`
- `packages/loops/skills/subagent-loop/refs/pickup.md`
- `packages/loops/skills/subagent-loop/refs/planning.md`
- `packages/loops/skills/subagent-loop/refs/tool-usage.md`
- `packages/loops/src/pi-json-worker.ts`
- `packages/loops/tests/orchestrator.test.ts`
- `.ralph/orchestrator/loops/subagent-loop-recovery-tools/iterations/004/verification.md`
- `.ralph/orchestrator/loops/subagent-loop-recovery-tools/iterations/004/handoff-out.md`
- `.ralph/orchestrator/loops/subagent-loop-recovery-tools/iterations/004/worker-output.jsonl`

## Commit subject

feat: document subagent loop recovery workflows

## Decisions

- Kept clarification policy as plain text in the loop packet/docs, not as a new state field or tool.
- Documented continuation as visible resolution subtask insertion with answer-source metadata.
- Documented restart as destructive retry from `beforeRef` with dry-run preference.
- Expanded worker help guidance as a terminal escalation path with `Status: not_run` artifacts.

## Risks

- The docs test is static and validates required phrasing/presence, not end-to-end human/orchestrator behavior.
- `npm --prefix packages/loops test -- --test-name-pattern ...` ran the full suite in this environment despite the name pattern, increasing verification time but passing.

## Next suggested task

Proceed to the next planned issue/todo in the loop; no blocker remains for issue 016.
