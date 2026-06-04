# Artifact Protocol

Loop artifacts currently live under the `.loop/orchestrator/loops/<name>/` directory. Each loop has `plan.md`, `state.json`, optional `decisions.md`, and numbered `iterations/NNN/` directories with handoff, verification, git status, and compact worker output files.

Todo IDs are semantic identities; execution order follows the todo array. Physical iteration directories remain numeric. The orchestrator creates git checkpoints before and after worker iterations. Raw worker traces are local diagnostics; compact worker output and handoff artifacts are the durable audit trail.

When a worker calls `subagent_loop_request_help`, the active iteration directory contains `help-request.md` and `help-request.json`. Treat these as the source of truth for the blocked question. The orchestrator should answer according to the loop packet's clarification policy, record whether the answer was `human-provided` or `orchestrator-inferred`, and insert a resolution subtask with `subagent_loop_insert_todo_subtask` rather than editing `state.json` by hand or resuming the same worker.

Resolution subtask instructions are part of the durable audit trail. They should point to prior iteration artifacts, explain why the parent is incomplete, state the answer/decision and answer source, and remind the next worker that the original acceptance criteria and verification standards still apply.

See `docs/protocol.md` for the full state, artifact, commit, worker-output, and compatibility protocol.
