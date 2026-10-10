const HEADING_PREFIX = /^\s*(?:Block\s+([A-Z])(?:[).:]\s*|\s+(?:[—–-]+\s*)?)|([A-Z])[).:]\s*)/i;

const HEADING_LETTER = /^(?:Block\s+([A-Z])(?:[).:]|\s)|([A-Z])[).:])/i;

export function cleanHeading(h) {
  const stripped = h
    .replace(HEADING_PREFIX, "")
    .replace(/\s*\((?:lead|verdict)\)\s*$/i, "")
    .trim();
  return stripped || h.trim();
}

export function authorLetter(heading) {
  const match = heading.match(HEADING_LETTER);
  return (match?.[1] ?? match?.[2])?.toUpperCase() ?? null;
}

export function isVerdictHeading(heading) {
  if (/\((?:lead|verdict)\)\s*$/i.test(heading.trim())) return true;
  return /^verdict$/i.test(cleanHeading(heading));
}

export const APPLY_LINE = 4.0;

export function applyLineLabel(score) {
  if (score == null || score === "") return null;
  const n = typeof score === "number" ? score : Number(String(score).match(/(\d+(?:\.\d+)?)/)?.[1]);
  if (!Number.isFinite(n)) return null;
  return n >= APPLY_LINE ? "Recommended" : "Below the apply line";
}

export function applyCtaQuiet(opts) {
  if (applyLineLabel(opts?.score) === "Below the apply line") return true;
  const s = String(opts?.legitimacy ?? "").toLowerCase();
  if (s.includes("caution") || s.includes("precau") || s.includes("caut")) return true;
  if (s.includes("suspic") || s.includes("sospech") || s.includes("scam") || s.includes("fake")) return true;
  return false;
}

export function isLeadSection(section) {
  if (section?.letter === "B") return true;
  return /\b(cv match|match with cv)\b/i.test(cleanHeading(section?.heading ?? ""));
}

export function firstProseParagraph(md) {
  const withoutTables = String(md ?? "")
    .split("\n")
    .map((l) => (/^\s*\|/.test(l) ? "" : l))
    .join("\n");
  return (
    withoutTables
      .split(/\n{2,}/)
      .map((p) => p.replace(/^#+\s+/, "").trim())
      .find((p) => p && !/^[-*]{3,}$/.test(p) && !/^\*\*[^*]+:\*\*/.test(p)) ?? ""
  );
}

export function verdictReason(opts) {
  const fromVerdict = firstProseParagraph(opts?.verdictContent ?? "");
  if (fromVerdict) return fromVerdict;
  const fromIntro = firstProseParagraph(opts?.intro ?? "");
  if (fromIntro) return fromIntro;
  const header = String(opts?.report ?? "").split(/^---\s*$/m)[0] ?? "";
  const stripped = header
    .replace(/^#\s+.*$/m, "")
    .replace(/^\s*\*\*[^*]+:\*\*.*$/gm, "")
    .trim();
  return firstProseParagraph(stripped);
}

export function splitSections(body) {
  const intro = [];
  const sections = [];
  let cur = null;
  for (const line of body.split("\n")) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      if (cur) sections.push({ heading: cur.heading, letter: cur.letter, content: cur.lines.join("\n").trim() });
      const heading = h[1].trim();
      cur = { heading, letter: authorLetter(heading), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      intro.push(line);
    }
  }
  if (cur) sections.push({ heading: cur.heading, letter: cur.letter, content: cur.lines.join("\n").trim() });
  return { intro: intro.join("\n").trim(), sections };
}
