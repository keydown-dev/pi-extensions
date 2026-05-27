import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deriveLoopStatus, RalphOrchestrator, renderLoopList, renderStatus } from "../src/orchestrator.js";
import type { IterationCompleteEvent, LoopState, OrchestratorProgress, WorkerMode, WorkerProgress, WorkerUsage } from "../src/types.js";

let currentLoop: string | null = null;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const activeJobs = new Map<string, Promise<void>>();

export default function (pi: ExtensionAPI) {
  function setCurrent(ctx: ExtensionContext, state: LoopState | null): void {
    currentLoop = state?.name ?? null;
    updateUI(ctx, state);
  }

  function updateUI(ctx: ExtensionContext, state?: LoopState | null, worker?: WorkerProgress): void {
    if (!ctx.hasUI) return;
    if (!state) {
      ctx.ui.setStatus("ralph", undefined);
      ctx.ui.setWidget("ralph", undefined);
      return;
    }
    ctx.ui.setStatus("ralph", undefined);
    ctx.ui.setWidget("ralph", (tui, widgetTheme) => {
      const interval = state.todos.some((todo) => todo.status === "running") ? setInterval(() => tui.requestRender(), PI_WORKING_SPINNER_INTERVAL_MS) : undefined;
      return {
        render: (width: number) => renderRalphWidget(state, worker, widgetTheme, width),
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
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).run(name, { maxIterations, workerMode: parseRunner(argv), workerModel: parseModel(argv), onProgress: commandProgress(ctx), onIterationComplete: postIterationSummary });
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
        .run(name, { maxIterations, workerMode: parseRunnerValue(params.runner), workerModel: params.model, onProgress: commandProgress(ctx), onIterationComplete: postIterationSummary })
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
    if (/\bralph\b/i.test(event.text) && /\b(loop|loops|iterate|iterations|issues?|pause|resume|run|kill|abort|status|list)\b/i.test(event.text) && !event.text.startsWith("/")) {
      return { action: "transform" as const, text: `${event.text}\n\nIf this is a request to create, manage, pause, resume by running, kill, or inspect a Ralph loop, use ralph_orchestrator_start, ralph_orchestrator_run, ralph_orchestrator_pause, ralph_orchestrator_kill, ralph_orchestrator_status, or ralph_orchestrator_list as appropriate.` };
    }
    return { action: "continue" as const };
  });

  pi.on("session_start", async (_event, ctx) => {
    const states = await new RalphOrchestrator(ctx.cwd, packageRoot).list();
    const active = states.find((state) => deriveLoopStatus(state) === "running") ?? states.find((state) => deriveLoopStatus(state) === "ready") ?? null;
    currentLoop = active?.name ?? null;
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

type RalphTheme = ExtensionContext["ui"]["theme"];
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PI_WORKING_SPINNER_INTERVAL_MS = 80;

export function renderRalphWidget(state: LoopState, worker: WorkerProgress | undefined, theme: RalphTheme, width: number): string[] {
  const completed = state.todos.filter((todo) => todo.status === "complete").length;
  const max = state.maxIterations ? `/${state.maxIterations}` : "";
  const rule = theme.fg("accent", "─".repeat(Math.max(0, width)));
  const lines: string[] = [rule, theme.fg("accent", theme.bold(`Ralph Loop · ${state.name} · ${deriveLoopStatus(state)} · Iteration ${state.currentIteration}${max} · Todos ${completed}/${state.todos.length}`)), ""];

  for (const todo of state.todos) {
    const iteration = latestIterationForTodo(state, todo.id);
    const isRunning = todo.status === "running";
    const prefix = isRunning ? theme.fg("accent", "› ") : "  ";
    const icon = todoGlyph(todo.status);
    const iconColor = todo.status === "complete" ? "success" : todo.status === "failed" || todo.status === "interrupted" ? "error" : todo.status === "running" ? "accent" : "dim";
    const titleColor = todo.status === "running" ? "accent" : todo.status === "queued" ? "text" : "muted";
    lines.push(`${prefix}${theme.fg(iconColor, icon)} ${theme.fg(titleColor, `#${todo.id} ${todo.title}`)}`);
    lines.push(`  ${renderTodoDetail(todo.status, iteration, isRunning ? worker : undefined, theme)}`);
    lines.push("");
  }

  lines.push(rule);
  lines.push(theme.fg("dim", "Chat to pause, resume, kill or steer the orchestrator."));
  return lines.map((line) => truncateAnsiToWidth(line, width));
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

function latestIterationForTodo(state: LoopState, todoId: number): LoopState["iterations"][number] | undefined {
  for (let index = state.iterations.length - 1; index >= 0; index--) {
    const iteration = state.iterations[index];
    if (iteration?.todoId === todoId) return iteration;
  }
  return undefined;
}

function renderTodoDetail(status: LoopState["todos"][number]["status"], iteration: LoopState["iterations"][number] | undefined, worker: WorkerProgress | undefined, theme: RalphTheme): string {
  if (status === "running" && worker) {
    const model = worker.model ? `${worker.provider ? `${worker.provider}/` : ""}${worker.model}` : worker.configuredModel;
    const tools = worker.toolNames.length ? ` · tools ${worker.toolNames.slice(-3).join(", ")}` : ` · ${worker.toolCalls} tools`;
    return [theme.fg("muted", `running · ${formatElapsed(worker.elapsedMs)}`), model ? theme.fg("muted", ` · ${model}`) : "", theme.fg("muted", tools), renderContextUsage(worker, theme)].join("");
  }

  if (status === "complete" || status === "failed" || status === "interrupted") {
    const verification = iteration?.verification?.status;
    const result = status === "complete" ? theme.fg("success", "passed") : status === "interrupted" ? theme.fg("warning", "interrupted") : theme.fg("error", "failed");
    const segments = [result];
    if (iteration?.diff) segments.push(renderDiffStats(iteration.diff, theme));
    if (iteration?.usage) segments.push(renderCompactUsage(iteration.usage, theme));
    if (verification === "failed") segments.push(theme.fg("error", "✗ verification"));
    if (verification === "not_run" || !verification) segments.push(theme.fg("error", "✗ verification not run"));
    return segments.join(theme.fg("muted", " · "));
  }

  if (status === "deferred") return theme.fg("dim", "deferred");
  return theme.fg("dim", "queued");
}

function renderDiffStats(diff: NonNullable<LoopState["iterations"][number]["diff"]>, theme: RalphTheme): string {
  return [theme.fg("success", `+${diff.insertions}`), theme.fg("muted", " / "), theme.fg("error", `-${diff.deletions}`), theme.fg("muted", ` · ${diff.filesChanged} files`)].join("");
}

function renderCompactUsage(usage: WorkerUsage, theme: RalphTheme): string {
  if (!usage.totalTokens) return "";
  const cost = usage.cost && usage.cost > 0 ? ` · $${usage.cost.toFixed(4)}` : "";
  return theme.fg("muted", `${formatTokenCount(usage.totalTokens)} tok${cost}`);
}

function renderContextUsage(worker: WorkerProgress, theme: RalphTheme): string {
  const usage = worker.latestUsage ?? worker.usage;
  if (!usage.totalTokens) return "";
  const contextWindow = inferContextWindow(worker.model ?? worker.configuredModel);
  if (!contextWindow) return theme.fg("muted", ` · ctx ${formatTokenCount(usage.totalTokens)}`);
  const percent = Math.round((usage.totalTokens / contextWindow) * 100);
  const color = percent > 50 ? "error" : percent >= 40 ? "warning" : "success";
  return theme.fg(color, ` · ctx ${formatTokenCount(usage.totalTokens)} / ${formatTokenCount(contextWindow)} ${percent}%`);
}

function inferContextWindow(model: string | undefined): number | undefined {
  const normalized = model?.toLowerCase() ?? "";
  if (!normalized) return undefined;
  if (normalized.includes("gemini-1.5") || normalized.includes("gemini-2")) return 1_000_000;
  if (normalized.includes("claude") || normalized.includes("sonnet") || normalized.includes("opus") || normalized.includes("haiku")) return 200_000;
  if (normalized.includes("gpt-4o") || normalized.includes("gpt-4.1") || normalized.includes("o3") || normalized.includes("o4")) return 128_000;
  return undefined;
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
  return status === "running" ? spinnerFrame(elapsedMs) : status === "queued" ? "○" : status === "complete" ? "✓" : status === "deferred" ? "◌" : status === "interrupted" ? "!" : "✗";
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
    `Status: ${todo.status}`,
  ];

  if (iteration.diff) lines.push(`Changed: ${plainDiffStats(iteration.diff)}`);
  const files = iteration.changedFiles ?? result.changedFiles;
  if (files.length) lines.push("Files:", ...files.map((file) => `- ${file}`));
  const usage = iteration.usage ?? result.usage;
  if (usage?.totalTokens) lines.push(`Used: ${formatUsage(usage)}`);

  lines.push("Verification:");
  for (const command of result.verification.commands) {
    lines.push(`- ${command.command} → ${command.exitCode}: ${command.summary}`);
  }
  if (result.verification.notes) lines.push(`Notes: ${result.verification.notes}`);
  lines.push("", "Summary:", result.summary || "Worker did not provide a summary.");
  return lines.join("\n");
}

function plainDiffStats(diff: NonNullable<LoopState["iterations"][number]["diff"]>): string {
  return `+${diff.insertions} / -${diff.deletions} · ${diff.filesChanged} files`;
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
