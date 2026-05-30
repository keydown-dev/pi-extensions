# Issue 009: Consolidate Ralph skills into one Subagent Loop skill and rename public API

## Summary

Refactor this package from a Ralph-branded, prompt-transform-assisted workflow into a cleaner `subagent-loop` capability:

1. Replace the four separate bundled skills (`ralph-plan`, `ralph-brief`, `ralph-pickup`, `ralph-report`) with one top-level `subagent-loop` skill that uses bundled reference documents for the role-specific workflows.
2. Remove the `input` event transform that appends Ralph tool instructions to user messages.
3. Rename the public command/tool surface from `ralph-*` / `ralph_orchestrator_*` toward `loop-*` / `subagent_loop_*`, with a deliberate migration strategy for existing users.
4. Clean up repository docs, tests, wording, exported UI copy, and stale references so the repository is simpler and more coherent after the refactor.

The intended user-facing concept is **Subagent Loop**. `Ralph` may remain as historical/package/internal terminology where technically necessary, but users should not need to know the implementation brand to use the workflow.

## Motivation

The current extension rewrites certain user prompts when it detects `Ralph` plus loop-management keywords:

```ts
pi.on("input", async (event) => {
  if (/\bralph\b/i.test(event.text) && /\b(loop|loops|iterate|iterations|issues?|todos?|insert|pause|resume|run|kill|abort|status|list)\b/i.test(event.text) && !event.text.startsWith("/")) {
    return {
      action: "transform",
      text: `${event.text}\n\nIf this is a request ...`,
    };
  }
});
```

This is surprising because the submitted user message is modified before the agent receives it. Pi already has a better extension mechanism for this shape of behavior: bundled skills with trigger descriptions and progressive-disclosure reference files.

The current four-skill layout also fragments one workflow across several skill folders. Planning, briefing, pickup, and reporting are not unrelated capabilities; they are roles inside one Subagent Loop protocol. A single skill with references will be more discoverable, easier to maintain, and easier to trigger based on terms like `subagent loop`, `loop`, `fresh-context worker`, `worker handoff`, `iteration report`, and legacy `Ralph`.

## Goals

- Users can invoke the workflow naturally via skill routing without their prompt being rewritten.
- One bundled skill named `subagent-loop` describes the overall workflow and points to reference documents for detailed role behavior.
- Public commands and tools use Subagent Loop terminology instead of Ralph terminology.
- Existing protocol details are preserved, but docs and UI copy are cleaned up around the new concept.
- Tests cover the absence of prompt rewriting and the presence/behavior of the renamed API.
- The repository has no stale, contradictory, or duplicated skill guidance after the refactor.

## Non-goals

- Changing the core orchestrator state machine semantics.
- Changing the artifact directory layout in the same PR, unless a compatibility shim is trivial and well tested.
- Rewriting the worker execution engine.
- Removing all internal class/function names containing `Ralph` if that would create a large low-value diff. Public API and docs are higher priority.

## Desired end state

### Skill layout

Replace:

```txt
skills/
  ralph-plan/SKILL.md
  ralph-brief/SKILL.md
  ralph-pickup/SKILL.md
  ralph-report/SKILL.md
```

With:

```txt
skills/
  subagent-loop/
    SKILL.md
    refs/
      planning.md
      brief.md
      pickup.md
      report.md
      handoff.md
      artifact-protocol.md
      tool-usage.md
      terminology.md
```

`skills/subagent-loop/SKILL.md` should be short and act as the router. It should:

- Use frontmatter `name: subagent-loop`.
- Trigger on Subagent Loop, subagent loops, fresh-context workers, worker handoffs, planning a loop, running/pausing/resuming/killing/inspecting a loop, iteration reports, and legacy `Ralph` mentions.
- Explain that `Subagent Loop` is the user-facing concept and `Ralph` is legacy/internal terminology.
- Direct the agent to read exactly the relevant `refs/*.md` file(s) for the requested workflow.
- State explicitly: **Do not modify the user's prompt to inject loop tool guidance.** Use the available tools/commands directly when appropriate.

### Public commands

Rename commands from:

- `/ralph-plan`
- `/ralph-start`
- `/ralph-run`
- `/ralph-pause`
- `/ralph-kill`
- `/ralph-status`
- `/ralph-list`
- `/ralph-widget`

To:

- `/loop-plan`
- `/loop-start`
- `/loop-run`
- `/loop-pause`
- `/loop-kill`
- `/loop-status`
- `/loop-list`
- `/loop-widget`

Because the user requested a full rename, these should become the primary documented commands. Decide during implementation whether to keep deprecated aliases for one release. If aliases are kept, they must:

- Be explicitly marked deprecated in help text.
- Notify the user to use `/loop-*` instead.
- Not appear as the primary command set in README tables.
- Have tests proving both alias and primary command paths call the same implementation.

If aliases are not kept, update all tests/docs/fixtures and ensure error/help output does not mention the old command names except in a migration note.

### Public tools

Rename tools from:

- `ralph_orchestrator_plan`
- `ralph_orchestrator_start`
- `ralph_orchestrator_run`
- `ralph_orchestrator_insert_todo`
- `ralph_orchestrator_pause`
- `ralph_orchestrator_kill`
- `ralph_orchestrator_status`
- `ralph_orchestrator_list`

To:

- `subagent_loop_plan`
- `subagent_loop_start`
- `subagent_loop_run`
- `subagent_loop_insert_todo`
- `subagent_loop_pause`
- `subagent_loop_kill`
- `subagent_loop_status`
- `subagent_loop_list`

Update labels, descriptions, prompt snippets, details, next-action strings, and skill instructions to use these names.

Compatibility strategy must be explicit:

- Preferred: register new tool names as primary and, only if necessary, keep old tool names as deprecated wrappers for one release.
- Deprecated wrappers should share the same implementation functions to avoid drift.
- If wrappers remain, their descriptions should say `Deprecated alias for subagent_loop_*`.
- The old names must not be recommended by skills, README, protocol docs, tests, or generated handoffs.

### Prompt rewriting

Remove this behavior entirely:

```ts
pi.on("input", async (event) => {
  ... return { action: "transform", text: `${event.text}\n\nIf this is a request ...` };
});
```

Do not replace it with another input transform. The skill and tool metadata should handle routing.

If additional non-mutating guidance is still needed, prefer one of these options and document why:

- Improve `subagent-loop` skill description.
- Improve individual tool `promptSnippet` / `promptGuidelines`.
- Add concise static documentation in `refs/tool-usage.md`.

Do **not** append content to user messages.

## Detailed implementation plan

### 1. Create the consolidated skill

Create `skills/subagent-loop/SKILL.md`.

Suggested frontmatter:

```md
---
name: subagent-loop
description: Use when the user mentions Subagent Loop, subagent loops, fresh-context workers, worker handoffs, loop planning, loop status, loop iterations, background worker agents, or legacy Ralph loop/orchestrator workflows.
---
```

Suggested body sections:

- `# Subagent Loop`
- `## User-facing terminology`
- `## Choose the workflow`
- `## Tool usage`
- `## Prompt integrity rule`
- `## Reference documents`

The skill should route to references like:

- Planning a new loop → `refs/planning.md`
- Preparing a worker handoff → `refs/brief.md`
- Acting as a fresh-context worker → `refs/pickup.md`
- Writing iteration completion artifacts → `refs/report.md`
- Handing state between agents/sessions → `refs/handoff.md`
- Understanding state/artifacts/git policy → `refs/artifact-protocol.md`
- Calling tools/commands → `refs/tool-usage.md`
- Naming/legacy wording → `refs/terminology.md`

### 2. Move existing skill content into references

Migrate existing content instead of rewriting from scratch:

- `skills/ralph-plan/SKILL.md` → `skills/subagent-loop/refs/planning.md`
- `skills/ralph-brief/SKILL.md` → `skills/subagent-loop/refs/brief.md`
- `skills/ralph-pickup/SKILL.md` → `skills/subagent-loop/refs/pickup.md`
- `skills/ralph-report/SKILL.md` → `skills/subagent-loop/refs/report.md`

While migrating, update language:

- `Ralph Plan` → `Subagent Loop Planning`
- `Ralph worker` → `subagent worker` or `fresh-context worker`
- `Ralph loop packet` → `Subagent Loop packet`
- `ralph_orchestrator_start` → `subagent_loop_start`
- `/ralph-run` → `/loop-run`
- `Ralph artifacts` → `loop artifacts` unless referring to the existing `.ralph/` directory.

Keep the important protocol rules intact:

- Do not start a loop until the user approves the packet.
- Start creates the loop but does not run workers.
- Use bounded worker iterations.
- Workers write durable `handoff-out.md` and `verification.md`.
- Workers stop after their bounded slice.
- Blockers should be reported rather than silently widening scope.

### 3. Add new reference documents

Create `skills/subagent-loop/refs/handoff.md` covering:

- What belongs in `handoff-in.md`.
- What belongs in `handoff-out.md`.
- How to reference files by path instead of copying large content.
- How to distinguish loop-specific instructions from durable project context.
- What a fresh worker should preserve for the orchestrator.

Create `skills/subagent-loop/refs/artifact-protocol.md` covering a concise skill-level summary of:

- State file location.
- Iteration artifact layout.
- Semantic todo identity vs execution order.
- Git checkpoint model.
- Raw vs compact worker output.
- Verification artifacts.

This should reference `docs/protocol.md` for full details rather than duplicating the entire protocol.

Create `skills/subagent-loop/refs/tool-usage.md` covering:

- Preferred agent tools: `subagent_loop_plan`, `subagent_loop_start`, `subagent_loop_run`, `subagent_loop_insert_todo`, `subagent_loop_pause`, `subagent_loop_kill`, `subagent_loop_status`, `subagent_loop_list`.
- Preferred slash commands: `/loop-plan`, `/loop-start`, `/loop-run`, `/loop-pause`, `/loop-kill`, `/loop-status`, `/loop-list`, `/loop-widget`.
- When to use status/list before acting.
- When to ask for approval before start/run/kill.
- Kill vs pause semantics.
- One-iteration run guidance: `maxIterations: 1` or `/loop-run --max 1`.

Create `skills/subagent-loop/refs/terminology.md` covering:

- `Subagent Loop`: public concept.
- `fresh-context worker`: child Pi worker for one bounded iteration.
- `loop packet`: approved plan used to create a loop.
- `Ralph`: legacy/internal/package branding.
- `.ralph/`: current artifact directory name retained for compatibility unless a separate migration changes it.

### 4. Remove old skill folders

After migrating content, delete:

- `skills/ralph-plan/`
- `skills/ralph-brief/`
- `skills/ralph-pickup/`
- `skills/ralph-report/`

Then search the repo for stale skill references:

```bash
rg -n "ralph-plan|ralph-brief|ralph-pickup|ralph-report|/skill:ralph|Ralph Plan|Ralph Brief|Ralph Pickup|Ralph Report" .
```

Every match should either be removed, updated to `subagent-loop`, or intentionally retained in a migration note.

### 5. Remove the prompt-transform input hook

In `extensions/orchestrator.ts`, delete the `pi.on("input", ...)` block that appends the Ralph guidance.

After removal:

- There should be no `input` handler whose purpose is to modify user text for loop routing.
- `rg -n "If this is a request to create|action: \"transform\"|\binput\b" extensions src tests skills docs README.md` should not find a loop-routing transform.
- If any `input` handler remains in the future, it must have a different clearly documented purpose and tests proving it does not append tool guidance to user prompts.

### 6. Rename command registration

In `extensions/orchestrator.ts`, update command registrations.

Current registrations are around:

```ts
pi.registerCommand("ralph-start", ...)
pi.registerCommand("ralph-pause", ...)
pi.registerCommand("ralph-kill", ...)
pi.registerCommand("ralph-status", ...)
pi.registerCommand("ralph-list", ...)
pi.registerCommand("ralph-run", ...)
pi.registerCommand("ralph-widget", ...)
pi.registerCommand("ralph-plan", ...)
```

Change primary command names to:

```ts
pi.registerCommand("loop-start", ...)
pi.registerCommand("loop-pause", ...)
pi.registerCommand("loop-kill", ...)
pi.registerCommand("loop-status", ...)
pi.registerCommand("loop-list", ...)
pi.registerCommand("loop-run", ...)
pi.registerCommand("loop-widget", ...)
pi.registerCommand("loop-plan", ...)
```

Also update command descriptions:

- `Start a Subagent Loop`
- `Pause active Subagent Loop`
- `Kill active Subagent Loop worker process and pause the loop`
- `Show current or named Subagent Loop status`
- `List Subagent Loops`
- `Run one or more Subagent Loop worker iterations`
- `Set Subagent Loop widget mode`
- `Plan a Subagent Loop through an interview before starting`

If deprecated aliases are kept, implement them through a helper so each alias points to the exact same handler as the primary command. Do not duplicate business logic.

### 7. Rename tool registration

In `extensions/orchestrator.ts`, update each `pi.registerTool` name, label, description, promptSnippet, and returned `nextAction` copy.

Examples:

- `ralph_orchestrator_plan` → `subagent_loop_plan`
  - Label: `Plan Subagent Loop`
  - Description: `Start a Subagent Loop planning interview before creating a loop.`
- `ralph_orchestrator_start` → `subagent_loop_start`
  - Label: `Start Subagent Loop`
  - Description: `Create a Subagent Loop from a natural-language task.`
- `ralph_orchestrator_run` → `subagent_loop_run`
  - Label: `Run Subagent Loop`
- `ralph_orchestrator_insert_todo` → `subagent_loop_insert_todo`
  - Label: `Insert Loop Todo`
- `ralph_orchestrator_pause` → `subagent_loop_pause`
- `ralph_orchestrator_kill` → `subagent_loop_kill`
- `ralph_orchestrator_status` → `subagent_loop_status`
- `ralph_orchestrator_list` → `subagent_loop_list`

Update all references in:

- Tool response text.
- `nextActionForState` output.
- Error messages that tell the agent/user what to call next.
- Skill docs.
- README agent tool list.
- `docs/protocol.md`.
- Test assertions.

### 8. Rename user-facing UI/widget copy

Audit and update strings in `extensions/orchestrator.ts` and tests:

- `Ralph Loop · <name>` → `Subagent Loop · <name>` if not already covered by another issue.
- `Ralph widget` → `Subagent Loop widget`.
- `Ralph run stopped...` → `Subagent Loop run stopped...`.
- `Ralph loop is already running...` → `Subagent Loop is already running...`.
- `Started Ralph iteration...` → `Started loop iteration...` or `Started Subagent Loop iteration...`.

Keep `.ralph/` path references unchanged unless a separate artifact migration is implemented. When referencing that path, write copy like:

> Loop artifacts currently live under the legacy `.ralph/orchestrator/` directory.

### 9. Update planning command behavior

Current `/ralph-plan` queues:

```ts
pi.sendUserMessage(`/skill:ralph-plan ${goal}`, { deliverAs: "followUp" });
```

Update `/loop-plan` to queue:

```ts
pi.sendUserMessage(`/skill:subagent-loop ${goal}`, { deliverAs: "followUp" });
```

The `subagent-loop` skill should then read `refs/planning.md` as needed.

If Pi skill invocation supports only root skill markdown loading, the root skill must contain enough instruction to route to `refs/planning.md` and ask the agent to read it. Do not reintroduce prompt transforms to force this behavior.

### 10. Update docs

Update `README.md`:

- Title/intro should say `Subagent Loop` first and mention Ralph only as package/history if needed.
- Command reference table should use `/loop-*` commands.
- Agent tools list should use `subagent_loop_*` names.
- Widget hint should use `Subagent Loop widget`.
- Insert-todo section should use `subagent_loop_insert_todo`.
- Control semantics should use `loop` rather than `Ralph` where possible.
- Artifact section should explain `.ralph/` as a legacy-compatible artifact directory.

Update `docs/protocol.md`:

- Rename headings and prose to `Subagent Loop protocol` where user-facing.
- Preserve necessary references to `.ralph/` artifact paths.
- Replace old command/tool names with new names.
- Add a migration note mapping old names to new names if aliases remain or if users upgrading may see old docs/artifacts.

Update `plans/issues/008-compact-widget-hr-counts-and-selection.md` only if it is still active/relevant and contains contradictory target copy. Since historical issue files can be intentionally stale, prefer adding a note rather than rewriting large historical plans unless tests/docs depend on them.

### 11. Update tests and fixtures

Audit `tests/orchestrator.test.ts` and prompt fixtures.

Expected changes include:

- Test names should use `Subagent Loop` where behavior is user-facing.
- Widget assertions should expect `Subagent Loop`, not `Ralph Loop`, if widget copy is renamed in this issue.
- Command/tool name assertions should use `/loop-*` and `subagent_loop_*`.
- Fixture prompt `tests/prompts/setup-ralph-loop-for-arithmetic-test-prompt.md` should be renamed, for example:
  - `tests/prompts/setup-subagent-loop-for-arithmetic-test-prompt.md`
- Fixture content should ask for a Subagent Loop, not a Ralph loop, while possibly mentioning legacy Ralph only if testing backward compatibility.

Add a regression test for prompt integrity if possible within Pi extension test capabilities:

- Simulate an input event containing `Ralph loop status` or `Subagent Loop status`.
- Assert the extension no longer returns an input transform that appends tool guidance.
- If direct event testing is not easy, add a static test that reads `extensions/orchestrator.ts` and asserts the old appended string is absent. Prefer behavioral testing if the test harness supports it.

Add tests for command/tool rename:

- Primary `/loop-*` commands are registered.
- Old `/ralph-*` commands are absent or deprecated aliases according to the chosen compatibility strategy.
- New `subagent_loop_*` tools are registered.
- Deprecated `ralph_orchestrator_*` wrappers are absent or marked as aliases according to the chosen compatibility strategy.

### 12. Update package metadata

Update `package.json` fields:

- `description`: mention Subagent Loop first.
- `keywords`: add `subagent-loop`, `subagents`, `fresh-context`, `loop`; keep `ralph` if desired for discoverability.
- `pi.skills`: still points to `./skills`, no structural change needed if the new skill lives below that folder.

Consider whether the package name should remain `@keydown-dev/pi-ralph-orchestrator`. A package rename is out of scope unless the repository owner wants a breaking package distribution change. If left unchanged, explain in README that the package provides the Subagent Loop capability and retains Ralph naming for package/history compatibility.

### 13. Update generated/help text

Update the `HELP` constant in `extensions/orchestrator.ts`:

- Header: `Subagent Loop - fresh-context worker loops`
- Usage examples: `/loop-start`, `/loop-run`, etc.
- Widget command: `/loop-widget`.
- If aliases are kept, add a final migration line:
  - `Deprecated aliases: /ralph-* still work for now; prefer /loop-*.`

Search for stale help text:

```bash
rg -n "ralph-|/ralph|ralph_orchestrator|Ralph Orchestrator|Ralph Loop|Ralph widget" extensions src README.md docs skills tests package.json
```

Every match should be either:

- Updated.
- A legacy compatibility note.
- A package/internal class name intentionally left for a future cleanup.

### 14. Cleanup internal naming where low risk

Do not block the refactor on renaming every internal symbol, but clean up obvious user-facing names and low-risk helpers.

Candidates to keep for now:

- `RalphOrchestrator` class if renaming would cause broad churn.
- `.ralph/` path constants.
- Existing state schema fields, if any mention Ralph internally.

Candidates to rename now:

- Help strings.
- Widget labels.
- Tool labels/descriptions.
- Command descriptions.
- Test fixture names.
- Skill docs.
- README/protocol docs.

If internal names are kept, add a follow-up cleanup note or TODO in this issue's implementation notes so future maintainers understand the boundary.

## Cleanup checklist

Before closing this issue, run these searches and resolve each match intentionally:

```bash
rg -n "If this is a request to create" .
rg -n "action: \"transform\"|action: 'transform'" extensions src tests
rg -n "ralph-plan|ralph-brief|ralph-pickup|ralph-report" .
rg -n "/ralph-|ralph_orchestrator_" README.md docs skills tests extensions src package.json
rg -n "Ralph Loop|Ralph widget|Ralph Orchestrator" README.md docs skills tests extensions src
```

Allowed remaining matches:

- Package name/repository name if unchanged.
- `.ralph/` artifact path documentation.
- Migration/deprecation notes.
- Internal class names intentionally left for a later low-value cleanup.
- Historical issue documents, only if clearly not part of current user-facing docs.

Also remove any now-empty directories and stale files:

- `skills/ralph-plan/`
- `skills/ralph-brief/`
- `skills/ralph-pickup/`
- `skills/ralph-report/`
- Old renamed prompt fixture files.
- Any generated references to deleted skill paths.

## Acceptance criteria

- [ ] There is exactly one bundled skill for this capability: `skills/subagent-loop/SKILL.md`.
- [ ] Role-specific workflow instructions live under `skills/subagent-loop/refs/`.
- [ ] The old `skills/ralph-*` folders are removed.
- [ ] No extension `input` transform appends Ralph/Subagent Loop tool guidance to user messages.
- [ ] Primary slash commands are `/loop-*`.
- [ ] Primary agent tools are `subagent_loop_*`.
- [ ] README and protocol docs use Subagent Loop terminology and document any legacy compatibility.
- [ ] Skill docs recommend new tool/command names only.
- [ ] Widget/help/user-facing copy says `Subagent Loop` rather than `Ralph Loop` where applicable.
- [ ] Tests pass: `npm test`.
- [ ] Type checking passes: `npm run typecheck`.
- [ ] Cleanup searches have been run and all remaining legacy matches are intentional.

## Verification plan

Run:

```bash
npm test
npm run typecheck
rg -n "If this is a request to create" .
rg -n "ralph-plan|ralph-brief|ralph-pickup|ralph-report" .
rg -n "/ralph-|ralph_orchestrator_" README.md docs skills tests extensions src package.json
```

Manual verification in Pi:

1. Install/reload the package.
2. Send a normal message containing `Ralph loop status` and verify the visible/submitted user prompt is not appended with tool instructions.
3. Ask: `Plan a Subagent Loop for a small test refactor`.
4. Verify the `subagent-loop` skill is available/usable and guides the agent into planning.
5. Use `/loop-plan`, `/loop-start`, `/loop-status`, and `/loop-run --max 1` in a throwaway repo.
6. Verify widget/help text uses Subagent Loop terminology.
7. If deprecated aliases are kept, run one `/ralph-status` command and confirm it works while nudging the user toward `/loop-status`.

## Migration note for users

This package now exposes the workflow as **Subagent Loop**. The previous Ralph names were implementation/package branding. If aliases are retained, old `/ralph-*` commands and `ralph_orchestrator_*` tools are deprecated and may be removed in a future release. Use `/loop-*` commands and `subagent_loop_*` tools going forward.
