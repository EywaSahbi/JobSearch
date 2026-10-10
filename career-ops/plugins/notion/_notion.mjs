import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

const DIR = dirname(fileURLToPath(import.meta.url));
const STATES_PATH = join(DIR, '..', '..', 'templates', 'states.yml');
const MAX = 1900;

let _states;
function loadStates() {
  if (_states) return _states;
  const doc = yaml.load(readFileSync(STATES_PATH, 'utf-8'));
  const labels = [], aliasMap = {};
  for (const s of doc.states) {
    labels.push(s.label);
    aliasMap[s.label.toLowerCase()] = s.label;
    for (const a of (s.aliases || [])) aliasMap[String(a).toLowerCase()] = s.label;
  }
  _states = { labels, aliasMap };
  return _states;
}
export function canonicalStatus(raw) {
  if (!raw) return null;
  const key = String(raw).replace(/\*\*/g, '').trim().toLowerCase();
  return loadStates().aliasMap[key] || null;
}
export function statusLabels() { return loadStates().labels.slice(); }

export function rich(text) {
  const str = String(text ?? '');
  const out = [];
  for (let i = 0; i < str.length || out.length === 0; i += MAX) out.push({ type: 'text', text: { content: str.slice(i, i + MAX) } });
  return out;
}

export function plain(prop) {
  return (prop?.title || prop?.rich_text || []).map((t) => t.plain_text).join('');
}

export function createNotionClient({ token, parent, fetch: fetchFn = globalThis.fetch }) {
  if (!token) throw new Error('NOTION_ACCESS_TOKEN is not set (.env) — the Notion plugin needs it to read/write.');
  const HEADERS = { Authorization: `Bearer ${token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(path, method, body) {
    await sleep(360);
    const r = await fetchFn(`https://api.notion.com/v1/${path}`, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion ${method} ${path} -> ${j.code}: ${j.message}`);
    return j;
  }

  async function createPage(dataSourceId, properties, markdown) {
    const body = { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties };
    if (markdown) body.markdown = markdown;
    return api('pages', 'POST', body);
  }

  async function resolveDBs() {
    if (!parent) throw new Error('Set NOTION_PARENT_PAGE_ID in .env (the "Career Ops" parent page id).');
    const out = {};
    let cursor;
    do {
      const j = await api(`blocks/${parent}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`, 'GET');
      for (const b of j.results) {
        if (b.type !== 'child_database') continue;
        const db = await api(`databases/${b.id}`, 'GET');
        out[b.child_database.title] = db.data_sources?.[0]?.id;
      }
      cursor = j.has_more ? j.next_cursor : null;
    } while (cursor);
    return out;
  }

  async function queryDB(dataSourceId) {
    let cursor, all = [];
    do {
      const j = await api(`data_sources/${dataSourceId}/query`, 'POST', { page_size: 100, start_cursor: cursor });
      all.push(...j.results);
      cursor = j.has_more ? j.next_cursor : null;
    } while (cursor);
    return all;
  }

  function summarize(r) {
    return {
      id: r.id,
      company: plain(r.properties.Company),
      role: plain(r.properties.Role),
      status: r.properties.Status?.select?.name || '',
      score: r.properties.Score?.number ?? null,
      jobUrl: r.properties.URL?.url || '',
      url: r.url,
    };
  }

  async function findRecords(dataSourceId, match) {
    const m = String(match).toLowerCase().trim();
    return (await queryDB(dataSourceId)).map(summarize).filter((r) => {
      const hay = `${r.company} / ${r.role}`.toLowerCase();
      return hay.includes(m) || r.company.toLowerCase() === m;
    });
  }

  return { api, createPage, resolveDBs, queryDB, findRecords };
}
