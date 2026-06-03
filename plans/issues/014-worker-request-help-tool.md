# Issue 014: Add a worker request-help tool for human/orchestrator clarification

## Summary

Add a worker-facing escalation tool:

- `subagent_loop_request_help`

A fresh-context worker should call this when it is blocked by ambiguity, missing requirements, unclear ownership, or a decision that should not be guessed. The tool pauses the loop, records the help request, marks the current todo interrupted, and instructs the worker to stop cleanly after writing handoff/verification artifacts.

This is a terminal request in v1. The worker does not stay alive waiting for an answer. The orchestrator later resolves the question and inserts a resolution subtask.

## Motivation

Subagent Loop needs a human-in-the-loop escape hatch. Workers should not burn tokens or make product/architecture guesses when they discover an underspecified task. They need an explicit, discoverable way to surface the blocker to the orchestrator.

Current behavior forces workers to fail vaguely or continue guessing. The parent/orchestrator sees only a failed/interrupted todo, not a structured question.

## Desired workflow

1. Worker is running todo `005-auth-refresh`.
2. Worker discovers an ambiguity.
3. Worker calls:

```ts
subagent_loop_request_help({
  question: "Should auth refresh use Expo API routes or the existing backend?",
  context: "I found both patterns in the repo. Continuing may duplicate auth logic.",
  blockingReason: "Architecture ownership is unclear.",
  attemptedApproaches: ["Inspected app API routes", "Inspected backend client"],
  options: ["Expo API route", "Existing backend", "Client-only for now"],
  recommendation: "Use the existing backend.",
  riskIfGuessed: "May create duplicate auth/session behavior.",
  neededBy: ["src/auth/session.ts"]
})
```

4. Tool writes help request artifacts and state summary.
5. Tool sets loop control to `paused` and current todo to `interrupted`.
6. Tool response instructs worker to:
   - write `handoff-out.md`
   - write `verification.md` with `Status: not_run`
   - stop without further implementation work
7. Orchestrator reads the help request, answers from context or asks the human depending on planning policy.
8. Orchestrator inserts a resolution subtask with `subagent_loop_insert_todo_subtask`.

## Tool API

```ts
subagent_loop_request_help({
  name?: string;
  question: string;
  context?: string;
  blockingReason?: string;
  attemptedApproaches?: string[];
  options?: string[];
  recommendation?: string;
  riskIfGuessed?: string;
  neededBy?: string[];
})
```

`question` is required. All other fields are optional but should be encouraged in worker guidance.

## State/artifacts

Persist details in both artifact files and a small state summary.

Artifacts in the active iteration dir:

```txt
.loop/orchestrator/loops/<name>/iterations/003/help-request.md
.loop/orchestrator/loops/<name>/iterations/003/help-request.json
```

State should store a compact summary/link on the todo and/or iteration, for example:

```json
{
  "helpRequest": {
    "id": "help-003",
    "iteration": 3,
    "question": "Should auth refresh use Expo API routes or the existing backend?",
    "artifactPath": ".loop/orchestrator/loops/<name>/iterations/003/help-request.md",
    "createdAt": "...",
    "status": "open"
  }
}
```

Rich request details belong in the artifacts. State should be enough for status/tooling to summarize and point agents to the right file.

## Orchestrator behavior after worker exit

When the worker exits after a help request:

- Preserve the todo as `interrupted`.
- Preserve loop control as `paused` unless later user action changes it.
- Do not overwrite the todo to `failed` merely because verification is `not_run`.
- Mark the iteration using an existing status, preferably `aborted`, with summary like `Worker requested help`.
- Commit/persist handoff and help-request artifacts according to existing git policy.

## Worker guidance

Update both the pickup skill and generated child prompt. Workers should be told:

- If blocked by ambiguity or missing product/architecture decision, call `subagent_loop_request_help` instead of guessing.
- Include the question, context, attempted approaches, options, recommendation, risk if guessed, and affected files when useful.
- After the tool returns, stop work cleanly by writing handoff and verification with `Status: not_run`.
- Do not start the next todo.

## Validation/refusal rules

The tool should infer the active running loop/iteration from `cwd` and state when possible.

Refuse if:

- no running loop/iteration exists
- multiple running loops exist and `name` is omitted
- the selected loop has no running todo
- the selected iteration directory cannot be found
- the todo is not `running`

The tool should be safe to call from a child Pi worker process, assuming the loops extension is loaded there.

## Non-goals

- Do not implement live same-worker resume in v1.
- Do not kill the worker process from the tool.
- Do not add a new todo status like `blocked` in v1; use `interrupted` plus help-request metadata.
- Do not automatically insert a follow-up subtask from this tool.

## Tests

Add tests for:

1. Request-help writes markdown and JSON artifacts.
2. Request-help stores compact help summary/link in state.
3. Request-help pauses the loop and marks running todo interrupted.
4. Worker exit with `Status: not_run` preserves interrupted/help-request state.
5. Tool refuses when no running loop exists.
6. Tool refuses when multiple running loops exist and no name is supplied.
7. Status output surfaces the help request and artifact path.

## Documentation updates

Update README/protocol/skill docs to explain the request-help lifecycle and how the orchestrator should respond by resolving the question and inserting a resolution subtask.
