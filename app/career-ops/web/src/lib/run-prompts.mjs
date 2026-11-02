import { CV_ENVELOPE_INSTRUCTION } from "./cv-envelope.mjs";

export function isShellSafeCompanyName(name) {
  return typeof name === "string"
    && name.length > 0
    && name.length <= 80
    && SAFE_COMPANY_NAME.test(name)
    && !name.includes("&&");
}

const SAFE_COMPANY_NAME = /^[\p{L}\p{N} .,&'()+/-]+$/u;

const ISO_DATE_RE = /^20\d{2}-\d{2}-\d{2}$/;

export const BASE_CV_TEMPLATE = "templates/cv-template.html";

const CV_TEMPLATE_RE =
  /^templates\/(?:[A-Za-z0-9][A-Za-z0-9._ +-]*\/)?cv-template(?:\.[a-z0-9-]+)?\.html(?![\s\S])/;

function safeCvTemplate(value) {
  return typeof value === "string" && !value.includes("..") && CV_TEMPLATE_RE.test(value)
    ? value
    : BASE_CV_TEMPLATE;
}

export function buildPrompt({ kind, input, memory, today, postedAt, lang, cvTemplate }) {
  const resolvedLang = lang ?? { output: "en", modesDir: "modes", modesDirs: ["modes"], evalModeFile: "modes/oferta.md" };
  const allDeclaredMarkets = resolvedLang.modesDirs ?? [resolvedLang.modesDir];
  const declaredMarkets = allDeclaredMarkets.filter(Boolean);
  const isMultiMarket = declaredMarkets.length > 1;
  const sharedMarketDirs = declaredMarkets.filter((dir) => dir !== "modes");
  const sharedMarketNote = sharedMarketDirs.length
    ? ` Also read ${sharedMarketDirs.map((dir) => `${dir}/_shared.md`).join(" and ")} for ${
        isMultiMarket ? "these markets'" : "this market's"
      } vocabulary, benefits and legal concepts, and keep those terms (explained in the output language) where relevant.`
    : "";
  const marketSelectionNote = kind === "evaluate" && isMultiMarket
    ? ` These are multiple DECLARED candidate markets — per posting, judge which one actually applies from the JD's own MARKET signals (hiring-entity jurisdiction, currency, benefits/legal vocabulary), reusing the same judgment Block G posting-legitimacy checks already use. Never infer the market from the JD's language alone (a French-language Quebec/federal-Canada posting needs Canada's concepts, not modes/fr's France/Belgium/Switzerland/Luxembourg ones).`
    : "";
  const unattendedAmbiguityStep = kind === "evaluate" && isMultiMarket
    ? ` If those signals remain genuinely ambiguous, this is an unattended run and nobody can answer a question: do not stop or ask the candidate. Continue with the first/primary market (${resolvedLang.modesDir}) and state both the ambiguity and that primary-market fallback explicitly in the report header or Block G before persisting.\n\n`
    : "";
  const marketNote = sharedMarketNote + marketSelectionNote;
  const languageDirective = `\n\nWrite all human-facing output in "${resolvedLang.output}" regardless of the language of these instructions or the job description.${marketNote}\n`;
  const mem = (memory.trim() ? `\n\nDurable notes about the user (from their profile):\n${memory.trim()}\n` : "") + languageDirective;
  if (kind === "research") {
    return `You are investigating the user's OWN work / portfolio to surface job-search-relevant strengths, headless. Investigate the target (use WebFetch for URLs; read local files if referenced) and report: what it is, why it is impressive, and how to leverage it in their job search — which roles/claims it supports and how to frame it on a CV. Be specific, honest, and encouraging. Report only: never submit, send, or click Apply anywhere, and contact no one — you are investigating the user's own work, not acting on it.${mem}

End with EXACTLY one final line: VERDICT: {0-5 signal strength}/5 — {why it helps their search, ≤12 words}

Target: ${input}`;
  }
  if (kind === "pdf") {
    return `You are tailoring the user's ATS-optimized CV for application #${input}, headless, on their machine. Run the REAL career-ops "pdf" mode's CONTENT step: follow modes/pdf.md's TAILORING rules exactly (do not improvise your own scoring or format). Apply its CONTENT rules — keyword injection, ordering, the competency grid, project selection, and its never-invent-a-skill rule. Its steps that shell out (the jd-skill-gap.mjs check) and its build/save/render steps are NOT performed on web runs; the platform handles output itself.
1. Read modes/pdf.md, cv.md, config/profile.yml, and the evaluation report at reports/${input}-*.md (for the JD keywords + analysis).
2. Tailor the CV per modes/pdf.md: inject the JD's keywords into the summary + first bullets, reorder experience by relevance, build the competency grid, pick the top 3–4 projects. NEVER invent skills — only reword REAL experience using the JD's vocabulary.
3. Fill ${safeCvTemplate(cvTemplate)}'s {{...}} placeholders with the tailored content. Use that exact file: the platform already resolved it from cv.template through cv-templates.mjs, so do NOT run modes/pdf.md's own template-resolution step. ${CV_ENVELOPE_INSTRUCTION}
4. Emit the envelope EXACTLY ONCE. The platform writes the HTML, renders the PDF, and updates the tracker's PDF column itself, only after a confirmed successful render. Do not submit anything anywhere.

After the envelope, end with EXACTLY one final line: VERDICT: {5 if the complete HTML envelope was emitted, else 1}/5 — {a one-line summary, ≤12 words}`;
  }
  if (kind === "fix-portal") {
    return `A company's job-portal ATS slug is BROKEN — career-ops can no longer scan it, so it silently disappears from every future scan. Repair it (headless, on the user's machine):
1. Run \`node verify-portals.mjs --add "${input}"\` — it probes Greenhouse/Ashby/Lever for the company's correct ATS slug and prints the suggested ats + slug.
2. Open portals.yml, find the "${input}" entry under tracked_companies, and update its careers_url (and any api/slug field) to the suggested WORKING ATS URL. Change ONLY this one company; preserve all other YAML structure, comments and formatting exactly.
3. Re-run \`node verify-portals.mjs\` and confirm "${input}" now shows ✅ live (not ❌).
If NO slug variant resolves, say so clearly and leave portals.yml unchanged. Never touch any other company. This is a config repair: do not submit, send, or click Apply anywhere, and edit no file other than portals.yml.

End with EXACTLY one final line: VERDICT: {5 if now live, else 1}/5 — {what you changed, ≤12 words}`;
  }
  const postedSegment = ISO_DATE_RE.test(String(postedAt ?? "")) ? `; posted: ${postedAt}` : "";

  return `You are running the OFFICIAL career-ops job evaluation, HEADLESS, on the user's own machine. Today is ${today}. Run the REAL career-ops evaluation — do NOT improvise your own scoring.

1. Read ${resolvedLang.evalModeFile} and follow it EXACTLY — EVERY section its report template specifies, in its order, including the Machine Summary. Do not treat any list of sections in THIS prompt as the set to produce; that file is the only source of truth for which sections exist. Ground the fit in THIS person: read cv.md, config/profile.yml and modes/_profile.md.

   Use WebFetch to read the posting (you are headless — Playwright is unavailable), and mark the report header "Verification: unconfirmed (batch mode)".

   **If WebFetch does not return the posting itself — a login/consent wall, a partial page shell with no job description, a 404 or expired ad, a paywall, a bot challenge, or a page whose text is not this job — this is the mode file's "posting appears closed" case: STOP BEFORE BLOCK A and do not generate an evaluation, a report or a CV.** That rule is the mode's, not this prompt's; modes/pipeline.md states the same thing for extraction — never treat a login wall or partial shell as a verified JD. Instead, say which URL you fetched and what came back, so the user can paste the job text themselves. A scored report about a login screen looks exactly like a scored report about the job, and a run that reports it could not read the posting is a correct outcome.

${mem}${unattendedAmbiguityStep}2. Persist the result CANONICALLY so the web and the CLI share ONE source of truth:
   a. Reserve a report number: run \`node reserve-report-num.mjs\` — its stdout is a 3-digit number (e.g. 035).
   b. Write the full report to reports/{num}-{company-slug}-${today}.md  (company-slug = company lowercased, non-alphanumerics → hyphens).
   c. Write batch/tracker-additions/{num}-{company-slug}.tsv as TWO lines (real \\t tabs): a HEADER row of the 10 column labels, then ONE data row of 10 TAB-separated columns under it. merge-tracker reads the header and resolves every field by NAME, so no value can land in the wrong column. Copy both lines exactly as shown. ALWAYS write all 10 fields on the data row — leave the last one EMPTY if there is no posting URL, never "N/A" or "-":
      num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl
      {num}\t${today}\t{Company}\t{Role}\t{CanonicalStatus e.g. Evaluated}\t{score}/5\t❌\t[{num}](reports/{num}-{company-slug}-${today}.md)\t{one-line note}${postedSegment}\t{posting URL, or empty}
   d. Merge into the tracker: run \`node merge-tracker.mjs\` (it dedupes by company+role+report-num, validates the status, and writes data/applications.md — NEVER edit applications.md by hand).

3. NEVER submit an application, fill no forms, contact no one. This is evaluation + persistence ONLY.

After everything above is written and merged, output EXACTLY one final line, nothing after it:
VERDICT: {score}/5 — {reason in 12 words or fewer}

Posting URL: ${input}`;
}
