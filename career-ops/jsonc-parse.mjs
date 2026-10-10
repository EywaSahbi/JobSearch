export function stripJsoncSyntax(source) {
  let out = '';
  let inString = false;
  let escaped = false;
  let comment = null;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (comment === 'line') {
      if (char === '\n') {
        comment = null;
        out += char;
      }
      continue;
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = null;
        index++;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      comment = 'line';
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      comment = 'block';
      index++;
      continue;
    }

    if (char === '}' || char === ']') {
      let back = out.length - 1;
      while (back >= 0 && /\s/.test(out[back])) back--;
      if (back >= 0 && out[back] === ',') out = out.slice(0, back) + out.slice(back + 1);
    }

    out += char;
  }

  return out;
}

export function parseJsonc(source) {
  return JSON.parse(stripJsoncSyntax(source));
}

export function parseConfigByExtension(filePath, source) {
  return filePath.toLowerCase().endsWith('.jsonc') ? parseJsonc(source) : JSON.parse(source);
}
