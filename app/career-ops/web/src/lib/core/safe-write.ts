import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
    }
    throw err;
  }
}

export function backup(file: string): string | null {
  let cur: Buffer;
  try {
    cur = fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!cur.toString("utf8").trim()) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${file}.bak-${ts}`;
  fs.writeFileSync(bak, cur);
  return bak;
}

export function atomicWriteWithBackup(file: string, content: string): string | null {
  const bak = backup(file);
  atomicWrite(file, content);
  return bak;
}
