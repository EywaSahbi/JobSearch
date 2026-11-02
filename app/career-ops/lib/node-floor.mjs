export const NODE_MIN = '22.13.0';

export const NODE_MIN_23 = '23.4.0';

export const NODE_ENGINES = `^${NODE_MIN} || >=${NODE_MIN_23}`;

const parse = (v) => String(v).replace(/^v/, '').split('.').map(Number);

export function nodeFloor(versionStr) {
  const [major, minor] = parse(versionStr);
  const [minMajor, minMinor] = parse(NODE_MIN);
  const [, min23Minor] = parse(NODE_MIN_23);
  const floor = `${minMajor}.${minMinor}`;

  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return {
      pass: false,
      label: `Could not read the Node.js version ("${versionStr}"), so the Node ${floor}+ requirement could not be verified`,
      fix: [`Check your Node install, then confirm it is ${floor} or later: node --version`],
    };
  }

  const meets = major === 23
    ? minor >= min23Minor
    : major > minMajor || (major === minMajor && minor >= minMinor);

  if (meets) {
    return { pass: true, label: `Node.js >= ${floor} (v${versionStr})` };
  }

  return {
    pass: false,
    label: major === 23
      ? `Node.js 23 needs 23.${min23Minor} or later for node:sqlite without a flag (found v${versionStr})`
      : `Node.js >= ${floor} required (found v${versionStr})`,
    fix: [
      `Install Node.js ${floor} or later (the current LTS is a safe choice) from https://nodejs.org`,
      `tracker.mjs's index uses node:sqlite, which needs no flag only from Node ${floor} on (${NODE_MIN_23.split('.').slice(0, 2).join('.')} on the 23.x line).`,
    ],
  };
}
