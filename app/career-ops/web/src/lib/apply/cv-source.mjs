import fs from "node:fs";
import path from "node:path";

export function applyCvSource(root, pdfPath) {
  const rel = toRootRelative(root, pdfPath);
  if (!rel) return null;

  const fromManifest = manifestHtml(root, rel);
  if (fromManifest) {
    const kept = keepInsideRoot(root, fromManifest);
    if (kept) return kept;
  }

  if (rel.toLowerCase().endsWith(".pdf")) {
    const sibling = keepInsideRoot(root, rel.slice(0, -4) + ".html");
    if (sibling) return sibling;
  }
  return keepInsideRoot(root, rel);
}

function toRootRelative(root, p) {
  const s = (p ?? "").trim();
  if (!s) return null;
  const abs = path.isAbsolute(s) ? s : path.join(root, s);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function manifestHtml(root, relPdf) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, "data", "pdf-index.tsv"), "utf8");
  } catch {
    return null;
  }
  let html = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields[1] !== relPdf) continue;
    html = (fields[2] || "").trim();
  }
  return html || null;
}

function keepInsideRoot(root, relCandidate) {
  let realAbs;
  let realRoot;
  try {
    realAbs = fs.realpathSync(path.resolve(root, relCandidate));
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  const rel = path.relative(realRoot, realAbs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}
