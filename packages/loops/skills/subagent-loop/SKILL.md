---
name: subagent-loop
description: Use when the user mentions Subagent Loop, subagent loops, fresh-context workers, worker handoffs, loop planning, loop status, loop iterations, background worker agents, or legacy Ralph loop/orchestrator workflows.
---

# Subagent Loop

Subagent Loop is the user-facing capability for planning and running bounded fresh-context worker iterations. Ralph is legacy/internal terminology and may still appear in package names, git refs, internal class names, or environment variables.

## Choose the workflow

Read only the relevant reference document(s):

- Planning a new loop: `refs/planning.md`
- Preparing an iteration handoff: `refs/brief.md`
- Acting as a fresh-context worker: `refs/pickup.md`
- Writing completion artifacts: `refs/report.md`
- Handing state between sessions: `refs/handoff.md`
- Understanding artifacts/git policy: `refs/artifact-protocol.md`
- Calling tools or commands: `refs/tool-usage.md`
- Terminology and legacy naming: `refs/terminology.md`

## Tool usage

Prefer `subagent_loop_*` tools and `/loop-*` commands. Use bounded runs (`maxIterations: 1` or `/loop-run --max 1`) when doing one worker slice.

## Prompt integrity rule

Do **not** modify the user's prompt to inject loop tool guidance. Use the available tools/commands directly when appropriate.
