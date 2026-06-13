import fs from "node:fs/promises";
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

  async createRef(ref: string, target = "HEAD"): Promise<void> {
    await this.run(["update-ref", `refs/${ref}`, target]);
  }

  async refExists(ref: string): Promise<boolean> {
    try {
      await this.run(["rev-parse", "--verify", "--quiet", `refs/${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  async headRef(): Promise<string> {
    return this.run(["rev-parse", "HEAD"]);
  }

  async isWorktreeDirty(options: { ignorePrefixes?: string[] } = {}): Promise<boolean> {
    const status = await this.run(["status", "--porcelain"], { trim: false });
    return status
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .some((line) => !isIgnoredStatusLine(line, options.ignorePrefixes ?? []));
  }

  async resetHard(ref: string): Promise<void> {
    await this.run(["reset", "--hard", `refs/${ref}`]);
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

  async recentCommitSubjects(limit = 25): Promise<string[]> {
    try {
      const output = await this.run(["log", `-${limit}`, "--format=%s"], { trim: false });
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async inferCommitConvention(): Promise<string> {
    const subjects = await this.recentCommitSubjects();
    return inferCommitConventionFromSubjects(subjects);
  }

  async diffStats(base = "HEAD", options: { excludePrefixes?: string[]; includeUntracked?: boolean; includePaths?: string[] } = {}): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
    const excludePrefixes = options.excludePrefixes ?? [];
    const pathspecs = [".", ...excludePrefixes.map((prefix) => `:(exclude)${prefix}`)];
    const numstat = await this.run(["diff", "--numstat", base, "--", ...pathspecs], { trim: false });
    const trackedPaths = new Set<string>();
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [added, removed, filePath] = line.split("\t");
      if (filePath) trackedPaths.add(filePath);
      filesChanged += 1;
      insertions += parseNumstatCount(added);
      deletions += parseNumstatCount(removed);
    }

    const extraUntracked = new Set<string>();
    if (options.includeUntracked) {
      for (const filePath of await this.untrackedPaths(excludePrefixes)) extraUntracked.add(filePath);
    }
    for (const filePath of cleanDeclaredPaths(options.includePaths ?? [], excludePrefixes)) {
      if (!(await this.isTracked(filePath))) extraUntracked.add(filePath);
    }

    for (const filePath of extraUntracked) {
      if (trackedPaths.has(filePath)) continue;
      const stats = await this.untrackedFileStats(filePath);
      if (!stats) continue;
      filesChanged += 1;
      insertions += stats.insertions;
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

  async addAllAndCommit(message: string, options: { ignoreWorkerLogs?: boolean } = {}): Promise<boolean> {
    await this.run(["add", "-A"]);
    if (options.ignoreWorkerLogs ?? true) await this.unstageRalphWorkerLogs();
    const staged = await this.run(["diff", "--cached", "--name-only"]);
    if (!staged.trim()) return false;
    await this.run(["commit", "-m", message]);
    return true;
  }

  private async unstageRalphWorkerLogs(): Promise<void> {
    const staged = await this.run(["diff", "--cached", "--name-only"], { trim: false });
    const logPaths = staged
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .filter(isRalphWorkerLogPath);
    if (logPaths.length === 0) return;
    await this.run(["reset", "-q", "HEAD", "--", ...logPaths]);
  }

  private async isTracked(filePath: string): Promise<boolean> {
    try {
      await this.run(["ls-files", "--error-unmatch", "--", filePath]);
      return true;
    } catch {
      return false;
    }
  }

  private async untrackedFileStats(filePath: string): Promise<{ insertions: number } | undefined> {
    try {
      const stat = await fs.stat(`${this.cwd}/${filePath}`);
      if (!stat.isFile()) return undefined;
      const text = await fs.readFile(`${this.cwd}/${filePath}`, "utf8");
      return { insertions: text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0) };
    } catch {
      return { insertions: 0 };
    }
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

function isRalphWorkerLogPath(filePath: string): boolean {
  return filePath.startsWith(".loop/") && /(^|\/)worker-output(?:\.raw)?\.jsonl(?:\..*)?$/.test(filePath);
}

function cleanDeclaredPaths(paths: string[], excludePrefixes: string[]): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const rawPath of paths) {
    const normalized = rawPath.trim().replace(/^\.[/\\]/, "").replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized.includes("..")) continue;
    if (excludePrefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) continue;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      clean.push(normalized);
    }
  }
  return clean;
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

export function inferCommitConventionFromSubjects(subjects: string[]): string {
  const meaningful = subjects.map((subject) => subject.trim()).filter(Boolean);
  if (meaningful.length === 0) return "Conventional Commits (e.g. feat: add capability, fix: correct behavior).";
  const conventionalCount = meaningful.filter((subject) => /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]+\))?!?: .+/.test(subject)).length;
  if (conventionalCount >= Math.ceil(meaningful.length * 0.5)) return "Follow the project's existing Conventional Commits style inferred from recent git history.";
  const prefixes = meaningful
    .map((subject) => subject.match(/^([A-Za-z][A-Za-z0-9_-]+):\s+/)?.[1])
    .filter((prefix): prefix is string => Boolean(prefix));
  const prefixCounts = new Map<string, number>();
  for (const prefix of prefixes) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  const commonPrefixes = [...prefixCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([prefix]) => `${prefix}:`);
  if (commonPrefixes.length > 0) return `Follow the project's existing commit prefix style inferred from recent git history (${commonPrefixes.slice(0, 5).join(", ")}).`;
  return "Follow the short imperative commit-subject style inferred from recent git history; if uncertain, use Conventional Commits.";
}
