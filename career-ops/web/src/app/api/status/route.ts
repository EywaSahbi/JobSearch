import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { canonicalizeStatus } from "@/lib/core/states";
import { parseCliJson, trackerRowArg, clientErrorMessage } from "@/lib/status-cli.mjs";

export const runtime = "nodejs";

const SET_STATUS_TIMEOUT_MS = 30_000;

const LOCK_WAIT_DEFAULT_MS = 10_000;
const LOCK_WAIT_CEILING_MS = SET_STATUS_TIMEOUT_MS - 5_000;

function boundedLockWait(): Record<string, string> {
  const raw = Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS);
  const requested = Number.isFinite(raw) && raw > 0 ? raw : LOCK_WAIT_DEFAULT_MS;
  return { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: String(Math.min(requested, LOCK_WAIT_CEILING_MS)) };
}

const EXIT_TO_HTTP: Record<number, number> = { 2: 404, 3: 409, 4: 503 };

const CLIENT_ERROR_CODES = new Set(["usage", "invalid-state"]);

type CliResult = { code: number; stdout: string; stderr: string; spawnFailed: boolean; timedOut: boolean };

function runSetStatus(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [rootScript("set-status"), ...args],
      {
        cwd: careerOpsRoot(),
        timeout: SET_STATUS_TIMEOUT_MS,
        env: { ...process.env, ...boundedLockWait() },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const timedOut = e?.killed === true;
        const code = typeof e?.code === "number" ? e.code : e ? -1 : 0;
        resolve({
          code,
          stdout: stdout || "",
          stderr: stderr || "",
          spawnFailed: !timedOut && code === -1,
          timedOut,
        });
      },
    );
  });
}

export async function POST(req: Request) {
  let body: { n?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { n, status } = body;
  if (!n || typeof status !== "string" || !status.trim()) {
    return NextResponse.json({ error: "n and status required" }, { status: 400 });
  }
  if (/[|\r\n*]/.test(status)) {
    return NextResponse.json({ error: "invalid status (table-breaking characters)" }, { status: 400 });
  }
  const canon = canonicalizeStatus(status);
  if (!canon) {
    return NextResponse.json({ error: `not a canonical status: ${status}` }, { status: 400 });
  }
  const row = trackerRowArg(n);
  if (!row) {
    return NextResponse.json({ error: "n must be a tracker row number" }, { status: 400 });
  }

  const script = rootScript("set-status");
  if (!fs.existsSync(script)) {
    return NextResponse.json(
      {
        error: "status updates need the career-ops scripts; this root has data only",
        code: "core-script-missing",
      },
      { status: 503 },
    );
  }

  const { code, stdout, stderr, spawnFailed, timedOut } = await runSetStatus([
    "--row",
    row,
    canon,
    "--source",
    "web",
    "--json",
  ]);
  const parsed = parseCliJson(stdout);

  if (spawnFailed) {
    console.error(`/api/status: set-status.mjs failed to run: ${stderr.trim()}`);
    return NextResponse.json({ error: "status update failed to run" }, { status: 500 });
  }

  if (timedOut) {
    return NextResponse.json(
      { error: "status update timed out; the change may or may not have been applied" },
      { status: 504, headers: { "Retry-After": "5" } },
    );
  }

  if (code !== 0) {
    const cliCode = typeof parsed?.code === "string" ? parsed.code : undefined;
    const httpStatus =
      code === 1
        ? (cliCode && CLIENT_ERROR_CODES.has(cliCode) ? 400 : 500)
        : (EXIT_TO_HTTP[code] ?? 500);
    if (!parsed && stderr.trim()) {
      console.error(`/api/status: set-status.mjs exited ${code} without JSON: ${stderr.trim()}`);
    }
    const error = clientErrorMessage(parsed, stderr);
    return NextResponse.json(
      { error, ...(cliCode ? { code: cliCode } : {}) },
      {
        status: httpStatus,
        ...(httpStatus === 503 ? { headers: { "Retry-After": "5" } } : {}),
      },
    );
  }

  if (!parsed) {
    return NextResponse.json({ error: "status update returned no result" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    status: canon,
    changed: parsed.changed === true,
    statusLogged: parsed.statusLogged === true,
  });
}
