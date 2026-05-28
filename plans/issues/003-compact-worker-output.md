# Issue 003: Replace token-stream worker logs with compact committed worker output

## Problem Statement

Ralph currently writes the child `pi --mode json` output stream directly into `worker-output.jsonl`. In real runs, this file can become too large to commit because streaming response events may produce large rows for small token deltas. The resulting artifact is noisy, expensive to store in Git, and hard for humans to review.

Users still want useful worker trace information for auditability and debugging, but not token-by-token raw streams in committed history.

## Solution

Split worker output into compact committed output and raw local trace output. The compact `worker-output.jsonl` should contain coalesced, meaningful records such as worker start, process metadata, assistant messages, tool calls, tool results or summaries, usage snapshots, worker result, and worker exit. The raw stream should be written separately only when enabled and ignored by Git.

## User Stories

1. As a Ralph user, I want committed worker output to be small, so that Ralph commits remain reviewable.
2. As a Ralph user, I want assistant messages coalesced into complete records, so that I do not see token-by-token noise.
3. As a Ralph user, I want useful process metadata retained, so that I can debug failed workers.
4. As a Ralph user, I want usage data retained, so that I can understand cost and context consumption.
5. As a Ralph user, I want raw output available locally when debugging, so that I can inspect the exact child process stream if needed.
6. As a Ralph maintainer, I want the worker progress tracker to continue receiving streaming events, so that the UI widget remains responsive.
7. As a Ralph maintainer, I want the compact writer to be testable in isolation, so that stream compaction can evolve safely.
8. As a Ralph user, I want failed or killed workers to still produce compact exit/error records, so that failures are diagnosable.

## Implementation Decisions

- Introduce a deep module responsible for compacting Pi JSON events into durable worker event records.
- Keep progress tracking separate from compact output writing; both can consume the same parsed event stream.
- Coalesce streaming assistant updates into a single assistant message record where possible.
- Record tool-call starts and useful tool-call metadata without duplicating full token deltas.
- Append a final worker result record after the orchestrator parses handoff-out and verification.
- Prefer compact output as the default committed artifact.
- Support optional raw output modes for debugging, but do not require raw logs for normal operation.
- Treat malformed partial JSON lines defensively: preserve process stability and emit a compact warning/error record where appropriate.

## Testing Decisions

- Unit-test the compact event writer with representative streaming message events.
- Test that many token/message update events produce one or a small number of compact records.
- Test that worker start, process metadata, exit, usage, and worker result records are preserved.
- Add regression tests ensuring compact output is much smaller than raw output for repeated streaming updates.
- Keep tests focused on external output records, not private buffering details.

## Out of Scope

- Building a UI viewer for worker traces.
- Storing full raw traces in a database or remote artifact store.
- Guaranteeing perfect reconstruction of the original token stream from compact output.
- Changing handoff-out or verification as the primary worker/orchestrator contract.

## Further Notes

The compact output writer should make `worker-output.jsonl` useful as a committed flight-recorder summary, while raw logs remain an opt-in local diagnostic artifact.
