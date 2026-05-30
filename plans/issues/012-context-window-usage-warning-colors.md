# Issue 012: Highlight Ralph worker context-window pressure in the widget

## Summary

Add visual warning/error states to the Ralph widget when a running worker consumes a large fraction of its model context window. While an item is running, if context usage exceeds 40% of the worker model's context window, the widget background and spinner should switch to a warning color. If usage exceeds 50%, they should switch to an error color to indicate the worker may be entering the model's “dumb zone” and the task may have been too large.

Also make two general widget color refinements: the widget border should use the same color as the header text, and the filled/progress portion of the bottom progress bar should render white.

This is a nice-to-have observability and polish feature. It should not change orchestration behavior, stop workers, or mark tasks failed by itself.

## Motivation

Long-running fresh-context workers can silently accumulate a large prompt/tool transcript. Once a worker consumes too much of its context window, model quality may degrade even if the process is still technically within the provider's limits. Users need an at-a-glance signal that a task is becoming too large and may need to be split, paused, killed, or redesigned.

The Ralph widget already displays worker progress while a todo is running. Context pressure is important enough to surface visually, not just as a numeric token count.

## Desired behavior

Only apply this visual treatment while a todo is actively running and a worker context window is known.

Thresholds:

- `< 40%`: normal widget colors.
- `>= 40%` and `< 50%`: warning state.
- `>= 50%`: error state.

Warning state:

- Spinner uses the theme warning color.
- Running row/detail accents use warning color where appropriate.
- Widget background or highlighted running row background changes to a warning-tinted color, if the TUI theme supports it.

Error state:

- Spinner uses the theme error color.
- Running row/detail accents use error color where appropriate.
- Widget background or highlighted running row background changes to an error-tinted color, if the TUI theme supports it.
- Detail text may include a short indicator such as `context 52%` or `52% ctx`.

General widget color refinements:

- The border around the Ralph widget should use the same color as the header text, whatever that color is in the active state/theme.
- The filled portion of the bottom progress bar — the part that represents completed progress — should render white.
- The unfilled/remainder portion of the progress bar should keep its existing muted/background styling unless readability requires a small adjustment.

## Current data availability

`WorkerUsage` already supports context-window fields:

```ts
export interface WorkerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: number;
  contextTokens?: number;
  contextWindow?: number;
}
```

`WorkerProgress` exposes both aggregate and latest usage:

```ts
export interface WorkerProgress {
  ...
  usage: WorkerUsage;
  latestUsage?: WorkerUsage;
}
```

Use the best available values from live worker progress:

```ts
const contextTokens =
  worker.latestUsage?.contextTokens ??
  worker.usage.contextTokens;

const contextWindow =
  worker.latestUsage?.contextWindow ??
  worker.usage.contextWindow ??
  worker.contextWindowFromConfiguredModel;
```

If `contextTokens` or `contextWindow` is missing, render normal colors and omit percentage warnings.

## Requirements

### Context pressure calculation

Add a helper that derives pressure from worker progress:

```ts
type ContextPressure = "normal" | "warning" | "error" | "unknown";

function contextPressure(worker?: WorkerProgress): {
  level: ContextPressure;
  ratio?: number;
  percent?: number;
} {
  ...
}
```

Rules:

- Return `unknown` when no worker is running or context data is unavailable.
- Use `contextTokens / contextWindow`.
- Clamp invalid values defensively.
- Treat exactly 40% as warning.
- Treat exactly 50% as error.

### Widget rendering

When a todo is running and pressure is warning/error:

- Apply warning/error color to the spinner.
- Apply warning/error styling to the running todo row or detail row.
- Apply warning/error background tint if supported by current TUI theme APIs.
- Keep text readable in light and dark themes.
- Do not apply warning/error color to completed, queued, deferred, failed, or interrupted todos unless they are also the live running todo.

For all widget states:

- Render the widget border using the same color as the header text.
- If the header text color changes because of normal/warning/error state, the border should follow that same resolved color.
- Render the filled/completed segment of the bottom progress bar in white.
- Keep the progress bar remainder in the current muted/remainder color unless tests or visual review show poor contrast.

### Detail text

When context percentage is known, include it in the worker detail line, for example:

```text
1m 20s · ctx 43% · ↑261k ↓21k · tools read, edit
```

If the existing detail line already includes context tokens/window elsewhere, avoid duplicating it. Prefer a compact percentage.

### Accessibility / low-noise behavior

- Do not flash colors on every render tick; color level should change only when thresholds are crossed.
- Do not use warning/error for missing context-window data.
- Do not emit notifications solely for threshold crossing in this issue; widget color is enough.

## Non-goals

- Automatically pausing, killing, compacting, or splitting a worker.
- Changing worker prompt size or context management.
- Adding user-configurable thresholds in the first implementation.
- Persisting context-pressure events into loop state.
- Treating high context usage as verification failure.

## Implementation notes

Likely touch points:

- `extensions/orchestrator.ts`
  - Rendering helpers around `renderRalphWidget`, running todo row, spinner, and worker detail text.
  - Existing code already renders model/usage/tool data for workers; extend that path.
- `src/types.ts`
  - No type changes should be required unless worker context window is not reliably present in `WorkerProgress`.
- `src/pi-json-worker.ts`
  - If context usage is not populated consistently, improve `WorkerProgressTracker` so `latestUsage.contextTokens` and `contextWindow` are available when provider usage exposes them.
- Theme usage
  - Prefer existing theme semantic colors for warning/error.
  - If there is no background API, color the spinner and row label only rather than inventing unsupported styling.
  - Reuse the resolved header text color for the widget border instead of choosing an independent border color.
  - Use white for the filled progress-bar segment; keep the remainder muted.

## Edge cases

- Worker model has unknown context window.
  - Expected: normal colors; no percentage.
- Provider reports total tokens but not context tokens.
  - Expected: use context tokens only if semantically correct; otherwise normal colors.
- Context usage briefly drops or provider reports inconsistent snapshots.
  - Expected: render based on latest valid snapshot; no persistence needed.
- Very small or invalid context window value.
  - Expected: ignore and render `unknown`.
- Compact widget mode shows only one focused row.
  - Expected: warning/error styling is visible in compact mode when the focused/running todo is active.
- Expanded widget mode shows all todos.
  - Expected: only the running todo row/detail gets pressure styling.
- Header color changes due to warning/error pressure.
  - Expected: widget border follows the same resolved header color.
- Progress bar appears against a light theme.
  - Expected: white filled segment remains readable or the surrounding/remainder styling provides sufficient contrast.

## Acceptance criteria

- While a worker is running below 40% context-window usage, widget styling remains normal.
- At 40% or above, spinner and running-row/detail styling switch to warning color.
- At 50% or above, spinner and running-row/detail styling switch to error color.
- Context percentage appears compactly in worker detail text when context data is available.
- Missing context-window data does not produce warning/error colors or misleading percentages.
- Completed items do not keep warning/error styling after the worker exits.
- Compact and expanded widget modes both show the pressure styling for the active running todo.
- Widget border color matches the resolved header text color in normal, warning, and error states.
- The filled/completed segment of the bottom progress bar renders white.
- Existing Ralph widget display-mode tests continue to pass.

## Suggested tests

- Helper test: `39.9%` returns normal.
- Helper test: `40%` returns warning.
- Helper test: `49.9%` returns warning.
- Helper test: `50%` returns error.
- Helper test: missing context tokens/window returns unknown.
- Rendering test: running spinner uses warning color at 40%.
- Rendering test: running spinner uses error color at 50%.
- Rendering test: completed todo with previous high usage renders normal after worker progress is gone.
- Rendering test: detail line includes compact context percentage when known.
- Rendering test: widget border uses the same color as header text.
- Rendering test: filled progress-bar segment renders white.

## Verification

Run:

```bash
npm test
npm run typecheck
```
