---
name: ralph-report
description: Produce structured Ralph worker reports for the orchestrator, including verification evidence and next-step handoff context.
---

# Ralph Report

At the end of a Ralph worker iteration, report in durable files rather than relying on chat history.

`handoff-out.md` must include:

- summary
- changed files
- commit subject: one short single-line subject matching project commit style when inferable
- verification performed
- decisions made
- risks or blockers
- next suggested bounded task

`verification.md` must include:

- each command run
- exit code or pass/fail result
- concise output summary
- whether verification passed, failed, or was not run
