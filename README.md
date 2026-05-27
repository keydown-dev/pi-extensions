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
- `ralph_orchestrator_pause`
- `ralph_orchestrator_kill`
- `ralph_orchestrator_status`
- `ralph_orchestrator_list`

The run tool/command returns immediately after starting background orchestration, so the parent/orchestrator chat remains available while the Ralph widget streams progress. Widget hint: `Chat to pause, resume, kill or steer the orchestrator.`

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

## Artifacts and git policy

Starting a loop requires a clean worktree, creates/checks out `orchestrator/<loop-name>`, and commits initial loop state. Each iteration commits handoff context before the worker starts, then commits the worker result when the iteration finishes. The orchestrator records before/after refs and captures code diff stats for completed work, excluding local `.ralph/` artifacts from displayed line counts.

Ralph artifacts live under `.ralph/orchestrator/`. This repo ignores `.ralph/` so loop state, handoffs, and worker transcripts stay local unless a project explicitly chooses to track them.

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
