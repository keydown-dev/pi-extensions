import fs from "node:fs/promises";
import path from "node:path";
import { handoffCommitMessage, workerCommitMessage } from "./commit-messages.js";
import { afterRef, beforeRef, GitPolicy, orchestrationBranch } from "./git.js";
import { slugifyLoopName } from "./paths.js";
import { killRalphWorkerProcesses, PiJsonWorkerRunner } from "./pi-json-worker.js";
import { ScriptedMathWorker } from "./scripted-worker.js";
import { RalphStore } from "./store.js";
import type { AssignTodoModelOptions, AssignTodoModelResult, DerivedLoopStatus, InsertTodoOptions, InsertTodoResult, InsertTodoSubtaskOptions, IterationState, LoopGitPreferences, LoopState, RalphTodo, RequestHelpOptions, RequestHelpResult, RestartTodoOptions, RestartTodoResult, RunOptions, StartOptions, WorkerProgress } from "./types.js";

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
    const gitPreferences = await this.resolveStartGitPreferences(options);
    if (gitPreferences.requireCleanWorktree) await this.git.assertCleanWorktree({ ignorePrefixes: loopIgnoredPrefixes() });

    const branch = orchestrationBranch(name);
    await this.git.checkoutBranch(branch);
    const workerDefaults = {
      ...(options.defaultWorkerModel ? { model: options.defaultWorkerModel } : {}),
      ...(options.defaultWorkerProvider ? { provider: options.defaultWorkerProvider } : {}),
      ...(options.defaultWorkerContextWindow ? { contextWindow: options.defaultWorkerContextWindow } : {}),
    };
    const state = await this.store.createLoop(name, options.todos?.length ? options.todos : DEFAULT_TODOS, branch, options.maxIterations, workerDefaults, gitPreferences);
    await this.commitIfEnabled(state, `orchestrator: start ${name}`);
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
      await this.commitIfEnabled(nextState, `orchestrator: insert todo ${insertedTodo.id} into ${state.name}`);
    }

    return {
      state: nextState,
      insertedTodo,
      insertAtIndex,
      dryRun: options.dryRun ?? false,
      maxIterationsChange: maxIterationsBefore === undefined ? undefined : { before: maxIterationsBefore, after: maxIterationsBefore + 1 },
    };
  }

  async insertTodoSubtask(options: InsertTodoSubtaskOptions): Promise<InsertTodoResult> {
    const state = await this.store.readState(slugifyLoopName(options.name));
    assertLoopSafeForTodoInsertion(state);
    const title = options.title.trim();
    if (!title) throw new Error("Inserted Ralph todo title cannot be empty.");
    const id = options.id.trim();
    if (!id) throw new Error("Inserted Ralph todo id cannot be empty.");
    if (state.todos.some((todo) => String(todo.id) === id)) throw new Error(`Ralph todo id already exists in ${state.name}: ${id}`);

    const target = state.todos.find((todo) => String(todo.id) === String(options.insertAsSubtask));
    if (!target) throw new Error(`Ralph todo not found in ${state.name}: ${options.insertAsSubtask}`);
    const rootTodoId = target.rootTodoId ?? String(target.id);
    const rootTodo = state.todos.find((todo) => String(todo.id) === rootTodoId);
    if (!rootTodo) throw new Error(`Root Ralph todo not found in ${state.name}: ${rootTodoId}`);
    const insertAtIndex = resolutionSubtaskInsertIndex(state, rootTodoId);
    assertResolutionSubtaskId(id, rootTodoId, nextResolutionSubtaskNumber(state, rootTodoId));

    const maxIterationsBefore = state.maxIterations;
    const now = new Date().toISOString();
    const insertedTodo: RalphTodo = {
      id,
      title,
      status: options.status ?? "queued",
      parentTodoId: rootTodoId,
      rootTodoId,
      subtaskOf: rootTodoId,
      inheritsVerificationFromTodoId: rootTodoId,
      ...(options.instructions?.trim() ? { handoffInstructions: options.instructions.trim() } : {}),
      createdAt: now,
      createdReason: "resolution_subtask",
      ...(options.workerModel ? { workerModel: options.workerModel } : {}),
      ...(options.workerProvider ? { workerProvider: options.workerProvider } : {}),
      ...(options.workerContextWindow ? { workerContextWindow: options.workerContextWindow } : {}),
    };
    const rootWithAudit: RalphTodo = {
      ...rootTodo,
      status: rootTodo.status === "complete" ? rootTodo.status : "interrupted",
      resolutionTodoIds: [...(rootTodo.resolutionTodoIds ?? []), id],
    };
    const nextState: LoopState = {
      ...state,
      control: "active",
      todos: [
        ...state.todos.slice(0, insertAtIndex).map((todo) => (String(todo.id) === rootTodoId ? rootWithAudit : todo)),
        insertedTodo,
        ...state.todos.slice(insertAtIndex).map((todo) => (String(todo.id) === rootTodoId ? rootWithAudit : todo)),
      ],
      maxIterations: state.maxIterations === undefined ? undefined : state.maxIterations + 1,
      iterations: [...state.iterations],
    };
    prepareResolutionRunScope(nextState);

    if (!options.dryRun) {
      await this.store.writeState(nextState);
      await this.commitIfEnabled(nextState, `orchestrator: insert resolution subtask ${insertedTodo.id} into ${state.name}`);
    }

    return {
      state: nextState,
      insertedTodo,
      insertAtIndex,
      dryRun: options.dryRun ?? false,
      maxIterationsChange: maxIterationsBefore === undefined ? undefined : { before: maxIterationsBefore, after: maxIterationsBefore + 1 },
      parentTodo: rootWithAudit,
      rootTodo: rootWithAudit,
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
        await this.commitIfEnabled(nextState, `orchestrator: assign model for ${todo.id} in ${state.name}`);
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
      await this.commitIfEnabled(state, `orchestrator: pause ${state.name}`);
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
    const worktreeDirty = await this.git.isWorktreeDirty({ ignorePrefixes: loopIgnoredPrefixes() });
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
      await this.commitIfEnabled(nextState, `orchestrator: restart ${todo.id} in ${state.name}`);
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


  private async resolveStartGitPreferences(options: StartOptions): Promise<LoopGitPreferences> {
    const existing = await this.store.readProjectConfig();
    const base = existing?.git ?? {
      commitMode: "per_iteration" as const,
      requireCleanWorktree: true,
      commitConvention: await this.git.inferCommitConvention(),
      ignoreWorkerLogs: true,
    };
    return {
      commitMode: options.commitMode ?? base.commitMode,
      requireCleanWorktree: options.requireCleanWorktree ?? base.requireCleanWorktree,
      commitConvention: options.commitConvention?.trim() || base.commitConvention,
      ignoreWorkerLogs: options.ignoreWorkerLogs ?? base.ignoreWorkerLogs,
    };
  }

  private async commitIfEnabled(state: LoopState, message: string): Promise<boolean> {
    if ((state.git?.commitMode ?? "per_iteration") === "manual") return false;
    return this.git.addAllAndCommit(message, { ignoreWorkerLogs: state.git?.ignoreWorkerLogs ?? true });
  }

  async requestHelp(options: RequestHelpOptions): Promise<RequestHelpResult> {
    if (!options.question.trim()) throw new Error("Help request question cannot be empty.");
    const state = options.name ? await this.store.readState(slugifyLoopName(options.name)) : await this.selectRunningStateForHelp();
    const runningTodos = state.todos.filter((todo) => todo.status === "running");
    if (runningTodos.length === 0) throw new Error(`Selected loop has no running todo: ${state.name}`);
    if (runningTodos.length > 1) throw new Error(`Selected loop has multiple running todos: ${state.name}`);
    const runningIterations = state.iterations.filter((iteration) => iteration.status === "running");
    if (runningIterations.length === 0) throw new Error(`Selected loop has no running iteration: ${state.name}`);
    if (runningIterations.length > 1) throw new Error(`Selected loop has multiple running iterations: ${state.name}`);
    const todo = runningTodos[0]!;
    const iteration = runningIterations[0]!;
    if (String(iteration.todoId) !== String(todo.id)) throw new Error(`Running todo and iteration do not match in ${state.name}.`);

    const iterationDir = this.store.getIterationDir(state.name, iteration.number);
    try {
      const stat = await fs.stat(iterationDir);
      if (!stat.isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new Error(`Selected iteration directory cannot be found: ${iterationDir}`);
    }

    const createdAt = new Date().toISOString();
    const id = `help-${String(iteration.number).padStart(3, "0")}`;
    const artifactPath = path.relative(this.cwd, path.join(iterationDir, "help-request.md"));
    const helpRequest = { id, iteration: iteration.number, question: options.question.trim(), artifactPath, createdAt, status: "open" as const };
    const details = { ...options, name: state.name, todoId: todo.id, iteration: iteration.number, id, artifactPath, createdAt, status: "open" as const };

    await fs.writeFile(path.join(iterationDir, "help-request.md"), renderHelpRequestMarkdown(details), "utf8");
    await fs.writeFile(path.join(iterationDir, "help-request.json"), `${JSON.stringify(details, null, 2)}\n`, "utf8");

    state.control = "paused";
    delete state.runBudget;
    todo.status = "interrupted";
    todo.helpRequest = helpRequest;
    iteration.status = "aborted";
    iteration.completedAt = createdAt;
    iteration.summary = "Worker requested help";
    iteration.helpRequest = helpRequest;
    iteration.verification = {
      status: "not_run",
      commands: [{ command: "subagent_loop_request_help", exitCode: 0, summary: "Worker requested help; implementation stopped before verification" }],
      notes: "Loop paused and current todo interrupted until the help request is resolved.",
    };
    await this.store.writeState(state);
    return { state, todo, iteration, helpRequest, markdownPath: artifactPath, jsonPath: path.relative(this.cwd, path.join(iterationDir, "help-request.json")) };
  }

  private async selectRunningStateForHelp(): Promise<LoopState> {
    const running = (await this.store.listStates()).filter((state) => state.todos.some((todo) => todo.status === "running") || state.iterations.some((iteration) => iteration.status === "running"));
    if (running.length === 0) throw new Error("No running Subagent Loop exists for a help request.");
    if (running.length > 1) throw new Error(`Multiple running Subagent Loops exist; pass name. Candidates: ${running.map((state) => state.name).join(", ")}`);
    return running[0]!;
  }

  async kill(name: string): Promise<{ state: LoopState; killed: number }> {
    const state = await this.store.readState(slugifyLoopName(name));
    const killed = killRalphWorkerProcesses(state.name);
    state.control = "paused";
    const hasWorkerChanges = (await this.git.changedPaths()).some((filePath) => !isLoopInternalPath(filePath));
    for (const todo of state.todos) {
      if (todo.status === "running") todo.status = hasWorkerChanges ? "interrupted" : "queued";
    }
    for (const iteration of state.iterations) {
      if (iteration.status === "running") {
        iteration.status = "aborted";
        iteration.completedAt = new Date().toISOString();
        iteration.diff = { filesChanged: hasWorkerChanges ? (await this.git.changedPaths()).filter((filePath) => !isLoopInternalPath(filePath)).length : 0, insertions: 0, deletions: 0 };
        iteration.verification = {
          status: "failed",
          commands: [{ command: "loop-kill", exitCode: killed > 0 ? 143 : 0, summary: hasWorkerChanges ? "Worker killed; partial edits may remain" : "Worker killed; no worktree edits detected" }],
          notes: hasWorkerChanges ? "Inspect git status before running the loop again." : "No non-loop worktree edits were detected at kill time.",
        };
      }
    }
    await this.store.writeState(state);
    if (killed === 0) await this.commitIfEnabled(state, `orchestrator: kill ${state.name}`);
    return { state, killed };
  }

  async next(name: string, options: RunOptions = {}): Promise<LoopState> {
    const state = await this.store.readState(slify(name));
    if (state.control === "paused") throw new Error(`Loop is paused: ${state.name}. Use /loop-run ${state.name} to resume and run queued work.`);
    if (loopNeedsAttentionForRun(state)) throw new Error(`Loop needs attention before running: ${state.name}`);
    prepareResolutionRunScope(state);
    if (state.git?.requireCleanWorktree ?? true) await this.git.assertCleanWorktree({ ignorePrefixes: loopIgnoredPrefixes() });

    const workerMode = options.workerMode ?? "pi-json";
    const worker = workerMode === "scripted" ? new ScriptedMathWorker() : new PiJsonWorkerRunner();
    if (worker instanceof ScriptedMathWorker) await worker.assertCanRun(this.cwd);

    const todo = state.todos.find((item) => item.status === "queued");
    if (!todo) {
      await this.store.writeState(state);
      await this.commitIfEnabled(state, `orchestrator: idle ${state.name}`);
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
    await this.commitIfEnabled(state, handoffCommitMessage(todo.id, iterationNumber));

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
    iteration.diff = await this.git.diffStats("HEAD", { excludePrefixes: loopIgnoredPrefixes(), includeUntracked: true });
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
    const latestTodo = latest.todos.find((item) => String(item.id) === String(todo.id));
    const latestIteration = latest.iterations.find((item) => item.number === iteration.number);
    const externalHelpRequest = latestTodo?.helpRequest ?? latestIteration?.helpRequest;
    preserveExternalRunUpdates(state, latest, todo.id);
    const externallyPaused = latest.control === "paused";
    const killed = /(?:ralph-kill|loop kill|loop-kill)/i.test(result.verification.notes ?? "") || result.verification.commands.some((command) => /(?:ralph-kill|loop kill|loop-kill)/i.test(command.summary));

    iteration.verification = result.verification;
    iteration.afterRef = afterRef(state.name, iterationNumber);
    iteration.completedAt = new Date().toISOString();

    if (externalHelpRequest) {
      iteration.status = "aborted";
      iteration.summary = latestIteration?.summary ?? "Worker requested help";
      iteration.helpRequest = externalHelpRequest;
      todo.status = "interrupted";
      todo.helpRequest = externalHelpRequest;
      state.control = "paused";
      deferQueuedTodos(state);
    } else if (killed) {
      const changed = (iteration.diff?.filesChanged ?? 0) > 0;
      iteration.status = "aborted";
      todo.status = changed ? "interrupted" : "queued";
      state.control = "paused";
    } else {
      iteration.status = result.verification.status === "passed" ? "accepted" : "failed";
      todo.status = result.verification.status === "passed" ? "complete" : "failed";
      if (result.verification.status === "passed") resolveChainIfResolutionSubtask(state, todo);
      state.control = externallyPaused ? "paused" : "active";
      if (externallyPaused) deferQueuedTodos(state);
    }

    await this.store.writeWorkerArtifacts(state, iteration, result);
    await fs.writeFile(path.join(this.store.getIterationDir(state.name, iterationNumber), "git-after.txt"), await this.git.captureStatus(), "utf8");
    await this.store.writeState(state);
    options.onProgress?.({ state, message: `Finished loop iteration ${iterationNumber} with ${result.verification.status}` });
    await this.commitIfEnabled(state, workerCommitMessage(todo.id, iterationNumber, result.commitSubject));
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
    if (loopNeedsAttentionForRun(state)) throw new Error(`Loop needs attention before running: ${state.name}`);
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
    if (loopNeedsAttentionForRun(state)) throw new Error(`Loop needs attention before running: ${state.name}`);
    state.control = "active";
    state.runBudget = { remaining: max, updatedAt: new Date().toISOString(), updatedBy: "orchestrator" };
    prepareRunScope(state, max);
    await this.store.writeState(state);
    await this.commitIfEnabled(state, `orchestrator: run ${state.name}`);

    while (true) {
      state = await this.store.readState(slugifyLoopName(name));
      if (state.control !== "active") break;
      if (loopNeedsAttentionForRun(state)) break;
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


function renderHelpRequestMarkdown(details: RequestHelpOptions & { name: string; todoId: RalphTodo["id"]; iteration: number; id: string; artifactPath: string; createdAt: string; status: "open" }): string {
  const lines = [
    `# Help request ${details.id}`,
    "",
    `Loop: ${details.name}`,
    `Iteration: ${details.iteration}`,
    `Todo: ${details.todoId}`,
    `Status: ${details.status}`,
    `Created: ${details.createdAt}`,
    "",
    "## Question",
    "",
    details.question,
  ];
  appendOptionalSection(lines, "Context", details.context);
  appendOptionalSection(lines, "Blocking reason", details.blockingReason);
  appendListSection(lines, "Attempted approaches", details.attemptedApproaches);
  appendListSection(lines, "Options", details.options);
  appendOptionalSection(lines, "Recommendation", details.recommendation);
  appendOptionalSection(lines, "Risk if guessed", details.riskIfGuessed);
  appendListSection(lines, "Needed by", details.neededBy);
  lines.push("");
  return lines.join("\n");
}

function appendOptionalSection(lines: string[], title: string, value: string | undefined): void {
  if (!value) return;
  lines.push("", `## ${title}`, "", value);
}

function appendListSection(lines: string[], title: string, values: string[] | undefined): void {
  if (!values?.length) return;
  lines.push("", `## ${title}`, "", ...values.map((value) => `- ${value}`));
}

function slify(name: string): string {
  return slugifyLoopName(name);
}

function loopIgnoredPrefixes(): string[] {
  return [".loop", ".loops"];
}

function isLoopInternalPath(filePath: string): boolean {
  return filePath === ".loop" || filePath === ".loops" || filePath.startsWith(".loop/") || filePath.startsWith(".loops/");
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
  const rootTodoId = String(todoId);
  const legacyPrefix = `${rootTodoId}.`;
  return state.todos.some((todo) => (todo.createdReason === "resolution_subtask" && String(todo.rootTodoId) === rootTodoId) || String(todo.id).startsWith(legacyPrefix));
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
      todo.resolutionTodoIds = latestTodo.resolutionTodoIds;
      todo.resolvedByTodoId = latestTodo.resolvedByTodoId;
      todo.resolvedAt = latestTodo.resolvedAt;
      todo.resolutionReason = latestTodo.resolutionReason;
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

function resolutionSubtaskInsertIndex(state: LoopState, rootTodoId: string): number {
  const rootIndex = state.todos.findIndex((todo) => String(todo.id) === rootTodoId);
  if (rootIndex === -1) throw new Error(`Root Ralph todo not found: ${rootTodoId}`);
  let index = rootIndex + 1;
  while (index < state.todos.length && state.todos[index]?.createdReason === "resolution_subtask" && String(state.todos[index]?.rootTodoId) === rootTodoId) index += 1;
  return index;
}

function nextResolutionSubtaskNumber(state: LoopState, rootTodoId: string): number {
  return state.todos.filter((todo) => todo.createdReason === "resolution_subtask" && String(todo.rootTodoId) === rootTodoId).length + 1;
}

function rootIdPrefix(rootTodoId: string): string {
  return rootTodoId.match(/^(\d+)/)?.[1] ?? rootTodoId;
}

function assertResolutionSubtaskId(id: string, rootTodoId: string, expectedNumber: number): void {
  const expectedPrefix = `${rootIdPrefix(rootTodoId)}.${expectedNumber}-`;
  if (!id.startsWith(expectedPrefix)) throw new Error(`Resolution subtask id should start with ${expectedPrefix}`);
}

function unresolvedInterruptedTodos(state: LoopState): RalphTodo[] {
  return state.todos.filter((todo) => todo.status === "interrupted" && !todo.resolvedByTodoId);
}

function pendingResolutionSubtasks(state: LoopState, rootTodoId: string): RalphTodo[] {
  return state.todos.filter((todo) => todo.createdReason === "resolution_subtask" && String(todo.rootTodoId) === rootTodoId && (todo.status === "queued" || todo.status === "deferred" || todo.status === "running"));
}

function hasRunnableResolutionChain(state: LoopState): boolean {
  return unresolvedInterruptedTodos(state).some((todo) => pendingResolutionSubtasks(state, String(todo.rootTodoId ?? todo.id)).length > 0);
}

function loopNeedsAttentionForRun(state: LoopState): boolean {
  if (state.todos.some((todo) => todo.status === "failed" && todo.createdReason !== "resolution_subtask")) return true;
  const interrupted = unresolvedInterruptedTodos(state);
  if (interrupted.length === 0) return false;
  return !hasRunnableResolutionChain(state);
}

function earliestRunnableResolutionRoot(state: LoopState): string | undefined {
  for (const todo of state.todos) {
    if (todo.status !== "interrupted") continue;
    const rootTodoId = String(todo.rootTodoId ?? todo.id);
    if (pendingResolutionSubtasks(state, rootTodoId).length > 0) return rootTodoId;
  }
  return undefined;
}

function prepareResolutionRunScope(state: LoopState): boolean {
  const rootTodoId = earliestRunnableResolutionRoot(state);
  if (!rootTodoId) return false;
  let queuedOne = false;
  for (const todo of state.todos) {
    if (todo.createdReason !== "resolution_subtask") {
      if (todo.status === "queued") todo.status = "deferred";
      continue;
    }
    if (String(todo.rootTodoId) === rootTodoId && !queuedOne && (todo.status === "queued" || todo.status === "deferred")) {
      todo.status = "queued";
      queuedOne = true;
    } else if (todo.status === "queued") {
      todo.status = "deferred";
    }
  }
  return true;
}

function resolveChainIfResolutionSubtask(state: LoopState, todo: RalphTodo): void {
  if (todo.createdReason !== "resolution_subtask" || !todo.rootTodoId) return;
  const rootTodoId = String(todo.rootTodoId);
  const resolvedAt = new Date().toISOString();
  for (const item of state.todos) {
    const inChain = String(item.id) === rootTodoId || (item.createdReason === "resolution_subtask" && String(item.rootTodoId) === rootTodoId);
    if (!inChain) continue;
    if (item.status === "interrupted" || String(item.id) === String(todo.id)) item.status = "complete";
    if (String(item.id) !== String(todo.id)) {
      item.resolvedByTodoId = String(todo.id);
      item.resolvedAt = resolvedAt;
      item.resolutionReason = "Resolved by subtask after clarification";
    }
  }
}

function prepareRunScope(state: LoopState, max: number): void {
  if (prepareResolutionRunScope(state)) return;
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
  if (state.todos.some((todo) => todo.status === "failed" && todo.createdReason !== "resolution_subtask")) return "needs_attention";
  if (state.todos.some((todo) => todo.status === "interrupted") && !hasRunnableResolutionChain(state)) return "needs_attention";
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
      const helpText = todo.helpRequest ? ` · help: ${todo.helpRequest.question} (${todo.helpRequest.artifactPath})` : "";
      return `${index === state.todos.length - 1 ? "└─" : "├─"} ${todoIcon(todo.status)} #${todo.id} ${todo.title}${todo.status === "running" ? " (working)" : ""}${todo.status === "deferred" ? " (deferred)" : ""}${modelText}${diff}${helpText}`;
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
