# Pi Extensions

Monorepo for Keydown Pi extensions. The root package is `@keydown-dev/pi-extensions` and acts as an aggregator package: installing the monorepo root loads the extension and skill resources listed in the root `package.json` `pi` manifest.

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

## Install in Pi

Install the extensions directly from Git with either SSH or HTTPS:

```bash
# SSH, uses your configured GitHub SSH key
pi install git:git@github.com:keydown-dev/pi-extensions

# HTTPS
pi install https://github.com/keydown-dev/pi-extensions
```

To pin the install to a tag or commit, append `@<ref>`:

```bash
pi install git:git@github.com:keydown-dev/pi-extensions@v0.1.0
pi install https://github.com/keydown-dev/pi-extensions@<commit-sha>
```

By default, Pi installs packages globally under `~/.pi/agent/git/` and records them in `~/.pi/agent/settings.json`. For a project-local install that is recorded in `.pi/settings.json`, add `-l`:

```bash
pi install -l git:git@github.com:keydown-dev/pi-extensions
```

After installing, restart Pi or run `/reload`. Use `pi list` to confirm the package is installed and `pi config` to enable or disable resources from the package.

For local development from a checkout:

```bash
pi install .
```

You can also target an individual package directory:

```bash
pi install ./packages/loops
```

## Root aggregator manifest

Pi package manifests can point to multiple extension and skill directories. The root package uses this to expose ready extensions from the monorepo as one installable package:

```json
"pi": {
  "extensions": ["./packages/loops/extensions"],
  "skills": ["./packages/loops/skills"]
}
```

As more packages become ready, add their resource directories to the root manifest arrays.
