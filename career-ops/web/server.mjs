#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planNextRun } from "./src/lib/bind-host.mjs";

const requireHere = createRequire(import.meta.url);
const [command, ...extra] = process.argv.slice(2);

const plan = planNextRun({
  command,
  extra,
  envValue: process.env.CAREER_OPS_WEB_ALLOWED_HOSTS,
});
if (!plan.ok) {
  console.error(plan.error);
  process.exit(1);
}

if (plan.hostFlagSupplied) {
  console.error(
    "career-ops web: -H/--hostname supplied, so next chooses the bind — this run may be " +
      "reachable from your network.",
  );
  if (plan.grantsNoNewHost) {
    console.error(
      "career-ops web: CAREER_OPS_WEB_ALLOWED_HOSTS names no host beyond loopback, so if that " +
        "flag opens the socket the request guard will refuse honest clients on this interface " +
        "and admit spoofed loopback ones. Name the hosts that should reach it in that variable.",
    );
  }
} else if (plan.widened) {
  console.error(
    `career-ops web: binding ${plan.bindHost} — reachable from your network ` +
      `(allowed hosts: ${plan.allowedHosts.join(", ")}).`,
  );
  if (plan.loopbackUnreachable) {
    console.error(
      `career-ops web: one socket carries one address, so http://localhost:PORT will not answer — ` +
        `open it at ${plan.bindHost}. Name a loopback host alongside it to bind every interface instead.`,
    );
  }
} else {
  console.error(`career-ops web: binding ${plan.bindHost} — loopback only.`);
}

let nextEntry;
try {
  const manifest = requireHere.resolve("next/package.json");
  nextEntry = join(dirname(manifest), requireHere(manifest).bin.next);
} catch (err) {
  console.error(
    err.code === "MODULE_NOT_FOUND"
      ? "Cannot find next — run `npm ci` in web/ and retry."
      : `Cannot resolve next (${err.code ?? "error"}): ${err.message}`,
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [nextEntry, ...plan.argv], {
  cwd: dirname(fileURLToPath(import.meta.url)),
  stdio: "inherit",
});

if (result.error) {
  console.error(`Could not start next: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.signal ? 128 + (os.constants.signals[result.signal] ?? 0) : result.status ?? 1);
