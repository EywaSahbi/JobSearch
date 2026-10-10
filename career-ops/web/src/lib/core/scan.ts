import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { writeTempPortals, cleanupTempPortals } from "./portals";
import { profileTargetKeywords } from "@/lib/profile-keywords.mjs";
import { titleFit } from "@/lib/title-fit.mjs";
import { resolveScanTimeoutMs, scanTimeoutMessage } from "./scan-timeout.mjs";
import { ATS_LABEL, ATS_SOURCES, type AtsSource, type DiscoveredOffer, type ExploreFilters, type FitBand, type ScanEvent } from "@/lib/explore";
import { mergeScanResults, timedOutMessage } from "./scan-merge.mjs";

export type { DiscoveredOffer, ScanEvent, AtsSource } from "@/lib/explore";
export { ATS_SOURCES } from "@/lib/explore";

const OFFER_RE = /^\s*\+\s+\[([^\]]+)\]\s+(\S+)\s+\|\s+(.+)$/;
const ATS_START_RE = /⚙\s+(\S+)\s+—\s+(\d+)\s+companies/;
const PROGRESS_RE = /(\d+)\/(\d+)\s+scanned,\s+(\d+)\s+total matches/;
const ATS_DONE_RE = /done \((\d+) unreachable boards skipped\)/;
const COMPANIES_RE = /Companies scanned:\s+(\d+)/;
const UNREACHABLE_RE = /Unreachable boards:\s+(\d+)/;
const SUMMARY_RE = /New matches:\s+(\d+)/;

function firstMatch(title: string, positives: string[]): string | undefined {
  const lower = title.toLowerCase();
  for (const k of positives) if (k && lower.includes(k.toLowerCase())) return k;
  return undefined;
}

function loadProfileTargets(): string[] {
  try {
    const doc = yaml.load(fs.readFileSync(path.join(careerOpsRoot(), "config", "profile.yml"), "utf8"));
    return profileTargetKeywords(doc && typeof doc === "object" ? (doc as Record<string, unknown>) : null);
  } catch {
    return [];
  }
}

function fitField(title: string, targets: string[]): { fit: { band: FitBand; score: number } } | Record<string, never> {
  const f = titleFit(title, targets);
  return f ? { fit: { band: f.band as FitBand, score: f.score } } : {};
}

function ingestJsonOffer(
  o: JsonOffer,
  currentAts: string,
  filters: ExploreFilters,
  seen: Set<string>,
  offers: DiscoveredOffer[],
  onEvent: (e: ScanEvent) => void,
  roleTargets: string[] = [],
): void {
  const url = (o.url || "").trim();
  if (!url || seen.has(url) || !o.company || !o.title) return;
  seen.add(url);
  const source = o.source || `${currentAts}-full`;
  const offer: DiscoveredOffer = {
    company: o.company,
    title: o.title,
    location: o.location || "",
    postedAt: o.postedAt || "",
    ats: source.replace(/-full$/, ""),
    source,
    url,
    matchedKeyword: firstMatch(o.title, filters.positive),
    ...fitField(o.title, roleTargets),
  };
  offers.push(offer);
  onEvent({ kind: "offer", offer });
}

function parseLiveOfferLine(line: string): JsonOffer | null {
  const raw = line.trim();
  const start = raw.indexOf("{");
  if (start < 0) return null;
  try {
    const ev = JSON.parse(raw.slice(start)) as JsonOffer & { kind?: string };
    if (ev?.kind !== "offer") return null;
    const url = (ev.url || "").trim();
    if (!url || !ev.company || !ev.title) return null;
    return ev;
  } catch {
    return null;
  }
}

function parseOfferLine(source: string, date: string, rest: string): Omit<DiscoveredOffer, "url"> | null {
  const fields = rest.split(" | ");
  if (fields.length < 2) return null;
  const company = fields[0].trim();
  const title = fields[1].trim();
  const location = fields.slice(2).join(" | ").trim();
  if (!company || !title) return null;
  return {
    company,
    title,
    location: location === "N/A" ? "" : location,
    postedAt: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
    ats: source.replace(/-full$/, ""),
    source,
  };
}

export function scannerSupportsJson(): boolean {
  try {
    const src = fs.readFileSync(rootScript("scan-ats-full"), "utf8");
    return src.includes("--json") && src.includes("capHit");
  } catch {
    return false;
  }
}

type JsonOffer = { company?: string; title?: string; url?: string; location?: string | null; postedAt?: string | null; source?: string };
type ScanJson = {
  companiesAvailable?: number;
  companiesScanned?: number;
  capHit?: boolean;
  datasetStatus?: Record<string, "ok" | "stale" | "empty">;
  postingsKept?: number;
  postingsDroppedNoDate?: number;
  unreachableBoards?: number;
  stoppedEarly?: boolean;
  offers?: JsonOffer[];
};

function readScanTimeoutMs(): number {
  try {
    const parsed = yaml.load(fs.readFileSync(path.join(careerOpsRoot(), "config", "profile.yml"), "utf8"));
    return resolveScanTimeoutMs(parsed);
  } catch {
    return resolveScanTimeoutMs(undefined);
  }
}

type ScannerRun = {
  json: ScanJson | null;
  timedOut: boolean;
  failed?: string;
};

function runScanner(
  ats: string[],
  useJson: boolean,
  filters: ExploreFilters,
  tempPortals: string,
  onEvent: (e: ScanEvent) => void,
  sink: { offers: DiscoveredOffer[]; seen: Set<string> },
  timeoutMs: number,
  roleTargets: string[],
): Promise<ScannerRun> {
  return new Promise((resolve) => {
    const args = [
      rootScript("scan-ats-full"),
      "--dry-run",
      "--since",
      String(Math.max(1, filters.sinceDays || 7)),
      "--ats",
      ats.join(","),
      "--limit",
      String(Math.max(1, filters.limitPerAts || 150)),
    ];
    if (useJson) args.push("--json");

    const child = spawn(process.execPath, args, {
      cwd: careerOpsRoot(),
      env: { ...process.env, CAREER_OPS_PORTALS: tempPortals },
    });

    const { offers, seen } = sink;
    let currentAts: string = ats[0] || "";
    let pending: Omit<DiscoveredOffer, "url"> | null = null;
    let companiesScanned = 0;
    let unreachable = 0;
    let outBuf = "";
    let errBuf = "";
    let jsonOut = "";

    let timedOut = false;
    let hardKiller: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (run: ScannerRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (hardKiller) clearTimeout(hardKiller);
      resolve(run);
    };

    const killer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
      }
      hardKiller = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }, 5_000);
    }, timeoutMs);

    const handleProgressLine = (line: string) => {
      const live = parseLiveOfferLine(line);
      if (live) {
        ingestJsonOffer(live, currentAts, filters, seen, offers, onEvent, roleTargets);
        return true;
      }
      const atsM = line.match(ATS_START_RE);
      if (atsM) {
        currentAts = atsM[1];
        onEvent({ kind: "atsStart", ats: atsM[1], companies: Number(atsM[2]) });
        return false;
      }
      const progM = line.match(PROGRESS_RE);
      if (progM) {
        onEvent({ kind: "progress", ats: currentAts, scanned: Number(progM[1]), total: Number(progM[2]), matches: Number(progM[3]) });
        return false;
      }
      const doneAtsM = line.match(ATS_DONE_RE);
      if (doneAtsM) {
        onEvent({ kind: "atsDone", ats: currentAts, unreachable: Number(doneAtsM[1]) });
      }
      return false;
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (pending && /^https?:\/\//i.test(trimmed)) {
        const url = trimmed.split(/\s+/)[0];
        if (!seen.has(url)) {
          seen.add(url);
          const offer: DiscoveredOffer = { ...pending, url, matchedKeyword: firstMatch(pending.title, filters.positive), ...fitField(pending.title, roleTargets) };
          offers.push(offer);
          onEvent({ kind: "offer", offer });
        }
        pending = null;
        return;
      }
      if (pending) pending = null;

      const offerM = line.match(OFFER_RE);
      if (offerM) {
        pending = parseOfferLine(offerM[1], offerM[2], offerM[3]);
        return;
      }
      const atsM = line.match(ATS_START_RE);
      if (atsM) {
        currentAts = atsM[1];
        onEvent({ kind: "atsStart", ats: atsM[1], companies: Number(atsM[2]) });
        return;
      }
      const progM = line.match(PROGRESS_RE);
      if (progM) {
        onEvent({ kind: "progress", ats: currentAts, scanned: Number(progM[1]), total: Number(progM[2]), matches: Number(progM[3]) });
        return;
      }
      const doneAtsM = line.match(ATS_DONE_RE);
      if (doneAtsM) {
        onEvent({ kind: "atsDone", ats: currentAts, unreachable: Number(doneAtsM[1]) });
        return;
      }
      const compM = line.match(COMPANIES_RE);
      if (compM) {
        companiesScanned = Number(compM[1]);
        return;
      }
      const unreachM = line.match(UNREACHABLE_RE);
      if (unreachM) {
        unreachable = Number(unreachM[1]);
        return;
      }
      const sumM = line.match(SUMMARY_RE);
      if (sumM) {
        onEvent({ kind: "summary", companiesScanned, unreachable, matches: Number(sumM[1]) });
        return;
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      if (useJson) {
        jsonOut += d.toString();
        return;
      }
      outBuf += d.toString();
      const parts = outBuf.split(/\r\n|\r|\n/);
      outBuf = parts.pop() ?? "";
      for (const p of parts) handleLine(p);
    });
    child.stderr.on("data", (d: Buffer) => {
      errBuf += d.toString();
      const parts = errBuf.split(/\r?\n/);
      errBuf = parts.pop() ?? "";
      for (const p of parts) {
        if (!p.trim()) continue;
        if (useJson) {
          if (handleProgressLine(p)) continue;
        }
        onEvent({ kind: "log", line: p.trim() });
      }
    });

    child.on("error", (e) => {
      settle({ json: null, timedOut, failed: e instanceof Error ? e.message : "scanner failed to start" });
    });
    child.on("close", () => {
      if (useJson) {
        let j: ScanJson | null = null;
        try {
          j = JSON.parse(jsonOut.trim()) as ScanJson;
        } catch {
          j = null;
        }
        settle({ json: j && Array.isArray(j.offers) ? j : null, timedOut });
        return;
      }
      if (outBuf.trim()) handleLine(outBuf);
      settle({ json: null, timedOut });
    });
  });
}

const NO_OUTPUT = "The scanner returned no readable output.";

export async function runDiscovery(filters: ExploreFilters, onEvent: (e: ScanEvent) => void): Promise<DiscoveredOffer[]> {
  const tempPortals = writeTempPortals(filters);
  const ats = (filters.ats.length ? filters.ats : [...ATS_SOURCES]).filter((a) => (ATS_SOURCES as readonly string[]).includes(a));
  const useJson = scannerSupportsJson();
  const timeoutMs = readScanTimeoutMs();
  const deadlineSec = timeoutMs / 1000;
  const roleTargets = loadProfileTargets();
  const label = (a: string) => ATS_LABEL[a as AtsSource] ?? a;
  const sink = { offers: [] as DiscoveredOffer[], seen: new Set<string>() };

  try {
    if (!useJson) {
      const run = await runScanner(ats, false, filters, tempPortals, onEvent, sink, timeoutMs, roleTargets);
      if (run.failed) onEvent({ kind: "error", message: run.failed });
      else if (run.timedOut) onEvent({ kind: "error", message: scanTimeoutMessage(timeoutMs) });
      return sink.offers;
    }

    const runs = await Promise.all(
      ats.map((a) => runScanner([a], true, filters, tempPortals, onEvent, sink, timeoutMs, roleTargets)),
    );

    const { offers, seen } = sink;
    const finished: ScanJson[] = [];
    runs.forEach((run, i) => {
      if (!run.json) return;
      finished.push(run.json);
      for (const o of run.json.offers ?? []) ingestJsonOffer(o, ats[i], filters, seen, offers, onEvent, roleTargets);
    });

    const stopped = runs.map((r) => r.timedOut || r.json?.stoppedEarly === true);
    const timedOut = ats.filter((_, i) => stopped[i]);
    const incomplete = ats.filter((_, i) => !runs[i].json || stopped[i]);

    if (finished.length === 0) {
      const failed = runs.find((r) => r.failed)?.failed;
      onEvent({
        kind: "error",
        message: timedOut.length ? timedOutMessage(timedOut.map(label), deadlineSec) : failed || NO_OUTPUT,
      });
      return offers;
    }

    if (timedOut.length) {
      const message = timedOutMessage(timedOut.map(label), deadlineSec);
      onEvent(incomplete.length === ats.length ? { kind: "error", message } : { kind: "log", line: message });
    }
    onEvent({
      kind: "summary",
      ...mergeScanResults(finished, offers.length),
      ...(incomplete.length ? { incomplete } : {}),
    });
    return offers;
  } finally {
    cleanupTempPortals(tempPortals);
  }
}
