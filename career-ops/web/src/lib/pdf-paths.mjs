import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function resolvePdfPaths(input, today, root, findReportFile) {
  if (!/^\d+$/.test(input)) {
    return { ok: false, error: `Invalid report selector: "${input}"` };
  }
  const reportFile = findReportFile(input);
  if (!reportFile) {
    return { ok: false, error: `No report #${input} found — evaluate this posting first.` };
  }
  const companyMatch = path.basename(reportFile).match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
  const companySlug = companyMatch ? companyMatch[1] : "company";
  let candidateSlug = "candidate";
  try {
    const profile = yaml.load(fs.readFileSync(path.join(root, "config", "profile.yml"), "utf8"));
    if (profile?.candidate?.full_name) candidateSlug = slugify(profile.candidate.full_name);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn(`resolvePdfPaths: could not read/parse config/profile.yml, defaulting candidate slug: ${err.message}`);
    }
  }
  const scratchDir = path.join(root, ".career-ops-web", "pdf-tmp");
  fs.mkdirSync(scratchDir, { recursive: true });
  return {
    ok: true,
    paths: {
      html: path.join(scratchDir, `cv-web-${input}.html`),
      finalPdf: path.join(root, "output", `cv-${candidateSlug}-${companySlug}-${today}.pdf`),
    },
  };
}
