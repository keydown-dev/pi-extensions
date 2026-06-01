# Keydown Pi Extensions

Monorepo for independently installable Pi extensions.

Packages:

- `packages/loops` — `@keydown-dev/pi-loops`, orchestrated loops with optional subagent workers.
- `packages/questions` — `@keydown-dev/pi-questions`, structured Q&A extension placeholder.
- `packages/todos` — `@keydown-dev/pi-todos`, todo tool/widget extension placeholder.
- `packages/elements` — `@keydown-dev/elements`, shared TUI elements library, not a Pi extension.

Current development commands:

```bash
npm run typecheck
npm test
```

Install the loop extension from a local checkout with:

```bash
pi install ./packages/loops
```
