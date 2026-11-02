import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readVersion(): string {
  const candidates = [path.join(process.cwd(), "..", "VERSION"), path.join(process.cwd(), "VERSION")];
  for (const p of candidates) {
    try {
      const v = fs.readFileSync(p, "utf8").split(/\s+/)[0].trim();
      if (v) return v;
    } catch {
    }
  }
  return "";
}

function shortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

function webVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

export async function GET() {
  const coreVersion = readVersion();
  const web = webVersion();
  const m = coreVersion.match(/-(rc|beta|alpha|next)\b/i);
  const channel = m ? m[1].toLowerCase() : web && /^0\./.test(web) ? "alpha" : "stable";
  const version = web ? `web ${web}` : coreVersion;
  return Response.json({ version, coreVersion, channel, sha: shortSha() });
}
