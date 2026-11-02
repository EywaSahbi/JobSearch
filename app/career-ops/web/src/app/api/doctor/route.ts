import { execFile } from "node:child_process";
import fs from "node:fs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const root = careerOpsRoot();
  const doctor = rootScript("doctor");
  if (!fs.existsSync(doctor)) {
    return Response.json({ available: false, onboardingNeeded: false, missing: [], warnings: [] });
  }
  const stdout = await new Promise<string>((resolve) => {
    execFile("node", [doctor, "--json"], { cwd: root, timeout: 10_000 }, (_err, out) => resolve(out || ""));
  });
  try {
    const last = stdout.trim().split("\n").pop() || "{}";
    const j = JSON.parse(last);
    return Response.json({ available: true, onboardingNeeded: !!j.onboardingNeeded, missing: j.missing ?? [], warnings: j.warnings ?? [] });
  } catch {
    return Response.json({ available: false, onboardingNeeded: false, missing: [], warnings: [] });
  }
}
