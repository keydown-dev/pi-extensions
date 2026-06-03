# Subagent Loop Protocol

## Roles

- Orchestrator extension: owns state, git policy, artifacts, commands, worker process tracking, and widget status.
- Brief workflow: prepares concise `handoff-in.md` files.
- Pickup workflow: guides fresh workers through one bounded task.
- Report workflow: guides workers to produce durable output artifacts.

## Todo identity and execution order

Todo IDs are stable semantic identifiers, not list positions. Newly created loops derive IDs from the todo title and original creation index, for example `001-document-protocol` or issue-like IDs such as `ISSUE-005.1`. Inserted todos must provide an explicit semantic ID.

The persisted `todos` array controls execution order. The loop selects queued work by walking that array; inserting a todo changes array order without renumbering existing todo IDs or completed iteration references. Treat `todo.id` as durable identity and array position as mutable scheduling order.

Physical iteration numbers remain numeric and chronological. Iteration directories, refs, and display counters use padded numbers such as `iterations/005/`, `iter-005-before`, and `iter-005-after`. `iteration.todoId` links a numeric execution attempt back to the semantic todo it executed.

## Artifact root

Loop artifacts live under `.loop/orchestrator/loops/<loop>/`. Projects usually ignore `.loop/` so local loop state, handoffs, and worker transcripts stay local by default. If a project chooses to track `.loop/`, raw diagnostic traces remain local-only ignored files.

The extension creates or updates `.loop/.gitignore` with managed diagnostic rules:

```gitignore
# Loop-managed local diagnostics
worker-output.raw.jsonl
worker-output.raw.jsonl.*
*.raw.jsonl
*.raw.jsonl.*
```

The generator is idempotent and preserves custom rules already present in `.loop/.gitignore`.

## Required iteration files

- `handoff-in.md`: exact input context for the worker and the assignment boundary.
- `handoff-out.md`: worker summary, changed files, optional commit subject, and handoff back to orchestrator.
- `verification.md`: commands run and results. It must contain `Status: passed`, `Status: failed`, or `Status: not_run`.
- `worker-output.jsonl`: compact committed worker event summary.
- `git-before.txt`: status before worker activity.
- `git-after.txt`: status after worker activity.

Optional local-only diagnostics:

- `worker-output.raw.jsonl`: raw `pi --mode json` stdout trace when raw output is enabled.
- `worker-output.raw.jsonl.*` / `*.raw.jsonl*`: rotated or ad-hoc raw traces; ignored by managed gitignore rules and unstaged before commits.

`worker-output.jsonl` is intentionally compact and durable. It records worker start/process metadata, assistant message summaries, tool calls/results, usage snapshots, warnings for malformed lines, worker exit, and the final `worker_result`. Large values are truncated so repository history remains readable.

## Git policy

- Starting a loop requires a clean worktree and creates/checks out `orchestrator/<loop>`.
- The initial loop state is committed on that branch.
- Each iteration first commits handoff context before the worker starts. This commit is the assignment/context boundary and uses `handoff: <todo-id> context`.
- Each completed iteration then commits worker changes and artifacts after verification is captured. This commit is the result boundary.
- Worker commits use the worker-provided `## Commit subject` from `handoff-out.md` when it is valid; otherwise they fall back to `worker: <todo-id> changes`.
- Displayed diff stats are computed from code changes since the handoff commit, excluding `.loop/` artifacts.
- Raw trace files under `.loop/` are unstaged before commit even when `.loop/` is tracked.

Commit subject rules:

- `handoff: ISSUE-005.1 context` for semantic todo `ISSUE-005.1`.
- `worker: ISSUE-005.1 changes` when no valid worker subject is provided.
- A worker subject must be a single non-empty line after trimming and whitespace normalization, no longer than 120 characters, for example `feat: document loop artifact protocol`.
- Legacy states without a usable todo ID fall back to `iteration 006` in commit messages.

## Git refs

- `refs/ralph/<loop>/iter-001-before`
- `refs/ralph/<loop>/iter-001-after`

Refs keep the historical namespace and stay numeric because they identify physical chronological attempts, not semantic todo identity.

## Runner boundary

The default `pi-json` runner spawns a fresh `pi --mode json` worker process. The deterministic `scripted` runner is retained for local tests and writes the same artifacts.

The `pi-json` runner accepts these environment options:

- `RALPH_WORKER_RAW_OUTPUT=1` (also `true` or `yes`): write `worker-output.raw.jsonl` alongside compact output for debugging.
- `RALPH_WORKER_TIMEOUT_MS`: absolute worker timeout; default 15 minutes.
- `RALPH_WORKER_IDLE_TIMEOUT_MS`: idle-output timeout; default 3 minutes.

## Persisted state model

Loop state stores control, optional run budget, and optional worker defaults:

```ts
loop.control: "active" | "paused"
loop.workerDefaults?: { model?: string; provider?: string; contextWindow?: number }
```

Task state stores work lifecycle and optional per-todo worker model assignment:

```ts
task.workerModel?: string
task.workerProvider?: string
task.workerContextWindow?: number

task.status:
  | "queued"
  | "running"
  | "complete"
  | "deferred"
  | "failed"
  | "interrupted"
```

Worker model precedence is todo override → loop default → run-level fallback → current/default Pi model. The active running todo's launch model is immutable; model assignment tools may update future queued/deferred work but must refuse the currently running todo.

Loop display status is derived from control and task statuses:

- `running`: any task is `running`.
- `needs_attention`: any task is `failed` or `interrupted`.
- `paused`: control is `paused` and no task is running.
- `ready`: control is `active` and queued or deferred work remains. If only deferred tasks remain, display ready.
- `completed`: no queued/running/deferred/failed/interrupted tasks remain.

## Schema compatibility and migration rules

Current state validation is strict about field names and status values, but `todo.id` and `iteration.todoId` accept both strings and numbers. This preserves compatibility with legacy numeric loops while new loops use semantic string IDs.

Migration invariants for future protocol changes:

- Never treat a todo ID as an array index.
- Never renumber existing todo IDs during migration or insertion.
- Preserve completed `iteration.todoId` references exactly so historical attempts keep pointing at the same todo identity.
- Keep physical iteration numbers, directories, and refs numeric and chronological.
- For legacy numeric IDs, stringify only at display/commit-message boundaries as needed; do not rewrite history merely to prettify IDs.
- If a state lacks a usable todo ID for an iteration, use the numeric iteration fallback label (`iteration 006`) rather than inventing identity.
- Add new durable fields as optional first, then document acceptance criteria before making them required.

## Worker/orchestrator responsibilities

Orchestrator responsibilities:

- Create and validate loop state.
- Generate handoff, verification placeholder, compact output file, before/after git status files, and refs.
- Enforce clean-worktree and commit policy.
- Parse worker-produced `handoff-out.md`, `verification.md`, compact usage, changed files, and optional commit subject.
- Keep raw traces out of durable commits.

Worker responsibilities:

- Read only the assigned `handoff-in.md` first, then inspect referenced files or the minimum necessary local context.
- Complete exactly the assigned todo slice.
- If blocked by ambiguity, missing requirements, unclear ownership, or a decision that should not be guessed, call `subagent_loop_request_help` with a focused question and useful context, then write final artifacts with `Status: not_run` and stop.
- Write `verification.md` with commands/results and a status line.
- Write `handoff-out.md` with these parseable sections:
  - `## Summary`: concise outcome or blocker.
  - `## Changed files`: markdown bullets of changed paths, or `- None` if blocked/no changes.
  - `## Commit subject`: one short single-line subject when a suitable project style can be inferred.
- Stop after reporting; do not start the next iteration.

## Todo insertion

`subagent_loop_insert_todo` inserts a new task at an explicit array position. Existing todo IDs and completed iteration `todoId` references are preserved; execution order follows the persisted todo array order. The inserted todo defaults to `deferred`, uses the caller-provided semantic ID, can include a per-todo `model`, and increments `maxIterations` when that field is present. The tool refuses to modify loops with running todos or iterations and supports `dryRun: true` for a before/after preview.

`subagent_loop_assign_todo_model` updates or clears a persisted model override for a future todo. It refuses a `running` todo so callers do not imply that an already-started child worker changed models.

## Worker help requests

`subagent_loop_request_help` is a terminal escalation path for the active worker. The tool infers the single running loop when possible, or accepts `name`; it refuses when no running loop/iteration exists, when multiple running loops exist and no name is supplied, when the selected loop has no running todo, or when the active iteration directory is missing.

On success, it writes `help-request.md` and `help-request.json` in the active iteration directory, stores a compact `helpRequest` summary/link on the running todo and iteration, sets loop control to `paused`, marks the todo `interrupted`, and marks the iteration `aborted` with `Status: not_run`. The worker must then write `handoff-out.md`, write `verification.md` with `Status: not_run`, and stop. When the worker exits, the orchestrator preserves the interrupted/help-request state instead of converting the todo to `failed` merely because verification was not run. Status output includes the open question and artifact path.

The orchestrator/human should answer the question later and insert a visible resolution subtask; the v1 tool does not resume the same worker and does not automatically create follow-up todos.

## Todo restart

`subagent_loop_restart` and `/loop-restart [name] [--todo TODO_ID] [--dry-run]` recover from `failed` or `interrupted` todos by discarding the current visible attempt and retrying the original todo from scratch. Restart is intentionally not a continue/resume primitive; continue-like recovery should be represented by inserting a resolution subtask instead.

A dry run reports the selected loop/todo, latest iteration for that todo, `beforeRef`, current `HEAD`, the rescue ref that would be created, whether the worktree is dirty, and whether resolution subtasks block restart. A real restart refuses running loops, todos without `failed`/`interrupted` status, missing `beforeRef`s, and todos with resolution subtasks. It creates a rescue ref at current `HEAD`, runs `git reset --hard` to the iteration `beforeRef`, marks the same todo `queued`, clears the active run budget/blocking state, preserves historical iteration records, writes state/plan updates, and returns the next action: run one fresh iteration with `/loop-run --max 1` or `subagent_loop_run({ maxIterations: 1 })`.

## Run-limit behavior

`/loop-start --max N` creates the first `N` tasks as `queued` and the rest as `deferred`.

`/loop-run --max N` sets control to `active`, persists `runBudget.remaining = N`, scopes the current run to at most `N` queued tasks, and can promote deferred tasks into that scope when no queued work remains. The loop only picks `queued` tasks.

If the loop is already running in the background, another `/loop-run --max N` or `subagent_loop_run({ maxIterations: N })` does not start a second worker. It adds `N` to the persisted run budget, promotes deferred work if needed, and the active orchestrator consults that budget after the current worker exits.

Use `/loop-run --max 1` for a single worker iteration. There is no `/loop-next` command.

## Control semantics

- **Pause** is soft: set control to `paused`, clear the active run budget, and defer queued work. If a worker is already running, it is allowed to finish the active iteration, and the orchestrator does not start another iteration.
- **Resume** is not a command. Running again with `/loop-run` sets control to `active` and starts fresh worker iterations for queued work.
- **Kill** is hard: send `SIGTERM` to active child worker processes for that loop and set control to `paused`. If non-loop worktree changes are detected, the active task becomes `interrupted`; otherwise it may return to `queued`. The killed child session cannot be resumed in-place. Inspect Subagent Loop status and `git status` before running again.
- **Restart** is destructive retry: create a rescue ref, reset hard to the failed/interrupted todo's `beforeRef`, requeue that same todo, and then run one fresh iteration. Dry-run restart before the reset unless the user explicitly requested immediate restart.

Removed command/tool surface: stop, resume, next, and ralph-control. Legacy `/ralph-*` commands and `ralph_orchestrator_*` tools have been replaced by `/loop-*` and `subagent_loop_*`.
