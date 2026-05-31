# Handoff Guidance

`handoff-in.md` should identify the loop, iteration number, exact task slice, referenced artifacts by path, allowed/forbidden paths, verification requirements, and stop conditions.

`handoff-out.md` should summarize what happened, list changed files, include a short single-line commit subject when inferable, record decisions/risks, and suggest the next bounded task.

Reference files by path instead of copying large content. Keep loop-specific instructions in loop artifacts; move durable project context to project docs when appropriate. Fresh workers should preserve enough evidence for the orchestrator to continue without chat history.
