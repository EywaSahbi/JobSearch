import { execFile } from "node:child_process";
import fs from "node:fs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const script = rootScript("stats");
  if (!fs.existsSync(script)) return Response.json({ available: false, stats: null });

  const stdout = await new Promise<string>((resolve) => {
    execFile("node", [script], { cwd: careerOpsRoot(), timeout: 20_000, maxBuffer: 8 << 20 }, (err, out) =>
      resolve(err ? "" : out || ""),
    );
  });

  try {
    const start = stdout.indexOf("{");
    if (start < 0) return Response.json({ available: false, stats: null });
    return Response.json({ available: true, stats: JSON.parse(stdout.slice(start)) });
  } catch {
    return Response.json({ available: false, stats: null });
  }
}
