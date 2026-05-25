# Ralph Orchestrator Protocol

## Roles

- Orchestrator extension: owns state, git policy, artifacts, and commands.
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

## Initial git refs

- `refs/ralph/<loop>/iter-001-before`
- `refs/ralph/<loop>/iter-001-after`

## Runner boundary

The default `pi-json` runner spawns a fresh `pi --mode json` worker process. The deterministic `scripted` runner is retained for local tests and writes the same artifacts.
