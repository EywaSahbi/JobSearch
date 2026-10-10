export function normalizeHost(hostHeader) {
  if (!hostHeader) return "";
  const host = String(hostHeader).trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host.slice(1) : host.slice(1, end);
  }
  const colon = host.indexOf(":");
  if (colon === -1 || host.indexOf(":", colon + 1) !== -1) return host;
  return host.slice(0, colon);
}

export function isLoopbackHost(host) {
  const h = normalizeHost(host);
  if (h === "localhost" || h === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function normalizeOrigin(origin) {
  if (!origin) return "";
  const plain = String(origin).trim().replace(/\/+$/, "").toLowerCase();
  if (!plain) return "";
  let url;
  try {
    url = new URL(plain);
  } catch {
    return plain;
  }
  return url.host ? `${url.protocol}//${url.host}` : plain;
}

export function parseAllowedOrigins(envValue) {
  const out = new Set();
  if (!envValue) return out;
  for (const token of String(envValue).split(/[\s,]+/)) {
    const o = normalizeOrigin(token);
    if (o) out.add(o);
  }
  return out;
}

export function parseAllowedHosts(envValue) {
  const out = new Set();
  if (!envValue) return out;
  for (const token of String(envValue).split(/[\s,]+/)) {
    const h = normalizeHost(token);
    if (h) out.add(h);
  }
  return out;
}

function block(reason) {
  return { ok: false, status: 403, reason };
}

export function checkRequest({ secFetchSite, origin, host, allowedHosts, allowedOrigins }) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return block("missing Host header");
  const hostAllowed = isLoopbackHost(normalizedHost) || (allowedHosts && allowedHosts.has(normalizedHost));
  if (!hostAllowed) {
    return block(
      "this host is not allowed; the dashboard serves loopback only unless CAREER_OPS_WEB_ALLOWED_HOSTS opts it in",
    );
  }

  if (origin != null && origin !== "null" && allowedOrigins && allowedOrigins.size > 0) {
    if (allowedOrigins.has(normalizeOrigin(origin))) return { ok: true };
  }

  if (secFetchSite) {
    if (secFetchSite === "same-origin" || secFetchSite === "none") return { ok: true };
    return block(`cross-origin request refused (Sec-Fetch-Site: ${secFetchSite})`);
  }

  if (origin == null) return { ok: true };
  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return block("invalid Origin header");
  }
  if (originHost !== String(host).trim().toLowerCase()) {
    return block("cross-origin request refused (Origin does not match Host)");
  }
  return { ok: true };
}
