# pi-ralph-orchestrator

A fresh-context, Ralph-style orchestrator for Pi.

This package provides:

- a Pi package manifest with bundled extension and skills
- a `/ralph` command namespace
- loop artifacts stored under `.ralph/orchestrator/`
- a strict clean-worktree policy before starting loops
- orchestration branch creation
- before/after git refs for each iteration
- a deterministic scripted worker for test-driving loops
- todo-style progress rendering adapted from MIT-licensed Pi UI packages

## Install locally

From this repo:

```bash
pi install .
```

Or run temporarily:

```bash
pi -e .
```

## Command reference

Primary commands:

| Command | Purpose |
| --- | --- |
| `/ralph-plan <goal>` | Start a planning interview using the bundled `ralph-plan` skill. Produces an approved loop packet before any workers run. |
| `/ralph-start <name> [--max N] [--todo item ...]` | Prepare a new loop: state, artifacts, branch, plan, and todo list. Status becomes `ready`; workers do not run until `/ralph-next` or `/ralph-run`. |
| `/ralph-next [name] [--runner pi-json\|scripted] [--model MODEL]` | Execute exactly one worker iteration for the active or named loop. Best for inspectable, step-by-step progress. |
| `/ralph-run [name] [--max N] [--runner pi-json\|scripted] [--model MODEL]` | Execute multiple `/ralph-next`-style iterations up to `--max N`. This is convenience automation, not a different execution model. |
| `/ralph-status [name]` | Show the active loop, or a named loop, including status, iteration count, branch, and todo progress. |
| `/ralph-list` | List all loops under `.ralph/orchestrator/loops/` with compact status/progress summaries. |
| `/ralph-stop [name]` | Stop the active or named loop and clear the active UI widget. |

Secondary/compatibility commands:

| Command | Purpose |
| --- | --- |
| `/ralph resume <name>` | Resume a stopped loop by setting it back to `running`. |
| `/ralph start <name> [--max N]` | Compatibility alias for `/ralph-start`. |
| `/ralph stop [name]` | Compatibility alias for `/ralph-stop`. |
| `/ralph status [name]` | Compatibility alias for `/ralph-status`. |
| `/ralph list` | Compatibility alias for `/ralph-list`. |
| `/ralph next [name]` | Compatibility alias for `/ralph-next`. |
| `/ralph run [name] --max N` | Compatibility alias for `/ralph-run`. |

Runner modes:

| Runner | Purpose |
| --- | --- |
| `pi-json` | Default. Spawns a fresh `pi --mode json` worker process with a bounded handoff. |
| `scripted` | Deterministic math-kata test runner. Only for local automated tests/fixtures. |

You can also ask naturally, for example:

```text
Can we set up a ralph loop to get through our issues? Max of 5 loops.
```

The extension exposes agent tools for the same flow:

- `ralph_orchestrator_plan`, which runs a planning/grilling phase before a loop starts
- `ralph_orchestrator_start`, which creates governed loop state but does not execute workers
- `ralph_orchestrator_next`, which runs exactly one worker iteration
- `ralph_orchestrator_run`, which runs a bounded number of worker iterations
- `ralph_orchestrator_status`, which inspects one loop
- `ralph_orchestrator_list`, which lists workspace loops

Use `/ralph-plan` when you want the agent to interview you, derive issues or todos, define validation standards, and decide which skills subagents should invoke before starting the loop. It invokes the bundled `ralph-plan` skill, which is intentionally lightweight: it asks which planning/grilling skill or project process you prefer, which skills workers should invoke, which files are mandatory context, and which durable project or workspace documentation should be created or updated.

Agent tool flow:

```text
ralph_orchestrator_plan
→ user approval
→ ralph_orchestrator_start
→ ralph_orchestrator_next or ralph_orchestrator_run
→ ralph_orchestrator_status or ralph_orchestrator_list
```

The start tool only prepares a loop. It returns next-step guidance so the agent can continue with a run/status tool without inspecting extension code.

The status widget uses a compact todo-style vocabulary:

```text
○ pending
⠹ running spinner
✓ completed
✗ failed
```

Ralph is intentionally Git-first. Starting a loop requires a clean worktree, creates/checks out `orchestrator/<loop-name>`, and commits the initial loop state. Each iteration commits its handoff context before the worker starts, then commits the worker result when the iteration finishes. The orchestrator records before/after refs and captures code diff stats for completed work, excluding local `.ralph/` artifacts from the displayed line counts.

`/ralph-next` and `/ralph-run` default to a real fresh-context Pi worker via `pi --mode json`. Pass `--model MODEL` (or the agent tool `model` parameter) to use any model pattern/ID already configured in Pi, independent of the parent/orchestrator session model. The worker receives a bounded handoff and writes `handoff-out.md` and `verification.md`; the orchestrator captures `worker-output.jsonl`, git status, before/after refs, and per-iteration diff stats. While the worker runs, the UI marks the active todo with a Braille spinner and streams worker progress including model, elapsed time, JSON events, tool calls, assistant messages, token usage, context-window percentage when inferable, and cost when reported by Pi.

Ralph artifacts live under `.ralph/orchestrator/`. This repo ignores `.ralph/` so loop state, handoffs, and worker transcripts stay local unless a project explicitly chooses to track them.

For deterministic local tests, use `--runner scripted` with the math-kata fixture.

## Test

```bash
npm install
npm test
npm run typecheck
```

The integration test creates a temporary git repo containing a tiny math project. Ralph then runs three iterations:

1. add subtract test + implementation
2. add multiply test + implementation
3. add divide test + implementation

The test verifies artifacts, status rendering, git refs, and project tests.

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
