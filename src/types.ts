export type LoopStatus = "ready" | "running" | "awaiting_acceptance" | "completed" | "failed" | "stopped";
export type IterationStatus = "planned" | "running" | "candidate" | "accepted" | "rejected" | "failed" | "aborted";
export type TodoStatus = "pending" | "running" | "completed" | "failed";

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
}

export interface LoopState {
  name: string;
  status: LoopStatus;
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

export interface RunOptions {
  maxIterations?: number;
  workerMode?: WorkerMode;
  workerModel?: string;
  onProgress?: (progress: OrchestratorProgress) => void | Promise<void>;
}

export interface WorkerInput {
  cwd: string;
  loopDir: string;
  iterationDir: string;
  packageRoot?: string;
  workerModel?: string;
  state: LoopState;
  iteration: IterationState;
  todo: RalphTodo;
}

export interface WorkerResult {
  summary: string;
  changedFiles: string[];
  verification: VerificationRecord;
}
