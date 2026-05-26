import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitPolicy {
  constructor(private readonly cwd: string) {}

  async run(args: string[], options: { trim?: boolean } = {}): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: this.cwd });
    return options.trim === false ? stdout : stdout.trim();
  }

  async assertRepo(): Promise<void> {
    await this.run(["rev-parse", "--show-toplevel"]);
  }

  async assertCleanWorktree(options: { ignorePrefixes?: string[] } = {}): Promise<void> {
    const status = await this.run(["status", "--porcelain"], { trim: false });
    const dirtyLines = status
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .filter((line) => !isIgnoredStatusLine(line, options.ignorePrefixes ?? []));
    if (dirtyLines.length > 0) {
      throw new Error(`Ralph requires a clean worktree. Dirty paths:\n${dirtyLines.join("\n")}`);
    }
  }

  async currentBranch(): Promise<string> {
    return this.run(["branch", "--show-current"]);
  }

  async checkoutBranch(branch: string): Promise<void> {
    const branches = await this.run(["branch", "--list", branch]);
    if (branches.trim()) await this.run(["checkout", branch]);
    else await this.run(["checkout", "-b", branch]);
  }

  async createRef(ref: string): Promise<void> {
    await this.run(["update-ref", `refs/${ref}`, "HEAD"]);
  }

  async captureStatus(): Promise<string> {
    return this.run(["status", "--short", "--branch"], { trim: false });
  }

  async changedPaths(): Promise<string[]> {
    const status = await this.run(["status", "--porcelain"], { trim: false });
    return status
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => line.slice(3));
  }

  async diffStats(base = "HEAD", options: { excludePrefixes?: string[]; includeUntracked?: boolean } = {}): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
    const pathspecs = [".", ...(options.excludePrefixes?.map((prefix) => `:(exclude)${prefix}`) ?? [])];
    if (options.includeUntracked) {
      const untracked = await this.untrackedPaths(options.excludePrefixes ?? []);
      if (untracked.length > 0) await this.run(["add", "-N", "--", ...untracked]);
    }
    const numstat = await this.run(["diff", "--numstat", base, "--", ...pathspecs], { trim: false });
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [added, removed] = line.split("\t");
      filesChanged += 1;
      insertions += parseNumstatCount(added);
      deletions += parseNumstatCount(removed);
    }
    return { filesChanged, insertions, deletions };
  }

  private async untrackedPaths(excludePrefixes: string[]): Promise<string[]> {
    const output = await this.run(["ls-files", "--others", "--exclude-standard"], { trim: false });
    return output
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .filter((filePath) => !excludePrefixes.some((prefix) => filePath === prefix || filePath.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)));
  }

  async addAllAndCommit(message: string): Promise<boolean> {
    await this.run(["add", "-A"]);
    const staged = await this.run(["diff", "--cached", "--name-only"]);
    if (!staged.trim()) return false;
    await this.run(["commit", "-m", message]);
    return true;
  }
}

function parseNumstatCount(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isIgnoredStatusLine(line: string, ignorePrefixes: string[]): boolean {
  const pathPart = line.slice(3);
  return ignorePrefixes.some((prefix) => pathPart === prefix || pathPart.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

export function orchestrationBranch(loopName: string): string {
  return `orchestrator/${loopName}`;
}

export function beforeRef(loopName: string, iteration: number): string {
  return `ralph/${loopName}/iter-${String(iteration).padStart(3, "0")}-before`;
}

export function afterRef(loopName: string, iteration: number): string {
  return `ralph/${loopName}/iter-${String(iteration).padStart(3, "0")}-after`;
}
