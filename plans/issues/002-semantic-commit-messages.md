# Issue 002: Use semantic todo identity and worker summaries in Ralph commit messages

## Problem Statement

Ralph currently creates iteration commits with messages like `handoff: iteration 006 context` and `worker: iteration 006 changes`. These messages are technically correct but hard to understand in real project history, especially when physical iteration 006 corresponds to a semantic issue such as `Issue 005.1`.

Users want commits to reflect the work completed and, when possible, follow the target project's commit conventions such as `feat:`, `fix:`, `docs:`, or similar prefixes.

## Solution

Introduce commit message generation helpers that use semantic todo identity for deterministic Ralph commits and allow the worker to provide a concise project-convention-aware commit subject for the final worker commit.

The handoff commit should remain deterministic and identify the assignment context. The worker commit should prefer a worker-provided commit subject when available, falling back to a deterministic Ralph message using semantic todo identity.

## User Stories

1. As a Ralph user, I want handoff commits to mention the semantic todo ID, so that I can map Git history to issue plans.
2. As a Ralph user, I want worker commits to summarize the actual work completed, so that Git history is readable.
3. As a Ralph user, I want worker commits to follow project conventions when the worker can infer them, so that Ralph history fits the surrounding repository.
4. As a Ralph user, I want physical iteration numbers retained somewhere when helpful, so that I can debug Ralph artifacts.
5. As a Ralph maintainer, I want deterministic fallback commit messages, so that commits still work if the worker omits a commit subject.
6. As a Ralph worker, I want the handoff to request a commit subject explicitly, so that I know what artifact to produce.
7. As a Ralph user, I want commit subjects to be short and single-line, so that Git history remains clean.
8. As a Ralph user, I want invalid or multiline worker commit subjects sanitized, so that a bad worker output does not break commits.

## Implementation Decisions

- Keep two commits by default: a handoff/context commit and a worker/result commit.
- Handoff commits should use a deterministic semantic label, for example `handoff: ISSUE-005.1 context`.
- Worker commits should prefer a parsed worker-provided commit subject, for example `feat: add verbose transcription progress`.
- If no valid worker commit subject is found, fall back to a deterministic message like `worker: ISSUE-005.1 changes`.
- Update the worker handoff/report contract to include a `Commit subject` section.
- Parse the commit subject from the worker's handoff-out artifact, not from the raw event stream.
- Sanitize commit subjects to one line, trim whitespace, and reject empty or excessively long values.
- Store the accepted commit subject on the iteration state for later inspection.

## Testing Decisions

- Add tests for commit message helper behavior with semantic IDs, missing semantic IDs, and invalid worker subjects.
- Add an orchestrator test showing the worker result commit uses a parsed commit subject when present.
- Add fallback tests showing Ralph still commits with deterministic messages if no subject is supplied.
- Test behavior through Git log assertions where practical, matching existing test style.

## Out of Scope

- Squashing the handoff and worker commits into one commit.
- Automatically rewriting old commits.
- Enforcing a universal commit convention across all projects.
- Asking the parent orchestrator LLM to generate the worker commit after the fact.

## Further Notes

The worker has the best context for the final commit subject because it has inspected the project and performed the changes. The orchestrator should only validate and apply the subject, not invent detailed project-specific commit messages itself.
