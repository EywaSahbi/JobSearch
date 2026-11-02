import { execFile } from "node:child_process";
import fs from "node:fs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const script = rootScript("analyze-patterns");
  if (!fs.existsSync(script)) return Response.json({ available: false, patterns: null });

  const stdout = await new Promise<string>((resolve) => {
    execFile("node", [script], { cwd: careerOpsRoot(), timeout: 30_000, maxBuffer: 8 << 20 }, (_err, out) =>
      resolve(out || ""),
    );
  });

  try {
    const start = stdout.indexOf("{");
    if (start < 0) return Response.json({ available: false, patterns: null });
    return Response.json({ available: true, patterns: JSON.parse(stdout.slice(start)) });
  } catch {
    return Response.json({ available: false, patterns: null });
  }
}
