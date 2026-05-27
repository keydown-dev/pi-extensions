import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
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
  assert.match(status, /└─ ✓ #3 Add divide/);
  assert.match(status, /\+\d+ \/ -\d+ · \d+ files/);

  const handoffOut = await fs.readFile(path.join(cwd, ".ralph", "orchestrator", "loops", "math-kata", "iterations", "003", "handoff-out.md"), "utf8");
  assert.match(handoffOut, /Added divide test and implementation/);

  const refs = (await execFileAsync("git", ["show-ref"], { cwd })).stdout;
  assert.match(refs, /refs\/ralph\/math-kata\/iter-001-before/);
  assert.match(refs, /refs\/ralph\/math-kata\/iter-003-after/);
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

  assert.ok(progressMessages.some((message) => message.includes("◐ #1 Add subtract test and implementation (working)")));
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
      usage: { input: 50000, output: 30000, cacheRead: 6999, cacheWrite: 0, totalTokens: 86999, cost: 0.165567 },
    }],
  }));

  const output = renderRalphWidget(state, undefined, plainTheme as never, 120).join("\n");
  assert.match(output, /passed · \+1 \/ -1 · 1 files · 87\.0k tok · \$0\.1656/);
  assert.doesNotMatch(output, /verification ok/);
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
  assert.match(output, /failed · \+1 \/ -0 · 1 files · ✗ verification/);
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
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: 0.1234 },
      summary: "Did work.",
      changedFiles: ["src/work.ts"],
    }],
  }));

  assert.equal(state.todos[0]?.status, "complete");
  assert.equal(state.iterations[0]?.usage?.totalTokens, 18);
  assert.deepEqual(state.iterations[0]?.changedFiles, ["src/work.ts"]);
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
  const trackedArtifacts = (await execFileAsync("git", ["ls-files", ".ralph", ".ralph-orchestrator"], { cwd })).stdout.trim();
  assert.equal(trackedArtifacts, "");
});

const plainTheme = {
  fg(_color: string, text: string) {
    return text;
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
