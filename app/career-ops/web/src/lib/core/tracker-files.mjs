import fs from "node:fs";
import path from "node:path";

export function resolveTrackerPath(root) {
  const override = process.env.CAREER_OPS_TRACKER?.trim();
  const candidate = path.resolve(override || (
    fs.existsSync(path.join(root, "data/applications.md"))
      ? path.join(root, "data/applications.md")
      : path.join(root, "applications.md")
  ));
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

export function readTrackerFile(root, sibling) {
  const tracker = resolveTrackerPath(root);
  const file = sibling ? path.join(path.dirname(tracker), sibling) : tracker;
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
