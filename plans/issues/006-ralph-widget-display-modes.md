# Issue 006: Add Ralph widget display modes and compact focus view

## Summary

Replace the Ralph widget's pure show/hide behavior with three display modes: expanded, compact, and hidden. Expanded mode should show the full todo list. Compact mode should keep Ralph visible with one focused todo row and header badges summarizing hidden work around that focus. Hidden mode should remain available through explicit command/LLM action, but keyboard shortcut behavior should only expand/contract the widget.

This issue intentionally removes the pagination behavior added to the expanded widget in commit `110ffca` and repurposes the underlying focus/pagination concept for compact mode.

## User stories

1. As a Ralph user, I want an active loop to remain visible by default, so I do not lose track of background work.
2. As a Ralph user, I want a compact widget mode, so Ralph can stay visible without consuming too much vertical space.
3. As a Ralph user, I want expanded mode to show the full todo list, so expansion means complete context rather than another cropped view.
4. As a Ralph user, I want compact mode to show the most relevant current item, so I can quickly understand what Ralph is doing or what needs attention.
5. As a Ralph user, I want compact badges to summarize hidden work above and below the focused item, so I retain orientation without seeing the full list.
6. As a Ralph user, I want Ctrl+Opt+R to expand/contract only, so I do not accidentally hide the widget.
7. As a Ralph user, I want `/ralph-widget hide` to still dismiss the widget, so I have an explicit escape hatch.
8. As a Ralph user, I want meaningful loop changes to reopen a hidden widget in compact mode, so important Ralph progress is surfaced again.

## Requirements

### Display modes

Add a widget mode state:

- `compact`
- `expanded`
- `hidden`

Replace the current boolean `ralphWidgetVisible` model.

### Session and loop detection

- On `session_start`, if the extension detects a Ralph loop that is not fully complete, show compact mode by default.
- New sessions should not auto-show fully completed loops.
- If a loop is visible in the current session and later completes, keep the widget open in its current mode.
- If the widget is hidden and a meaningful loop state change happens, including final completion, reopen in compact mode.
- Avoid reopening hidden mode solely because of repeated render ticks for the same state.
- If `/ralph-widget show`, `/ralph-widget compact`, `/ralph-widget expanded`, or toggle is invoked with no detected non-complete loop, list available loops rather than auto-showing stale completed work.

### Keyboard and command behavior

- Ctrl+Opt+R toggles display density only:
  - compact → expanded
  - expanded → compact
  - hidden → expanded
- Ctrl+Opt+R must not hide the widget.
- `/ralph-widget show` and `/ralph-widget on` switch to expanded mode.
- `/ralph-widget hide` and `/ralph-widget off` switch to hidden mode.
- `/ralph-widget compact`, `/ralph-widget collapse`, and `/ralph-widget collapsed` switch to compact mode.
- `/ralph-widget expanded`, `/ralph-widget expand`, and `/ralph-widget full` switch to expanded mode.
- `/ralph-widget toggle` or no argument should match Ctrl+Opt+R density toggle semantics.
- Update shortcut description to `Expand/contract the Ralph widget`.
- Update command descriptions/help text to describe compact/expanded/hidden behavior.

### Expanded mode

- Expanded mode renders `state.todos` directly.
- Expanded mode must not paginate or crop the todo list.
- Keep the blue border/divider color introduced in commit `110ffca`.
- Expanded footer should indicate Ctrl+Opt+R contracts the widget.

### Compact selected todo

Compact mode renders:

- header with loop name and compact hidden-work badges
- one selected todo row
- that todo's detail row
- compact footer hint

Selection priority:

1. running todo
2. failed/interrupted todo needing attention
3. last completed todo
4. next queued/deferred todo

Compact mode should recompute this status-priority selection when contracting from expanded mode. It should not preserve expanded focus.

### Compact header badges

Compact badges summarize hidden work by side relative to the focused todo. Hide zero-count badges.

Example:

```text
Ralph Loop · demo    ↑2 ✓ ↑1 ✗ ↓2 ○ ↓4 ◌
› ⠋ #003 Current work
  1m 20s · ↑261k ↓21k · tools read, edit
```

Badge semantics:

- Green `↑N ✓`: completed todos above/before the focused todo.
- Red `↑N ✗`: failed/interrupted todos above/before the focused todo.
- Blue/teal `↓N ○`: queued todos below/after the focused todo.
- Muted grey `↓N ◌`: deferred todos below/after the focused todo.

Counts are hidden-by-side counts, not whole-loop totals.

### Rendering refactor

- Factor todo row rendering into a helper reused by compact and expanded modes.
- Repurpose the previous pagination/focus logic into compact focus/count helpers.
- Remove full-width cropped indicators from expanded mode.
- Do not render full-width cropped indicators in compact mode; use header badges instead.

## Acceptance criteria

- Starting a session with a non-complete loop shows compact mode by default.
- Starting a session with only completed loops does not auto-show the widget.
- Expanded mode shows every todo in the loop and no `↑ N more` / `↓ N more` crop dividers.
- Compact mode shows exactly one todo row selected by the specified priority.
- Compact mode header badges show nonzero hidden-by-side counts and hide zeros.
- Ctrl+Opt+R toggles compact/expanded and shows expanded if currently hidden.
- Ctrl+Opt+R never hides the widget.
- `/ralph-widget hide` hides the widget.
- `/ralph-widget show` shows expanded mode.
- A meaningful loop state change while hidden reopens compact mode.
- Existing Ralph run/pause/status commands continue to update the widget.

## Suggested tests

- Compact mode selects running todo.
- Compact mode selects failed/interrupted before last completed when no todo is running.
- Compact mode selects last completed before next queued/deferred when no running/problem todo exists.
- Compact mode falls back to next queued/deferred when nothing is complete.
- Compact badges count completed/failed above and queued/deferred below the selected todo.
- Compact badges hide zero counts.
- Expanded mode renders all todos and omits crop indicators.
- Shortcut/density helper toggles compact ↔ expanded and hidden → expanded.
- Hidden widget reopens compact on meaningful state change.
- Session-start selection excludes fully completed loops.

## Verification

Run:

```bash
npm test
npm run typecheck
```
