import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { extractCommitSubjectFromHandoff, handoffCommitMessage, sanitizeWorkerCommitSubject, workerCommitMessage } from "../src/commit-messages.js";
import { GitPolicy } from "../src/git.js";
import { deriveLoopStatus, RalphOrchestrator, renderStatus } from "../src/orchestrator.js";
import { parseLoopStateJson } from "../src/store.js";
import { contextPressure, renderRalphWidget } from "../extensions/orchestrator.js";

const execFileAsync = promisify(execFile);

test("scripted Ralph loop adds tests and implementations over three iterations", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);

  let state = await ralph.start({ name: "math-kata" });
  assert.equal(state.control, "active");
  assert.equal(deriveLoopStatus(state), "ready");
  assert.equal(state.todos.length, 3);

  state = await ralph.run("math-kata", { maxIterations: 3, workerMode: "scripted" });

  assert.equal(state.currentIteration, 3);
  assert.equal(deriveLoopStatus(state), "completed");
  assert.equal(state.todos.filter((todo) => todo.status === "complete").length, 3);
  assert.equal(state.iterations.length, 3);
  assert.ok(state.iterations.every((iteration) => iteration.status === "accepted"));
  assert.ok(state.iterations.every((iteration) => iteration.diff && iteration.diff.filesChanged >= 1));
  assert.ok(state.iterations.every((iteration) => iteration.diff && iteration.diff.insertions >= 1));

  await execFileAsync("npm", ["test"], { cwd });

  const status = renderStatus(state);
  assert.match(status, /Ralph Orchestrator · math-kata/);
  assert.match(status, /Todos 3\/3/);
  assert.match(status, /└─ ✓ #003-add-divide-test-and-implementation Add divide/);
  assert.match(status, /\+\d+ \/ -\d+ · \d+ files/);

  const handoffIn = await fs.readFile(path.join(cwd, ".ralph", "orchestrator", "loops", "math-kata", "iterations", "003", "handoff-in.md"), "utf8");
  assert.match(handoffIn, /Todo: 003-add-divide-test-and-implementation\. Add divide test and implementation/);
  const handoffOut = await fs.readFile(path.join(cwd, ".ralph", "orchestrator", "loops", "math-kata", "iterations", "003", "handoff-out.md"), "utf8");
  assert.match(handoffOut, /Added divide test and implementation/);

  const refs = (await execFileAsync("git", ["show-ref"], { cwd })).stdout;
  assert.match(refs, /refs\/ralph\/math-kata\/iter-001-before/);
  assert.match(refs, /refs\/ralph\/math-kata\/iter-003-after/);
});

test("pi-json worker commit uses parsed handoff commit subject", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-fake-pi-"));
  t.after(() => fs.rm(binDir, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  await fs.writeFile(path.join(binDir, "pi"), `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const prompt = process.argv[process.argv.length - 1] ?? "";
const outputs = [...prompt.matchAll(/- (\\S+\\.md)/g)].map((match) => match[1]);
const handoffOut = outputs.find((file) => file.endsWith("handoff-out.md"));
const verification = outputs.find((file) => file.endsWith("verification.md"));
fs.appendFileSync(path.join(process.cwd(), "src", "math.js"), "\\nexport const fakePiWorkerTouched = true;\\n");
fs.writeFileSync(handoffOut, "# Ralph handoff-out\\n\\n## Summary\\n\\nTouched math module.\\n\\n## Changed files\\n\\n- src/math.js\\n\\n## Commit subject\\n\\nfeat: touch math from fake pi\\n");
fs.writeFileSync(verification, "# Verification\\n\\nStatus: passed\\n\\n## Commands\\n\\n- fake pi passed\\n");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }));
`, { mode: 0o755 });

  const ralph = new RalphOrchestrator(cwd);
  const state = await ralph.start({ name: "commit-subject-demo", todos: ["Touch math module"] });
  const finalState = await ralph.run("commit-subject-demo", { maxIterations: 1 });

  assert.match(await fs.readFile(path.join(cwd, ".ralph", "orchestrator", "loops", state.name, "iterations", "001", "handoff-in.md"), "utf8"), /## Commit subject/);
  assert.equal(finalState.iterations[0]?.commitSubject, "feat: touch math from fake pi");
  const log = (await execFileAsync("git", ["log", "--format=%s"], { cwd })).stdout;
  assert.match(log, /feat: touch math from fake pi/);
});

test("pi-json worker writes compact committed output and optional raw trace", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-fake-pi-"));
  t.after(() => fs.rm(binDir, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  const originalRaw = process.env.RALPH_WORKER_RAW_OUTPUT;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.RALPH_WORKER_RAW_OUTPUT = "1";
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalRaw === undefined) delete process.env.RALPH_WORKER_RAW_OUTPUT;
    else process.env.RALPH_WORKER_RAW_OUTPUT = originalRaw;
  });
  await fs.writeFile(path.join(binDir, "pi"), `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const prompt = process.argv[process.argv.length - 1] ?? "";
const outputs = [...prompt.matchAll(/- (\\S+\\.md)/g)].map((match) => match[1]);
const handoffOut = outputs.find((file) => file.endsWith("handoff-out.md"));
const verification = outputs.find((file) => file.endsWith("verification.md"));
fs.appendFileSync(path.join(process.cwd(), "src", "math.js"), "\\nexport const compactWorkerTouched = true;\\n");
fs.writeFileSync(handoffOut, "# Ralph handoff-out\\n\\n## Summary\\n\\nTouched math module.\\n\\n## Changed files\\n\\n- src/math.js\\n\\n## Commit subject\\n\\nfeat: compact worker output\\n");
fs.writeFileSync(verification, "# Verification\\n\\nStatus: passed\\n\\n## Commands\\n\\n- fake pi passed\\n");
for (let i = 0; i < 100; i++) {
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "delta", partial: { content: [{ type: "text", text: "token-" + i }] } } }));
}
console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", partial: { content: [{ type: "toolCall", name: "read", id: "call-1", input: { path: "src/math.js" } }] } } }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } } }));
`, { mode: 0o755 });

  const ralph = new RalphOrchestrator(cwd);
  const state = await ralph.start({ name: "compact-output-demo", todos: ["Touch math module"] });
  await ralph.run("compact-output-demo", { maxIterations: 1 });

  const iterationDir = path.join(cwd, ".ralph", "orchestrator", "loops", state.name, "iterations", "001");
  const compact = await fs.readFile(path.join(iterationDir, "worker-output.jsonl"), "utf8");
  const compactRecords = compact.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(compactRecords.map((record) => record.type), ["worker_start", "worker_process", "tool_call", "assistant_message", "worker_exit", "worker_result"]);
  assert.ok(!compact.includes("message_update"));
  assert.ok(compact.length < 2_500, `compact output was ${compact.length} bytes`);

  const raw = await fs.readFile(path.join(iterationDir, "worker-output.raw.jsonl"), "utf8");
  assert.match(raw, /message_update/);
  assert.ok(raw.length > compact.length);
});

test("commit message helpers use semantic todo identity and sanitized worker subjects", () => {
  assert.equal(handoffCommitMessage("ISSUE-005.1", 6), "handoff: ISSUE-005.1 context");
  assert.equal(handoffCommitMessage(undefined, 6), "handoff: iteration 006 context");
  assert.equal(workerCommitMessage("ISSUE-005.1", 6), "worker: ISSUE-005.1 changes");
  assert.equal(workerCommitMessage(undefined, 6), "worker: iteration 006 changes");
  assert.equal(workerCommitMessage("ISSUE-005.1", 6, "  feat: add progress UI  "), "feat: add progress UI");
  assert.equal(sanitizeWorkerCommitSubject("feat: add x\n\nbody"), undefined);
  assert.equal(sanitizeWorkerCommitSubject("x".repeat(121)), undefined);
  assert.equal(extractCommitSubjectFromHandoff("## Commit subject\n\nfix: handle pause\n\n## Risks\n\nNone"), "fix: handle pause");
  assert.equal(extractCommitSubjectFromHandoff("## Commit subject\n\nfix: line one\nfix: line two"), undefined);
});

test("start refuses dirty worktrees", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, "dirty.txt"), "dirty", "utf8");

  const ralph = new RalphOrchestrator(cwd);
  await assert.rejects(() => ralph.start({ name: "dirty-demo" }), /clean worktree/);
});

test("run emits progress with running todo before worker completes", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "progress-demo", todos: ["Add subtract test and implementation"] });
  const progressMessages: string[] = [];

  await ralph.run("progress-demo", {
    maxIterations: 1,
    workerMode: "scripted",
    onProgress(progress) {
      progressMessages.push(renderStatus(progress.state));
    },
  });

  assert.ok(progressMessages.some((message) => message.includes("◐ #001-add-subtract-test-and-implementation Add subtract test and implementation (working)")));
});

test("progress includes configured worker model", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "model-progress", todos: ["Add subtract test and implementation"] });
  const models: Array<string | undefined> = [];

  await ralph.run("model-progress", {
    maxIterations: 1,
    workerMode: "scripted",
    workerModel: "test-provider/test-model:low",
    onProgress(progress) {
      models.push(progress.worker?.configuredModel);
    },
  });

  assert.ok(models.includes("test-provider/test-model:low"));
});

test("pause defers queued work until run resumes it", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "pause-demo", todos: ["Add subtract test and implementation", "Add multiply test and implementation"] });

  let state = await ralph.pause("pause-demo");
  assert.equal(state.control, "paused");
  assert.equal(deriveLoopStatus(state), "paused");
  assert.deepEqual(state.todos.map((todo) => todo.status), ["deferred", "deferred"]);

  state = await ralph.run("pause-demo", { maxIterations: 1, workerMode: "scripted" });
  assert.equal(state.control, "active");
  assert.deepEqual(state.todos.map((todo) => todo.status), ["complete", "deferred"]);
});

test("pausing a running loop defers remaining queued work in final state", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({
    name: "pause-running-demo",
    todos: ["Add subtract test and implementation", "Add multiply test and implementation", "Add divide test and implementation"],
  });
  let pausePromise: Promise<unknown> | undefined;

  const state = await ralph.run("pause-running-demo", {
    maxIterations: 3,
    workerMode: "scripted",
    onProgress(progress) {
      if (!pausePromise && progress.state.todos.some((todo) => todo.status === "running")) {
        pausePromise = ralph.pause("pause-running-demo");
      }
    },
  });
  assert.ok(pausePromise);
  await pausePromise;

  assert.equal(state.control, "paused");
  assert.deepEqual(state.todos.map((todo) => todo.status), ["complete", "deferred", "deferred"]);
});

test("worker progress after pause does not repaint deferred todos as queued", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({
    name: "pause-progress-demo",
    todos: ["Add subtract test and implementation", "Add multiply test and implementation", "Add divide test and implementation"],
  });
  const progressStatuses: string[][] = [];
  let pausedAt = -1;
  let pausePromise: Promise<unknown> | undefined;

  await ralph.run("pause-progress-demo", {
    maxIterations: 3,
    workerMode: "scripted",
    onProgress(progress) {
      progressStatuses.push(progress.state.todos.map((todo) => todo.status));
      if (!pausePromise && progress.state.todos.some((todo) => todo.status === "running")) {
        pausePromise = ralph.pause("pause-progress-demo").then(() => {
          pausedAt = progressStatuses.length;
        });
      }
    },
  });
  assert.ok(pausePromise);
  await pausePromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(pausedAt >= 0);
  assert.ok(progressStatuses.slice(pausedAt).every((statuses) => !statuses.includes("queued")), JSON.stringify(progressStatuses));
});

test("running loop extension persists budget and starts one more worker", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({
    name: "extend-running-demo",
    todos: ["Add subtract test and implementation", "Add multiply test and implementation", "Add divide test and implementation"],
    maxIterations: 1,
  });
  let extensionPromise: Promise<unknown> | undefined;

  const state = await ralph.run("extend-running-demo", {
    maxIterations: 1,
    workerMode: "scripted",
    onProgress(progress) {
      if (!extensionPromise && progress.state.todos.some((todo) => todo.status === "running")) {
        extensionPromise = ralph.extendRun("extend-running-demo", 1, "tool");
      }
    },
  });
  assert.ok(extensionPromise);
  await extensionPromise;

  assert.equal(state.currentIteration, 2);
  assert.deepEqual(state.todos.map((todo) => todo.status), ["complete", "complete", "deferred"]);
  const persisted = await ralph.status("extend-running-demo");
  assert.equal(persisted.runBudget?.remaining, 0);
});

test("pause clears persisted run budget", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "pause-budget-demo", todos: ["First", "Second"], maxIterations: 1 });
  await ralph.extendRun("pause-budget-demo", 1, "command");

  const state = await ralph.pause("pause-budget-demo");

  assert.equal(state.runBudget, undefined);
  assert.deepEqual(state.todos.map((todo) => todo.status), ["deferred", "deferred"]);
});

test("deferred tasks are not picked until a later run scope", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  let state = await ralph.start({ name: "deferred-demo", maxIterations: 1 });
  assert.deepEqual(state.todos.map((todo) => todo.status), ["queued", "deferred", "deferred"]);

  state = await ralph.run("deferred-demo", { maxIterations: 1, workerMode: "scripted" });
  assert.deepEqual(state.todos.map((todo) => todo.status), ["complete", "deferred", "deferred"]);
  assert.equal(deriveLoopStatus(state), "ready");

  state = await ralph.run("deferred-demo", { maxIterations: 1, workerMode: "scripted" });
  assert.deepEqual(state.todos.map((todo) => todo.status), ["complete", "complete", "deferred"]);
});

test("insertTodo requires a semantic ID and inserts at an array index", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "insert-demo", todos: ["First", "Second", "Third"], maxIterations: 2 });

  const preview = await ralph.insertTodo({ name: "insert-demo", id: "001.1-extra-work", insertAtIndex: 1, title: "Iteration 1.1: Extra work", dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.insertAtIndex, 1);
  assert.deepEqual(preview.state.todos.map((todo) => todo.id), ["001-first", "001.1-extra-work", "002-second", "003-third"]);
  assert.deepEqual(preview.state.todos.map((todo) => todo.status), ["queued", "deferred", "queued", "deferred"]);
  assert.deepEqual(preview.maxIterationsChange, { before: 2, after: 3 });

  let persisted = await ralph.status("insert-demo");
  assert.deepEqual(persisted.todos.map((todo) => todo.id), ["001-first", "002-second", "003-third"]);
  assert.equal(persisted.maxIterations, 2);

  const result = await ralph.insertTodo({ name: "insert-demo", id: "001.1-extra-work", insertAtIndex: 1, title: "Iteration 1.1: Extra work" });
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.state.todos.map((todo) => `${todo.id}:${todo.title}:${todo.status}`), [
    "001-first:First:queued",
    "001.1-extra-work:Iteration 1.1: Extra work:deferred",
    "002-second:Second:queued",
    "003-third:Third:deferred",
  ]);
  assert.equal(result.state.maxIterations, 3);

  persisted = await ralph.status("insert-demo");
  assert.deepEqual(persisted.todos.map((todo) => todo.id), ["001-first", "001.1-extra-work", "002-second", "003-third"]);
  const plan = await fs.readFile(path.join(cwd, ".ralph", "orchestrator", "loops", "insert-demo", "plan.md"), "utf8");
  assert.match(plan, /- \[ \] 001-first\. First \(queued\)\n- \[ \] 001\.1-extra-work\. Iteration 1\.1: Extra work \(deferred\)\n- \[ \] 002-second\. Second \(queued\)/);
});

test("insertTodo refuses to modify a loop with running work", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  const state = await ralph.start({ name: "insert-running-demo", todos: ["First", "Second"] });
  state.todos[0]!.status = "running";
  await fs.writeFile(path.join(cwd, ".ralph", "orchestrator", "loops", "insert-running-demo", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await assert.rejects(() => ralph.insertTodo({ name: "insert-running-demo", id: "001.1-extra", insertAtIndex: 1, title: "Extra" }), /while loop is running/);
});

test("insertTodo rejects duplicate or empty semantic IDs", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "insert-id-demo", todos: ["First", "Second"] });

  await assert.rejects(() => ralph.insertTodo({ name: "insert-id-demo", id: " ", title: "Extra" }), /id cannot be empty/);
  await assert.rejects(() => ralph.insertTodo({ name: "insert-id-demo", id: "001-first", title: "Extra" }), /id already exists/);
});

test("insertTodo rejects insertion before completed work", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  const state = await ralph.start({ name: "insert-complete-demo", todos: ["First", "Second", "Third"] });
  state.todos[0]!.status = "complete";
  await fs.writeFile(path.join(cwd, ".ralph", "orchestrator", "loops", "insert-complete-demo", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await assert.rejects(() => ralph.insertTodo({ name: "insert-complete-demo", id: "000-extra", insertAtIndex: 0, title: "Extra" }), /before completed work/);
  const result = await ralph.insertTodo({ name: "insert-complete-demo", id: "001.1-extra", insertAtIndex: 1, title: "Extra", dryRun: true });
  assert.deepEqual(result.state.todos.map((todo) => todo.id), ["001-first", "001.1-extra", "002-second", "003-third"]);
});

test("insertTodo rejects inconsistent completed todo ordering", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  const state = await ralph.start({ name: "insert-inconsistent-demo", todos: ["First", "Second", "Third"] });
  state.todos[1]!.status = "complete";
  await fs.writeFile(path.join(cwd, ".ralph", "orchestrator", "loops", "insert-inconsistent-demo", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

  await assert.rejects(() => ralph.insertTodo({ name: "insert-inconsistent-demo", id: "001.1-extra", insertAtIndex: 1, title: "Extra" }), /completed todos.*do not form a prefix/);
});

test("derived status reports needs attention for interrupted tasks", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  const state = await ralph.start({ name: "interrupted-demo", todos: ["Add subtract test and implementation"] });
  state.todos[0]!.status = "interrupted";

  assert.equal(deriveLoopStatus(state), "needs_attention");
});

test("completion callback is emitted before the next iteration starts", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "completion-demo", todos: ["Add subtract test and implementation", "Add multiply test and implementation"] });
  const events: string[] = [];

  await ralph.run("completion-demo", {
    maxIterations: 2,
    workerMode: "scripted",
    onProgress(progress) {
      if (progress.message.startsWith("Started Ralph iteration")) events.push(`start:${progress.state.currentIteration}`);
    },
    onIterationComplete(event) {
      events.push(`complete:${event.iteration.number}:${event.result.verification.status}`);
    },
  });

  assert.deepEqual(events, ["start:1", "complete:1:passed", "start:2", "complete:2:passed"]);
});

test("Ralph widget renders rounded panel title summary and progress", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-header-demo",
    control: "active",
    branch: "orchestrator/widget-header-demo",
    currentIteration: 2,
    maxIterations: 5,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [
      { id: 1, title: "Done work", status: "complete" },
      { id: 2, title: "Problem", status: "failed" },
      { id: 3, title: "Next work", status: "queued" },
    ],
    iterations: [{
      number: 1,
      status: "accepted",
      todoId: 1,
      beforeRef: "before",
      startedAt: "2026-05-27T00:00:00.000Z",
      completedAt: "2026-05-27T00:01:00.000Z",
      usage: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 3000, cost: 0.1234 },
    }],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 120).join("\n");
  assert.match(output, /^╭─ Subagent Loop · widget-header-demo .*✓ 1\/3 · ✗1 · \$0\.1234 · 1m 0s ╮/m);
  assert.match(output, /╰─ (?:\x1b\[97m)?[━─]+(?:\x1b\[39m)?[━─]* ╯/);
  assert.doesNotMatch(output, /Ralph Loop · widget-header-demo|✗0|↓\d+ [○Ⅱ◌]|↑\d+ [✓✗]/);
});

test("Ralph widget expanded mode renders all todos inside side borders", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-expanded-demo",
    control: "active",
    branch: "orchestrator/widget-expanded-demo",
    currentIteration: 3,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [
      { id: 1, title: "First done", status: "complete" },
      { id: 2, title: "Latest done", status: "complete" },
      { id: 3, title: "Current work", status: "running" },
      { id: 4, title: "Next work", status: "queued" },
      { id: 5, title: "Later work", status: "deferred" },
    ],
    iterations: [],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 100, "expanded").join("\n");
  assert.match(output, /╭─ Subagent Loop/);
  assert.match(output, /│  ✓   #1 First done/);
  assert.match(output, /#1 First done[\s\S]*#5 Later work/);
  assert.match(output, /│\s*│\n│  ✓/);
  assert.doesNotMatch(output, /more|↓\d+ [○Ⅱ◌]|↑\d+ [✓✗]/);
});

test("Ralph widget compact mode focuses actionable todo without header badges", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-compact-demo",
    control: "active",
    branch: "orchestrator/widget-compact-demo",
    currentIteration: 3,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [
      { id: 1, title: "First done", status: "complete" },
      { id: 2, title: "Problem", status: "failed" },
      { id: 3, title: "Current work", status: "queued" },
      { id: 4, title: "Later work", status: "deferred" },
    ],
    iterations: [],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 120, "compact").join("\n");
  assert.match(output, /#2 Problem/);
  assert.doesNotMatch(output, /#1 First done|#3 Current work|#4 Later work|↑1 ✓|↓1 ○/);
});

test("Ralph widget compact mode selects queued work before latest complete", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-queued-demo",
    control: "active",
    branch: "orchestrator/widget-queued-demo",
    currentIteration: 2,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [
      { id: 1, title: "First done", status: "complete" },
      { id: 2, title: "Latest done", status: "complete" },
      { id: 3, title: "Next work", status: "queued" },
    ],
    iterations: [],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 120, "compact").join("\n");
  assert.match(output, /○   #3 Next work/);
  assert.doesNotMatch(output, /#1 First done|#2 Latest done/);
});

test("contextPressure derives warning and error thresholds", () => {
  const worker = (contextTokens?: number, contextWindow?: number) => ({
    phase: "running" as const,
    elapsedMs: 0,
    events: 0,
    toolCalls: 0,
    toolNames: [],
    assistantMessages: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, contextTokens, contextWindow },
  });

  assert.equal(contextPressure(worker(399, 1000)).level, "normal");
  assert.equal(contextPressure(worker(400, 1000)).level, "warning");
  assert.equal(contextPressure(worker(499, 1000)).level, "warning");
  assert.equal(contextPressure(worker(500, 1000)).level, "error");
  assert.equal(contextPressure(worker(undefined, 1000)).level, "unknown");
  assert.equal(contextPressure(worker(500, undefined)).level, "unknown");
});

test("Ralph widget renders warning and error context pressure styling", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-pressure-demo",
    control: "active",
    branch: "orchestrator/widget-pressure-demo",
    currentIteration: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [{ id: 1, title: "Current work", status: "running" }],
    iterations: [],
  }));
  const worker = (contextTokens: number) => ({
    phase: "running" as const,
    model: "gpt-5.5",
    elapsedMs: 0,
    events: 0,
    toolCalls: 0,
    toolNames: [],
    assistantMessages: 0,
    usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 2000, contextTokens, contextWindow: 1000 },
  });

  const warning = renderRalphWidget(state, worker(400), taggedTheme as never, 160, "compact").join("\n");
  assert.match(warning, /<warning>╭─/);
  assert.match(warning, /<warning>[^<]+<\/warning>   <warning>#1 Current work/);
  assert.match(warning, /40\.0%\/1k/);

  const error = renderRalphWidget(state, worker(500), taggedTheme as never, 160, "expanded").join("\n");
  assert.match(error, /<error>╭─/);
  assert.match(error, /<bg:toolErrorBg>  <error>[^<]+<\/error>   <error>#1 Current work/);
  assert.match(error, /50\.0%\/1k/);
});

test("Ralph widget uses header color for panel chrome and highlights running rows", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-border-demo",
    control: "active",
    branch: "orchestrator/widget-border-demo",
    currentIteration: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [{ id: 1, title: "Current work", status: "running" }],
    iterations: [],
  }));

  const output = renderRalphWidget(state, undefined, taggedTheme as never, 200, "expanded").join("\n");
  assert.match(output, /<accent>╭─/);
  assert.match(output, /<bg:toolPendingBg>  <accent>[^<]+<\/accent>   <accent>#1 Current work/);
  assert.match(output, /\x1b\[97m━*\x1b\[39m/);
  assert.doesNotMatch(output, /<border>╭|›/);
});

test("Ralph widget renders detail row in model tokens context cost time diff files order", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-demo",
    control: "active",
    branch: "orchestrator/widget-demo",
    currentIteration: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [{ id: 1, title: "Do work", status: "complete" }],
    iterations: [{
      number: 1,
      status: "accepted",
      todoId: 1,
      beforeRef: "before",
      startedAt: "2026-05-27T00:00:00.000Z",
      completedAt: "2026-05-27T00:01:00.000Z",
      verification: { status: "passed", commands: [{ command: "npm test", exitCode: 0, summary: "ok" }] },
      diff: { filesChanged: 1, insertions: 1, deletions: 1 },
      model: "anthropic/sonnet",
      usage: { input: 50000, output: 30000, cacheRead: 6999, cacheWrite: 0, totalTokens: 86999, cost: 0.165567, contextTokens: 66100, contextWindow: 272000 },
    }],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 140).join("\n");
  assert.match(output, /sonnet · ↑50k ↓30k R7\.0k · 24\.3%\/272k · \$0\.1656 · 1m 0s · \+1 \/ -1 · 1 File/);
  assert.doesNotMatch(output, /anthropic\/sonnet|1 files|passed|verification ok|Used /);
});

test("Ralph widget renders running worker usage without tool phrases", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-running-demo",
    control: "active",
    branch: "orchestrator/widget-running-demo",
    currentIteration: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [{ id: 1, title: "Do work", status: "running" }],
    iterations: [{
      number: 1,
      status: "running",
      todoId: 1,
      beforeRef: "before",
      startedAt: "2026-05-27T00:00:00.000Z",
    }],
  }));

  const output = renderRalphWidget(state, {
    phase: "running",
    provider: "openai-codex",
    model: "gpt-5.5",
    elapsedMs: 80_000,
    events: 3,
    toolCalls: 2,
    toolNames: ["read", "edit"],
    assistantMessages: 1,
    usage: { input: 261000, output: 21000, cacheRead: 4200000, cacheWrite: 0, totalTokens: 4482000, cost: 0.159, contextWindow: 272000 },
    latestUsage: { input: 60000, output: 6000, cacheRead: 0, cacheWrite: 0, totalTokens: 66000, contextTokens: 66000 },
  }, plainTheme as never, 160).join("\n");

  assert.match(output, /gpt-5\.5 · ↑261k ↓21k R4\.2m · 24\.3%\/272k · \$0\.1590 · 1m 20s/);
  assert.doesNotMatch(output, /openai-codex\/gpt-5\.5|Used Read|tools read, edit|›/);
});

test("Ralph widget renders queued and deferred placeholder telemetry", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-placeholder-demo",
    control: "paused",
    branch: "orchestrator/widget-placeholder-demo",
    currentIteration: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [
      { id: 1, title: "Queued work", status: "queued" },
      { id: 2, title: "Later work", status: "deferred" },
    ],
    iterations: [],
  }));

  const output = renderRalphWidget(state, {
    phase: "starting",
    configuredModel: "anthropic/sonnet",
    elapsedMs: 0,
    events: 0,
    toolCalls: 0,
    toolNames: [],
    assistantMessages: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, contextWindow: 272000 },
  }, plainTheme as never, 140, "expanded").join("\n");

  assert.match(output, /○   #1 Queued work[\s\S]*sonnet · ↑0 ↓0 · 0%\/272k · \$0\.0000 · 0s/);
  assert.match(output, /Ⅱ   #2 Later work[\s\S]*sonnet · ↑0 ↓0 · 0%\/272k · \$0\.0000 · 0s/);
});

test("Ralph widget footers use the same compact and expanded controls", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-footer-demo",
    control: "active",
    branch: "orchestrator/widget-footer-demo",
    currentIteration: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [{ id: 1, title: "Do work", status: "queued" }],
    iterations: [],
  }));

  const compact = renderRalphWidget(state, undefined, plainTheme as never, 160, "compact").join("\n");
  const expanded = renderRalphWidget(state, undefined, plainTheme as never, 160, "expanded").join("\n");
  const footer = "Ctrl+Opt+R Expand/Compact · Chat to resume, pause, edit, or kill the loop.";

  assert.match(compact, new RegExp(escapeRegExp(footer)));
  assert.match(expanded, new RegExp(escapeRegExp(footer)));
  assert.doesNotMatch(`${compact}\n${expanded}`, /\/ralph-widget hide|Ctrl\+Opt\+R (Expand$|Compact$)/m);
});

test("Ralph widget renders verification problem markers", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-fail-demo",
    control: "active",
    branch: "orchestrator/widget-fail-demo",
    currentIteration: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [{ id: 1, title: "Do work", status: "failed" }],
    iterations: [{
      number: 1,
      status: "failed",
      todoId: 1,
      beforeRef: "before",
      startedAt: "2026-05-27T00:00:00.000Z",
      completedAt: "2026-05-27T00:01:00.000Z",
      verification: { status: "failed", commands: [{ command: "npm test", exitCode: 1, summary: "failed" }] },
      diff: { filesChanged: 2, insertions: 1, deletions: 0 },
    }],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 120).join("\n");
  assert.match(output, /1m 0s · \+1 \/ -0 · 2 Files/);
  assert.doesNotMatch(output, /failed|verification|2 files/);
});

test("parseLoopStateJson validates persisted state", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "valid-demo",
    control: "active",
    branch: "orchestrator/valid-demo",
    currentIteration: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [{ id: 1, title: "Do work", status: "complete" }],
    iterations: [{
      number: 1,
      status: "accepted",
      todoId: 1,
      beforeRef: "refs/ralph/valid-demo/iter-001-before",
      afterRef: "refs/ralph/valid-demo/iter-001-after",
      startedAt: "2026-05-27T00:00:00.000Z",
      completedAt: "2026-05-27T00:01:00.000Z",
      verification: { status: "passed", commands: [{ command: "npm test", exitCode: 0, summary: "ok" }] },
      diff: { filesChanged: 1, insertions: 2, deletions: 0 },
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: 0.1234, contextTokens: 15, contextWindow: 100 },
      summary: "Did work.",
      changedFiles: ["src/work.ts"],
    }],
  }));

  assert.equal(state.todos[0]?.status, "complete");
  assert.equal(state.iterations[0]?.usage?.totalTokens, 18);
  assert.deepEqual(state.iterations[0]?.changedFiles, ["src/work.ts"]);

  const stringIdState = parseLoopStateJson(JSON.stringify({
    name: "string-id-demo",
    control: "active",
    branch: "orchestrator/string-id-demo",
    currentIteration: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [{ id: "001-do-work", title: "Do work", status: "complete" }],
    iterations: [{
      number: 1,
      status: "accepted",
      todoId: "001-do-work",
      beforeRef: "refs/ralph/string-id-demo/iter-001-before",
      startedAt: "2026-05-27T00:00:00.000Z",
    }],
  }));
  assert.equal(stringIdState.iterations[0]?.todoId, "001-do-work");
  assert.throws(() => parseLoopStateJson("{", "bad-state.json"), /Invalid Ralph state JSON in bad-state\.json/);
  assert.throws(() => parseLoopStateJson(JSON.stringify({ name: "bad" }), "bad-state.json"), /required properties control/);
  assert.throws(() => parseLoopStateJson(JSON.stringify({
    name: "bad-status",
    control: "active",
    branch: "orchestrator/bad-status",
    currentIteration: 0,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [{ id: 1, title: "Do work", status: "pending" }],
    iterations: [],
  }), "bad-state.json"), /bad-state\.json\.todos\[0\]\.status/);
});

test("worker model assignments persist and resolve by precedence", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  let state = await ralph.start({ name: "model-assignment-demo", todos: ["Add subtract test and implementation", "Add multiply test and implementation"], defaultWorkerModel: "loop/default", defaultWorkerContextWindow: 1234 });
  assert.equal(state.workerDefaults?.model, "loop/default");

  const assigned = await ralph.assignTodoModel({ name: state.name, todoId: "001-add-subtract-test-and-implementation", model: "todo/override", contextWindow: 5678 });
  assert.equal(assigned.todo.workerModel, "todo/override");

  state = await ralph.run(state.name, { maxIterations: 2, workerMode: "scripted", workerModel: "run/fallback" });

  assert.equal(state.iterations[0]?.configuredModel, "todo/override");
  assert.equal(state.iterations[0]?.model, "todo/override");
  assert.equal(state.iterations[1]?.configuredModel, "loop/default");
  assert.equal(state.iterations[1]?.model, "loop/default");
  assert.match(renderStatus(state), /todo\/override|loop\/default/);
});

test("assignTodoModel refuses running todo but allows future todo during a run", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "model-running-demo", todos: ["Add subtract test and implementation", "Add multiply test and implementation"] });
  let assignedFuture: Promise<unknown> | undefined;
  let refusedRunning: Promise<unknown> | undefined;

  const state = await ralph.run("model-running-demo", {
    maxIterations: 2,
    workerMode: "scripted",
    onProgress(progress) {
      if (!assignedFuture && progress.state.todos[0]?.status === "running") {
        refusedRunning = ralph.assignTodoModel({ name: "model-running-demo", todoId: "001-add-subtract-test-and-implementation", model: "too-late/model" }).catch((error) => error);
        assignedFuture = ralph.assignTodoModel({ name: "model-running-demo", todoId: "002-add-multiply-test-and-implementation", model: "future/model" });
      }
    },
  });

  assert.ok(refusedRunning);
  const refusal = await refusedRunning;
  assert.match(String(refusal), /running todo/);
  assert.ok(assignedFuture);
  const assigned = await assignedFuture as Awaited<ReturnType<RalphOrchestrator["assignTodoModel"]>>;
  assert.equal(assigned.todo.workerModel, "future/model");
  assert.equal(state.iterations[1]?.configuredModel, "future/model");
});

test("pi-json worker persists observed model and provider", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-fake-pi-"));
  t.after(() => fs.rm(binDir, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  await fs.writeFile(path.join(binDir, "pi"), `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const prompt = process.argv[process.argv.length - 1] ?? "";
const outputs = [...prompt.matchAll(/- (\\S+\\.md)/g)].map((match) => match[1]);
const handoffOut = outputs.find((file) => file.endsWith("handoff-out.md"));
const verification = outputs.find((file) => file.endsWith("verification.md"));
fs.appendFileSync(path.join(process.cwd(), "src", "math.js"), "\\nexport const observedModelTouched = true;\\n");
fs.writeFileSync(handoffOut, "# Ralph handoff-out\\n\\n## Summary\\n\\nTouched math module.\\n\\n## Changed files\\n\\n- src/math.js\\n\\n## Commit subject\\n\\nfeat: persist observed model\\n");
fs.writeFileSync(verification, "# Verification\\n\\nStatus: passed\\n");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "observed-model", provider: "observed-provider", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }));
`, { mode: 0o755 });

  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "observed-model-demo", todos: ["Touch math module"] });
  const state = await ralph.run("observed-model-demo", { maxIterations: 1, workerModel: "configured/model" });

  assert.equal(state.iterations[0]?.configuredModel, "configured/model");
  assert.equal(state.iterations[0]?.observedModel, "observed-model");
  assert.equal(state.iterations[0]?.observedProvider, "observed-provider");
  assert.equal(state.iterations[0]?.model, "observed-model");
});

test("schema accepts persisted worker model fields", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "model-schema-demo",
    control: "active",
    branch: "orchestrator/model-schema-demo",
    currentIteration: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    workerDefaults: { model: "loop/default", contextWindow: 1000 },
    todos: [{ id: "001-do-work", title: "Do work", status: "complete", workerModel: "todo/model", workerContextWindow: 2000 }],
    iterations: [{
      number: 1,
      status: "accepted",
      todoId: "001-do-work",
      beforeRef: "before",
      startedAt: "2026-05-27T00:00:00.000Z",
      configuredModel: "todo/model",
      observedModel: "actual/model",
      observedProvider: "actual-provider",
    }],
  }));

  assert.equal(state.workerDefaults?.model, "loop/default");
  assert.equal(state.todos[0]?.workerModel, "todo/model");
  assert.equal(state.iterations[0]?.observedModel, "actual/model");
});

test("Ralph widget displays durable todo default and completed model", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-model-demo",
    control: "active",
    branch: "orchestrator/widget-model-demo",
    currentIteration: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    workerDefaults: { model: "provider/default-model" },
    todos: [
      { id: 1, title: "Done", status: "complete" },
      { id: 2, title: "Next", status: "queued", workerModel: "provider/todo-model" },
    ],
    iterations: [{
      number: 1,
      status: "accepted",
      todoId: 1,
      beforeRef: "before",
      startedAt: "2026-05-27T00:00:00.000Z",
      completedAt: "2026-05-27T00:00:01.000Z",
      configuredModel: "provider/configured-model",
      observedModel: "provider/observed-model",
    }],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 140, "expanded").join("\n");
  assert.match(output, /observed-model/);
  assert.match(output, /todo-model/);
});

test("changedPaths preserves leading-space porcelain paths", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.appendFile(path.join(cwd, "src", "math.js"), "\n// local edit\n", "utf8");

  const paths = await new GitPolicy(cwd).changedPaths();

  assert.deepEqual(paths, ["src/math.js"]);
});

test("diffStats includes untracked files and excludes Ralph artifacts", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, "src", "new-op.js"), "export const value = 1;\n", "utf8");
  await fs.mkdir(path.join(cwd, ".ralph", "scratch"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".ralph", "scratch", "local.md"), "ignored\n", "utf8");

  const stats = await new GitPolicy(cwd).diffStats("HEAD", { excludePrefixes: [".ralph"], includeUntracked: true });

  assert.deepEqual(stats, { filesChanged: 1, insertions: 1, deletions: 0 });
});

test("declared ignored worker files are counted without being added", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, ".tmp"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".tmp", "add.ts"), "export const add = (a, b) => a + b;\n", "utf8");
  const git = new GitPolicy(cwd);

  const stats = await git.diffStats("HEAD", { excludePrefixes: [".ralph"], includeUntracked: true, includePaths: [".tmp/add.ts"] });
  await git.addAllAndCommit("worker: regular changes only");

  assert.deepEqual(stats, { filesChanged: 1, insertions: 1, deletions: 0 });
  const tracked = (await execFileAsync("git", ["ls-files", ".tmp/add.ts"], { cwd })).stdout.trim();
  assert.equal(tracked, "");
});

test("orchestrator artifacts are created under ignored .ralph/orchestrator", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "ignored-artifacts", todos: ["Add subtract test and implementation"] });

  await fs.access(path.join(cwd, ".ralph", "orchestrator", "loops", "ignored-artifacts", "state.json"));
  const ralphGitignore = await fs.readFile(path.join(cwd, ".ralph", ".gitignore"), "utf8");
  assert.match(ralphGitignore, /worker-output\.raw\.jsonl/);
  assert.match(ralphGitignore, /worker-output\.raw\.jsonl\.\*/);
  const trackedArtifacts = (await execFileAsync("git", ["ls-files", ".ralph", ".ralph-orchestrator"], { cwd })).stdout.trim();
  assert.equal(trackedArtifacts, "");
});

test("ralph gitignore generation is idempotent and preserves custom rules", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, ".ralph"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".ralph", ".gitignore"), "custom-local-file\nworker-output.raw.jsonl\n", "utf8");

  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "gitignore-idempotent", todos: ["Add subtract test and implementation"] });
  await ralph.run("gitignore-idempotent", { maxIterations: 1, workerMode: "scripted" });

  const ralphGitignore = await fs.readFile(path.join(cwd, ".ralph", ".gitignore"), "utf8");
  assert.match(ralphGitignore, /^custom-local-file$/m);
  assert.equal((ralphGitignore.match(/^worker-output\.raw\.jsonl$/gm) ?? []).length, 1);
  assert.equal((ralphGitignore.match(/^worker-output\.raw\.jsonl\.\*$/gm) ?? []).length, 1);
});

test("tracked ralph artifacts commit compact output but exclude raw traces", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, ".gitignore"), ".ralph-orchestrator/\n.tmp/\n", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd });
  await execFileAsync("git", ["commit", "-m", "track ralph artifacts"], { cwd });

  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-fake-pi-"));
  t.after(() => fs.rm(binDir, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  const originalRaw = process.env.RALPH_WORKER_RAW_OUTPUT;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.RALPH_WORKER_RAW_OUTPUT = "1";
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalRaw === undefined) delete process.env.RALPH_WORKER_RAW_OUTPUT;
    else process.env.RALPH_WORKER_RAW_OUTPUT = originalRaw;
  });
  await fs.writeFile(path.join(binDir, "pi"), `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const prompt = process.argv[process.argv.length - 1] ?? "";
const outputs = [...prompt.matchAll(/- (\\S+\\.md)/g)].map((match) => match[1]);
const handoffOut = outputs.find((file) => file.endsWith("handoff-out.md"));
const verification = outputs.find((file) => file.endsWith("verification.md"));
fs.appendFileSync(path.join(process.cwd(), "src", "math.js"), "\\nexport const rawTraceExcluded = true;\\n");
fs.writeFileSync(handoffOut, "# Ralph handoff-out\\n\\n## Summary\\n\\nTouched math module.\\n\\n## Changed files\\n\\n- src/math.js\\n\\n## Commit subject\\n\\nfeat: exclude raw trace\\n");
fs.writeFileSync(verification, "# Verification\\n\\nStatus: passed\\n\\n## Commands\\n\\n- fake pi passed\\n");
console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "delta", partial: { content: [{ type: "text", text: "raw token" }] } } }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }));
`, { mode: 0o755 });

  const ralph = new RalphOrchestrator(cwd);
  const state = await ralph.start({ name: "tracked-artifacts", todos: ["Touch math module"] });
  await ralph.run("tracked-artifacts", { maxIterations: 1 });

  const tracked = (await execFileAsync("git", ["ls-files", ".ralph"], { cwd })).stdout;
  assert.match(tracked, /\.ralph\/.gitignore/);
  assert.match(tracked, /worker-output\.jsonl/);
  assert.doesNotMatch(tracked, /worker-output\.raw\.jsonl/);
  await fs.access(path.join(cwd, ".ralph", "orchestrator", "loops", state.name, "iterations", "001", "worker-output.raw.jsonl"));
});

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
  bg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

const taggedTheme = {
  fg(color: string, text: string) {
    return `<${color}>${text}</${color}>`;
  },
  bg(color: string, text: string) {
    return `<bg:${color}>${text}</bg:${color}>`;
  },
  bold(text: string) {
    return text;
  },
};

async function createMathFixture(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-fixture-"));
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.mkdir(path.join(cwd, "test"), { recursive: true });
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2), "utf8");
  await fs.writeFile(path.join(cwd, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
  await fs.writeFile(path.join(cwd, "test", "math.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n});\n", "utf8");
  await fs.writeFile(path.join(cwd, ".gitignore"), ".ralph/\n.ralph-orchestrator/\n.tmp/\n", "utf8");
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "ralph@example.test"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Ralph Test"], { cwd });
  await execFileAsync("git", ["add", "-A"], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial fixture"], { cwd });
  return cwd;
}
