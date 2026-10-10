export const DEFAULT_OFFER_LIMIT = 24;

export const MAX_OFFER_LIMIT = 200;

export function resolveOfferLimit(raw) {
  if (raw == null) return DEFAULT_OFFER_LIMIT;
  const text = String(raw).trim();
  if (text === "") return DEFAULT_OFFER_LIMIT;
  const requested = Number(text);
  if (!Number.isInteger(requested)) return DEFAULT_OFFER_LIMIT;
  return Math.min(MAX_OFFER_LIMIT, Math.max(1, requested));
}

const EXPIRED_STATUS = /expired/i;

export function collectWhatsNew(rows, { cutoff, toOffer, offerLimit = DEFAULT_OFFER_LIMIT, fallbackLimit = 12 }) {
  const seen = new Set();
  const offers = [];
  let count = 0;
  let anyDated = false;

  const add = (columns, limit) => {
    if (EXPIRED_STATUS.test(columns[5] || "")) {
      if (columns[0]) seen.add(columns[0]);
      return;
    }
    const offer = toOffer(columns);
    if (!offer || seen.has(offer.url)) return;
    seen.add(offer.url);
    count += 1;
    if (offers.length < limit) offers.push(offer);
  };

  for (let i = rows.length - 1; i >= 1; i--) {
    const columns = rows[i].split("\t");
    const timestamp = Date.parse(columns[1] || "");
    if (Number.isFinite(timestamp)) anyDated = true;
    if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;
    add(columns, offerLimit);
  }

  if (count === 0 && !anyDated) {
    for (let i = rows.length - 1; i >= 1; i--) {
      add(rows[i].split("\t"), fallbackLimit);
    }
  }

  return { offers, count };
}
