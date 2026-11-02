import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, realpathSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getCareerOpsRoot() {
  const env = process.env.CAREER_OPS_ROOT?.trim() || process.env.CAREER_OPS_DATA_DIR?.trim();
  if (env) {
    return resolve(__dirname, env);
  }
  const markerFile = join(__dirname, '.career-ops-data');
  if (existsSync(markerFile)) {
    try {
      const content = readFileSync(markerFile, 'utf-8').trim();
      if (content) {
        return resolve(__dirname, content);
      }
    } catch {
    }
  }
  return __dirname;
}

export function canonicalizeTrackerPath(path) {
  const absolutePath = resolve(path);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

export function resolveTrackerPath(rootDir) {
  return canonicalizeTrackerPath(rawTrackerPath(rootDir));
}

export function rawTrackerPath(rootDir) {
  const env = process.env.CAREER_OPS_TRACKER?.trim();
  return env
    ? env
    : existsSync(join(rootDir, 'data/applications.md'))
      ? join(rootDir, 'data/applications.md')
      : join(rootDir, 'applications.md');
}

export function resolveTrackerPathForWrite(root) {
  const env = process.env.CAREER_OPS_TRACKER?.trim();
  if (env) {
    return canonicalizeTrackerPath(env);
  }
  return join(root, 'data/applications.md');
}

