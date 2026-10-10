import fs from "node:fs";
import path from "node:path";

const WEB_FIELD = {
  num: "n", date: "date", company: "company", via: "via", role: "role", location: "location",
  score: "score", status: "status", pdf: "pdf", report: "report", notes: "notes",
  applylink: "applyLink", followup: "followUp",
};

export const WEB_FIELD_NAMES = Object.values(WEB_FIELD);

const aliasCache = new Map();

const REQUIRED_FIELDS = ["num", "company", "role", "score", "status"];

export function loadHeaderAliases(rootDir, fallbackRootDir) {
  const roots = [...new Set([rootDir, fallbackRootDir].filter(Boolean))];
  for (const [i, root] of roots.entries()) {
    const file = path.resolve(root, "tracker-aliases.json");
    try {
      const { mtimeMs, size } = fs.statSync(file);
      const cached = aliasCache.get(file);
      let aliases;
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        aliases = cached.aliases;
      } else {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          aliasCache.delete(file);
          continue;
        }
        aliases = parsed;
        aliasCache.set(file, { mtimeMs, size, aliases });
      }
      const mapped = new Set(Object.values(aliases));
      if (i < roots.length - 1 && !REQUIRED_FIELDS.every((f) => mapped.has(f))) continue;
      return aliases;
    } catch {
      aliasCache.delete(file);
    }
  }
  return {};
}

function trackerCells(line) {
  const parts = line.split("|").map((c) => c.trim());
  return parts.slice(1, line.trimEnd().endsWith("|") ? -1 : undefined);
}

export function detectColumnMap(lines, aliases) {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = trackerCells(line);
    const m = {};
    cells.forEach((c, i) => {
      const k = WEB_FIELD[aliases[c.toLowerCase()]];
      if (k) m[k] = i;
    });
    if (["n", "company", "role", "score", "status"].every((k) => m[k] != null)) return m;
  }
  return null;
}

function emptyRow(pick) {
  const row = {};
  for (const field of Object.values(WEB_FIELD)) row[field] = pick(field);
  return row;
}

export function parseApplications(md, rootDir, systemRootDir) {
  const lines = md.split("\n");
  const map = detectColumnMap(lines, loadHeaderAliases(rootDir, systemRootDir));
  const mappedWidth = map ? Math.max(...Object.values(map)) + 1 : 0;
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = trackerCells(line);
    if (cells.length < 8) continue;
    if (map) {
      if (cells.length < mappedWidth) continue;
      const at = (k) => (map[k] == null ? "" : cells[map[k]] ?? "");
      if (!/^\d+$/.test(at("n"))) continue;
      rows.push(emptyRow((k) => at(k)));
    } else {
      if (!/^\d+$/.test(cells[0])) continue;
      const [n, date, company, role, score, status, pdf, report, ...rest] = cells;
      const positional = { n, date, company, role, score, status, pdf, report, notes: rest.join(" | ") };
      rows.push(emptyRow((k) => positional[k] ?? ""));
    }
  }
  return rows;
}
