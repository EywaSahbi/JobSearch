import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliSubstitutionNotice, cliUnavailableError, resolveCliOrFallback } from "@/lib/clis";
import { careerOpsRoot, readMemory } from "@/lib/career-ops";
import { assembleDedupContext } from "@/lib/core/discover";
import { CAPS } from "@/lib/worker-capabilities.mjs";
import { scopeFrom } from "@/lib/claude-invocation.mjs";
import { fencingReport } from "@/lib/cli-fencing.mjs";
import { codexFencingSupported } from "@/lib/cli-fencing-probe.mjs";

const ADVISOR_SCOPE = scopeFrom("Read,WebFetch,WebSearch,Glob,Grep");

const CODEX_ISOLATION_FLAGS = ["--strict-config", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check"];
const CODEX_OUTPUT_FLAG = "--output-last-message";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const OUTPUT_CONTRACT = `

--- OUTPUT CONTRACT (the career-ops WEB is parsing your stream) ---
Follow modes/discover.md exactly. You are running headless for the web:
- You are a PROPOSER — never write a file (Write/Edit/Bash are disabled).
- Emit each candidate as ONE line, never inside a code fence:
  <<offer:{"url":"…","title":"…","company":"…","location":"…","source":"ai-search","why":"…","postedHint":"…","ats":"…","verification":"unconfirmed"}>>
  Valid JSON, one per line, the moment you're confident — stream them as you go.
- Between envelopes, narrate briefly (plain text) what you're searching — shown live as your reasoning.
- Be frugal (~3–6 searches, stop at a strong set). EVERY candidate is UNVERIFIED.
- Be a GENEROUS FINDER, not a judge: when a constraint (location, seniority, stage) can't be confirmed from the shallow signal, INCLUDE + flag the uncertainty in "why" — don't discard. NEVER score or judge fit; the A–F evaluation does that later, with the full JD.
- DEDUP: skip anything already known below; don't re-propose the user's existing companies.
`;

export async function POST(req: Request) {
  let body: { query?: string; cliId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const query = (body.query || "").trim();
  const requestedCliId = body.cliId;
  if (!query || !requestedCliId) return Response.json({ error: "query and cliId required" }, { status: 400 });

  const resolved = resolveCliOrFallback(requestedCliId);
  if (!resolved) return Response.json(cliUnavailableError(requestedCliId), { status: 404 });
  const { spec, binPath } = resolved;
  const cliId = spec.id;
  const substitution = cliSubstitutionNotice(resolved);

  let mode: string;
  try {
    mode = fs.readFileSync(path.join(careerOpsRoot(), "modes", "discover.md"), "utf8");
  } catch {
    return Response.json({ code: "MODE_MISSING", error: "AI search needs a newer career-ops — update to enable it." }, { status: 400 });
  }

  const { lines } = assembleDedupContext();
  const memory = readMemory();
  const memoryLine = memory.trim() ? `\n\nWHAT YOU KNOW ABOUT THE USER (persistent memory):\n${memory.trim()}` : "";
  const knownBlock = lines.length ? `\n\n--- ALREADY KNOWN (dedup — do NOT propose these) ---\n${lines.join("\n")}` : "";
  const prompt = `${mode}${OUTPUT_CONTRACT}${memoryLine}${knownBlock}\n\n--- USER INTENT ---\n${query}\n`;

  const isClaude = cliId === "claude";
  const isCodex = cliId === "codex";

  if (isCodex && !(await codexFencingSupported(binPath, { alsoRequiresInExec: [...CODEX_ISOLATION_FLAGS, CODEX_OUTPUT_FLAG] }))) {
    return Response.json(
      {
        code: "CODEX_UNSUPPORTED",
        error:
          "Codex CLI does not support the required read-only execution flags. Update Codex and try again.",
      },
      { status: 400 },
    );
  }

  let childCwd: string;

  if (isCodex) {
    try {
      childCwd = fs.mkdtempSync(
        path.join(os.tmpdir(), "career-ops-codex-"),
      );
    } catch {
      return Response.json(
        {
          code: "CODEX_TEMP_DIR_FAILED",
          error: "AI search could not create an isolated Codex workspace.",
        },
        { status: 400 },
      );
    }
  } else {
    childCwd = careerOpsRoot();
  }

  const codexResultFile = isCodex
    ? path.join(childCwd, "final-response.txt")
    : undefined;

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
    : isCodex
      ? [
          "exec",
          ...CODEX_ISOLATION_FLAGS,
          CODEX_OUTPUT_FLAG,
          codexResultFile!,
          prompt,
        ]
      : spec.args(prompt);

  const useCodexProcessGroup =
    isCodex && process.platform !== "win32";

  const cleanupChildCwd = () => {
    if (!isCodex) return;
    try {
      fs.rmSync(childCwd, { recursive: true, force: true });
    } catch {
    }
  };

  let child;
  try {
    child = spawnHeadlessCli(
      binPath,
      args,
      { cwd: childCwd, env: process.env, detached: useCodexProcessGroup },
      { cliId, capabilities: CAPS.webSearchOnly },
    );
  } catch (e) {
    cleanupChildCwd();
    return Response.json({ error: e instanceof Error ? e.message : "failed to start the CLI" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;

  const isCodexProcessGroupAlive = () => {
    if (!useCodexProcessGroup || !child.pid) return false;

    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const clearTerminationTimers = () => {
    if (killer) {
      clearTimeout(killer);
      killer = undefined;
    }

    if (forceKill && !isCodexProcessGroupAlive()) {
      clearTimeout(forceKill);
      forceKill = undefined;
    }
  };

  const signalChild = (signal: NodeJS.Signals): boolean => {
    if (useCodexProcessGroup && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
      }
    }

    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  };

  const terminateChild = () => {
    const termSent = signalChild("SIGTERM");

    if (!isCodex || !termSent || forceKill) return;

    forceKill = setTimeout(() => {
      signalChild("SIGKILL");
      forceKill = undefined;
    }, 5_000);

    forceKill.unref?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emitted = false;
      let codexStderr = "";
      killer = setTimeout(() => {
        terminateChild();
      }, 480_000);
      const safeClose = () => {
        if (!closed) {
          closed = true;
          clearTerminationTimers();
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
      const fencing = fencingReport({ cliId, cliName: spec.name, capabilities: CAPS.webSearchOnly });
      if (fencing.notice) safeEnqueue(`⚠️ ${fencing.notice}

`);
      if (substitution) safeEnqueue(`⚠️ ${substitution}\n\n`);

      child.stdout.on("data", (d: Buffer) => {
        if (closed) return;

        if (isCodex) return;

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

        if (isCodex) {
          codexStderr = (codexStderr + s).slice(-16_000);
          return;
        }

        if (/error|not found|denied|fatal/i.test(s)) {
          safeEnqueue(`\n[${spec.name}] ${s.trim()}\n`);
        }
      });
      child.on("error", (e) => {
        safeEnqueue(`
[error launching ${spec.name}: ${e.message}]`);
        cleanupChildCwd();
        safeClose();
      });

      child.on("close", (code) => {
        clearTerminationTimers();

        if (closed) {
          cleanupChildCwd();
          return;
        }

        if (isCodex) {
          let finalText = "";

          try {
            if (codexResultFile && fs.existsSync(codexResultFile)) {
              finalText = fs.readFileSync(codexResultFile, "utf8").trim();
            }
          } catch {
          }

          if (finalText) {
            emit(finalText);
          } else if (code !== 0) {
            const diagnosticText = codexStderr.trim();
            const diagnosticsCaptured = diagnosticText.length > 0;

            if (diagnosticsCaptured) {
              const lowerDiagnostics = diagnosticText.toLowerCase();
              const diagnosticMarkers = [
                "error",
                "fatal",
                "failed",
                "denied",
                "not found",
                "invalid",
                "unsupported",
              ].filter((marker) => lowerDiagnostics.includes(marker));

              console.error("[Codex AI search exited without a final response]", {
                exitCode: code ?? "unknown",
                stderrBytes: Buffer.byteLength(diagnosticText, "utf8"),
                stderrLines: diagnosticText.split(/\r?\n/).length,
                diagnosticMarkers,
              });
            }

            safeEnqueue(
              `
[Codex exited with code ${code ?? "unknown"}${
                diagnosticsCaptured ? "; diagnostic output captured" : ""
              }]
`,
            );
          } else if (!emitted) {
            safeEnqueue("_(no final output from Codex)_");
          }

          cleanupChildCwd();
          safeClose();
          return;
        }

        if (!emitted) safeEnqueue("_(no output — is the CLI authenticated?)_");
        safeClose();
      });
    },
    cancel() {
      closed = true;

      if (killer) {
        clearTimeout(killer);
        killer = undefined;
      }

      terminateChild();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
