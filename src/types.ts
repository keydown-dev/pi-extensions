export type LoopControl = "active" | "paused";
export type DerivedLoopStatus = "running" | "paused" | "needs_attention" | "completed" | "ready";
export type IterationStatus = "planned" | "running" | "candidate" | "accepted" | "rejected" | "failed" | "aborted";
export type TodoStatus = "queued" | "running" | "complete" | "deferred" | "failed" | "interrupted";

export interface RalphTodo {
  id: number;
  title: string;
  status: TodoStatus;
}

export interface VerificationRecord {
  status: "passed" | "failed" | "not_run";
  commands: Array<{
    command: string;
    exitCode: number;
    summary: string;
  }>;
  notes?: string;
}

export interface IterationDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface IterationState {
  number: number;
  status: IterationStatus;
  todoId?: number;
  beforeRef: string;
  afterRef?: string;
  workerBranch?: string;
  startedAt: string;
  completedAt?: string;
  verification?: VerificationRecord;
  diff?: IterationDiffStats;
  usage?: WorkerUsage;
  summary?: string;
  changedFiles?: string[];
}

export interface LoopState {
  name: string;
  control: LoopControl;
  branch: string;
  currentIteration: number;
  createdAt: string;
  updatedAt: string;
  maxIterations?: number;
  todos: RalphTodo[];
  iterations: IterationState[];
}

export interface StartOptions {
  name: string;
  todos?: string[];
  maxIterations?: number;
}

export type WorkerMode = "scripted" | "pi-json";

export interface WorkerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: number;
  contextTokens?: number;
  contextWindow?: number;
}

export interface WorkerProgress {
  phase: "starting" | "running" | "exited";
  model?: string;
  provider?: string;
  configuredModel?: string;
  elapsedMs: number;
  events: number;
  toolCalls: number;
  toolNames: string[];
  assistantMessages: number;
  usage: WorkerUsage;
  latestUsage?: WorkerUsage;
  lastEventType?: string;
}

export interface OrchestratorProgress {
  state: LoopState;
  message: string;
  worker?: WorkerProgress;
}

export interface IterationCompleteEvent {
  state: LoopState;
  iteration: IterationState;
  todo: RalphTodo;
  result: WorkerResult;
}

export interface RunOptions {
  maxIterations?: number;
  workerMode?: WorkerMode;
  workerModel?: string;
  workerContextWindow?: number;
  onProgress?: (progress: OrchestratorProgress) => void | Promise<void>;
  onIterationComplete?: (event: IterationCompleteEvent) => void | Promise<void>;
}

export interface WorkerInput {
  cwd: string;
  loopDir: string;
  iterationDir: string;
  packageRoot?: string;
  workerModel?: string;
  workerContextWindow?: number;
  state: LoopState;
  iteration: IterationState;
  todo: RalphTodo;
}

export interface WorkerResult {
  summary: string;
  changedFiles: string[];
  verification: VerificationRecord;
  usage?: WorkerUsage;
}
