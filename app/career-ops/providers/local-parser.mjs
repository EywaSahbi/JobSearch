import { execFile } from 'child_process';
import { realpathSync } from 'fs';
import { resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const LOCAL_PARSER_TIMEOUT_MS = 20_000;
const LOCAL_PARSER_MAX_BUFFER_BYTES = 2_000_000;

const PROJECT_ROOT = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));
const ALLOWED_INTERPRETERS = new Set(['python3', 'python', 'node', 'deno', 'bun', 'sh', 'bash']);

function safeCareersUrl(value) {
  if (!value) return '';
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`local-parser: careers_url is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`local-parser: careers_url must be http(s): ${value}`);
  }
  return url.href;
}

function safeCompany(value) {
  if (!value) return '';
  const name = String(value).trim();
  if (name.startsWith('-')) {
    throw new Error(`local-parser: company name cannot start with '-': ${value}`);
  }
  return name;
}

function expandParserArg(value, entry) {
  let out = String(value);
  if (out.includes('{careers_url}')) out = out.replaceAll('{careers_url}', safeCareersUrl(entry.careers_url));
  if (out.includes('{company}')) out = out.replaceAll('{company}', safeCompany(entry.name));
  return out;
}

function getParserScriptPath(entry) {
  const parser = entry.parser || {};
  if (parser.script) return expandParserArg(parser.script, entry);

  const args = Array.isArray(parser.args) ? parser.args : [];
  const scriptArg = args.find(arg => {
    const value = String(arg);
    return !value.startsWith('-') && /\.(py|mjs|js|sh)$/.test(value);
  });

  return scriptArg ? expandParserArg(scriptArg, entry) : null;
}

function buildParserArgs(entry) {
  const parser = entry.parser || {};
  const args = [];

  if (parser.script) args.push(parser.script);
  if (Array.isArray(parser.args)) args.push(...parser.args);

  return args.map(arg => expandParserArg(arg, entry));
}

function resolveInsideRoot(rawPath) {
  const resolved = realpathSync(resolve(PROJECT_ROOT, String(rawPath)));
  if (resolved !== PROJECT_ROOT && !resolved.startsWith(PROJECT_ROOT + sep)) {
    throw new Error(`local-parser: path escapes the project root: ${rawPath}`);
  }
  return resolved;
}

function resolveCommand(command) {
  const value = String(command || '');
  if (!value) throw new Error('local-parser: parser.command is required');
  if (!value.includes('/') && ALLOWED_INTERPRETERS.has(value)) return value;
  return resolveInsideRoot(value);
}

function resolveInvocation(entry) {
  const rawCommand = String(entry.parser?.command || '');
  const command = resolveCommand(rawCommand);
  const args = buildParserArgs(entry);
  const scriptPath = getParserScriptPath(entry);

  const usesInterpreter = !rawCommand.includes('/') && ALLOWED_INTERPRETERS.has(rawCommand);
  if (usesInterpreter) {
    if (!scriptPath) throw new Error('local-parser: interpreter command requires an in-repo parser script');
    resolveInsideRoot(scriptPath);
    if (args[0] !== scriptPath) {
      throw new Error('local-parser: the parser script must be the interpreter\'s first argument');
    }
  } else if (scriptPath) {
    resolveInsideRoot(scriptPath);
  }

  return { command, args };
}

function normalizeJobUrl(rawUrl, baseUrl) {
  if (!rawUrl) return '';
  try {
    return new URL(String(rawUrl).trim(), baseUrl || undefined).href;
  } catch {
    return '';
  }
}

function normalizeLocation(value) {
  if (!value) return '';
  if (Array.isArray(value)) return value.map(normalizeLocation).filter(Boolean).join(', ');
  if (typeof value === 'object') return value.name || value.text || '';
  return String(value).trim();
}

const MAX_VALID_EPOCH_MS = 8_640_000_000_000_000;

function toEpochMs(value) {
  let ms;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    ms = value;
  } else if (typeof value === 'string' && value) {
    ms = Date.parse(value);
    if (Number.isNaN(ms)) return undefined;
  } else {
    return undefined;
  }
  return ms > 0 && ms <= MAX_VALID_EPOCH_MS ? ms : undefined;
}

function firstPostedAt(...candidates) {
  for (const candidate of candidates) {
    const parsed = toEpochMs(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function normalizeParserJob(job, entry) {
  if (!job || typeof job !== 'object') return null;

  const title = String(job.title || job.name || '').trim();
  const url = normalizeJobUrl(
    job.url || job.jobUrl || job.job_url || job.applyUrl || job.apply_url,
    entry.careers_url,
  );
  if (!title || !url) return null;

  const {
    title: _title, name: _name,
    url: _url, jobUrl: _jobUrl, job_url: _jobUrlSnake,
    applyUrl: _applyUrl, apply_url: _applyUrlSnake,
    company: _company, location: _location, locations: _locations,
    postedAt: _postedAt, posted_at: _postedAtSnake,
    publishedAt: _publishedAt, published_at: _publishedAtSnake,
    published_date: _publishedDate, datePosted: _datePosted, date_posted: _datePostedSnake,
    ...rest
  } = job;

  const out = {
    ...rest,
    title,
    url,
    company: String(job.company || entry.name || '').trim(),
    location: normalizeLocation(job.location || job.locations),
  };

  const postedAt = firstPostedAt(
    job.postedAt, job.posted_at, job.publishedAt, job.published_at,
    job.published_date, job.datePosted, job.date_posted,
  );
  if (postedAt !== undefined) out.postedAt = postedAt;

  return out;
}

async function runLocalParser(entry) {
  const parser = entry.parser || {};
  const { command, args } = resolveInvocation(entry);
  const timeout = Number(parser.timeout_ms || LOCAL_PARSER_TIMEOUT_MS);
  const maxBuffer = Number(parser.max_buffer_bytes || LOCAL_PARSER_MAX_BUFFER_BYTES);

  const { stdout } = await execFileAsync(command, args, {
    cwd: PROJECT_ROOT,
    timeout,
    maxBuffer,
    windowsHide: true,
  });

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error('local parser returned invalid JSON');
  }

  const rawJobs = Array.isArray(payload) ? payload : payload.jobs || payload.results;
  if (!Array.isArray(rawJobs)) {
    throw new Error('local parser JSON must be an array or contain jobs[]/results[]');
  }

  return rawJobs
    .map(job => normalizeParserJob(job, entry))
    .filter(Boolean);
}

export default {
  id: 'local-parser',

  detect(entry) {
    if (!entry.parser?.command) return null;

    try {
      resolveInvocation(entry);
    } catch {
      return null;
    }

    return { url: entry.careers_url || 'local-parser' };
  },

  async fetch(entry) {
    return runLocalParser(entry);
  },
};
