import fs from "node:fs/promises";
import path from "node:path";
import { handoffCommitMessage, workerCommitMessage } from "./commit-messages.js";
import { afterRef, beforeRef, GitPolicy, orchestrationBranch } from "./git.js";
import { slugifyLoopName } from "./paths.js";
import { killRalphWorkerProcesses, PiJsonWorkerRunner } from "./pi-json-worker.js";
import { ScriptedMathWorker } from "./scripted-worker.js";
import { RalphStore } from "./store.js";
import type { AssignTodoModelOptions, AssignTodoModelResult, DerivedLoopStatus, InsertTodoOptions, InsertTodoResult, IterationState, LoopState, RalphTodo, RestartTodoOptions, RestartTodoResult, RunOptions, StartOptions, WorkerProgress } from "./types.js";

const DEFAULT_TODOS = ["Add subtract test and implementation", "Add multiply test and implementation", "Add divide test and implementation"];

export class RalphOrchestrator {
  private readonly store: RalphStore;
  private readonly git: GitPolicy;

  constructor(private readonly cwd: string, private readonly packageRoot?: string) {
    this.store = new RalphStore(cwd);
    this.git = new GitPolicy(cwd);
  }

  async start(options: StartOptions): Promise<LoopState> {
    const name = slugifyLoopName(options.name);
    await this.git.assertRepo();
    if (await this.store.exists(name)) throw new Error(`Ralph loop already exists: ${name}`);
    await this.git.assertCleanWorktree({ ignorePrefixes: [".loop"] });

    const branch = orchestrationBranch(name);
    await this.git.checkoutBranch(branch);
    const workerDefaults = {
      ...(options.defaultWorkerModel ? { model: options.defaultWorkerModel } : {}),
      ...(options.defaultWorkerProvider ? { provider: options.defaultWorkerProvider } : {}),
      ...(options.defaultWorkerContextWindow ? { contextWindow: options.defaultWorkerContextWindow } : {}),
    };
    const state = await this.store.createLoop(name, options.todos?.length ? options.todos : DEFAULT_TODOS, branch, options.maxIterations, workerDefaults);
    await this.git.addAllAndCommit(`orchestrator: start ${name}`);
    return state;
  }

  async status(name: string): Promise<LoopState> {
    return this.store.readState(slugifyLoopName(name));
  }

  async list(): Promise<LoopState[]> {
    return this.store.listStates();
  }

  async insertTodo(options: InsertTodoOptions): Promise<InsertTodoResult> {
    const state = await this.store.readState(slugifyLoopName(options.name));
    assertLoopSafeForTodoInsertion(state);
    const title = options.title.trim();
    if (!title) throw new Error("Inserted Ralph todo title cannot be empty.");
    const id = options.id.trim();
    if (!id) throw new Error("Inserted Ralph todo id cannot be empty.");
    if (state.todos.some((todo) => String(todo.id) === id)) throw new Error(`Ralph todo id already exists in ${state.name}: ${id}`);
    const insertAtIndex = options.insertAtIndex ?? state.todos.length;
    assertValidInsertAtIndex(state, insertAtIndex);

    const maxIterationsBefore = state.maxIterations;
    const insertedTodo: RalphTodo = {
      id,
      title,
      status: options.status ?? "deferred",
      ...(options.workerModel ? { workerModel: options.workerModel } : {}),
      ...(options.workerProvider ? { workerProvider: options.workerProvider } : {}),
      ...(options.workerContextWindow ? { workerContextWindow: options.workerContextWindow } : {}),
    };
    const nextState: LoopState = {
      ...state,
      todos: [
        ...state.todos.slice(0, insertAtIndex),
        insertedTodo,
        ...state.todos.slice(insertAtIndex),
      ],
      maxIterations: state.maxIterations === undefined ? undefined : state.maxIterations + 1,
      iterations: [...state.iterations],
    };

    if (!options.dryRun) {
      await this.store.writeState(nextState);
      await this.git.addAllAndCommit(`orchestrator: insert todo ${insertedTodo.id} into ${state.name}`);
    }

    return {
      state: nextState,
      insertedTodo,
      insertAtIndex,
      dryRun: options.dryRun ?? false,
      maxIterationsChange: maxIterationsBefore === undefined ? undefined : { before: maxIterationsBefore, after: maxIterationsBefore + 1 },
    };
  }

  async assignTodoModel(options: AssignTodoModelOptions): Promise<AssignTodoModelResult> {
    const state = await this.store.readState(slugifyLoopName(options.name));
    const todo = state.todos.find((item) => String(item.id) === String(options.todoId));
    if (!todo) throw new Error(`Ralph todo not found in ${state.name}: ${options.todoId}`);
    if (todo.status === "running") throw new Error(`Cannot change the active worker model for running todo ${todo.id}. Pause or wait for the worker to finish.`);
    const cleared = options.model === null || options.model === "";
    const nextTodo: RalphTodo = { ...todo };
    if (cleared) {
      delete nextTodo.workerModel;
      delete nextTodo.workerProvider;
      delete nextTodo.workerContextWindow;
    } else {
      if (options.model !== undefined) nextTodo.workerModel = options.model ?? undefined;
      if (options.provider !== undefined) nextTodo.workerProvider = options.provider ?? undefined;
      if (options.contextWindow !== undefined) nextTodo.workerContextWindow = options.contextWindow ?? undefined;
    }
    const nextState: LoopState = {
      ...state,
      todos: state.todos.map((item) => (String(item.id) === String(todo.id) ? nextTodo : item)),
      iterations: [...state.iterations],
    };
    if (!options.dryRun) {
      await this.store.writeState(nextState);
      if (!state.iterations.some((iteration) => iteration.status === "running")) {
        await this.git.addAllAndCommit(`orchestrator: assign model for ${todo.id} in ${state.name}`);
      }
    }
    return { state: nextState, todo: nextTodo, dryRun: options.dryRun ?? false, cleared };
  }

  async pause(name: string): Promise<LoopState> {
    const state = await this.store.readState(slugifyLoopName(name));
    state.control = "paused";
    delete state.runBudget;
    deferQueuedTodos(state);
    await this.store.writeState(state);
    if (!state.iterations.some((iteration) => iteration.status === "running")) {
      await this.git.addAllAndCommit(`orchestrator: pause ${state.name}`);
    }
    return state;
  }

  async restartTodo(options: RestartTodoOptions): Promise<RestartTodoResult> {
    const state = await this.store.readState(slugifyLoopName(options.name));
    if (state.todos.some((todo) => todo.status === "running") || state.iterations.some((iteration) => iteration.status === "running")) {
      throw new Error(`Cannot restart a loop todo while loop is running: ${state.name}. Pause or wait for the active worker to finish first.`);
    }

    const todo = selectRestartTodo(state, options.todoId);
    if (todo.status !== "failed" && todo.status !== "interrupted") throw new Error(`Ralph todo is not failed or interrupted in ${state.name}: ${todo.id}`);
    if (hasResolutionSubtasks(state, todo.id)) throw new Error(`Cannot restart ${todo.id} because it has resolution subtasks. Continue-like recovery should use the subtask instead.`);

    const iteration = latestIterationForTodo(state, todo.id);
    if (!iteration) throw new Error(`No iteration history found for todo ${todo.id} in ${state.name}.`);
    const before = iteration.beforeRef;
    if (!(await this.git.refExists(before))) throw new Error(`Cannot restart ${todo.id}: beforeRef does not exist: ${before}`);

    const head = await this.git.headRef();
    const rescueRef = restartRescueRef(state.name, todo.id);
    const worktreeDirty = await this.git.isWorktreeDirty({ ignorePrefixes: [".loop"] });
    const nextState: LoopState = {
      ...state,
      control: "active",
      runBudget: undefined,
      todos: state.todos.map((item) => (String(item.id) === String(todo.id) ? { ...item, status: "queued" } : item)),
      iterations: [...state.iterations],
    };
    const nextTodo = nextState.todos.find((item) => String(item.id) === String(todo.id));
    if (!nextTodo) throw new Error(`Ralph todo disappeared during restart planning: ${todo.id}`);

    if (!options.dryRun) {
      await this.git.createRef(rescueRef, "HEAD");
      await this.git.resetHard(before);
      await this.store.writeState(nextState);
      await this.git.addAllAndCommit(`orchestrator: restart ${todo.id} in ${state.name}`);
    }

    return {
      state: nextState,
      todo: nextTodo,
      iteration,
      beforeRef: before,
      headRef: head,
      rescueRef,
      worktreeDirty,
      dryRun: options.dryRun ?? false,
      nextAction: `Run /loop-run ${state.name} --max 1 or subagent_loop_run({ name: "${state.name}", maxIterations: 1 }) to retry ${todo.id}.`,
    };
  }

  async kill(name: string): Promise<{ state: LoopState; killed: number }> {
    const state = await this.store.readState(slugifyLoopName(name));
    const killed = killRalphWorkerProcesses(state.name);
    state.control = "paused";
    const hasWorkerChanges = (await this.git.changedPaths()).some((filePath) => !filePath.startsWith(".loop/"));
    for (const todo of state.todos) {
      if (todo.status === "running") todo.status = hasWorkerChanges ? "interrupted" : "queued";
    }
    for (const iteration of state.iterations) {
      if (iteration.status === "running") {
        iteration.status = "aborted";
        iteration.completedAt = new Date().toISOString();
        iteration.diff = { filesChanged: hasWorkerChanges ? (await this.git.changedPaths()).filter((filePath) => !filePath.startsWith(".loop/")).length : 0, insertions: 0, deletions: 0 };
        iteration.verification = {
          status: "failed",
          commands: [{ command: "loop-kill", exitCode: killed > 0 ? 143 : 0, summary: hasWorkerChanges ? "Worker killed; partial edits may remain" : "Worker killed; no worktree edits detected" }],
          notes: hasWorkerChanges ? "Inspect git status before running the loop again." : "No non-loop worktree edits were detected at kill time.",
        };
      }
    }
    await this.store.writeState(state);
    if (killed === 0) await this.git.addAllAndCommit(`orchestrator: kill ${state.name}`);
    return { state, killed };
  }

  async next(name: string, options: RunOptions = {}): Promise<LoopState> {
    const state = await this.store.readState(slify(name));
    if (state.control === "paused") throw new Error(`Loop is paused: ${state.name}. Use /loop-run ${state.name} to resume and run queued work.`);
    if (state.todos.some((todo) => todo.status === "failed" || todo.status === "interrupted")) throw new Error(`Loop needs attention before running: ${state.name}`);
    await this.git.assertCleanWorktree({ ignorePrefixes: [".loop"] });

    const workerMode = options.workerMode ?? "pi-json";
    const worker = workerMode === "scripted" ? new ScriptedMathWorker() : new PiJsonWorkerRunner();
    if (worker instanceof ScriptedMathWorker) await worker.assertCanRun(this.cwd);

    const todo = state.todos.find((item) => item.status === "queued");
    if (!todo) {
      await this.store.writeState(state);
      await this.git.addAllAndCommit(`orchestrator: idle ${state.name}`);
      return state;
    }

    const effectiveWorker = resolveEffectiveWorker(todo, state, options);
    const iterationNumber = state.currentIteration + 1;
    const iteration: IterationState = {
      number: iterationNumber,
      status: "running",
      todoId: todo.id,
      beforeRef: beforeRef(state.name, iterationNumber),
      ...(effectiveWorker.model ? { model: effectiveWorker.model, configuredModel: effectiveWorker.model } : {}),
      ...(effectiveWorker.provider ? { configuredProvider: effectiveWorker.provider } : {}),
      startedAt: new Date().toISOString(),
    };
    state.currentIteration = iterationNumber;
    state.iterations.push(iteration);
    todo.status = "running";

    await this.git.createRef(iteration.beforeRef);
    await this.store.createIterationFiles(state, iteration, todo);
    await fs.writeFile(path.join(this.store.getIterationDir(state.name, iterationNumber), "git-before.txt"), await this.git.captureStatus(), "utf8");
    await this.store.writeState(state);
    options.onProgress?.({ state, message: `Started loop iteration ${iterationNumber}: ${todo.title}` });
    await this.git.addAllAndCommit(handoffCommitMessage(todo.id, iterationNumber));

    const forwardWorkerProgress = (progress: WorkerProgress): void => {
      void (async () => {
        const progressState = await this.latestProgressState(state);
        await options.onProgress?.({ state: progressState, worker: progress, message: `Worker ${progress.phase} for iteration ${iterationNumber}: ${todo.title}` });
      })();
    };

    const result = await worker.runIteration({
      cwd: this.cwd,
      loopDir: this.store.getLoopDir(state.name),
      iterationDir: this.store.getIterationDir(state.name, iterationNumber),
      packageRoot: this.packageRoot,
      workerModel: effectiveWorker.model,
      workerContextWindow: effectiveWorker.contextWindow,
      state,
      iteration,
      todo,
    }, forwardWorkerProgress);

    result.changedFiles = result.changedFiles.length > 0 ? result.changedFiles : await this.git.changedPaths();
    iteration.diff = await this.git.diffStats("HEAD", { excludePrefixes: [".loop"], includeUntracked: true });
    iteration.usage = result.usage;
    if (result.model) {
      iteration.observedModel = result.model;
      iteration.model = result.model;
    }
    if (result.provider) {
      iteration.observedProvider = result.provider;
      iteration.provider = result.provider;
    }
    iteration.summary = result.summary;
    iteration.changedFiles = result.changedFiles;
    iteration.commitSubject = result.commitSubject;
    const latest = await this.store.readState(state.name);
    preserveExternalRunUpdates(state, latest, todo.id);
    const externallyPaused = latest.control === "paused";
    const killed = /(?:ralph-kill|loop kill|loop-kill)/i.test(result.verification.notes ?? "") || result.verification.commands.some((command) => /(?:ralph-kill|loop kill|loop-kill)/i.test(command.summary));

    iteration.verification = result.verification;
    iteration.afterRef = afterRef(state.name, iterationNumber);
    iteration.completedAt = new Date().toISOString();

    if (killed) {
      const changed = (iteration.diff?.filesChanged ?? 0) > 0;
      iteration.status = "aborted";
      todo.status = changed ? "interrupted" : "queued";
      state.control = "paused";
    } else {
      iteration.status = result.verification.status === "passed" ? "accepted" : "failed";
      todo.status = result.verification.status === "passed" ? "complete" : "failed";
      state.control = externallyPaused ? "paused" : "active";
      if (externallyPaused) deferQueuedTodos(state);
    }

    await this.store.writeWorkerArtifacts(state, iteration, result);
    await fs.writeFile(path.join(this.store.getIterationDir(state.name, iterationNumber), "git-after.txt"), await this.git.captureStatus(), "utf8");
    await this.store.writeState(state);
    options.onProgress?.({ state, message: `Finished loop iteration ${iterationNumber} with ${result.verification.status}` });
    await this.git.addAllAndCommit(workerCommitMessage(todo.id, iterationNumber, result.commitSubject));
    await this.git.createRef(iteration.afterRef);
    await options.onIterationComplete?.({ state, iteration, todo, result });

    return state;
  }

  private async latestProgressState(state: LoopState): Promise<LoopState> {
    try {
      const latest = await this.store.readState(state.name);
      return latest.control === "paused" ? latest : state;
    } catch {
      return state;
    }
  }

  async extendRun(name: string, count: number, updatedBy: "command" | "tool" = "command"): Promise<LoopState> {
    if (!Number.isInteger(count) || count <= 0) throw new Error("Run extension count must be a positive integer.");
    const state = await this.store.readState(slugifyLoopName(name));
    if (state.todos.some((todo) => todo.status === "failed" || todo.status === "interrupted")) throw new Error(`Loop needs attention before running: ${state.name}`);
    state.control = "active";
    const current = state.runBudget?.remaining ?? 0;
    state.runBudget = { remaining: current + count, updatedAt: new Date().toISOString(), updatedBy };
    prepareRunScope(state, state.runBudget.remaining);
    await this.store.writeState(state);
    return state;
  }

  async run(name: string, options: RunOptions = {}): Promise<LoopState> {
    const max = options.maxIterations ?? 1;
    let state = await this.store.readState(slugifyLoopName(name));
    if (state.todos.some((todo) => todo.status === "failed" || todo.status === "interrupted")) throw new Error(`Loop needs attention before running: ${state.name}`);
    state.control = "active";
    state.runBudget = { remaining: max, updatedAt: new Date().toISOString(), updatedBy: "orchestrator" };
    prepareRunScope(state, max);
    await this.store.writeState(state);
    await this.git.addAllAndCommit(`orchestrator: run ${state.name}`);

    while (true) {
      state = await this.store.readState(slugifyLoopName(name));
      if (state.control !== "active") break;
      if (state.todos.some((todo) => todo.status === "failed" || todo.status === "interrupted")) break;
      const remaining = state.runBudget?.remaining ?? 0;
      if (remaining <= 0) break;
      prepareRunScope(state, remaining);
      if (!state.todos.some((todo) => todo.status === "queued")) break;
      state.runBudget = { ...state.runBudget, remaining: remaining - 1, updatedAt: new Date().toISOString(), updatedBy: "orchestrator" };
      await this.store.writeState(state);
      state = await this.next(name, options);
    }
    return this.store.readState(slugifyLoopName(name));
  }
}

function slify(name: string): string {
  return slugifyLoopName(name);
}

function selectRestartTodo(state: LoopState, requestedTodoId: string | undefined): RalphTodo {
  if (requestedTodoId) {
    const todo = state.todos.find((item) => String(item.id) === String(requestedTodoId));
    if (!todo) throw new Error(`Ralph todo not found in ${state.name}: ${requestedTodoId}`);
    return todo;
  }

  const candidates = state.todos.filter((todo) => todo.status === "failed" || todo.status === "interrupted");
  if (candidates.length === 0) throw new Error(`No failed or interrupted todo exists in ${state.name}.`);
  if (candidates.length > 1) throw new Error(`Multiple failed/interrupted todos exist in ${state.name}; pass todoId. Candidates: ${candidates.map((todo) => todo.id).join(", ")}`);
  return candidates[0]!;
}

function hasResolutionSubtasks(state: LoopState, todoId: RalphTodo["id"]): boolean {
  const prefix = `${String(todoId)}.`;
  return state.todos.some((todo) => String(todo.id).startsWith(prefix));
}

function restartRescueRef(loopName: string, todoId: RalphTodo["id"]): string {
  const safeTodoId = String(todoId).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "todo";
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `ralph/${loopName}/restart-rescue-${safeTodoId}-${timestamp}`;
}

function deferQueuedTodos(state: LoopState): void {
  for (const todo of state.todos) {
    if (todo.status === "queued") todo.status = "deferred";
  }
}

function preserveExternalRunUpdates(state: LoopState, latest: LoopState, activeTodoId: RalphTodo["id"]): void {
  state.runBudget = latest.runBudget;
  state.workerDefaults = latest.workerDefaults;
  const latestTodosById = new Map(latest.todos.map((todo) => [String(todo.id), todo]));
  for (const todo of state.todos) {
    if (String(todo.id) === String(activeTodoId)) continue;
    const latestTodo = latestTodosById.get(String(todo.id));
    if (latestTodo) {
      todo.status = latestTodo.status;
      todo.workerModel = latestTodo.workerModel;
      todo.workerProvider = latestTodo.workerProvider;
      todo.workerContextWindow = latestTodo.workerContextWindow;
    }
  }
}

function resolveEffectiveWorker(todo: RalphTodo, state: LoopState, options: RunOptions): { model?: string; provider?: string; contextWindow?: number } {
  return {
    model: todo.workerModel ?? state.workerDefaults?.model ?? options.workerModel,
    provider: todo.workerProvider ?? state.workerDefaults?.provider,
    contextWindow: todo.workerContextWindow ?? state.workerDefaults?.contextWindow ?? options.workerContextWindow,
  };
}

function assertLoopSafeForTodoInsertion(state: LoopState): void {
  if (state.todos.some((todo) => todo.status === "running") || state.iterations.some((iteration) => iteration.status === "running")) {
    throw new Error(`Cannot insert a loop todo while loop is running: ${state.name}. Pause or wait for the active worker to finish first.`);
  }
}

function assertValidInsertAtIndex(state: LoopState, insertAtIndex: number): void {
  if (!Number.isInteger(insertAtIndex) || insertAtIndex < 0 || insertAtIndex > state.todos.length) {
    throw new Error(`insertAtIndex must be an integer between 0 and ${state.todos.length}.`);
  }

  let seenIncomplete = false;
  let completedPrefixLength = 0;
  for (const todo of state.todos) {
    if (todo.status === "complete") {
      if (seenIncomplete) throw new Error(`Cannot insert loop todo because completed todos in ${state.name} do not form a prefix.`);
      completedPrefixLength += 1;
    } else {
      seenIncomplete = true;
    }
  }

  if (insertAtIndex < completedPrefixLength) {
    throw new Error(`Cannot insert loop todo before completed work. insertAtIndex must be at least ${completedPrefixLength}.`);
  }
}

function prepareRunScope(state: LoopState, max: number): void {
  const queued = state.todos.filter((todo) => todo.status === "queued");
  if (queued.length > max) {
    let kept = 0;
    for (const todo of state.todos) {
      if (todo.status !== "queued") continue;
      kept += 1;
      if (kept > max) todo.status = "deferred";
    }
    return;
  }

  let available = queued.length;
  for (const todo of state.todos) {
    if (available >= max) break;
    if (todo.status === "deferred") {
      todo.status = "queued";
      available += 1;
    }
  }
}

export function deriveLoopStatus(state: LoopState): DerivedLoopStatus {
  if (state.todos.some((todo) => todo.status === "running")) return "running";
  if (state.todos.some((todo) => todo.status === "failed" || todo.status === "interrupted")) return "needs_attention";
  if (state.control === "paused") return "paused";
  if (state.todos.some((todo) => todo.status === "queued" || todo.status === "deferred")) return "ready";
  return "completed";
}

export function renderStatus(state: LoopState): string {
  const completed = state.todos.filter((todo) => todo.status === "complete").length;
  const max = state.maxIterations ? `/${state.maxIterations}` : "";
  const displayStatus = deriveLoopStatus(state);
  const runBudget = state.runBudget ? ` · Run budget ${state.runBudget.remaining}` : "";
  const lines = [
    `${statusIcon(displayStatus)} Subagent Loop · ${state.name}`,
    `Status: ${displayStatus} · Control: ${state.control} · Iteration ${state.currentIteration}${max} · Todos ${completed}/${state.todos.length}${runBudget}`,
    `Branch: ${state.branch}`,
    "",
    ...state.todos.map((todo, index) => {
      const iteration = latestIterationForTodo(state, todo.id);
      const diff = iteration?.diff ? ` · ${formatDiffStats(iteration.diff)}` : "";
      const model = durableModelForTodo(state, todo, iteration);
      const modelText = model ? ` · ${model}` : "";
      return `${index === state.todos.length - 1 ? "└─" : "├─"} ${todoIcon(todo.status)} #${todo.id} ${todo.title}${todo.status === "running" ? " (working)" : ""}${todo.status === "deferred" ? " (deferred)" : ""}${modelText}${diff}`;
    }),
    "",
    "Chat to pause, resume, kill, or steer the loop.",
  ];
  return lines.join("\n");
}

export function renderLoopList(states: LoopState[]): string {
  if (states.length === 0) return "No Subagent Loops found.";
  return states.map((state) => {
    const completed = state.todos.filter((todo) => todo.status === "complete").length;
    const max = state.maxIterations ? `/${state.maxIterations}` : "";
    const displayStatus = deriveLoopStatus(state);
    const runBudget = state.runBudget ? `, budget ${state.runBudget.remaining}` : "";
    return `${statusIcon(displayStatus)} ${state.name}: ${displayStatus} (control ${state.control}, iteration ${state.currentIteration}${max}, ${completed}/${state.todos.length} todos${runBudget})`;
  }).join("\n");
}

function statusIcon(status: DerivedLoopStatus): string {
  return status === "running" ? "◐" : status === "ready" ? "●" : status === "completed" ? "✓" : status === "needs_attention" ? "✗" : "⏸";
}

function latestIterationForTodo(state: LoopState, todoId: RalphTodo["id"]): LoopState["iterations"][number] | undefined {
  for (let index = state.iterations.length - 1; index >= 0; index--) {
    const iteration = state.iterations[index];
    if (String(iteration?.todoId) === String(todoId)) return iteration;
  }
  return undefined;
}

function durableModelForTodo(state: LoopState, todo: RalphTodo, iteration: LoopState["iterations"][number] | undefined): string | undefined {
  return iteration?.observedModel ?? iteration?.configuredModel ?? iteration?.model ?? todo.workerModel ?? state.workerDefaults?.model;
}

function formatDiffStats(diff: { filesChanged: number; insertions: number; deletions: number }): string {
  return `+${diff.insertions} / -${diff.deletions} · ${diff.filesChanged} files`;
}

function todoIcon(status: LoopState["todos"][number]["status"]): string {
  return status === "queued" ? "○" : status === "running" ? "◐" : status === "complete" ? "✓" : status === "deferred" ? "◌" : status === "interrupted" ? "!" : "✗";
}
