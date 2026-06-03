# Issue 013: Add a restart tool for interrupted Subagent Loop todos

## Summary

Add a first-class restart primitive for Subagent Loop recovery:

- `subagent_loop_restart`
- `/loop-restart`

Restart means: discard the current visible attempt for an interrupted/failed todo, restore the repository to that todo iteration's `beforeRef`, and requeue the same todo so a fresh worker can try it from scratch.

This is intentionally different from continuing unfinished work. Continuing should be represented by inserting a resolution subtask with `subagent_loop_insert_todo_subtask`; restart should reset to the pre-attempt checkpoint and retry the original todo.

## Motivation

When a worker is killed, times out, or fails badly, the loop currently enters `needs_attention` and refuses to run. The user/agent must inspect refs and hand-edit state or manually reset git. This is unsafe and confusing.

The extension already records `beforeRef` and creates iteration checkpoints. It should expose a safe, explicit restart operation around those refs.

## Desired behavior

A user or orchestrator can call:

```ts
subagent_loop_restart({
  name: "my-loop",
  todoId: "005-auth-refresh",
  dryRun: true
})
```

The dry run reports:

- selected loop and todo
- latest failed/interrupted iteration for that todo
- `beforeRef`
- current `HEAD`
- rescue ref/branch that would be created
- whether the worktree is dirty
- whether the todo has resolution subtasks, which blocks v1 restart

Then the real call:

```ts
subagent_loop_restart({
  name: "my-loop",
  todoId: "005-auth-refresh"
})
```

should:

1. Require the todo to be `failed` or `interrupted`.
2. Refuse if the todo has resolution subtasks in v1.
3. Find the latest iteration for the todo.
4. Create a rescue ref/branch from the current `HEAD` before any destructive reset.
5. `git reset --hard` to that iteration's `beforeRef`.
6. Mark the todo back to `queued`.
7. Clear loop-level blocking for that todo.
8. Keep iteration history intact.
9. Write state/plan updates.
10. Return next action: run `/loop-run --max 1` or `subagent_loop_run({ maxIterations: 1 })`.

## Non-goals

- Do not add a generic `continue` tool.
- Do not support force-restarting todos with existing subtasks in v1.
- Do not delete or rewrite historical iteration artifacts.
- Do not attempt to preserve failed worker message history as a live resumed session.

## Tool API

```ts
subagent_loop_restart({
  name?: string;
  todoId?: string;
  dryRun?: boolean;
})
```

If `todoId` is omitted, select the first failed/interrupted todo that is restartable. If multiple candidates are ambiguous, return a clear error asking for `todoId`.

## Command API

```txt
/loop-restart [name] [--todo TODO_ID] [--dry-run]
```

## Safety requirements

- Always create a rescue ref/branch before `reset --hard`.
- Surface the rescue ref/branch in the tool/command response.
- Refuse when `beforeRef` does not exist.
- Refuse when the todo has resolution subtasks.
- Refuse when another worker is running for the loop.
- Do not silently restart later unrelated todos.

Suggested rescue ref format:

```txt
ralph/<loop-name>/restart-rescue-<todo-id>-<timestamp>
```

or a branch if refs are not user-visible enough:

```txt
rescue/<loop-name>/<todo-id>-<timestamp>
```

## State/model changes

This issue should not require new statuses. It may add optional metadata recording the restart action, for example on the iteration or todo history, but the core behavior can be implemented with existing statuses.

## Tests

Add tests for:

1. Dry-run reports target todo, `beforeRef`, rescue ref, and does not mutate state or git.
2. Restart of interrupted todo creates rescue ref, resets to `beforeRef`, marks todo `queued`, and preserves old iteration record.
3. Restart refuses if the todo has resolution subtasks.
4. Restart refuses if no failed/interrupted todo exists.
5. Restart refuses if `beforeRef` is missing.
6. Running the loop after restart starts a fresh iteration for the same todo.

## Documentation updates

Update README/protocol/skill docs to explain:

- Restart discards the current attempt and retries the original todo.
- Continue-like recovery should usually use `subagent_loop_insert_todo_subtask` instead.
- Agents should dry-run restart before destructive reset unless the user explicitly asked for immediate restart.
