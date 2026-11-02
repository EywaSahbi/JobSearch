import { AsyncLocalStorage } from 'node:async_hooks';

export const providerFetchContext = new AsyncLocalStorage();

export function inProviderFetch() {
  return providerFetchContext.getStore() !== undefined;
}

export function isTrustedProxyLookup(hostname) {
  const context = providerFetchContext.getStore();
  return Boolean(context?.proxyHost && hostname === context.proxyHost && hostname !== context.targetHost);
}

const V4_BLOCKED = [
  [0x00000000, 8],
  [0x0A000000, 8],
  [0x64400000, 10],
  [0x7F000000, 8],
  [0xA9FE0000, 16],
  [0xAC100000, 12],
  [0xC0000000, 24],
  [0xC0A80000, 16],
  [0xC6120000, 15],
  [0xE0000000, 4],
  [0xF0000000, 4],
];

function v4ToInt(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function isBlockedAddress(address) {
  const raw = String(address ?? '').trim();
  if (!raw) return true;

  const addr = raw.split('%')[0].toLowerCase();

  const asV4 = v4ToInt(addr);
  if (asV4 !== null) {
    return V4_BLOCKED.some(([net, bits]) => {
      const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
      return (asV4 & mask) >>> 0 === net;
    });
  }

  if (!addr.includes(':')) return true;

  const tail = addr.slice(addr.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const embedded = v4ToInt(tail);
    return embedded === null ? true : isBlockedAddress(tail);
  }
  const hexEmbedded = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hexEmbedded) {
    const high = Number.parseInt(hexEmbedded[1], 16);
    const low = Number.parseInt(hexEmbedded[2], 16);
    return isBlockedAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }

  if (addr === '::' || addr === '::1') return true;
  if (/^f[cd]/.test(addr)) return true;
  if (/^fe[89ab]/.test(addr)) return true;
  if (/^ff/.test(addr)) return true;
  return false;
}

export function blockedAddressError(hostname, address) {
  const err = new Error(
    `Refusing to connect to ${hostname}: resolves to non-public address ${address}`,
  );
  (err).code = 'ECAREEROPS_BLOCKED_ADDRESS';
  (err).hostname = hostname;
  (err).address = address;
  return err;
}
