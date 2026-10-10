import fs from "node:fs";
import * as yaml from "js-yaml";

export class PortalsConfigError extends Error {
  constructor(message, kind, cause) {
    super(message, { cause });
    this.name = "PortalsConfigError";
    this.kind = kind;
  }
}

export function isMapping(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function loadPortalsDocument(file, templateFile) {
  let source;
  let seeded = false;

  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw new PortalsConfigError("could not read portals.yml", "read-failed", error);
    }

    seeded = true;
    try {
      source = fs.readFileSync(templateFile, "utf8");
    } catch (templateError) {
      throw new PortalsConfigError("could not read portals template", "read-failed", templateError);
    }
  }

  let parsed;
  try {
    parsed = yaml.load(source);
  } catch (error) {
    throw new PortalsConfigError(
      seeded ? "portals template contains invalid YAML" : "portals.yml contains invalid YAML",
      seeded ? "invalid-template" : "invalid-user-config",
      error,
    );
  }

  if (!isMapping(parsed)) {
    throw new PortalsConfigError(
      seeded ? "portals template must contain a YAML mapping" : "portals.yml must contain a YAML mapping",
      seeded ? "invalid-template" : "invalid-user-config",
    );
  }

  return { doc: parsed, seeded };
}

export function mergePortalFilters(doc, roles, locations) {
  const merged = { ...doc };
  const titleFilter = isMapping(doc.title_filter) ? { ...doc.title_filter } : {};
  titleFilter.positive = [...roles];
  merged.title_filter = titleFilter;

  if (locations?.length) {
    const locationFilter = isMapping(doc.location_filter) ? { ...doc.location_filter } : {};
    locationFilter.allow = [...locations];
    merged.location_filter = locationFilter;
  }

  return merged;
}
