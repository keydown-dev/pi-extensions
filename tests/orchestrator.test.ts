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

test("pause prevents queued work until run resumes it", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "pause-demo", todos: ["Add subtract test and implementation"] });

  let state = await ralph.pause("pause-demo");
  assert.equal(state.control, "paused");
  assert.equal(deriveLoopStatus(state), "paused");

  state = await ralph.run("pause-demo", { maxIterations: 1, workerMode: "scripted" });
  assert.equal(state.control, "active");
  assert.equal(state.todos[0]?.status, "complete");
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

test("parseLoopStateJson validates persisted state", () => {
  const state = parseLoopStateJson(JSON.stringify({
    name: "valid-demo",
    control: "active",
    branch: "orchestrator/valid-demo",
    currentIteration: 0,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    todos: [{ id: 1, title: "Do work", status: "queued" }],
    iterations: [],
  }));

  assert.equal(state.todos[0]?.status, "queued");
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
