export type LoopControl = "active" | "paused";
export type DerivedLoopStatus = "running" | "paused" | "needs_attention" | "completed" | "ready";
export type IterationStatus = "planned" | "running" | "candidate" | "accepted" | "rejected" | "failed" | "aborted";
export type TodoStatus = "queued" | "running" | "complete" | "deferred" | "failed" | "interrupted";

export type RalphTodoId = string | number;

export type LoopCommitMode = "per_iteration" | "manual";

export interface LoopGitPreferences {
  commitMode: LoopCommitMode;
  requireCleanWorktree: boolean;
  commitConvention: string;
  ignoreWorkerLogs: boolean;
}

export interface LoopProjectConfig {
  version: 1;
  git: LoopGitPreferences;
}

export interface WorkerModelAssignment {
  model?: string;
  provider?: string;
  contextWindow?: number;
}

export interface HelpRequestSummary {
  id: string;
  iteration: number;
  question: string;
  artifactPath: string;
  createdAt: string;
  status: "open" | "resolved";
}

export interface RalphTodo {
  id: RalphTodoId;
  title: string;
  status: TodoStatus;
  workerModel?: string;
  workerProvider?: string;
  workerContextWindow?: number;
  helpRequest?: HelpRequestSummary;
  parentTodoId?: string;
  rootTodoId?: string;
  subtaskOf?: string;
  inheritsVerificationFromTodoId?: string;
  handoffInstructions?: string;
  createdAt?: string;
  createdReason?: "resolution_subtask";
  resolutionTodoIds?: string[];
  resolvedByTodoId?: string;
  resolvedAt?: string;
  resolutionReason?: string;
}

export type InsertTodoStatus = "queued" | "deferred";

export interface InsertTodoOptions {
  name: string;
  id: string;
  title: string;
  insertAtIndex?: number;
  status?: InsertTodoStatus;
  workerModel?: string;
  workerProvider?: string;
  workerContextWindow?: number;
  dryRun?: boolean;
}

export interface InsertTodoSubtaskOptions {
  name: string;
  insertAsSubtask: string;
  id: string;
  title: string;
  instructions?: string;
  status?: InsertTodoStatus;
  workerModel?: string;
  workerProvider?: string;
  workerContextWindow?: number;
  dryRun?: boolean;
}

export interface AssignTodoModelOptions {
  name: string;
  todoId: string;
  model?: string | null;
  provider?: string | null;
  contextWindow?: number | null;
  dryRun?: boolean;
}

export interface RestartTodoOptions {
  name: string;
  todoId?: string;
  dryRun?: boolean;
}

export interface RequestHelpOptions {
  name?: string;
  question: string;
  context?: string;
  blockingReason?: string;
  attemptedApproaches?: string[];
  options?: string[];
  recommendation?: string;
  riskIfGuessed?: string;
  neededBy?: string[];
}

export interface RequestHelpResult {
  state: LoopState;
  todo: RalphTodo;
  iteration: IterationState;
  helpRequest: HelpRequestSummary;
  markdownPath: string;
  jsonPath: string;
}

export interface RestartTodoResult {
  state: LoopState;
  todo: RalphTodo;
  iteration: IterationState;
  beforeRef: string;
  headRef: string;
  rescueRef: string;
  worktreeDirty: boolean;
  dryRun: boolean;
  nextAction: string;
}

export interface AssignTodoModelResult {
  state: LoopState;
  todo: RalphTodo;
  dryRun: boolean;
  cleared: boolean;
}

export interface InsertTodoResult {
  state: LoopState;
  insertedTodo: RalphTodo;
  insertAtIndex: number;
  dryRun: boolean;
  maxIterationsChange?: { before: number; after: number };
  parentTodo?: RalphTodo;
  rootTodo?: RalphTodo;
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
  todoId?: RalphTodoId;
  beforeRef: string;
  afterRef?: string;
  workerBranch?: string;
  model?: string;
  provider?: string;
  configuredModel?: string;
  configuredProvider?: string;
  observedModel?: string;
  observedProvider?: string;
  startedAt: string;
  completedAt?: string;
  verification?: VerificationRecord;
  diff?: IterationDiffStats;
  usage?: WorkerUsage;
  summary?: string;
  changedFiles?: string[];
  commitSubject?: string;
  helpRequest?: HelpRequestSummary;
}

export interface RunBudget {
  remaining: number;
  updatedAt: string;
  updatedBy?: "command" | "tool" | "orchestrator";
}

export interface LoopState {
  name: string;
  control: LoopControl;
  branch: string;
  currentIteration: number;
  createdAt: string;
  updatedAt: string;
  maxIterations?: number;
  runBudget?: RunBudget;
  workerDefaults?: WorkerModelAssignment;
  git?: LoopGitPreferences;
  todos: RalphTodo[];
  iterations: IterationState[];
}

export interface StartOptions {
  name: string;
  todos?: string[];
  maxIterations?: number;
  defaultWorkerModel?: string;
  defaultWorkerProvider?: string;
  defaultWorkerContextWindow?: number;
  commitMode?: LoopCommitMode;
  requireCleanWorktree?: boolean;
  commitConvention?: string;
  ignoreWorkerLogs?: boolean;
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
  commitSubject?: string;
  usage?: WorkerUsage;
  model?: string;
  provider?: string;
}
