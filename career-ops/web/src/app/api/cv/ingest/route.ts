import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliSubstitutionNotice, cliUnavailableError, resolveCliOrFallback, type CliResolution } from "@/lib/clis";
import { careerOpsRoot } from "@/lib/career-ops";
import { CAPS } from "@/lib/worker-capabilities.mjs";
import { scopeFrom } from "@/lib/claude-invocation.mjs";
import { fencingReport } from "@/lib/cli-fencing.mjs";

const ADVISOR_SCOPE = scopeFrom("Read,Glob,Grep");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function readCanonicalMode(): string | null {
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), "modes", "cv-ingest.md"), "utf8");
  } catch {
    return null;
  }
}

function ingestPrompt(source: string): string {
  const mode = readCanonicalMode();
  if (mode) {
    return `${mode}\n\n--- HEADLESS OUTPUT CONTRACT (the career-ops WEB is parsing your stream) ---\nFollow the mode above exactly. You are a PROPOSER running headless: emit ONLY the markdown between <<cv:start>> and <<cv:end>> (own lines, never in a code fence), then one <<cv:seed>>{...} line; or <<cv:error>>{"reason":"unreadable"} if you can't read it. Narrate one short line before <<cv:start>>.\n\n${source}`;
  }
  return `You convert a person's CV into clean cv.md markdown that EXACTLY mirrors career-ops's reference format.

FORMAT (match exactly; omit a section if the source lacks it; INVENT NOTHING):
\`# CV -- {Full Name}\`
then bold contact lines directly under the title (no "Contact" section):
\`**Location:** …\` / \`**Email:** …\` / \`**LinkedIn:** …\` / \`**Portfolio:** …\` / \`**GitHub:** …\`
\`## Professional Summary\` — a 2-4 line summary, only from facts present.
\`## Work Experience\` — each role as: \`### {Company} -- {Location}\`, then \`**{Job Title}**\` on its own line, then \`{Start}-{End or Present}\` on its own line, then bullet points (preserve EVERY quantified achievement verbatim).
\`## Projects\` — flat bullets: \`- **{Name}** ({type}) -- {what + hero metric}\`.
\`## Education\` — flat bullets: \`- {Degree}, {Institution} ({year})\`.
\`## Skills\` — grouped bullets: \`- **{Category}:** {comma list}\`.
Use \`--\` (double hyphen), NEVER an em dash (ATS rule). Preserve every company/title/date/metric. Clean, don't rewrite — it's THEIR CV.

OUTPUT PROTOCOL:
- You are a PROPOSER: do NOT write any file. Emit ONLY the markdown wrapped EXACTLY between a line \`<<cv:start>>\` and a line \`<<cv:end>>\` (each on its own line, never inside a code fence).
- After \`<<cv:end>>\`, emit ONE more line: \`<<cv:seed>>{"title":"<their current/target role>","roles":["<3-5 role keywords>"],"location":"<their location or 'Remote'>"}\`
- If the source is unreadable or empty, emit ONLY: \`<<cv:error>>{"reason":"unreadable"}\` and stop.
- Narrate one short line BEFORE \`<<cv:start>>\` (e.g. "Reading your CV…").

${source}`;
}

const TEXT_SRC = (t: string) => `SOURCE (the user's CV, pasted as text — convert it):\n"""\n${t.slice(0, 24000)}\n"""`;
const FILE_SRC = (p: string) => `SOURCE: the user's CV is the file at this local path — READ it with your file/Read tool, then convert it:\n${p}`;

export async function POST(req: Request) {
  const ctype = req.headers.get("content-type") || "";
  let cliId = "";
  let promptSource = "";
  let tempFile: string | null = null;
  let resolved: CliResolution | null = null;

  try {
    if (ctype.includes("application/json")) {
      const body = (await req.json()) as { text?: string; cliId?: string };
      cliId = body.cliId || "";
      const text = (body.text || "").trim();
      if (!text) return Response.json({ error: "empty cv text" }, { status: 400 });
      promptSource = TEXT_SRC(text);
    } else if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      cliId = String(form.get("cliId") || "");
      const file = form.get("file");
      if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });
      resolved = resolveCliOrFallback(cliId);
      if (!resolved) return Response.json(cliUnavailableError(cliId), { status: 404 });
      if (resolved.spec.id !== "claude" && /\.(pdf|docx)$/i.test(file.name)) {
        return Response.json({ error: "PDF upload needs Claude Code — paste your CV text instead." }, { status: 400 });
      }
      const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] || ".pdf").toLowerCase();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-cv-"));
      tempFile = path.join(dir, `cv${ext}`);
      fs.writeFileSync(tempFile, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
      promptSource = FILE_SRC(tempFile);
    } else {
      return Response.json({ error: "unsupported content-type" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  resolved ??= resolveCliOrFallback(cliId);
  if (!resolved) {
    if (tempFile) cleanupTemp(tempFile);
    return Response.json(cliUnavailableError(cliId), { status: 404 });
  }
  const { spec, binPath } = resolved;
  cliId = spec.id;
  const substitution = cliSubstitutionNotice(resolved);
  const prompt = ingestPrompt(promptSource);
  const isClaude = cliId === "claude";
  const args = isClaude
    ? [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
        "--strict-mcp-config",
        "--allowedTools",
        ADVISOR_SCOPE.allowed,
        "--disallowedTools",
        ADVISOR_SCOPE.disallowed,
      ]
    : spec.args(prompt);

  let child;
  try {
    child = spawnHeadlessCli(
      binPath,
      args,
      { cwd: careerOpsRoot(), env: process.env },
      { cliId, capabilities: CAPS.localReadOnly },
    );
  } catch (e) {
    if (tempFile) cleanupTemp(tempFile);
    return Response.json({ error: e instanceof Error ? e.message : "failed to start the CLI" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emitted = false;
      killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
        }
      }, 240_000);
      const safeClose = () => {
        if (!closed) {
          closed = true;
          if (killer) clearTimeout(killer);
          if (tempFile) cleanupTemp(tempFile);
          try {
            controller.close();
          } catch {
          }
        }
      };
      const safeEnqueue = (s: string): boolean => {
        if (closed || !s) return false;
        try {
          controller.enqueue(encoder.encode(s));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      const emit = (s: string) => {
        if (safeEnqueue(s)) emitted = true;
      };
      const fencing = fencingReport({ cliId, cliName: spec.name, capabilities: CAPS.localReadOnly });
      if (fencing.notice) safeEnqueue(`⚠️ ${fencing.notice}\n\n`);
      if (substitution) safeEnqueue(`⚠️ ${substitution}\n\n`);

      child.stdout.on("data", (d: Buffer) => {
        if (closed) return;
        if (!isClaude) {
          emit(d.toString());
          return;
        }
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
              const text = obj.event.delta?.text;
              if (typeof text === "string") emit(text);
            }
          } catch {
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        if (/error|not found|denied|fatal/i.test(s)) safeEnqueue(`\n[${spec.name}] ${s.trim()}\n`);
      });
      child.on("error", (e) => {
        safeEnqueue(`\n[error launching ${spec.name}: ${e.message}]`);
        safeClose();
      });
      child.on("close", () => {
        if (!emitted) safeEnqueue("<<cv:error>>{\"reason\":\"no-output\"}");
        safeClose();
      });
    },
    cancel() {
      closed = true;
      if (killer) clearTimeout(killer);
      try {
        child.kill("SIGTERM");
      } catch {
      }
      if (tempFile) cleanupTemp(tempFile);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}

function cleanupTemp(file: string) {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
  }
}
