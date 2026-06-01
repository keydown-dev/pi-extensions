import type { RalphTodoId } from "./types.js";

const MAX_WORKER_COMMIT_SUBJECT_LENGTH = 120;

export function semanticTodoLabel(todoId: RalphTodoId | undefined, iterationNumber: number): string {
  const raw = todoId === undefined ? "" : String(todoId).trim();
  return raw || `iteration ${String(iterationNumber).padStart(3, "0")}`;
}

export function handoffCommitMessage(todoId: RalphTodoId | undefined, iterationNumber: number): string {
  return `handoff: ${semanticTodoLabel(todoId, iterationNumber)} context`;
}

export function workerCommitMessage(todoId: RalphTodoId | undefined, iterationNumber: number, workerCommitSubject?: string): string {
  const subject = sanitizeWorkerCommitSubject(workerCommitSubject);
  return subject ?? `worker: ${semanticTodoLabel(todoId, iterationNumber)} changes`;
}

export function sanitizeWorkerCommitSubject(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/\r|\n/.test(value)) return undefined;
  const subject = value.trim().replace(/\s+/g, " ");
  if (!subject) return undefined;
  if (subject.length > MAX_WORKER_COMMIT_SUBJECT_LENGTH) return undefined;
  return subject;
}

export function extractCommitSubjectFromHandoff(handoffText: string): string | undefined {
  const section = handoffText.match(/## Commit subject\s+([\s\S]*?)(?:\n## |$)/i)?.[1];
  if (!section) return undefined;
  const nonEmptyLines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (nonEmptyLines.length !== 1) return undefined;
  return sanitizeWorkerCommitSubject(nonEmptyLines[0]);
}
