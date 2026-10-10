import { existsSync, readFileSync } from 'fs';
import * as yaml from 'js-yaml';

function defaultProfilePath() {
  return process.env.CAREER_OPS_PROFILE || 'config/profile.yml';
}

function cleanKeywords(value) {
  const arr = Array.isArray(value) ? value : [];
  return [...new Set(
    arr
      .filter(k => typeof k === 'string')
      .map(k => k.trim())
      .filter(Boolean),
  )];
}

export function profileTargetKeywords(profile) {
  const roles = profile && profile.target_roles;
  if (!roles || typeof roles !== 'object') return [];
  return cleanKeywords([
    ...(Array.isArray(roles.primary) ? roles.primary : []),
    ...(Array.isArray(roles.archetypes) ? roles.archetypes.map(a => a && a.name) : []),
  ]);
}

export function resolveProfileKeywords(profilePath = defaultProfilePath()) {
  if (!existsSync(profilePath)) return [];
  try {
    const profile = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    return profileTargetKeywords(profile);
  } catch {
    return [];
  }
}
