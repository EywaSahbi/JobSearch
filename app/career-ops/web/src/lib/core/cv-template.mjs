import path from "node:path";
import { pathToFileURL } from "node:url";
import { BASE_CV_TEMPLATE } from "../run-prompts.mjs";

export async function resolveCvTemplate(root) {
  const file = path.join(root, "cv-templates.mjs");
  try {
    const mod = await import(/* webpackIgnore: true */ pathToFileURL(file).href);
    if (typeof mod?.resolveTemplate !== "function") return BASE_CV_TEMPLATE;
    const profile = process.env.CAREER_OPS_PROFILE?.trim();
    const abs = mod.resolveTemplate("cv", null, {
      fallback: true,
      profilePath: profile ? path.resolve(root, profile) : undefined,
    });
    if (typeof abs !== "string" || !abs) return BASE_CV_TEMPLATE;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    return rel || BASE_CV_TEMPLATE;
  } catch {
    return BASE_CV_TEMPLATE;
  }
}
