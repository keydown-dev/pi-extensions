import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { GitPolicy } from "../src/git.js";
import { RalphOrchestrator, renderStatus } from "../src/orchestrator.js";

const execFileAsync = promisify(execFile);

test("scripted Ralph loop adds tests and implementations over three iterations", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);

  let state = await ralph.start({ name: "math-kata" });
  assert.equal(state.status, "ready");
  assert.equal(state.todos.length, 3);

  state = await ralph.run("math-kata", { maxIterations: 3, workerMode: "scripted" });

  assert.equal(state.currentIteration, 3);
  assert.equal(state.status, "completed");
  assert.equal(state.todos.filter((todo) => todo.status === "completed").length, 3);
  assert.equal(state.iterations.length, 3);
  assert.ok(state.iterations.every((iteration) => iteration.status === "accepted"));

  await execFileAsync("npm", ["test"], { cwd });

  const status = renderStatus(state);
  assert.match(status, /Ralph Orchestrator · math-kata/);
  assert.match(status, /Todos 3\/3/);
  assert.match(status, /└─ ✓ #3 Add divide/);

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

test("legacy .ralph artifacts do not block orchestrator commands", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, ".ralph"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".ralph", "legacy.md"), "legacy flat Ralph state", "utf8");

  const ralph = new RalphOrchestrator(cwd);
  const state = await ralph.start({ name: "with-legacy-ralph" });

  assert.equal(state.name, "with-legacy-ralph");
  assert.equal(state.status, "ready");
  await fs.access(path.join(cwd, ".ralph", "orchestrator", "loops", "with-legacy-ralph", "state.json"));
});

test("run emits progress with running todo before worker completes", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const ralph = new RalphOrchestrator(cwd);
  await ralph.start({ name: "progress-demo", todos: ["Add subtract test and implementation"] });
  const progressMessages: string[] = [];

  await ralph.next("progress-demo", {
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

  await ralph.next("model-progress", {
    workerMode: "scripted",
    workerModel: "test-provider/test-model:low",
    onProgress(progress) {
      models.push(progress.worker?.configuredModel);
    },
  });

  assert.ok(models.includes("test-provider/test-model:low"));
});

test("changedPaths preserves leading-space porcelain paths", async (t) => {
  const cwd = await createMathFixture();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.appendFile(path.join(cwd, "src", "math.js"), "\n// local edit\n", "utf8");

  const paths = await new GitPolicy(cwd).changedPaths();

  assert.deepEqual(paths, ["src/math.js"]);
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
  await fs.writeFile(path.join(cwd, ".gitignore"), ".ralph/\n.ralph-orchestrator/\n", "utf8");
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "ralph@example.test"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Ralph Test"], { cwd });
  await execFileAsync("git", ["add", "-A"], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial fixture"], { cwd });
  return cwd;
}
