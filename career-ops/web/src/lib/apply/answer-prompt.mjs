export function buildAnswerPrompt({ title, fields, memory = "", cvSource = null }) {
  const fieldsList = fields
    .map((f) => `${f.id}\t${f.type}${f.required ? "*" : ""}\t${f.label}${f.options ? `\t[options: ${f.options.join(" | ")}]` : ""}`)
    .join("\n");
  const sources = cvSource
    ? `SOURCES. The document being attached to this form is the tailored CV at ${cvSource} — read it, and read config/profile.yml. If a matching report for this company exists in reports/, read it too.
- config/profile.yml owns name, email, phone, address, links, work authorization, visa status and comp expectations. It is authoritative; no CV overrides it.
- The tailored CV owns employer names, job titles, dates, locations, role descriptions, achievements, education, certifications, skills and the summary. The reviewer is holding it, so every experience answer must describe the roles as it states them.
- cv.md is the fallback only: read it for a whole section the tailored CV omits, never to top up a role the tailored CV already covers. Where the two disagree, the tailored CV wins.`
    : `SOURCES. No tailored CV was found for this application. Read cv.md and config/profile.yml; if a matching report for this company exists in reports/, read it too. config/profile.yml owns name, email, phone, address, links, work authorization, visa status and comp expectations, and is authoritative over cv.md.`;

  return `You are pre-filling a job application for the user (company/role: ${title}).

${sources}

Ground EVERY answer in the REAL candidate — never invent facts.${memory ? `\n\nDurable notes about the user:\n${memory}` : ""}

FIELDS (id ⇥ type ⇥ label ⇥ options):
${fieldsList}

For each field give the best answer:
- identity/contact (name, email, phone, github, linkedin, location) → from config/profile.yml.
- experience (employer, job title, dates, location, role description) → from the source that owns it above, verbatim in substance.
- free-text (Why us?, cover-letter, "most impactful thing you've built", etc.) → a concise, honest, concrete answer in the candidate's own voice (no buzzwords, active voice, real metrics only). Keep each under ~120 words.
- select/radio → choose the best-matching option using the EXACT option text from the list.
- NEVER fill legal / visa / work-authorization / salary / demographic / sensitive fields → set needs_confirmation:true and value:"".

Output ONLY a compact JSON object mapping each field id → {"value": "...", "needs_confirmation": boolean}. No prose, no markdown, no code fence.`;
}
