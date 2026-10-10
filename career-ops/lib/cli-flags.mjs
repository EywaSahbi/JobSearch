export function flagValue(args, flag) {
  if (!Array.isArray(args)) return undefined;
  const eq = args.find((a) => typeof a === 'string' && a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

export function hasFlag(args, flag) {
  if (!Array.isArray(args)) return false;
  return args.some((a) => typeof a === 'string' && (a === flag || a.startsWith(`${flag}=`)));
}

export function validateFlags(args, knownFlags, usage, { valueFlags = [], requireOperand = false } = {}) {
  if (!Array.isArray(args)) return;

  const consumedValueIndices = new Set();
  args.forEach((a, idx) => {
    if (valueFlags.includes(a) && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) {
      consumedValueIndices.add(idx + 1);
    }
  });

  const unknownFlags = args.filter((a, idx) => {
    if (typeof a !== 'string' || !a.startsWith('-') || consumedValueIndices.has(idx)) return false;
    const flag = a.split('=')[0];
    return !knownFlags.includes(flag) || (a.includes('=') && !valueFlags.includes(flag));
  });
  if (unknownFlags.length > 0) {
    console.error(`Error: unrecognized flag(s): ${unknownFlags.join(', ')}. Valid flags: ${knownFlags.join(', ')}`);
    process.exit(1);
  }

  const missingOperand = requireOperand ? args.filter((a, idx) => {
    if (typeof a !== 'string' || !valueFlags.includes(a)) return false;
    const next = args[idx + 1];
    return next === undefined || (typeof next === 'string' && next.startsWith('--'));
  }) : [];
  if (missingOperand.length > 0) {
    console.error(`Error: ${missingOperand[0]} requires a value`);
    process.exit(1);
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
}

export function safeIntFlag(raw, fallback) {
  if (raw === undefined) return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
