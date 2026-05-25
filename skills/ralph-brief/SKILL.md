---
name: ralph-brief
description: Create concise Ralph iteration input handoffs for fresh-context workers. Use when preparing the next bounded task in a Ralph orchestrator loop.
---

# Ralph Brief

Create a durable `handoff-in.md` for exactly one bounded iteration.

Include:

- loop name and iteration number
- exact task slice
- referenced artifacts by path, not copied content
- allowed path scope
- verification requirements
- stop conditions

Avoid duplicating content already present in plans, PRDs, ADRs, diffs, issues, or previous handoffs. Reference those artifacts by path or URL instead.
