import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexStreamArgs, isFatalClaudeStderr, isFatalCodexStderr, parseClaudeEvent, parseCodexEvent, parseGrokEvent } from "./run-cli-support.mjs";
import { installedCliIds, pickUsableCli } from "./cli-pick.mjs";

export type CliSpec = {
  id: string;
  name: string;
  bin: string;
  run: string;
  url: string;
  args: (prompt: string) => string[];
  streamArgs?: (prompt: string) => string[];
  parseEvent?: (line: string) => import("./run-cli-support.mjs").ParsedEvent | null;
  stderrIsFatal?: (line: string) => boolean;
};

export const KNOWN: CliSpec[] = [
  { id: "claude", name: "Claude Code", bin: "claude", run: "claude -p", url: "https://claude.ai/code", args: (p) => ["-p", p], parseEvent: parseClaudeEvent, stderrIsFatal: isFatalClaudeStderr },
  { id: "codex", name: "Codex", bin: "codex", run: "codex exec", url: "https://github.com/openai/codex", args: (p) => ["exec", p], streamArgs: codexStreamArgs, parseEvent: parseCodexEvent, stderrIsFatal: isFatalCodexStderr },
  { id: "gemini", name: "Gemini CLI", bin: "gemini", run: "gemini -p", url: "https://github.com/google-gemini/gemini-cli", args: (p) => ["-p", p] },
  { id: "opencode", name: "OpenCode", bin: "opencode", run: "opencode run", url: "https://opencode.ai", args: (p) => ["run", p] },
  { id: "pi", name: "Pi", bin: "pi", run: "pi -p", url: "https://github.com/earendil-works/pi", args: (p) => ["--no-session", "-p", p] },
  { id: "copilot", name: "GitHub Copilot CLI", bin: "copilot", run: "copilot -p", url: "https://docs.github.com/en/copilot/github-copilot-in-the-cli", args: (p) => ["-p", p] },
  { id: "qwen", name: "Qwen CLI", bin: "qwen", run: "qwen -p", url: "https://qwen.ai/qwencode", args: (p) => ["-p", p] },
  { id: "antigravity", name: "Antigravity CLI", bin: "agy", run: "agy -p", url: "https://antigravity.google", args: (p) => ["-p", p] },
  { id: "grok", name: "Grok Build CLI", bin: "grok", run: "grok -p", url: "https://docs.x.ai/build/overview", args: (p) => ["-p", p], streamArgs: (p) => ["-p", p, "--output-format", "streaming-json"], parseEvent: parseGrokEvent },
  { id: "hermes", name: "Hermes Agent", bin: "hermes", run: "hermes chat", url: "https://github.com/NousResearch/hermes-agent", args: (p) => ["chat", "-q", p, "--oneshot", "-Q", "--no-restore-cwd"] },
];

function searchDirs(): string[] {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local/bin"),
    path.join(home, ".grok/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".deno/bin"),
    path.join(home, ".opencode/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    extra.push(
      path.join(localAppData, "agy", "bin"),
      path.join(localAppData, "grok", "bin"),
      path.join(localAppData, "Microsoft", "WindowsApps"),
      path.join(appData, "npm"),
    );
  }
  const fromPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...new Set([...fromPath, ...extra])];
}

function binCandidates(bin: string): string[] {
  if (process.platform !== "win32") return [bin];
  const pathext = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  const exts = pathext
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
    .filter((e) => [".com", ".exe", ".bat", ".cmd"].includes(e.toLowerCase()));

  return [bin, ...exts.map((ext) => bin + ext)];
}

export function findBin(bin: string, dirs = searchDirs()): string | null {
  for (const dir of dirs) {
    for (const candidate of binCandidates(bin)) {
      const p = path.join(dir, candidate);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
      }
    }
  }
  return null;
}

export function detectClis() {
  const dirs = searchDirs();
  return KNOWN.map((c) => {
    const found = findBin(c.bin, dirs);
    return { id: c.id, name: c.name, run: c.run, url: c.url, installed: !!found, path: found };
  });
}

export function resolveCli(id: string): { spec: CliSpec; binPath: string } | null {
  const spec = KNOWN.find((c) => c.id === id);
  if (!spec) return null;
  const binPath = findBin(spec.bin);
  if (!binPath) return null;
  return { spec, binPath };
}

export type CliResolution = { spec: CliSpec; binPath: string; substitutedFrom: string | null };

export function resolveCliOrFallback(id: string): CliResolution | null {
  const direct = resolveCli(id);
  if (direct) return { ...direct, substitutedFrom: null };
  const pick = pickUsableCli(id, detectClis());
  if (!pick.id) return null;
  const fallback = resolveCli(pick.id);
  return fallback ? { ...fallback, substitutedFrom: pick.substitutedFrom } : null;
}

export function cliSubstitutionNotice(r: CliResolution): string | null {
  if (!r.substitutedFrom) return null;
  return `Saved CLI '${r.substitutedFrom}' is not installed — using ${r.spec.name} instead. Pick one in Config to make this permanent.`;
}

export function cliUnavailableError(id: string): { error: string; installed: string[] } {
  const installed = installedCliIds(detectClis());
  const error = installed.length
    ? `CLI '${id}' not found on this machine. Installed: ${installed.join(", ")} — choose one in Config.`
    : `CLI '${id}' not found on this machine, and no supported CLI is installed. Install one, then choose it in Config.`;
  return { error, installed };
}
