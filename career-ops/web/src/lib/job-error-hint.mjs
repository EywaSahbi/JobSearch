const AUTH_PATTERN =
  /authenticat\w*|login|sign[ -]?in|credential|api[ -]?key|unauthorized|no cli configured/i;

const HINTS = {
  auth: { kind: "auth", text: "Sign your CLI in from Config, then re-run." },
  connection: { kind: "connection", text: "Lost connection to the local server — re-run." },
  interrupted: { kind: "interrupted", text: "The run was interrupted — re-run it." },
};

function lastStepLabel(job) {
  if (!job || job.status !== "error") return "";
  const steps = job.steps || [];
  return steps[steps.length - 1]?.label ?? "";
}

export function jobErrorHint(job) {
  const label = lastStepLabel(job);
  if (!label) return null;
  if (label === "Connection error") return HINTS.connection;
  if (label === "Interrupted (page reloaded)") return HINTS.interrupted;
  if (AUTH_PATTERN.test(label)) return HINTS.auth;
  return null;
}
