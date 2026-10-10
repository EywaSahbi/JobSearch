import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import type { DiscoveredOffer } from "./scan";

export type AddResult = { added: number; error?: string };

export function addOffersToPipeline(offers: DiscoveredOffer[]): Promise<AddResult> {
  const clean = offers
    .filter((o) => o && typeof o.url === "string" && /^https?:\/\//i.test(o.url))
    .map((o) => ({
      url: o.url,
      company: o.company || "",
      title: o.title || "",
      location: o.location || "",
      source: o.source || o.ats || "explorer",
      note: o.note || "",
    }));
  if (clean.length === 0) return Promise.resolve({ added: 0 });

  if (!fs.existsSync(rootScript("scan"))) {
    return Promise.resolve({ added: 0, error: "This checkout is data-only — the pipeline writer (scan.mjs) isn't available." });
  }

  const scanUrl = pathToFileURL(rootScript("scan")).href;
  const localTodayUrl = pathToFileURL(path.join(careerOpsRoot(), "lib", "local-today.mjs")).href;
  const code = `
import { appendToPipeline, appendToScanHistory } from ${JSON.stringify(scanUrl)};
import { localToday } from ${JSON.stringify(localTodayUrl)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", async () => {
  try {
    const offers = JSON.parse(input);
    // LOCAL calendar day, not the UTC one — west of Greenwich, an evening
    // add would otherwise stamp scan-history.tsv's first_seen a day ahead,
    // opening scan.mjs's recheck/cooldown gate a day late for this row (#3070).
    const date = localToday();
    await appendToPipeline(offers);
    await appendToScanHistory(offers, date, "added");
    process.stdout.write(JSON.stringify({ added: offers.length }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ added: 0, error: String((e && e.message) || e) }));
  }
});
`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: careerOpsRoot(),
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => resolve({ added: 0, error: e instanceof Error ? e.message : "spawn failed" }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out.trim() || "{}") as AddResult;
        resolve({ added: parsed.added ?? 0, error: parsed.error });
      } catch {
        resolve({ added: 0, error: err.trim().slice(0, 200) || "writer returned no result" });
      }
    });
    child.stdin.write(JSON.stringify(clean));
    child.stdin.end();
  });
}
