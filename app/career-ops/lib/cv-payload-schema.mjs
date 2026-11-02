export const ENTRY_FIELD_SPECS = {
  html: {
    experience: {
      required: ['company', 'role'],
      known: ['company', 'role', 'location', 'context', 'dates', 'period', 'bullets'],
    },
    projects: {
      required: ['name'],
      known: ['name', 'badge', 'description', 'bullets', 'tech', 'url'],
    },
    education: {
      required: ['title'],
      known: ['title', 'org', 'location', 'year', 'description'],
    },
    certifications: { required: ['title'], known: ['title', 'org', 'year'] },
    awards: { required: ['title'], known: ['title', 'org', 'year'] },
    skills: { required: ['items'], known: ['category', 'items'], rules: { items: hasRenderableItems } },
  },
  tex: {
    experience: {
      required: ['company', 'role'],
      known: ['company', 'role', 'location', 'dates', 'bullets'],
    },
    projects: {
      required: ['name'],
      known: ['name', 'context', 'dates', 'bullets', 'url'],
    },
    education: {
      required: ['institution', 'degree'],
      known: ['institution', 'degree', 'location', 'dates', 'coursework'],
    },
    awards: { required: ['title'], known: ['title', 'org', 'year'] },
    skills: { required: ['items'], known: ['category', 'items'], rules: { items: hasRenderableItems } },
  },
};

export const KNOWN_ROOT_KEYS = {
  html: [
    'lang', 'page_format', 'candidate', 'sections', 'summary', 'competencies',
    'experience', 'projects', 'education', 'certifications', 'awards',
    'interests', 'skills', 'consent',
  ],
  tex: [
    'name', 'contact_line', 'email', 'linkedin', 'github',
    'education', 'experience', 'projects', 'awards', 'skills',
  ],
};

export const UNRENDERED_SECTIONS = {
  html: [],
  tex: ['certifications', 'competencies', 'interests', 'summary'],
};

export function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function hasRenderableItems(value) {
  if (Array.isArray(value)) return value.length > 0 && value.every(item => hasText(item));
  return hasText(value);
}

function populatedContent(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? `${value.length} entr${value.length > 1 ? 'ies' : 'y'}` : '';
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).length > 0 ? 'its content' : '';
  }
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? (value.trim() !== '' ? 'its content' : '') : 'its content';
}

function fieldPresent(entry, field, spec) {
  const rule = (spec.rules && spec.rules[field]) || hasText;
  return rule(entry[field]);
}

export function hasRequiredFields(entry, section, format) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const spec = (ENTRY_FIELD_SPECS[format] || {})[section];
  if (!spec) return true;
  return spec.required.every(field => fieldPresent(entry, field, spec));
}

export function validatePayload(payload, format) {
  const errors = [];
  const warnings = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('expected the CV payload to be an object, got '
      + (Array.isArray(payload) ? 'an array' : payload === null ? 'null' : typeof payload));
    return { errors, warnings };
  }
  const specs = ENTRY_FIELD_SPECS[format];
  if (!specs) {
    errors.push(`unknown payload format: ${format}`);
    return { errors, warnings };
  }
  const plural = (list) => (list.length > 1 ? 's' : '');

  for (const [section, spec] of Object.entries(specs)) {
    const entries = payload ? payload[section] : undefined;
    if (entries === undefined || entries === null) continue;
    if (!Array.isArray(entries)) {
      errors.push(`${section}: expected an array, got ${typeof entries}`);
      continue;
    }
    entries.forEach((entry, i) => {
      const where = `${section}[${i}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${where}: expected an object with keys ${spec.known.join(', ')}`);
        return;
      }
      const missing = spec.required.filter(field => !fieldPresent(entry, field, spec));
      const unknown = Object.keys(entry).filter(key => !spec.known.includes(key));
      if (missing.length) {
        errors.push(
          `${where}: missing required field${plural(missing)} ${missing.join(', ')}`
          + (unknown.length
            ? ` — unrecognised key${plural(unknown)} present: ${unknown.join(', ')}`
            : '')
          + ` (known keys: ${spec.known.join(', ')})`
        );
      } else if (unknown.length) {
        warnings.push(
          `${where}: unrecognised key${plural(unknown)} ${unknown.join(', ')} `
          + `will be ignored (known keys: ${spec.known.join(', ')})`
        );
      }
    });
  }

  const knownRoots = KNOWN_ROOT_KEYS[format] || [];
  const declaredUnrendered = new Set(UNRENDERED_SECTIONS[format] || []);
  for (const key of Object.keys(payload)) {
    if (knownRoots.includes(key) || declaredUnrendered.has(key)) continue;
    const what = populatedContent(payload[key]);
    if (!what) continue;
    const near = knownRoots.filter(k => k.startsWith(key.slice(0, 4)) || key.startsWith(k.slice(0, 4)));
    warnings.push(
      `${key}: not a section the ${format} builder reads, so ${what} will not `
      + `appear in the output`
      + (near.length ? ` — did you mean ${near.join(' or ')}?` : '')
      + ` (known keys: ${knownRoots.join(', ')})`
    );
  }

  for (const section of UNRENDERED_SECTIONS[format] || []) {
    const what = populatedContent(payload[section]);
    if (what) {
      warnings.push(
        `${section}: the ${format} template has no ${section} section — `
        + `${what} will not appear in the output`
      );
    }
  }

  return { errors, warnings };
}
