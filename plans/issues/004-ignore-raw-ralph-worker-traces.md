# Issue 004: Generate Ralph gitignore rules for raw worker traces

## Problem Statement

Raw worker output traces can be very large. Some projects ignore the whole `.ralph` directory, but others may choose to track Ralph orchestration artifacts. In those projects, raw JSONL files should not accidentally enter Git history.

Users want Ralph to protect them by generating ignore rules inside the `.ralph` artifact root whenever Ralph creates that root.

## Solution

Ensure Ralph creates or updates a `.ralph/.gitignore` file with rules that ignore raw worker trace files while allowing compact, human-readable, or summarized artifacts to be tracked if the project chooses.

## User Stories

1. As a Ralph user, I want raw worker traces ignored automatically, so that huge files are not accidentally committed.
2. As a Ralph user, I want compact worker artifacts to remain trackable, so that useful audit records can be committed.
3. As a Ralph user, I want `.ralph/.gitignore` generated consistently, so that I do not need to remember manual setup.
4. As a Ralph user, I want existing `.ralph/.gitignore` contents preserved, so that Ralph does not destroy local ignore rules.
5. As a Ralph maintainer, I want ignore-rule generation centralized, so that all artifact creation paths get the same protection.
6. As a Ralph user, I want compressed raw logs ignored too, so that future raw-log compression remains safe.

## Implementation Decisions

- Generate `.ralph/.gitignore` when Ralph creates or writes loop artifacts.
- Include ignore patterns for raw worker traces such as `worker-output.raw.jsonl` and compressed variants.
- Preserve existing custom lines in `.ralph/.gitignore` and append missing Ralph-managed rules idempotently.
- Do not ignore compact `worker-output.jsonl` by default.
- Add an explicit Git commit exclusion policy for raw traces where practical, so safety does not rely only on ignore files.
- Document that projects already ignoring `.ralph/` do not need this file, but it is still harmless.

## Testing Decisions

- Test that creating a loop generates `.ralph/.gitignore`.
- Test that running the generation twice is idempotent.
- Test that existing custom ignore lines are preserved.
- Test that raw files are not staged by Ralph commits when present.
- Test that compact worker output remains eligible for commits.

## Out of Scope

- Modifying the repository root `.gitignore` automatically.
- Removing raw files already committed to history.
- Enforcing a global Git LFS or artifact retention policy.

## Further Notes

This issue pairs with compact worker output. The compact artifact should be the normal committed record; raw traces should be local diagnostics.
