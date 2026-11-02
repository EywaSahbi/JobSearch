export function pipeCells(line) {
  const t = String(line ?? "").trim();
  if (!t.startsWith("|")) return [];
  const parts = [];
  let buf = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\") {
      let n = 0;
      while (i < t.length && t[i] === "\\") {
        n += 1;
        i += 1;
      }
      if (t[i] === "|") {
        buf += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) {
          buf += "|";
          continue;
        }
        i -= 1;
        continue;
      }
      buf += "\\".repeat(n);
      i -= 1;
      continue;
    }
    if (t[i] === "|") {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += t[i];
  }
  parts.push(buf);
  if (parts[0] === "") parts.shift();
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.map((c) => c.trim());
}

export function isStarTableHeader(header) {
  const n = (header || []).map((h) => String(h).trim().toLowerCase());
  if (n.length < 6) return false;
  const hasS = n.includes("s");
  const hasT = n.includes("t");
  const hasA = n.includes("a");
  const hasR = n.includes("r");
  const hasStar = n.some((h) => /star/.test(h));
  return hasStar && hasS && hasT && hasA && hasR;
}

export function fitTone(text) {
  const raw = String(text ?? "").replace(/\*+/g, "").trim();
  if (!raw || raw.length > 48) return null;
  const t = raw.toLowerCase();
  if (/^gap\b/.test(t) || /^missing\b/.test(t) || /^fail/.test(t)) return "bad";
  if (/^strong\b/.test(t) || /^exceeds\b/.test(t) || /^excellent\b/.test(t)) return "good";
  if (/^adjacent\b/.test(t) || /^partial\b/.test(t) || /^adequate\b/.test(t) || /^ok\b/.test(t)) return "warn";
  return null;
}

export function splitPipeTables(md) {
  const lines = String(md ?? "").split("\n");
  const out = [];
  let buf = [];
  let table = [];
  const flushMd = () => {
    const text = buf.join("\n");
    if (text.trim()) out.push({ type: "md", text });
    buf = [];
  };
  const flushTable = () => {
    if (table.length) out.push({ type: "table", text: table.join("\n") });
    table = [];
  };
  const isTableLine = (l) => /^\s*\|/.test(l);
  for (const line of lines) {
    if (isTableLine(line)) {
      if (buf.length) flushMd();
      table.push(line);
    } else {
      if (table.length) flushTable();
      buf.push(line);
    }
  }
  if (table.length) flushTable();
  flushMd();
  return out;
}

export function parsePipeTable(block) {
  const lines = String(block ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));
  if (lines.length < 2) return null;
  const header = pipeCells(lines[0]);
  if (!header.length) return null;
  const start = /^\s*\|?\s*:?-{3,}/.test(lines[1]) ? 2 : 1;
  const rows = lines.slice(start).map(pipeCells).filter((r) => r.some((c) => c.length));
  return { header, rows };
}

export function colIndex(header, names) {
  const n = header.map((h) => String(h).trim().toLowerCase());
  for (const name of names) {
    const want = name.toLowerCase();
    const i = n.findIndex((h) => (want.length <= 2 ? h === want : h === want || h.includes(want)));
    if (i >= 0) return i;
  }
  return -1;
}

export function fitColumnIndex(header) {
  return (header || []).findIndex((h) => String(h).trim().toLowerCase() === "fit");
}
