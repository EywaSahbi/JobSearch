import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export function isBlockedIp(ip) {
  const fam = isIP(ip);
  if (fam === 0) return true;

  if (fam === 4) return isBlockedV4(ip);

  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f][0-9a-f]:/.test(lower)) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const a = parseInt(mappedHex[1], 16), b = parseInt(mappedHex[2], 16);
    return isBlockedV4([(a >> 8) & 255, a & 255, (b >> 8) & 255, b & 255].join('.'));
  }
  return false;
}

function isBlockedV4(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && o[2] === 0) return true;
  if (a >= 224) return true;
  return false;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export async function resolveAndValidate(hostname, { allowsLocalhost = false } = {}) {
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      if (allowsLocalhost && isLoopbackLiteral(hostname)) return [hostname];
      throw new Error(`plugin egress to ${hostname} is blocked (private/loopback/metadata range)`);
    }
    return [hostname];
  }

  if (allowsLocalhost && LOOPBACK_HOSTS.has(hostname.toLowerCase())) {
    return ['127.0.0.1'];
  }

  let addrs;
  try {
    addrs = await dnsLookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`plugin egress: cannot resolve ${hostname} — ${err.message}`);
  }
  if (!addrs.length) throw new Error(`plugin egress: ${hostname} resolved to no addresses`);
  for (const { address } of addrs) {
    if (isBlockedIp(address)) {
      if (allowsLocalhost && isLoopbackLiteral(address)) continue;
      throw new Error(`plugin egress: ${hostname} resolves to a blocked address (${address}) — possible SSRF/rebinding`);
    }
  }
  return addrs.map(a => a.address);
}

function isLoopbackLiteral(ip) {
  if (ip === '::1') return true;
  if (isIP(ip) === 4) return ip.split('.')[0] === '127';
  return false;
}
