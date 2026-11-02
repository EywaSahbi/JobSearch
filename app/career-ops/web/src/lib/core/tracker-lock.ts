import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot } from "@/lib/career-ops";

type CoreLock = { release: () => void | Promise<void> };
type AcquireFn = (lockDir: string, options: Record<string, unknown>) => Promise<CoreLock>;
type LockDirFn = (trackerPath: string) => string;

const modCache = new Map<string, { acquire: AcquireFn; lockDirFor: LockDirFn }>();

async function loadCoreLock() {
  const file = path.join(careerOpsRoot(), "tracker-utils.mjs");
  const cached = modCache.get(file);
  if (cached) return cached;
  const mod = await import(/* webpackIgnore: true */ pathToFileURL(file).href);
  if (typeof mod.acquireTrackerLock !== "function" || typeof mod.trackerLockDirFor !== "function") {
    throw new Error("tracker-utils.mjs has no acquireTrackerLock/trackerLockDirFor");
  }
  const api = { acquire: mod.acquireTrackerLock as AcquireFn, lockDirFor: mod.trackerLockDirFor as LockDirFn };
  modCache.set(file, api);
  return api;
}

export class TrackerBusyError extends Error {
  constructor() {
    super("tracker is being written by another process");
    this.name = "TrackerBusyError";
  }
}

export async function withTrackerLock<T>(trackerFile: string, fn: () => T | Promise<T>): Promise<T> {
  const { acquire, lockDirFor } = await loadCoreLock();
  let lock: CoreLock;
  try {
    lock = await acquire(lockDirFor(trackerFile), {
      timeoutMs: Number(process.env.CAREER_OPS_WEB_LOCK_TIMEOUT_MS) || 5_000,
      retryMs: 50,
      tracker: trackerFile,
    });
  } catch (e) {
    const err = e as { code?: string } | null;
    if (err && err.code === "LOCK_TIMEOUT") {
      throw new TrackerBusyError();
    }
    throw e;
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
