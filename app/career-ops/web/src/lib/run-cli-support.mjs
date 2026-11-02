import { isReservedReportFile } from "./report-files.mjs";
import { claudeUsageTokens } from "./claude-usage.mjs";

const STATUS_READY = "Agent ready";
const STATUS_RECONNECTING = "Reconnecting…";

function tokenCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

const FATAL_AUTH_STDERR_RE =
  /unauthorized|forbidden|not authenticated|please log in|sign[ -]?in required|credential.*missing/i;

const FATAL_QUOTA_STDERR_RE = /quota|rate limit/i;
const RETRYING_STDERR_RE = /retrying|retry\s+in\b|will\s+retry/i;
const isFatalQuotaStderr = (line) => FATAL_QUOTA_STDERR_RE.test(line) && !RETRYING_STDERR_RE.test(line);

const CLAUDE_FATAL_STDERR_RE = /invalid api key|please run \/login|credit balance|usage limit reached/i;

const CODEX_TRANSIENT_ERROR_RE = /reconnect/i;

export function isFatalCodexStderr(line) {
  return FATAL_AUTH_STDERR_RE.test(line) || isFatalQuotaStderr(line);
}

export function isFatalClaudeStderr(line) {
  return FATAL_AUTH_STDERR_RE.test(line) || CLAUDE_FATAL_STDERR_RE.test(line) || isFatalQuotaStderr(line);
}

export function isFatalGenericStderr(line) {
  return GENERIC_FATAL_STDERR_RE.test(line);
}

const GENERIC_FATAL_STDERR_RE =
  /\berror\b|\bdenied\b|\bfatal\b|not found|\bunauthorized\b|\bforbidden\b|not authenticated|authentication failed|\blogin\b|log in|\bcredentials?\b|api[ -]?key|\bquota\b|rate limit/i;

export function codexStreamArgs(prompt) {
  return ["exec", "--json", "--color", "never", prompt];
}

export function parseCodexEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;

  if (event.type === "thread.started") return { status: STATUS_READY };
  if (event.type === "turn.started") return { status: "Agent working" };

  if (event.type === "item.started") {
    const type = event.item?.type;
    if (type === "command_execution") return { tool: "Bash" };
    if (type === "web_search") return { tool: "WebSearch" };
    if (type === "mcp_tool_call") return { tool: event.item?.tool || "Working" };
  }

  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    if (typeof event.item.text !== "string" || event.item.text === "") return null;
    const text = event.item.text;
    return { text: text.endsWith("\n") ? text : text + "\n" };
  }

  if (event.type === "turn.completed") {
    if (!event.usage) return null;
    const usage = event.usage;
    const fresh = Math.max(0, tokenCount(usage.input_tokens) - tokenCount(usage.cached_input_tokens));
    return { tokens: fresh + tokenCount(usage.output_tokens), costUsd: null };
  }

  if (event.type === "turn.failed" || event.type === "error") {
    const message = String(event.error?.message || event.message || "Codex failed before finishing");
    if (event.type === "error" && CODEX_TRANSIENT_ERROR_RE.test(message)) return { status: STATUS_RECONNECTING };
    return { error: message };
  }

  return null;
}

export function parseClaudeEvent(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== "object") return null;

  if (ev.type === "stream_event") {
    const e = ev.event;
    if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
      return { tool: e.content_block.name };
    }
    if (e?.type === "content_block_delta" && e.delta?.text) {
      return { text: e.delta.text };
    }
    return null;
  }

  if (ev.type === "system" && ev.subtype === "init") {
    return { status: STATUS_READY };
  }

  if (ev.type === "result") {
    const result = {};
    if (ev.usage) {
      result.tokens = claudeUsageTokens(ev.usage);
      if (typeof ev.total_cost_usd === "number") result.costUsd = ev.total_cost_usd;
    }
    if (ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype.startsWith("error"))) {
      const diagnostic =
        (typeof ev.error === "string" && ev.error) ||
        (typeof ev.result === "string" && ev.result) ||
        (typeof ev.subtype === "string" && ev.subtype) ||
        "Claude failed before finishing";
      result.error = String(diagnostic);
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  return null;
}

export function parseGrokEvent(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== "object") return null;

  if (ev.type === "text") {
    if (typeof ev.data !== "string" || ev.data === "") return null;
    return { text: ev.data };
  }

  if (ev.type === "tool_call") {
    const name = ev.toolName ?? ev.title;
    return { tool: typeof name === "string" && name ? name : "Working" };
  }

  if (ev.type === "usage" || ev.type === "end") {
    const usage = ev.usage;
    if (!usage || typeof usage !== "object") return null;
    const fresh = Math.max(0, tokenCount(usage.input_tokens) - tokenCount(usage.cached_input_tokens));
    const result = { tokens: fresh + tokenCount(usage.output_tokens), tokensAreTotal: true };
    result.costUsd = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null;
    return result;
  }

  return null;
}

export function accumulateTokens(current, ev) {
  if (typeof ev?.tokens !== "number") return current;
  return ev.tokensAreTotal ? ev.tokens : current + ev.tokens;
}

export function completedReportNames(entries) {
  return new Set(entries.filter((name) => name.endsWith(".md") && !isReservedReportFile(name)));
}

export function hasNewCompletedReport(beforeEntries, afterEntries) {
  const before = completedReportNames(beforeEntries);
  const after = completedReportNames(afterEntries);
  for (const name of after) {
    if (!before.has(name)) return true;
  }
  return false;
}

export const RUN_MAX_DURATION_S = 800;
export function killMsForKind(kind) {
  return kind === "pdf" ? 600_000 : 780_000;
}

export function timeoutMessage(killMs, kind) {
  return `This run passed the ${Math.round(killMs / 1000)}s time limit and was stopped before it could finish — re-run it, or run a very long ${kind} on Claude Code directly. The CLI was working; we cut it off, so it isn't recorded as a result.`;
}
