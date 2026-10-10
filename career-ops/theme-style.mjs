#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';

export const STYLE_VAR_MAP = {
  accent_color:     '--accent-color',
  secondary_color:  '--secondary-color',
  tag_color:        '--tag-color',
  tag_bg:           '--tag-bg',
  tag_border:       '--tag-border',
  font_family:      '--font-family',
  font_size:        '--font-size',
  margin:           '--page-margin',
  job_break_inside: '--job-break-inside',
  project_break_inside: '--project-break-inside',
};

export function readStyleTokens(profilePath = 'config/profile.yml') {
  try {
    if (!existsSync(profilePath)) return {};
    const raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    return styleTokensFrom(raw?.style);
  } catch {
    return {};
  }
}

export function styleTokensFrom(style) {
  const out = {};
  if (!style || typeof style !== 'object' || Array.isArray(style)) return out;
  for (const [key, cssVar] of Object.entries(STYLE_VAR_MAP)) {
    const v = style[key];
    if (typeof v === 'string' && v.trim()) out[cssVar] = v.trim();
  }
  return out;
}

export function readCvSectionOrder(profilePath = 'config/profile.yml') {
  try {
    if (!existsSync(profilePath)) return [];
    const raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    return cvSectionOrderFrom(raw?.cv);
  } catch {
    return [];
  }
}

export function cvSectionOrderFrom(cv) {
  if (!cv || typeof cv !== 'object' || Array.isArray(cv)) return [];
  const sections = cv.sections;
  if (!Array.isArray(sections)) return [];
  return sections
    .filter(v => typeof v === 'string')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

export function buildThemeStyleBlock(tokens) {
  const decls = Object.entries(tokens || {})
    .filter(([, v]) => typeof v === 'string' && v.trim() && !/[;{}<>]/.test(v))
    .map(([cssVar, v]) => `${cssVar}: ${v.trim()};`)
    .join(' ');
  if (!decls) return '';
  return `<style id="career-ops-dynamic-theme">:root { ${decls} }</style>`;
}

export function injectThemeStyle(html, tokens) {
  const block = buildThemeStyleBlock(tokens);
  if (!block) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, () => `${block}\n</head>`);
  return `${block}\n${html}`;
}
