const FEED_BASE = 'https://echojobs.io/api/jobs';

const RETIRED_MESSAGE =
  'echojobs: this feed is gone — echojobs.io/api/jobs is now behind bot protection ' +
  '(HTTP 429, Vercel checkpoint) and the site\'s robots.txt disallows /api (#2976). ' +
  'This provider is retired, not broken-and-fixable: remove `provider: echojobs` from ' +
  'portals.yml. See docs/SUPPORTED_JOB_BOARDS.md.';

const HYBRID_MARKER = /\bhybrid\b/i;

export function normalizeEchojobsJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  let url = '';
  const rawUrl = typeof j.url === 'string' ? j.url.trim() : '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:') url = parsed.href;
    } catch {
    }
  }
  if (!url) return null;

  const company =
    typeof j.company_name === 'string' && j.company_name.trim()
      ? j.company_name.trim()
      : fallbackCompany || 'EchoJobs';

  let location = '';
  if (Array.isArray(j.locations)) {
    location = j.locations
      .filter((l) => typeof l === 'string' && l.trim())
      .map((l) => l.trim())
      .join(', ');
  }
  const remoteType = typeof j.remote_type === 'string' ? j.remote_type.trim().toLowerCase() : '';
  if (remoteType === 'hybrid') {
    if (!HYBRID_MARKER.test(location)) location = [location, 'Hybrid'].filter(Boolean).join(' · ');
  } else if (!location && remoteType === 'remote') {
    location = 'Remote';
  }

  const job = { title, url, company, location };
  if (Number.isFinite(j.posted_at) && j.posted_at > 0) job.postedAt = j.posted_at;
  return job;
}

export default {
  id: 'echojobs',

  detect(entry) {
    return entry?.provider === 'echojobs' ? { url: FEED_BASE } : null;
  },

  async fetch() {
    throw new Error(RETIRED_MESSAGE);
  },
};
