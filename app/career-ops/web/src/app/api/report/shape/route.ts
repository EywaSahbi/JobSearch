import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, doctorState, readApplications, readInbox, trackerCanDelete } from "@/lib/career-ops";
import { scannerSupportsJson } from "@/lib/core/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function lineCount(rel: string, predicate: (l: string) => boolean): number {
  try {
    return fs
      .readFileSync(path.join(careerOpsRoot(), rel), "utf8")
      .split("\n")
      .filter(predicate).length;
  } catch {
    return 0;
  }
}

function dirCount(rel: string, ext: string): number {
  try {
    return fs.readdirSync(path.join(careerOpsRoot(), rel)).filter((f) => f.endsWith(ext)).length;
  } catch {
    return 0;
  }
}

export async function GET() {
  const doctor = doctorState();
  const inboxCandidates = lineCount("data/pipeline.md", (l) => /^\s*-\s*\[[ xX]\]/.test(l));
  const trackerCandidates = lineCount(
    "data/applications.md",
    (l) => l.trim().startsWith("|") && !/^\|\s*#\s*\|/.test(l.trim()) && !/^\|\s*:?-{2,}/.test(l.trim()),
  );
  return Response.json({
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    setup: {
      phase: doctor.phase,
      missing: doctor.missing,
      hasCv: doctor.hasCv,
      hasData: doctor.hasData,
    },
    data: {
      inbox: { candidates: inboxCandidates, parsed: readInbox().length },
      tracker: { candidates: trackerCandidates, parsed: readApplications().length },
      reports: dirCount("reports", ".md"),
      pdfs: dirCount("output", ".pdf"),
      followupsFile: fs.existsSync(path.join(careerOpsRoot(), "data", "follow-ups.md")),
    },
    capabilities: {
      scanJson: scannerSupportsJson(),
      trackerDelete: trackerCanDelete(),
    },
  });
}
