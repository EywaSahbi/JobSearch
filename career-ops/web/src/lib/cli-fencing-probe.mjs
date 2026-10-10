import { spawn } from "node:child_process";
import fs from "node:fs";
import { CODEX_REQUIRED_EXEC_FLAGS, CODEX_REQUIRED_GLOBAL_FLAGS } from "./cli-fencing.mjs";

const IDENTITY_FIELDS = Object.freeze(["mtimeMs", "ctimeMs", "size", "ino", "dev"]);

const probeCache = new Map();

const HELP_TIMEOUT_MS = 5_000;
const HELP_CAPTURE_BYTES = 64_000;
const SIGKILL_GRACE_MS = 1_000;

function readCliHelp(binPath, args) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout;
    let killTimeout;

    const finish = (output) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolve(output);
    };

    const appendBounded = (current, chunk) => (current + chunk.toString()).slice(-HELP_CAPTURE_BYTES);

    const child = spawn(binPath, args, { env: { ...process.env, NO_COLOR: "1" } });
    child.stdin?.end();

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", () => {
      if (!timedOut) finish("");
    });
    child.on("close", () => finish(timedOut ? "" : `${stdout}\n${stderr}`));

    timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
      }
      killTimeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
        for (const stream of [child.stdout, child.stderr]) {
          try {
            stream?.destroy();
          } catch {
          }
        }
        finish("");
      }, SIGKILL_GRACE_MS);
      killTimeout.unref?.();
    }, HELP_TIMEOUT_MS);
  });
}

const OPTION_TOKEN = "-{1,2}[A-Za-z0-9?][A-Za-z0-9?-]*";
const OPTION_DECLARATION = new RegExp(
  `^(${OPTION_TOKEN})(?:,\\s*(${OPTION_TOKEN}))?(?:\\s+<[^>]+>(?:\\.\\.\\.)?)?(?:\\s{2,}(?!\\[possible values:)\\S.*?)?(?:\\s*\\[possible values:\\s*([^\\]]+)\\])?\\s*$`,
  "i",
);
const POSSIBLE_VALUES = /^\[possible values:\s*([^\]]+)\]\s*$/i;

function declaresFlag(help, flag) {
  const declaredOptions = new Set();
  const valuesByOption = new Map();
  let currentOptions = [];

  const recordValues = (values) => {
    if (!values || currentOptions.length === 0) return;
    for (const option of currentOptions) {
      const owned = valuesByOption.get(option) ?? new Set();
      for (const value of values.split(",")) owned.add(value.trim());
      valuesByOption.set(option, owned);
    }
  };

  for (const line of help.split(/\r?\n/)) {
    const trimmed = line.trim();
    const declaration = trimmed.match(OPTION_DECLARATION);
    if (declaration) {
      currentOptions = declaration.slice(1, 3).filter(Boolean);
      for (const option of currentOptions) declaredOptions.add(option);
      recordValues(declaration[3]);
      continue;
    }

    recordValues(trimmed.match(POSSIBLE_VALUES)?.[1]);
  }

  if (flag.startsWith("-")) return declaredOptions.has(flag);
  return valuesByOption.get("--sandbox")?.has(flag) ?? false;
}

export function helpSatisfiesFencing({ globalHelp, execHelp }, alsoRequiresInExec = []) {
  return (
    CODEX_REQUIRED_GLOBAL_FLAGS.every((flag) => declaresFlag(globalHelp, flag)) &&
    [...CODEX_REQUIRED_EXEC_FLAGS, ...alsoRequiresInExec].every((flag) => declaresFlag(execHelp, flag))
  );
}

function readBothHelps(binPath, identity) {
  const cached = probeCache.get(binPath);
  if (cached && IDENTITY_FIELDS.every((field) => cached[field] === identity[field])) {
    return cached.help;
  }

  let entry;
  const help = Promise.all([readCliHelp(binPath, ["--help"]), readCliHelp(binPath, ["exec", "--help"])])
    .then(([globalHelp, execHelp]) => {
      if ((!globalHelp.trim() || !execHelp.trim()) && probeCache.get(binPath) === entry) {
        probeCache.delete(binPath);
      }
      return { globalHelp, execHelp };
    })
    .catch(() => {
      if (probeCache.get(binPath) === entry) probeCache.delete(binPath);
      return { globalHelp: "", execHelp: "" };
    });

  entry = { ...identity, help };
  probeCache.set(binPath, entry);
  return help;
}

export function codexFencingSupported(binPath, { alsoRequiresInExec = [] } = {}) {
  let stats;

  try {
    stats = fs.statSync(binPath);
  } catch {
    return Promise.resolve(false);
  }

  const identity = Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, stats[field]]));
  return readBothHelps(binPath, identity).then((help) => helpSatisfiesFencing(help, alsoRequiresInExec));
}
