import fs from "node:fs/promises";
import path from "node:path";
import { afterRef, beforeRef, GitPolicy, orchestrationBranch } from "./git.js";
import { slugifyLoopName } from "./paths.js";
import { killRalphWorkerProcesses, PiJsonWorkerRunner } from "./pi-json-worker.js";
import { ScriptedMathWorker } from "./scripted-worker.js";
import { RalphStore } from "./store.js";
import type { DerivedLoopStatus, InsertTodoOptions, InsertTodoResult, IterationState, LoopState, RalphTodo, RunOptions, StartOptions, WorkerProgress } from "./types.js";

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
    await this.git.assertCleanWorktree({ ignorePrefixes: [".ralph"] });

    const branch = orchestrationBranch(name);
    await this.git.checkoutBranch(branch);
    const state = await this.store.createLoop(name, options.todos?.length ? options.todos : DEFAULT_TODOS, branch, options.maxIterations);
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

  async pause(name: string): Promise<LoopState> {
    const state = await this.store.readState(slugifyLoopName(name));
    state.control = "paused";
    deferQueuedTodos(state);
    await this.store.writeState(state);
    if (!state.iterations.some((iteration) => iteration.status === "running")) {
      await this.git.addAllAndCommit(`orchestrator: pause ${state.name}`);
    }
    return state;
  }

  async kill(name: string): Promise<{ state: LoopState; killed: number }> {
    const state = await this.store.readState(slugifyLoopName(name));
    const killed = killRalphWorkerProcesses(state.name);
    state.control = "paused";
    const hasWorkerChanges = (await this.git.changedPaths()).some((filePath) => !filePath.startsWith(".ralph/"));
    for (const todo of state.todos) {
      if (todo.status === "running") todo.status = hasWorkerChanges ? "interrupted" : "queued";
    }
    for (const iteration of state.iterations) {
      if (iteration.status === "running") {
        iteration.status = "aborted";
        iteration.completedAt = new Date().toISOString();
        iteration.diff = { filesChanged: hasWorkerChanges ? (await this.git.changedPaths()).filter((filePath) => !filePath.startsWith(".ralph/")).length : 0, insertions: 0, deletions: 0 };
        iteration.verification = {
          status: "failed",
          commands: [{ command: "ralph-kill", exitCode: killed > 0 ? 143 : 0, summary: hasWorkerChanges ? "Worker killed; partial edits may remain" : "Worker killed; no worktree edits detected" }],
          notes: hasWorkerChanges ? "Inspect git status before running Ralph again." : "No non-Ralph worktree edits were detected at kill time.",
        };
      }
    }
    await this.store.writeState(state);
    if (killed === 0) await this.git.addAllAndCommit(`orchestrator: kill ${state.name}`);
    return { state, killed };
  }

  async next(name: string, options: RunOptions = {}): Promise<LoopState> {
    const state = await this.store.readState(slify(name));
    if (state.control === "paused") throw new Error(`Loop is paused: ${state.name}. Use /ralph-run ${state.name} to resume and run queued work.`);
    if (state.todos.some((todo) => todo.status === "failed" || todo.status === "interrupted")) throw new Error(`Loop needs attention before running: ${state.name}`);
    await this.git.assertCleanWorktree({ ignorePrefixes: [".ralph"] });

    const workerMode = options.workerMode ?? "pi-json";
    const worker = workerMode === "scripted" ? new ScriptedMathWorker() : new PiJsonWorkerRunner();
    if (worker instanceof ScriptedMathWorker) await worker.assertCanRun(this.cwd);

    const todo = state.todos.find((item) => item.status === "queued");
    if (!todo) {
      await this.store.writeState(state);
      await this.git.addAllAndCommit(`orchestrator: idle ${state.name}`);
      return state;
    }

    const iterationNumber = state.currentIteration + 1;
    const iteration: IterationState = {
      number: iterationNumber,
      status: "running",
      todoId: todo.id,
      beforeRef: beforeRef(state.name, iterationNumber),
      startedAt: new Date().toISOString(),
    };
    state.currentIteration = iterationNumber;
    state.iterations.push(iteration);
    todo.status = "running";

    await this.git.createRef(iteration.beforeRef);
    await this.store.createIterationFiles(state, iteration, todo);
    await fs.writeFile(path.join(this.store.getIterationDir(state.name, iterationNumber), "git-before.txt"), await this.git.captureStatus(), "utf8");
    await this.store.writeState(state);
    options.onProgress?.({ state, message: `Started Ralph iteration ${iterationNumber}: ${todo.title}` });
    await this.git.addAllAndCommit(`handoff: iteration ${String(iterationNumber).padStart(3, "0")} context`);

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
      workerModel: options.workerModel,
      workerContextWindow: options.workerContextWindow,
      state,
      iteration,
      todo,
    }, forwardWorkerProgress);

    result.changedFiles = result.changedFiles.length > 0 ? result.changedFiles : await this.git.changedPaths();
    iteration.diff = await this.git.diffStats("HEAD", { excludePrefixes: [".ralph"], includeUntracked: true });
    iteration.usage = result.usage;
    iteration.summary = result.summary;
    iteration.changedFiles = result.changedFiles;
    const latest = await this.store.readState(state.name);
    const externallyPaused = latest.control === "paused";
    const killed = /ralph-kill/i.test(result.verification.notes ?? "") || result.verification.commands.some((command) => /ralph-kill/i.test(command.summary));

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
    options.onProgress?.({ state, message: `Finished Ralph iteration ${iterationNumber} with ${result.verification.status}` });
    await this.git.addAllAndCommit(`worker: iteration ${String(iterationNumber).padStart(3, "0")} changes`);
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

  async run(name: string, options: RunOptions = {}): Promise<LoopState> {
    const max = options.maxIterations ?? 1;
    let state = await this.store.readState(slugifyLoopName(name));
    state.control = "active";
    prepareRunScope(state, max);
    await this.store.writeState(state);
    await this.git.addAllAndCommit(`orchestrator: run ${state.name}`);

    for (let i = 0; i < max; i++) {
      state = await this.store.readState(slugifyLoopName(name));
      if (state.control !== "active") break;
      if (!state.todos.some((todo) => todo.status === "queued")) break;
      if (state.todos.some((todo) => todo.status === "failed" || todo.status === "interrupted")) break;
      state = await this.next(name, options);
    }
    return this.store.readState(slugifyLoopName(name));
  }
}

function slify(name: string): string {
  return slugifyLoopName(name);
}

function deferQueuedTodos(state: LoopState): void {
  for (const todo of state.todos) {
    if (todo.status === "queued") todo.status = "deferred";
  }
}

function assertLoopSafeForTodoInsertion(state: LoopState): void {
  if (state.todos.some((todo) => todo.status === "running") || state.iterations.some((iteration) => iteration.status === "running")) {
    throw new Error(`Cannot insert a Ralph todo while loop is running: ${state.name}. Pause or wait for the active worker to finish first.`);
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
      if (seenIncomplete) throw new Error(`Cannot insert Ralph todo because completed todos in ${state.name} do not form a prefix.`);
      completedPrefixLength += 1;
    } else {
      seenIncomplete = true;
    }
  }

  if (insertAtIndex < completedPrefixLength) {
    throw new Error(`Cannot insert Ralph todo before completed work. insertAtIndex must be at least ${completedPrefixLength}.`);
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
  const lines = [
    `${statusIcon(displayStatus)} Ralph Orchestrator · ${state.name}`,
    `Status: ${displayStatus} · Control: ${state.control} · Iteration ${state.currentIteration}${max} · Todos ${completed}/${state.todos.length}`,
    `Branch: ${state.branch}`,
    "",
    ...state.todos.map((todo, index) => {
      const iteration = latestIterationForTodo(state, todo.id);
      const diff = iteration?.diff ? ` · ${formatDiffStats(iteration.diff)}` : "";
      return `${index === state.todos.length - 1 ? "└─" : "├─"} ${todoIcon(todo.status)} #${todo.id} ${todo.title}${todo.status === "running" ? " (working)" : ""}${todo.status === "deferred" ? " (deferred)" : ""}${diff}`;
    }),
    "",
    "Chat to pause, resume, kill or steer the orchestrator.",
  ];
  return lines.join("\n");
}

export function renderLoopList(states: LoopState[]): string {
  if (states.length === 0) return "No Ralph orchestrator loops found.";
  return states.map((state) => {
    const completed = state.todos.filter((todo) => todo.status === "complete").length;
    const max = state.maxIterations ? `/${state.maxIterations}` : "";
    const displayStatus = deriveLoopStatus(state);
    return `${statusIcon(displayStatus)} ${state.name}: ${displayStatus} (control ${state.control}, iteration ${state.currentIteration}${max}, ${completed}/${state.todos.length} todos)`;
  }).join("\n");
}

function statusIcon(status: DerivedLoopStatus): string {
  return status === "running" ? "◐" : status === "ready" ? "●" : status === "completed" ? "✓" : status === "needs_attention" ? "✗" : "⏸";
}

function latestIterationForTodo(state: LoopState, todoId: RalphTodo["id"]): LoopState["iterations"][number] | undefined {
  for (let index = state.iterations.length - 1; index >= 0; index--) {
    const iteration = state.iterations[index];
    if (iteration?.todoId === todoId) return iteration;
  }
  return undefined;
}

function formatDiffStats(diff: { filesChanged: number; insertions: number; deletions: number }): string {
  return `+${diff.insertions} / -${diff.deletions} · ${diff.filesChanged} files`;
}

function todoIcon(status: LoopState["todos"][number]["status"]): string {
  return status === "queued" ? "○" : status === "running" ? "◐" : status === "complete" ? "✓" : status === "deferred" ? "◌" : status === "interrupted" ? "!" : "✗";
}
