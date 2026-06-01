# Pi Extensions Monorepo Plan

## Goals

- Turn this repo into a small family of independently installable Pi packages.
- Keep `pi-loops` installable on its own.
- Support both self-run orchestrator loops and subagent-run loops.
- Add first-party question/answer and todo extensions that share visual language with the loop widget.
- Share only UI primitives and conventions; avoid forcing users to install all extensions together.

## Proposed package layout

```text
packages/
  loops/                # future home of current loop package
  questions/            # structured questionnaire tool + UI
  todos/                # session/project todo tool + widget
  elements/             # shared TUI primitives, no Pi extension manifest
```

Initial publishing names:

- `@keydown-dev/pi-loops` (keep `ralph`/`wiggum` keywords for discoverability)
- `@keydown-dev/pi-questions`
- `@keydown-dev/pi-todos`
- `@keydown-dev/elements`

Each extension package should have its own `package.json`, `README.md`, tests, and `pi.extensions` manifest. Shared UI belongs in `elements` as a normal dependency, not a Pi package extension.

## Migration sequence

1. **Artifact rename first**
   - New loop artifacts are created under `.loop/orchestrator/`.
   - Keep legacy internal names where changing them would be noisy or compatibility-sensitive.
   - Decide later whether to support automatic migration from existing `.ralph/orchestrator/` directories.

2. **Introduce workspace shell**
   - Add package placeholders under `packages/`.
   - Keep the current root package working until the move is complete.
   - Add npm workspaces only when we are ready to move source files and refresh the lockfile.

3. **Extract shared UI**
   - Move panel/border/progress-list helpers from `extensions/orchestrator.ts` into `packages/elements/src`.
   - Keep the shared package Pi-agnostic except for peer-typed theme helpers when unavoidable.
   - Provide snapshot-style render tests for narrow/wide terminals.

4. **Move pi-loops**
   - Relocate `src/`, `extensions/`, `skills/`, and package tests into `packages/loops/`.
   - Root package becomes a workspace aggregator with no Pi resources, or remains a compatibility package that re-exports the subpackage for one release.

5. **Add loop execution modes**
   - Add a setup-time choice for who performs each iteration: the current orchestrator LLM or fresh subagent workers.
   - Persist a loop-level default execution mode, plus optional per-todo overrides.
   - For self-run iterations, generate a bounded iteration brief for the current agent, mark the todo running, and let the orchestrator complete the work directly before recording verification.
   - For subagent iterations, keep the current fresh-context worker behavior and model assignment flow.
   - During `/loop-plan` and `subagent_loop_plan`, explicitly ask whether to complete iterations here or assign them to subagents using a selected model.

6. **Build pi-questions from scratch**
   - Register an `ask_user_question`-compatible tool schema unless we deliberately choose a new tool name.
   - Implement a persistent below-editor widget mode first, not a bottom overlay that hides recent transcript/editor content.
   - Allow dismiss/collapse into a non-blocking reminder widget so the user can type normal chat while choices remain visible.
   - Preserve typed custom answers when focus moves away from the custom answer row.
   - Support multi-question tabs, single-select, multi-select, preview pane, chat/dismiss path, answer review, and no-UI fallback.

7. **Build pi-todos**
   - Register a `todo`-style tool with create/update/list/get/delete/clear actions.
   - Store todo state in session entries first; consider optional project-file persistence later.
   - Render a compact/expanded widget using the same panel grammar as Subagent Loop.
   - Keep it independent from Subagent Loop; `@keydown-dev/elements` is the only common dependency.

## Referenced question extension feature inventory

From `@juicesharp/rpiv-ask-user-question` 1.17.1 and Pi TUI docs, the main feature set to rebuild is:

- Pi tool registration with 1-4 questions, 2-4 options per question, labels/descriptions, optional previews, and multi-select.
- Validation for duplicates, reserved labels, empty/too many questions/options, and no-UI mode.
- Dialog state machine for tabs, row focus, selections, custom text, notes, chat/cancel, submit/review, and overflow scroll.
- Responsive rendering: stacked vs side-by-side previews, terminal-row-aware clipping, sticky hints, focus-preserving scroll.
- Keyboard routing: arrows, Tab, Enter, Space, Esc, custom-answer editing, notes editing, submit picker.
- Return envelope with human-readable content and structured details.
- Optional localization is useful but should not be in the first slice unless needed.

Our divergences:

- Prefer a widget/below-editor presentation that does not cover the editor or recent messages.
- Add explicit dismiss/collapse semantics that keep choices visible while allowing normal free-form chat.
- Treat custom-answer text as durable row state, not editor-local state that can be lost on focus changes.
- Align visual style with the `pi-loops` widget: rounded panel, compact/expanded modes, consistent footer controls, same status colors.

## Open decisions

- Whether the Q&A tool should keep the exact `ask_user_question` name for compatibility or use a namespaced tool and optionally provide an alias.
- Whether `.ralph/orchestrator/` should be auto-detected and migrated, read-only listed, or ignored after the `.loop/` switch.
- Whether todo state is session-only by default or optionally project-persisted under `.pi/` / `.loop/`.
- Whether self-run loop iterations should be explicitly committed by a tool call (`loop_iteration_complete`) or inferred from existing verification artifacts.
