# Ralph Orchestrator Protocol

## Roles

- Orchestrator extension: owns state, git policy, artifacts, commands, worker process tracking, and widget status.
- Brief skill: prepares concise `handoff-in.md` files.
- Pickup skill: guides fresh workers through one bounded task.
- Report skill: guides workers to produce durable output artifacts.

## Artifact root

Loop artifacts live under `.ralph/orchestrator/loops/<loop>/`. Projects should usually ignore `.ralph/` so local loop state, handoffs, and worker transcripts are not committed by default.

## Required iteration files

- `handoff-in.md`: exact input context for the worker.
- `handoff-out.md`: worker summary and handoff back to orchestrator.
- `verification.md`: commands run and results.
- `worker-output.jsonl`: event stream or scripted-worker events.
- `git-before.txt`: status before worker activity.
- `git-after.txt`: status after worker activity.

## Git policy

- Starting a loop requires a clean worktree and creates/checks out `orchestrator/<loop>`.
- The initial loop state is committed on that branch.
- Each iteration commits handoff context before the worker starts.
- Each completed iteration commits worker changes and artifacts after verification is captured.
- Displayed diff stats are computed from code changes since the handoff commit, excluding `.ralph/` artifacts.

## Git refs

- `refs/ralph/<loop>/iter-001-before`
- `refs/ralph/<loop>/iter-001-after`

## Runner boundary

The default `pi-json` runner spawns a fresh `pi --mode json` worker process. The deterministic `scripted` runner is retained for local tests and writes the same artifacts.

## Persisted state model

Loop state stores control only:

```ts
loop.control: "active" | "paused"
```

Task state stores work lifecycle:

```ts
task.status:
  | "queued"
  | "running"
  | "complete"
  | "deferred"
  | "failed"
  | "interrupted"
```

Meanings:

- `queued`: eligible for the current/next run.
- `running`: currently assigned to an active worker.
- `complete`: finished and accepted.
- `deferred`: intentionally outside the current run scope/limit.
- `failed`: attempted and failed verification or needs a decision.
- `interrupted`: a running worker was killed/aborted with partial work likely present.

Loop display status is derived from control and task statuses:

- `running`: any task is `running`.
- `needs_attention`: any task is `failed` or `interrupted`.
- `paused`: control is `paused` and no task is running.
- `ready`: control is `active` and queued or deferred work remains. If only deferred tasks remain, display ready.
- `completed`: no queued/running/deferred/failed/interrupted tasks remain.

## Todo insertion

`ralph_orchestrator_insert_todo` inserts a new task after an existing stable todo ID. Existing todo IDs and completed iteration `todoId` references are preserved; execution order follows the persisted todo array order. The inserted todo defaults to `deferred`, receives the next unused internal ID, and increments `maxIterations` when that field is present. The tool refuses to modify loops with running todos or iterations and supports `dryRun: true` for a before/after preview.

## Run-limit behavior

`/ralph-start --max N` creates the first `N` tasks as `queued` and the rest as `deferred`.

`/ralph-run --max N` sets control to `active`, scopes the current run to at most `N` queued tasks, and can promote deferred tasks into that scope when no queued work remains. Ralph only picks `queued` tasks.

Use `/ralph-run --max 1` for a single worker iteration. There is no `/ralph-next` command.

## Control semantics

- **Pause** is soft: set control to `paused`. If a worker is already running, it is allowed to finish the active iteration, and the orchestrator does not start another iteration.
- **Resume** is not a command. Running again with `/ralph-run` sets control to `active` and starts fresh worker iterations for queued work.
- **Kill** is hard: send `SIGTERM` to active Ralph child worker processes for that loop and set control to `paused`. If non-Ralph worktree changes are detected, the active task becomes `interrupted`; otherwise it may return to `queued`. The killed child session cannot be resumed in-place. Inspect Ralph status and `git status` before running again.

Removed command/tool surface: stop, resume, next, and ralph-control.
