# Issue 008: Redesign Subagent Loop widget as rounded progress panel

## Summary

Redesign the Ralph/Subagent Loop widget display in both compact and expanded modes:

- Render the widget as a rounded bordered panel, lazygit-style, instead of loose horizontal rules.
- Rename the widget heading from `Ralph Loop` to user-facing `Subagent Loop`.
- Put loop title on the left side of the top border/title bar.
- Put loop summary metrics on the right side of the top border/title bar:
  - completed/total todos
  - error count when nonzero
  - aggregate subagent cost when available
  - aggregate elapsed subagent time when available
- Move the progress bar into the bottom border.
- Use a two-line todo row layout with a blank line between todos.
- Drop tool-call phrases from widget todo rows.
- Highlight the active/running todo block with `toolPendingBg` instead of using an arrow.
- Dim/mute deferred todos entirely.
- Keep compact mode focused on one selected todo, chosen by actionable priority.

This supersedes the earlier ideas of putting completed/error counts into the top horizontal rule, using a separate progress line under the heading, and using three-line todo rows. The rounded panel title bar is now the loop summary; the bottom border is the progress bar.

## Follow-up issue noted but out of scope

A later issue should consider renaming public commands/tools from `/ralph-*` to `/loop-*` and replacing most user-facing `ralph` references with `loop`/`subagent loop`, while keeping package tags and README discoverability references to Ralph. Do not include that command/API rename in this issue.

## Target examples

### Expanded

```text
╭─ Subagent Loop · widget-demo ─────────────────────────────── ✓ 1/5 · ✗1 · $0.2930 · 3m57s ╮
│                                                                                          │
│  ✓   #1 Add semantic IDs                                                                 │
│      sonnet · ↑42k ↓8k R120k · 15.4%/272k · $0.1030 · 1m 12s · +88 / -12 · 3 Files        │
│                                                                                          │
│  ⠋   #2 Polish compact widget                                                            │
│      sonnet · ↑80k ↓12k R240k · 29.4%/272k · $0.1590 · 2m 05s                             │
│                                                                                          │
│  ✗   #3 Add rounded panel tests                                                          │
│      sonnet · ↑12k ↓2k · 5.1%/272k · $0.0310 · 42s · +12 / -4 · 1 File                    │
│                                                                                          │
│  ○   #4 Update docs                                                                      │
│      sonnet · ↑0 ↓0 · 0%/272k · $0.0000 · 0s                                             │
│                                                                                          │
│  Ⅱ   #5 Optional polish                                                                  │
│      sonnet · ↑0 ↓0 · 0%/272k · $0.0000 · 0s                                             │
│                                                                                          │
╰─ ━━━━━━━━━━━━━━━━━━━──────────────────────────────────────────────────────────────────── ╯
Ctrl+Opt+R Expand/Compact · Chat to resume, pause, edit, or kill the loop.
```

Notes:

- The active/running todo (`#2`) should be highlighted with `toolPendingBg` across both of its content lines. The mock above cannot show real ANSI background.
- Deferred todo (`#5`) should be fully muted/dim: icon, title, and placeholder telemetry.
- There is a blank line between every todo.
- There is also a blank line between the last todo and the bottom progress border.
- The progress bar lives in the bottom border, not as a separate interior line.

### Compact

```text
╭─ Subagent Loop · widget-demo ─────────────────────────────── ✓ 1/5 · ✗1 · $0.2930 · 3m57s ╮
│                                                                                          │
│  ⠋   #2 Polish compact widget                                                            │
│      sonnet · ↑80k ↓12k R240k · 29.4%/272k · $0.1590 · 2m 05s                             │
│                                                                                          │
╰─ ━━━━━━━━━━━━━━━━━━━──────────────────────────────────────────────────────────────────── ╯
Ctrl+Opt+R Expand/Compact · Chat to resume, pause, edit, or kill the loop.
```

Notes:

- Compact mode still shows exactly one focused todo.
- Active/running compact row should also receive `toolPendingBg` across both content lines.
- There is a blank line before the bottom progress border.
- Queued/deferred upcoming counts are no longer embedded in the compact bottom border. The bottom border is reserved for the progress bar.

## Current behavior

Relevant implementation is in `extensions/orchestrator.ts`:

- `renderRalphWidget(...)` builds the widget as:
  - top `widgetRule(...)`
  - header from `renderCompactHeader(...)` in compact mode, otherwise expanded header inline
  - selected todo row(s)
  - bottom `widgetRule(...)`
  - footer
- `renderCompactHeader(...)` appends compact badges to `Ralph Loop · <name>`.
- `compactBadges(...)` computes before/after counts relative to the selected todo and displays chips such as `↑1 ✓`, `↑1 ✗`, `↓1 ○`, `↓2 ◌`.
- `selectedCompactTodo(...)` currently prioritizes `running`, then `failed/interrupted`, then the latest complete todo, then queued/deferred.
- Detail text currently may include tool-call phrases and lowercase `files`.

Current compact behavior was covered by `tests/orchestrator.test.ts` test `Ralph widget compact mode shows focused todo and header badges`; that test should be updated or replaced.

## Requirements

### Rounded bordered panel

Render compact and expanded widgets as a rounded panel using Unicode box drawing characters:

- top-left: `╭`
- top-right: `╮`
- bottom-left: `╰`
- bottom-right: `╯`
- horizontal: `─`
- vertical: `│`

Panel requirements:

- Every interior line should be wrapped with side borders and padded/truncated to fit the viewport width.
- Top and bottom borders should fit exactly within `width` after ANSI styling is accounted for.
- Handle narrow widths gracefully. If width is too narrow for a meaningful panel, fall back to safe truncated lines rather than overflowing or corrupting ANSI styling.
- Preserve a footer line outside the panel.
- Footer copy should be identical in compact and expanded modes:
  - `Ctrl+Opt+R Expand/Compact · Chat to resume, pause, edit, or kill the loop.`
- `Expand/Compact` is literal text describing the shortcut as a display-mode toggle; do not swap the verb based on current mode.
- Do not show `/ralph-widget hide to dismiss` in the compact footer.
- Use `border` color for panel borders.
- Use ANSI-aware visible width helpers/truncation. Do not assume styled string length equals terminal width.

### Top border/title bar

The top border should include left-aligned title text and right-aligned summary text.

Suggested format:

```text
╭─ Subagent Loop · <loop name> ───── ✓ <complete>/<total> · ✗<errors> · $<cost> · <elapsed> ╮
```

Title requirements:

- Use user-facing label `Subagent Loop · <loop name>`.
- Do not rename internal functions/types/commands in this issue.
- The old widget heading `Ralph Loop · <loop name>` should no longer appear in widget output.

Summary requirements:

- Completed/total segment: `✓ <complete>/<total>`.
- Completed count includes only todos with `status === "complete"`.
- Total count is `state.todos.length`.
- Error segment: `✗<errors>`, omitted when zero.
- Error count includes todos with `status === "failed" || status === "interrupted"`.
- Cost segment comes before elapsed segment.
- Cost segment is aggregate subagent cost so far, omitted when unavailable.
- Elapsed segment is aggregate subagent time so far, omitted when unavailable.
- Use `·` separators between summary segments.
- Summary is right-aligned in the available top border space.
- If width is constrained, prefer dropping lower-priority summary segments before truncating the loop name:
  1. drop elapsed
  2. drop cost
  3. keep nonzero error count as long as possible
  4. keep `✓ complete/total` as the most important summary
- If still too narrow, truncate the loop name safely.

Aggregate elapsed/cost semantics:

- Elapsed should sum completed iteration durations from `iteration.startedAt` to `iteration.completedAt` when both exist.
- If a worker is currently running, include `worker.elapsedMs` for the active iteration when available.
- Cost should sum `iteration.usage.cost` where present.
- If a worker is currently running and `worker.usage.cost` is present, include it as current running cost.
- Omit cost if no usage cost is available; do not render misleading `$0.00` unless actual zero-cost usage is known.

### Bottom border progress bar

Render the progress bar in the bottom border for both compact and expanded modes.

Suggested format:

```text
╰─ ━━━━━━━━━━━━━━━━━━━──────────────────────────────────────────────────────────────────── ╯
```

Progress requirements:

- Use thin line glyphs, not block glyphs.
- Filled segment: `━` repeated according to completed/total ratio.
- Remaining segment: `─` repeated for the rest.
- Progress is based on `complete / total` using the same complete/total semantics as the title summary.
- The progress bar should start after `╰─ ` so it visually lines up near the top-border heading start.
- Leave a small space before the bottom-right corner.
- Use success/accent color for filled segment and border/dim color for remaining segment.
- Handle `total === 0` by rendering an empty bar.
- The bottom border is reserved for progress; do not include queued/deferred upcoming chips in the bottom border.

### Todo row layout

Use a two-line row for every todo, with a blank line between todos.

Started/running/error row format:

```text
│  ✓   #1 Add semantic IDs                                                                 │
│      sonnet · ↑42k ↓8k R120k · 15.4%/272k · $0.1030 · 1m 12s · +88 / -12 · 3 Files        │
```

Queued/deferred row format:

```text
│  ○   #4 Update docs                                                                      │
│      sonnet · ↑0 ↓0 · 0%/272k · $0.0000 · 0s                                             │
```

Layout requirements:

- Status icon column starts near the title start in the top border.
- Leave multiple spaces between icon and todo task details.
- Suggested title line prefix: two spaces, icon, three spaces, then `#<id> <title>`.
- Detail line should align with task text, not the icon.
- Insert one blank bordered line between todos in expanded mode.
- Insert one blank bordered line between the final todo and the bottom progress border.
- Compact mode renders the focused todo as the same two-line row, plus a blank bordered line before the bottom progress border.

### Detail row content

Drop tool-call phrases from widget todo rows.

Detail row segment order:

1. model
2. tokens
3. context
4. cost
5. elapsed time
6. line diff, only when row has diff data
7. files touched, only when row has diff data

Rendering requirements:

- Model segment should show model only, not provider/model.
  - Example: `sonnet`, not `anthropic/sonnet`.
  - Use the most specific model value available from iteration/worker data, but strip provider prefix if present.
- Tokens segment should keep current arrow format, for example `↑42k ↓8k R120k`.
- Context segment should keep current format, for example `15.4%/272k`.
- Cost segment should keep current money format, for example `$0.1030`.
- Time segment should come after cost and before diff/file data.
- Omit unavailable segments for started/running/error rows rather than showing placeholders.
- Do not show `Used Read, Edit` or other tool-call phrases in widget rows.
- Rows with diff data should append diff/file summary at the end.
- Running rows should not show diff/file summary.
- File count should render with capitalized `File`/`Files`, not lowercase `files`:
  - `1 File`
  - `3 Files`
- Diff/file summary example:

```text
+88 / -12 · 3 Files
```

### Queued and deferred placeholder telemetry

Queued and deferred rows should preserve the same two-line rhythm by showing placeholder telemetry on line 2.

Placeholder requirements:

- Use a placeholder line with model, zero tokens, zero context, zero cost, and zero time where enough data is known.
- Suggested format:

```text
sonnet · ↑0 ↓0 · 0%/272k · $0.0000 · 0s
```

- If a configured/default model is known, show model-only name.
- If context window is known, show `0%/<context>`.
- If model/context is unknown, omit unknown segments rather than inventing misleading values, but keep zero tokens/cost/time when appropriate.
- Queued rows use normal text with queued icon `○`.
- Deferred rows use pause icon `Ⅱ` and are fully muted/dim, including icon, title, and placeholder telemetry.
- Use `Ⅱ`, not emoji pause, for terminal width stability.

### Active/running highlight

- Do not render an arrow for the active/running todo.
- Highlight both lines of the active/running todo with `theme.bg("toolPendingBg", ...)`.
- Apply background after padding the interior content to full interior width so the highlight spans the row inside the panel.
- Keep side borders unhighlighted so the rounded panel remains crisp.
- The running spinner/icon remains on the title line.

### Compact focused todo selection

Compact mode should continue to render one focused todo row, not up to three rows.

Selection priority:

1. First `running` todo in list order.
2. First `failed` or `interrupted` todo in list order.
3. First `queued` or `deferred` todo in list order.
4. Latest `complete` todo only when that todo is also the last item in the todo list.
5. Fallback to first todo.

Important behavior changes:

- Do not show the latest completed todo merely because it is the latest complete item.
- If there is queued/deferred work after completed work, compact mode should show the next queued/deferred item.
- If the loop is fully complete and the last todo is complete, compact mode may show that final completed todo.
- `failed` and `interrupted` are the blocking/error states for this issue; do not add a new todo status.

### Removed old compact badge behavior

Remove or replace the old relative header badges:

```text
↑1 ✓  ↑1 ✗  ↓1 ○  ↓2 ◌
```

Do not display these arrows in the compact header anymore.

## Acceptance criteria

- Widget renders as a rounded bordered panel in compact and expanded modes.
- Top border/title bar says `Subagent Loop · <loop name>`.
- Widget output no longer says `Ralph Loop · <loop name>`.
- Top border/title bar includes right-aligned `✓ complete/total`.
- Top border/title bar includes `✗N` only when failed/interrupted count is nonzero.
- Top border/title bar includes aggregate cost before aggregate elapsed when available.
- Bottom border renders thin progress bar using `━`/`─`.
- Bottom border does not render queued/deferred chips.
- There is a blank bordered line between the final todo and bottom progress border.
- Compact mode still renders exactly one focused todo row.
- Compact selection chooses a running todo before any other status.
- Compact selection chooses failed/interrupted before queued/deferred when no todo is running.
- Compact selection chooses the next queued/deferred todo before any completed todo.
- Compact selection shows a completed todo only when it is the final todo in the list and no running/error/queued/deferred item exists.
- Todo rows use two-line layout with blank line between todos.
- Detail rows use segment order: model, tokens, context, cost, time, diff, files.
- Widget rows do not include tool-call phrases.
- Detail rows show model only, not provider/model.
- Rows with diff data append capitalized `File`/`Files` summary.
- Queued/deferred rows show placeholder telemetry where data is known.
- Deferred rows use `Ⅱ` and are fully muted/dim.
- Running rows use `toolPendingBg` across both row lines and do not use an arrow.
- Compact and expanded footers both say `Ctrl+Opt+R Expand/Compact · Chat to resume, pause, edit, or kill the loop.`
- No widget footer says `/ralph-widget hide to dismiss`.
- Narrow widths do not overflow or break ANSI styling.

## Suggested tests

Update/add tests in `tests/orchestrator.test.ts`:

1. Compact widget renders rounded top/bottom border and side borders.
2. Expanded widget renders rounded top/bottom border and side borders.
3. Top border/title bar renders `Subagent Loop · <name>` and not `Ralph Loop · <name>`.
4. Top border/title bar renders right-side `✓ 4/8` style progress summary.
5. Top border/title bar renders `✗1` for failed/interrupted todos and omits `✗0` when none exist.
6. Top border/title bar includes aggregate cost before elapsed when iteration/worker usage data exists.
7. Bottom border renders progress using `━` and `─`.
8. Bottom border does not include queued/deferred chips.
9. Progress handles `total === 0` safely.
10. Expanded mode inserts blank line between todos and before bottom progress border.
11. Compact mode inserts blank line before bottom progress border.
12. Compact mode selects running todo when present.
13. Compact mode selects failed/interrupted todo when no running todo exists.
14. Compact mode selects first queued/deferred todo before latest complete.
15. Compact mode selects final completed todo when all work is complete and the last todo is complete.
16. Running detail row renders model, tokens, context, cost, time in that order where available.
17. Completed detail row renders model, tokens, context, cost, time, diff, files in that order where available.
18. Detail row model segment strips provider prefix.
19. Widget rows do not render `Used Read`/tool-call phrases.
20. File count renders `1 File` / `N Files`, not lowercase `files`.
21. Queued rows render `○` and placeholder telemetry.
22. Deferred rows render `Ⅱ` and placeholder telemetry.
23. Running rows render without `›` arrow.
24. Compact and expanded footers both use literal `Ctrl+Opt+R Expand/Compact · Chat to resume, pause, edit, or kill the loop.` copy and do not mention `/ralph-widget hide`.
25. Header, panel, progress, and row rendering are safe at narrow widths.

Existing tests to revisit:

- `Ralph widget compact mode shows focused todo and header badges` should be renamed and changed to assert rounded panel, title-bar summary, focused two-line row, and bottom-border progress instead of old header badges.
- Tests that assert `provider/model` in detail rows should be updated to expect model-only display.
- Tests that assert lowercase `files` should be updated to expect `File`/`Files`.
- Tests that assert tool phrase rendering inside widget rows should be updated or scoped to non-widget summary rendering if still relevant.

## Implementation notes

Potential refactor:

- Replace `compactBadges(...)` with progress/title helpers, for example:
  - `renderPanelTopBorder(state, worker, theme, width)`
  - `renderPanelLine(content, theme, width, options?)`
  - `renderPanelBottomProgressBorder(state, theme, width)`
  - `renderTodoRow(todo, state, worker, theme, width)`
- Replace `renderCompactHeader(...)` with shared title-bar rendering used by compact and expanded modes.
- Keep `widgetRule(theme, width)` only if still useful elsewhere; widget panel rendering may make it obsolete.
- Add helpers for aggregate loop metrics:
  - `aggregateLoopElapsedMs(state, worker)`
  - `aggregateLoopCost(state, worker)`
- Add helper to display model-only names:
  - strip provider prefixes from strings like `anthropic/claude-sonnet-4-5`
  - preserve plain model strings as-is
- Add helper for placeholder telemetry for queued/deferred todos using known configured/default model and context window when possible.
- Keep ANSI-aware width handling in mind. Existing `truncateAnsiToWidth(...)` can be used as a final safety net, but panel helpers should aim to produce correctly sized lines before truncation.
- Update `selectedCompactTodo(...)` priority as specified.

## Verification

Run:

```bash
npm test
npm run typecheck
```
