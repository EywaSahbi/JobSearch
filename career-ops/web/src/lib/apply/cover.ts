import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, findApplication, isRegularContainedFile } from "@/lib/career-ops";
import { companySlug } from "@/lib/company-slug.mjs";
import { hasToken, matchesTailoredCover, sortNewestFirst } from "./cv-match.mjs";

const ROLE_SLUG_MAX = 30;

export async function resolveTailoredCover(company?: string, applicationNumber?: string): Promise<string | null> {
  const n = applicationNumber?.trim();
  const app = n ? findApplication(n) : null;
  if (n && !app) return null;

  const key = companySlug(app?.company ?? company);
  if (!key) return null;
  const dir = path.join(careerOpsRoot(), "output");

  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .filter((f) => matchesTailoredCover(f.toLowerCase(), key.slug))
      .filter((f) => isRegularContainedFile(path.join(dir, f), dir));
  } catch {
    return null;
  }

  if (app) {
    const role = companySlug(app.role)?.slug;
    const wanted = role ? [role, role.slice(0, ROLE_SLUG_MAX)] : [];
    files = files.filter((f) => wanted.some((r) => hasToken(f.toLowerCase(), r)));
  }

  if (!files.length) return null;
  const sorted = sortNewestFirst(dir, files);
  if (!sorted.length) return null;
  return path.join(dir, sorted[0]);
}
