# Ralph Widget Display Modes Plan

## Goal

Replace the current pure show/hide Ralph widget behavior with display modes:

1. **Expanded**: larger Ralph widget showing the full todo list with no pagination.
2. **Compact**: always-visible lightweight widget showing the most relevant single todo plus repurposed/improved directional pagination indicators in the header.
3. **Hidden**: explicit temporary dismissal available only through `/ralph-widget hide` or LLM/tool action, not through the keyboard shortcut.

## Confirmed requirements

### Detection and lifetime

- On `session_start`, if the extension detects a Ralph loop that is **not fully complete**, show the widget in **compact** mode by default.
- New sessions should not auto-show fully completed loops.
- If a loop is visible in the current session and later completes, keep the widget open in whatever mode it was already in.
- If the widget is hidden and a meaningful loop state change happens, including final completion, reopen the widget in **compact** mode.
- If `/ralph-widget show` is invoked when no non-complete loop is detected, list available loops rather than showing a stale completed loop automatically.

### Modes and controls

- Ctrl+Opt+R should only expand/contract the widget; it should **not** hide the widget.
- Ctrl+Opt+R behavior:
  - compact → expanded
  - expanded → compact
  - hidden → expanded
- `/ralph-widget show` should show the widget and switch to **expanded** mode.
- `/ralph-widget hide` should remove the widget entirely.
- `/ralph-widget compact` / `collapse` should show compact mode.
- `/ralph-widget expanded` / `expand` / `full` should show expanded mode.
- `/ralph-widget toggle` or no arg should match Ctrl+Opt+R: toggle compact/expanded, and if hidden show expanded.

### Compact selected todo

Compact mode renders the same header plus one selected todo row.

Selection priority:

1. running todo
2. failed/interrupted todo needing attention
3. last completed todo
4. next queued/deferred todo

Compact mode should recompute this status-priority selection when contracting from expanded mode; it should not preserve expanded pagination focus.

### Compact indicators

Compact mode should include directional count indicators as **header badges**. Hide zero-count indicators.

Example layout:

```text
Ralph Loop · demo    ↑2 ✓ ↑1 ✗ ↓2 ○ ↓4 ◌
› ⠋ #003 Current work
  1m 20s · ↑261k ↓21k · tools read, edit
```

Badge meaning and color:

- Green upward arrow + count/check for completed todos above the focused todo: `↑2 ✓`
- Red upward arrow + count/cross for failed/interrupted todos above the focused todo: `↑1 ✗`
- Blue/teal downward arrow + count/open-circle for queued todos below the focused todo: `↓2 ○`
- Muted grey downward arrow + count/dotted-circle for deferred todos below the focused todo: `↓4 ◌`

Directional/counting semantics:

- Counts are based on items hidden by compact mode relative to the focused todo, not whole-loop totals.
- Up badges count matching todos above/before the focused todo.
- Down badges count matching todos below/after the focused todo.

### Tool/action detail text

- Replace the current lowercase CSV-style tool detail (`tools read, edit`) with sentence-style display.
- Preferred format: `Used Read, Edit, Bash`.
- If there are more tools than the display limit, show the first few title-cased names plus a count, e.g. `Used Read, Edit +3 more`.
- Apply this to both running worker detail text and any future completed/action detail text that lists tool names.
- Keep this as text rather than icon chips so it remains readable in compact and expanded terminal layouts.

### Expanded mode

- Remove the pagination behavior added in commit `110ffca` from expanded mode.
- Expanded mode should show the full todo list, even for long loops.
- Keep the blue border divider color from commit `110ffca`.
- Repurpose the pagination/focus logic from commit `110ffca` for compact mode instead of deleting the idea entirely:
  - compact mode chooses one focused todo
  - compact mode summarizes hidden work above/below that focus with header badges
  - compact mode no longer uses full-width cropped divider indicators

## UX suggestions

- Rename notification copy from “shown/hidden” to mode language, e.g. `Ralph widget expanded`, `Ralph widget compact`, `Ralph widget hidden`.
- Update footer hint based on current mode:
  - Compact: `Ctrl+Opt+R Expand · /ralph-widget hide to dismiss`
  - Expanded: `Ctrl+Opt+R Compact · Chat to pause, resume, steer, or kill the loop.`
  - Hidden: no widget footer.
- For compact indicators, use header badges with icons/colors only; avoid long labels so the widget stays compact.

## Implementation steps

1. Replace `ralphWidgetVisible: boolean` with `ralphWidgetMode: "compact" | "expanded" | "hidden"`.
2. Track whether the latest loop was hidden so `updateUI` can reopen compact on meaningful loop state changes.
   - Simplest version: when `updateUI` receives a non-null state different from the last rendered state snapshot and mode is `hidden`, switch to `compact`.
   - Avoid reopening solely due to repeated render ticks for the same state.
3. Update `updateUI`:
   - clear widget if mode is `hidden` or no detected state
   - call `renderRalphWidget(..., { mode: "compact" | "expanded" })` otherwise
4. Add mode transition helpers:
   - `setWidgetMode(ctx, mode, reason?)`
   - `toggleWidgetDensity(ctx)` implementing compact ↔ expanded, and hidden → expanded
   - `showWidget(ctx)` as expanded
   - `hideWidget(ctx)` as hidden
5. Update commands:
   - `/ralph-widget show|on` → expanded
   - `/ralph-widget hide|off` → hidden
   - `/ralph-widget compact|collapse|collapsed` → compact
   - `/ralph-widget expanded|expand|full` → expanded
   - `/ralph-widget toggle` or no arg → density toggle
   - if show/toggle/compact/expanded has no detected non-complete loop, list loops in the notification/tool response
6. Update shortcut:
   - Ctrl+Opt+R toggles compact ↔ expanded; if hidden, shows expanded.
   - Description: `Expand/contract the Ralph widget`.
7. Refactor widget rendering:
   - factor existing todo row rendering into a helper reused by expanded and compact modes
   - expanded mode renders `state.todos` directly with no `paginatedTodos` cropping
   - compact mode uses a renamed/refactored focus helper derived from `paginatedTodos`/`findLastIndex`
   - compact mode uses `selectCompactTodo` plus hidden-by-side counts around that selected todo
   - compact mode renders nonzero directional header badges for completed, failed/interrupted, queued, and deferred counts
   - remove full-width crop indicators from expanded mode; do not render them in compact mode either
8. Improve tool/action detail formatting:
   - add a helper like `renderToolPhrase(toolNames, fallbackCount)`
   - title-case known tool names
   - render `Used Read, Edit, Bash` for a short list
   - render `Used Read, Edit +3 more` for longer lists
   - avoid lowercase CSV labels like `tools read, edit`
9. Update help text and command descriptions.
10. Add tests for:
   - compact mode selects running todo
   - compact mode selects failed/interrupted before last completed when no running todo
   - compact mode selects last completed before next queued/deferred when no running/problems exist
   - compact mode hidden-by-side indicator counts/colors and zero-count hiding
   - expanded mode shows the full todo list and does not paginate
   - density toggle semantics: compact ↔ expanded, hidden → expanded if practical
   - session-start active/ready selection excludes fully complete loops if testable
   - visible completed loop stays visible after completion, while new sessions do not auto-show completed loops if testable
   - running detail formats tools as `Used Read, Edit` and truncates long lists as `+N more`

## Verification

Run:

```bash
npm test
npm run typecheck
```
