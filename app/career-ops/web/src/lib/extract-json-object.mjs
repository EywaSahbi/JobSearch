export function extractJsonObject(text) {
  const s = text
    .replace(/^\s*```(?:json)?[^\S\n]*\n?/i, "")
    .replace(/\n?[^\S\n]*```\s*$/, "");
  const start = s.indexOf("{");
  if (start === -1) return { obj: null, truncated: false };

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end !== -1) {
    try {
      return { obj: JSON.parse(s.slice(start, end + 1)), truncated: false };
    } catch {
    }
  }

  const frag = s.slice(start);
  const structural = new Array(frag.length).fill(false);
  const depths = new Array(frag.length).fill(0);
  {
    let inStr2 = false;
    let esc2 = false;
    let depth2 = 0;
    for (let i = 0; i < frag.length; i++) {
      const c = frag[i];
      structural[i] = !inStr2;
      depths[i] = depth2;
      if (inStr2) {
        if (esc2) esc2 = false;
        else if (c === "\\") esc2 = true;
        else if (c === '"') inStr2 = false;
      } else if (c === '"') inStr2 = true;
      else if (c === "{") depth2++;
      else if (c === "}") depth2--;
    }
  }
  const lastStructuralComma = (before) => {
    for (let i = before - 1; i >= 0; i--) {
      if (frag[i] === "," && structural[i] && depths[i] === 1) return i;
    }
    return -1;
  };

  for (let tryEnd = frag.length; tryEnd > 0; ) {
    const body = frag.slice(0, tryEnd).replace(/,\s*$/, "");
    let open = 0;
    let close = 0;
    for (let i = 0; i < body.length; i++) {
      if (!structural[i]) continue;
      if (body[i] === "{") open++;
      else if (body[i] === "}") close++;
    }
    const pad = "}".repeat(Math.max(0, open - close));
    try {
      return { obj: JSON.parse(body + pad), truncated: true };
    } catch {
      const prevComma = lastStructuralComma(tryEnd);
      if (prevComma < 0) break;
      tryEnd = prevComma;
    }
  }
  return { obj: null, truncated: true };
}
