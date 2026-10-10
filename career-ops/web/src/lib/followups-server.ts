import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { withFollowupsLock, FollowupsBusyError } from "@/lib/core/followups-lock";

export { FollowupsBusyError };

export function followupsLogPath(): string {
  return path.join(careerOpsRoot(), "data", "follow-ups.md");
}

let queue: Promise<unknown> = Promise.resolve();
export function withLogLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function withFollowupsWrite<T>(fn: () => T | Promise<T>): Promise<T> {
  return withLogLock(() => withFollowupsLock(followupsLogPath(), fn));
}

export function followupsWriteError(e: unknown, fallback = "write failed"): Response {
  if (e instanceof FollowupsBusyError) {
    return Response.json(
      { error: "follow-ups file is busy — try again in a moment" },
      { status: 409, headers: { "Retry-After": "1" } },
    );
  }
  return Response.json({ error: e instanceof Error ? e.message : fallback }, { status: 500 });
}
