# Issue 010: Allow extending a running Ralph loop's queued work budget

## Summary

Allow users to queue additional todo items for execution while a Ralph loop is already running, without killing or waiting for the active worker to finish. Today `/ralph-run` and `ralph_orchestrator_run` reject a loop that already has an active background job. Users can soft-pause after the current worker, but they cannot say “after this worker, also run one more item” or “continue through item 3” while the loop is in flight.

The desired behavior is a mutable run budget: a running loop should be able to accept additional requested iterations, persist that intent, and have the orchestrator consult it between worker iterations. Pause remains higher priority: if the user pauses, Ralph should still finish the current worker and stop before starting the next one, even if budget remains.

## Motivation

During an active loop, users often refine how much work they want done based on live progress. In the arithmetic-kata test loop, the user initially requested three items, then changed their mind to pause after the first item, then changed again to pause after the second. Ralph could soft-pause, but once paused was queued against the active worker, there was no way to queue exactly one additional item until the worker exited.

This makes orchestration feel less like a controllable queue and more like a fixed one-shot command. A background loop should support natural steering such as:

- “Run one more after this.”
- “Actually, continue through the next two items.”
- “Queue the next item, then pause.”
- “Increase this run from max 1 to max 3.”

## Current behavior

`extensions/orchestrator.ts` keeps in-memory active jobs:

```ts
const activeJobs = new Map<string, Promise<void>>();
```

`startBackgroundLoop` rejects new run requests while a loop already has an active job:

```ts
if (activeJobs.has(name)) {
  ctx.ui.notify(`Ralph loop is already running: ${name}`, "warning");
  return;
}
```

`RalphOrchestrator.run(name, { maxIterations })` treats `maxIterations` as a local loop bound for the current call:

```ts
for (let i = 0; i < max; i++) {
  state = await this.store.readState(slugifyLoopName(name));
  if (state.control !== "active") break;
  if (!state.todos.some((todo) => todo.status === "queued")) break;
  if (state.todos.some((todo) => todo.status === "failed" || todo.status === "interrupted")) break;
  state = await this.next(name, options);
}
```

The persisted state has `control` and task statuses, but no durable “remaining requested iterations” field that can be updated while the run loop is active.

## Goals

- Let users extend or modify queued run scope while a loop is running.
- Persist run budget changes so they survive process restarts where practical.
- Preserve soft-pause semantics: pause always prevents another worker from starting after the current one exits.
- Preserve one-worker-at-a-time execution for a loop.
- Make tool/command responses explicit: “queued N more iterations” rather than “already running.”
- Keep existing `/ralph-run --max 1` behavior for idle/paused loops.
- Support LLM tool usage through `ralph_orchestrator_run` as well as slash command usage.

## Non-goals

- Running multiple workers concurrently for the same loop.
- Resuming a killed child worker in place.
- Reordering todos in this issue. Todo insertion/reordering remains separate.
- Changing the semantic meaning of `deferred` except as needed to promote work into the extended run scope.

## Proposed state model

Add a persisted run-control field to `LoopState`.

One possible shape:

```ts
export interface LoopState {
  name: string;
  control: LoopControl;
  branch: string;
  currentIteration: number;
  createdAt: string;
  updatedAt: string;
  maxIterations?: number;
  todos: RalphTodo[];
  iterations: IterationState[];

  runBudget?: {
    remaining: number;
    updatedAt: string;
    updatedBy?: "command" | "tool" | "orchestrator";
  };
}
```

Alternative names to consider:

- `runQueue.remainingIterations`
- `activeRun.remainingIterations`
- `requestedIterationsRemaining`

Use an object rather than a bare number so future fields can be added without another schema break.

## Desired semantics

### Idle or paused loop

`/ralph-run <name> --max N` should:

1. Set `control = "active"`.
2. Promote up to `N` eligible tasks into `queued` status using existing `prepareRunScope` semantics.
3. Set `runBudget.remaining = N` or otherwise initialize the active run budget.
4. Start the background job if none is active.

### Already-running loop

`/ralph-run <name> --max N` or `ralph_orchestrator_run({ maxIterations: N })` should:

1. Read latest state.
2. Validate the loop has an active worker/job.
3. Increase the persisted run budget by `N`, or update it according to a clearly documented mode.
4. Promote deferred tasks into queued scope if needed.
5. Save state.
6. Update the widget.
7. Return/notify: `Queued N additional Ralph iteration(s) for <name>.`
8. Not spawn a second background job.

Recommended first implementation: additive extension.

```ts
state.runBudget.remaining += requestedMaxIterations;
```

A later UI can add explicit modes like `--set-max` or `--run-until <todo-id>`, but additive `--max N` is simple and matches “queue N more.”

### Between iterations

After each worker exits, the orchestrator should reload state and decide whether to start another worker:

1. If `control === "paused"`, stop.
2. If any todo is `failed` or `interrupted`, stop for attention.
3. If `runBudget.remaining <= 0`, stop.
4. If no queued todo exists, try promoting deferred work only up to budget.
5. If still no queued todo exists, stop.
6. Decrement budget when starting or successfully claiming the next iteration, not after completion, to avoid double-running after crashes.
7. Start the next worker.

Pseudo-code:

```ts
while (true) {
  state = await store.readState(name);
  if (state.control !== "active") break;
  if (hasFailedOrInterrupted(state)) break;
  if ((state.runBudget?.remaining ?? 0) <= 0) break;

  prepareRunScope(state, state.runBudget.remaining);
  const nextTodo = state.todos.find((todo) => todo.status === "queued");
  if (!nextTodo) break;

  state.runBudget.remaining -= 1;
  await store.writeState(state);
  state = await this.next(name, options);
}
```

### Pause priority

`/ralph-pause` remains a soft stop:

- Set `control = "paused"`.
- Allow current running worker to finish.
- Do not start another worker after the current worker exits.
- Leave `runBudget.remaining` either preserved or cleared, but choose and document one behavior.

Recommended: clear or freeze budget on pause? Two viable options:

1. **Clear on pause**: pause means “cancel the rest of this run scope.” Running again starts a fresh budget. This matches current behavior where pause defers queued todos.
2. **Freeze on pause**: pause means “hold remaining queued work until resumed.” This is more queue-like but changes current semantics.

Recommendation for compatibility: clear budget and defer queued todos on pause, matching existing `deferQueuedTodos(state)` behavior.

## Command/tool UX

### `/ralph-run`

When the loop is already running:

```text
Queued 1 additional Ralph iteration for arithmetic-kata-throwaway.
```

If `--max 3`:

```text
Queued 3 additional Ralph iterations for arithmetic-kata-throwaway.
```

Do not print `Ralph loop is already running` unless the request cannot be represented safely.

### `ralph_orchestrator_run`

Update the tool behavior similarly. The tool should return a status message that distinguishes:

- started a new background run
- extended an active background run
- refused due to needs-attention state
- refused because loop is completed

## Implementation notes

Likely touch points:

- `src/types.ts`
  - Add `runBudget` or equivalent to `LoopState`.
  - Possibly add `RunBudget` type.
- `src/store.ts`
  - Update state validation schema with optional field.
  - Add migration/default handling for older state files.
- `src/orchestrator.ts`
  - Refactor `run` so run scope is persisted and checked between iterations.
  - Add method such as `extendRun(name, count)` or make `run` handle active-loop state safely.
  - Ensure `prepareRunScope` is called against current persisted state when budget changes.
- `extensions/orchestrator.ts`
  - Replace `activeJobs.has(name)` hard rejection with active-run budget extension.
  - Keep the single active promise/job invariant.
  - Notify user/widget after extension.
- Tool registration for `ralph_orchestrator_run`
  - Return a useful result when it extends a run.
- `docs/protocol.md` and `README.md`
  - Document run-budget behavior and pause priority.

## Edge cases

- Running loop has an active worker and user queues more, then immediately pauses.
  - Expected: current worker finishes, no next worker starts.
- Running loop has one deferred todo and user queues one more.
  - Expected: deferred todo becomes eligible and runs after current worker.
- Running loop is on final todo and user queues more than available.
  - Expected: run all available work, then complete; budget may end at zero or be cleared on completion.
- Running loop hits failed verification.
  - Expected: stop regardless of remaining budget.
- Pi process restarts while worker is running.
  - Expected: state validation tolerates `runBudget`; recovery behavior should be documented.
- Multiple rapid run-extension requests arrive.
  - Expected: state writes are serialized enough to avoid losing increments.

## Acceptance criteria

- Calling `/ralph-run <name> --max 1` while a loop is running queues one additional iteration instead of rejecting as already running.
- Calling `ralph_orchestrator_run({ name, maxIterations: 1 })` while a loop is running queues one additional iteration instead of returning only an already-running warning.
- Ralph never starts more than one worker at a time for the same loop.
- A queued additional iteration starts only after the active worker completes successfully.
- `/ralph-pause` during a running worker prevents queued additional iterations from starting after that worker exits.
- Remaining budget is persisted in `state.json` and validated by the store schema.
- Status/widget output makes it clear when extra work has been queued or budget remains.
- Existing idle-loop behavior for `/ralph-run --max N` continues to work.
- Existing tests for pause, kill, needs-attention, and deferred tasks still pass.

## Suggested tests

- Unit test: active job plus `/ralph-run --max 1` updates persisted budget and does not create a second job.
- Orchestrator test: run max 1, extend by 1 while first worker is running, verify two todos complete and third remains deferred/queued according to policy.
- Pause test: extend by 1 while running, pause before first worker exits, verify only first todo completes and second does not start.
- Failure test: queued budget remains but failed/interrupted todo stops the loop.
- Schema test: older states without `runBudget` still load.
- CLI/tool test: notification/result says queued additional iterations.

## Verification

Run:

```bash
npm test
npm run typecheck
```
