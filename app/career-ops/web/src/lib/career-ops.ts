import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { atomicWrite } from "@/lib/core/safe-write";
import { resolveDataRoot } from "@/lib/core/data-root.mjs";
import { readTrackerFile } from "@/lib/core/tracker-files.mjs";
import { resolveCodeRoot, resolveRootScript } from "@/lib/core/code-root.mjs";
import { parseApplications } from "@/lib/tracker-table.mjs";
import { parseStatusLog } from "@/lib/pipeline-sankey.mjs";
import { parseInbox, splitLines } from "@/lib/pipeline-table.mjs";
import { isReservedReportFile } from "@/lib/report-files.mjs";
import { resolvePdfIndexPath } from "@/lib/core/pdf-index";
import { pdfIndexEntryForReport } from "@/lib/apply/cv-selection.mjs";
import { NOTES_START, NOTES_END, profilePath as profileMemoryPath, readProfileMemory } from "@/lib/profile-memory.mjs";

export function careerOpsRoot(): string {
  const coreRoot = resolveCodeRoot(process.cwd(), process.env);
  return resolveDataRoot(
    coreRoot,
    (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    process.env,
    path.resolve,
    path.join,
  );
}

export function rootScript(nameNoExt: string): string {
  return resolveRootScript(resolveCodeRoot(process.cwd(), process.env), nameNoExt);
}

export function trackerCanDelete(): boolean {
  try {
    const src = fs.readFileSync(rootScript("tracker"), "utf8");
    return src.includes("delete") && src.includes("--num");
  } catch {
    return false;
  }
}

function read(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), rel), "utf8");
  } catch {
    return null;
  }
}

export type InboxJob = { url: string; company: string; role: string; location?: string; compensation?: string; done: boolean; postedAt?: string };

export function readInbox(): InboxJob[] {
  const md = read("data/pipeline.md");
  if (!md) return [];
  return parseInbox(md);
}

export function readScanDates(): Map<string, string> {
  const tsv = read("data/scan-history.tsv");
  const dates = new Map<string, string>();
  if (!tsv) return dates;
  const lines = splitLines(tsv);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (i === 0 && line.startsWith("url\t"))) continue;
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const url = line.slice(0, tab);
    const firstSeen = line.slice(tab + 1).split("\t")[0]?.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstSeen) && !dates.has(url)) dates.set(url, firstSeen);
  }
  return dates;
}

export type Application = {
  n: string;
  date: string;
  company: string;
  via: string;
  role: string;
  location: string;
  score: string;
  status: string;
  pdf: string;
  report: string;
  applyLink: string;
  followUp: string;
  notes: string;
};

export function readApplications(): Application[] {
  const md = readTrackerFile(careerOpsRoot());
  if (!md) return [];
  return parseApplications(md, careerOpsRoot(), path.resolve(process.cwd(), "..")) as Application[];
}

export type StatusLogRow = {
  num: number;
  date: string;
  from: string;
  to: string;
  source: string;
  note: string;
};

export function readStatusLog(): StatusLogRow[] {
  return parseStatusLog(readApplicationStatusLog() ?? "");
}

export function readApplicationStatusLog(): string | null {
  return readTrackerFile(careerOpsRoot(), "status-log.tsv");
}

function pdfIndexTarget(n: string): number | null {
  const trimmed = n.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

export async function pdfReadyForReport(n: string): Promise<boolean> {
  return (await pdfPathForReport(n)) !== null;
}

export type PdfPathForReportResult =
  | { status: "found"; path: string }
  | { status: "not-found" }
  | { status: "invalid" }
  | { status: "rejected" };

export async function pdfPathStatusForReport(n: string): Promise<PdfPathForReportResult> {
  const target = pdfIndexTarget(n);
  if (target === null) return { status: "invalid" };
  const indexPath = await resolvePdfIndexPath();
  if (!indexPath) return { status: "not-found" };
  let tsv: string;
  try {
    tsv = fs.readFileSync(indexPath, "utf8");
  } catch {
    return { status: "not-found" };
  }
  const root = careerOpsRoot();
  const entry = pdfIndexEntryForReport(tsv, target);
  if (!entry.found) return { status: "not-found" };
  if (!entry.path) return { status: "rejected" };
  const abs = path.resolve(root, entry.path);
  const outputDir = path.resolve(root, "output");
  if (!abs.startsWith(outputDir + path.sep)) return { status: "rejected" };
  if (!isRegularContainedFile(abs, outputDir)) return { status: "rejected" };
  return { status: "found", path: abs };
}

export async function pdfPathForReport(n: string): Promise<string | null> {
  const result = await pdfPathStatusForReport(n);
  return result.status === "found" ? result.path : null;
}

export type LifecyclePhase = "first-run" | "in-between" | "established";
export function doctorState(snapshot?: Pick<PipelineSummary, "applications" | "inbox">): {
  phase: LifecyclePhase;
  onboardingNeeded: boolean;
  missing: string[];
  hasCv: boolean;
  hasData: boolean;
} {
  const has = (rel: string) => {
    try {
      return fs.existsSync(path.join(careerOpsRoot(), rel));
    } catch {
      return false;
    }
  };
  const prereqs: [string, string][] = [
    ["cv.md", "cv.md"],
    ["config/profile.yml", "config/profile.yml"],
    ["modes/_profile.md", "modes/_profile.md"],
    ["portals.yml", "portals.yml"],
  ];
  const missing = prereqs.filter(([rel]) => !has(rel)).map(([, label]) => label);
  const hasCv = has("cv.md");
  const hasData = (snapshot?.applications ?? readApplications()).length > 0 ||
    (snapshot?.inbox ?? readInbox()).some((j) => !j.done);
  const onboardingNeeded = missing.length > 0;
  const phase: LifecyclePhase = !hasCv && !hasData ? "first-run" : onboardingNeeded ? "in-between" : "established";
  return { phase, onboardingNeeded, missing, hasCv, hasData };
}

export type PipelineSummary = {
  root: string;
  rootExists: boolean;
  inbox: InboxJob[];
  applications: Application[];
};

export function pipelineSummary(): PipelineSummary {
  const root = careerOpsRoot();
  const scanDates = readScanDates();
  return {
    root,
    rootExists: fs.existsSync(root),
    inbox: readInbox().map((j) => ({ ...j, postedAt: j.postedAt ?? scanDates.get(j.url) })),
    applications: readApplications(),
  };
}

export type ReportData = { content: string; file: string };

export function findReportFile(n: string): string | null {
  const target = parseInt(n, 10);
  if (Number.isNaN(target)) return null;
  const root = careerOpsRoot();
  const app = readApplications().find((a) => parseInt(a.n, 10) === target);
  const linked = app?.report.match(/\]\(([^)]+)\)/)?.[1];
  if (linked) {
    const p = path.resolve(root, "data", linked);
    if (p.endsWith(".md") && !isReservedReportFile(p) && containedRealpath(p, root)) return p;
  }
  let files: string[];
  try {
    files = fs.readdirSync(path.join(root, "reports"));
  } catch {
    return null;
  }
  const match = files.find(
    (f) => f.endsWith(".md") && !isReservedReportFile(f) && parseInt(f, 10) === target,
  );
  if (!match) return null;
  const p = path.join(root, "reports", match);
  return containedRealpath(p, root) ? p : null;
}

function containedRealpath(p: string, root: string): boolean {
  try {
    return fs.realpathSync(p).startsWith(fs.realpathSync(root) + path.sep);
  } catch {
    return false;
  }
}

export function isRegularContainedFile(p: string, root: string): boolean {
  try {
    return fs.statSync(p).isFile() && containedRealpath(p, root);
  } catch {
    return false;
  }
}

export function readReport(n: string): ReportData | null {
  const file = findReportFile(n);
  if (!file) return null;
  try {
    return {
      content: fs.readFileSync(file, "utf8"),
      file: path.basename(file),
    };
  } catch {
    return null;
  }
}

export function findApplication(n: string): Application | null {
  return readApplications().find((a) => a.n === n) ?? null;
}

export function profilePath(): string {
  return profileMemoryPath(careerOpsRoot());
}

export function readMemory(): string {
  return readProfileMemory(careerOpsRoot());
}

export function rememberFact(fact: string): "ok" | "deduped" | "error" {
  const f = fact.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!f) return "deduped";
  const p = profilePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let md = "";
    try {
      md = fs.readFileSync(p, "utf8");
    } catch {
      md = "";
    }
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) {
      if (md.slice(i, j).includes(f)) return "deduped";
      atomicWrite(p, md.slice(0, j) + `- ${f}\n` + md.slice(j));
      return "ok";
    }
    if (md.includes(f)) return "deduped";
    const section = `\n\n## Notes from the web assistant\n${NOTES_START}\n- ${f}\n${NOTES_END}\n`;
    const base = md.trim() ? md.replace(/\n*$/, "\n") : "# Profile customization\n";
    atomicWrite(p, base + section);
    return "ok";
  } catch {
    return "error";
  }
}


export type LanguageConfig = {
  output: string;
  modesDir: string;
  modesDirs: string[];
  evalModeFile: string;
};

const MODES_DIR_RE = /^modes(?:\/[A-Za-z0-9_-]+)?$/;

const EVAL_MODE_TITLE_RE = /A[-\u2010-\u2015][FG]/;

const DEFAULT_EVAL_MODE = "modes/oferta.md";

function resolveEvalModeFile(root: string, modesDir: string): string {
  if (modesDir === "modes") return DEFAULT_EVAL_MODE;
  let names: string[];
  try {
    names = fs.readdirSync(path.join(root, modesDir));
  } catch {
    return DEFAULT_EVAL_MODE;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".md") || name.startsWith("_") || name === "README.md") continue;
    try {
      const first = fs.readFileSync(path.join(root, modesDir, name), "utf8").split("\n", 1)[0] ?? "";
      if (EVAL_MODE_TITLE_RE.test(first)) return `${modesDir}/${name}`;
    } catch {
    }
  }
  return DEFAULT_EVAL_MODE;
}

export function readLanguageConfig(): LanguageConfig {
  const root = careerOpsRoot();
  let modesDirs = ["modes"];
  let output = "en";
  try {
    const parsed = yaml.load(fs.readFileSync(path.join(root, "config", "profile.yml"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const language = (parsed as Record<string, unknown>).language;
      if (language && typeof language === "object" && !Array.isArray(language)) {
        const l = language as Record<string, unknown>;
        if (typeof l.output === "string" && l.output.trim()) output = l.output.trim();
        const rawModesDir = l.modes_dir;
        const rawCandidates = Array.isArray(rawModesDir) ? rawModesDir : [rawModesDir];
        const resolveDeclaredDir = (value: unknown): string | null => {
          if (typeof value !== "string" || !value.trim()) return null;
          const candidate = value.trim().replace(/\/+$/, "");
          if (!MODES_DIR_RE.test(candidate)) return null;
          return fs.existsSync(path.join(root, candidate)) ? candidate : null;
        };
        const primary = resolveDeclaredDir(rawCandidates[0]);
        const extras = rawCandidates.slice(1).map(resolveDeclaredDir).filter(
          (value): value is string => value !== null,
        );
        if (primary) {
          modesDirs = [primary, ...extras];
        } else if (extras.length) {
          modesDirs = ["modes", ...extras.filter((dir) => dir !== "modes")];
        }
      }
    }
  } catch {
  }
  const modesDir = modesDirs[0];
  return { output, modesDir, modesDirs, evalModeFile: resolveEvalModeFile(root, modesDir) };
}
