import path from "node:path";

export function scheduledStorePath(root, configuredPath = process.env.CAREER_OPS_SCHEDULED_JOBS_PATH) {
  if (configuredPath) return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(root, configuredPath);
  return path.join(root, "data", "scheduled-jobs.json");
}

export function scheduledRunnerResourcePath(storePath) {
  return `${storePath}.runner`;
}
