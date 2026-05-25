import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkerInput, WorkerProgress, WorkerResult } from "./types.js";

const execFileAsync = promisify(execFile);

export class ScriptedMathWorker {
  async assertCanRun(cwd: string): Promise<void> {
    const missing = [];
    for (const relativePath of ["src/math.js", "test/math.test.js", "package.json"]) {
      try {
        await fs.access(path.join(cwd, relativePath));
      } catch {
        missing.push(relativePath);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `The current /ralph run implementation uses the scripted math-kata test worker and cannot run in this project. Missing: ${missing.join(", ")}. Real Pi subagent execution is the next implementation slice.`,
      );
    }
  }

  async runIteration(input: WorkerInput, onProgress?: (progress: WorkerProgress) => void): Promise<WorkerResult> {
    await this.assertCanRun(input.cwd);
    const title = input.todo.title.toLowerCase();
    const op = title.includes("subtract") ? "subtract" : title.includes("multiply") ? "multiply" : title.includes("divide") ? "divide" : undefined;
    if (!op) throw new Error(`Scripted worker only knows subtract/multiply/divide todos. Got: ${input.todo.title}`);

    onProgress?.({ phase: "running", configuredModel: input.workerModel, elapsedMs: 0, events: 1, toolCalls: 0, toolNames: [], assistantMessages: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, lastEventType: "scripted_edit" });
    await addMathOperation(input.cwd, op);

    let exitCode = 0;
    let summary = "npm test passed";
    try {
      await execFileAsync("npm", ["test"], { cwd: input.cwd, timeout: 30_000 });
    } catch (error) {
      exitCode = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      summary = `npm test failed: ${(error as Error).message}`;
    }

    onProgress?.({ phase: "exited", configuredModel: input.workerModel, elapsedMs: 0, events: 2, toolCalls: 0, toolNames: [], assistantMessages: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, lastEventType: "scripted_exit" });

    return {
      summary: `Added ${op} test and implementation via scripted worker.`,
      changedFiles: ["src/math.js", "test/math.test.js"],
      verification: {
        status: exitCode === 0 ? "passed" : "failed",
        commands: [{ command: "npm test", exitCode, summary }],
      },
    };
  }
}

async function addMathOperation(cwd: string, op: "subtract" | "multiply" | "divide"): Promise<void> {
  const src = path.join(cwd, "src", "math.js");
  const test = path.join(cwd, "test", "math.test.js");
  let srcText = await fs.readFile(src, "utf8");
  let testText = await fs.readFile(test, "utf8");

  if (!srcText.includes(`function ${op}`)) {
    const body = op === "subtract" ? "return a - b;" : op === "multiply" ? "return a * b;" : "return a / b;";
    srcText += `\nexport function ${op}(a, b) {\n  ${body}\n}\n`;
  }

  if (!testText.includes(`${op}(`)) {
    const expected = op === "subtract" ? 2 : op === "multiply" ? 12 : 3;
    const args = op === "divide" ? "12, 4" : "5, 3";
    const importLine = `import { add`;
    testText = testText.replace(importLine, `import { add, ${op}`);
    testText += `\ntest("${op}", () => {\n  assert.equal(${op}(${args}), ${expected});\n});\n`;
  }

  await fs.writeFile(src, srcText, "utf8");
  await fs.writeFile(test, testText, "utf8");
}
