# Issue 005: Document Ralph identity, commit, and worker-output protocol updates

## Problem Statement

Ralph's protocol is evolving from numeric-only todos and raw worker JSONL logs toward semantic todo identity, readable commit subjects, compact committed worker output, and ignored raw traces. Users and future agents need the protocol documented so they understand which artifacts are durable, which are local diagnostics, and how todo identity relates to execution order.

## Solution

Update the package documentation to describe the revised state model, artifact model, commit model, and worker/orchestrator responsibilities. The documentation should make the new invariants explicit and should be suitable for future agents modifying Ralph internals.

## User Stories

1. As a Ralph user, I want to understand why todo IDs are semantic, so that I do not treat them as list positions.
2. As a Ralph user, I want to understand that array order controls execution order, so that I can reason about inserted todos.
3. As a Ralph user, I want to understand why there are handoff and worker commits, so that Git history makes sense.
4. As a Ralph user, I want to know which artifacts are committed and which are ignored, so that I can manage repository history confidently.
5. As a Ralph maintainer, I want schema migration rules documented, so that future changes do not break existing loops.
6. As a Ralph worker author, I want the expected handoff-out sections documented, so that workers produce parseable summaries and commit subjects.
7. As a Ralph user, I want configuration or environment options documented if raw output modes exist, so that I can enable raw traces during debugging.

## Implementation Decisions

- Document semantic todo identity separately from physical iteration numbers.
- Document that physical iteration numbers, refs, and artifact directories remain numeric and chronological.
- Document the handoff commit as the assignment/context boundary and the worker commit as the result boundary.
- Document compact `worker-output.jsonl` as the committed worker event summary.
- Document raw worker trace files as local ignored diagnostics.
- Document `.ralph/.gitignore` generation and the rules it manages.
- Document fallback behavior for legacy numeric loops.
- Include examples using issue-like IDs such as `ISSUE-005.1`.

## Testing Decisions

- Documentation changes should be reviewed alongside tests from the feature issues.
- If docs include command or artifact examples, align them with actual render output tested elsewhere.

## Out of Scope

- Publishing docs to an external website.
- Creating end-user tutorials for every Ralph command.
- Documenting internal implementation details that are not stable protocol behavior.

## Further Notes

This issue should be completed after the implementation issues have settled naming and artifact details, so the docs do not encode outdated decisions.
