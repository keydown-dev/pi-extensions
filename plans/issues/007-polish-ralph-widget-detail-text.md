# Issue 007: Polish Ralph widget detail text and mode copy

## Summary

Polish the Ralph widget text after the display-mode work lands. Replace lowercase CSV-style tool/action detail text with a more readable sentence phrase, and clean up footer/help/notification copy to match compact, expanded, and hidden modes.

This issue is intentionally separate from the structural display-mode work so the UI state changes can land first, then text polish can be applied with focused tests.

## User stories

1. As a Ralph user, I want running tool details to read like polished UI copy, so the widget feels intentional rather than debuggy.
2. As a Ralph user, I want long tool lists to be summarized neatly, so detail rows do not become noisy.
3. As a Ralph user, I want footer and notification copy to describe compact/expanded/hidden modes accurately, so keyboard and command behavior is discoverable.
4. As a Ralph maintainer, I want detail formatting in helpers, so future widget rendering changes do not duplicate string logic.

## Requirements

### Tool/action phrase formatting

Replace the current lowercase CSV-style detail text, for example:

```text
tools read, edit
```

with sentence-style display:

```text
Used Read, Edit
```

For longer tool lists, show the first few title-cased names and summarize the rest:

```text
Used Read, Edit +3 more
```

Requirements:

- Add a helper such as `renderToolPhrase(toolNames, fallbackCount)`.
- Title-case known/raw tool names for display.
- Preserve concise names where appropriate, e.g. `Bash`, `Read`, `Edit`, `Write`.
- Use `Used <Tool>, <Tool>` for short lists.
- Use `Used <Tool>, <Tool> +N more` for long lists.
- If tool names are unavailable but a count exists, use a readable fallback such as `Used 3 tools`.
- Avoid lowercase CSV labels like `tools read, edit`.
- Apply this to running worker detail text.
- If completed/action detail text later lists tool names, it should reuse the same helper.

### Footer copy

Update widget footer text to reflect display mode behavior.

Suggested copy:

- Compact mode:
  ```text
  Ctrl+Opt+R Expand · /ralph-widget hide to dismiss
  ```
- Expanded mode:
  ```text
  Ctrl+Opt+R Compact · Chat to pause, resume, steer, or kill the loop.
  ```
- Hidden mode has no widget footer because no widget is rendered.

### Notifications

Replace pure show/hide notification language with mode language where applicable:

- `Ralph widget expanded`
- `Ralph widget compact`
- `Ralph widget hidden`

Notifications should not claim Ctrl+Opt+R hides the widget. Ctrl+Opt+R only expands/contracts.

### Help and command descriptions

Update command and help text:

- `/ralph-widget [toggle|compact|expand|show|hide]`
- Describe show/hide as explicit command actions.
- Describe Ctrl+Opt+R as expand/contract, not show/hide.

### Tone and constraints

- Keep detail rows compact enough for terminal widths.
- Prefer text over icon chips for tool/action phrases.
- Do not introduce a dependency for title-casing.
- Preserve existing token/cost/diff formatting unless directly necessary for the tool phrase.

## Acceptance criteria

- Running worker detail renders `Used Read, Edit` instead of `tools read, edit`.
- Long running tool lists render a `+N more` suffix.
- Missing tool names with a count render a readable fallback.
- Compact and expanded footers mention the correct Ctrl+Opt+R action.
- Notifications use mode terms and no longer say `Ctrl+Opt+R toggles show/hide`.
- Help text and command descriptions match the final widget controls.

## Suggested tests

- Running detail formats a short tool list as `Used Read, Edit`.
- Running detail formats a long tool list as `Used Read, Edit +N more`.
- Running detail falls back to `Used N tools` when names are absent.
- Compact footer says `Expand`.
- Expanded footer says `Compact`.
- No rendered/help text describes Ctrl+Opt+R as hide/show.

## Verification

Run:

```bash
npm test
npm run typecheck
```
