export function splitLines(text) {
  return text.split(/\r?\n/);
}

const LABELED_SEGMENT = /^([a-z][a-z_-]*):\s*(.*)$/i;

export function parseInbox(md) {
  const jobs = [];
  for (const line of splitLines(md)) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    const all = m[2].split("|").map((s) => s.trim());
    const labels = new Map();
    const parts = [];
    for (const [i, seg] of all.entries()) {
      const lm = i >= 3 ? seg.match(LABELED_SEGMENT) : null;
      if (lm) labels.set(lm[1].toLowerCase(), lm[2].trim());
      else parts.push(seg);
    }
    if (parts.length < 3 || !parts[0]) continue;
    const posted = labels.get("posted");
    jobs.push({
      done: m[1].toLowerCase() === "x",
      url: parts[0],
      company: parts[1],
      role: parts[2],
      location: parts[3] || undefined,
      compensation: parts[4] || undefined,
      postedAt: posted && /^\d{4}-\d{2}-\d{2}$/.test(posted) ? posted : undefined,
    });
  }
  return jobs;
}
