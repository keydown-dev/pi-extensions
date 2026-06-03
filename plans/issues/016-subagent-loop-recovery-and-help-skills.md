# Issue 016: Update Subagent Loop skills and docs for recovery, subtasks, and help requests

## Summary

Update Subagent Loop skills and documentation so agents know how to use the new recovery primitives:

- `subagent_loop_restart` for discarding an attempt and retrying the original todo from `beforeRef`
- `subagent_loop_request_help` for worker escalation when blocked by ambiguity
- `subagent_loop_insert_todo_subtask` for transparent continuation of unfinished work through visible resolution subtasks

Also improve loop setup/planning guidance so the orchestrator creates a more complete packet before launching workers, including acceptance criteria, verification standards, anticipated ambiguity, and clarification policy.

## Motivation

The extension should provide small primitives; judgment should live in skills/docs. Agents need clear guidance for:

- when to restart vs create a resolution subtask
- how a worker should ask for help instead of guessing
- how an orchestrator should resolve help requests
- when the orchestrator may answer from context vs ask the human
- how to phrase subtask instructions so the next worker inherits the original acceptance criteria

Without skill updates, agents will keep hand-editing state or overusing restart/continue incorrectly.

## Planning/setup guidance

Update `skills/subagent-loop/refs/planning.md` and related docs so loop setup includes a short interview process:

1. Draft the loop packet.
2. Anticipate likely worker ambiguities.
3. Ask clarifying questions up front.
4. Capture overall verification standards and per-todo acceptance criteria when known.
5. Ask the user for a loop-wide clarification policy.
6. Iterate on the packet with the user.
7. Confirm before starting the loop.

Example clarification policy question:

> If workers request clarification, may the orchestrator answer from project context when confident, or should it always ask you?

The policy is plain text in the packet/docs for v1, not a state field or tool. The user may steer it later in chat before running more todos.

Example policy text:

```md
## Clarification policy

The orchestrator may answer worker clarification requests from project context when confident.
Ask the human when the question involves product direction, architecture tradeoffs, security, irreversible changes, or low confidence.
Record whether each clarification was human-provided or orchestrator-inferred.
```

Alternative:

```md
## Clarification policy

Always ask the human before answering worker clarification requests.
```

## Worker pickup guidance

Update `skills/subagent-loop/refs/pickup.md` and the generated child prompt.

Workers should be told:

- Complete exactly the assigned todo.
- Read the handoff first and keep context small.
- If blocked by ambiguity, missing requirements, product/architecture decision, or unclear verification, do not guess.
- Call `subagent_loop_request_help` with a rich, focused request.
- Include question, context, blocking reason, attempted approaches, options, recommendation, risk if guessed, and affected files when useful.
- After request-help returns, write `handoff-out.md` and `verification.md` with `Status: not_run`, then stop.

## Orchestrator response guidance

Update `skills/subagent-loop/refs/tool-usage.md`, `refs/artifact-protocol.md`, README, and protocol docs.

When a help request appears:

1. Inspect loop status and help-request artifact.
2. Try to answer from existing project context if the loop policy permits and confidence is high.
3. Ask the human if confidence is low or the decision involves product direction, architecture tradeoffs, security, irreversible changes, or ambiguous ownership.
4. Record whether the answer was `human-provided` or `orchestrator-inferred` in the subtask instructions.
5. Insert a resolution subtask with `subagent_loop_insert_todo_subtask`.
6. Run the loop for the resolution subtask.

The orchestrator may have a back-and-forth with the human before inserting the subtask. It should not create the subtask until it has enough information to write useful instructions.

## Continue vs restart guidance

Use this decision tree:

### Create a resolution subtask when

- the previous worker asked for help
- the worker was killed/shutdown but left useful progress
- the task is incomplete but salvageable
- the next worker should inspect current repo state and prior artifacts
- preserving audit trail matters

In this case, use `subagent_loop_insert_todo_subtask`.

### Restart when

- the previous attempt should be discarded
- current changes are bad/noisy/wrong
- the user wants the original todo retried from its `beforeRef`
- no resolution subtasks already exist for that todo

In this case, use `subagent_loop_restart`, preferably dry-run first.

Do not introduce a separate `subagent_loop_continue` tool in v1. Continuation is a skill workflow that creates resolution subtasks.

## Subtask instruction guidance

Subtask `instructions` are freeform and persisted as `handoffInstructions`. Skills should tell orchestrators to include:

- why the parent/subtask was incomplete
- what question/problem blocked it
- the answer or decision
- whether the answer was human-provided or orchestrator-inferred
- relevant artifact paths or iteration numbers
- reminder that the original acceptance criteria and verification standards still apply
- any additional acceptance criteria or clarification accumulated along the chain

Example:

```md
Parent todo `005-auth-refresh` was interrupted after the worker requested clarification.

Previous worker question: Should auth refresh use Expo API routes or the existing backend?

Answer source: human-provided.
Answer: Use the existing backend. Do not add Expo API routes.

Continue from the current repository state. Inspect iteration 005 artifacts before changing code. You must satisfy the original todo's acceptance criteria and verification standards.
```

## Documentation files likely affected

- `packages/loops/README.md`
- `packages/loops/docs/protocol.md`
- `packages/loops/skills/subagent-loop/SKILL.md` if routing text needs updates
- `packages/loops/skills/subagent-loop/refs/planning.md`
- `packages/loops/skills/subagent-loop/refs/pickup.md`
- `packages/loops/skills/subagent-loop/refs/tool-usage.md`
- `packages/loops/skills/subagent-loop/refs/artifact-protocol.md`
- generated worker prompt in `packages/loops/src/pi-json-worker.ts`

## Non-goals

- Do not add a policy-update tool in v1.
- Do not add a loop-state clarification policy field in v1.
- Do not implement live same-worker resume.
- Do not make `subagent_loop_insert_todo_subtask` specific only to help-request answers.

## Tests/verification

Add or update tests/docs checks for:

1. Skill docs mention request-help and terminal stop behavior.
2. Planning docs include clarification policy interview.
3. Tool usage docs explain restart vs resolution subtask.
4. Worker prompt includes request-help guidance.
5. README command/tool list includes new tools/commands where applicable.
6. `rg` finds no recommendation to hand-edit `state.json` for normal recovery.

## Acceptance criteria

- Agents using the bundled skill can recover a blocked/killed loop without guessing state edits.
- Workers know when and how to request help.
- Orchestrators know they may answer from context only when policy permits and confidence is high.
- Continuation is documented as resolution subtask insertion, not as a hidden state reset.
- Restart is documented as destructive recovery with rescue ref and dry-run preference.
