import { verifyClaudeArgs } from "./claude-invocation.mjs";

const CODEX_READ_ONLY = "read-only";
const CODEX_WORKSPACE_WRITE = "workspace-write";

export function isCliAllowedForCapabilities(cliId, { writes }) {
  return cliId !== "hermes" || !writes;
}


function codexSandboxMode({ writes, network }) {
  return writes || network === "fetch" ? CODEX_WORKSPACE_WRITE : CODEX_READ_ONLY;
}

function codexGlobalFencingFlags({ network }) {
  return ["--ask-for-approval", "never", ...(network ? ["--search"] : [])];
}

function codexExecFencingFlags(capabilities) {
  const mode = codexSandboxMode(capabilities);
  const flags = ["-c", `sandbox_mode=${mode}`];
  if (mode === CODEX_WORKSPACE_WRITE && capabilities.network === "fetch") {
    flags.push("-c", "sandbox_workspace_write.network_access=true");
  }
  return flags;
}

const CODEX_PERMISSION_TOKENS = Object.freeze([
  "-s",
  "--sandbox",
  "--ask-for-approval",
  "--search",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--approve-for-me",
  "--not-so-yolo",
  "--full-auto",
]);

const CODEX_PERMISSION_CONFIG_KEYS = Object.freeze([
  "sandbox_mode",
  "sandbox_workspace_write.",
  "approval_policy",
  "web_search",
  "features.web_search_request",
]);

function setsCodexPermissionKey(payload) {
  const key = payload.split("=")[0].trim();
  return CODEX_PERMISSION_CONFIG_KEYS.some((policyKey) =>
    policyKey.endsWith(".") ? key.startsWith(policyKey) : key === policyKey,
  );
}

function codexConfigPayload(arg) {
  if (arg.startsWith("--config=")) return arg.slice("--config=".length);
  if (arg.startsWith("-c") && arg.length > 2) return arg.slice(2);
  return arg;
}

function assertCodexArgvUnfenced(args) {
  const spelled = args
    .slice(0, -1)
    .find(
      (arg) =>
        CODEX_PERMISSION_TOKENS.includes(arg.split("=")[0]) ||
        (arg.startsWith("-s") && arg.length > 2) ||
        setsCodexPermissionKey(codexConfigPayload(arg)),
    );
  if (spelled !== undefined) {
    throw new Error(
      `cli-fencing: codex argv already spells ${JSON.stringify(spelled)}. ` +
        "Permission belongs to the capability record, not the call site — declare it in worker-capabilities.mjs.",
    );
  }
}

function fenceCodexArgs(args, capabilities) {
  assertCodexArgvUnfenced(args);
  const exec = args.indexOf("exec");
  if (exec === -1 || exec === args.length - 1) {
    throw new Error(
      `cli-fencing: codex argv must contain an "exec" subcommand followed by a prompt, got ${JSON.stringify(args)}. ` +
        "Sandbox flags have no known-safe insertion point in this argv shape.",
    );
  }
  return [
    ...args.slice(0, exec),
    ...codexGlobalFencingFlags(capabilities),
    "exec",
    ...codexExecFencingFlags(capabilities),
    ...args.slice(exec + 1),
  ];
}

export const CODEX_REQUIRED_GLOBAL_FLAGS = Object.freeze(["--ask-for-approval", "--search", "--config"]);

export const CODEX_REQUIRED_EXEC_FLAGS = Object.freeze([
  "--config",
  "--sandbox",
  CODEX_READ_ONLY,
  CODEX_WORKSPACE_WRITE,
]);

const FENCERS = Object.freeze({
  claude: verifyClaudeArgs,
  codex: fenceCodexArgs,
});

export function fencingReport({ cliId, cliName, capabilities }) {
  if (!Object.hasOwn(FENCERS, cliId)) {
    return {
      level: "none",
      notice: `${cliName} ${UNFENCED_MARKER} — this agent runs with its default access`,
    };
  }
  if (cliId === "codex" && !capabilities.writes && capabilities.network === "fetch") {
    return {
      level: "partial",
      notice: `${cliName} ${PARTIAL_MARKER}: this worker has to open urls it is handed, which its sandbox ` +
        "only allows alongside write access — its writes are confined to the project folder, not blocked",
    };
  }
  return { level: "full", notice: null };
}

const UNFENCED_MARKER = "cannot be permission-restricted";
const PARTIAL_MARKER = "is only partly restricted";

export function isFencingNotice(label) {
  return typeof label === "string" && (label.includes(UNFENCED_MARKER) || label.includes(PARTIAL_MARKER));
}

export function fenceArgs({ cliId, args, capabilities }) {
  if (!Object.hasOwn(FENCERS, cliId)) return { args };
  return { args: FENCERS[cliId](args, capabilities) };
}
