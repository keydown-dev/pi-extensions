# Tool Usage

Preferred tools: `subagent_loop_plan`, `subagent_loop_start`, `subagent_loop_run`, `subagent_loop_insert_todo`, `subagent_loop_restart`, `subagent_loop_pause`, `subagent_loop_kill`, `subagent_loop_status`, `subagent_loop_list`.

Preferred commands: `/loop-plan`, `/loop-start`, `/loop-run`, `/loop-restart`, `/loop-pause`, `/loop-kill`, `/loop-status`, `/loop-list`, `/loop-widget`.

Check status/list before acting when the active loop is unclear. Ask for approval before starting a new approved plan, running a broad budget, killing a worker, or performing a destructive restart. Pause lets the current worker finish; kill terminates active child processes and requires inspection before resuming. Restart discards a failed/interrupted todo attempt by resetting to its `beforeRef`; dry-run restart first unless the user explicitly requested immediate restart. Use `maxIterations: 1` or `/loop-run --max 1` for one bounded iteration.
