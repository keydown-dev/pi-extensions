import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deriveLoopStatus, RalphOrchestrator, renderLoopList, renderStatus } from "../src/orchestrator.js";
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
    ctx.ui.notify(`Ralph widget ${mode}`, "info");
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
    ctx.ui.notify(`No non-complete Ralph loop detected. Available loops:\n${renderLoopList(states)}`, "info");
    updateUI(ctx, null);
    return false;
  }

  async function toggleWidget(args: string, ctx: ExtensionContext): Promise<void> {
    const mode = splitArgs(args)[0]?.toLowerCase();
    if (mode === "show" || mode === "on") return setWidgetMode(ctx, "expanded");
    if (mode === "hide" || mode === "off") return setWidgetMode(ctx, "hidden");
    if (mode === "compact" || mode === "collapse" || mode === "collapsed") return setWidgetMode(ctx, "compact");
    if (mode === "expanded" || mode === "expand" || mode === "full") return setWidgetMode(ctx, "expanded");
    if (mode && mode !== "toggle") throw new Error("Usage: /ralph-widget [toggle|compact|expand|show|hide]");
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
    if (!name) throw new Error("Usage: /ralph-start <name> [--max N] [--todo item ...]");
    const state = await new RalphOrchestrator(ctx.cwd, packageRoot).start({ name, todos: parseTodos(argv), maxIterations: parseMax(argv) });
    setCurrent(ctx, state);
    ctx.ui.notify(`Prepared Ralph loop: ${state.name}. Use /ralph-run ${state.name} to run queued work.`, "info");
  }

  async function pauseLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const name = splitArgs(args).shift() ?? currentLoop;
    if (!name) throw new Error("Usage: /ralph-pause [name]");
    const state = await new RalphOrchestrator(ctx.cwd, packageRoot).pause(name);
    updateUI(ctx, state);
    ctx.ui.notify(activeJobs.has(state.name) ? `Paused Ralph loop after the current worker exits: ${state.name}` : `Paused Ralph loop: ${state.name}`, "info");
  }

  async function killLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const name = splitArgs(args).shift() ?? currentLoop;
    if (!name) throw new Error("Usage: /ralph-kill [name]");
    const { state, killed } = await new RalphOrchestrator(ctx.cwd, packageRoot).kill(name);
    updateUI(ctx, state);
    ctx.ui.notify(`Killed ${killed} Ralph worker process${killed === 1 ? "" : "es"} for ${state.name}. Inspect status and git status before running again.`, killed > 0 ? "warning" : "info");
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
    ctx.ui.notify(`Ralph status:\n${active ? renderStatus(active) : renderLoopList(states)}`, "info");
  }

  async function showList(_args: string, ctx: ExtensionContext): Promise<void> {
    const states = await new RalphOrchestrator(ctx.cwd, packageRoot).list();
    ctx.ui.notify(`Ralph loops:\n${renderLoopList(states)}`, "info");
    const active = states.find((state) => deriveLoopStatus(state) === "running") ?? states.find((state) => deriveLoopStatus(state) === "ready");
    if (active) setCurrent(ctx, active);
  }

  async function runLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const argv = splitArgs(args);
    const name = argv.shift() ?? currentLoop;
    if (!name) throw new Error("Usage: /ralph-run [name] [--max N] [--runner pi-json] [--model MODEL]");
    const maxIterations = parseMax(argv) ?? 1;
    startBackgroundLoop(ctx, name, `Ralph run for ${name}`, async () => {
      const workerModel = parseModel(argv);
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).run(name, { maxIterations, workerMode: parseRunner(argv), workerModel, workerContextWindow: resolveWorkerContextWindow(ctx, workerModel), onProgress: commandProgress(ctx), onIterationComplete: postIterationSummary });
      return { state, message: `Ralph run stopped at ${state.currentIteration} (${deriveLoopStatus(state)})` };
    });
  }

  function startBackgroundLoop(ctx: ExtensionContext, name: string, label: string, execute: () => Promise<{ state: LoopState; message: string }>): void {
    if (activeJobs.has(name)) {
      ctx.ui.notify(`Ralph loop is already running: ${name}`, "warning");
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
    ctx.ui.notify(`${label} started in the background. You can keep chatting; progress will update in the Ralph widget.`, "info");
  }

  pi.registerCommand("ralph-start", command("Start a Ralph orchestrator loop", startLoop));
  pi.registerCommand("ralph-pause", command("Pause active Ralph orchestrator loop", pauseLoop));
  pi.registerCommand("ralph-kill", command("Kill active Ralph worker process and pause the loop", killLoop));
  pi.registerCommand("ralph-status", command("Show current or named Ralph loop status", showStatus));
  pi.registerCommand("ralph-list", command("List Ralph orchestrator loops", showList));
  pi.registerCommand("ralph-run", command("Run one or more Ralph worker iterations", runLoop));
  pi.registerCommand("ralph-widget", {
    description: "Set Ralph widget mode (compact, expand, show, or hide)",
    handler: async (args, ctx) => {
      try {
        await toggleWidget(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
  pi.registerShortcut("ctrl+alt+r", {
    description: "Expand/contract the Ralph widget",
    handler: async (ctx) => densityToggleWidget(ctx),
  });

  pi.registerCommand("ralph-plan", {
    description: "Plan a Ralph loop through a grilling/planning interview before starting",
    handler: async (args, ctx) => {
      const prompt = buildPlanPrompt(args.trim());
      ctx.ui.notify("Starting Ralph planning interview. The agent should grill, plan, and ask for approval before starting a loop.", "info");
      pi.sendUserMessage(prompt);
    },
  });

  pi.registerCommand("ralph", {
    description: "Ralph Orchestrator - fresh-context development loops",
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
    name: "ralph_orchestrator_plan",
    label: "Plan Ralph Loop",
    description: "Start a Ralph planning interview before creating a loop.",
    promptSnippet: "Plan a Ralph loop by grilling requirements before calling ralph_orchestrator_start.",
    parameters: Type.Object({ request: Type.String({ description: "The user's planning request or goal" }) }),
    async execute(_toolCallId, params) {
      pi.sendUserMessage(buildPlanPrompt(params.request), { deliverAs: "followUp" });
      return { content: [{ type: "text", text: "Queued a Ralph planning interview." }], details: {} };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_start",
    label: "Start Ralph Orchestrator",
    description: "Create a Ralph orchestrator loop from a natural-language task.",
    promptSnippet: "Create a Ralph orchestrator loop with a plan, todo list, and max-iteration setting.",
    parameters: Type.Object({
      name: Type.String({ description: "Short loop name" }),
      taskContent: Type.String({ description: "Markdown plan with goals, checklist, notes, and verification expectations" }),
      maxIterations: Type.Optional(Type.Number({ description: "Maximum number of tasks in the initial run scope" })),
      todos: Type.Optional(Type.Array(Type.String(), { description: "Concrete checklist items extracted from taskContent" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const todos = params.todos?.length ? params.todos : extractTodos(params.taskContent);
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).start({ name: params.name, todos, maxIterations: params.maxIterations });
      setCurrent(ctx, state);
      return { content: [{ type: "text", text: renderToolResponse(state, `Created Ralph orchestrator loop "${state.name}" with ${state.todos.length} todos.`) }], details: { state, nextAction: nextActionForState(state) } };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_run",
    label: "Run Ralph Loop",
    description: "Run one or more worker iterations for a Ralph orchestrator loop. Running a paused loop resumes it.",
    promptSnippet: "Run a Ralph loop for a bounded number of iterations, then inspect status and artifacts.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })),
      maxIterations: Type.Optional(Type.Number({ description: "Maximum number of worker iterations to run in this call." })),
      runner: Type.Optional(Type.String({ description: "Worker runner: pi-json (default) or scripted." })),
      model: Type.Optional(Type.String({ description: "Pi model pattern/ID for the child worker." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Ralph loop name provided and no active loop is set.");
      if (activeJobs.has(name)) throw new Error(`Ralph loop is already running: ${name}`);
      currentLoop = name;
      const maxIterations = params.maxIterations ?? 1;
      const job = new RalphOrchestrator(ctx.cwd, packageRoot)
        .run(name, { maxIterations, workerMode: parseRunnerValue(params.runner), workerModel: params.model, workerContextWindow: resolveWorkerContextWindow(ctx, params.model), onProgress: commandProgress(ctx), onIterationComplete: postIterationSummary })
        .then((state) => {
          setCurrent(ctx, state);
          ctx.ui.notify(`Ralph run stopped at ${state.currentIteration} (${deriveLoopStatus(state)})`, "info");
        })
        .catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"))
        .finally(() => activeJobs.delete(name));
      activeJobs.set(name, job);
      return { content: [{ type: "text", text: `Started Ralph run for "${name}" in the background. You can keep chatting; progress will update in the Ralph widget.` }], details: { state: { name, control: "active", maxIterations }, nextAction: `Continue chatting normally, or use /ralph-pause ${name} to pause after the current worker exits.` } };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_insert_todo",
    label: "Insert Ralph Todo",
    description: "Safely insert a deferred semantic-ID todo into an existing Ralph loop at an array position without renumbering existing todos.",
    promptSnippet: "Insert a new Ralph todo with an explicit semantic ID at insertAtIndex; dry-run first when the user wants a preview.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })),
      id: Type.String({ description: "Unique semantic todo ID, e.g. 003.1-add-logging or ISSUE-005.1." }),
      title: Type.String({ description: "Title for the new todo, e.g. Complete plans/issues/005.1.md." }),
      insertAtIndex: Type.Optional(Type.Number({ description: "Zero-based array insertion position. Omit to append." })),
      status: Type.Optional(Type.Union([Type.Literal("deferred"), Type.Literal("queued")], { description: "Initial status for the inserted todo. Defaults to deferred." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Preview the state change without writing state.json or plan.md." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Ralph loop name provided and no active loop is set.");
      if (activeJobs.has(name)) throw new Error(`Cannot insert a Ralph todo while loop is running: ${name}. Pause or wait for the active worker to finish first.`);
      const result = await new RalphOrchestrator(ctx.cwd, packageRoot).insertTodo({ name, id: params.id, title: params.title, insertAtIndex: params.insertAtIndex, status: params.status, dryRun: params.dryRun });
      if (!result.dryRun) updateUI(ctx, result.state);
      return { content: [{ type: "text", text: renderInsertTodoResponse(result) }], details: { ...result, nextAction: result.dryRun ? "If the preview looks correct, call ralph_orchestrator_insert_todo again with dryRun false or omitted." : nextActionForState(result.state) } };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_pause",
    label: "Pause Ralph Loop",
    description: "Pause a Ralph loop after the current worker iteration exits. Does not kill the active child process.",
    promptSnippet: "Pause the active Ralph loop after the current worker exits.",
    parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Ralph loop name provided and no active loop is set.");
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).pause(name);
      updateUI(ctx, state);
      return { content: [{ type: "text", text: renderToolResponse(state, activeJobs.has(state.name) ? `Ralph loop "${state.name}" will pause after the current worker exits.` : `Paused Ralph loop "${state.name}".`) }], details: { state, nextAction: nextActionForState(state) } };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_kill",
    label: "Kill Ralph Worker",
    description: "Kill active child Pi worker processes for a Ralph loop, then pause for inspection/recovery.",
    promptSnippet: "Kill the active Ralph worker only when the user asks for an immediate abort/kill.",
    parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Ralph loop name provided and no active loop is set.");
      const { state, killed } = await new RalphOrchestrator(ctx.cwd, packageRoot).kill(name);
      updateUI(ctx, state);
      return { content: [{ type: "text", text: `${killed > 0 ? "Killed" : "No active worker process found for"} Ralph loop "${state.name}" (${killed} process${killed === 1 ? "" : "es"}).\n\nInspect status and git status before running again; partial edits may remain.` }], details: { state, killed, nextAction: "Inspect ralph_orchestrator_status and git status before ralph_orchestrator_run." } };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_status",
    label: "Ralph Status",
    description: "Inspect status for the active or named Ralph orchestrator loop.",
    promptSnippet: "Check Ralph loop status before deciding whether to continue, pause, kill, or inspect artifacts.",
    parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const orchestrator = new RalphOrchestrator(ctx.cwd, packageRoot);
      const name = params.name ?? currentLoop;
      if (!name) {
        const states = await orchestrator.list();
        return { content: [{ type: "text", text: `Ralph loops:\n${renderLoopList(states)}` }], details: { states, nextAction: states.length ? "Pick a loop name, then call ralph_orchestrator_status or ralph_orchestrator_run." : "Create a loop with ralph_orchestrator_start." } };
      }
      const state = await orchestrator.status(name);
      updateUI(ctx, state);
      return { content: [{ type: "text", text: renderToolResponse(state, `Status for Ralph loop "${state.name}".`) }], details: { state, nextAction: nextActionForState(state), artifacts: iterationArtifacts(state) } };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_list",
    label: "List Ralph Loops",
    description: "List Ralph orchestrator loops in this workspace.",
    promptSnippet: "List available Ralph loops when the user asks what is running or when no active loop is known.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const states = await new RalphOrchestrator(ctx.cwd, packageRoot).list();
      const active = states.find((state) => deriveLoopStatus(state) === "running") ?? states.find((state) => deriveLoopStatus(state) === "ready") ?? null;
      if (active) setCurrent(ctx, active);
      return { content: [{ type: "text", text: `Ralph loops:\n${renderLoopList(states)}` }], details: { states, nextAction: active ? `Active candidate: ${active.name}. Call ralph_orchestrator_status or ralph_orchestrator_run next.` : "Create a loop with ralph_orchestrator_start." } };
    },
  });

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (/\bralph\b/i.test(event.text) && /\b(loop|loops|iterate|iterations|issues?|todos?|insert|pause|resume|run|kill|abort|status|list)\b/i.test(event.text) && !event.text.startsWith("/")) {
      return { action: "transform" as const, text: `${event.text}\n\nIf this is a request to create, manage, insert todos into, pause, resume by running, kill, or inspect a Ralph loop, use ralph_orchestrator_start, ralph_orchestrator_insert_todo, ralph_orchestrator_run, ralph_orchestrator_pause, ralph_orchestrator_kill, ralph_orchestrator_status, or ralph_orchestrator_list as appropriate.` };
    }
    return { action: "continue" as const };
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

const HELP = `Ralph Orchestrator - fresh-context development loops

Primary commands:
  /ralph-plan <goal>                               Plan/grill a loop before starting
  /ralph-start <name> [--max N] [--todo item ...]  Start a loop
  /ralph-run [name] [--max N] [--runner pi-json] [--model MODEL] Run queued work; resumes a paused loop
  /ralph-pause [name]                              Pause after the current worker exits
  /ralph-kill [name]                               Kill the current Ralph worker process and pause
  /ralph-status [name]                             Show current or named loop status
  /ralph-list                                      List all loops
  /ralph-widget [toggle|compact|expand|show|hide] Set Ralph widget mode (Ctrl+Opt+R expands/contracts)

Natural usage:
  Ask: "Can we set up a ralph loop to get through our issues? Max of 5 loops."`;

function buildPlanPrompt(request: string): string {
  const goal = request || "Plan a Ralph loop for the work I want to accomplish.";
  return `/skill:ralph-plan ${goal}`;
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
  return `${action} Ralph todo #${result.insertedTodo.id} at index ${result.insertAtIndex}: ${result.insertedTodo.title}\n\nChanges:\n- status: ${result.insertedTodo.status}\n- existing todo IDs preserved: ${preserved || "none"}${maxChange}\n\n${renderStatus(result.state)}\n\nNext action: ${result.dryRun ? "Review the preview, then insert without dryRun if approved." : nextActionForState(result.state)}`;
}

type RalphTheme = ExtensionContext["ui"]["theme"];
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PI_WORKING_SPINNER_INTERVAL_MS = 80;

export function renderRalphWidget(state: LoopState, worker: WorkerProgress | undefined, theme: RalphTheme, width: number, mode: Exclude<RalphWidgetMode, "hidden"> = "expanded"): string[] {
  const safeWidth = Math.max(0, width);
  const todos = mode === "compact" ? selectedCompactTodo(state.todos) : state.todos;
  const lines: string[] = [renderPanelTopBorder(state, worker, theme, safeWidth), renderPanelLine("", theme, safeWidth)];

  for (const todo of todos) {
    lines.push(...renderTodoRow(todo, state, worker, theme, safeWidth));
    lines.push(renderPanelLine("", theme, safeWidth));
  }

  lines.push(renderPanelBottomProgressBorder(state, theme, safeWidth));
  lines.push(theme.fg("dim", "Ctrl+Opt+R Expand/Compact · Chat to resume, pause, edit, or kill the loop."));
  return lines.map((line) => truncateAnsiToWidth(line, safeWidth));
}

type WidgetTodo = LoopState["todos"][number];

const PANEL_MIN_WIDTH = 8;
const TODO_TITLE_PREFIX = "  ";
const TODO_DETAIL_PREFIX = "      ";

function renderTodoRow(todo: WidgetTodo, state: LoopState, worker: WorkerProgress | undefined, theme: RalphTheme, width: number): string[] {
  const iteration = latestIterationForTodo(state, todo.id);
  const isRunning = todo.status === "running";
  const icon = todoGlyph(todo.status, isRunning ? worker?.elapsedMs : undefined);
  const iconColor = todo.status === "complete" ? "success" : todo.status === "failed" || todo.status === "interrupted" ? "error" : todo.status === "running" ? "accent" : "dim";
  const rowColor = todo.status === "deferred" ? "dim" : todo.status === "running" ? "accent" : "text";
  const title = `${TODO_TITLE_PREFIX}${theme.fg(todo.status === "deferred" ? "dim" : iconColor, icon)}   ${theme.fg(rowColor, `#${todo.id} ${todo.title}`)}`;
  const detail = `${TODO_DETAIL_PREFIX}${renderTodoDetail(todo.status, iteration, isRunning ? worker : undefined, worker, theme)}`;
  return [renderPanelLine(title, theme, width, { highlight: isRunning }), renderPanelLine(detail, theme, width, { highlight: isRunning })];
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

function renderPanelTopBorder(state: LoopState, worker: WorkerProgress | undefined, theme: RalphTheme, width: number): string {
  if (width < PANEL_MIN_WIDTH) return theme.fg("border", truncatePlain("─".repeat(Math.max(0, width)), width));
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
    if (gapWidth >= 1) return theme.fg("border", "╭" + titlePrefix) + theme.fg("accent", theme.bold(title)) + theme.fg("border", titleSuffix + "─".repeat(gapWidth) + summaryLeftPadding) + summary + theme.fg("border", rightPadding + "╮");
  }

  const title = truncatePlain(`Subagent Loop · ${state.name}`, Math.max(0, innerWidth - 4));
  const body = padPlain(`─ ${title} `, innerWidth, "─");
  return theme.fg("border", "╭") + theme.fg("accent", theme.bold(title ? body : "─".repeat(innerWidth))) + theme.fg("border", "╮");
}

function renderPanelLine(content: string, theme: RalphTheme, width: number, options: { highlight?: boolean } = {}): string {
  if (width < PANEL_MIN_WIDTH) return truncateAnsiToWidth(content, width);
  const innerWidth = width - 2;
  const inner = padAnsiToWidth(truncateAnsiToWidth(content, innerWidth), innerWidth);
  const highlighted = options.highlight ? themeBg(theme, "toolPendingBg", inner) : inner;
  return theme.fg("border", "│") + highlighted + theme.fg("border", "│");
}

function renderPanelBottomProgressBorder(state: LoopState, theme: RalphTheme, width: number): string {
  if (width < PANEL_MIN_WIDTH) return theme.fg("border", truncatePlain("─".repeat(Math.max(0, width)), width));
  const innerWidth = width - 2;
  const metrics = loopSummaryMetrics(state, undefined);
  const barWidth = Math.max(0, innerWidth - 3);
  const filledWidth = metrics.total > 0 ? Math.round((metrics.complete / metrics.total) * barWidth) : 0;
  const filled = theme.fg("success", "━".repeat(filledWidth));
  const remaining = theme.fg("border", "─".repeat(Math.max(0, barWidth - filledWidth)));
  return theme.fg("border", "╰─ ") + filled + remaining + theme.fg("border", " ╯");
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

function renderTodoDetail(status: LoopState["todos"][number]["status"], iteration: LoopState["iterations"][number] | undefined, worker: WorkerProgress | undefined, fallbackWorker: WorkerProgress | undefined, theme: RalphTheme): string {
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
    const iterationWithModel = iteration as (LoopState["iterations"][number] & { model?: string; provider?: string }) | undefined;
    const model = displayModelName(iterationWithModel?.model);
    if (model) segments.push(theme.fg("muted", model));
    segments.push(...renderUsageSegments(iteration?.usage, theme));
    const elapsed = renderIterationElapsed(iteration);
    if (elapsed) segments.push(theme.fg("muted", elapsed));
    if (iteration?.diff) segments.push(...renderDiffSummarySegments(iteration.diff, theme));
    return segments.join(theme.fg("muted", " · "));
  }

  const placeholder = renderPlaceholderDetail(fallbackWorker, theme);
  return status === "deferred" ? theme.fg("dim", placeholder) : placeholder;
}

function renderPlaceholderDetail(worker: WorkerProgress | undefined, theme: RalphTheme): string {
  const segments: string[] = [];
  const model = displayModelName(worker?.model ?? worker?.configuredModel);
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
  const latestContextTokens = worker.latestUsage?.totalTokens;
  const contextWindow = worker.latestUsage?.contextWindow ?? worker.usage.contextWindow;
  return renderUsageSegmentsForDisplay({ ...worker.usage, ...(latestContextTokens ? { contextTokens: latestContextTokens } : {}), ...(contextWindow ? { contextWindow } : {}) }, theme);
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
  if (status === "ready") return `Loop is ready. Use ralph_orchestrator_run or /ralph-run ${state.name} --max N.`;
  if (status === "running") return `Loop is running. Chat to pause, kill, or steer the orchestrator.`;
  if (status === "completed") return "Loop is complete. Inspect artifacts or start a new loop.";
  if (status === "needs_attention") return "Loop needs attention. Inspect status and git status before running again.";
  return `Loop is paused. Run it again with /ralph-run ${state.name} when ready.`;
}

function renderIterationSummary(event: IterationCompleteEvent): string {
  const { state, iteration, todo, result } = event;
  const passed = result.verification.status === "passed";
  const lines = [
    `${passed ? "✓" : "✗"} Ralph iteration #${iteration.number} ${passed ? "completed and verified" : "needs attention"}`,
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
