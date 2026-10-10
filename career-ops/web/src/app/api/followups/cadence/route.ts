import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { isMapping } from "@/lib/portals-config.mjs";
import { PROFILE_CADENCE_KEYS, type ProfileCadenceKey } from "@/lib/followups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function readCoreDefaults(): Promise<Partial<Record<ProfileCadenceKey, number>> | null> {
  const script = rootScript("followup-cadence");
  if (!fs.existsSync(script)) return null;
  const stdout = await new Promise<string>((resolve) => {
    execFile("node", [script, "--json"], { cwd: careerOpsRoot(), timeout: 12_000 }, (_e, out) => resolve(out || ""));
  });
  try {
    const start = stdout.indexOf("{");
    if (start === -1) return null;
    const parsed = JSON.parse(stdout.slice(start)) as { cadenceDefaults?: unknown };
    if (!isObj(parsed.cadenceDefaults)) return null;
    const core = parsed.cadenceDefaults;
    const out: Partial<Record<ProfileCadenceKey, number>> = {};
    for (const key of PROFILE_CADENCE_KEYS) {
      const coreKey = key === "applied_max_followups" ? key : key.replace(/_days$/, "");
      const raw = core[coreKey];
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
      out[key] = raw;
    }
    return out;
  } catch {
    return null;
  }
}

export async function GET() {
  const file = path.join(careerOpsRoot(), "config", "profile.yml");
  const overrides: Partial<Record<ProfileCadenceKey, number>> = {};
  if (fs.existsSync(file)) {
    let profile: Record<string, unknown> = {};
    try {
      const parsed = yaml.load(fs.readFileSync(file, "utf8"));
      profile = isObj(parsed) ? parsed : {};
    } catch {
    }
    const source = isObj(profile.followup_cadence) ? profile.followup_cadence : {};
    for (const key of PROFILE_CADENCE_KEYS) {
      const n = Number.parseInt(String(source[key]), 10);
      if (Number.isFinite(n) && n >= 0) overrides[key] = n;
    }
  }
  const defaults = await readCoreDefaults();
  const effective = { ...(defaults ?? {}), ...overrides };
  return Response.json({ defaults: defaults ?? {}, defaultsAvailable: defaults !== null, overrides, effective });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const cadence: Record<string, number> = {};
  for (const key of PROFILE_CADENCE_KEYS) {
    if (body[key] == null) continue;
    const n = Number.parseInt(String(body[key]), 10);
    if (!Number.isInteger(n) || n < 0) {
      return Response.json({ error: `${key} must be a non-negative integer` }, { status: 400 });
    }
    cadence[key] = n;
  }
  if (Object.keys(cadence).length === 0) return Response.json({ error: "nothing to write" }, { status: 400 });

  const root = careerOpsRoot();
  const file = path.join(root, "config", "profile.yml");
  let base: Record<string, unknown> = {};
  if (!fs.existsSync(file)) {
    try {
      const seeded = yaml.load(fs.readFileSync(path.join(root, "config", "profile.example.yml"), "utf8"));
      base = isObj(seeded) ? seeded : {};
    } catch {
      base = {};
    }
  } else {
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(file, "utf8"));
    } catch {
      return Response.json({ error: "config/profile.yml exists but could not be read as YAML — refusing to overwrite it." }, { status: 409 });
    }
    if (!isMapping(parsed)) {
      return Response.json({ error: "config/profile.yml must contain named settings, not a list or single value. Refusing to overwrite it." }, { status: 409 });
    }
    base = parsed as Record<string, unknown>;
  }

  const merged = {
    ...base,
    followup_cadence: { ...(isObj(base.followup_cadence) ? base.followup_cadence : {}), ...cadence },
  };
  try {
    atomicWriteWithBackup(file, yaml.dump(merged, { lineWidth: 100, noRefs: true }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
  }
  return Response.json({ ok: true, followup_cadence: merged.followup_cadence });
}
