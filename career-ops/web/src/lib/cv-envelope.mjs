import { PAGE_FORMATS, DEFAULT_PAGE_FORMAT } from "./page-formats.mjs";

export const OPEN_MARK = "<<cv-html";
export const CLOSE_MARK = "<</cv-html>>";

const OPENER_SRC = String.raw`^<<cv-html(?:[ \t]+format="([^"\n]*)")?>>[ \t]*$`;
const CLOSER_SRC = String.raw`^<<\/cv-html>>[ \t]*$`;
const OPENER = new RegExp(OPENER_SRC, "gm");
const CLOSER = new RegExp(CLOSER_SRC, "m");
const CLOSER_ALL = new RegExp(CLOSER_SRC, "gm");

export const CV_ENVELOPE_INSTRUCTION =
  `Do NOT save or edit any file — the platform persists your output for you. Instead OUTPUT the finished HTML inline, between two marker lines. The first line contains only the opening marker carrying your chosen page format — \`${OPEN_MARK} format="a4">>\` or \`${OPEN_MARK} format="letter">>\`, and nothing else on that line. Choose letter for a US/Canada company, otherwise a4. Then the complete HTML document, then a final line containing only \`${CLOSE_MARK}\`. Each marker appears exactly once. Emit the WHOLE document from <!DOCTYPE html> to </html> — never abbreviate, summarize, or write "unchanged"; the platform renders exactly these bytes and nothing else.`;

export function parseCvEnvelope(text) {
  if (typeof text !== "string") {
    return { ok: false, error: "No agent output to read a CV envelope from." };
  }
  const normalized = text.replace(/\r\n/g, "\n");

  const openers = [...normalized.matchAll(OPENER)];
  if (openers.length === 0) {
    return { ok: false, error: "The agent emitted no <<cv-html>> envelope, so there is no CV to render." };
  }
  if (openers.length > 1) {
    return { ok: false, error: `Found ${openers.length} <<cv-html>> envelopes; refusing to guess which is the real CV.` };
  }

  const opener = openers[0];
  const afterOpener = normalized.slice(opener.index + opener[0].length);
  const closer = CLOSER.exec(afterOpener);
  if (!closer) {
    return { ok: false, error: "The <<cv-html>> envelope was never closed — the CV output is incomplete." };
  }

  const html = afterOpener.slice(0, closer.index).replace(/^\n/, "").replace(/\n$/, "");
  if (!html.trim()) {
    return { ok: false, error: "The <<cv-html>> envelope was empty — no CV was tailored." };
  }
  if (!/<\/html\s*>/i.test(html)) {
    return { ok: false, error: "The CV was cut off before its closing </html> tag — the output is incomplete." };
  }

  const warnings = [];
  const declared = opener[1];
  let format = DEFAULT_PAGE_FORMAT;
  if (declared === undefined) {
    warnings.push(`The agent declared no page format; defaulting to ${DEFAULT_PAGE_FORMAT}.`);
  } else {
    const lower = declared.trim().toLowerCase();
    if (PAGE_FORMATS.has(lower)) format = lower;
    else warnings.push(`Unrecognized page format "${declared}"; defaulting to ${DEFAULT_PAGE_FORMAT}.`);
  }

  return { ok: true, html, format, warnings };
}

function couldBecomeMarker(line) {
  return (
    OPEN_MARK.startsWith(line) || CLOSE_MARK.startsWith(line) ||
    line.startsWith(OPEN_MARK) || line.startsWith(CLOSE_MARK)
  );
}

function completeMarker(re, s) {
  for (const m of s.matchAll(re)) {
    const after = m.index + m[0].length;
    if (s[after] === "\n") return { start: m.index, end: after + 1 };
  }
  return null;
}

export function createCvEnvelopeFilter() {
  let raw = "";
  let pending = "";
  let carry = "";
  let inBody = false;

  return {
    push(chunk) {
      const text = String(chunk ?? "");
      raw += text;
      const withCarry = carry + text;
      carry = withCarry.endsWith("\r") ? "\r" : "";
      pending += (carry ? withCarry.slice(0, -1) : withCarry).replace(/\r\n/g, "\n");
      let display = "";
      for (;;) {
        if (!inBody) {
          const opener = completeMarker(OPENER, pending);
          if (opener) {
            display += pending.slice(0, opener.start);
            pending = pending.slice(opener.end);
            inBody = true;
            continue;
          }
          const tailStart = pending.lastIndexOf("\n") + 1;
          const cut = couldBecomeMarker(pending.slice(tailStart)) ? tailStart : pending.length;
          display += pending.slice(0, cut);
          pending = pending.slice(cut);
          return display;
        }
        const closer = completeMarker(CLOSER_ALL, pending);
        if (closer) {
          pending = pending.slice(closer.end);
          inBody = false;
          continue;
        }
        const tailStart = pending.lastIndexOf("\n") + 1;
        pending = pending.slice(tailStart);
        return display;
      }
    },

    flush() {
      const held = inBody ? "" : pending + carry;
      pending = "";
      carry = "";
      return held;
    },

    result() {
      return parseCvEnvelope(raw);
    },
  };
}
