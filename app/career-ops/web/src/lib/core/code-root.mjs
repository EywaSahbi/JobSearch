import path from "node:path";

export function resolveCodeRoot(cwd, env = process.env) {
  const explicit = (env.CAREER_OPS_CODE_ROOT || "").trim();
  if (explicit) return path.resolve(cwd, explicit);
  return path.resolve(cwd, "..");
}

export function resolveRootScript(codeRoot, nameNoExt) {
  return path.join(codeRoot, `${nameNoExt}.mjs`);
}
