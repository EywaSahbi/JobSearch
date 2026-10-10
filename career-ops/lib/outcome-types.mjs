export const OUTCOME_MAP = {
  interview_progress: { state: 'Interview', defaultNote: 'Stage updated' },
  stage_reached: { state: 'Interview', defaultNote: 'Stage updated' },
  interview: { state: 'Interview', defaultNote: 'Interview stage' },
  offer_received: { state: 'Offer', defaultNote: 'Offer received' },
  offer: { state: 'Offer', defaultNote: 'Offer received' },
  hired: { state: 'Hired', defaultNote: 'Offer accepted' },
  accepted: { state: 'Hired', defaultNote: 'Offer accepted' },
  offer_declined: { state: 'Discarded', defaultNote: 'Offer declined by candidate' },
  declined: { state: 'Discarded', defaultNote: 'Offer declined by candidate' },
  rejected: { state: 'Rejected', defaultNote: 'Application rejected' },
  rejection: { state: 'Rejected', defaultNote: 'Application rejected' },
  no_response: { state: 'Discarded', defaultNote: 'No response / ghosted' },
  ghosted: { state: 'Discarded', defaultNote: 'No response / ghosted' },
  interview_only: { state: 'Interview', defaultNote: 'Interview process completed' },
};

export const CANONICAL_OUTCOMES = [
  'interview_progress', 'interview_only', 'offer_received', 'hired',
  'offer_declined', 'rejected', 'no_response',
];

const ALIASES = {
  stage_reached: 'interview_progress',
  interview: 'interview_progress',
  offer: 'offer_received',
  accepted: 'hired',
  declined: 'offer_declined',
  rejection: 'rejected',
  ghosted: 'no_response',
};

for (const key of Object.keys(OUTCOME_MAP)) {
  if (!CANONICAL_OUTCOMES.includes(key) && !(key in ALIASES)) {
    throw new Error(`outcome-types.mjs: "${key}" is accepted by outcome.mjs but has no canonical meaning; add it to ALIASES or CANONICAL_OUTCOMES`);
  }
}

export function canonicalOutcome(raw) {
  const key = String(raw ?? '').trim().toLowerCase().replace(/-/g, '_');
  if (CANONICAL_OUTCOMES.includes(key)) return key;
  return ALIASES[key] ?? null;
}
