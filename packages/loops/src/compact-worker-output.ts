import fs from "node:fs/promises";
import type { WorkerUsage } from "./types.js";

export type CompactWorkerRecord =
  | { type: "worker_start"; runner: string; timestamp: string }
  | { type: "worker_process"; pid?: number; absoluteTimeoutMs: number; idleTimeoutMs: number; timestamp: string }
  | { type: "assistant_message"; role: "assistant"; text?: string; content?: unknown; model?: string; provider?: string; api?: string; usage?: WorkerUsage; timestamp: string }
  | { type: "tool_call"; name?: string; id?: string; input?: unknown; eventType?: string; timestamp: string }
  | { type: "tool_result"; name?: string; id?: string; summary?: string; eventType?: string; timestamp: string }
  | { type: "usage_snapshot"; usage: WorkerUsage; timestamp: string }
  | { type: "worker_warning"; message: string; eventType?: string; timestamp: string }
  | { type: "worker_exit"; exitCode: number; stderr: string; timestamp: string }
  | { type: "worker_result"; result: unknown };

const MAX_TEXT_CHARS = 20_000;
const MAX_VALUE_CHARS = 8_000;

export class CompactWorkerOutputWriter {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly outputPath: string) {}

  append(record: CompactWorkerRecord): Promise<void> {
    this.pending = this.pending.then(() => fs.appendFile(this.outputPath, `${JSON.stringify(record)}\n`, "utf8"));
    return this.pending;
  }

  async recordWorkerStart(runner = "pi-json"): Promise<void> {
    await this.append({ type: "worker_start", runner, timestamp: new Date().toISOString() });
  }

  async recordProcess(process: { pid?: number; absoluteTimeoutMs: number; idleTimeoutMs: number }): Promise<void> {
    await this.append({ type: "worker_process", ...process, timestamp: new Date().toISOString() });
  }

  async recordEvent(event: unknown): Promise<void> {
    const record = event as PiJsonEvent;
    const eventType = record.assistantMessageEvent?.type;
    const usage = parseUsage(record.message?.usage);

    if (record.type === "message_update") {
      const toolCall = findContentItem(record.assistantMessageEvent?.partial?.content, "toolCall");
      if (toolCall || eventType === "toolcall_start") {
        await this.append({
          type: "tool_call",
          name: stringValue(toolCall?.name),
          id: stringValue(toolCall?.id),
          input: compactValue(toolCall?.input ?? toolCall?.arguments),
          eventType,
          timestamp: new Date().toISOString(),
        });
      }

      const toolResult = findContentItem(record.assistantMessageEvent?.partial?.content, "toolResult");
      if (toolResult) {
        await this.append({
          type: "tool_result",
          name: stringValue(toolResult.name),
          id: stringValue(toolResult.id),
          summary: summarizeValue(toolResult.result ?? toolResult.output ?? toolResult.content),
          eventType,
          timestamp: new Date().toISOString(),
        });
      }

      if (usage) await this.append({ type: "usage_snapshot", usage, timestamp: new Date().toISOString() });
      return;
    }

    if (record.type === "message_end" && record.message?.role === "assistant") {
      await this.append({
        type: "assistant_message",
        role: "assistant",
        text: truncate(extractText(record.message.content), MAX_TEXT_CHARS),
        content: compactValue(record.message.content),
        model: record.message.model,
        provider: record.message.provider,
        api: record.message.api,
        usage,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (usage) await this.append({ type: "usage_snapshot", usage, timestamp: new Date().toISOString() });
  }

  async recordMalformedLine(line: string): Promise<void> {
    await this.append({ type: "worker_warning", message: `Ignored malformed JSON line: ${truncate(line, 240)}`, timestamp: new Date().toISOString() });
  }

  async recordExit(exitCode: number, stderr: string): Promise<void> {
    await this.append({ type: "worker_exit", exitCode, stderr, timestamp: new Date().toISOString() });
  }
}

type PiJsonEvent = {
  type?: string;
  message?: { role?: string; content?: unknown; usage?: unknown; model?: string; provider?: string; api?: string };
  assistantMessageEvent?: { type?: string; partial?: { content?: unknown[]; model?: string; provider?: string; api?: string } };
};

function findContentItem(content: unknown[] | undefined, type: string): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.find((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === type));
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return undefined;
      const typed = item as { type?: string; text?: unknown; content?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") return typed.text;
      if (typeof typed.content === "string") return typed.content;
      return undefined;
    })
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("") : undefined;
}

function compactValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (!text || text.length <= MAX_VALUE_CHARS) return value;
  return { truncated: true, chars: text.length, preview: truncate(text, MAX_VALUE_CHARS) };
}

function summarizeValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return truncate(typeof value === "string" ? value : JSON.stringify(value), MAX_VALUE_CHARS);
}

function truncate(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
