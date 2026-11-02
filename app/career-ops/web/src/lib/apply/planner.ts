import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { CAPS } from "@/lib/worker-capabilities.mjs";
import { scopeFrom } from "@/lib/claude-invocation.mjs";
import { fencingReport } from "@/lib/cli-fencing.mjs";
import type { CliSpec } from "@/lib/clis";

const ADVISOR_SCOPE = scopeFrom("Read,Glob,Grep");

export type PlannerField = {
  id: string;
  type: string;
  label: string;
  required?: boolean;
  options?: string[];
};

export type PlannerRun = { buf: string; code: number | null; signal: NodeJS.Signals | null; refused?: string };

export function runPlanner(opts: {
  cliId: string | undefined;
  spec: CliSpec;
  binPath: string;
  prompt: string;
  fieldCount: number;
  cwd: string;
  t0: number;
  log: (m: string) => void;
}): Promise<PlannerRun> {
  const { cliId, spec, binPath, prompt, fieldCount, cwd, t0, log } = opts;

  const isClaude = cliId === "claude";
  const args = isClaude
    ? ["-p", prompt, "--permission-mode", "acceptEdits", "--strict-mcp-config", "--allowedTools", ADVISOR_SCOPE.allowed, "--disallowedTools", ADVISOR_SCOPE.disallowed]
    : spec.args(prompt);
  const fencing = fencingReport({ cliId: spec.id, cliName: spec.name, capabilities: CAPS.localReadOnly });
  if (fencing.notice) log(`⚠️ ${fencing.notice}`);
  const killMs = Math.min(300_000, 150_000 + fieldCount * 6_000);
  log(`Spawning planner (timeout ${Math.round(killMs / 1000)}s)…`);

  return new Promise<PlannerRun>((resolve) => {
    let child;
    try {
      child = spawnHeadlessCli(
        binPath,
        args,
        { cwd, env: process.env },
        { cliId: spec.id, capabilities: CAPS.localReadOnly },
      );
    } catch (e) {
      const refused = e instanceof Error ? e.message : "failed to start the planner";
      log(`spawn refused: ${refused}`);
      return resolve({ buf: "", code: null, signal: null, refused });
    }
    let buf = "";
    let firstByteAt = 0;
    const hb = setInterval(() => {
      log(`…running ${Math.round((Date.now() - t0) / 1000)}s · ${buf.length} chars received`);
    }, 4000);
    child.stdout.on("data", (d: Buffer) => {
      if (!firstByteAt) {
        firstByteAt = Date.now();
        log(`first output byte at ${Math.round((firstByteAt - t0) / 1000)}s`);
      }
      buf += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      const e = d.toString().trim();
      if (e) log(`stderr: ${e.slice(0, 160).replace(/\s+/g, " ")}`);
    });
    const killer = setTimeout(() => {
      log("TIMEOUT reached → SIGTERM");
      try {
        child.kill("SIGTERM");
      } catch {
      }
    }, killMs);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      clearInterval(hb);
      resolve({ buf, code, signal });
    });
    child.on("error", (e) => {
      clearTimeout(killer);
      clearInterval(hb);
      log(`spawn error: ${e.message}`);
      resolve({ buf, code: null, signal: null });
    });
  });
}
