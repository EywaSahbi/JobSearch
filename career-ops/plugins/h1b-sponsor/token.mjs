#!/usr/bin/env node

import { isMainModule } from '../../lib/is-main-module.mjs';
import { apiBase, fetchWithTimeout, readBoundedText } from './lib/api.mjs';

const USER_AGENT = 'career-ops-plugin-h1b-sponsor/1.0';
const TIMEOUT_MS = 10_000;
const USAGE = 'Usage: node plugins/h1b-sponsor/token.mjs request';
const TOKEN_RE = /^h1b_[0-9a-f]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
function displayClean(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').trim();
}

function humanSpan(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const span = (n, unit) => `about ${n} ${unit}${n === 1 ? '' : 's'}`;
  if (s < 60) return span(Math.max(1, s), 'second');
  if (s < 3600) return span(Math.round(s / 60), 'minute');
  if (s < 86_400) return span(Math.round(s / 3600), 'hour');
  return span(Math.round(s / 86_400), 'day');
}

const MAX_BODY_BYTES = 64 * 1024;

function guardedMintFetch() {
  return fetchWithTimeout(`${apiBase()}/keys/request`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    timeoutMs: TIMEOUT_MS,
    maxRedirects: 0,
  }, async res => {
    const rawRetry = res.headers.get('retry-after');
    const retrySecs = Number(rawRetry);
    const envelope = {
      status: res.status,
      retryAfterSeconds: (rawRetry !== null && Number.isFinite(retrySecs)) ? retrySecs : null,
    };
    let read;
    try {
      read = await readBoundedText(res, MAX_BODY_BYTES);
    } catch {
      envelope.bodyError = 'unreadable';
      return envelope;
    }
    if (read.oversized) {
      envelope.bodyError = 'oversized';
      return envelope;
    }
    try {
      envelope.body = JSON.parse(read.text);
    } catch {
      envelope.bodyError = 'notjson';
    }
    return envelope;
  });
}

export async function mintToken({ fetchImpl = guardedMintFetch } = {}) {
  let env;
  try {
    env = await fetchImpl();
  } catch (err) {
    const reason = (err && err.name === 'AbortError')
      ? `no response within ${TIMEOUT_MS / 1000}s`
      : displayClean((err && err.message) ? err.message : err);
    return { ok: false, exitCode: 1, message: `could not reach the key service (${reason})` };
  }

  if (env.status === 429) {
    const span = (env.retryAfterSeconds !== null) ? humanSpan(env.retryAfterSeconds) : null;
    return {
      ok: false,
      exitCode: 1,
      message: `rate limited: this address has used its recent mint budget (2 available, then one more every 12 hours). Try again in ${span || 'a while'}.`,
    };
  }

  if (env.status !== 201) {
    return { ok: false, exitCode: 1, message: `could not issue a key (HTTP ${env.status})` };
  }

  const spentNote = ' A key may have been issued and the mint budget spent; wait for the cool-off before retrying.';

  if (env.bodyError || !env.body) {
    return { ok: false, exitCode: 1, message: `could not issue a key (the response was not readable JSON).${spentNote}` };
  }

  const body = env.body;
  const token = (typeof body.token === 'string') ? body.token.trim() : '';
  if (!token) {
    return { ok: false, exitCode: 1, message: `could not issue a key (the response carried no token).${spentNote}` };
  }
  if (!TOKEN_RE.test(token)) {
    return { ok: false, exitCode: 1, message: `could not issue a key (the response token was malformed).${spentNote}` };
  }

  const note = (typeof body.note === 'string') ? displayClean(body.note) : '';

  return { ok: true, token, note };
}

function render(result) {
  const lines = [
    result.token,
    '',
    'Set this in your shell before running the plugin (add it to your .env only',
    'if your workflow loads that, for example direnv or node --env-file):',
    `H1B_API_TOKEN=${result.token}`,
  ];
  if (result.note) lines.push('', result.note);
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== 'request') {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  const result = await mintToken();
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = result.exitCode;
    return;
  }
  render(result);
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    const message = displayClean((err && err.message) ? err.message : err);
    process.stderr.write(`could not issue a key (${message})\n`);
    process.exitCode = 1;
  });
}
