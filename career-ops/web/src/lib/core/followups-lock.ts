import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { careerOpsRoot } from "@/lib/career-ops";

type CoreWithFollowupsLock = (
  followupsPath: string,
  fn: () => unknown,
  options?: Record<string, unknown>,
) => Promise<unknown>;

const modCache = new Map<string, CoreWithFollowupsLock>();

async function loadCoreLock(): Promise<CoreWithFollowupsLock | null> {
  const file = path.join(careerOpsRoot(), "followup-seed.mjs");
  const cached = modCache.get(file);
  if (cached) return cached;
  if (!fs.existsSync(file)) return null;
  const mod = await import(/* webpackIgnore: true */ pathToFileURL(file).href);
  if (typeof mod.withFollowupsLock !== "function") {
    throw new Error("followup-seed.mjs has no withFollowupsLock export");
  }
  const api = mod.withFollowupsLock as CoreWithFollowupsLock;
  modCache.set(file, api);
  return api;
}

export class FollowupsBusyError extends Error {
  constructor() {
    super("follow-ups file is being written by another process");
    this.name = "FollowupsBusyError";
  }
}

export async function withFollowupsLock<T>(followupsPath: string, fn: () => T | Promise<T>): Promise<T> {
  const core = await loadCoreLock();
  if (!core) return await fn();
  try {
    return (await core(followupsPath, fn as () => unknown, {
      timeoutMs: Number(process.env.CAREER_OPS_WEB_FOLLOWUPS_LOCK_TIMEOUT_MS) || 5_000,
    })) as T;
  } catch (e) {
    const err = e as { name?: string; code?: string } | null;
    if (err && err.name === "SeedError" && err.code === "LOCK_TIMEOUT") {
      throw new FollowupsBusyError();
    }
    throw e;
  }
}
