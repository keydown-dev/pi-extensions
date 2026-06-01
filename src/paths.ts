import path from "node:path";

export const ROOT_DIR = path.join(".loop", "orchestrator");

export function slugifyLoopName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Loop name must contain at least one letter or number");
  return slug;
}

export function loopDir(cwd: string, name: string): string {
  return path.join(cwd, ROOT_DIR, "loops", slugifyLoopName(name));
}

export function iterationDir(cwd: string, name: string, iteration: number): string {
  return path.join(loopDir(cwd, name), "iterations", String(iteration).padStart(3, "0"));
}

export function statePath(cwd: string, name: string): string {
  return path.join(loopDir(cwd, name), "state.json");
}
