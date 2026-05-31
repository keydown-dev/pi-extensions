import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deriveLoopStatus, RalphOrchestrator, renderLoopList, renderStatus } from "../src/orchestrator.js";
import { slugifyLoopName } from "../src/paths.js";
import type { InsertTodoResult, IterationCompleteEvent, LoopState, OrchestratorProgress, WorkerMode, WorkerProgress, WorkerUsage } from "../src/types.js";

let currentLoop: string | null = null;
type RalphWidgetMode = "compact" | "expanded" | "hidden";
let ralphWidgetMode: RalphWidgetMode = "compact";
let latestWidgetState: LoopState | null = null;
let latestWidgetWorker: WorkerProgress | undefined;
let lastHiddenWidgetSignature: string | null = null;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const activeJobs = new Map<string, Promise<void>>();

export default function (pi: ExtensionAPI) {
  function setCurrent(ctx: ExtensionContext, state: LoopState | null): void {
    currentLoop = state?.name ?? null;
    if (state && deriveLoopStatus(state) !== "completed" && ralphWidgetMode === "hidden") ralphWidgetMode = "compact";
    updateUI(ctx, state);
  }

  function updateUI(ctx: ExtensionContext, state?: LoopState | null, worker?: WorkerProgress): void {
    latestWidgetState = state ?? null;
    latestWidgetWorker = worker;
    if (state && ralphWidgetMode === "hidden") {
      const signature = widgetStateSignature(state);
      if (lastHiddenWidgetSignature && signature !== lastHiddenWidgetSignature) {
        ralphWidgetMode = "compact";
        lastHiddenWidgetSignature = null;
      } else {
        lastHiddenWidgetSignature = signature;
      }
    }
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("ralph", undefined);
    if (!state || ralphWidgetMode === "hidden") {
      ctx.ui.setWidget("ralph", undefined);
      return;
    }
    const visibleMode = ralphWidgetMode;
    ctx.ui.setWidget("ralph", (tui, widgetTheme) => {
      const interval = state.todos.some((todo) => todo.status === "running") ? setInterval(() => tui.requestRender(), PI_WORKING_SPINNER_INTERVAL_MS) : undefined;
      return {
        render: (width: number) => renderRalphWidget(state, worker, widgetTheme, width, visibleMode),
        invalidate: () => {},
        dispose: () => {
          if (interval) clearInterval(interval);
        },
      };
    });
  }

  function commandProgress(ctx: ExtensionContext): (progress: OrchestratorProgress) => void {
    return (progress) => {
      currentLoop = progress.state.name;
      updateUI(ctx, progress.state, progress.worker);
    };
  }

  async function setWidgetMode(ctx: ExtensionContext, mode: RalphWidgetMode): Promise<void> {
    if (mode !== "hidden" && !(await ensureNonCompleteLoopForWidget(ctx))) return;
    ralphWidgetMode = mode;
    lastHiddenWidgetSignature = mode === "hidden" && latestWidgetState ? widgetStateSignature(latestWidgetState) : null;
    updateUI(ctx, latestWidgetState, latestWidgetWorker);
    ctx.ui.notify(`Subagent Loop widget ${mode}`, "info");
  }

  async function densityToggleWidget(ctx: ExtensionContext): Promise<void> {
    if (!(await ensureNonCompleteLoopForWidget(ctx))) return;
    await setWidgetMode(ctx, ralphWidgetMode === "expanded" ? "compact" : "expanded");
  }

  async function ensureNonCompleteLoopForWidget(ctx: ExtensionContext): Promise<boolean> {
    if (latestWidgetState && deriveLoopStatus(latestWidgetState) !== "completed") return true;
    const states = await new RalphOrchestrator(ctx.cwd, packageRoot).list();
    const active = states.find((state) => deriveLoopStatus(state) === "running") ?? states.find((state) => deriveLoopStatus(state) === "ready") ?? states.find((state) => deriveLoopStatus(state) === "needs_attention") ?? states.find((state) => deriveLoopStatus(state) === "paused") ?? null;
    if (active) {
      currentLoop = active.name;
      latestWidgetState = active;
      return true;
    }
    ctx.ui.notify(`No non-complete Subagent Loop detected. Available loops:\n${renderLoopList(states)}`, "info");
    updateUI(ctx, null);
    return false;
  }

  async function toggleWidget(args: string, ctx: ExtensionContext): Promise<void> {
    const mode = splitArgs(args)[0]?.toLowerCase();
    if (mode === "show" || mode === "on") return setWidgetMode(ctx, "expanded");
    if (mode === "hide" || mode === "off") return setWidgetMode(ctx, "hidden");
    if (mode === "compact" || mode === "collapse" || mode === "collapsed") return setWidgetMode(ctx, "compact");
    if (mode === "expanded" || mode === "expand" || mode === "full") return setWidgetMode(ctx, "expanded");
    if (mode && mode !== "toggle") throw new Error("Usage: /loop-widget [toggle|compact|expand|show|hide]");
    return densityToggleWidget(ctx);
  }

  function postIterationSummary(event: IterationCompleteEvent): void {
    pi.sendMessage({
      customType: "ralph-iteration-summary",
      content: renderIterationSummary(event),
      display: true,
      details: {
        loop: event.state.name,
        iteration: event.iteration.number,
        todoId: event.todo.id,
        verification: event.result.verification.status,
      },
    });
  }

  async function startLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const argv = splitArgs(args);
    const name = argv.shift();
    if (!name) throw new Error("Usage: /loop-start <name> [--max N] [--todo item ...]");
    const defaultWorkerModel = parseModel(argv);
    const state = await new RalphOrchestrator(ctx.cwd, packageRoot).start({ name, todos: parseTodos(argv), maxIterations: parseMax(argv), defaultWorkerModel, defaultWorkerContextWindow: resolveWorkerContextWindow(ctx, defaultWorkerModel) });
    setCurrent(ctx, state);
    ctx.ui.notify(`Prepared Subagent Loop loop: ${state.name}. Use /loop-run ${state.name} to run queued work.`, "info");
  }

  async function pauseLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const name = splitArgs(args).shift() ?? currentLoop;
    if (!name) throw new Error("Usage: /loop-pause [name]");
    const state = await new RalphOrchestrator(ctx.cwd, packageRoot).pause(name);
    updateUI(ctx, state);
    ctx.ui.notify(activeJobs.has(state.name) ? `Paused Subagent Loop after the current worker exits: ${state.name}` : `Paused Subagent Loop: ${state.name}`, "info");
  }

  async function killLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const name = splitArgs(args).shift() ?? currentLoop;
    if (!name) throw new Error("Usage: /loop-kill [name]");
    const { state, killed } = await new RalphOrchestrator(ctx.cwd, packageRoot).kill(name);
    updateUI(ctx, state);
    ctx.ui.notify(`Killed ${killed} Subagent Loop worker process${killed === 1 ? "" : "es"} for ${state.name}. Inspect status and git status before running again.`, killed > 0 ? "warning" : "info");
  }

  async function showStatus(args: string, ctx: ExtensionContext): Promise<void> {
    const name = splitArgs(args).shift();
    const orchestrator = new RalphOrchestrator(ctx.cwd, packageRoot);
    if (name) {
      const state = await orchestrator.status(name);
      updateUI(ctx, state);
      ctx.ui.notify(renderStatus(state), "info");
      return;
    }
    const states = await orchestrator.list();
    const active = currentLoop ? states.find((state) => state.name === currentLoop) : states.find((state) => deriveLoopStatus(state) === "running") ?? states.find((state) => deriveLoopStatus(state) === "ready");
    if (active) updateUI(ctx, active);
    ctx.ui.notify(`Subagent Loop status:\n${active ? renderStatus(active) : renderLoopList(states)}`, "info");
  }

  async function showList(_args: string, ctx: ExtensionContext): Promise<void> {
    const states = await new RalphOrchestrator(ctx.cwd, packageRoot).list();
    ctx.ui.notify(`Subagent Loops:\n${renderLoopList(states)}`, "info");
    const active = states.find((state) => deriveLoopStatus(state) === "running") ?? states.find((state) => deriveLoopStatus(state) === "ready");
    if (active) setCurrent(ctx, active);
  }

  async function assignTodoModel(args: string, ctx: ExtensionContext): Promise<void> {
    const argv = splitArgs(args);
    const name = argv.shift() ?? currentLoop;
    const todoId = argv.shift();
    const model = parseModel(argv) ?? argv.shift();
    if (!name || !todoId) throw new Error("Usage: /loop-assign-model <loop> <todo-id> [--model MODEL]");
    const clear = !model || model === "--clear" || model === "clear";
    const result = await new RalphOrchestrator(ctx.cwd, packageRoot).assignTodoModel({ name, todoId, model: clear ? null : model, contextWindow: clear ? null : resolveWorkerContextWindow(ctx, model) });
    updateUI(ctx, result.state);
    ctx.ui.notify(`${result.cleared ? "Cleared" : "Assigned"} worker model for #${result.todo.id}${result.todo.workerModel ? `: ${result.todo.workerModel}` : ""}.`, "info");
  }

  async function runLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const argv = splitArgs(args);
    const name = argv.shift() ?? currentLoop;
    if (!name) throw new Error("Usage: /loop-run [name] [--max N] [--runner pi-json] [--model MODEL]");
    const loopName = slugifyLoopName(name);
    const maxIterations = parseMax(argv) ?? 1;
    startBackgroundLoop(ctx, loopName, `Subagent Loop run for ${loopName}`, async () => {
      const workerModel = parseModel(argv);
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).run(loopName, { maxIterations, workerMode: parseRunner(argv), workerModel, workerContextWindow: resolveWorkerContextWindow(ctx, workerModel), onProgress: commandProgress(ctx), onIterationComplete: postIterationSummary });
      return { state, message: `Subagent Loop run stopped at ${state.currentIteration} (${deriveLoopStatus(state)})` };
    }, async () => {
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).extendRun(loopName, maxIterations, "command");
      updateUI(ctx, state);
      return state;
    }, maxIterations);
  }

  function startBackgroundLoop(ctx: ExtensionContext, name: string, label: string, execute: () => Promise<{ state: LoopState; message: string }>, extendActive?: () => Promise<LoopState>, extensionCount = 1): void {
    if (activeJobs.has(name)) {
      if (!extendActive) {
        ctx.ui.notify(`Subagent Loop is already running: ${name}`, "warning");
        return;
      }
      void extendActive()
        .then((state) => ctx.ui.notify(`Queued ${extensionCount} additional loop iteration${extensionCount === 1 ? "" : "s"} for ${state.name}.`, "info"))
        .catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
      return;
    }
    currentLoop = name;
    const job = execute()
      .then(({ state, message }) => {
        setCurrent(ctx, state);
        ctx.ui.notify(message, "info");
      })
      .catch((error) => {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      })
      .finally(() => {
        activeJobs.delete(name);
      });
    activeJobs.set(name, job);
    ctx.ui.notify(`${label} started in the background. You can keep chatting; progress will update in the Subagent Loop widget.`, "info");
  }

  pi.registerCommand("loop-start", command("Start a Subagent Loop loop", startLoop));
  pi.registerCommand("loop-pause", command("Pause active Subagent Loop loop", pauseLoop));
  pi.registerCommand("loop-kill", command("Kill active Subagent Loop worker process and pause the loop", killLoop));
  pi.registerCommand("loop-status", command("Show current or named Subagent Loop status", showStatus));
  pi.registerCommand("loop-list", command("List Subagent Loop loops", showList));
  pi.registerCommand("loop-run", command("Run one or more Subagent Loop worker iterations", runLoop));
  pi.registerCommand("loop-assign-model", command("Assign a worker model to a future loop todo", assignTodoModel));
  pi.registerCommand("loop-widget", {
    description: "Set Subagent Loop widget mode (compact, expand, show, or hide)",
    handler: async (args, ctx) => {
      try {
        await toggleWidget(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
  pi.registerShortcut("ctrl+alt+r", {
    description: "Expand/contract the Subagent Loop widget",
    handler: async (ctx) => densityToggleWidget(ctx),
  });

  pi.registerCommand("loop-plan", {
    description: "Plan a Subagent Loop through a grilling/planning interview before starting",
    handler: async (args, ctx) => {
      const prompt = buildPlanPrompt(args.trim());
      ctx.ui.notify("Starting Subagent Loop planning interview. The agent should grill, plan, and ask for approval before starting a loop.", "info");
      pi.sendUserMessage(prompt);
    },
  });

  pi.registerCommand("ralph", {
    description: "Subagent Loop - fresh-context development loops",
    handler: async (args, ctx) => {
      const argv = splitArgs(args ?? "");
      const subcommand = argv.shift();
      try {
        if (subcommand === "start") return startLoop(argv.join(" "), ctx);
        if (subcommand === "plan") {
          pi.sendUserMessage(buildPlanPrompt(argv.join(" ")));
          return;
        }
        if (subcommand === "run") return runLoop(argv.join(" "), ctx);
        if (subcommand === "assign-model") return assignTodoModel(argv.join(" "), ctx);
        if (subcommand === "pause") return pauseLoop(argv.join(" "), ctx);
        if (subcommand === "kill") return killLoop(argv.join(" "), ctx);
        if (subcommand === "status") return showStatus(argv.join(" "), ctx);
        if (subcommand === "list") return showList(argv.join(" "), ctx);
        if (subcommand === "widget") return toggleWidget(argv.join(" "), ctx);
        ctx.ui.notify(HELP, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "subagent_loop_plan",
    label: "Plan Subagent Loop",
    description: "Start a Subagent Loop planning interview before creating a loop.",
    promptSnippet: "Plan a Subagent Loop by grilling requirements before calling subagent_loop_start.",
    parameters: Type.Object({ request: Type.String({ description: "The user's planning request or goal" }) }),
    async execute(_toolCallId, params) {
      pi.sendUserMessage(buildPlanPrompt(params.request), { deliverAs: "followUp" });
      return { content: [{ type: "text", text: "Queued a Subagent Loop planning interview." }], details: {} };
    },
  });

  pi.registerTool({
    name: "subagent_loop_start",
    label: "Start Subagent Loop",
    description: "Create a Subagent Loop loop from a natural-language task.",
    promptSnippet: "Create a Subagent Loop loop with a plan, todo list, and max-iteration setting.",
    parameters: Type.Object({
      name: Type.String({ description: "Short loop name" }),
      taskContent: Type.String({ description: "Markdown plan with goals, checklist, notes, and verification expectations" }),
      maxIterations: Type.Optional(Type.Number({ description: "Maximum number of tasks in the initial run scope" })),
      defaultWorkerModel: Type.Optional(Type.String({ description: "Loop-level default Pi model pattern/ID for child workers." })),
      todos: Type.Optional(Type.Array(Type.String(), { description: "Concrete checklist items extracted from taskContent" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const todos = params.todos?.length ? params.todos : extractTodos(params.taskContent);
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).start({ name: params.name, todos, maxIterations: params.maxIterations, defaultWorkerModel: params.defaultWorkerModel, defaultWorkerContextWindow: resolveWorkerContextWindow(ctx, params.defaultWorkerModel) });
      setCurrent(ctx, state);
      return { content: [{ type: "text", text: renderToolResponse(state, `Created Subagent Loop loop "${state.name}" with ${state.todos.length} todos.`) }], details: { state, nextAction: nextActionForState(state) } };
    },
  });

  pi.registerTool({
    name: "subagent_loop_run",
    label: "Run Subagent Loop",
    description: "Run one or more worker iterations for a Subagent Loop loop. Running a paused loop resumes it.",
    promptSnippet: "Run a Subagent Loop for a bounded number of iterations, then inspect status and artifacts.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })),
      maxIterations: Type.Optional(Type.Number({ description: "Maximum number of worker iterations to run in this call." })),
      runner: Type.Optional(Type.String({ description: "Worker runner: pi-json (default) or scripted." })),
      model: Type.Optional(Type.String({ description: "Pi model pattern/ID for the child worker." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Subagent Loop name provided and no active loop is set.");
      const loopName = slugifyLoopName(name);
      currentLoop = loopName;
      const maxIterations = params.maxIterations ?? 1;
      if (activeJobs.has(loopName)) {
        const state = await new RalphOrchestrator(ctx.cwd, packageRoot).extendRun(loopName, maxIterations, "tool");
        updateUI(ctx, state);
        return { content: [{ type: "text", text: `Queued ${maxIterations} additional loop iteration${maxIterations === 1 ? "" : "s"} for "${state.name}".` }], details: { state, nextAction: `Continue chatting normally, or use /loop-pause ${state.name} to pause after the current worker exits.` } };
      }
      const job = new RalphOrchestrator(ctx.cwd, packageRoot)
        .run(loopName, { maxIterations, workerMode: parseRunnerValue(params.runner), workerModel: params.model, workerContextWindow: resolveWorkerContextWindow(ctx, params.model), onProgress: commandProgress(ctx), onIterationComplete: postIterationSummary })
        .then((state) => {
          setCurrent(ctx, state);
          ctx.ui.notify(`Subagent Loop run stopped at ${state.currentIteration} (${deriveLoopStatus(state)})`, "info");
        })
        .catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"))
        .finally(() => activeJobs.delete(loopName));
      activeJobs.set(loopName, job);
      return { content: [{ type: "text", text: `Started Subagent Loop run for "${loopName}" in the background. You can keep chatting; progress will update in the Subagent Loop widget.` }], details: { state: { name: loopName, control: "active", maxIterations }, nextAction: `Continue chatting normally, or use /loop-pause ${loopName} to pause after the current worker exits.` } };
    },
  });

  pi.registerTool({
    name: "subagent_loop_insert_todo",
    label: "Insert Loop Todo",
    description: "Safely insert a deferred semantic-ID todo into an existing Subagent Loop at an array position without renumbering existing todos.",
    promptSnippet: "Insert a new loop todo with an explicit semantic ID at insertAtIndex; dry-run first when the user wants a preview.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })),
      id: Type.String({ description: "Unique semantic todo ID, e.g. 003.1-add-logging or ISSUE-005.1." }),
      title: Type.String({ description: "Title for the new todo, e.g. Complete plans/issues/005.1.md." }),
      insertAtIndex: Type.Optional(Type.Number({ description: "Zero-based array insertion position. Omit to append." })),
      status: Type.Optional(Type.Union([Type.Literal("deferred"), Type.Literal("queued")], { description: "Initial status for the inserted todo. Defaults to deferred." })),
      model: Type.Optional(Type.String({ description: "Optional Pi model pattern/ID for this todo's worker." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview the state change without writing state.json or plan.md." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Subagent Loop name provided and no active loop is set.");
      const loopName = slugifyLoopName(name);
      if (activeJobs.has(loopName)) throw new Error(`Cannot insert a loop todo while loop is running: ${loopName}. Pause or wait for the active worker to finish first.`);
      const result = await new RalphOrchestrator(ctx.cwd, packageRoot).insertTodo({ name: loopName, id: params.id, title: params.title, insertAtIndex: params.insertAtIndex, status: params.status, workerModel: params.model, workerContextWindow: resolveWorkerContextWindow(ctx, params.model), dryRun: params.dryRun });
      if (!result.dryRun) updateUI(ctx, result.state);
      return { content: [{ type: "text", text: renderInsertTodoResponse(result) }], details: { ...result, nextAction: result.dryRun ? "If the preview looks correct, call subagent_loop_insert_todo again with dryRun false or omitted." : nextActionForState(result.state) } };
    },
  });

  pi.registerTool({
    name: "subagent_loop_assign_todo_model",
    label: "Assign Loop Todo Model",
    description: "Assign, update, or clear a persisted child-worker model override for a queued/deferred future loop todo.",
    promptSnippet: "Assign a Pi model to a future loop todo; do not use this to change an active running worker.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })),
      todoId: Type.String({ description: "Todo ID to update." }),
      model: Type.Optional(Type.String({ description: "Pi model pattern/ID. Use an empty string to clear the override." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview without writing state.json or committing." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Subagent Loop name provided and no active loop is set.");
      const result = await new RalphOrchestrator(ctx.cwd, packageRoot).assignTodoModel({ name, todoId: params.todoId, model: params.model ?? null, contextWindow: params.model ? resolveWorkerContextWindow(ctx, params.model) : null, dryRun: params.dryRun });
      if (!result.dryRun) updateUI(ctx, result.state);
      const action = result.cleared ? "Cleared" : result.dryRun ? "Dry run: would assign" : "Assigned";
      return { content: [{ type: "text", text: `${action} worker model for #${result.todo.id}${result.todo.workerModel ? `: ${result.todo.workerModel}` : ""}.\n\n${renderStatus(result.state)}` }], details: { ...result, nextAction: nextActionForState(result.state) } };
    },
  });

  pi.registerTool({
    name: "subagent_loop_pause",
    label: "Pause Subagent Loop Loop",
    description: "Pause a Subagent Loop after the current worker iteration exits. Does not kill the active child process.",
    promptSnippet: "Pause the active Subagent Loop after the current worker exits.",
    parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Subagent Loop name provided and no active loop is set.");
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).pause(name);
      updateUI(ctx, state);
      return { content: [{ type: "text", text: renderToolResponse(state, activeJobs.has(state.name) ? `Subagent Loop "${state.name}" will pause after the current worker exits.` : `Paused Subagent Loop "${state.name}".`) }], details: { state, nextAction: nextActionForState(state) } };
    },
  });

  pi.registerTool({
    name: "subagent_loop_kill",
    label: "Kill Subagent Loop Worker",
    description: "Kill active child Pi worker processes for a Subagent Loop, then pause for inspection/recovery.",
    promptSnippet: "Kill the active Subagent Loop worker only when the user asks for an immediate abort/kill.",
    parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Subagent Loop name provided and no active loop is set.");
      const { state, killed } = await new RalphOrchestrator(ctx.cwd, packageRoot).kill(name);
      updateUI(ctx, state);
      return { content: [{ type: "text", text: `${killed > 0 ? "Killed" : "No active worker process found for"} Subagent Loop "${state.name}" (${killed} process${killed === 1 ? "" : "es"}).\n\nInspect status and git status before running again; partial edits may remain.` }], details: { state, killed, nextAction: "Inspect subagent_loop_status and git status before subagent_loop_run." } };
    },
  });

  pi.registerTool({
    name: "subagent_loop_status",
    label: "Ralph Status",
    description: "Inspect status for the active or named Subagent Loop loop.",
    promptSnippet: "Check Subagent Loop status before deciding whether to continue, pause, kill, or inspect artifacts.",
    parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const orchestrator = new RalphOrchestrator(ctx.cwd, packageRoot);
      const name = params.name ?? currentLoop;
      if (!name) {
        const states = await orchestrator.list();
        return { content: [{ type: "text", text: `Subagent Loops:\n${renderLoopList(states)}` }], details: { states, nextAction: states.length ? "Pick a loop name, then call subagent_loop_status or subagent_loop_run." : "Create a loop with subagent_loop_start." } };
      }
      const state = await orchestrator.status(name);
      updateUI(ctx, state);
      return { content: [{ type: "text", text: renderToolResponse(state, `Status for Subagent Loop "${state.name}".`) }], details: { state, nextAction: nextActionForState(state), artifacts: iterationArtifacts(state) } };
    },
  });

  pi.registerTool({
    name: "subagent_loop_list",
    label: "List Subagent Loops",
    description: "List Subagent Loop loops in this workspace.",
    promptSnippet: "List available Subagent Loops when the user asks what is running or when no active loop is known.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const states = await new RalphOrchestrator(ctx.cwd, packageRoot).list();
      const active = states.find((state) => deriveLoopStatus(state) === "running") ?? states.find((state) => deriveLoopStatus(state) === "ready") ?? null;
      if (active) setCurrent(ctx, active);
      return { content: [{ type: "text", text: `Subagent Loops:\n${renderLoopList(states)}` }], details: { states, nextAction: active ? `Active candidate: ${active.name}. Call subagent_loop_status or subagent_loop_run next.` : "Create a loop with subagent_loop_start." } };
    },
  });


  pi.on("session_start", async (_event, ctx) => {
    const states = await new RalphOrchestrator(ctx.cwd, packageRoot).list();
    const active = states.find((state) => deriveLoopStatus(state) === "running") ?? states.find((state) => deriveLoopStatus(state) === "ready") ?? null;
    currentLoop = active?.name ?? null;
    ralphWidgetMode = active ? "compact" : "hidden";
    updateUI(ctx, active);
  });
}

function command(description: string, handler: (args: string, ctx: ExtensionContext) => Promise<void>) {
  return {
    description,
    handler: async (args: string, ctx: ExtensionContext) => {
      try {
        await handler(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  };
}

const HELP = `Subagent Loop - fresh-context development loops

Primary commands:
  /loop-plan <goal>                               Plan/grill a loop before starting
  /loop-start <name> [--max N] [--model MODEL] [--todo item ...] Start a loop
  /loop-run [name] [--max N] [--runner pi-json] [--model MODEL] Run queued work; resumes a paused loop
  /loop-assign-model <loop> <todo-id> [--model MODEL] Assign/clear future todo worker model
  /loop-pause [name]                              Pause after the current worker exits
  /loop-kill [name]                               Kill the current Subagent Loop worker process and pause
  /loop-status [name]                             Show current or named loop status
  /loop-list                                      List all loops
  /loop-widget [toggle|compact|expand|show|hide] Set Subagent Loop widget mode (Ctrl+Opt+R expands/contracts)

Natural usage:
  Ask: "Can we set up a ralph loop to get through our issues? Max of 5 loops."`;

function buildPlanPrompt(request: string): string {
  const goal = request || "Plan a Subagent Loop for the work I want to accomplish.";
  return `/skill:subagent-loop ${goal}`;
}

function splitArgs(input: string): string[] {
  return input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

function parseTodos(args: string[]): string[] | undefined {
  const todoIndex = args.indexOf("--todo");
  if (todoIndex === -1) return undefined;
  return args.slice(todoIndex + 1).filter((arg) => !arg.startsWith("--"));
}

function parseRunner(args: string[]): WorkerMode {
  const index = args.indexOf("--runner");
  if (index === -1) return "pi-json";
  return parseRunnerValue(args[index + 1]);
}

function parseRunnerValue(value: string | undefined): WorkerMode {
  return value === "scripted" ? "scripted" : "pi-json";
}

function parseModel(args: string[]): string | undefined {
  const index = args.indexOf("--model");
  if (index === -1) return undefined;
  return args[index + 1];
}

function resolveWorkerContextWindow(ctx: ExtensionContext, workerModel: string | undefined): number | undefined {
  if (!workerModel) return ctx.model?.contextWindow;
  const model = resolveModel(ctx, workerModel);
  return model?.contextWindow;
}

function resolveModel(ctx: ExtensionContext, modelPattern: string): { contextWindow?: number } | undefined {
  const candidates = modelPattern.includes(":") ? [modelPattern, modelPattern.replace(/:[^:/]+$/, "")] : [modelPattern];
  for (const candidate of candidates) {
    const slash = candidate.indexOf("/");
    if (slash > 0) {
      const model = ctx.modelRegistry.find(candidate.slice(0, slash), candidate.slice(slash + 1));
      if (model) return model;
    }
    const matches = ctx.modelRegistry.getAll().filter((model) => model.id === candidate);
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function parseMax(args: string[]): number | undefined {
  const index = args.includes("--max") ? args.indexOf("--max") : args.indexOf("--max-iterations");
  if (index === -1) return undefined;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractTodos(taskContent: string): string[] {
  const todos = taskContent
    .split("\n")
    .map((line) => line.match(/^\s*- \[[ xX]\]\s+(.+)$/)?.[1]?.trim())
    .filter((todo): todo is string => Boolean(todo));
  return todos.length ? todos : [taskContent.trim().split("\n")[0] || "Work through requested task"];
}

function renderToolResponse(state: LoopState, lead: string): string {
  return `${lead}\n\n${renderStatus(state)}\n\nNext action: ${nextActionForState(state)}`;
}

function renderInsertTodoResponse(result: InsertTodoResult): string {
  const action = result.dryRun ? "Dry run: would insert" : "Inserted";
  const maxChange = result.maxIterationsChange ? `\n- maxIterations: ${result.maxIterationsChange.before} → ${result.maxIterationsChange.after}` : "";
  const preserved = result.state.todos
    .filter((todo) => todo.id !== result.insertedTodo.id)
    .map((todo) => `#${todo.id}`)
    .join(", ");
  return `${action} loop todo #${result.insertedTodo.id} at index ${result.insertAtIndex}: ${result.insertedTodo.title}\n\nChanges:\n- status: ${result.insertedTodo.status}\n- existing todo IDs preserved: ${preserved || "none"}${maxChange}\n\n${renderStatus(result.state)}\n\nNext action: ${result.dryRun ? "Review the preview, then insert without dryRun if approved." : nextActionForState(result.state)}`;
}

type RalphTheme = ExtensionContext["ui"]["theme"];
type RalphThemeColor = Parameters<RalphTheme["fg"]>[0];
type RalphThemeBg = Parameters<RalphTheme["bg"]>[0];
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PI_WORKING_SPINNER_INTERVAL_MS = 80;

export function renderRalphWidget(state: LoopState, worker: WorkerProgress | undefined, theme: RalphTheme, width: number, mode: Exclude<RalphWidgetMode, "hidden"> = "expanded"): string[] {
  const safeWidth = Math.max(0, width);
  const todos = mode === "compact" ? selectedCompactTodo(state.todos) : state.todos;
  const pressure = state.todos.some((todo) => todo.status === "running") ? contextPressure(worker) : { level: "unknown" as const };
  const chromeColor = pressureColor(pressure.level) ?? "accent";
  const lines: string[] = [renderPanelTopBorder(state, worker, theme, safeWidth, chromeColor), renderPanelLine("", theme, safeWidth, { borderColor: chromeColor })];

  for (const todo of todos) {
    lines.push(...renderTodoRow(todo, state, worker, theme, safeWidth, chromeColor));
    lines.push(renderPanelLine("", theme, safeWidth, { borderColor: chromeColor }));
  }

  lines.push(renderPanelBottomProgressBorder(state, theme, safeWidth, chromeColor));
  lines.push(theme.fg("dim", "Ctrl+Opt+R Expand/Compact · Chat to resume, pause, edit, or kill the loop."));
  return lines.map((line) => truncateAnsiToWidth(line, safeWidth));
}

export type ContextPressure = "normal" | "warning" | "error" | "unknown";

export function contextPressure(worker?: WorkerProgress): { level: ContextPressure; ratio?: number; percent?: number } {
  if (!worker || worker.phase === "exited") return { level: "unknown" };
  const contextTokens = worker.latestUsage?.contextTokens ?? worker.usage.contextTokens;
  const contextWindow = worker.latestUsage?.contextWindow ?? worker.usage.contextWindow;
  if (!Number.isFinite(contextTokens) || !Number.isFinite(contextWindow) || contextTokens === undefined || contextWindow === undefined || contextTokens < 0 || contextWindow <= 0) return { level: "unknown" };
  const ratio = Math.min(1, Math.max(0, contextTokens / contextWindow));
  const percent = Math.round(ratio * 100);
  if (ratio >= 0.5) return { level: "error", ratio, percent };
  if (ratio >= 0.4) return { level: "warning", ratio, percent };
  return { level: "normal", ratio, percent };
}

type WidgetTodo = LoopState["todos"][number];

const PANEL_MIN_WIDTH = 8;
const TODO_TITLE_PREFIX = "  ";
const TODO_DETAIL_PREFIX = "      ";

function renderTodoRow(todo: WidgetTodo, state: LoopState, worker: WorkerProgress | undefined, theme: RalphTheme, width: number, borderColor: RalphThemeColor): string[] {
  const iteration = latestIterationForTodo(state, todo.id);
  const isRunning = todo.status === "running";
  const pressure = isRunning ? contextPressure(worker) : { level: "unknown" as const };
  const runningPressureColor = pressureColor(pressure.level);
  const icon = todoGlyph(todo.status, isRunning ? worker?.elapsedMs : undefined);
  const iconColor = todo.status === "complete" ? "success" : todo.status === "failed" || todo.status === "interrupted" ? "error" : todo.status === "running" ? runningPressureColor ?? "accent" : "dim";
  const rowColor = todo.status === "deferred" ? "dim" : todo.status === "running" ? runningPressureColor ?? "accent" : "text";
  const title = `${TODO_TITLE_PREFIX}${theme.fg(todo.status === "deferred" ? "dim" : iconColor, icon)}   ${theme.fg(rowColor, `#${todo.id} ${todo.title}`)}`;
  const detail = `${TODO_DETAIL_PREFIX}${renderTodoDetail(todo, state, iteration, isRunning ? worker : undefined, worker, theme)}`;
  const lineOptions = { highlight: isRunning, borderColor, highlightBg: pressureBg(pressure.level) };
  return [renderPanelLine(title, theme, width, lineOptions), renderPanelLine(detail, theme, width, lineOptions)];
}

function selectedCompactTodo(todos: WidgetTodo[]): WidgetTodo[] {
  const finalTodo = todos[todos.length - 1];
  const selected = todos.find((todo) => todo.status === "running")
    ?? todos.find((todo) => todo.status === "failed" || todo.status === "interrupted")
    ?? todos.find((todo) => todo.status === "queued" || todo.status === "deferred")
    ?? (finalTodo?.status === "complete" ? finalTodo : undefined)
    ?? todos[0];
  return selected ? [selected] : [];
}

function renderPanelTopBorder(state: LoopState, worker: WorkerProgress | undefined, theme: RalphTheme, width: number, chromeColor: RalphThemeColor = "accent"): string {
  if (width < PANEL_MIN_WIDTH) return theme.fg(chromeColor, truncatePlain("─".repeat(Math.max(0, width)), width));
  const innerWidth = width - 2;
  const metrics = loopSummaryMetrics(state, worker);
  const titlePrefix = "─ ";
  const titleSuffix = " ";
  const summaryLeftPadding = " ";
  const rightPadding = " ";
  const summaryCandidates = [
    `✓ ${metrics.complete}/${metrics.total}`,
    ...(metrics.errors > 0 ? [`✗${metrics.errors}`] : []),
    ...(metrics.cost !== undefined ? [`$${metrics.cost.toFixed(4)}`] : []),
    ...(metrics.elapsedMs !== undefined ? [formatElapsed(metrics.elapsedMs)] : []),
  ];

  for (let keep = summaryCandidates.length; keep >= 1; keep--) {
    const summary = summaryCandidates.slice(0, keep).join(" · ");
    const fixedWidth = visibleWidth(titlePrefix) + visibleWidth(titleSuffix) + visibleWidth(summaryLeftPadding) + visibleWidth(summary) + visibleWidth(rightPadding);
    const titleWidth = Math.max(0, innerWidth - fixedWidth - 1);
    const title = truncatePlain(`Subagent Loop · ${state.name}`, titleWidth);
    const gapWidth = innerWidth - visibleWidth(titlePrefix) - visibleWidth(title) - visibleWidth(titleSuffix) - visibleWidth(summaryLeftPadding) - visibleWidth(summary) - visibleWidth(rightPadding);
    if (gapWidth >= 1) return theme.fg(chromeColor, "╭" + titlePrefix) + theme.fg(chromeColor, theme.bold(title)) + theme.fg(chromeColor, titleSuffix + "─".repeat(gapWidth) + summaryLeftPadding) + summary + theme.fg(chromeColor, rightPadding + "╮");
  }

  const title = truncatePlain(`Subagent Loop · ${state.name}`, Math.max(0, innerWidth - 4));
  const body = padPlain(`─ ${title} `, innerWidth, "─");
  return theme.fg(chromeColor, "╭") + theme.fg(chromeColor, theme.bold(title ? body : "─".repeat(innerWidth))) + theme.fg(chromeColor, "╮");
}

function renderPanelLine(content: string, theme: RalphTheme, width: number, options: { highlight?: boolean; borderColor?: RalphThemeColor; highlightBg?: RalphThemeBg } = {}): string {
  if (width < PANEL_MIN_WIDTH) return truncateAnsiToWidth(content, width);
  const innerWidth = width - 2;
  const inner = padAnsiToWidth(truncateAnsiToWidth(content, innerWidth), innerWidth);
  const highlighted = options.highlight ? themeBg(theme, options.highlightBg ?? "toolPendingBg", inner) : inner;
  const borderColor = options.borderColor ?? "accent";
  return theme.fg(borderColor, "│") + highlighted + theme.fg(borderColor, "│");
}

function renderPanelBottomProgressBorder(state: LoopState, theme: RalphTheme, width: number, chromeColor: RalphThemeColor = "accent"): string {
  if (width < PANEL_MIN_WIDTH) return theme.fg(chromeColor, truncatePlain("─".repeat(Math.max(0, width)), width));
  const innerWidth = width - 2;
  const metrics = loopSummaryMetrics(state, undefined);
  const barWidth = Math.max(0, innerWidth - 3);
  const filledWidth = metrics.total > 0 ? Math.round((metrics.complete / metrics.total) * barWidth) : 0;
  const filled = fgWhite("━".repeat(filledWidth));
  const remaining = theme.fg(chromeColor, "─".repeat(Math.max(0, barWidth - filledWidth)));
  return theme.fg(chromeColor, "╰─ ") + filled + remaining + theme.fg(chromeColor, " ╯");
}

function loopSummaryMetrics(state: LoopState, worker: WorkerProgress | undefined): { complete: number; total: number; errors: number; cost?: number; elapsedMs?: number } {
  const complete = state.todos.filter((todo) => todo.status === "complete").length;
  const errors = state.todos.filter((todo) => todo.status === "failed" || todo.status === "interrupted").length;
  let cost = 0;
  let hasCost = false;
  let elapsedMs = 0;
  let hasElapsed = false;
  for (const iteration of state.iterations) {
    if (iteration.usage?.cost !== undefined) {
      cost += iteration.usage.cost;
      hasCost = true;
    }
    const elapsed = iterationElapsedMs(iteration);
    if (elapsed !== undefined) {
      elapsedMs += elapsed;
      hasElapsed = true;
    }
  }
  if (worker?.usage.cost !== undefined) {
    cost += worker.usage.cost;
    hasCost = true;
  }
  if (worker?.elapsedMs !== undefined && worker.phase !== "exited") {
    elapsedMs += worker.elapsedMs;
    hasElapsed = true;
  }
  return { complete, total: state.todos.length, errors, ...(hasCost ? { cost } : {}), ...(hasElapsed ? { elapsedMs } : {}) };
}

function iterationElapsedMs(iteration: LoopState["iterations"][number] | undefined): number | undefined {
  if (!iteration?.completedAt) return undefined;
  const started = Date.parse(iteration.startedAt);
  const completed = Date.parse(iteration.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return undefined;
  return Math.max(0, completed - started);
}

function themeBg(theme: RalphTheme, color: string, text: string): string {
  const maybeTheme = theme as RalphTheme & { bg?: (color: string, text: string) => string };
  return maybeTheme.bg ? maybeTheme.bg(color, text) : text;
}

function widgetStateSignature(state: LoopState): string {
  return JSON.stringify({
    name: state.name,
    control: state.control,
    currentIteration: state.currentIteration,
    updatedAt: state.updatedAt,
    todos: state.todos.map((todo) => [todo.id, todo.status]),
    iterations: state.iterations.map((iteration) => [iteration.number, iteration.status, iteration.completedAt, iteration.verification?.status]),
  });
}

function truncateAnsiToWidth(input: string, width: number): string {
  if (width <= 0) return "";
  let visible = 0;
  let output = "";
  for (let index = 0; index < input.length;) {
    if (input[index] === "\x1b") {
      const match = input.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }
    const char = Array.from(input.slice(index))[0] ?? "";
    if (!char) break;
    if (visible + 1 > width) return `${output}\x1b[0m`;
    output += char;
    visible += 1;
    index += char.length;
  }
  return output;
}

function visibleWidth(input: string): number {
  let visible = 0;
  for (let index = 0; index < input.length;) {
    if (input[index] === "\x1b") {
      const match = input.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (match) {
        index += match[0].length;
        continue;
      }
    }
    const char = Array.from(input.slice(index))[0] ?? "";
    if (!char) break;
    visible += 1;
    index += char.length;
  }
  return visible;
}

function padAnsiToWidth(input: string, width: number, fill = " "): string {
  const visible = visibleWidth(input);
  return visible >= width ? input : input + fill.repeat(width - visible);
}

function truncatePlain(input: string, width: number): string {
  if (width <= 0) return "";
  return Array.from(input).slice(0, width).join("");
}

function padPlain(input: string, width: number, fill = " "): string {
  const truncated = truncatePlain(input, width);
  return truncated + fill.repeat(Math.max(0, width - visibleWidth(truncated)));
}

function latestIterationForTodo(state: LoopState, todoId: LoopState["todos"][number]["id"]): LoopState["iterations"][number] | undefined {
  for (let index = state.iterations.length - 1; index >= 0; index--) {
    const iteration = state.iterations[index];
    if (iteration?.todoId === todoId) return iteration;
  }
  return undefined;
}

export function renderToolPhrase(toolNames: readonly string[], fallbackCount = 0, maxVisible = 2): string {
  const normalizedNames = toolNames.map(displayToolName).filter((name) => name.length > 0);
  if (normalizedNames.length === 0) {
    if (fallbackCount > 0) return `Used ${fallbackCount} ${fallbackCount === 1 ? "tool" : "tools"}`;
    return "Used tools";
  }

  const visibleNames = normalizedNames.slice(0, maxVisible);
  const hiddenCount = Math.max(normalizedNames.length, fallbackCount) - visibleNames.length;
  const suffix = hiddenCount > 0 ? ` +${hiddenCount} more` : "";
  return `Used ${visibleNames.join(", ")}${suffix}`;
}

function displayToolName(toolName: string): string {
  const knownTools: Record<string, string> = {
    bash: "Bash",
    edit: "Edit",
    read: "Read",
    write: "Write",
  };
  const trimmed = toolName.trim();
  const known = knownTools[trimmed.toLowerCase()];
  if (known) return known;
  return trimmed
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function renderTodoDetail(todo: LoopState["todos"][number], state: LoopState, iteration: LoopState["iterations"][number] | undefined, worker: WorkerProgress | undefined, fallbackWorker: WorkerProgress | undefined, theme: RalphTheme): string {
  const status = todo.status;
  if (status === "running" && worker) {
    const segments: string[] = [];
    const model = displayModelName(worker.model ?? worker.configuredModel);
    if (model) segments.push(theme.fg("muted", model));
    segments.push(...renderRunningUsageSegments(worker, theme));
    segments.push(theme.fg("muted", formatElapsed(worker.elapsedMs)));
    return segments.join(theme.fg("muted", " · "));
  }

  if (status === "complete" || status === "failed" || status === "interrupted") {
    const segments: string[] = [];
    const model = displayModelName(iteration?.observedModel ?? iteration?.configuredModel ?? iteration?.model);
    if (model) segments.push(theme.fg("muted", model));
    segments.push(...renderUsageSegments(iteration?.usage, theme));
    const elapsed = renderIterationElapsed(iteration);
    if (elapsed) segments.push(theme.fg("muted", elapsed));
    if (iteration?.diff) segments.push(...renderDiffSummarySegments(iteration.diff, theme));
    return segments.join(theme.fg("muted", " · "));
  }

  const placeholder = renderPlaceholderDetail(fallbackWorker, theme, todo.workerModel ?? state.workerDefaults?.model);
  return status === "deferred" ? theme.fg("dim", placeholder) : placeholder;
}

function renderPlaceholderDetail(worker: WorkerProgress | undefined, theme: RalphTheme, assignedModel?: string): string {
  const segments: string[] = [];
  const model = displayModelName(worker?.model ?? worker?.configuredModel ?? assignedModel);
  if (model) segments.push(theme.fg("muted", model));
  segments.push(theme.fg("muted", renderTokenBreakdown({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 })));
  const contextWindow = worker?.latestUsage?.contextWindow ?? worker?.usage.contextWindow;
  if (contextWindow) segments.push(theme.fg("muted", `0%/${formatTokenCount(contextWindow)}`));
  segments.push(theme.fg("muted", "$0.0000"), theme.fg("muted", "0s"));
  return segments.join(theme.fg("muted", " · "));
}

function renderIterationElapsed(iteration: LoopState["iterations"][number] | undefined): string {
  const elapsed = iterationElapsedMs(iteration);
  return elapsed === undefined ? "" : formatElapsed(elapsed);
}

function renderUsageSegments(usage: WorkerUsage | undefined, theme: RalphTheme): string[] {
  if (!usage?.totalTokens) return [];
  return renderUsageSegmentsForDisplay(usage, theme);
}

function renderRunningUsageSegments(worker: WorkerProgress, theme: RalphTheme): string[] {
  if (!worker.usage.totalTokens) return [];
  const contextTokens = worker.latestUsage?.contextTokens ?? worker.usage.contextTokens;
  const contextWindow = worker.latestUsage?.contextWindow ?? worker.usage.contextWindow;
  return renderUsageSegmentsForDisplay({ ...worker.usage, ...(contextTokens !== undefined && contextWindow ? { contextTokens, contextWindow } : { contextWindow: undefined }) }, theme);
}

function pressureColor(level: ContextPressure): RalphThemeColor | undefined {
  return level === "warning" ? "warning" : level === "error" ? "error" : undefined;
}

function pressureBg(level: ContextPressure): RalphThemeBg | undefined {
  return level === "error" ? "toolErrorBg" : level === "warning" ? "toolPendingBg" : undefined;
}

function fgWhite(text: string): string {
  return `\x1b[97m${text}\x1b[39m`;
}

function renderUsageSegmentsForDisplay(usage: WorkerUsage, theme: RalphTheme): string[] {
  const segments = [theme.fg("muted", renderTokenBreakdown(usage))];
  const context = renderContextWindowUsage(usage);
  if (context) segments.push(theme.fg("muted", context));
  if (usage.cost !== undefined) segments.push(theme.fg("muted", `$${usage.cost.toFixed(4)}`));
  return segments;
}

function renderDiffSummarySegments(diff: NonNullable<LoopState["iterations"][number]["diff"]>, theme: RalphTheme): string[] {
  const fileLabel = diff.filesChanged === 1 ? "File" : "Files";
  return [theme.fg("muted", `+${diff.insertions} / -${diff.deletions}`), theme.fg("muted", `${diff.filesChanged} ${fileLabel}`)];
}

function displayModelName(model: string | undefined): string {
  if (!model) return "";
  const trimmed = model.trim();
  if (!trimmed) return "";
  const slashParts = trimmed.split("/");
  return slashParts[slashParts.length - 1] ?? trimmed;
}

function renderTokenBreakdown(usage: WorkerUsage): string {
  const parts = [`↑${formatTokenCount(usage.input)}`, `↓${formatTokenCount(usage.output)}`];
  if (usage.cacheRead > 0) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
  if (usage.cacheWrite > 0) parts.push(`W${formatTokenCount(usage.cacheWrite)}`);
  return parts.join(" ");
}

function renderContextWindowUsage(usage: WorkerUsage): string {
  const contextTokens = usage.contextTokens ?? usage.totalTokens;
  if (!usage.contextWindow || !contextTokens) return "";
  return `${formatPercent(contextTokens / usage.contextWindow)}/${formatTokenCount(usage.contextWindow)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1)}k`;
  return tokens.toLocaleString();
}

function spinnerFrame(elapsedMs = Date.now()): string {
  return SPINNER_FRAMES[Math.floor(elapsedMs / PI_WORKING_SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length] ?? "⠋";
}

function todoGlyph(status: LoopState["todos"][number]["status"], elapsedMs?: number): string {
  return status === "running" ? spinnerFrame(elapsedMs) : status === "queued" ? "○" : status === "complete" ? "✓" : status === "deferred" ? "Ⅱ" : status === "interrupted" ? "!" : "✗";
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function nextActionForState(state: LoopState): string {
  const status = deriveLoopStatus(state);
  if (status === "ready") return `Loop is ready. Use subagent_loop_run or /loop-run ${state.name} --max N.`;
  if (status === "running") return `Loop is running. Chat to pause, kill, or steer the orchestrator.`;
  if (status === "completed") return "Loop is complete. Inspect artifacts or start a new loop.";
  if (status === "needs_attention") return "Loop needs attention. Inspect status and git status before running again.";
  return `Loop is paused. Run it again with /loop-run ${state.name} when ready.`;
}

function renderIterationSummary(event: IterationCompleteEvent): string {
  const { state, iteration, todo, result } = event;
  const passed = result.verification.status === "passed";
  const lines = [
    `${passed ? "✓" : "✗"} loop iteration #${iteration.number} ${passed ? "completed and verified" : "needs attention"}`,
    "",
    `Loop: ${state.name}`,
    `Task: #${todo.id} ${todo.title}`,
  ];

  const elapsed = renderIterationElapsed(iteration);
  if (elapsed) lines.push(`Elapsed: ${elapsed}`);
  const usage = iteration.usage ?? result.usage;
  if (usage?.totalTokens) lines.push(`Tokens: ${usage.totalTokens.toLocaleString()}`);
  if (usage?.cost && usage.cost > 0) lines.push(`Cost: $${usage.cost.toFixed(4)}`);
  if (iteration.diff) {
    lines.push(`Files edited: ${iteration.diff.filesChanged}`);
    lines.push(`Lines: +${iteration.diff.insertions} / -${iteration.diff.deletions}`);
  }
  const files = iteration.changedFiles ?? result.changedFiles;
  if (files.length) lines.push("Files:", ...files.map((file) => `- ${file}`));

  lines.push("Verification:");
  for (const command of result.verification.commands) {
    lines.push(`- ${command.command} → ${command.exitCode}: ${command.summary}`);
  }
  if (result.verification.notes) lines.push(`Notes: ${result.verification.notes}`);
  lines.push("", "Summary:", result.summary || "Worker did not provide a summary.");
  return lines.join("\n");
}

function iterationArtifacts(state: LoopState): Record<string, string> {
  const base = path.join(".ralph", "orchestrator", "loops", state.name);
  const artifacts: Record<string, string> = { loopDir: base, plan: path.join(base, "plan.md"), state: path.join(base, "state.json") };
  if (state.currentIteration > 0) {
    const iterationDir = path.join(base, "iterations", String(state.currentIteration).padStart(3, "0"));
    artifacts.iterationDir = iterationDir;
    artifacts.handoffOut = path.join(iterationDir, "handoff-out.md");
    artifacts.verification = path.join(iterationDir, "verification.md");
    artifacts.workerOutput = path.join(iterationDir, "worker-output.jsonl");
  }
  return artifacts;
}

function formatUsage(usage: WorkerUsage): string {
  const cost = usage.cost && usage.cost > 0 ? ` · $${usage.cost.toFixed(4)}` : "";
  return `${usage.totalTokens.toLocaleString()} tok (in ${usage.input.toLocaleString()}, out ${usage.output.toLocaleString()}, cache read ${usage.cacheRead.toLocaleString()}, cache write ${usage.cacheWrite.toLocaleString()})${cost}`;
}
