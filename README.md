# pi-ralph-orchestrator

A fresh-context, Ralph-style orchestrator for Pi.

This package provides a `/ralph` command namespace, local loop artifacts under `.ralph/orchestrator/`, orchestration branches, before/after git refs for each iteration, fresh `pi --mode json` workers, and a deterministic scripted worker for tests.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/keydown-dev/pi-ralph-subagents
```

Or pin a specific branch, tag, or commit:

```bash
pi install git:github.com/keydown-dev/pi-ralph-subagents@development
```

For a one-off trial without adding it to your Pi settings:

```bash
pi -e git:github.com/keydown-dev/pi-ralph-subagents
```

From a local checkout of this repo:

```bash
pi install .
```

This package is not published to npm yet, so use the Git or local-path installation forms above.

## Command reference

| Command | Purpose |
| --- | --- |
| `/ralph-plan <goal>` | Start a planning interview using the bundled `ralph-plan` skill. |
| `/ralph-start <name> [--max N] [--todo item ...]` | Prepare a new loop. Tasks beyond `--max N` are marked `deferred`; workers do not run until `/ralph-run`. |
| `/ralph-run [name] [--max N] [--runner pi-json\|scripted] [--model MODEL]` | Run queued work in the background. If paused, this resumes the loop. Use `--max 1` for one iteration. |
| `/ralph-pause [name]` | Soft pause. A running worker may finish, but Ralph will not pick another queued task. |
| `/ralph-kill [name]` | Hard abort active child worker processes, pause the loop, then require inspection before running again. |
| `/ralph-status [name]` | Show loop control, derived status, iteration count, branch, and task progress. |
| `/ralph-list` | List all loops under `.ralph/orchestrator/loops/`. |

There are no stop/resume/next/control aliases. Resume by running again with `/ralph-run`; run one task with `/ralph-run --max 1`.

Runner modes:

| Runner | Purpose |
| --- | --- |
| `pi-json` | Default. Spawns a fresh `pi --mode json` worker process with a bounded handoff. |
| `scripted` | Deterministic math-kata test runner for local automated tests/fixtures. |

Agent tools:

- `ralph_orchestrator_plan`
- `ralph_orchestrator_start`
- `ralph_orchestrator_run`
- `ralph_orchestrator_insert_todo`
- `ralph_orchestrator_pause`
- `ralph_orchestrator_kill`
- `ralph_orchestrator_status`
- `ralph_orchestrator_list`

The run tool/command returns immediately after starting background orchestration, so the parent/orchestrator chat remains available while the Ralph widget streams progress. Widget hint: `Chat to pause, resume, kill or steer the orchestrator.`

`ralph_orchestrator_insert_todo` safely inserts a new todo after a stable `afterTodoId` without renumbering existing todos or completed iteration references. Todo IDs are semantic identity, not list positions; execution order follows the persisted todo array. The insert tool refuses to run while any todo/iteration is `running`, defaults the inserted todo to `deferred`, requires a caller-provided semantic ID such as `ISSUE-005.1`, increments `maxIterations` when present, updates both `state.json` and `plan.md`, and supports `dryRun: true` for preview.

## State model

Loop state persists only control:

```ts
loop.control: "active" | "paused"
```

Task state carries work lifecycle:

```ts
task.status: "queued" | "running" | "complete" | "deferred" | "failed" | "interrupted"
```

Display status is derived:

- `running`: any task is running
- `needs_attention`: any task failed or was interrupted
- `paused`: control is paused and no task is running
- `ready`: control is active and queued or deferred work remains
- `completed`: no queued/running/deferred/failed/interrupted work remains

`deferred` means the task is part of the plan but outside the current run scope. If only deferred tasks remain, the loop displays as ready; running again promotes deferred tasks into the current run scope.

## Control semantics

- **Pause**: set loop control to `paused`. If a worker is already running, let it finish the current task, then do not start another task.
- **Resume**: there is no resume command. Running again (`/ralph-run`) sets control to `active` and picks queued work.
- **Kill**: send `SIGTERM` to active child `pi --mode json` workers. The loop is paused. If non-Ralph worktree changes are detected, the running task becomes `interrupted`; otherwise it can return to `queued`. Inspect Ralph status and `git status` before running again.

## Artifacts, identity, and git policy

Starting a loop requires a clean worktree, creates/checks out `orchestrator/<loop-name>`, and commits initial loop state. Each iteration creates a handoff commit (`handoff: <todo-id> context`) before the worker starts, then a worker-result commit when the iteration finishes. Worker commits use a valid single-line `## Commit subject` from `handoff-out.md` when provided, otherwise fall back to `worker: <todo-id> changes`.

Todo IDs are stable semantic identity (`001-document-protocol`, `ISSUE-005.1`); physical iteration numbers, directories, and refs remain numeric and chronological. The orchestrator records before/after refs and captures code diff stats for completed work, excluding local `.ralph/` artifacts from displayed line counts.

Ralph artifacts live under `.ralph/orchestrator/`. This repo ignores `.ralph/` so loop state, handoffs, and worker transcripts stay local unless a project explicitly chooses to track them. When `.ralph/` is tracked, `worker-output.jsonl` is the compact committed worker event summary. Raw diagnostic traces such as `worker-output.raw.jsonl` are local-only, ignored by Ralph-managed `.ralph/.gitignore`, and unstaged before commits. Enable raw traces for debugging with `RALPH_WORKER_RAW_OUTPUT=1` (`true` and `yes` also work).

See `docs/protocol.md` for the full state, artifact, commit, worker-output, and schema compatibility protocol.

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
