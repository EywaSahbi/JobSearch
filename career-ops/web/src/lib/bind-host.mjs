import { isIP } from "node:net";
import { parseAllowedHosts, isLoopbackHost } from "./origin-guard.mjs";

export const LOOPBACK_BIND = "127.0.0.1";
export const ALL_INTERFACES_BIND = "0.0.0.0";

export const NEXT_COMMANDS = Object.freeze(["dev", "start"]);

const SWITCH_LIKE = Object.freeze(
  new Set(["on", "off", "true", "false", "yes", "no", "0", "1", "none", "all", "enable", "enabled", "disable", "disabled"]),
);

const URL_SCHEMES = Object.freeze(new Set(["http", "https"]));

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function isIPLiteral(host) {
  return isIP(host) !== 0;
}

export function isWildcardAddress(host) {
  return host === ALL_INTERFACES_BIND || (host.includes(":") && /^[0:]+$/.test(host));
}

function isUnscopedLinkLocalV6(host) {
  return /^fe[89ab][0-9a-f]:/.test(host);
}

function isNonUnicastAddress(host) {
  const version = isIP(host);
  if (version === 4) {
    const firstOctet = Number(host.slice(0, host.indexOf(".")));
    return (firstOctet >= 224 && firstOctet <= 239) || host === "255.255.255.255";
  }
  return version === 6 && host.startsWith("ff");
}

function isPlausibleHost(host) {
  if (isIPLiteral(host)) return true;
  if (host.length > 253) return false;
  const labels = host.replace(/\.$/, "").split(".");
  if (!labels.every((label) => label.length <= 63 && HOSTNAME_LABEL.test(label))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]);
}

export function validateAllowedHosts(envValue) {
  const hosts = [...parseAllowedHosts(envValue)];
  for (const host of hosts) {
    if (SWITCH_LIKE.has(host)) {
      return {
        ok: false,
        error:
          `CAREER_OPS_WEB_ALLOWED_HOSTS="${host}" is not a switch — it is the list of hosts allowed to\n` +
          "reach the dashboard, and any name in it opens the socket beyond this machine.\n" +
          "Unset the variable to stay on loopback, or name the hosts that should reach it.",
      };
    }
    if (isWildcardAddress(host)) {
      return {
        ok: false,
        error:
          `CAREER_OPS_WEB_ALLOWED_HOSTS="${host}" names every interface, which is a bind target and\n` +
          "not a host any client is addressed by. Accepting it opens the socket while the request\n" +
          "guard still matches Host literally, so honest clients on your network get 403 and only a\n" +
          `client that spells "Host: ${host}" is let in.\n` +
          'Name the hosts that should reach it, e.g. CAREER_OPS_WEB_ALLOWED_HOSTS="192.168.1.50".',
      };
    }
    if (isUnscopedLinkLocalV6(host)) {
      return {
        ok: false,
        error:
          `CAREER_OPS_WEB_ALLOWED_HOSTS contains the link-local address "${host}", which is ambiguous\n` +
          "across interfaces and cannot be bound without a zone index. Use a routable address or a\n" +
          "hostname instead.",
      };
    }
    if (isNonUnicastAddress(host)) {
      return {
        ok: false,
        error:
          `CAREER_OPS_WEB_ALLOWED_HOSTS contains "${host}", which is not a unicast address and\n` +
          "cannot identify one interface for a TCP listener. Use a unicast address or a hostname\n" +
          "instead.",
      };
    }
    if (URL_SCHEMES.has(host)) {
      return {
        ok: false,
        error:
          "CAREER_OPS_WEB_ALLOWED_HOSTS takes hosts, not URLs — a scheme is cut off at the colon,\n" +
          "leaving the name of the scheme itself as the allowed host.\n" +
          'Write the host alone, e.g. CAREER_OPS_WEB_ALLOWED_HOSTS="192.168.1.50".',
      };
    }
    if (!isPlausibleHost(host)) {
      return {
        ok: false,
        error:
          `CAREER_OPS_WEB_ALLOWED_HOSTS contains "${host}", which is not a hostname or IP address.\n` +
          "Separate entries with commas or spaces, e.g. CAREER_OPS_WEB_ALLOWED_HOSTS=\"192.168.1.50, nas.local\".",
      };
    }
  }
  return { ok: true, hosts };
}

export function resolveBindHost(envValue) {
  const named = [...parseAllowedHosts(envValue)];
  const reachable = named.filter((host) => !isLoopbackHost(host));
  if (reachable.length === 0) return LOOPBACK_BIND;
  const loopbackAlsoNamed = reachable.length !== named.length;
  if (!loopbackAlsoNamed && reachable.length === 1 && isIPLiteral(reachable[0])) return reachable[0];
  return ALL_INTERFACES_BIND;
}

export function isWidenedBind(bindHost) {
  return !isLoopbackHost(bindHost);
}

export function hasHostFlag(extra) {
  return extra.some((token) => {
    const flag = String(token);
    return flag.startsWith("-H") || flag === "--hostname" || flag.startsWith("--hostname=");
  });
}

export function planNextRun({ command, extra = [], envValue }) {
  if (!NEXT_COMMANDS.includes(command)) {
    return {
      ok: false,
      error:
        `Usage: node server.mjs <${NEXT_COMMANDS.join("|")}> [next options]\n` +
        "Run it through npm: `npm run dev` / `npm start` (extra flags after --).",
    };
  }

  const validation = validateAllowedHosts(envValue);
  if (!validation.ok) return validation;

  const { hosts: allowedHosts } = validation;
  const bindHost = resolveBindHost(envValue);
  const hostFlagSupplied = hasHostFlag(extra);
  const widened = isWidenedBind(bindHost);

  return {
    ok: true,
    argv: hostFlagSupplied ? [command, ...extra] : [command, "-H", bindHost, ...extra],
    bindHost,
    hostFlagSupplied,
    widened,
    allowedHosts,
    grantsNoNewHost: !allowedHosts.some((host) => !isLoopbackHost(host)),
    loopbackUnreachable: !hostFlagSupplied && widened && !isWildcardAddress(bindHost),
  };
}
