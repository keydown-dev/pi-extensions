import fs from "node:fs/promises";
import path from "node:path";
import { afterRef, beforeRef, GitPolicy, orchestrationBranch } from "./git.js";
import { slugifyLoopName } from "./paths.js";
import { PiJsonWorkerRunner } from "./pi-json-worker.js";
import { ScriptedMathWorker } from "./scripted-worker.js";
import { RalphStore } from "./store.js";
import type { IterationState, LoopState, RunOptions, StartOptions, WorkerProgress } from "./types.js";

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

  async stop(name: string): Promise<LoopState> {
    const state = await this.store.readState(slugifyLoopName(name));
    if (state.status === "completed") return state;
    state.status = "stopped";
    await this.store.writeState(state);
    await this.git.addAllAndCommit(`orchestrator: stop ${state.name}`);
    return state;
  }

  async resume(name: string): Promise<LoopState> {
    const state = await this.store.readState(slugifyLoopName(name));
    if (state.status === "completed") throw new Error(`Loop is completed: ${state.name}`);
    state.status = "ready";
    await this.store.writeState(state);
    await this.git.addAllAndCommit(`orchestrator: resume ${state.name}`);
    return state;
  }

  async next(name: string, options: RunOptions = {}): Promise<LoopState> {
    const state = await this.store.readState(slugifyLoopName(name));
    if (state.status !== "ready" && state.status !== "running") throw new Error(`Loop is not ready to run: ${state.status}`);
    await this.git.assertCleanWorktree({ ignorePrefixes: [".ralph"] });

    const workerMode = options.workerMode ?? "pi-json";
    const worker = workerMode === "scripted" ? new ScriptedMathWorker() : new PiJsonWorkerRunner();
    if (worker instanceof ScriptedMathWorker) await worker.assertCanRun(this.cwd);

    const todo = state.todos.find((item) => item.status === "pending");
    if (!todo) {
      state.status = "completed";
      await this.store.writeState(state);
      await this.git.addAllAndCommit(`orchestrator: complete ${state.name}`);
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
    state.status = "running";
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
      options.onProgress?.({ state, worker: progress, message: `Worker ${progress.phase} for iteration ${iterationNumber}: ${todo.title}` });
    };

    const result = await worker.runIteration({
      cwd: this.cwd,
      loopDir: this.store.getLoopDir(state.name),
      iterationDir: this.store.getIterationDir(state.name, iterationNumber),
      packageRoot: this.packageRoot,
      workerModel: options.workerModel,
      state,
      iteration,
      todo,
    }, forwardWorkerProgress);

    result.changedFiles = result.changedFiles.length > 0 ? result.changedFiles : await this.git.changedPaths();
    iteration.diff = await this.git.diffStats("HEAD", { excludePrefixes: [".ralph"], includeUntracked: true, includePaths: result.changedFiles });

    iteration.verification = result.verification;
    iteration.status = result.verification.status === "passed" ? "accepted" : "failed";
    iteration.afterRef = afterRef(state.name, iterationNumber);
    iteration.completedAt = new Date().toISOString();
    todo.status = result.verification.status === "passed" ? "completed" : "failed";
    state.status = result.verification.status === "passed" ? "ready" : "failed";

    await this.store.writeWorkerArtifacts(state, iteration, result);
    await fs.writeFile(path.join(this.store.getIterationDir(state.name, iterationNumber), "git-after.txt"), await this.git.captureStatus(), "utf8");
    await this.store.writeState(state);
    options.onProgress?.({ state, message: `Finished Ralph iteration ${iterationNumber} with ${result.verification.status}` });
    await this.git.addAllAndCommit(`worker: iteration ${String(iterationNumber).padStart(3, "0")} changes`);
    await this.git.createRef(iteration.afterRef);

    return state;
  }

  async run(name: string, options: RunOptions = {}): Promise<LoopState> {
    const max = options.maxIterations ?? 1;
    let state = await this.store.readState(slugifyLoopName(name));
    for (let i = 0; i < max && (state.status === "ready" || state.status === "running"); i++) {
      state = await this.next(name, options);
    }
    if (state.status === "ready" && state.todos.every((todo) => todo.status === "completed")) {
      state.status = "completed";
      await this.store.writeState(state);
      await this.git.addAllAndCommit(`orchestrator: complete ${state.name}`);
    }
    return state;
  }
}

export function renderStatus(state: LoopState): string {
  const completed = state.todos.filter((todo) => todo.status === "completed").length;
  const max = state.maxIterations ? `/${state.maxIterations}` : "";
  const lines = [
    `${statusIcon(state.status)} Ralph Orchestrator · ${state.name}`,
    `Status: ${state.status} · Iteration ${state.currentIteration}${max} · Todos ${completed}/${state.todos.length}`,
    `Branch: ${state.branch}`,
    "",
    ...state.todos.map((todo, index) => {
      const iteration = latestIterationForTodo(state, todo.id);
      const diff = iteration?.diff ? ` · ${formatDiffStats(iteration.diff)}` : "";
      return `${index === state.todos.length - 1 ? "└─" : "├─"} ${todoIcon(todo.status)} #${todo.id} ${todo.title}${todo.status === "running" ? " (working)" : ""}${diff}`;
    }),
    "",
    "ESC pauses the assistant; /ralph stop <name> stops the loop.",
  ];
  return lines.join("\n");
}

export function renderLoopList(states: LoopState[]): string {
  if (states.length === 0) return "No Ralph orchestrator loops found.";
  return states.map((state) => {
    const completed = state.todos.filter((todo) => todo.status === "completed").length;
    const max = state.maxIterations ? `/${state.maxIterations}` : "";
    return `${statusIcon(state.status)} ${state.name}: ${state.status} (iteration ${state.currentIteration}${max}, ${completed}/${state.todos.length} todos)`;
  }).join("\n");
}

function statusIcon(status: LoopState["status"]): string {
  return status === "running" ? "◐" : status === "ready" ? "●" : status === "completed" ? "✓" : status === "failed" ? "✗" : status === "awaiting_acceptance" ? "◐" : "○";
}

function latestIterationForTodo(state: LoopState, todoId: number): LoopState["iterations"][number] | undefined {
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
  return status === "pending" ? "○" : status === "running" ? "◐" : status === "completed" ? "✓" : "✗";
}
