# Packages

This directory contains the monorepo packages for Pi extensions and shared libraries.

Current packages:

- `loops/` — `@keydown-dev/pi-loops`, the loop orchestration Pi package.
- `questions/` — `@keydown-dev/pi-questions`, structured Q&A extension placeholder.
- `todos/` — `@keydown-dev/pi-todos`, todo tool/widget extension placeholder.
- `elements/` — `@keydown-dev/elements`, shared TUI primitives used by the extensions.

Install the root aggregator package from a local checkout with:

```bash
pi install .
```

Install an individual extension package locally by targeting its package directory, for example:

```bash
pi install ./packages/loops
```

The monorepo root `package.json` can expose multiple package resource directories through its `pi.extensions` and `pi.skills` arrays.
