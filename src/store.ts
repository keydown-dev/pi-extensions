import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { IterationState, LoopState, RalphTodo, TodoStatus, VerificationRecord, WorkerResult } from "./types.js";
import { ROOT_DIR, iterationDir, loopDir, statePath, slugifyLoopName } from "./paths.js";

export class RalphStore {
  constructor(private readonly cwd: string) {}

  getLoopDir(name: string): string {
    return loopDir(this.cwd, name);
  }

  getIterationDir(name: string, iteration: number): string {
    return iterationDir(this.cwd, name, iteration);
  }

  async exists(name: string): Promise<boolean> {
    try {
      await fs.access(statePath(this.cwd, name));
      return true;
    } catch {
      return false;
    }
  }

  async createLoop(name: string, todos: string[], branch: string, maxIterations?: number): Promise<LoopState> {
    const now = new Date().toISOString();
    const state: LoopState = {
      name: slugifyLoopName(name),
      control: "active",
      branch,
      currentIteration: 0,
      createdAt: now,
      updatedAt: now,
      maxIterations,
      todos: todos.map<RalphTodo>((title, index) => ({ id: semanticTodoId(title, index), title, status: initialTodoStatus(index, maxIterations) })),
      iterations: [],
    };
    await fs.mkdir(path.join(this.getLoopDir(name), "iterations"), { recursive: true });
    await fs.writeFile(path.join(this.getLoopDir(name), "plan.md"), renderPlan(state), "utf8");
    await fs.writeFile(path.join(this.getLoopDir(name), "decisions.md"), `# Decisions: ${state.name}\n\n`, "utf8");
    await this.writeState(state);
    return state;
  }

  async readState(name: string): Promise<LoopState> {
    const filePath = statePath(this.cwd, name);
    return parseLoopStateJson(await fs.readFile(filePath, "utf8"), filePath);
  }

  async listStates(): Promise<LoopState[]> {
    const root = path.join(this.cwd, ROOT_DIR, "loops");
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      return [];
    }

    const states: LoopState[] = [];
    for (const entry of entries) {
      try {
        const filePath = path.join(root, entry, "state.json");
        states.push(parseLoopStateJson(await fs.readFile(filePath, "utf8"), filePath));
      } catch {
        // Ignore malformed/incomplete loop dirs in list output.
      }
    }
    return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async writeState(state: LoopState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await fs.mkdir(this.getLoopDir(state.name), { recursive: true });
    await fs.writeFile(statePath(this.cwd, state.name), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(this.getLoopDir(state.name), "plan.md"), renderPlan(state), "utf8");
  }

  async createIterationFiles(state: LoopState, iteration: IterationState, todo: RalphTodo): Promise<void> {
    const dir = this.getIterationDir(state.name, iteration.number);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "handoff-in.md"), renderHandoffIn(state, iteration, todo), "utf8");
    await fs.writeFile(path.join(dir, "verification.md"), "# Verification\n\n_Status: not_run_\n", "utf8");
    await fs.writeFile(path.join(dir, "worker-output.jsonl"), "", "utf8");
  }

  async writeWorkerArtifacts(state: LoopState, iteration: IterationState, result: WorkerResult): Promise<void> {
    const dir = this.getIterationDir(state.name, iteration.number);
    const handoffOut = path.join(dir, "handoff-out.md");
    if (!(await fileExists(handoffOut))) {
      await fs.writeFile(handoffOut, renderHandoffOut(iteration, result), "utf8");
    }
    await fs.writeFile(path.join(dir, "verification.md"), renderVerification(result.verification), "utf8");
    await fs.appendFile(path.join(dir, "worker-output.jsonl"), `${JSON.stringify({ type: "worker_result", result })}\n`, "utf8");
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function initialTodoStatus(index: number, maxIterations: number | undefined): TodoStatus {
  return maxIterations && index >= maxIterations ? "deferred" : "queued";
}

function semanticTodoId(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "") || "todo";
  return `${String(index + 1).padStart(3, "0")}-${slug}`;
}

function renderPlan(state: LoopState): string {
  const lines = [`# Ralph loop: ${state.name}`, "", `Control: ${state.control}`, "", "## Todo", ""];
  for (const todo of state.todos) {
    const box = todo.status === "complete" ? "x" : " ";
    lines.push(`- [${box}] ${todo.id}. ${todo.title} (${todo.status})`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderHandoffIn(state: LoopState, iteration: IterationState, todo: RalphTodo): string {
  return `# Ralph handoff-in\n\nLoop: ${state.name}\nIteration: ${iteration.number}\nTodo: ${todo.id}. ${todo.title}\n\n## Task\n\nComplete exactly this todo item. Keep changes bounded and record verification.\n\n## Required output\n\nProduce handoff-out.md and verification.md for this iteration. Include a ## Commit subject section in handoff-out.md with one short single-line commit subject that follows this project's commit style when you can infer it.\n`;
}

function renderHandoffOut(iteration: IterationState, result: { summary: string; changedFiles: string[]; commitSubject?: string }): string {
  const commitSubject = result.commitSubject ? `\n## Commit subject\n\n${result.commitSubject}\n` : "";
  return `# Ralph handoff-out\n\nIteration: ${iteration.number}\n\n## Summary\n\n${result.summary}\n\n## Changed files\n\n${result.changedFiles.map((file) => `- ${file}`).join("\n")}\n${commitSubject}`;
}

function renderVerification(verification: VerificationRecord): string {
  const lines = ["# Verification", "", `Status: ${verification.status}`, "", "## Commands", ""];
  for (const command of verification.commands) {
    lines.push(`- \`${command.command}\` → ${command.exitCode}: ${command.summary}`);
  }
  if (verification.notes) lines.push("", "## Notes", "", verification.notes);
  lines.push("");
  return lines.join("\n");
}

const VerificationRecordSchema = Type.Object({
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
  commands: Type.Array(Type.Object({
    command: Type.String(),
    exitCode: Type.Number(),
    summary: Type.String(),
  }, { additionalProperties: false })),
  notes: Type.Optional(Type.String()),
}, { additionalProperties: false });

const IterationDiffStatsSchema = Type.Object({
  filesChanged: Type.Number(),
  insertions: Type.Number(),
  deletions: Type.Number(),
}, { additionalProperties: false });

const WorkerUsageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  totalTokens: Type.Number(),
  cost: Type.Optional(Type.Number()),
  contextTokens: Type.Optional(Type.Number()),
  contextWindow: Type.Optional(Type.Number()),
}, { additionalProperties: false });

const IterationStateSchema = Type.Object({
  number: Type.Number(),
  status: Type.Union([
    Type.Literal("planned"),
    Type.Literal("running"),
    Type.Literal("candidate"),
    Type.Literal("accepted"),
    Type.Literal("rejected"),
    Type.Literal("failed"),
    Type.Literal("aborted"),
  ]),
  todoId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  beforeRef: Type.String(),
  afterRef: Type.Optional(Type.String()),
  workerBranch: Type.Optional(Type.String()),
  startedAt: Type.String(),
  completedAt: Type.Optional(Type.String()),
  verification: Type.Optional(VerificationRecordSchema),
  diff: Type.Optional(IterationDiffStatsSchema),
  usage: Type.Optional(WorkerUsageSchema),
  summary: Type.Optional(Type.String()),
  changedFiles: Type.Optional(Type.Array(Type.String())),
  commitSubject: Type.Optional(Type.String()),
}, { additionalProperties: false });

const RalphTodoSchema = Type.Object({
  id: Type.Union([Type.String(), Type.Number()]),
  title: Type.String(),
  status: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("complete"),
    Type.Literal("deferred"),
    Type.Literal("failed"),
    Type.Literal("interrupted"),
  ]),
}, { additionalProperties: false });

const LoopStateSchema = Type.Object({
  name: Type.String(),
  control: Type.Union([Type.Literal("active"), Type.Literal("paused")]),
  branch: Type.String(),
  currentIteration: Type.Number(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  maxIterations: Type.Optional(Type.Number()),
  todos: Type.Array(RalphTodoSchema),
  iterations: Type.Array(IterationStateSchema),
}, { additionalProperties: false });

export function parseLoopStateJson(text: string, filePath = "state.json"): LoopState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid Ralph state JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (Value.Check(LoopStateSchema, value)) return value;

  const errors = [...Value.Errors(LoopStateSchema, value)]
    .slice(0, 5)
    .map((error) => `${filePath}${formatInstancePath(error.instancePath)}: ${error.message}`)
    .join("; ");
  throw new Error(`Invalid Ralph state in ${filePath}: ${errors || "schema validation failed"}`);
}

function formatInstancePath(instancePath: string): string {
  if (!instancePath) return "";
  return instancePath
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((part) => (/^\d+$/.test(part) ? `[${part}]` : `.${part}`))
    .join("");
}

