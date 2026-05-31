# Subagent Loop - fresh-context worker loops

This package provides the **Subagent Loop** capability for Pi. It keeps the historical package name and legacy `.ralph/orchestrator/` artifact directory for compatibility, but the public command and tool surface is `/loop-*` and `subagent_loop_*`.

Subagent Loop creates local loop artifacts, orchestration branches, before/after git refs for each iteration, fresh `pi --mode json` workers, and a deterministic scripted worker for tests.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/keydown-dev/pi-subagent-loop
```

Or pin a specific branch, tag, or commit:

```bash
pi install git:github.com/keydown-dev/pi-subagent-loop@development
```

For a one-off trial without adding it to your Pi settings:

```bash
pi -e git:github.com/keydown-dev/pi-subagent-loop
```

From a local checkout of this repo:

```bash
pi install .
```

This package is not published to npm yet, so use the Git or local-path installation forms above.

## Command reference

| Command | Purpose |
| --- | --- |
| `/loop-plan <goal>` | Start a planning interview using the bundled `subagent-loop` skill. |
| `/loop-start <name> [--max N] [--model MODEL] [--todo item ...]` | Prepare a new loop. Tasks beyond `--max N` are marked `deferred`; `--model` sets the persisted loop default worker model. |
| `/loop-run [name] [--max N] [--runner pi-json\|scripted] [--model MODEL]` | Run queued work in the background. If paused, this resumes the loop. If already running, this queues `N` more persisted run-budget iterations instead of starting a second worker. |
| `/loop-pause [name]` | Soft pause. A running worker may finish, but the loop will not pick another queued task. |
| `/loop-kill [name]` | Hard abort active child worker processes, pause the loop, then require inspection before running again. |
| `/loop-status [name]` | Show loop control, derived status, iteration count, branch, and task progress. |
| `/loop-list` | List all loops under `.ralph/orchestrator/loops/`. |
| `/loop-widget [toggle\|compact\|expand\|show\|hide]` | Set Subagent Loop widget mode. |

Resume by running again with `/loop-run`; run one task with `/loop-run --max 1`.

Runner modes:

| Runner | Purpose |
| --- | --- |
| `pi-json` | Default. Spawns a fresh `pi --mode json` worker process with a bounded handoff. |
| `scripted` | Deterministic math-kata test runner for local automated tests/fixtures. |

Agent tools:

- `subagent_loop_plan`
- `subagent_loop_start`
- `subagent_loop_run`
- `subagent_loop_insert_todo`
- `subagent_loop_assign_todo_model`
- `subagent_loop_pause`
- `subagent_loop_kill`
- `subagent_loop_status`
- `subagent_loop_list`

The run tool/command returns immediately after starting background orchestration, so the parent/orchestrator chat remains available while the Subagent Loop widget streams progress. Calling it again while the same loop is running adds to `runBudget.remaining`; the active loop picks up that persisted budget after the current worker exits.

`subagent_loop_insert_todo` safely inserts a new todo at a stable `insertAtIndex` without renumbering existing todos or completed iteration references. Todo IDs are semantic identity, not list positions; execution order follows the persisted todo array. The insert tool refuses to run while any todo/iteration is `running`, defaults the inserted todo to `deferred`, requires a caller-provided semantic ID such as `ISSUE-005.1`, increments `maxIterations` when present, updates both `state.json` and `plan.md`, can include a per-todo `model`, and supports `dryRun: true` for preview.

Worker model precedence is: todo override (`todo.workerModel`) → loop default (`loop.workerDefaults.model`) → run-level fallback (`/loop-run --model` or tool `model`) → current/default Pi model. The loop persists the effective configured model on the iteration before launching the child worker and records observed model/provider when the worker reports them. `subagent_loop_assign_todo_model` can update or clear queued/deferred future todo overrides, but refuses the currently running todo so an active child worker's launch model cannot change mid-flight.

## State model

Loop state persists control and, during active/background runs, a mutable run budget:

```ts
loop.control: "active" | "paused"
loop.runBudget?: { remaining: number; updatedAt: string; updatedBy?: "command" | "tool" | "orchestrator" }
loop.workerDefaults?: { model?: string; provider?: string; contextWindow?: number }
```

Task state carries work lifecycle:

```ts
task.status: "queued" | "running" | "complete" | "deferred" | "failed" | "interrupted"
task.workerModel?: string
```

Display status is derived:

- `running`: any task is running
- `needs_attention`: any task failed or was interrupted
- `paused`: control is paused and no task is running
- `ready`: control is active and queued or deferred work remains
- `completed`: no queued/running/deferred/failed/interrupted work remains

`deferred` means the task is part of the plan but outside the current run scope. If only deferred tasks remain, the loop displays as ready; running again promotes deferred tasks into the current run scope.

## Control semantics

- **Pause**: set loop control to `paused`, clear the active run budget, and defer queued work. If a worker is already running, let it finish the current task, then do not start another task.
- **Resume**: there is no resume command. Running again (`/loop-run`) sets control to `active` and picks queued work.
- **Kill**: send `SIGTERM` to active child `pi --mode json` workers. The loop is paused. If non-loop worktree changes are detected, the running task becomes `interrupted`; otherwise it can return to `queued`. Inspect loop status and `git status` before running again.

## Artifacts, identity, and git policy

Starting a loop requires a clean worktree, creates/checks out `orchestrator/<loop-name>`, and commits initial loop state. Each iteration creates a handoff commit (`handoff: <todo-id> context`) before the worker starts, then a worker-result commit when the iteration finishes. Worker commits use a valid single-line `## Commit subject` from `handoff-out.md` when provided, otherwise fall back to `worker: <todo-id> changes`.

Todo IDs are stable semantic identity (`001-document-protocol`, `ISSUE-005.1`); physical iteration numbers, directories, and refs remain numeric and chronological. The orchestrator records before/after refs and captures code diff stats for completed work, excluding local `.ralph/` artifacts from displayed line counts.

Loop artifacts currently live under the legacy `.ralph/orchestrator/` directory. This repo ignores `.ralph/` so loop state, handoffs, and worker transcripts stay local unless a project explicitly chooses to track them. When `.ralph/` is tracked, `worker-output.jsonl` is the compact committed worker event summary. Raw diagnostic traces such as `worker-output.raw.jsonl` are local-only, ignored by managed `.ralph/.gitignore`, and unstaged before commits. Enable raw traces for debugging with `RALPH_WORKER_RAW_OUTPUT=1` (`true` and `yes` also work).

See `docs/protocol.md` for the full state, artifact, commit, worker-output, and schema compatibility protocol.

## Migration note

Ralph was the previous public name. Use `/loop-*` commands and `subagent_loop_*` tools going forward. The package name, some internal class names, git refs, and the `.ralph/` artifact path remain for compatibility.

## Test

```bash
npm install
npm test
npm run typecheck
```

## Artifact layout

```text
.ralph/orchestrator/loops/<name>/
├─ plan.md
├─ state.json
├─ decisions.md
└─ iterations/
   └─ 001/
      ├─ handoff-in.md
      ├─ handoff-out.md
      ├─ git-before.txt
      ├─ git-after.txt
      ├─ verification.md
      └─ worker-output.jsonl
```
