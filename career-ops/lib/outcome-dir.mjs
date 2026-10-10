import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export function outcomeDirsFor(outcomesRoot, num) {
  if (!existsSync(outcomesRoot)) return [];
  const prefix = `${String(num)}_`;
  const mtime = (name) => {
    const log = join(outcomesRoot, name, 'outcome.md');
    if (!existsSync(log)) return -1;
    try {
      return statSync(log).mtimeMs;
    } catch {
      return -1;
    }
  };
  return readdirSync(outcomesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort((a, b) => (mtime(b) - mtime(a)) || (a < b ? -1 : a > b ? 1 : 0));
}

export function resolveOutcomeDir(outcomesRoot, num, fallbackName) {
  const existing = outcomeDirsFor(outcomesRoot, num);
  return { name: existing[0] ?? fallbackName, existing };
}
