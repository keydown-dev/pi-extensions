import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RalphOrchestrator, renderLoopList, renderStatus } from "../src/orchestrator.js";
import type { LoopState, OrchestratorProgress, WorkerMode, WorkerProgress, WorkerUsage } from "../src/types.js";

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
    ctx.ui.setWidget("ralph", (_tui, widgetTheme) => ({
      render: (width: number) => renderRalphWidget(state, worker, widgetTheme, width),
      invalidate: () => {},
    }));
  }

  function commandProgress(ctx: ExtensionContext): (progress: OrchestratorProgress) => void {
    return (progress) => {
      currentLoop = progress.state.name;
      updateUI(ctx, progress.state, progress.worker);
    };
  }

  function toolProgress(ctx: ExtensionContext, onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined): (progress: OrchestratorProgress) => void {
    return (progress) => {
      currentLoop = progress.state.name;
      updateUI(ctx, progress.state, progress.worker);
      onUpdate?.({
        content: [{ type: "text", text: renderProgressText(progress) }],
        details: { state: progress.state, worker: progress.worker, artifacts: iterationArtifacts(progress.state) },
      });
    };
  }

  async function startLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const argv = splitArgs(args);
    const name = argv.shift();
    if (!name) throw new Error("Usage: /ralph-start <name> [--max N] [--todo item ...]");
    const state = await new RalphOrchestrator(ctx.cwd, packageRoot).start({ name, todos: parseTodos(argv), maxIterations: parseMax(argv) });
    setCurrent(ctx, state);
    ctx.ui.notify(`Prepared Ralph loop: ${state.name}. Use /ralph-next ${state.name} to run the first worker iteration.`, "info");
  }

  async function stopLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const name = splitArgs(args).shift() ?? currentLoop;
    if (!name) throw new Error("Usage: /ralph-stop [name]");
    const state = await new RalphOrchestrator(ctx.cwd, packageRoot).stop(name);
    updateUI(ctx, state);
    ctx.ui.notify(activeJobs.has(state.name) ? `Stopping Ralph loop after the current worker exits: ${state.name}` : `Stopped Ralph loop: ${state.name}`, "info");
  }

  async function killLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const name = splitArgs(args).shift() ?? currentLoop;
    if (!name) throw new Error("Usage: /ralph-kill [name]");
    const { state, killed } = await new RalphOrchestrator(ctx.cwd, packageRoot).kill(name);
    updateUI(ctx, state);
    ctx.ui.notify(`Killed ${killed} Ralph worker process${killed === 1 ? "" : "es"} for ${state.name}. Inspect status before resuming.`, killed > 0 ? "warning" : "info");
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
    const active = currentLoop ? states.find((state) => state.name === currentLoop) : states.find((state) => state.status === "running") ?? states.find((state) => state.status === "ready");
    if (active) updateUI(ctx, active);
    ctx.ui.notify(`Ralph status:\n${active ? renderStatus(active) : renderLoopList(states)}`, "info");
  }

  async function showList(_args: string, ctx: ExtensionContext): Promise<void> {
    const states = await new RalphOrchestrator(ctx.cwd, packageRoot).list();
    ctx.ui.notify(`Ralph loops:\n${renderLoopList(states)}`, "info");
    const active = states.find((state) => state.status === "running") ?? states.find((state) => state.status === "ready");
    if (active) setCurrent(ctx, active);
  }

  async function nextLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const argv = splitArgs(args);
    const name = argv.shift() ?? currentLoop;
    if (!name) throw new Error("Usage: /ralph-next [name] [--runner pi-json] [--model MODEL]");
    startBackgroundLoop(ctx, name, `Ralph iteration for ${name}`, async () => {
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).next(name, { workerMode: parseRunner(argv), workerModel: parseModel(argv), onProgress: commandProgress(ctx) });
      return { state, message: `Ralph iteration ${state.currentIteration} finished with status ${state.status}` };
    });
  }

  async function runLoop(args: string, ctx: ExtensionContext): Promise<void> {
    const argv = splitArgs(args);
    const name = argv.shift() ?? currentLoop;
    if (!name) throw new Error("Usage: /ralph-run [name] [--max N] [--runner pi-json] [--model MODEL]");
    const maxIterations = parseMax(argv) ?? 1;
    startBackgroundLoop(ctx, name, `Ralph run for ${name}`, async () => {
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).run(name, { maxIterations, workerMode: parseRunner(argv), workerModel: parseModel(argv), onProgress: commandProgress(ctx) });
      return { state, message: `Ralph run stopped at ${state.currentIteration} (${state.status})` };
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
        setCurrent(ctx, state.status === "ready" || state.status === "running" ? state : state.status === "stopped" ? state : null);
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

  pi.registerCommand("ralph-start", {
    description: "Start a Ralph orchestrator loop",
    handler: async (args, ctx) => {
      try {
        await startLoop(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("ralph-stop", {
    description: "Stop active Ralph orchestrator loop",
    handler: async (args, ctx) => {
      try {
        await stopLoop(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("ralph-kill", {
    description: "Kill active Ralph worker process and stop the loop",
    handler: async (args, ctx) => {
      try {
        await killLoop(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("ralph-status", {
    description: "Show current or named Ralph loop status",
    handler: async (args, ctx) => {
      try {
        await showStatus(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("ralph-list", {
    description: "List Ralph orchestrator loops",
    handler: async (args, ctx) => {
      try {
        await showList(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("ralph-next", {
    description: "Run the next single Ralph worker iteration",
    handler: async (args, ctx) => {
      try {
        await nextLoop(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("ralph-run", {
    description: "Run one or more Ralph worker iterations",
    handler: async (args, ctx) => {
      try {
        await runLoop(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
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
      const orchestrator = new RalphOrchestrator(ctx.cwd, packageRoot);

      try {
        if (subcommand === "start") {
          await startLoop(argv.join(" "), ctx);
          return;
        }

        if (subcommand === "plan") {
          const prompt = buildPlanPrompt(argv.join(" "));
          ctx.ui.notify("Starting Ralph planning interview. The agent should grill, plan, and ask for approval before starting a loop.", "info");
          pi.sendUserMessage(prompt);
          return;
        }

        if (subcommand === "run") {
          await runLoop(argv.join(" "), ctx);
          return;
        }

        if (subcommand === "next") {
          await nextLoop(argv.join(" "), ctx);
          return;
        }

        if (subcommand === "resume") {
          const name = argv.shift();
          if (!name) throw new Error("Usage: /ralph resume <name>");
          const state = await orchestrator.resume(name);
          setCurrent(ctx, state);
          ctx.ui.notify(`Resumed Ralph loop: ${state.name}`, "info");
          return;
        }

        if (subcommand === "stop") {
          await stopLoop(argv.join(" "), ctx);
          return;
        }

        if (subcommand === "kill") {
          await killLoop(argv.join(" "), ctx);
          return;
        }

        if (subcommand === "status") {
          await showStatus(argv.join(" "), ctx);
          return;
        }

        if (subcommand === "list") {
          await showList(argv.join(" "), ctx);
          return;
        }

        ctx.ui.notify(HELP, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_plan",
    label: "Plan Ralph Loop",
    description: "Start a Ralph planning interview before creating a loop. Use when the user wants to design, grill, or preconfigure a Ralph loop before execution.",
    promptSnippet: "Plan a Ralph loop by grilling requirements, deriving todos/issues, verification standards, and worker skill guidance before calling ralph_orchestrator_start.",
    promptGuidelines: [
      "Use ralph_orchestrator_plan when the user asks to plan or preconfigure a Ralph loop before starting.",
      "Do not start the loop until the user approves the plan; then call ralph_orchestrator_start with the approved todos and max iterations.",
      "After start, the loop is ready but not executed; offer ralph_orchestrator_next or ralph_orchestrator_run if the user wants to proceed.",
    ],
    parameters: Type.Object({
      request: Type.String({ description: "The user's planning request or goal" }),
    }),
    async execute(_toolCallId, params) {
      pi.sendUserMessage(buildPlanPrompt(params.request), { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued a Ralph planning interview. I will grill the plan, derive loop issues/todos, define validation standards, and ask approval before starting." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_start",
    label: "Start Ralph Orchestrator",
    description: "Create a Ralph orchestrator loop from a natural-language task. Use when the user asks to set up a Ralph loop, work through issues iteratively, or run a bounded number of loops.",
    promptSnippet: "Create a Ralph orchestrator loop with a plan, todo list, and max-iteration setting.",
    promptGuidelines: [
      "Use ralph_orchestrator_start when the user asks conversationally to set up a Ralph loop or work through a plan/issues over multiple iterations.",
      "Build taskContent as markdown with goals, checklist items, verification expectations, and any max-loop limit mentioned by the user.",
      "Tell the user that start only creates the loop. Use ralph_orchestrator_next or ralph_orchestrator_run to execute workers.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Short loop name, e.g. get-through-issues" }),
      taskContent: Type.String({ description: "Markdown plan with goals, checklist, notes, and verification expectations" }),
      maxIterations: Type.Optional(Type.Number({ description: "Maximum number of loop iterations" })),
      todos: Type.Optional(Type.Array(Type.String(), { description: "Concrete checklist items extracted from taskContent" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const orchestrator = new RalphOrchestrator(ctx.cwd, packageRoot);
      const todos = params.todos?.length ? params.todos : extractTodos(params.taskContent);
      const state = await orchestrator.start({ name: params.name, todos, maxIterations: params.maxIterations });
      setCurrent(ctx, state);
      return {
        content: [{ type: "text", text: renderToolResponse(state, `Created Ralph orchestrator loop "${state.name}" with ${state.todos.length} todos${state.maxIterations ? ` and max ${state.maxIterations} iterations` : ""}. Loop created but not executed.`) }],
        details: { state, nextAction: nextActionForState(state) },
      };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_next",
    label: "Run Ralph Iteration",
    description: "Run exactly one worker iteration for a ready or running Ralph orchestrator loop.",
    promptSnippet: "Run the next Ralph worker iteration and inspect the returned status/artifacts before deciding whether to continue.",
    promptGuidelines: [
      "Use after ralph_orchestrator_start when the user wants to execute one bounded iteration.",
      "Do not call repeatedly without checking status and user intent unless the user asked for autonomous running.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })),
      runner: Type.Optional(Type.String({ description: "Worker runner: pi-json (default) or scripted." })),
      model: Type.Optional(Type.String({ description: "Pi model pattern/ID for the child worker, e.g. openai/gpt-4o or sonnet:high." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Ralph loop name provided and no active loop is set.");
      if (activeJobs.has(name)) throw new Error(`Ralph loop is already running: ${name}`);
      currentLoop = name;
      const job = new RalphOrchestrator(ctx.cwd, packageRoot)
        .next(name, { workerMode: parseRunnerValue(params.runner), workerModel: params.model, onProgress: commandProgress(ctx) })
        .then((state) => {
          setCurrent(ctx, state.status === "ready" || state.status === "running" ? state : state.status === "stopped" ? state : null);
          ctx.ui.notify(`Ralph iteration ${state.currentIteration} finished with status ${state.status}`, "info");
        })
        .catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"))
        .finally(() => activeJobs.delete(name));
      activeJobs.set(name, job);
      return {
        content: [{ type: "text", text: `Started Ralph iteration for "${name}" in the background. You can keep chatting; progress will update in the Ralph widget.` }],
        details: { state: { name, status: "running" }, nextAction: `Continue chatting normally, or use /ralph-stop ${name} to stop after the current worker exits.` },
      };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_run",
    label: "Run Ralph Loop",
    description: "Run one or more worker iterations for a ready or running Ralph orchestrator loop.",
    promptSnippet: "Run a Ralph loop for a bounded number of iterations, then inspect status and artifacts.",
    promptGuidelines: [
      "Use when the user explicitly asks to run a loop or continue for a bounded iteration count.",
      "Default to one iteration unless the user supplied a max iteration count.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })),
      maxIterations: Type.Optional(Type.Number({ description: "Maximum number of worker iterations to run in this call." })),
      runner: Type.Optional(Type.String({ description: "Worker runner: pi-json (default) or scripted." })),
      model: Type.Optional(Type.String({ description: "Pi model pattern/ID for the child worker, e.g. openai/gpt-4o or sonnet:high." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Ralph loop name provided and no active loop is set.");
      if (activeJobs.has(name)) throw new Error(`Ralph loop is already running: ${name}`);
      currentLoop = name;
      const maxIterations = params.maxIterations ?? 1;
      const job = new RalphOrchestrator(ctx.cwd, packageRoot)
        .run(name, { maxIterations, workerMode: parseRunnerValue(params.runner), workerModel: params.model, onProgress: commandProgress(ctx) })
        .then((state) => {
          setCurrent(ctx, state.status === "ready" || state.status === "running" ? state : state.status === "stopped" ? state : null);
          ctx.ui.notify(`Ralph run stopped at ${state.currentIteration} (${state.status})`, "info");
        })
        .catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"))
        .finally(() => activeJobs.delete(name));
      activeJobs.set(name, job);
      return {
        content: [{ type: "text", text: `Started Ralph run for "${name}" in the background. You can keep chatting; progress will update in the Ralph widget.` }],
        details: { state: { name, status: "running", maxIterations }, nextAction: `Continue chatting normally, or use /ralph-stop ${name} to stop after the current worker exits.` },
      };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_stop",
    label: "Stop Ralph Loop",
    description: "Pause/stop a Ralph loop after the current worker iteration exits. Does not kill the active child process.",
    promptSnippet: "Stop or pause the active Ralph loop after the current worker exits.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Ralph loop name provided and no active loop is set.");
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).stop(name);
      updateUI(ctx, state);
      return {
        content: [{ type: "text", text: renderToolResponse(state, activeJobs.has(state.name) ? `Ralph loop \"${state.name}\" will stop after the current worker exits.` : `Stopped Ralph loop \"${state.name}\".`) }],
        details: { state, nextAction: nextActionForState(state) },
      };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_resume",
    label: "Resume Ralph Loop",
    description: "Resume a stopped Ralph loop by setting it back to ready. The next/run tool starts the next worker iteration.",
    promptSnippet: "Resume a stopped Ralph loop after checking status and any partial work.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Ralph loop name provided and no active loop is set.");
      const state = await new RalphOrchestrator(ctx.cwd, packageRoot).resume(name);
      setCurrent(ctx, state);
      return {
        content: [{ type: "text", text: renderToolResponse(state, `Resumed Ralph loop \"${state.name}\". It is ready; no worker was started.`) }],
        details: { state, nextAction: nextActionForState(state) },
      };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_kill",
    label: "Kill Ralph Worker",
    description: "Kill active child Pi worker processes for a Ralph loop, then leave the loop stopped for inspection/recovery.",
    promptSnippet: "Kill the active Ralph worker only when the user asks for an immediate stop/abort/kill.",
    promptGuidelines: [
      "Use ralph_orchestrator_kill only for immediate abort/kill requests, not ordinary pause/stop requests.",
      "After killing, inspect status and git status before resuming; partial worker edits may remain in the worktree.",
      "A killed child Pi process cannot be resumed. Resume the Ralph loop by cleaning up or accepting partial work, then starting a new iteration.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = params.name ?? currentLoop;
      if (!name) throw new Error("No Ralph loop name provided and no active loop is set.");
      const { state, killed } = await new RalphOrchestrator(ctx.cwd, packageRoot).kill(name);
      updateUI(ctx, state);
      return {
        content: [{ type: "text", text: `${killed > 0 ? "Killed" : "No active worker process found for"} Ralph loop \"${state.name}\" (${killed} process${killed === 1 ? "" : "es"}).\n\nInspect status and git status before resuming; partial edits may remain.` }],
        details: { state, killed, nextAction: "Inspect ralph_orchestrator_status and git status. If partial edits are unwanted, reset/clean them before ralph_orchestrator_resume and ralph_orchestrator_run." },
      };
    },
  });

  pi.registerTool({
    name: "ralph_orchestrator_status",
    label: "Ralph Status",
    description: "Inspect status for the active or named Ralph orchestrator loop.",
    promptSnippet: "Check Ralph loop status before deciding whether to continue, stop, or inspect artifacts.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Loop name. Defaults to the current active loop when available." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const orchestrator = new RalphOrchestrator(ctx.cwd, packageRoot);
      const name = params.name ?? currentLoop;
      if (!name) {
        const states = await orchestrator.list();
        return {
          content: [{ type: "text", text: `Ralph loops:\n${renderLoopList(states)}` }],
          details: { states, nextAction: states.length ? "Pick a loop name, then call ralph_orchestrator_status or ralph_orchestrator_run." : "Create a loop with ralph_orchestrator_start." },
        };
      }
      const state = await orchestrator.status(name);
      updateUI(ctx, state);
      return {
        content: [{ type: "text", text: renderToolResponse(state, `Status for Ralph loop "${state.name}".`) }],
        details: { state, nextAction: nextActionForState(state), artifacts: iterationArtifacts(state) },
      };
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
      const active = states.find((state) => state.status === "running") ?? states.find((state) => state.status === "ready") ?? null;
      if (active) setCurrent(ctx, active);
      return {
        content: [{ type: "text", text: `Ralph loops:\n${renderLoopList(states)}` }],
        details: { states, nextAction: active ? `Active candidate: ${active.name}. Call ralph_orchestrator_status or ralph_orchestrator_run next.` : "Create a loop with ralph_orchestrator_start." },
      };
    },
  });

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (/\bralph\b/i.test(event.text) && /\b(loop|loops|iterate|iterations|issues?|pause|resume|stop|kill|abort)\b/i.test(event.text) && !event.text.startsWith("/")) {
      return {
        action: "transform" as const,
        text: `${event.text}\n\nIf this is a request to create, manage, pause, resume, stop, kill, or inspect a Ralph loop, use the ralph_orchestrator_start, ralph_orchestrator_next, ralph_orchestrator_run, ralph_orchestrator_stop, ralph_orchestrator_resume, ralph_orchestrator_kill, ralph_orchestrator_status, or ralph_orchestrator_list tools as appropriate.`,
      };
    }
    return { action: "continue" as const };
  });

  pi.on("session_start", async (_event, ctx) => {
    const states = await new RalphOrchestrator(ctx.cwd, packageRoot).list();
    const active = states.find((state) => state.status === "running") ?? states.find((state) => state.status === "ready") ?? null;
    currentLoop = active?.name ?? null;
    updateUI(ctx, active);
  });
}

const HELP = `Ralph Orchestrator - fresh-context development loops

Primary commands:
  /ralph-plan <goal>                               Plan/grill a loop before starting
  /ralph-start <name> [--max N] [--todo item ...]  Start a loop
  /ralph-stop [name]                               Stop after the current worker exits
  /ralph-kill [name]                               Kill the current Ralph worker process and stop
  /ralph-status [name]                             Show current or named loop status
  /ralph-list                                      List all loops
  /ralph-next [name] [--runner pi-json] [--model MODEL]          Run one fresh Pi worker iteration
  /ralph-run [name] [--max N] [--runner pi-json] [--model MODEL] Run one or more worker iterations

Other commands:
  /ralph plan <goal>                               Alias for /ralph-plan
  /ralph resume <name>                             Resume stopped loop
  /ralph kill [name]                               Alias for /ralph-kill

Compatibility aliases:
  /ralph start <name> [--max N]
  /ralph stop [name]
  /ralph kill [name]
  /ralph next [name]
  /ralph run [name] [--max N]

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

function renderProgressText(progress: OrchestratorProgress): string {
  return `${progress.message}\n\n${renderStatusWithProgress(progress.state, progress.worker)}`;
}

type RalphTheme = ExtensionContext["ui"]["theme"];

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function renderRalphWidget(state: LoopState, worker: WorkerProgress | undefined, theme: RalphTheme, width: number): string[] {
  const completed = state.todos.filter((todo) => todo.status === "completed").length;
  const max = state.maxIterations ? `/${state.maxIterations}` : "";
  const rule = theme.fg("accent", "─".repeat(Math.max(0, width)));
  const lines: string[] = [
    rule,
    theme.fg("accent", theme.bold(`Ralph Loop · ${state.name} · Iteration ${state.currentIteration}${max} · Todos ${completed}/${state.todos.length}`)),
    "",
  ];

  for (const todo of state.todos) {
    const iteration = latestIterationForTodo(state, todo.id);
    const isRunning = todo.status === "running";
    const prefix = isRunning ? theme.fg("accent", "› ") : "  ";
    const icon = todoGlyph(todo.status, worker?.elapsedMs);
    const iconColor = todo.status === "completed" ? "success" : todo.status === "failed" ? "error" : todo.status === "running" ? "accent" : "dim";
    const titleColor = todo.status === "running" ? "accent" : todo.status === "pending" ? "text" : "muted";
    lines.push(`${prefix}${theme.fg(iconColor, icon)} ${theme.fg(titleColor, `#${todo.id} ${todo.title}`)}`);
    lines.push(`  ${renderTodoDetail(todo.status, iteration, isRunning ? worker : undefined, theme)}`);
    lines.push("");
  }

  lines.push(rule);
  lines.push(theme.fg("dim", "Chat to pause, resume, stop, or steer Ralph · /ralph-kill kills the active worker"));
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
    return [
      theme.fg("muted", `running · ${formatElapsed(worker.elapsedMs)}`),
      model ? theme.fg("muted", ` · ${model}`) : "",
      theme.fg("muted", tools),
      renderContextUsage(worker, theme),
    ].join("");
  }

  if (status === "completed" || status === "failed") {
    const verification = iteration?.verification?.status;
    const verificationText = verification === "passed" ? theme.fg("success", "verification ok") : verification === "failed" ? theme.fg("error", "verification failed") : theme.fg("warning", "verification not run");
    const diff = iteration?.diff ? `${renderDiffStats(iteration.diff, theme)} · ` : "";
    const result = status === "completed" ? theme.fg("success", "passed") : theme.fg("error", "failed");
    return `${result} · ${diff}${verificationText}`;
  }

  return theme.fg("dim", "pending");
}

function renderDiffStats(diff: NonNullable<LoopState["iterations"][number]["diff"]>, theme: RalphTheme): string {
  return [
    theme.fg("success", `+${diff.insertions}`),
    theme.fg("muted", " / "),
    theme.fg("error", `-${diff.deletions}`),
    theme.fg("muted", ` · ${diff.filesChanged} files`),
  ].join("");
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
  return SPINNER_FRAMES[Math.floor(elapsedMs / 120) % SPINNER_FRAMES.length] ?? "⠋";
}

function statusGlyph(status: LoopState["status"]): string {
  return status === "running" ? spinnerFrame() : status === "ready" ? "●" : status === "completed" ? "✓" : status === "failed" ? "✗" : status === "stopped" ? "⏸" : "○";
}

function todoGlyph(status: LoopState["todos"][number]["status"], elapsedMs?: number): string {
  return status === "running" ? spinnerFrame(elapsedMs) : status === "pending" ? "○" : status === "completed" ? "✓" : "✗";
}

function renderStatusWithProgress(state: LoopState, worker?: WorkerProgress): string {
  if (!worker) return renderStatus(state);
  return `${renderStatus(state)}\n\n${renderWorkerProgress(worker)}`;
}

function renderWorkerProgress(worker: WorkerProgress): string {
  const model = worker.model ? ` · model ${worker.provider ? `${worker.provider}/` : ""}${worker.model}` : worker.configuredModel ? ` · model ${worker.configuredModel}` : "";
  const names = worker.toolNames.length ? ` · tools: ${worker.toolNames.slice(-4).join(", ")}` : "";
  const latest = worker.latestUsage ? ` · latest context ${formatUsage(worker.latestUsage)}` : "";
  const total = worker.usage.totalTokens > 0 ? ` · total ${formatUsage(worker.usage)}` : "";
  return `Worker: ${worker.phase}${model} · ${formatElapsed(worker.elapsedMs)} · events ${worker.events} · tool calls ${worker.toolCalls} · assistant messages ${worker.assistantMessages}${latest}${total}${names}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatUsage(usage: WorkerUsage): string {
  const cost = usage.cost ? ` · $${usage.cost.toFixed(4)}` : "";
  return `${usage.totalTokens.toLocaleString()} tok (in ${usage.input.toLocaleString()}, out ${usage.output.toLocaleString()}, cache ${usage.cacheRead.toLocaleString()})${cost}`;
}

function nextActionForState(state: LoopState): string {
  if (state.status === "ready") return `Loop is ready but not executing. Use ralph_orchestrator_next for one iteration, ralph_orchestrator_run to continue, or /ralph-run ${state.name} --max N.`;
  if (state.status === "running") return `Loop is running. Check status with ralph_orchestrator_status ${state.name} before continuing.`;
  if (state.status === "completed") return "Loop is complete. Inspect artifacts or start a new loop.";
  if (state.status === "failed") return "Loop failed. Inspect the latest iteration artifacts and verification before retrying.";
  if (state.status === "stopped") return `Loop is stopped. Resume with /ralph resume ${state.name} if you want to continue.`;
  return "Inspect status and artifacts before deciding the next step.";
}

function iterationArtifacts(state: LoopState): Record<string, string> {
  const base = path.join(".ralph", "orchestrator", "loops", state.name);
  const artifacts: Record<string, string> = {
    loopDir: base,
    plan: path.join(base, "plan.md"),
    state: path.join(base, "state.json"),
  };
  if (state.currentIteration > 0) {
    const iterationDir = path.join(base, "iterations", String(state.currentIteration).padStart(3, "0"));
    artifacts.iterationDir = iterationDir;
    artifacts.handoffOut = path.join(iterationDir, "handoff-out.md");
    artifacts.verification = path.join(iterationDir, "verification.md");
    artifacts.workerOutput = path.join(iterationDir, "worker-output.jsonl");
  }
  return artifacts;
}
