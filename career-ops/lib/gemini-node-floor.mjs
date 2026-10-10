import { NODE_MIN } from './node-floor.mjs';

export const GEMINI_MIN_MAJOR = 20;

export function geminiNodeFloor(activeCli, versionStr) {
  if (activeCli !== 'gemini') return null;

  const major = Number(String(versionStr).split('.')[0]);

  if (!Number.isFinite(major)) {
    return {
      pass: false,
      label: `Could not read the Node.js version ("${versionStr}"), so the Gemini integration's Node ${GEMINI_MIN_MAJOR}+ requirement could not be verified`,
      fix: [`Check your Node install, then confirm it is ${GEMINI_MIN_MAJOR} or later: node --version`],
    };
  }

  if (major >= GEMINI_MIN_MAJOR) {
    return { pass: true, label: `Node.js >= ${GEMINI_MIN_MAJOR} for the Gemini CLI integration (v${versionStr})` };
  }

  return {
    pass: false,
    label: `The Gemini CLI integration requires Node.js ${GEMINI_MIN_MAJOR}+ (found v${versionStr})`,
    fix: [`Upgrade Node.js to ${NODE_MIN.split('.').slice(0, 2).join('.')} or later from https://nodejs.org (career-ops as a whole needs it; Gemini alone needs ${GEMINI_MIN_MAJOR}+)`],
  };
}
