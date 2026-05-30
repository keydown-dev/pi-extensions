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
import { renderRalphWidget } from "../extensions/orchestrator.js";

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

test("Ralph widget header only shows loop name", () => {
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
      { id: 2, title: "Next work", status: "queued" },
      { id: 3, title: "Later work", status: "deferred" },
    ],
    iterations: [],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 120).join("\n");
  assert.match(output, /Ralph Loop · widget-header-demo/);
  assert.doesNotMatch(output, /ready|completed|Iteration|Todos 1\/3|\/5/);
});

test("Ralph widget paginates long todo lists around current work", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-pagination-demo",
    control: "active",
    branch: "orchestrator/widget-pagination-demo",
    currentIteration: 3,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [
      { id: 1, title: "First done", status: "complete" },
      { id: 2, title: "Latest done", status: "complete" },
      { id: 3, title: "Current work", status: "running" },
      { id: 4, title: "Next work", status: "queued" },
      { id: 5, title: "Later work", status: "deferred" },
      { id: 6, title: "Future work", status: "deferred" },
      { id: 7, title: "Hidden future", status: "deferred" },
      { id: 8, title: "Also hidden", status: "deferred" },
    ],
    iterations: [],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 80).join("\n");
  assert.match(output, /↑ 1 more/);
  assert.match(output, /#2 Latest done[\s\S]*#3 Current work/);
  assert.match(output, /↓ 2 more/);
  assert.doesNotMatch(output, /#1 First done|#7 Hidden future|#8 Also hidden/);
});

test("Ralph widget dividers use border blue instead of accent", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "widget-border-demo",
    control: "active",
    branch: "orchestrator/widget-border-demo",
    currentIteration: 3,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [
      { id: 1, title: "First done", status: "complete" },
      { id: 2, title: "Latest done", status: "complete" },
      { id: 3, title: "Current work", status: "running" },
      { id: 4, title: "Next work", status: "queued" },
      { id: 5, title: "Later work", status: "deferred" },
      { id: 6, title: "Future work", status: "deferred" },
    ],
    iterations: [],
  }));

  const output = renderRalphWidget(state, undefined, taggedTheme as never, 40).join("\n");
  assert.match(output, /<border>─+/);
  assert.match(output, /<border>.*↑ 1 more/);
  assert.doesNotMatch(output, /<accent>─+/);
});

test("Ralph widget renders compact usage and omits successful verification text", () => {
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
      usage: { input: 50000, output: 30000, cacheRead: 6999, cacheWrite: 0, totalTokens: 86999, cost: 0.165567, contextTokens: 66100, contextWindow: 272000 },
    }],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 120).join("\n");
  assert.match(output, /1m 0s · ↑50k ↓30k R7\.0k · 24\.3%\/272k · \$0\.1656 · \+1 \/ -1 · 1 files/);
  assert.doesNotMatch(output, /passed|verification ok/);
});

test("Ralph widget renders running worker usage like completed rows", () => {
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
    latestUsage: { input: 60000, output: 6000, cacheRead: 0, cacheWrite: 0, totalTokens: 66000 },
  }, plainTheme as never, 160).join("\n");

  assert.match(output, /1m 20s · ↑261k ↓21k R4\.2m · 24\.3%\/272k · \$0\.1590 · openai-codex\/gpt-5\.5 · tools read, edit/);
  assert.doesNotMatch(output, /  running ·/);
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
      diff: { filesChanged: 1, insertions: 1, deletions: 0 },
    }],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 120).join("\n");
  assert.match(output, /1m 0s · \+1 \/ -0 · 1 files/);
  assert.doesNotMatch(output, /failed|verification/);
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

const plainTheme = {
  fg(_color: string, text: string) {
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
