function normalizeForMatch(text = '', { keepLineBreaks = false } = {}) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[‘’ʼ′´`]/g, "'")
    .replace(/[“”″]/g, '"')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, (run) => (keepLineBreaks && run.includes('\n') ? '\n' : ' '));
}

const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /\b(?:job|jobs|position|role|posting|opening|vacancy|requisition|req|listing)\b[\s\S]{0,60}?(?<!\b(?:application|form)\s)has been filled\b(?!\s+out)/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this (?:job|role|position)(?: listing)? is closed\b(?!-)/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /(?<!\bbe\s)closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /(?<!\bbe\s)closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expiree|n'est plus disponible)/i,
  /(cette )?offre n'est plus (disponible|en ligne|active)/i,
  /(offre|poste|annonce) (deja )?pourvu(e)?/i,
  /offre (cloturee|desactivee|terminee)/i,
  /ce poste n'est plus (disponible|a pourvoir|ouvert)/i,
  /recrutement (termine|cloture)/i,
  /candidatures (closes|cloturees)/i,
];

const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

const SOFT_EXPIRED_PATTERNS = [
  /\bjob expired\b/i,
];

export const BOT_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /performing security verification/i,
  /checking your browser before/i,
  /verify you are (a |not a )?human/i,
  /enable javascript and cookies to continue/i,
  /attention required.*cloudflare/i,
  /\bray id\b/i,
  /\bcf-ray\b/i,
  /please complete the security check/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
  /\baplikuj\b/i,
  /panelu aplikowania/i,
  /wyslij (cv|aplikacj)/i,
  /^申请职位$/,
  /^投递$/,
];

const MIN_CONTENT_CHARS = 300;

const JOB_ID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}/gi;

function jobIdToken(url = '') {
  const matches = url.match(JOB_ID_TOKEN);
  return matches ? matches[matches.length - 1].toLowerCase() : null;
}

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

const TIME_OR_CONDITION_CLAUSE =
  /\b(?:until|till|once|when|whenever|after|before|unless|if|whether|as soon as) (?:[^\s.,;:!?…|•·]+ ){0,9}[^\s.,;:!?…|•·]+$/i;

function firstStatedMatch(patterns, lines = '') {
  const text = lines.replace(/\n/g, ' ');
  return patterns.find((pattern) => {
    for (const match of text.matchAll(new RegExp(pattern, `${pattern.flags}g`))) {
      if (!TIME_OR_CONDITION_CLAUSE.test(lines.slice(0, match.index + match[0].length))) return true;
    }
    return false;
  });
}

function hasApplyControl(controls = []) {
  return controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));
}

export function classifyLiveness({ status = 0, requestedUrl = '', finalUrl = '', bodyText: rawBodyText = '', applyControls: rawApplyControls = [] } = {}) {
  const bodyLines = normalizeForMatch(rawBodyText, { keepLineBreaks: true });
  const bodyText = bodyLines.replace(/\n/g, ' ');
  const applyControls = (Array.isArray(rawApplyControls) ? rawApplyControls : []).map((control) => normalizeForMatch(control));

  if (status === 404 || status === 410) {
    return { result: 'expired', code: 'http_gone', reason: `HTTP ${status}` };
  }

  const botChallenge = firstMatch(BOT_CHALLENGE_PATTERNS, bodyText);
  if (botChallenge) {
    return { result: 'uncertain', code: 'bot_challenge', reason: `anti-bot challenge: ${botChallenge.source}` };
  }
  if (status === 403 || status === 429 || status === 503) {
    return { result: 'uncertain', code: 'access_blocked', reason: `HTTP ${status} (access blocked, likely anti-bot)` };
  }
  if (status >= 500) {
    return { result: 'uncertain', code: 'server_error', reason: `HTTP ${status} (transient server error)` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', code: 'expired_url', reason: `redirect to ${finalUrl}` };
  }

  const expiredBody = firstStatedMatch(HARD_EXPIRED_PATTERNS, bodyLines);
  if (expiredBody) {
    return { result: 'expired', code: 'expired_body', reason: `pattern matched: ${expiredBody.source}` };
  }

  const jobId = jobIdToken(requestedUrl);
  if (jobId && finalUrl && !finalUrl.toLowerCase().includes(jobId)) {
    return {
      result: 'uncertain',
      code: 'redirected_off_posting',
      reason: `redirected to ${finalUrl} — job id "${jobId}" missing from final URL`,
    };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', code: 'apply_control_visible', reason: 'visible apply control detected' };
  }

  const softExpired = firstMatch(SOFT_EXPIRED_PATTERNS, bodyText);
  if (softExpired) {
    return { result: 'expired', code: 'expired_body_soft', reason: `pattern matched: ${softExpired.source}` };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return { result: 'expired', code: 'listing_page', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'expired', code: 'insufficient_content', reason: 'insufficient content — likely nav/footer only' };
  }

  return { result: 'uncertain', code: 'no_apply_control', reason: 'content present but no visible apply control found' };
}

const EXPIRED_HISTORY_STATUS = /expired/i;

export function planExpiredHistoryRows(scanHistoryText = '', verdicts = [], normalizeUrl = (url) => url) {
  const knownByKey = new Map();
  const recorded = new Set();

  for (const line of String(scanHistoryText ?? '').split('\n').slice(1)) {
    const [url, , portal = '', title = '', company = '', status = '', location = ''] = line.split('\t');
    if (!url) continue;
    const key = normalizeUrl(url);
    if (!knownByKey.has(key)) knownByKey.set(key, new Map());
    knownByKey.get(key).set(url, { url, source: portal, title, company, location, fingerprint: '' });
    if (EXPIRED_HISTORY_STATUS.test(status)) recorded.add(url);
    else if ((status || 'added') === 'added') recorded.delete(url);
  }

  const rows = [];
  const claimed = new Set();
  for (const verdict of verdicts ?? []) {
    if (verdict?.result !== 'expired' || verdict.code === 'insufficient_content') continue;
    const candidate = typeof verdict.url === 'string' ? verdict.url.trim() : '';
    if (!candidate) continue;
    const known = knownByKey.get(normalizeUrl(candidate));
    if (!known) continue;
    for (const [url, fields] of known) {
      if (recorded.has(url) || claimed.has(url)) continue;
      claimed.add(url);
      rows.push(fields);
    }
  }
  return rows;
}
