import fs from "node:fs/promises";
import path from "node:path";
import { type ChildProcess, spawn } from "node:child_process";
import { extractCommitSubjectFromHandoff } from "./commit-messages.js";
import { CompactWorkerOutputWriter } from "./compact-worker-output.js";
import type { VerificationRecord, WorkerInput, WorkerProgress, WorkerResult, WorkerUsage } from "./types.js";

export class PiJsonWorkerRunner {
  async runIteration(input: WorkerInput, onProgress?: (progress: WorkerProgress) => void): Promise<WorkerResult> {
    const handoffIn = path.join(input.iterationDir, "handoff-in.md");
    const handoffOut = path.join(input.iterationDir, "handoff-out.md");
    const verificationPath = path.join(input.iterationDir, "verification.md");
    const outputPath = path.join(input.iterationDir, "worker-output.jsonl");
    const prompt = await this.buildPrompt(input, handoffIn, handoffOut, verificationPath);

    const tracker = new WorkerProgressTracker(onProgress, input.workerModel, input.workerContextWindow);
    const output = new CompactWorkerOutputWriter(outputPath);
    await output.recordWorkerStart("pi-json");
    tracker.mark("starting", "worker_start");
    tracker.startHeartbeat();
    const { exitCode, stderr, killed } = await runPiJson(input.cwd, prompt, outputPath, output, input.workerModel, input.state.name, (event) => tracker.record(event));
    tracker.stopHeartbeat();
    await output.recordExit(exitCode, stderr);
    tracker.mark("exited", "worker_exit");
    const usage = nonEmptyUsage(tracker.getUsage());
    const observed = tracker.getObservedModel();

    if (exitCode !== 0) {
      return {
        summary: `Pi JSON worker exited with code ${exitCode}.`,
        changedFiles: [],
        verification: {
          status: "failed",
          commands: [{ command: "pi --mode json <subagent-loop pickup>", exitCode, summary: killed ? "Worker process killed by loop kill" : stderr || "Worker process failed" }],
          notes: killed ? "Worker was killed by loop kill. Partial edits may remain; inspect git status before resuming." : undefined,
        },
        usage,
        ...observed,
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
        usage,
        ...observed,
      };
    }

    const handoffText = (await fs.readFile(handoffOut, "utf8")).trim();
    return {
      summary: extractSummary(handoffText),
      changedFiles: extractChangedFiles(handoffText),
      verification: parseVerification(verificationText),
      commitSubject: extractCommitSubjectFromHandoff(handoffText),
      usage,
      ...observed,
    };
  }

  private async buildPrompt(input: WorkerInput, handoffIn: string, handoffOut: string, verificationPath: string): Promise<string> {
    const skill = await readPickupSkill(input.packageRoot);
    return `You are a fresh-context Subagent Loop worker running in a child Pi process.

<subagent-loop-pickup>
${skill}
</subagent-loop-pickup>

Input handoff path:
${handoffIn}

Required output files:
- ${handoffOut}
- ${verificationPath}

Important constraints:
- Complete only iteration ${input.iteration.number}, todo #${input.todo.id}: ${input.todo.title}
- Keep context small: read the handoff first, then inspect only referenced or necessary files.
- If blocked by ambiguity, missing requirements, unclear ownership, unclear verification, or a missing product/architecture/security/irreversible decision, call subagent_loop_request_help instead of guessing.
- The help request should include the concrete question, context, blocking reason, attempted approaches, options/recommendation when safe, risk if guessed, and affected files/artifacts when useful.
- After subagent_loop_request_help returns, write handoff-out.md and verification.md with Status: not_run, then stop; do not resume implementation in this worker.
- For non-ambiguity blockers, write handoff-out.md and verification.md explaining the blocker.
- Before finishing, ensure verification.md has a line like: Status: passed OR Status: failed OR Status: not_run.
- Include a ## Commit subject section in handoff-out.md with one short single-line commit subject that follows this project's commit style when you can infer it.
- Do not start the next Subagent Loop iteration.`;
  }
}

const activeWorkerProcesses = new Map<string, Set<ChildProcess>>();
const killedWorkerLoops = new Set<string>();

export function killRalphWorkerProcesses(loopName?: string): number {
  const entries = loopName ? [[loopName, activeWorkerProcesses.get(loopName)] as const] : [...activeWorkerProcesses.entries()];
  let killed = 0;
  for (const [entryLoopName, processes] of entries) {
    if (!processes) continue;
    for (const child of processes) {
      if (child.killed || child.exitCode !== null) continue;
      killedWorkerLoops.add(entryLoopName);
      child.kill("SIGTERM");
      killed += 1;
    }
  }
  return killed;
}

async function runPiJson(cwd: string, prompt: string, outputPath: string, output: CompactWorkerOutputWriter, workerModel: string | undefined, loopName: string, onEvent?: (event: unknown) => void): Promise<{ exitCode: number; stderr: string; killed: boolean }> {
  return new Promise((resolve, reject) => {
    const pendingWrites: Array<Promise<unknown>> = [];
    const queueWrite = (write: Promise<unknown>): void => {
      pendingWrites.push(write.catch(() => undefined));
    };
    const args = ["--mode", "json", ...(workerModel ? ["--model", workerModel] : []), prompt];
    const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const processes = activeWorkerProcesses.get(loopName) ?? new Set<ChildProcess>();
    processes.add(child);
    activeWorkerProcesses.set(loopName, processes);
    let stderr = "";
    let buffered = "";
    let settled = false;
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    const absoluteTimeoutMs = readTimeoutMs("RALPH_WORKER_TIMEOUT_MS", 15 * 60_000);
    const idleTimeoutMs = readTimeoutMs("RALPH_WORKER_IDLE_TIMEOUT_MS", 3 * 60_000);

    const rawOutputPath = shouldWriteRawWorkerOutput() ? path.join(path.dirname(outputPath), "worker-output.raw.jsonl") : undefined;
    queueWrite(output.recordProcess({ pid: child.pid, absoluteTimeoutMs, idleTimeoutMs }));

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
      if (rawOutputPath) queueWrite(fs.appendFile(rawOutputPath, chunk));
      buffered += text;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          onEvent?.(event);
          queueWrite(output.recordEvent(event));
        } catch {
          queueWrite(output.recordMalformedLine(trimmed));
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      lastOutputAt = Date.now();
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      processes.delete(child);
      if (processes.size === 0) activeWorkerProcesses.delete(loopName);
      reject(error);
    });
    child.on("close", async (code) => {
      processes.delete(child);
      if (processes.size === 0) activeWorkerProcesses.delete(loopName);
      const trimmed = buffered.trim();
      if (trimmed) {
        try {
          const event = JSON.parse(trimmed);
          onEvent?.(event);
          queueWrite(output.recordEvent(event));
        } catch {
          queueWrite(output.recordMalformedLine(trimmed));
        }
      }
      settled = true;
      clearInterval(killTimer);
      await Promise.all(pendingWrites);
      const killed = killedWorkerLoops.delete(loopName) || killedWorkerLoops.delete("*");
      resolve({ exitCode: code ?? 1, stderr: stderr.trim(), killed });
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

  constructor(private readonly onProgress?: (progress: WorkerProgress) => void, configuredModel?: string, contextWindow?: number) {
    this.progress.configuredModel = configuredModel;
    if (contextWindow) this.progress.usage.contextWindow = contextWindow;
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

  getUsage(): WorkerUsage {
    const contextTokens = this.progress.latestUsage?.totalTokens;
    return { ...this.progress.usage, ...(contextTokens ? { contextTokens } : {}) };
  }

  getObservedModel(): { model?: string; provider?: string } {
    return {
      ...(this.progress.model ? { model: this.progress.model } : {}),
      ...(this.progress.provider ? { provider: this.progress.provider } : {}),
    };
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
  const usage = value as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; totalTokens?: unknown; contextWindow?: unknown; contextWindowTokens?: unknown; cost?: { total?: unknown } } | undefined;
  if (!usage) return undefined;
  const totalTokens = numberValue(usage.totalTokens);
  const input = numberValue(usage.input);
  const output = numberValue(usage.output);
  const cacheRead = numberValue(usage.cacheRead);
  const cacheWrite = numberValue(usage.cacheWrite);
  const cost = numberValue(usage.cost?.total);
  const contextWindow = numberValue(usage.contextWindow) || numberValue(usage.contextWindowTokens);
  if (totalTokens === 0 && input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens, ...(cost > 0 ? { cost } : {}), ...(contextWindow > 0 ? { contextWindow } : {}) };
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
    ...(right.contextWindow ?? left.contextWindow ? { contextWindow: right.contextWindow ?? left.contextWindow } : {}),
  };
}

function nonEmptyUsage(usage: WorkerUsage): WorkerUsage | undefined {
  return usage.totalTokens > 0 ? usage : undefined;
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
    packageRoot ? path.join(packageRoot, "skills", "subagent-loop", "refs", "pickup.md") : undefined,
    path.join(process.cwd(), "skills", "subagent-loop", "refs", "pickup.md"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const content = await readOptional(candidate);
    if (content) return content;
  }
  return "Read the handoff, complete one bounded task, write handoff-out.md and verification.md, then stop.";
}

function shouldWriteRawWorkerOutput(): boolean {
  return ["1", "true", "yes"].includes((process.env.RALPH_WORKER_RAW_OUTPUT ?? "").toLowerCase());
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
