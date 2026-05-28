# Issue 001: Replace numeric Ralph todo IDs with semantic string IDs

## Problem Statement

Ralph loop state currently stores todos with numeric IDs. These IDs look like list positions, even though todo array order is the actual execution order and IDs are stable references from iteration history. This creates confusion when new work is inserted into an in-progress loop: an inserted sub-iteration may receive numeric ID `13` while logically representing `Issue 005.1`.

Users want todo identity in state, plans, handoffs, status output, insertion tools, and commits to reflect the external issue or work item being performed. IDs should look like `001-setup-monorepo`, `003.1-add-logging`, `ISSUE-005.1`, or whatever convention the source issue list already uses, rather than mutable-looking numeric list positions.

## Solution

Replace Ralph's new-loop todo identity model with semantic string IDs. A todo's `id` should be a stable string chosen by the orchestrator agent/user from the source material or explicitly supplied when inserting work. Execution order remains determined only by the todo array order. Physical Ralph iteration numbers remain numeric and chronological.

Existing loops with numeric todo IDs remain supported as legacy state. Ralph should not automatically migrate existing numeric loops. New loops and newly inserted todos should use semantic string IDs.

The insertion API should also move away from `afterTodoId`. New todo insertion should use `insertAtIndex`, a zero-based insertion position in the `todos` array: `0` inserts before the first todo, `1` inserts before the second todo, and omitting `insertAtIndex` appends to the end. The insertion tool must reject attempts to insert before completed work.

## User Stories

1. As a Ralph user, I want todo IDs to resemble issue IDs or concise work IDs, so that state files are easy to understand.
2. As a Ralph user, I want inserted sub-iterations to have IDs like `003.1-add-logging`, so that they are visibly related to the surrounding work.
3. As a Ralph user, I want todo execution order to remain determined by array order, so that semantic IDs do not need to sort lexically.
4. As a Ralph user, I want existing numeric-ID loops to keep working, so that upgrading Ralph does not force immediate migration.
5. As a Ralph user, I want new loops to use semantic string IDs, so that future state is not confused with positional numbering.
6. As a Ralph user, I want inserted todos to require an explicit semantic ID, so that the orchestrator agent/user can match GitHub, Kanban, or markdown issue conventions.
7. As a Ralph user, I want `insertAtIndex` to describe the exact array insertion position, so that insertion does not depend on looking up an existing todo ID.
8. As a Ralph user, I want Ralph to reject insertion before completed todos, so that completed history is not destabilized.
9. As a Ralph user, I want Ralph to reject insertion if completed todos are not grouped at the start of the list, so that it does not silently reorder or normalize audit history.
10. As a Ralph worker, I want handoff files to show the semantic todo ID, so that I can link my task to the intended issue.
11. As a Ralph user, I want status and plan output to show semantic IDs clearly, so that I can map Ralph work back to issue files.
12. As a Ralph maintainer, I want parsers and renderers to support both legacy numeric IDs and new semantic string IDs, so that compatibility is explicit and tested.

## Implementation Decisions

- `RalphTodo.id` becomes a string for all newly created todos.
- `IterationState.todoId` must support both legacy numeric IDs and new string IDs.
- Existing numeric-ID loops are legacy-compatible only. Ralph should read and operate on them, but should not automatically rewrite their IDs.
- New loops must create semantic string IDs for each todo.
- The orchestrator agent/user is responsible for choosing IDs that match the source issue system when one exists.
- If the source issues already have IDs, Ralph should preserve that format, for example GitHub/Kanban/markdown-derived IDs.
- If there is no source convention, default IDs should combine a zero-padded number and a short slug, for example `001-setup-monorepo` or `003.1-add-logging`.
- Decimal IDs are the default convention for inserted sub-items when no external convention is supplied, for example `003.1-add-logging`.
- Inserted todos must include an explicit `id` parameter. The insertion tool validates that it is non-empty and unique in the loop.
- `ralph_orchestrator_insert_todo` should replace `afterTodoId` with `insertAtIndex`.
- `insertAtIndex` is a zero-based insertion position: `0` means before the first todo; `todos.length` means append; omitted means append.
- The insertion tool must fail if `insertAtIndex` is before any completed todo.
- The insertion tool must verify all completed todos form a prefix at the start of the todo array. If a completed todo appears after an incomplete todo, fail with a clear inconsistency error rather than reordering.
- Ralph must not reorder todos during insertion. Reordering would mutate execution order and audit history.
- Physical iteration numbers, iteration artifact directories, before/after refs, and `currentIteration` remain numeric Ralph runtime artifacts.
- Handoff, plan, status, and worker prompts should display semantic todo IDs.
- Commit-message work can use semantic todo IDs, but detailed LLM/project-convention commit subjects are handled by the separate semantic commit messages issue.

## Testing Decisions

- Add schema/parser tests for new string-ID state.
- Add compatibility tests for legacy numeric-ID state.
- Add start-loop tests showing generated todos receive semantic string IDs rather than numeric IDs.
- Add insertion tests showing the caller must provide a unique string ID.
- Add insertion tests for `insertAtIndex`: insert at start, insert before first incomplete todo, and append when omitted.
- Add rejection tests for attempts to insert before completed todos.
- Add rejection tests for inconsistent state where completed todos do not form a prefix.
- Add status, plan, and handoff rendering tests showing semantic IDs are displayed.
- Add run tests showing `IterationState.todoId` records and resolves string IDs correctly.
- Test externally visible behavior: persisted state shape, rendered text, and run/insertion behavior. Avoid tests that depend on private helper internals.

## Out of Scope

- Automatically migrating existing numeric-ID loops to semantic string IDs.
- Changing physical iteration numbers or iteration directory names.
- Renaming existing iteration artifact directories.
- Reordering todos to repair inconsistent state.
- Rewriting historical Git commits.
- Generating project-convention-aware final commit messages; that belongs to the semantic commit messages issue.

## Further Notes

This issue intentionally resolves the previous ambiguity: Ralph should move to semantic string IDs for new todos, not add a separate `key` field. Numeric IDs remain supported only for legacy loops. The insertion API should be revised from ID-relative insertion to array-position insertion using `insertAtIndex`, with strong safeguards around completed work.
