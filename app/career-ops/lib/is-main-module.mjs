import { realpathSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const canonicalize = realpathSync.native ?? realpathSync;

export function isMainModule(moduleUrl) {
  if (typeof moduleUrl !== 'string' || moduleUrl === '') {
    throw new TypeError(`isMainModule expects import.meta.url; got ${typeof moduleUrl === 'string' ? 'an empty string' : typeof moduleUrl}`);
  }

  if (!moduleUrl.startsWith('file:')) {
    const isPath = !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(moduleUrl) || /^[a-zA-Z]:/.test(moduleUrl);
    if (isPath) {
      throw new TypeError(
        `isMainModule expects import.meta.url (a file: URL), got a filesystem path: ${moduleUrl}. ` +
        'Returning false here would silently suppress the CLI, which is the defect #3170 fixed.',
      );
    }
    return false;
  }

  if (!process.argv[1]) return false;

  let modulePath;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }

  const entryPath = resolve(process.argv[1]);

  if (entryPath === modulePath) return true;

  try {
    return canonicalize(entryPath) === canonicalize(modulePath);
  } catch {
    return false;
  }
}
