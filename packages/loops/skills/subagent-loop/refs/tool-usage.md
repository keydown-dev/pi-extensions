# Tool Usage

Preferred tools: `subagent_loop_plan`, `subagent_loop_start`, `subagent_loop_run`, `subagent_loop_insert_todo`, `subagent_loop_pause`, `subagent_loop_kill`, `subagent_loop_status`, `subagent_loop_list`.

Preferred commands: `/loop-plan`, `/loop-start`, `/loop-run`, `/loop-pause`, `/loop-kill`, `/loop-status`, `/loop-list`, `/loop-widget`.

Check status/list before acting when the active loop is unclear. Ask for approval before starting a new approved plan, running a broad budget, or killing a worker. Pause lets the current worker finish; kill terminates active child processes and requires inspection before resuming. Use `maxIterations: 1` or `/loop-run --max 1` for one bounded iteration.
