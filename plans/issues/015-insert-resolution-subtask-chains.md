# Issue 015: Add resolution subtask chains for unfinished loop todos

## Summary

Add a first-class tool for inserting a todo subtask that resolves an interrupted/unfinished parent todo:

- `subagent_loop_insert_todo_subtask`

This replaces the earlier idea of a generic `continue` tool. To continue unfinished work transparently, the orchestrator inserts a visible subtask such as `005.1-finish-auth-refresh-after-clarification`. The parent remains visibly incomplete/interrupted until a resolution subtask completes with passing verification.

Resolution subtasks form a flat sibling chain:

```txt
005-auth-refresh
005.1-finish-auth-refresh-after-backend-answer
005.2-finish-auth-refresh-after-env-answer
```

When the latest resolution subtask completes successfully, the whole unresolved chain is marked complete.

## Motivation

If a worker gets blocked, killed, or partially completes work, marking the original todo complete hides what actually happened. Resetting and retrying also loses useful progress. A visible resolution subtask preserves the audit trail:

- original todo was attempted and interrupted
- clarification/recovery happened
- a new fresh worker finished the original acceptance criteria

This makes recovery explicit in state, plan output, widget output, and artifacts.

## Tool API

```ts
subagent_loop_insert_todo_subtask({
  name?: string;
  insertAsSubtask: string;
  id: string;
  title: string;
  instructions?: string;
  status?: "queued" | "deferred";
  model?: string;
  dryRun?: boolean;
})
```

Notes:

- `insertAsSubtask` is required and names either the original root parent or the currently blocked subtask.
- The tool normalizes internally to the root chain.
- There is no `insertAtIndex`; placement is deterministic.
- Default status is `queued`.
- Caller provides the explicit semantic subtask ID.

## Placement rules

Given parent/root `005-auth-refresh`:

- If no existing subtasks, insert immediately after `005-auth-refresh`.
- If existing subtasks exist, insert after the last subtask in the flat sibling chain.
- If caller passes `005.1-...` as `insertAsSubtask`, normalize to root `005-auth-refresh` and insert next sibling `005.2-...`.

The tool should validate, where feasible, that caller-provided IDs follow the flat chain convention:

- root: `005-auth-refresh`
- first subtask: `005.1-...`
- second subtask: `005.2-...`

Validation should catch obvious mistakes but not overfit to one naming convention beyond semantic IDs.

## State model

Persist rich audit links in state. Exact field names may be refined during implementation, but the model should support:

On parent/root/interrupted chain members:

```json
{
  "status": "interrupted",
  "resolutionTodoIds": ["005.1-finish-auth-refresh-after-backend-answer"],
  "resolvedByTodoId": "005.2-finish-auth-refresh-after-env-answer",
  "resolvedAt": "...",
  "resolutionReason": "Resolved by subtask after clarification"
}
```

On subtask todos:

```json
{
  "parentTodoId": "005-auth-refresh",
  "rootTodoId": "005-auth-refresh",
  "subtaskOf": "005-auth-refresh",
  "inheritsVerificationFromTodoId": "005-auth-refresh",
  "handoffInstructions": "Human clarified: use the existing backend...",
  "createdAt": "...",
  "createdReason": "resolution_subtask"
}
```

The user explicitly wants rich audit fields. The visible todo status can still be simple `complete`; metadata should show completion via subtask.

## Handoff behavior

When a resolution subtask runs, generated `handoff-in.md` must include:

- parent/root todo ID and title
- previous incomplete/interrupted todo or subtask
- relevant previous iteration artifacts to inspect
- `handoffInstructions` from the subtask
- explicit statement that the subtask inherits the original acceptance criteria and verification burden
- explicit statement that completing the subtask means satisfying the original parent todo, not merely answering the blocker

Example section:

```md
## Resolution subtask context

This todo is a resolution subtask for `005-auth-refresh`.

The previous attempt was incomplete/interrupted. Inspect its handoff, verification, worker output, and current repository state before proceeding.

Additional instructions:

Human clarified: use the existing backend. Do not add Expo API routes.

You must satisfy the original todo's acceptance criteria and verification standards. Passing this subtask resolves the parent chain.
```

## Run eligibility and derived status

Current behavior blocks all runs when any todo is `failed` or `interrupted`. This must change for resolution chains.

Rules:

1. If an interrupted todo has no queued/running resolution subtask chain, loop status is `needs_attention`.
2. If every unresolved interrupted todo in the earliest blocking chain has a queued/running resolution subtask, loop status can become `ready`.
3. Only the earliest unresolved chain is eligible to run.
4. Later unrelated todos remain blocked until the chain resolves.
5. If two unrelated interrupted chains exist, run the earliest chain to completion first.

## Completion behavior

When a resolution subtask completes with verification `passed`:

- mark that subtask `complete`
- mark all prior interrupted todos/subtasks in the same root chain `complete`
- set rich metadata like `resolvedByTodoId` / `resolvedAt`
- then allow normal loop progression

Only `passed` verification resolves the chain. `failed` or `not_run` must not mark the parent chain complete.

## Non-goals

- Do not add nested IDs like `005.1.1`; use flat sibling chains.
- Do not expose arbitrary `insertAtIndex` on this tool.
- Do not use this tool to restart from `beforeRef`; that is `subagent_loop_restart`.
- Do not make the tool specific only to help requests. `instructions` is freeform so it can support crash recovery, clarification, or other unfinished-work continuations.

## Tests

Add tests for:

1. Insert first subtask immediately after parent.
2. Insert second subtask after existing sibling chain when `insertAsSubtask` points to root.
3. Insert second subtask after existing sibling chain when `insertAsSubtask` points to blocked `005.1`.
4. Default subtask status is `queued`.
5. Tool persists `handoffInstructions` on the subtask todo.
6. Derived status becomes `ready` when an interrupted parent has a queued resolution subtask.
7. Run selection chooses the earliest unresolved chain and blocks unrelated later todos.
8. Passing subtask completion marks prior interrupted chain members complete and records resolution metadata.
9. `failed` or `not_run` subtask does not resolve the parent chain.
10. Dry-run previews placement, metadata, and status changes without writing.

## Documentation updates

Update README/protocol/skill docs:

- Continuing unfinished work means inserting a resolution subtask.
- Resolution subtasks inherit original acceptance criteria and verification standards.
- The parent stays incomplete until a subtask passes.
- Flat sibling chains are preferred for widget readability and auditability.
