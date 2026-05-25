import fs from "node:fs/promises";
import path from "node:path";
import type { IterationState, LoopState, RalphTodo, VerificationRecord } from "./types.js";
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
      status: "ready",
      branch,
      currentIteration: 0,
      createdAt: now,
      updatedAt: now,
      maxIterations,
      todos: todos.map<RalphTodo>((title, index) => ({ id: index + 1, title, status: "pending" })),
      iterations: [],
    };
    await fs.mkdir(path.join(this.getLoopDir(name), "iterations"), { recursive: true });
    await fs.writeFile(path.join(this.getLoopDir(name), "plan.md"), renderPlan(state), "utf8");
    await fs.writeFile(path.join(this.getLoopDir(name), "decisions.md"), `# Decisions: ${state.name}\n\n`, "utf8");
    await this.writeState(state);
    return state;
  }

  async readState(name: string): Promise<LoopState> {
    return JSON.parse(await fs.readFile(statePath(this.cwd, name), "utf8")) as LoopState;
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
        states.push(JSON.parse(await fs.readFile(path.join(root, entry, "state.json"), "utf8")) as LoopState);
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

  async writeWorkerArtifacts(state: LoopState, iteration: IterationState, result: { summary: string; changedFiles: string[]; verification: VerificationRecord }): Promise<void> {
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

function renderPlan(state: LoopState): string {
  const lines = [`# Ralph loop: ${state.name}`, "", `Status: ${state.status}`, "", "## Todo", ""];
  for (const todo of state.todos) {
    const box = todo.status === "completed" ? "x" : " ";
    lines.push(`- [${box}] ${todo.id}. ${todo.title} (${todo.status})`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderHandoffIn(state: LoopState, iteration: IterationState, todo: RalphTodo): string {
  return `# Ralph handoff-in\n\nLoop: ${state.name}\nIteration: ${iteration.number}\nTodo: ${todo.id}. ${todo.title}\n\n## Task\n\nComplete exactly this todo item. Keep changes bounded and record verification.\n\n## Required output\n\nProduce handoff-out.md and verification.md for this iteration.\n`;
}

function renderHandoffOut(iteration: IterationState, result: { summary: string; changedFiles: string[] }): string {
  return `# Ralph handoff-out\n\nIteration: ${iteration.number}\n\n## Summary\n\n${result.summary}\n\n## Changed files\n\n${result.changedFiles.map((file) => `- ${file}`).join("\n")}\n`;
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
