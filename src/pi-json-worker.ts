import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { VerificationRecord, WorkerInput, WorkerProgress, WorkerResult, WorkerUsage } from "./types.js";

export class PiJsonWorkerRunner {
  async runIteration(input: WorkerInput, onProgress?: (progress: WorkerProgress) => void): Promise<WorkerResult> {
    const handoffIn = path.join(input.iterationDir, "handoff-in.md");
    const handoffOut = path.join(input.iterationDir, "handoff-out.md");
    const verificationPath = path.join(input.iterationDir, "verification.md");
    const outputPath = path.join(input.iterationDir, "worker-output.jsonl");
    const prompt = await this.buildPrompt(input, handoffIn, handoffOut, verificationPath);

    const tracker = new WorkerProgressTracker(onProgress, input.workerModel);
    await appendJson(outputPath, { type: "worker_start", runner: "pi-json", timestamp: new Date().toISOString() });
    tracker.mark("starting", "worker_start");
    tracker.startHeartbeat();
    const { exitCode, stderr } = await runPiJson(input.cwd, prompt, outputPath, input.workerModel, (event) => tracker.record(event));
    tracker.stopHeartbeat();
    await appendJson(outputPath, { type: "worker_exit", exitCode, stderr, timestamp: new Date().toISOString() });
    tracker.mark("exited", "worker_exit");

    if (exitCode !== 0) {
      return {
        summary: `Pi JSON worker exited with code ${exitCode}.`,
        changedFiles: [],
        verification: {
          status: "failed",
          commands: [{ command: "pi --mode json <ralph-pickup>", exitCode, summary: stderr || "Worker process failed" }],
        },
      };
    }

    const [handoffExists, verificationText] = await Promise.all([exists(handoffOut), readOptional(verificationPath)]);
    if (!handoffExists) {
      return {
        summary: "Worker did not produce handoff-out.md.",
        changedFiles: [],
        verification: {
          status: "failed",
          commands: [{ command: "check handoff-out.md", exitCode: 1, summary: "Missing handoff-out.md" }],
          notes: "Fresh worker must produce handoff-out.md before the orchestrator can accept the iteration.",
        },
      };
    }

    const handoffText = (await fs.readFile(handoffOut, "utf8")).trim();
    return {
      summary: extractSummary(handoffText),
      changedFiles: extractChangedFiles(handoffText),
      verification: parseVerification(verificationText),
    };
  }

  private async buildPrompt(input: WorkerInput, handoffIn: string, handoffOut: string, verificationPath: string): Promise<string> {
    const skill = await readPickupSkill(input.packageRoot);
    return `You are a fresh-context Ralph worker running in a child Pi process.

<ralph-pickup-skill>
${skill}
</ralph-pickup-skill>

Input handoff path:
${handoffIn}

Required output files:
- ${handoffOut}
- ${verificationPath}

Important constraints:
- Complete only iteration ${input.iteration.number}, todo #${input.todo.id}: ${input.todo.title}
- Keep context small: read the handoff first, then inspect only referenced or necessary files.
- If blocked, write handoff-out.md and verification.md explaining the blocker.
- Before finishing, ensure verification.md has a line like: Status: passed OR Status: failed OR Status: not_run.
- Do not start the next Ralph iteration.`;
  }
}

async function runPiJson(cwd: string, prompt: string, outputPath: string, workerModel?: string, onEvent?: (event: unknown) => void): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["--mode", "json", ...(workerModel ? ["--model", workerModel] : []), prompt];
    const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buffered = "";
    let settled = false;
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    const absoluteTimeoutMs = readTimeoutMs("RALPH_WORKER_TIMEOUT_MS", 15 * 60_000);
    const idleTimeoutMs = readTimeoutMs("RALPH_WORKER_IDLE_TIMEOUT_MS", 3 * 60_000);

    void appendJson(outputPath, { type: "worker_process", pid: child.pid, absoluteTimeoutMs, idleTimeoutMs, timestamp: new Date().toISOString() });

    const killTimer = setInterval(() => {
      const now = Date.now();
      const absoluteExpired = now - startedAt >= absoluteTimeoutMs;
      const idleExpired = now - lastOutputAt >= idleTimeoutMs;
      if (!absoluteExpired && !idleExpired) return;
      const reason = absoluteExpired ? `timed out after ${absoluteTimeoutMs}ms` : `produced no output for ${idleTimeoutMs}ms`;
      stderr = [stderr, `Ralph worker ${reason}; killed child process ${child.pid ?? "unknown"}.`].filter(Boolean).join("\n");
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5_000).unref();
    }, 1_000);
    killTimer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      lastOutputAt = Date.now();
      const text = chunk.toString();
      void fs.appendFile(outputPath, chunk);
      buffered += text;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          onEvent?.(JSON.parse(trimmed));
        } catch {
          // Keep raw worker output intact even if a partial/non-JSON line appears.
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      lastOutputAt = Date.now();
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearInterval(killTimer);
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearInterval(killTimer);
      settled = true;
      const trimmed = buffered.trim();
      if (trimmed) {
        try {
          onEvent?.(JSON.parse(trimmed));
        } catch {
          // Ignore malformed tail; it is still preserved in worker-output.jsonl.
        }
      }
      resolve({ exitCode: code ?? 1, stderr: stderr.trim() });
    });
  });
}

class WorkerProgressTracker {
  private readonly startedAt = Date.now();
  private heartbeat: NodeJS.Timeout | undefined;
  private progress: WorkerProgress = {
    phase: "starting",
    elapsedMs: 0,
    events: 0,
    toolCalls: 0,
    toolNames: [],
    assistantMessages: 0,
    usage: emptyUsage(),
  };
  private lastEmittedAt = 0;

  constructor(private readonly onProgress?: (progress: WorkerProgress) => void, configuredModel?: string) {
    this.progress.configuredModel = configuredModel;
  }

  startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (this.progress.phase !== "exited") this.emit(true);
    }, 1_000);
  }

  stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  mark(phase: WorkerProgress["phase"], lastEventType: string): void {
    this.progress.phase = phase;
    this.progress.lastEventType = lastEventType;
    this.emit(true);
  }

  record(event: unknown): void {
    const record = event as { type?: string; message?: { role?: string; usage?: unknown; model?: string; provider?: string; api?: string }; assistantMessageEvent?: { type?: string; partial?: { content?: unknown[]; model?: string; provider?: string; api?: string } } };
    this.progress.phase = "running";
    this.progress.events += 1;
    this.progress.lastEventType = record.type;
    this.progress.model = record.message?.model ?? record.assistantMessageEvent?.partial?.model ?? this.progress.model;
    this.progress.provider = record.message?.provider ?? record.assistantMessageEvent?.partial?.provider ?? this.progress.provider;

    if (record.type === "message_update" && record.assistantMessageEvent?.type === "toolcall_start") {
      this.progress.toolCalls += 1;
      const toolName = extractToolName(record.assistantMessageEvent.partial?.content);
      if (toolName && !this.progress.toolNames.includes(toolName)) this.progress.toolNames.push(toolName);
    }

    if (record.type === "message_end" && record.message?.role === "assistant") {
      this.progress.assistantMessages += 1;
      const usage = parseUsage(record.message.usage);
      if (usage) {
        this.progress.latestUsage = usage;
        this.progress.usage = addUsage(this.progress.usage, usage);
      }
    } else {
      const usage = parseUsage(record.message?.usage);
      if (usage) this.progress.latestUsage = usage;
    }

    this.emit(false);
  }

  private emit(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastEmittedAt < 750) return;
    this.progress.elapsedMs = now - this.startedAt;
    this.lastEmittedAt = now;
    this.onProgress?.(cloneProgress(this.progress));
  }
}

function extractToolName(content: unknown[] | undefined): string | undefined {
  if (!content) return undefined;
  for (const item of content) {
    const maybe = item as { type?: string; name?: string };
    if (maybe.type === "toolCall" && maybe.name) return maybe.name;
  }
  return undefined;
}

function parseUsage(value: unknown): WorkerUsage | undefined {
  const usage = value as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; totalTokens?: unknown; cost?: { total?: unknown } } | undefined;
  if (!usage) return undefined;
  const totalTokens = numberValue(usage.totalTokens);
  const input = numberValue(usage.input);
  const output = numberValue(usage.output);
  const cacheRead = numberValue(usage.cacheRead);
  const cacheWrite = numberValue(usage.cacheWrite);
  const cost = numberValue(usage.cost?.total);
  if (totalTokens === 0 && input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens, ...(cost > 0 ? { cost } : {}) };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyUsage(): WorkerUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function addUsage(left: WorkerUsage, right: WorkerUsage): WorkerUsage {
  const cost = (left.cost ?? 0) + (right.cost ?? 0);
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(cost > 0 ? { cost } : {}),
  };
}

function cloneProgress(progress: WorkerProgress): WorkerProgress {
  return {
    ...progress,
    toolNames: [...progress.toolNames],
    usage: { ...progress.usage },
    latestUsage: progress.latestUsage ? { ...progress.latestUsage } : undefined,
  };
}

async function readPickupSkill(packageRoot: string | undefined): Promise<string> {
  const candidates = [
    packageRoot ? path.join(packageRoot, "skills", "ralph-pickup", "SKILL.md") : undefined,
    path.join(process.cwd(), "skills", "ralph-pickup", "SKILL.md"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const content = await readOptional(candidate);
    if (content) return content;
  }
  return "Read the handoff, complete one bounded task, write handoff-out.md and verification.md, then stop.";
}

async function appendJson(filePath: string, value: unknown): Promise<void> {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function extractSummary(handoffText: string): string {
  const summarySection = handoffText.match(/## Summary\s+([\s\S]*?)(?:\n## |$)/i)?.[1]?.trim();
  return summarySection || handoffText.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim() || "Worker produced handoff-out.md.";
}

function extractChangedFiles(handoffText: string): string[] {
  const section = handoffText.match(/## Changed files\s+([\s\S]*?)(?:\n## |$)/i)?.[1] ?? "";
  return section
    .split("\n")
    .map((line) => line.match(/^\s*[-*]\s+`?([^`\n]+?)`?\s*$/)?.[1]?.trim())
    .filter((filePath): filePath is string => Boolean(filePath));
}

function readTimeoutMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseVerification(text: string): VerificationRecord {
  const statusMatch = text.match(/Status:\s*(passed|failed|not_run)/i);
  const status = (statusMatch?.[1]?.toLowerCase() as VerificationRecord["status"] | undefined) ?? "not_run";
  return {
    status,
    commands: [{ command: "worker-reported verification", exitCode: status === "failed" ? 1 : 0, summary: text.trim() || "No verification details provided" }],
  };
}
