import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "@/lib/core/safe-write";
import { CHANNELS, isRealISODate, localISODate } from "@/lib/followups";
import { parseFollowupId } from "@/lib/followup-id.mjs";
import { followupsLogPath, withFollowupsWrite, followupsWriteError } from "@/lib/followups-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cell(v: unknown, max?: number): string {
  const s = String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "/")
    .trim();
  return max ? s.slice(0, max) : s;
}

const TABLE_HEADER = "| num | appNum | date | company | role | channel | contact | notes |\n|---|---|---|---|---|---|---|---|\n";

export async function POST(req: Request) {
  let body: {
    appNum?: string | number;
    num?: string | number;
    company?: string;
    role?: string;
    date?: string;
    channel?: string;
    contact?: string;
    notes?: string;
    note?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const appNum = parseFollowupId(body.appNum ?? body.num);
  if (appNum === null) {
    return Response.json({ error: "appNum (application #) required" }, { status: 400 });
  }
  const company = cell(body.company, 80);
  if (!company) return Response.json({ error: "company required" }, { status: 400 });

  const date = (body.date ?? localISODate()).trim();
  if (!isRealISODate(date)) {
    return Response.json({ error: "date must be a real calendar date (YYYY-MM-DD)" }, { status: 400 });
  }
  const rawChannel = (body.channel ?? "Other").trim();
  const channel = CHANNELS.find((c) => c.toLowerCase() === rawChannel.toLowerCase());
  if (!channel) {
    return Response.json({ error: `channel must be one of: ${CHANNELS.join(", ")}` }, { status: 400 });
  }
  const role = cell(body.role, 80);
  const contact = cell(body.contact, 120);
  const notes = cell(body.notes ?? body.note ?? "");

  const file = followupsLogPath();
  try {
    return await withFollowupsWrite(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let existing = "";
      if (fs.existsSync(file)) existing = fs.readFileSync(file, "utf8");
      else fs.writeFileSync(file, "# Follow-ups\n\n", "utf8");

      let maxNum = 0;
      let hasHeader = false;
      for (const line of existing.split("\n")) {
        if (!line.startsWith("|")) continue;
        const first = line.split("|")[1]?.trim() ?? "";
        if (/^(num|#)$/i.test(first)) hasHeader = true;
        const n = Number.parseInt(first, 10);
        if (Number.isInteger(n) && n > maxNum) maxNum = n;
      }
      const num = maxNum + 1;

      let out = "";
      if (existing && !existing.endsWith("\n")) out += "\n";
      if (!hasHeader) out += TABLE_HEADER;
      out += `| ${num} | ${appNum} | ${date} | ${company} | ${role} | ${channel} | ${contact} | ${notes} |\n`;
      fs.appendFileSync(file, out, "utf8");
      return Response.json({ ok: true, num, appNum, date, channel });
    });
  } catch (e) {
    return followupsWriteError(e, "write failed");
  }
}

export async function DELETE(req: Request) {
  let body: { num?: string | number };
  try {
    body = (await req.json()) as { num?: string | number };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const num = parseFollowupId(body.num);
  if (num === null) return Response.json({ error: "num required" }, { status: 400 });

  const file = followupsLogPath();
  if (!fs.existsSync(file)) return Response.json({ error: "no follow-up log" }, { status: 404 });
  try {
    return await withFollowupsWrite(() => {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      const idx = lines.findIndex((line) => {
        if (!line.startsWith("|")) return false;
        const first = line.split("|")[1]?.trim() ?? "";
        return Number.parseInt(first, 10) === num && /^\d+$/.test(first);
      });
      if (idx === -1) return Response.json({ error: `follow-up #${num} not found` }, { status: 404 });
      lines.splice(idx, 1);
      atomicWrite(file, lines.join("\n"));
      return Response.json({ ok: true, num });
    });
  } catch (e) {
    return followupsWriteError(e, "delete failed");
  }
}
