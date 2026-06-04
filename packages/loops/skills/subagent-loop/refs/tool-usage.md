# Tool Usage

Preferred tools: `subagent_loop_plan`, `subagent_loop_start`, `subagent_loop_run`, `subagent_loop_insert_todo`, `subagent_loop_insert_todo_subtask`, `subagent_loop_request_help`, `subagent_loop_restart`, `subagent_loop_pause`, `subagent_loop_kill`, `subagent_loop_status`, `subagent_loop_list`.

Preferred commands: `/loop-plan`, `/loop-start`, `/loop-run`, `/loop-restart`, `/loop-pause`, `/loop-kill`, `/loop-status`, `/loop-list`, `/loop-widget`.

Check status/list before acting when the active loop is unclear. Ask for approval before starting a new approved plan, running a broad budget, killing a worker, or performing a destructive restart. Pause lets the current worker finish; kill terminates active child processes and requires inspection before resuming. Use `maxIterations: 1` or `/loop-run --max 1` for one bounded iteration.

## Worker help requests

Workers should call `subagent_loop_request_help` when blocked by ambiguity, missing requirements, unclear ownership, unclear verification, or a product/architecture/security/irreversible decision instead of guessing. After requesting help, the worker writes final artifacts with `Status: not_run` and stops.

When an open help request appears:

1. Inspect `subagent_loop_status` and the linked `help-request.md` / `help-request.json` artifact.
2. Check the loop packet's clarification policy.
3. Answer from existing project context only if policy permits and confidence is high.
4. Ask the human if confidence is low or the decision involves product direction, architecture tradeoffs, security, irreversible changes, or ambiguous ownership.
5. Record whether the answer is `human-provided` or `orchestrator-inferred`.
6. Insert a visible resolution subtask with `subagent_loop_insert_todo_subtask`.
7. Run the loop for that resolution subtask.

Do not create the resolution subtask until you have enough information to write useful handoff instructions.

## Continue vs restart

Create a resolution subtask with `subagent_loop_insert_todo_subtask` when:

- the previous worker asked for help
- the worker was killed or shut down but left useful progress
- the task is incomplete but salvageable
- the next worker should inspect current repository state and prior artifacts
- preserving an audit trail matters

Restart with `subagent_loop_restart` when:

- the previous attempt should be discarded
- current changes are bad, noisy, or wrong
- the user wants the original todo retried from its `beforeRef`
- no resolution subtasks already exist for that todo

Restart is destructive recovery: it discards a failed/interrupted todo attempt by resetting to its `beforeRef`; dry-run restart first unless the user explicitly requested immediate restart. Do not introduce or imply a separate continue tool; continuation is the resolution-subtask workflow.

## Resolution subtask instructions

`subagent_loop_insert_todo_subtask` instructions are persisted as handoff instructions. Include:

- why the parent/subtask was incomplete
- the blocking question or problem
- the answer or decision
- whether the answer was `human-provided` or `orchestrator-inferred`
- relevant artifact paths or iteration numbers
- a reminder that the original acceptance criteria and verification standards still apply
- any additional acceptance criteria or clarification accumulated along the chain
