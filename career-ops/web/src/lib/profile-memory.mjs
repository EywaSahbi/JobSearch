import fs from "node:fs";
import path from "node:path";

export const NOTES_START = "<!-- co-web-notes:start -->";
export const NOTES_END = "<!-- co-web-notes:end -->";

export function profilePath(root) {
  return path.join(root, "modes", "_profile.md");
}

export function readProfileMemory(root) {
  const read = (file) => {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch (err) {
      if (err?.code === "ENOENT") return "";
      throw err;
    }
  };
  const profile = read(profilePath(root));
  const legacy = read(path.join(root, ".career-ops-web", "memory.md"));
  return [profile, legacy].filter(Boolean).join("\n\n");
}
