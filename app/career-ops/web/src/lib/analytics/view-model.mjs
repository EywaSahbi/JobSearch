const NO_RATE = null;

export function rateOrNull(rate, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return NO_RATE;
  if (!Number.isFinite(rate)) return NO_RATE;
  return rate;
}

export function progressModel(stats) {
  const tracker = stats?.tracker ?? null;
  const funnel = stats?.funnel ?? null;
  if (!tracker || !funnel) {
    const reason = stats ? "no-data" : "no-core";
    return { available: false, reason, totals: { tracked: 0, active: 0, offers: 0, avgScore: null, topScore: null }, funnel: { stages: [], rates: [] }, provisional: false };
  }

  const n = (v) => (Number.isFinite(v) ? v : 0);

  const stages = [
    { key: "everApplied", label: "Applied", value: n(funnel.everApplied) },
    { key: "everResponded", label: "Responded", value: n(funnel.everResponded) },
    { key: "everInterview", label: "Interviewed", value: n(funnel.everInterview) },
    { key: "everOffer", label: "Offers", value: n(funnel.everOffer) },
  ];

  const rates = [
    { key: "responseRate", label: "Response rate", value: rateOrNull(funnel.responseRate, funnel.everApplied) },
    { key: "interviewRate", label: "Interview rate", value: rateOrNull(funnel.interviewRate, funnel.everApplied) },
    { key: "offerRate", label: "Offer rate", value: rateOrNull(funnel.offerRate, funnel.everApplied) },
  ];

  return {
    available: true,
    reason: null,
    totals: {
      tracked: n(tracker.total),
      active: n(tracker.activeApps),
      offers: n(funnel.everOffer),
      avgScore: Number.isFinite(tracker.avgScore) && tracker.total > 0 ? tracker.avgScore : null,
      topScore: Number.isFinite(tracker.topScore) && tracker.total > 0 ? tracker.topScore : null,
    },
    funnel: { stages, rates },
    provisional: funnel.smallSample === true,
  };
}

export function statsModel(patterns) {
  if (!patterns) return { state: "unavailable", progress: null, sections: [] };

  if (typeof patterns.error === "string") {
    return {
      state: "below-threshold",
      progress: {
        current: Number.isFinite(patterns.current) ? patterns.current : 0,
        threshold: Number.isFinite(patterns.threshold) ? patterns.threshold : null,
        message: patterns.error,
      },
      sections: [],
    };
  }

  const sections = [];

  const t = patterns.scoreThreshold;
  if (t && Number.isFinite(t.recommended)) {
    sections.push({
      key: "threshold",
      label: "Quality threshold",
      value: t.sufficientSample ? t.recommended : null,
      note: typeof t.reasoning === "string" ? t.reasoning : null,
      sampleSize: Number.isFinite(t.sampleSize) ? t.sampleSize : null,
      provisional: t.sufficientSample !== true,
    });
  }

  for (const [key, label, rows, dim] of [
    ["archetype", "Archetype mix", patterns.archetypeBreakdown, "archetype"],
    ["remote", "Work mode", patterns.remotePolicy, "policy"],
    ["companySize", "Company size", patterns.companySizeBreakdown, "size"],
  ]) {
    const list = Array.isArray(rows) ? rows.filter((r) => Number.isFinite(r?.total) && r.total > 0) : [];
    const named = list.filter((r) => !isUnlabelled(r?.[dim]));
    if (named.length === 0) continue;
    sections.push({ key, label, rows: list, dimension: dim, partial: named.length < list.length });
  }

  const v = patterns.vendorAnalysis;
  if (v) {
    const identified = Number.isFinite(v.identified) ? v.identified : 0;
    const need = Number.isFinite(v.minSampleForClaim) ? v.minSampleForClaim : 0;
    const enough = identified >= need && Array.isArray(v.breakdown) && v.breakdown.length > 0;
    sections.push({
      key: "vendor",
      label: "By ATS vendor",
      rows: enough ? v.breakdown : [],
      claimable: enough,
      coveragePct: Number.isFinite(v.coveragePct) ? v.coveragePct : 0,
      minSampleForClaim: need,
      identified,
      citation: typeof v.citation === "string" ? v.citation : null,
    });
  }

  return { state: "ready", progress: null, sections };
}

export function isUnlabelled(label) {
  const s = String(label ?? "").trim().toLowerCase();
  return s === "" || s === "unknown" || s === "n/a" || s === "—" || s === "-";
}
