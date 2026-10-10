import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, pdfPathStatusForReport, readApplications } from "@/lib/career-ops";
import { companySlug } from "@/lib/company-slug.mjs";
import { matchesTailoredCv, sortNewestFirst } from "./cv-match.mjs";
import { reportNumberFromCell } from "./cv-selection.mjs";

export async function resolveTailoredCv(company?: string, applicationNumber?: string): Promise<string | null> {
  const root = careerOpsRoot();
  if (applicationNumber?.trim()) {
    const app = readApplications().find((candidate) => candidate.n === applicationNumber.trim());
    const reportNumber = reportNumberFromCell(app?.report);
    if (!reportNumber) return null;
    const result = await pdfPathStatusForReport(String(reportNumber));
    return result.status === "found" ? result.path : null;
  }

  const c = (company ?? "").trim();
  if (!c) return null;
  const dir = path.join(root, "output");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  } catch {
    return null;
  }
  const key = companySlug(c);
  if (!key) return null;
  const { slug } = key;
  const matches = files.filter((f) => matchesTailoredCv(f.toLowerCase(), slug));
  if (!matches.length) return null;
  const sorted = sortNewestFirst(dir, matches);
  if (!sorted.length) return null;
  return path.join(dir, sorted[0]);
}

export async function resolveSessionCv(opts: { company?: string; application?: string; title?: string }): Promise<string | null> {
  const direct = await resolveTailoredCv(opts.company, opts.application);
  if (direct) return direct;
  if (opts.application) return null;
  return resolveTailoredCv(companyFromTitle(opts.title));
}

export function companyFromTitle(title?: string): string {
  const t = (title ?? "").trim();
  if (!t) return "";
  const at = t.match(/@\s*([^|@]+?)\s*$/);
  if (at) return at[1].trim();
  const atWord = t.match(/\bat\s+([A-Z][\w&.\- ]+?)\s*$/);
  if (atWord) return atWord[1].trim();
  return "";
}
