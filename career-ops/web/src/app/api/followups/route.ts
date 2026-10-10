import { execFile } from "node:child_process";
import fs from "node:fs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { selectDueFollowups, pickNextUpcoming } from "@/lib/core/followup-view.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const full = new URL(req.url).searchParams.get("full") === "1";
  const script = rootScript("followup-cadence");
  if (!fs.existsSync(script)) return Response.json({ available: false, metadata: null, entries: [], nextUpcoming: null });
  const stdout = await new Promise<string>((resolve) => {
    execFile("node", [script, "--json"], { cwd: careerOpsRoot(), timeout: 12_000 }, (err, out) => resolve(err ? "" : out || ""));
  });
  try {
    const start = stdout.indexOf("{");
    const j = JSON.parse(stdout.slice(start));
    const entries = Array.isArray(j.entries) ? j.entries : [];
    if (full) {
      return Response.json({
        available: true,
        metadata: j.metadata ?? null,
        entries,
        cadenceConfig: j.cadenceConfig ?? null,
      });
    }
    const due = selectDueFollowups(entries, 8);
    const nextUpcoming = due.length ? null : pickNextUpcoming(entries);
    return Response.json({ available: true, metadata: j.metadata ?? null, entries: due, nextUpcoming });
  } catch {
    return Response.json({ available: false, metadata: null, entries: [], nextUpcoming: null });
  }
}
