# Issue 011: Persist per-task Ralph worker model assignments

## Summary

Add first-class, persisted worker model assignment to Ralph loop state so each todo can specify which Pi model/provider should run it. Users should be able to accept the default current model, set a loop-level default model, or override individual todos with a specific model such as `ollama-cloud/kimi-k2.6`.

This should also fix the model-display gap where the widget/status can show a model while a worker is running from live worker progress, but completed items no longer reliably display which model performed the work. The chosen/effective worker model must be stored durably in loop state before the child worker starts, and the observed provider/model should be captured on the completed iteration where available.

The Ralph planning skill should also be updated so planning conversations can help users choose models. That may require a Pi extension/tool surface for querying available configured models, or a documented way for the skill/agent to ask Pi for the model registry.

## Motivation

Different loop tasks often deserve different models:

- Cheap/fast model for routine file edits.
- Strong model for architectural or ambiguous design tasks.
- Local/private model for sensitive files.
- Cloud model such as Kimi K2.6 via Ollama Cloud for long-context or high-throughput worker tasks.

Today Ralph supports `--model MODEL` / `ralph_orchestrator_run({ model })` as a run-level option, but that is transient. It does not express the intended model for each todo in `state.json`, does not survive well as planning metadata, and does not let the user assign “the next task” to a specific model while leaving later tasks on default.

The live widget can infer model from `WorkerProgress.model` or `configuredModel` while a worker is active. After completion, that transient progress disappears. Persisting model choice and observed model/provider into loop state gives status, artifacts, and history a durable source of truth.

## Current behavior

`RunOptions` has a transient worker model:

```ts
export interface RunOptions {
  maxIterations?: number;
  workerMode?: WorkerMode;
  workerModel?: string;
  workerContextWindow?: number;
  onProgress?: ...;
  onIterationComplete?: ...;
}
```

`WorkerInput` receives that transient model:

```ts
export interface WorkerInput {
  ...
  workerModel?: string;
  workerContextWindow?: number;
  state: LoopState;
  iteration: IterationState;
  todo: RalphTodo;
}
```

`IterationState` already has optional model/provider fields:

```ts
export interface IterationState {
  ...
  model?: string;
  provider?: string;
}
```

But in `src/orchestrator.ts`, the iteration is created without the configured model:

```ts
const iteration: IterationState = {
  number: iterationNumber,
  status: "running",
  todoId: todo.id,
  beforeRef: beforeRef(state.name, iterationNumber),
  startedAt: new Date().toISOString(),
};
```

and the worker is launched with only the run option:

```ts
workerModel: options.workerModel,
workerContextWindow: options.workerContextWindow,
```

`RalphTodo` currently cannot express a model assignment:

```ts
export interface RalphTodo {
  id: RalphTodoId;
  title: string;
  status: TodoStatus;
}
```

## Goals

- Persist model assignment on each todo when specified.
- Support a loop-level default worker model for todos without explicit overrides.
- Resolve effective worker model consistently before launching each worker.
- Persist the effective configured model on the iteration at start time.
- Persist the observed model/provider on the iteration after worker completion when available.
- Let users update model assignment for queued/deferred future todos, including while a different todo is running.
- Prevent model changes to a currently running todo from affecting an already-started child worker.
- Display assigned/effective/completed model in status and widget output.
- Update Ralph Plan so it knows to discuss worker model choices and, where possible, present available configured Pi models.

## Non-goals

- Implementing new model providers in this issue.
- Guaranteeing provider-specific model availability beyond Pi's existing model registry.
- Migrating historical completed iterations to infer model from old worker traces.
- Running multiple models for the same todo.
- Changing worker prompt semantics beyond reporting model assignment.

## Proposed state model

### Todo-level assignment

Add optional worker configuration to `RalphTodo`:

```ts
export interface RalphTodo {
  id: RalphTodoId;
  title: string;
  status: TodoStatus;

  workerModel?: string;          // e.g. "ollama-cloud/kimi-k2.6" or any Pi model pattern
  workerProvider?: string;       // optional if model string does not already encode provider
  workerContextWindow?: number;  // resolved or explicit override
}
```

If Pi's model string format already encodes provider/model, `workerProvider` may be unnecessary. Keep it only if useful for display or observed-provider distinction.

### Loop-level default

Add an optional default to `LoopState`:

```ts
export interface LoopState {
  ...
  defaultWorkerModel?: string;
  defaultWorkerProvider?: string;
  defaultWorkerContextWindow?: number;
}
```

Alternatively, use one object:

```ts
workerDefaults?: {
  model?: string;
  provider?: string;
  contextWindow?: number;
};
```

Recommendation: prefer `workerDefaults` as an extensible object.

### Iteration-level effective/observed model

Use existing `IterationState.model` and `provider`, but define their meaning clearly:

- `iteration.model`: effective configured model used to launch the worker, updated to observed model only if that is more precise and still compatible with display.
- `iteration.provider`: observed provider, if reported by Pi worker output.

If both configured and observed values are useful, split them:

```ts
configuredModel?: string;
configuredProvider?: string;
observedModel?: string;
observedProvider?: string;
```

Recommendation for clarity: add explicit configured/observed fields and keep `model`/`provider` as backwards-compatible display aliases or populate them from observed/configured priority.

## Model resolution order

Before each worker starts, resolve:

```ts
const effectiveModel =
  todo.workerModel ??
  state.workerDefaults?.model ??
  options.workerModel ??
  undefined; // Pi default/current model
```

Recommended priority discussion:

1. **Todo override** should win because it is the most specific planning decision.
2. **Loop default** should apply to all unspecified tasks.
3. **Run-level `--model`** is useful for ad hoc execution, but should not silently override explicit planned todo assignments.
4. **Undefined** means use Pi's current/default model.

If backward compatibility requires run-level `--model` to override loop default, document that explicitly. Do not let run-level model override a todo-specific model unless a force flag exists.

## Commands and tools

### Start loop

Extend start options to allow a loop default model:

```ts
interface StartOptions {
  name: string;
  todos?: string[];
  maxIterations?: number;
  defaultWorkerModel?: string;
}
```

Slash command option:

```bash
/ralph-start <name> --model ollama-cloud/kimi-k2.6 --todo "..."
```

Clarify whether `--model` on start sets the loop default, while `--model` on run remains a transient fallback.

### Insert todo

Extend todo insertion with optional model assignment:

```ts
ralph_orchestrator_insert_todo({
  name,
  id,
  title,
  insertAtIndex,
  status: "deferred",
  model: "ollama-cloud/kimi-k2.6"
})
```

### Assign/update model

Add a dedicated command/tool:

```ts
ralph_orchestrator_assign_todo_model({
  name: string;
  todoId: string;
  model?: string;        // omit/null to clear override
  provider?: string;
  dryRun?: boolean;
})
```

Potential slash commands:

```bash
/ralph-assign-model <loop> <todo-id> --model ollama-cloud/kimi-k2.6
/ralph-clear-model <loop> <todo-id>
/ralph-default-model <loop> --model sonnet:high
```

This tool should refuse to change the active running todo's launch model. It may allow updating queued/deferred/failed future attempts, with clear status messages.

### Query available models

The Ralph Plan skill needs a way to discover model choices instead of relying on the user to remember model IDs.

Options:

1. **New generic Pi tool**: expose model registry to agents, e.g. `list_models` or `pi_list_models`.
2. **Ralph-specific tool**: `ralph_orchestrator_list_models`, implemented using `ctx.modelRegistry.getAll()`.
3. **Planning command UI**: when `/ralph-plan` runs interactively, use `ctx.ui.select` to let the user pick from `ctx.modelRegistry.getAll()`.
4. **Document fallback**: if no tool is available, Ralph Plan asks the user for a model string or defaults to current model.

Recommendation: add a Ralph-specific planning/helper tool first if Pi does not already expose a generic model-list tool to the LLM. It can return configured provider/id/display/context window fields and avoid changing Pi core.

Example output shape:

```ts
interface AvailableWorkerModel {
  provider: string;
  id: string;
  displayName: string;
  pattern: string;       // value accepted by --model
  contextWindow?: number;
  supportsReasoning?: boolean;
}
```

## Ralph Plan skill updates

Update `skills/ralph-plan/SKILL.md` so planning includes worker model assignment.

Required additions:

- Ask whether workers should use:
  - current/default Pi model
  - one loop-wide model
  - per-todo model assignments
  - decide later before each run
- If model listing is available, instruct the agent to query it before asking the user to choose.
- Explain model precedence in the proposed loop packet.
- Include model assignment fields in the packet:

```md
## Worker Process
- Default worker model:
- Per-todo model overrides:
- Model selection notes:
```

- Add stop/ask-user condition when a requested model is not configured or cannot be resolved.
- For per-task planning, include model next to todos:

```md
- [ ] Add parser tests — model: default/current
- [ ] Refactor parser architecture — model: sonnet:high
- [ ] Generate fixtures — model: ollama-cloud/kimi-k2.6
```

## Display requirements

Status/widget rendering should display model from durable state:

For queued/deferred todos:

1. `todo.workerModel`
2. `state.workerDefaults?.model`
3. `default/current` only if useful and not noisy

For running todos:

1. live `WorkerProgress.model`
2. live `WorkerProgress.configuredModel`
3. `iteration.configuredModel` / `iteration.model`
4. `todo.workerModel`
5. loop default

For completed todos:

1. `iteration.observedModel` and provider, if available
2. `iteration.configuredModel`
3. legacy `iteration.model`
4. `todo.workerModel`
5. loop default

This should fix the observed bug where model display is present while running but disappears after completion.

## Artifact and reporting requirements

- `handoff-in.md` should tell the worker which model was selected, at least for traceability.
- `worker-output.jsonl` already records assistant model/provider events; ensure the orchestrator parses enough of this to populate iteration fields.
- `handoff-out.md` does not need to repeat model unless useful, but iteration summary should include model/provider.
- `verification.md` remains about commands/results, not model metadata.

## Implementation notes

Likely touch points:

- `src/types.ts`
  - Add worker model fields to `RalphTodo`.
  - Add loop default model fields.
  - Consider explicit configured/observed iteration model fields.
  - Add tool option types for assigning model.
- `src/store.ts`
  - Update schema validation.
  - Add backward-compatible optional fields.
- `src/orchestrator.ts`
  - Resolve effective worker model per todo before creating iteration.
  - Persist configured model on the iteration before worker starts.
  - Pass effective model/context window into worker input.
  - Read latest state before each iteration so updates to future todos made during a run are honored.
- `src/pi-json-worker.ts`
  - Ensure final result exposes observed model/provider if currently only progress sees it.
  - Consider extending `WorkerResult` with model/provider fields.
- `extensions/orchestrator.ts`
  - Parse model options for start/insert/assign commands/tools.
  - Use `ctx.modelRegistry` to resolve context window for per-todo/loop-default models.
  - Add list-models helper if needed.
  - Update widget/status render logic to use durable model fields.
- `skills/ralph-plan/SKILL.md`
  - Add model selection interview guidance and loop packet fields.
- `README.md` and `docs/protocol.md`
  - Document model assignment, precedence, display, and state schema.

## Edge cases

- Todo has explicit model that is no longer configured when it is about to run.
  - Expected: stop and mark needs attention or ask user before launching.
- User updates model for a queued/deferred todo while another todo is running.
  - Expected: update persists and next worker uses it.
- User attempts to update model for the currently running todo.
  - Expected: refuse or record as future retry only; do not imply active child worker changed models.
- Run-level `--model` conflicts with todo-level model.
  - Expected: todo-level model wins unless a documented force override exists.
- Completed legacy iteration lacks model fields.
  - Expected: render without model; do not crash.
- Model string matches multiple registry entries.
  - Expected: fail with a clear ambiguity message or require provider-qualified pattern.
- No UI/RPC model picker is available.
  - Expected: skill asks user for model string or defaults to current model.

## Acceptance criteria

- `state.json` can store a loop-level default worker model.
- `state.json` can store a worker model override on individual todos.
- Older loop states without model fields still load.
- Starting a worker persists the effective configured model on that iteration before launch.
- Completed iteration status/widget display still shows the model after live worker progress is gone.
- A queued/deferred todo can have its model updated while a different todo is running.
- The currently running todo's active child worker model cannot be changed mid-flight.
- Todo-specific model overrides take precedence over loop defaults and run-level fallback models.
- Ralph Plan proposes model selection in its loop packet and can use an available model-listing mechanism when present.
- Documentation explains model precedence and how to assign/clear per-todo model overrides.

## Suggested tests

- Schema test: todo-level and loop-level model fields validate.
- Migration test: old state without model fields validates.
- Resolution test: todo model beats loop default, loop default beats run-level fallback, run-level fallback beats undefined default.
- Orchestrator test: iteration created with configured model before worker launch.
- Worker-result test: observed model/provider are persisted when present in worker output.
- Command/tool test: assign model to queued todo updates state and plan/status output.
- Running-loop test: assign model to next todo while current todo runs; next iteration launches with assigned model.
- Refusal test: assigning model to currently running todo is rejected or clearly treated as future retry only.
- Rendering test: completed todo displays persisted model after worker progress is unavailable.
- Ralph Plan test/fixture: proposed packet includes default model and per-todo override fields.

## Verification

Run:

```bash
npm test
npm run typecheck
```
