import { spawn } from "node:child_process";
import { careerOpsRoot, rootScript, trackerCanDelete } from "@/lib/career-ops";
import { isTrackerWriting } from "@/lib/core/run-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let deleting = false;

function parseOrphan(stderr: string): string | null {
  const m = stderr.match(/orphaned[:—-]+\s*([^\n)]+)\)?\s*$/im);
  return m ? m[1].trim() : null;
}

export async function POST(req: Request) {
  let body: { n?: string | number; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const num = String(body.n ?? "").trim();
  if (!/^\d+$/.test(num)) {
    return Response.json({ error: "a numeric application number is required" }, { status: 400 });
  }
  const dryRun = !!body.dryRun;

  if (!trackerCanDelete()) {
    return Response.json(
      { error: "Removing a tracker row needs a newer career-ops — update to delete rows from here." },
      { status: 400 },
    );
  }
  if (isTrackerWriting()) {
    return Response.json(
      { error: "An evaluation is updating your tracker right now — try again in a moment." },
      { status: 409 },
    );
  }
  if (!dryRun && deleting) {
    return Response.json({ error: "Another delete is already in progress — try again in a moment." }, { status: 409 });
  }
  if (!dryRun) deleting = true;

  const args = [rootScript("tracker"), "delete", "--num", num];
  if (dryRun) args.push("--dry-run");

  try {
    const result = await new Promise<{ code: number | null; err: string }>((resolve) => {
      let err = "";
      let child;
      try {
        child = spawn(process.execPath, args, { cwd: careerOpsRoot(), env: process.env });
      } catch (e) {
        resolve({ code: 1, err: e instanceof Error ? e.message : "failed to start tracker.mjs" });
        return;
      }
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString();
      });
      child.stdout.on("data", () => {
      });
      const killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
        }
      }, 30_000);
      child.on("error", (e) => {
        clearTimeout(killer);
        resolve({ code: 1, err: e.message });
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        resolve({ code, err });
      });
    });

    if (result.code !== 0) {
      const notFound = /No application numbered/i.test(result.err);
      return Response.json(
        { error: result.err.trim().split("\n")[0] || "delete failed" },
        { status: notFound ? 404 : 400 },
      );
    }
    return Response.json({ ok: true, dryRun, orphanReport: parseOrphan(result.err) });
  } finally {
    if (!dryRun) deleting = false;
  }
}
