# Artifact Protocol

Loop artifacts currently live under the legacy `.ralph/orchestrator/loops/<name>/` directory. Each loop has `plan.md`, `state.json`, optional `decisions.md`, and numbered `iterations/NNN/` directories with handoff, verification, git status, and compact worker output files.

Todo IDs are semantic identities; execution order follows the todo array. Physical iteration directories remain numeric. The orchestrator creates git checkpoints before and after worker iterations. Raw worker traces are local diagnostics; compact worker output and handoff artifacts are the durable audit trail.

See `docs/protocol.md` for the full state, artifact, commit, worker-output, and compatibility protocol.
