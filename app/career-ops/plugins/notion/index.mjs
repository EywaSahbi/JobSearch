import { createNotionClient, rich, canonicalStatus } from './_notion.mjs';

function clientFromCtx(ctx) {
  return createNotionClient({
    token: ctx?.env?.NOTION_ACCESS_TOKEN,
    parent: ctx?.env?.NOTION_PARENT_PAGE_ID,
    fetch: ctx?.fetch,
  });
}

async function applicationsDb(client) {
  const dbs = await client.resolveDBs();
  const apps = dbs['Applications'];
  if (!apps) throw new Error('No "Applications" database found under the Career Ops page — create it and share the integration with it.');
  return apps;
}

export function parseScore(s) {
  const m = String(s ?? '').replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : NaN;
}

export default {
  parseScore,

  async export(snapshot, ctx) {
    const rows = Array.isArray(snapshot?.applications) ? snapshot.applications : [];
    if (rows.length === 0) return { pushed: 0 };
    const client = clientFromCtx(ctx);
    const apps = await applicationsDb(client);

    let pushed = 0;
    for (const row of rows) {
      const company = (row.company || '').trim();
      const role = (row.role || '').trim();
      if (!company || !role) continue;

      const props = { Role: { title: rich(role) }, Company: { rich_text: rich(company) } };
      const status = canonicalStatus(row.status);
      if (status) props.Status = { select: { name: status } };
      const score = parseScore(row.score);
      if (Number.isFinite(score)) props.Score = { number: score };

      if (ctx?.dryRun) { ctx.log(`would push: ${company} — ${role}`); pushed++; continue; }

      const dupes = (await client.findRecords(apps, `${company} / ${role}`))
        .filter((h) => h.company.toLowerCase() === company.toLowerCase() && h.role.toLowerCase() === role.toLowerCase());
      if (dupes.length) await client.api(`pages/${dupes[0].id}`, 'PATCH', { properties: props });
      else await client.createPage(apps, props);
      pushed++;
    }
    return { pushed };
  },

  async search(query, ctx) {
    const client = clientFromCtx(ctx);
    const apps = await applicationsDb(client);
    const hits = await client.findRecords(apps, query);
    return hits
      .filter((h) => h.jobUrl && /^https?:\/\//i.test(h.jobUrl))
      .map((h) => ({ title: h.role || 'Notion record', url: h.jobUrl, company: h.company || '', location: '' }));
  },
};
