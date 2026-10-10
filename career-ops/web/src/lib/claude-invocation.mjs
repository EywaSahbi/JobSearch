import { capabilitiesFor } from "./worker-capabilities.mjs";

export const WRITE_CAPABLE_TOOLS = Object.freeze(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);

export const NETWORK_TOOLS = Object.freeze(["WebFetch", "WebSearch"]);

const ALWAYS_DENIED = ["Task"];

export function toolNames(value) {
  return String(value ?? "")
    .split(",")
    .map((t) => t.trim().replace(/\(.*$/, "").trim())
    .filter(Boolean);
}

export function scopeFrom(allowed) {
  const granted = toolNames(allowed);
  const restricted = [...WRITE_CAPABLE_TOOLS, ...NETWORK_TOOLS];
  const denied = [...restricted.filter((t) => !granted.includes(t)), ...ALWAYS_DENIED];
  return Object.freeze({ allowed, disallowed: denied.join(",") });
}

export const TOOL_SCOPES = Object.freeze({
  persisting: scopeFrom("Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep"),
  networkReadOnly: scopeFrom("Read,WebFetch,WebSearch,Glob,Grep"),
  localReadOnly: scopeFrom("Read,Glob,Grep"),
});

export function toolScopeFor(kind) {
  const { writes, network } = capabilitiesFor(kind);
  if (writes) return TOOL_SCOPES.persisting;
  return network ? TOOL_SCOPES.networkReadOnly : TOOL_SCOPES.localReadOnly;
}

export function grantsWriteCapability(scope) {
  const allowed = toolNames(scope?.allowed);
  return WRITE_CAPABLE_TOOLS.some((tool) => allowed.includes(tool));
}

export function claudeCliArgs({ kind, prompt }) {
  const scope = toolScopeFor(kind);
  return [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "acceptEdits",
    ...(capabilitiesFor(kind).writes ? [] : ["--strict-mcp-config"]),
    "--allowedTools", scope.allowed,
    "--disallowedTools", scope.disallowed,
  ];
}

export function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 || i + 1 >= args.length ? "" : args[i + 1];
}

export function verifyClaudeArgs(args, capabilities) {
  const forbidden = [
    ...(capabilities.writes ? [] : WRITE_CAPABLE_TOOLS),
    ...(capabilities.network ? [] : NETWORK_TOOLS),
  ];
  const denied = toolNames(argValue(args, "--disallowedTools"));
  const unmentioned = forbidden.filter((tool) => !denied.includes(tool));

  const loadsMcpConfig = args.some((a) => a === "--mcp-config" || a.startsWith("--mcp-config="));
  if (!capabilities.writes && (!args.includes("--strict-mcp-config") || loadsMcpConfig)) {
    throw new Error(
      "cli-fencing: claude argv for a non-writing worker must pass --strict-mcp-config and no " +
        "--mcp-config, otherwise a user-configured MCP server could supply a write tool the " +
        "capability record forbids. Native tool flags alone cannot describe what this agent can reach.",
    );
  }

  if (unmentioned.length > 0) {
    throw new Error(
      `cli-fencing: claude argv does not deny ${unmentioned.join(", ")}, which the declared ` +
        `capabilities (writes=${capabilities.writes}, network=${capabilities.network}) forbid. ` +
        "Build the pair with claude-invocation.mjs's scopeFrom() rather than spelling a deny " +
        "list by hand — a forbidden tool that is merely absent is auto-approved by " +
        "--permission-mode acceptEdits.",
    );
  }
  return args;
}
