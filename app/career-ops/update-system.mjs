#!/usr/bin/env node

import { execFile, execFileSync, execSync, spawnSync } from 'child_process';
import { copyFileSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmSync, lstatSync, statSync, mkdtempSync, realpathSync } from 'fs';
import { join, dirname, basename, resolve, posix as pathPosix } from 'path';
import { tmpdir } from 'os';
import { randomBytes, timingSafeEqual } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

export function createReexecMarker() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'career-ops-reexec-')));
  const path = join(directory, 'marker');
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
  return { path, token };
}

export function consumeReexecMarker() {
  const suppliedPath = process.env.CAREER_OPS_UPDATE_REEXEC_MARKER;
  const token = process.env.CAREER_OPS_UPDATE_REEXEC_TOKEN;
  if (!suppliedPath || !token) {
    return false;
  }
  try {
    const tmpRoot = realpathSync(tmpdir());
    const path = resolve(suppliedPath);
    const parent = dirname(path);
    if (dirname(parent) !== tmpRoot || !basename(parent).startsWith('career-ops-reexec-') || basename(path) !== 'marker') {
      return false;
    }
    if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory() ||
        realpathSync(path) !== path || !lstatSync(path).isFile()) {
      return false;
    }
    const expected = readFileSync(path, 'utf8');
    const expectedBuffer = Buffer.from(expected);
    const tokenBuffer = Buffer.from(token);
    const valid = expectedBuffer.length === tokenBuffer.length && timingSafeEqual(expectedBuffer, tokenBuffer);
    unlinkSync(path);
    rmSync(dirname(path), { recursive: true, force: true });
    return valid;
  } catch {
    return false;
  }
}

function isLegacyReexec() {
  if (process.env.CAREER_OPS_UPDATE_REEXEC !== '1') {
    return false;
  }
  if (!existsSync(join(ROOT, '.update-lock'))) {
    return false;
  }
  const backupBranch = process.env.CAREER_OPS_UPDATE_BACKUP_BRANCH || '';
  if (!/^backup-pre-update-\d+\.\d+\.\d+-\d{8}T\d{6}Z$/.test(backupBranch)) {
    return false;
  }
  try {
    execFileSync('git', [
      'show-ref', '--verify', '--quiet', `refs/heads/${backupBranch}`,
    ], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CANONICAL_REPO = 'https://github.com/career-ops-hq/career-ops.git';
const RAW_VERSION_URL = 'https://raw.githubusercontent.com/career-ops-hq/career-ops/main/VERSION';
const RELEASES_API = 'https://api.github.com/repos/career-ops-hq/career-ops/releases/latest';

export const SEMVER_RE = /(?:^|-)v?(\d+\.\d+\.\d+)$/i;
export const DEFAULT_GIT_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_GIT_TIMEOUT_MS, 120000);
export const DEFAULT_GIT_FETCH_TIMEOUT_MS = parsePositiveInt(
  process.env.CAREER_OPS_GIT_FETCH_TIMEOUT_MS,
  Math.max(DEFAULT_GIT_TIMEOUT_MS, 300000),
);
export const NPM_INSTALL_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_NPM_INSTALL_TIMEOUT_MS, 60000);
export const PLAYWRIGHT_INSTALL_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_PLAYWRIGHT_INSTALL_TIMEOUT_MS, 120000);
export const DASHBOARD_REBUILD_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_DASHBOARD_REBUILD_TIMEOUT_MS, 60000);
export const UPDATE_PATH_CHECKOUT_BUDGET_MS = parsePositiveInt(process.env.CAREER_OPS_UPDATE_PATH_CHECKOUT_BUDGET_MS, 5000);
export const REEXEC_BUFFER_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_REEXEC_BUFFER_TIMEOUT_MS, 60000);

const SYSTEM_PATHS = [
  '.gitattributes',
  'dead-boards.mjs',
  'modes/README.md',
  'modes/_shared.md',
  'modes/_writing.md',
  'modes/_profile.template.md',
  'modes/_custom.template.md',
  'modes/_brief.template.md',
  'voice-dna.template.md',
  'modes/oferta.md',
  'modes/master-profile.md',
  'modes/pdf.md',
  'modes/ats.md',
  'modes/text.md',
  'modes/pdf/',
  'modes/cover.md',
  'modes/email.md',
  'modes/add.md',
  'modes/expand.md',
  'modes/scan.md',
  'modes/discover.md',
  'modes/batch.md',
  'modes/apply.md',
  'modes/auto-pipeline.md',
  'modes/contacto.md',
  'modes/deep.md',
  'modes/ofertas.md',
  'modes/pipeline.md',
  'modes/triage.md',
  'modes/project.md',
  'modes/tracker.md',
  'modes/training.md',
  'modes/interview.md',
  'modes/interview-redflag.md',
  'modes/latex.md',
  'modes/latex-tex.md',
  'modes/followup.md',
  'modes/offer-prep.md',
  'modes/interview-prep.md',
  'modes/interview/',
  'interview-prep/sessions/.gitkeep',
  'interview-prep/sessions/README.md',
  'modes/patterns.md',
  'modes/calibrate.md',
  'modes/titles.md',
  'modes/upskill.md',
  'modes/intake.md',
  'documents/.gitkeep',
  'data/.gitkeep',
  'data/offers/.gitkeep',
  'data/parser-output/.gitkeep',
  'jds/.gitkeep',
  'output/.gitkeep',
  'reports/.gitkeep',
  'documents/README.md',
  'modes/update.md',
  'modes/agent-inbox.md',
  'modes/reply-watch.md',
  'modes/outcome.md',
  'modes/ar/',
  'modes/da/',
  'modes/de/',
  'modes/de/interview/',
  'modes/fr/',
  'modes/fr/interview/',
  'modes/hi/',
  'modes/es/',
  'modes/es/interview/',
  'modes/id/',
  'modes/id/interview/',
  'modes/it/',
  'modes/it/interview/',
  'modes/ja/',
  'modes/ja/interview/',
  'modes/ko/',
  'modes/ko/interview/',
  'modes/nl/',
  'modes/pl/',
  'modes/pl/interview/',
  'modes/pt/',
  'modes/pt/interview/',
  'modes/ru/',
  'modes/ru/interview/',
  'modes/sg/',
  'modes/tr/',
  'modes/ua/',
  'modes/ua/interview/',
  'modes/heuristics/',
  'modes/regional/',
  'modes/zh/',
  'modes/zh/interview/',
  'modes/zh-TW/',
  'CLAUDE.md',
  'CODEX.md',
  'OPENCODE.md',
  'AGENTS.md',
  'GEMINI.md',
  'KIMI.md',
  'build-dashboard.mjs',
  'clean-markers.mjs',
  'cv-experience-order.mjs',
  'generate-pdf.mjs',
  'hired-share.mjs',
  'hired-wall-build.mjs',
  'HIRED.md',
  'theme-style.mjs',
  'generate-latex.mjs',
  'extract-latex-content.mjs',
  'patch-latex-content.mjs',
  'lib/ascii-fold.mjs',
  'lib/cli-flags.mjs',
  'lib/gemini-node-floor.mjs',
  'lib/node-floor.mjs',
  'lib/local-today.mjs',
  'lib/parse-date.mjs',
  'lib/placeholder-cell.mjs',
  'lib/tracker-addition.mjs',
  'lib/scan-summary-marker.mjs',
  'lib/scan-history-columns.mjs',
  'lib/small-board.mjs',
  'lib/tsv-formula-escape.mjs',
  'lib/is-main-module.mjs',
  'lib/mjs-files.mjs',
  'lib/scratch-dirs.mjs',
  'lib/story-bank.mjs',
  'lib/outcome-dir.mjs',
  'lib/outcome-types.mjs',
  'lib/latex-escape.mjs',
  'lib/cv-payload-schema.mjs',
  'lib/cv-markdown.mjs',
  'lib/page-format.mjs',
  'lib/template-manifest.mjs',
  'scan-hn.mjs',
  'scripts/check-syntax.mjs',
  'scripts/export-ats-text.mjs',
  'scripts/followup-sweep.sh',
  'story-provenance-check.mjs',
  'lib/latex-content.mjs',
  'lib/context-budget.mjs',
  'lib/context-budget.test.mjs',
  'lib/golden-budget-analysis.mjs',
  'img-to-pdf.mjs',
  'archive-posting.mjs',
  'jd-capture.mjs',
  'application-answers.mjs',
  'generate-cover-letter.mjs',
  'merge-tracker.mjs',
  'url-key.mjs',
  'sync-pdf-flags.mjs',
  'tracker-links.mjs',
  'tracker.mjs',
  'find.mjs',
  'verify-pipeline.mjs',
  'discard-analytics.mjs',
  'reconcile-pipeline.mjs',
  'dedup-tracker.mjs',
  'add-entry.mjs',
  'role-matcher.mjs',
  'tracker-utils.mjs',
  'tracker-parse.mjs',
  'tracker-aliases.json',
  'session-activity.mjs',
  'set-status.mjs',
  'mark-pdf-ready.mjs',
  'normalize-statuses.mjs',
  'fix-report-links.mjs',
  'cv-sync-check.mjs',
  'i18n-drift.mjs',
  'verify-cv-facts.mjs',
  'verify-cv-structure.mjs',
  'verify-ats.mjs',
  'ats-payload.mjs',
  'update-system.mjs',
  'path-resolver.mjs',
  'ats-vendor.mjs',
  'history-ats-seeds.mjs',

  'reserve-report-num.mjs',
  'scan.mjs',
  'migrate-scan-runs.mjs',
  'pipeline-lock.mjs',
  'portal-health-lock.mjs',
  'classify-tier.mjs',
  'scan-ats-full.mjs',
  'scan-interamt.mjs',
  'scan-dayforce.mjs',
  'company-funded.mjs',
  'match-star.mjs',
  'jd-skill-gap.mjs',
  'career-profile.mjs',
  'cv-title-check.mjs',
  'prepare-application.mjs',
  'application-artifacts.mjs',
  'batch-evaluate-gemini.mjs',
  'providers/',
  'data-static/',
  'seeds/',
  'tests/',

  'agent-inbox-tests.mjs',
  'followup-seed-tests.mjs',
  'paste-reply-tests.mjs',
  'set-status-tests.mjs',
  'tracker-columns-tests.mjs',
  'user-agent.mjs',
  'doctor.mjs',
  'jsonc-parse.mjs',
  'check-liveness.mjs',
  'liveness-core.mjs',
  'liveness-api.mjs',
  'liveness-browser.mjs',
  'browser-extract.mjs',
  'fetch-jd.mjs',
  'analyze-patterns.mjs',
  'keyword-match.mjs',
  'calibrate.mjs',
  'upskill.mjs',
  'skill-extract.mjs',
  'intake.mjs',
  'stats.mjs',
  'funnel-stages.mjs',
  'detect-reposts.mjs',
  'rank-pipeline.mjs',
  'discover-ats.mjs',
  'discover-new-companies.mjs',
  'check-table-freshness.mjs',
  'check-jd-archive.mjs',
  'fingerprint-core.mjs',
  'process-quality.mjs',
  'company-history.mjs',
  'rejection-latency.mjs',
  'salary-gap.mjs',
  'negotiation-roi.mjs',
  'funnel-velocity.mjs',
  'assessment-log.mjs',
  'contacts.mjs',
  'contact-lookup.mjs',
  'linkedin-join.mjs',
  'weekly-digest.mjs',
  'tracker-sync-check.mjs',
  'followup-cadence.mjs',
  'invite-match.mjs',
  'agent-inbox.mjs',
  'followup-seed.mjs',
  'profile-language.mjs',
  'title-keywords.mjs',
  'gemini-eval.mjs',
  'ollama-eval.mjs',
  'openai-eval.mjs',
  'openai-tailor.mjs',
  'eval-golden.mjs',
  'evals/',
  'openrouter-runner.mjs',
  'jd-similarity.mjs',
  'test-all.mjs',
  'tracker-writer-lock-tests.mjs',
  'validate-portals.mjs',
  'validate-profile.mjs',
  'verify-portals.mjs',
  'audit-portals.mjs',
  'fix-slugs.mjs',
  'updater-migration-tests.mjs',
  'validate-system-paths-coverage.mjs',
  'validate-untrusted-content-coverage.mjs',
  'reply-matcher.mjs',
  'reply-watch.mjs',
  'paste-reply.mjs',
  'contact-extract.mjs',
  'contact-extract-tests.mjs',
  'outcome.mjs',
  'batch/batch-prompt.md',
  'batch/batch-runner.sh',
  'batch/aggregate-tokens.mjs',
  'batch/README.md',
  'utils/token-tracker.mjs',
  'batch-tailor.mjs',
  'dashboard/',
  'templates/',
  'config/cv-facts.example.json',
  'fonts/',
  'examples/',
  'config/profile.example.yml',
  'config/local-paths.example.txt',
  '.env.example',
  '.editorconfig',
  '.agents/',
  '.claude/skills/',
  '.cursor/skills/',
  '.opencode/skills/',
  '.opencode/commands/',
  '.claude-plugin/',
  '.codex-plugin/',
  '.qwen/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  '.kimi/skills/',
  'docs/',
  'writing-samples/README.md',
  'VERSION',
  'DATA_CONTRACT.md',
  'MANIFESTO.md',
  'manifesto.mjs',
  'CONTRIBUTING.md',
  'MAINTAINERS.md',
  'ARCHITECTURE.md',
  'README.md',
  'README.ar.md',
  'README.cn.md',
  'README.da.md',
  'README.de.md',
  'README.es.md',
  'README.fr.md',
  'README.hi.md',
  'README.ja.md',
  'README.ko-KR.md',
  'README.pl.md',
  'README.pt-BR.md',
  'README.ru.md',
  'README.ta.md',
  'README.ua.md',
  'README.zh-TW.md',
  'README.tr.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTORS.md',
  '.all-contributorsrc',
  'GOVERNANCE.md',
  'LEGAL_DISCLAIMER.md',
  'SECURITY.md',
  'SUPPORT.md',
  'TRADEMARK.md',
  'LICENSE',
  'CITATION.cff',
  'funding.json',
  '.well-known/',
  '.editorconfig',
  '.github/',
  'package.json',
  'build-cv-latex.mjs',
  'build-cv-html.mjs',
  'cv-sections-core.mjs',
  'cv-templates.mjs',
  'playwright.cv.config.mjs',
  'scaffolder/',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  'cops',
  'DOCKER.md',
  'plugins/',
  'plugins.mjs',
  'plugins-registry/',
  'plugin-install.mjs',
  'plugin-audit.mjs',
  'validate-plugin-registry.mjs',
  'config/plugins.example.yml',
  'opencode.example.json',
  'seed-fixture.mjs',
  'test-fixtures/',
  'upgrade-tests.mjs',
];

const BOOTSTRAP_PATHS = [
  '.agents/',
  '.cursor/skills/',
  '.opencode/skills/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  '.kimi/skills/',
  'providers/',
  'liveness-browser.mjs',
  'tracker-links.mjs',
  'role-matcher.mjs',
  'tracker-utils.mjs',
  'tracker-parse.mjs',
  'tracker-aliases.json',
  'scaffolder/',
  'reserve-report-num.mjs',
  'updater-migration-tests.mjs',
  'validate-portals.mjs',
  'plugins/',
  'plugins.mjs',
  'plugins-registry/',
  'plugin-install.mjs',
  'plugin-audit.mjs',
  'validate-plugin-registry.mjs',
  'config/plugins.example.yml',
  'agent-inbox.mjs',
  'tests/agent-inbox.test.mjs',
];

export const USER_PATHS = [
  '.career-ops-web/',
  'cv.md',
  'config/profile.yml',
  'modes/_profile.md',
  'modes/_custom.md',
  'modes/_brief.md',
  'voice-dna.md',
  'portals.yml',
  'article-digest.md',
  'interview-prep/',
  'documents/',
  'data/',
  'reports/',
  'output/',
  'jds/',
  'writing-samples/',
  'config/plugins.yml',
  'plugins.local/',
  'plugins.lock',
  'opencode.json',
  '.claude/settings.json',
  '.claude/hooks/',
];

export const LOCAL_PATHS_FILE = 'config/local-paths.txt';

export function parseLocalPaths(text) {
  const seen = new Set();
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    seen.add(line);
  }
  return [...seen];
}

export function localUserPaths(root = ROOT) {
  const file = join(root, LOCAL_PATHS_FILE);
  if (!existsSync(file)) return [];

  const declared = parseLocalPaths(readFileSync(file, 'utf-8'));
  const reject = (path, why) => {
    throw new Error(`${LOCAL_PATHS_FILE}: refusing "${path}" — ${why}`);
  };

  for (const path of declared) {
    if (path === LOCAL_PATHS_FILE) {
      reject(path, 'the declaration file cannot list itself (it is gitignored, so nothing updates it)');
    }
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\')) {
      reject(path, 'paths must be repo-relative, not absolute');
    }
    if (path.split(/[\\/]/).includes('..')) {
      reject(path, 'paths must stay inside the repo');
    }
    if (path.includes('\\')) {
      reject(path, 'paths use forward slashes, matching how git reports them');
    }
    const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
    if (segments.includes('')) {
      reject(path, 'paths must not contain an empty segment (a repeated separator)');
    }
    if (segments.includes('.')) {
      reject(path, 'paths must be written plainly, with no "." segment (use "merge-tracker.mjs", not "./merge-tracker.mjs")');
    }
    const collision = SYSTEM_PATHS.find((sys) =>
      sys.endsWith('/') ? path.startsWith(sys) : path === sys,
    );
    if (collision) {
      reject(
        path,
        `the system layer ships it (SYSTEM_PATHS entry "${collision}"). `
        + 'Declaring it would stop updates to it with no other signal',
      );
    }
  }
  return declared;
}

export function effectiveUserPaths(root = ROOT) {
  return [...USER_PATHS, ...localUserPaths(root)];
}

export function userLayerViolations(changedFiles, updatePaths, userPaths) {
  const violations = [];
  for (const file of changedFiles) {
    if (updatePaths.includes(file)) continue;
    if (userPaths.some((userPath) => (userPath.endsWith('/') ? file.startsWith(userPath) : file === userPath))) {
      violations.push(file);
    }
  }
  return violations;
}

function upstreamShipsUnder(path, ref = 'FETCH_HEAD') {
  try {
    const listed = gitQuiet('--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', ref, '--', path);
    return listed.split('\0').filter(Boolean).some((file) => file.startsWith(`${path}/`));
  } catch {
    return false;
  }
}

export function manifestProbes({ trackedOutput, upstreamOutput, root = ROOT }) {
  const trackedFiles = new Set(String(trackedOutput).split('\0').filter(Boolean));
  const upstreamFiles = String(upstreamOutput).split('\0').filter(Boolean);
  return {
    tracked: (path) => trackedFiles.has(path),
    exists: (path) => existsSync(join(root, path)),
    claimsSubtree: (path) => {
      if (path.endsWith('/')) return true;
      const prefix = `${path}/`;
      return upstreamFiles.some((file) => file.startsWith(prefix));
    },
  };
}

function isCanonicalManifestPath(path) {
  if (typeof path !== 'string' || path === '') return false;
  if (path.includes('\0')) return false;
  if (path.includes('\\') || path.startsWith('/')) return false;
  if (path.includes(':')) return false;
  if (/[*?[]/.test(path)) return false;
  const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  return !segments.some((segment) => segment === '' || segment === '.' || segment === '..');
}

export function rejectUserLayerPaths(manifestPaths, userPaths, probes = {}) {
  const tracked = probes.tracked || ((path) => isTracked(path));
  const exists = probes.exists || ((path) => existsSync(join(ROOT, path)));
  const claimsSubtree = probes.claimsSubtree || ((path) => {
    if (path.endsWith('/')) return true;
    try {
      if (existsSync(join(ROOT, path)) && statSync(join(ROOT, path)).isDirectory()) return true;
    } catch { }
    return upstreamShipsUnder(path);
  });
  const trimSlash = (path) => (path.endsWith('/') ? path.slice(0, -1) : path);
  const isUnder = (child, parent) => child.startsWith(`${parent}/`);
  const declared = userPaths.map(trimSlash);
  const declaredDirs = userPaths.filter((path) => path.endsWith('/')).map(trimSlash);

  const kept = [];
  const refused = [];
  for (const path of manifestPaths) {
    if (!isCanonicalManifestPath(path)) {
      refused.push(path);
      continue;
    }
    const entry = trimSlash(path);
    if (declared.some((userPath) => entry === userPath || isUnder(userPath, entry))) {
      refused.push(path);
      continue;
    }
    if (declaredDirs.some((dir) => isUnder(entry, dir))) {
      if (claimsSubtree(path)) {
        refused.push(path);
        continue;
      }
      if (!tracked(entry) && exists(entry)) {
        refused.push(path);
        continue;
      }
    }
    kept.push(path);
  }
  return { kept, refused };
}

function parseVersionFile(raw) {
  return raw.trim().split(/\s+/)[0] || '';
}

function localShortSha(root = ROOT) {
  if (gitToplevelMismatch(root)) return '';
  try {
    return gitQuietIn(root, 'rev-parse', '--short', 'HEAD') || '';
  } catch {
    return '';
  }
}

function formatVersionWithSha(version, sha) {
  return sha ? `${version} (${sha})` : version;
}

function localVersion(root = ROOT) {
  const vPath = join(root, 'VERSION');
  return existsSync(vPath) ? parseVersionFile(readFileSync(vPath, 'utf-8')) : '0.0.0';
}

export function formatLocalVersion(root = ROOT) {
  const version = localVersion(root);
  const sha = localShortSha(root);
  return formatVersionWithSha(version, sha);
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

function updateBackupBranchName(version, date = new Date()) {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `backup-pre-update-${version}-${stamp}`;
}

function backupTimestamp(branchName) {
  const match = branchName.match(/-(\d{8}T\d{6}Z)$/);
  if (!match) return 0;
  const [date, time] = match[1].split('T');
  return Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`,
  ) || 0;
}

function newestBackupBranch(branches) {
  const branchList = branches.split('\n').map(b => b.trim()).filter(Boolean);
  if (branchList.length === 0) return null;

  const timestamped = branchList
    .map(branch => ({ branch, timestamp: backupTimestamp(branch) }))
    .filter(entry => entry.timestamp > 0)
    .sort((a, b) => b.timestamp - a.timestamp);

  return timestamped[0]?.branch || branchList[0];
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function gitTimeoutMs(args) {
  return args[0] === 'fetch' ? DEFAULT_GIT_FETCH_TIMEOUT_MS : DEFAULT_GIT_TIMEOUT_MS;
}

export function reexecTimeoutMs(updatePathCount = SYSTEM_PATHS.length + BOOTSTRAP_PATHS.length) {
  return Math.max(
    120000,
    DEFAULT_GIT_FETCH_TIMEOUT_MS +
      DEFAULT_GIT_TIMEOUT_MS * 3 +
      UPDATE_PATH_CHECKOUT_BUDGET_MS * Math.max(0, updatePathCount) +
      NPM_INSTALL_TIMEOUT_MS +
      PLAYWRIGHT_INSTALL_TIMEOUT_MS +
      DASHBOARD_REBUILD_TIMEOUT_MS +
      REEXEC_BUFFER_TIMEOUT_MS,
  );
}

function describeGitCommand(args) {
  return `git ${args.join(' ')}`;
}

function isTimeoutLikeError(err) {
  return err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM';
}

function timeoutSeconds(timeout) {
  return Math.round(timeout / 1000);
}

function gitTimeoutEnvVar(args) {
  return args[0] === 'fetch' ? 'CAREER_OPS_GIT_FETCH_TIMEOUT_MS' : 'CAREER_OPS_GIT_TIMEOUT_MS';
}

export function gitRawIn(root, ...args) {
  const timeout = gitTimeoutMs(args);
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8', timeout });
  } catch (err) {
    if (isTimeoutLikeError(err)) {
      throw new Error(`${describeGitCommand(args)} timed out after ${timeoutSeconds(timeout)}s. If your network is slow, retry or set ${gitTimeoutEnvVar(args)} to a larger value.`);
    }
    throw err;
  }
}

export function gitIn(root, ...args) {
  return gitRawIn(root, ...args).trim();
}

function git(...args) {
  return gitIn(ROOT, ...args);
}

export function gitQuietIn(root, ...args) {
  const timeout = gitTimeoutMs(args);
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (isTimeoutLikeError(err)) {
      throw new Error(`${describeGitCommand(args)} timed out after ${timeoutSeconds(timeout)}s. If your network is slow, retry or set ${gitTimeoutEnvVar(args)} to a larger value.`);
    }
    throw err;
  }
}

function gitQuiet(...args) {
  return gitQuietIn(ROOT, ...args);
}

export function gitToplevelMismatch(root = ROOT) {
  let toplevel;
  try {
    toplevel = gitQuietIn(root, 'rev-parse', '--show-toplevel');
  } catch {
    return null;
  }
  if (!toplevel) return null;
  const canonicalize = realpathSync.native ?? realpathSync;
  let same;
  try {
    same = canonicalize(toplevel) === canonicalize(root);
  } catch {
    same = resolve(toplevel) === resolve(root);
  }
  return same ? null : toplevel;
}

function assertOwnGitToplevel() {
  const foreignToplevel = gitToplevelMismatch();
  if (foreignToplevel) {
    throw new Error(
      `career-ops at ${ROOT} is not a git checkout of its own, so git operations would land in the enclosing repository at ${foreignToplevel} — this happens when the install was unpacked from a ZIP or copied without its .git directory. Nothing was changed. To make updates work, clone career-ops fresh (git clone ${CANONICAL_REPO}) and move your user-layer files (cv.md, config/, data/, reports/ — see DATA_CONTRACT.md) into the new clone.`,
    );
  }
}

const UPDATE_BRANCH = 'main';

const REDIRECTED_COMMANDS = new Set(['check', 'apply', 'rollback', 'dismiss']);

export function parseWorktreeList(porcelain) {
  const worktrees = [];
  let current = null;
  for (const line of String(porcelain).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, bare: false, prunable: false };
      worktrees.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    }
  }
  return worktrees;
}

function samePath(a, b) {
  const canonicalize = realpathSync.native ?? realpathSync;
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

export function worktreeUpdateTarget(root = ROOT, run = (...args) => gitIn(root, ...args)) {
  let gitDir;
  let commonDir;
  try {
    [gitDir, commonDir] = run('rev-parse', '--git-dir', '--git-common-dir').split(/\r?\n/);
  } catch {
    return null;
  }
  if (!gitDir || !commonDir || samePath(resolve(root, gitDir), resolve(root, commonDir))) return null;

  let branch = '(detached HEAD)';
  try {
    branch = run('rev-parse', '--abbrev-ref', 'HEAD') || branch;
  } catch {
  }

  let worktrees;
  try {
    worktrees = parseWorktreeList(run('worktree', 'list', '--porcelain'));
  } catch {
    return null;
  }
  const primary = worktrees.find(wt => !wt.bare)?.path || worktrees[0]?.path || '';
  const target = worktrees.find(wt => wt.branch === `refs/heads/${UPDATE_BRANCH}` && !wt.bare);

  if (target && samePath(target.path, root)) return null;

  const override = 'set CAREER_OPS_UPDATE_IN_WORKTREE=1 to update this worktree\'s branch instead';
  if (!target || target.prunable || !existsSync(target.path)) {
    return {
      branch,
      error: `This is a linked git worktree on branch '${branch}', and no checkout has '${UPDATE_BRANCH}' checked out, so there is no main checkout to update. Nothing was changed. Check out ${UPDATE_BRANCH} in your main checkout${primary ? ` (git -C "${primary}" checkout ${UPDATE_BRANCH})` : ''} and re-run, or ${override}.`,
    };
  }
  if (!existsSync(join(target.path, 'update-system.mjs'))) {
    return {
      branch,
      error: `This is a linked git worktree on branch '${branch}'. The checkout with '${UPDATE_BRANCH}' (${target.path}) has no update-system.mjs, so it cannot be updated from here. Nothing was changed. Run the update from that checkout, or ${override}.`,
    };
  }
  return { path: target.path, branch };
}

function redirectToMainCheckout(cmd, argv = process.argv, env = process.env) {
  if (!REDIRECTED_COMMANDS.has(cmd)) return null;
  if (env.CAREER_OPS_UPDATE_IN_WORKTREE === '1' || env.CAREER_OPS_UPDATE_REDIRECTED === '1') return null;
  if (gitToplevelMismatch()) return null;

  const target = worktreeUpdateTarget();
  if (!target) return null;
  if (target.error) {
    if (cmd === 'check') {
      console.log(JSON.stringify({ status: 'worktree-without-main', local: localVersion(), worktree_branch: target.branch }));
      return 0;
    }
    throw new Error(target.error);
  }

  if (cmd === 'apply' || cmd === 'rollback') {
    const dirty = gitIn(target.path, 'status', '--porcelain', '--untracked-files=no');
    if (dirty) {
      throw new Error(
        `The ${UPDATE_BRANCH} checkout at ${target.path} has uncommitted changes to tracked files. Nothing was changed. Commit or stash them there, then re-run ${cmd} from this worktree.`,
      );
    }
  }

  const chatty = cmd === 'apply' || cmd === 'rollback';
  if (chatty) {
    console.log(`This is a linked git worktree on branch '${target.branch}'. Running ${cmd} in the ${UPDATE_BRANCH} checkout at ${target.path} instead.`);
  }
  const res = spawnSync(process.execPath, ['update-system.mjs', ...argv.slice(2)], {
    cwd: target.path,
    stdio: 'inherit',
    env: { ...env, CAREER_OPS_UPDATE_REDIRECTED: '1' },
  });
  if (res.error) throw res.error;
  const status = res.status ?? 1;
  if (chatty && status === 0) {
    console.log(`To bring this worktree up to date: git merge ${UPDATE_BRANCH} (or git rebase ${UPDATE_BRANCH}) from inside it.`);
  }
  return status;
}

function missingFromTargetManifest(targetPaths) {
  const missing = [];
  for (const path of targetPaths) {
    const spec = path.endsWith('/') ? path.slice(0, -1) : path;

    if (path.endsWith('/')) {
      let treeFiles = [];
      try {
        treeFiles = gitQuiet('ls-tree', '-r', '--name-only', 'FETCH_HEAD', '--', spec)
          .split('\n').map(s => s.trim()).filter(Boolean);
      } catch {
        continue;
      }
      if (treeFiles.some(f => !existsSync(join(ROOT, f)))) missing.push(path);
      continue;
    }

    if (existsSync(join(ROOT, spec))) continue;
    try {
      gitQuiet('cat-file', '-e', `FETCH_HEAD:${spec}`);
      missing.push(path);
    } catch { }
  }
  return missing;
}

export function parsePorcelainStatus(status) {
  if (!status) return [];
  const fields = status.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    if (code[0] === 'R' || code[0] === 'C') {
      const origin = fields[++i];
      if (origin) entries.push({ code, path: origin });
    }
  }
  return entries;
}

export function gitStatusEntries(root = ROOT) {
  return parsePorcelainStatus(gitRawIn(root, 'status', '--porcelain', '-z', '--untracked-files=all'));
}

export function extractArrayFromSource(source, name) {
  source = source.replace(/(['"])(?:\\.|(?!\1)[\s\S])*\1|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (token) => (
    /^['"]/.test(token) ? token : token.replace(/[^\n]/g, ' ')
  ));
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) return [];
  return Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g), (entry) => entry[1]);
}

function mergePathLists(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    for (const path of list) {
      if (seen.has(path)) continue;
      seen.add(path);
      merged.push(path);
    }
  }
  return merged;
}

function normalizeRepoPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathMatchesManifest(file, entry) {
  const normalizedFile = normalizeRepoPath(file);
  const normalizedEntry = normalizeRepoPath(entry).replace(/\/$/, '');
  return normalizedFile === normalizedEntry || normalizedFile.startsWith(`${normalizedEntry}/`);
}

const GENERATED_CV_ARTIFACT_RE = /^templates\/cv-(?!template(?:[.-]|$))[^/]+\.html$/;
const GENERATED_COVER_ARTIFACT_RE = /^templates\/cover-(?!letter-template(?:[.-]|$))[^/]+\.html$/;

export function isGeneratedTemplateArtifact(file) {
  const normalized = normalizeRepoPath(file);
  return GENERATED_CV_ARTIFACT_RE.test(normalized) || GENERATED_COVER_ARTIFACT_RE.test(normalized);
}

const TEMPLATE_VARIANT_RE = /^templates\/(?:[^/]+\/)?(cv-template|cover-letter-template)\.([a-z0-9-]+)\.(html|tex)$/;
const TEMPLATE_VARIANT_KIND = { 'cv-template': 'cv', 'cover-letter-template': 'cover' };

export function isUserConfiguredTemplateVariant(file, configuredVariants = {}) {
  const match = normalizeRepoPath(file).match(TEMPLATE_VARIANT_RE);
  if (!match) return false;
  const kind = TEMPLATE_VARIANT_KIND[match[1]];
  const name = match[2];
  const configured = configuredVariants?.[kind];
  return Boolean(configured) && configured !== 'standard' && configured === name;
}

export function configuredTemplateVariantsFromProfileSource(source) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const configuredVariants = {};

  const parseScalar = (raw, label) => {
    let value = raw.trim();
    if (!value) return null;
    let quote = null;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (quote === '"' && char === '\\') {
        i++;
        continue;
      }
      if (char === quote) {
        if (quote === "'" && value[i + 1] === "'") {
          i++;
          continue;
        }
        quote = null;
        continue;
      }
      if (!quote && (char === '"' || char === "'")) {
        quote = char;
        continue;
      }
      if (!quote && char === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
        value = value.slice(0, i).trimEnd();
        break;
      }
    }
    if (quote) throw new Error(`Unterminated quoted value for ${label}`);
    if (!value) return null;
    if (value.startsWith('"')) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== 'string') throw new Error('not a string');
        return parsed;
      } catch (err) {
        throw new Error(`Unsupported quoted value for ${label}`, { cause: err });
      }
    }
    if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new Error(`Unterminated quoted value for ${label}`);
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (/^[\[\]{ }&*!|>@`]/.test(value)) {
      throw new Error(`Unsupported YAML value for ${label}`);
    }
    if (/^(?:null|~|true|false|yes|no|on|off|[-+]?\d+(?:\.\d+)?)$/i.test(value)) return null;
    return value;
  };

  for (const [section, kind] of [['cv', 'cv'], ['cover_letter', 'cover']]) {
    const header = new RegExp(`^${section}\\s*:(.*)$`);
    const starts = lines
      .map((line, index) => (header.test(line) ? index : -1))
      .filter((index) => index >= 0);
    if (starts.length > 1) throw new Error(`Duplicate top-level ${section} section`);
    if (starts.length === 0) continue;
    const start = starts[0];
    const headerTail = lines[start].match(header)[1].trim();
    if (headerTail && !headerTail.startsWith('#')) {
      throw new Error(`Unsupported inline YAML mapping for ${section}`);
    }
    const entries = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      if (/^\s*\t/.test(line)) throw new Error(`Unsupported tab indentation in ${section}`);
      const indent = line.match(/^ */)[0].length;
      if (indent === 0) break;
      const mapping = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (mapping) entries.push({ indent, key: mapping[1], value: mapping[2] });
    }
    if (entries.length === 0) continue;
    const childIndent = Math.min(...entries.map((entry) => entry.indent));
    const templateEntries = entries.filter(
      (entry) => entry.indent === childIndent && entry.key === 'template',
    );
    if (templateEntries.length > 1) throw new Error(`Duplicate ${section}.template value`);
    if (templateEntries.length === 0) continue;
    const configured = parseScalar(templateEntries[0].value, `${section}.template`);
    if (!configured) continue;
    const normalized = String(configured)
      .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (normalized && normalized !== 'standard') configuredVariants[kind] = normalized;
  }
  return configuredVariants;
}

export async function loadConfiguredTemplateVariants({ profilePath } = {}) {
  const configuredVariants = {};
  let templateModule;
  try {
    templateModule = await import('./cv-templates.mjs');
  } catch (err) {
    const expectedUrl = new URL('./cv-templates.mjs', import.meta.url).href;
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && err?.url === expectedUrl) {
      return configuredVariants;
    }
    if (err?.code === 'ERR_MODULE_NOT_FOUND'
        && /Cannot find package ['"]js-yaml['"]/.test(err?.message || '')) {
      if (!profilePath || !existsSync(profilePath)) return configuredVariants;
      return configuredTemplateVariantsFromProfileSource(readFileSync(profilePath, 'utf8'));
    }
    throw err;
  }
  const { loadProfileDefault, kebab } = templateModule;
  for (const kind of ['cv', 'cover']) {
    const options = profilePath ? { profilePath, strict: true } : { strict: true };
    const configured = loadProfileDefault(kind, options);
    const normalized = configured ? kebab(configured) : '';
    if (normalized && normalized !== 'standard') configuredVariants[kind] = normalized;
  }
  return configuredVariants;
}

export function configuredTemplateVariantPathsToPreserve(
  localFiles,
  remoteFiles,
  configuredVariants = {},
  localContents = {},
  remoteContents = {},
) {
  const remote = new Set([...remoteFiles].map(normalizeRepoPath));
  const normalizeContent = (content) => String(content).replace(/\r\n/g, '\n');
  return [...new Set(localFiles.map(normalizeRepoPath))]
    .filter((file) => isUserConfiguredTemplateVariant(file, configuredVariants))
    .filter((file) => remote.has(file))
    .filter((file) => Object.prototype.hasOwnProperty.call(localContents, file))
    .filter((file) => !Object.prototype.hasOwnProperty.call(remoteContents, file)
      || normalizeContent(localContents[file]) !== normalizeContent(remoteContents[file]))
    .sort();
}

export async function snapshotConfiguredTemplateVariants({
  dataRoot = ROOT,
  remoteFiles = [],
  readRemoteContent = () => null,
  readLocalContent = (path) => readFileSync(path, 'utf8'),
  localPathExists = existsSync,
} = {}) {
  const configuredVariants = await loadConfiguredTemplateVariants({
    profilePath: join(dataRoot, 'config', 'profile.yml'),
  });
  const configuredVariantPaths = [];
  for (const [kind, name] of Object.entries(configuredVariants)) {
    const prefix = kind === 'cv' ? 'cv-template' : 'cover-letter-template';
    for (const extension of ['html', 'tex']) {
      configuredVariantPaths.push(`templates/${prefix}.${name}.${extension}`);
    }
  }
  for (const file of remoteFiles) {
    const normalized = normalizeRepoPath(file);
    if (isUserConfiguredTemplateVariant(normalized, configuredVariants)) {
      configuredVariantPaths.push(normalized);
    }
  }
  const uniqueConfiguredVariantPaths = [...new Set(configuredVariantPaths)];
  const localContents = {};
  const remoteContents = {};
  const localFiles = uniqueConfiguredVariantPaths.filter((file) => {
    const localPath = join(dataRoot, ...file.split('/'));
    try {
      localContents[file] = readLocalContent(localPath);
      return true;
    } catch (err) {
      if (localPathExists(localPath)) {
        throw new Error(
          `Configured template variant is unreadable: ${file}. Refusing to update because checkout could overwrite it.`,
          { cause: err },
        );
      }
      return false;
    }
  });
  for (const file of localFiles) {
    if (!remoteFiles.includes(file)) continue;
    try {
      const content = readRemoteContent(file);
      if (content !== null && content !== undefined) remoteContents[file] = content;
    } catch {
    }
  }
  return {
    configuredVariants,
    localFiles,
    localContents,
    remoteContents,
    preservedPaths: configuredTemplateVariantPathsToPreserve(
      localFiles, remoteFiles, configuredVariants, localContents, remoteContents,
    ),
  };
}

export function staleSystemFiles(localFiles, remoteFiles, systemPaths, userPaths = USER_PATHS, configuredVariants = {}) {
  const remote = new Set([...remoteFiles].map(normalizeRepoPath));
  if (remote.size === 0) return [];
  return [...localFiles]
    .map(normalizeRepoPath)
    .filter((file) => !remote.has(file))
    .filter((file) => systemPaths.some((entry) => pathMatchesManifest(file, entry)))
    .filter((file) => !userPaths.some((entry) => pathMatchesManifest(file, entry)))
    .filter((file) => !isGeneratedTemplateArtifact(file))
    .filter((file) => !isUserConfiguredTemplateVariant(file, configuredVariants));
}

export function isReferencedByPreservedFile(
  candidatePath,
  preservedPaths,
  readFile = (path) => readFileSync(path, 'utf-8'),
  roots = [ROOT],
) {
  const basename = normalizeRepoPath(candidatePath).split('/').pop();
  if (!basename) return false;
  return preservedPaths.some((preservedPath) => {
    if (!/\.(html|css|tex)$/i.test(preservedPath)) return false;
    return roots.some((root) => {
      try {
        return readFile(join(root, ...preservedPath.split('/'))).includes(basename);
      } catch {
        return false;
      }
    });
  });
}

export function wasEverShippedUpstream(candidatePath, ref = 'FETCH_HEAD', revList = (...args) => gitQuiet(...args)) {
  const file = normalizeRepoPath(candidatePath);
  if (!file) return false;
  try {
    return revList('--literal-pathspecs', 'rev-list', '--max-count=1', ref, '--', file) !== '';
  } catch {
    return false;
  }
}

export const REEXEC_FALLBACK_FILES = [
  'update-system.mjs',
  'scaffolder/bin/skill-entrypoints.mjs',
  'cv-templates.mjs',
  'lib/is-main-module.mjs',
  'path-resolver.mjs',
];

export function relativeImportSpecifiers(source) {
  const specs = new Set();
  const fromRe = /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = fromRe.exec(source))) specs.add(match[1]);
  while ((match = bareRe.exec(source))) specs.add(match[1]);
  return [...specs].filter((spec) => spec.startsWith('.'));
}

function resolveReexecCheckout(ref, entry) {
  const visited = new Set();
  const present = new Set();
  const order = [];
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    let source;
    try {
      source = git('show', `${ref}:${file}`);
    } catch {
      continue;
    }
    present.add(file);
    order.push(file);
    const dir = pathPosix.dirname(file);
    for (const spec of relativeImportSpecifiers(source)) {
      stack.push(pathPosix.join(dir, spec));
    }
  }
  for (const file of REEXEC_FALLBACK_FILES) {
    if (present.has(file)) continue;
    try {
      git('show', `${ref}:${file}`);
      order.push(file);
      present.add(file);
    } catch {
    }
  }
  return order;
}

function repoPath(root, path) {
  return join(root, ...path.split('/'));
}

export function prepareMaterializedSkillEntrypointsForStage(paths, root = ROOT) {
  const prepared = [];
  for (const path of paths) {
    const entry = gitIn(root, 'ls-files', '-s', '--', path);
    if (!entry) continue;

    const mode = entry.split(/\s+/, 1)[0];
    if (mode === '120000') {
      gitIn(root, 'rm', '--cached', '-f', '--', path);
    }
    prepared.push(path);
  }
  return prepared;
}

export function systemTreeDiffers(systemPaths, upstreamRef = 'FETCH_HEAD', ctx = {}) {
  const runGit = ctx.git || git;
  if (!systemPaths || systemPaths.length === 0) return false;
  try {
    runGit('diff', '--quiet', '--ignore-cr-at-eol', upstreamRef, 'HEAD', '--', ...systemPaths);
    return false;
  } catch {
    return true;
  }
}

export function driftPathspecExcludingSkillEntrypoints(systemPaths, skillEntrypoints) {
  const excludes = (skillEntrypoints || []).map((entry) => `:(exclude)${entry.path}`);
  return [...systemPaths, ...excludes];
}

export function locallyModifiedSystemFiles(paths, upstreamRef = 'FETCH_HEAD', ctx = {}) {
  const runGit = ctx.git || git;
  if (!paths || paths.length === 0) return [];

  const diffNames = (ref) => {
    try {
      return runGit('diff', '--ignore-cr-at-eol', '--numstat', ref, '--', ...paths)
        .split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => l.split('\t')[2]).filter(Boolean);
    } catch {
      return [];
    }
  };

  let mergeBase = null;
  try {
    mergeBase = runGit('merge-base', 'HEAD', upstreamRef) || null;
  } catch {
    mergeBase = null;
  }
  let baseline = mergeBase;
  if (!baseline) {
    try {
      baseline = runGit('rev-list', '--max-parents=0', 'HEAD')
        .split('\n').map((l) => l.trim()).filter(Boolean)[0] || null;
    } catch {
      baseline = null;
    }
  }

  const differsFromUpstream = new Set(diffNames(upstreamRef));
  const changedLocally = new Set(diffNames(baseline || 'HEAD'));

  if (changedLocally.size > 0) {
    const localRange = baseline ? `${baseline}..HEAD` : 'HEAD';

    const deliveredBy = new Map();
    try {
      const log = runGit(
        'log', '--name-only', '--format=%x1e%H',
        '--grep=^chore: auto-update system files', localRange, '--', ...paths,
      );
      let commit = null;
      for (const raw of log.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('\x1e')) {
          commit = line.slice(1).trim() || null;
          continue;
        }
        if (commit && changedLocally.has(line) && !deliveredBy.has(line)) {
          deliveredBy.set(line, commit);
        }
      }
    } catch {
    }

    const byCommit = new Map();
    for (const [file, commit] of deliveredBy) {
      if (!byCommit.has(commit)) byCommit.set(commit, []);
      byCommit.get(commit).push(file);
    }
    for (const [commit, files] of byCommit) {
      try {
        const stat = runGit('diff', '--ignore-cr-at-eol', '--numstat', commit, '--', ...files);
        const stillDiffers = new Set(
          stat.split('\n').map((l) => l.trim()).filter(Boolean)
            .map((l) => l.split('\t')[2]).filter(Boolean),
        );
        for (const file of files) {
          if (!stillDiffers.has(file)) changedLocally.delete(file);
        }
      } catch {
      }
    }

    const undelivered = [...changedLocally].filter((file) => !deliveredBy.has(file));
    if (undelivered.length > 0) {
      const publishedRange = mergeBase ? `${mergeBase}..${upstreamRef}` : upstreamRef;
      const rawShas = (text) => {
        const map = new Map();
        for (const raw of text.split('\n')) {
          if (!raw.startsWith(':')) continue;
          const parts = raw.split('\t')[0].split(' ');
          const path = raw.slice(raw.indexOf('\t') + 1);
          const sha = parts[3];
          if (!path || !sha || /^0+$/.test(sha)) continue;
          if (!map.has(path)) map.set(path, new Set());
          map.get(path).add(sha);
        }
        return map;
      };
      let worktreeShas = null;
      let publishedShas = null;
      try {
        worktreeShas = rawShas(runGit('diff', '--raw', '--no-abbrev', '--no-renames', upstreamRef, '--', ...undelivered));
      } catch {
        worktreeShas = null;
      }
      try {
        publishedShas = rawShas(runGit(
          'log', '--raw', '--no-abbrev', '--no-renames', '--format=%x1e%H', publishedRange, '--', ...undelivered,
        ));
      } catch {
        publishedShas = null;
      }
      if (worktreeShas && publishedShas) {
        for (const file of undelivered) {
          const worktree = worktreeShas.get(file);
          const published = publishedShas.get(file);
          if (!worktree || !published) continue;
          for (const sha of worktree) {
            if (published.has(sha)) {
              changedLocally.delete(file);
              break;
            }
          }
        }
      }
    }
  }

  const atRisk = [...changedLocally].filter((file) => differsFromUpstream.has(file));

  let untracked = [];
  try {
    untracked = runGit('ls-files', '--others', '--exclude-standard', '--', ...paths)
      .split('\n').map((f) => f.trim()).filter(Boolean);
  } catch {
  }
  for (const file of untracked) {
    try {
      runGit('cat-file', '-e', `${upstreamRef}:${file}`);
      atRisk.push(file);
    } catch {
    }
  }

  const root = ctx.root || ROOT;
  return [...new Set(atRisk)]
    .filter((file) => existsSync(join(root, ...file.split('/'))))
    .filter((file) => !isGeneratedTemplateArtifact(file))
    .sort();
}

export function pathFullyPreserved(path, preservedPaths, preservedSet, ctx = {}) {
  if (preservedSet.size === 0) return false;
  const runGitQuiet = ctx.git || gitQuiet;
  const isDirectory = path.endsWith('/');
  const preservedHere = preservedPaths.filter((f) => (isDirectory ? f.startsWith(path) : f === path));
  if (preservedHere.length === 0) return false;
  if (!isDirectory) return true;
  let upstreamFiles = [];
  try {
    upstreamFiles = runGitQuiet('ls-tree', '-r', '--name-only', 'FETCH_HEAD', '--', path)
      .split('\n').map((f) => f.trim()).filter(Boolean);
  } catch {
    return 'unknown';
  }
  return upstreamFiles.length > 0 && upstreamFiles.every((f) => preservedSet.has(f));
}

const PATHSPEC_CANCELLED_RE = /did not match any file/i;

export function checkoutErrorIsBenign(err, { absentUpstream, preservedState }) {
  const text = `${(err && err.stderr) || ''}\n${(err && err.message) || ''}`;
  if (!PATHSPEC_CANCELLED_RE.test(text)) return false;
  return absentUpstream || preservedState === 'unknown';
}

export function probeAbsentUpstream(spec, ctx = {}) {
  const runGitQuiet = ctx.git || gitQuiet;
  try {
    return runGitQuiet('ls-tree', '--name-only', 'FETCH_HEAD', '--', spec).trim() === '';
  } catch {
    return false;
  }
}

export function backupSystemFiles(files, ctx = {}) {
  const root = ctx.root || ROOT;
  const copyFile = ctx.copyFile || copyFileSync;
  return files.map((file) => {
    const source = join(root, ...file.split('/'));
    const backup = `${source}.bak`;
    try {
      copyFile(source, backup);
      return { file, backup: `${file}.bak` };
    } catch (err) {
      return { file, backup: `${file}.bak`, error: err.message };
    }
  });
}

export function revertPaths(paths, protectedPaths = new Set(), ctx = {}) {
  const runGit = ctx.git || git;
  const root = ctx.root || ROOT;
  if (paths.length === 0) return;
  for (const p of paths) {
    try {
      runGit('checkout', 'HEAD', '--', p);
    } catch (err) {
      const pathspec = p.endsWith('/') ? p.slice(0, -1) : p;
      let existsInHead = true;
      try { runGit('cat-file', '-e', `HEAD:${pathspec}`); } catch { existsInHead = false; }
      if (existsInHead) throw err;
      try { runGit('rm', '-r', '-f', '--ignore-unmatch', '--', pathspec); } catch { }
      try { rmSync(join(root, pathspec), { recursive: true, force: true }); } catch { }
    }
    removeAdditionsNotInHead(p, protectedPaths, ctx);
  }
}

export function removeAdditionsNotInHead(pathspec, protectedPaths = new Set(), ctx = {}) {
  const runGit = ctx.git || git;
  const root = ctx.root || ROOT;
  const spec = pathspec.endsWith('/') ? pathspec.slice(0, -1) : pathspec;
  let added = '';
  try {
    added = runGit('diff', '--cached', '-z', '--name-only', '--diff-filter=A', 'HEAD', '--', spec);
  } catch {
    return;
  }
  for (const file of added.split('\0').filter(Boolean)) {
    if (protectedPaths.has(file)) continue;
    let removed = false;
    try {
      runGit('rm', '-f', '--ignore-unmatch', '--', file);
      removed = true;
    } catch {
      console.error(`Rollback: could not unstage ${file}; leaving it untouched.`);
    }
    if (removed) {
      try { rmSync(join(root, file), { force: true }); } catch { }
    }
  }
}

export function isTracked(path, ctx = {}) {
  const runGit = ctx.git || git;
  return runGit('--literal-pathspecs', 'ls-files', '--', path).trim().length > 0;
}

export function expandToShippedFiles(paths, ref = 'FETCH_HEAD', ctx = {}) {
  const runGit = ctx.git || git;
  const seen = new Set();
  const files = [];
  const take = (p) => { if (p && !seen.has(p)) { seen.add(p); files.push(p); } };

  for (const path of paths) {
    if (!path.endsWith('/')) { take(path); continue; }
    const listed = runGit('--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', ref, '--', path);
    for (const file of listed.split('\0')) take(file);
  }
  return files;
}

const ADD_ARGV_BUDGET = 8000;

export function addPaths(paths, ctx = {}) {
  if (paths.length === 0) return;
  rejectDirectories(paths, ctx.root || ROOT);
  const runGit = ctx.git || git;
  let batch = [];
  let budget = 0;
  const flush = () => {
    if (batch.length === 0) return;
    runGit('--literal-pathspecs', 'add', '-f', '--', ...batch);
    batch = [];
    budget = 0;
  };
  for (const path of paths) {
    if (batch.length > 0 && budget + path.length + 1 > ADD_ARGV_BUDGET) flush();
    batch.push(path);
    budget += path.length + 1;
  }
  flush();
}

function rejectDirectories(paths, root) {
  const dirs = paths.filter(p => {
    if (p.endsWith('/')) return true;
    try {
      return lstatSync(join(root, p)).isDirectory();
    } catch {
      return false;
    }
  });
  if (dirs.length > 0) {
    throw new Error(
      `addPaths received directory pathspec(s), which -f would sweep ignored files from: ` +
      `${dirs.join(', ')}. Resolve them with expandToShippedFiles() first.`
    );
  }
}

const EXCLUDE_PATHSPEC_PREFIX = ':(exclude)';

export function stagingFileList(pathsToStage, preserved = [], ref = 'FETCH_HEAD', ctx = {}) {
  const preservedSet = preserved instanceof Set ? preserved : new Set(preserved);
  const positives = pathsToStage.filter((spec) => !spec.startsWith(EXCLUDE_PATHSPEC_PREFIX));
  return expandToShippedFiles(positives, ref, ctx).filter((path) => !preservedSet.has(path));
}

export function stagedPathsOutside(owned, preserved = [], run = (...args) => gitRawIn(ROOT, ...args)) {
  const staged = run('diff', '--cached', '--name-only', '-z');
  if (!staged) return [];

  const files = new Set();
  const dirs = [];
  for (const entry of owned) {
    if (entry.endsWith('/')) dirs.push(entry);
    else files.add(entry);
  }
  const preservedFiles = new Set(preserved);

  return staged.split('\0')
    .filter(path => path !== '')
    .filter(path => preservedFiles.has(path)
      || (!files.has(path) && !dirs.some(dir => path.startsWith(dir))));
}

function dashboardGoSourcesChanged() {
  try {
    const changed = git('diff', '--name-only', 'HEAD', '--', 'dashboard');
    return changed
      .split('\n')
      .some(path => path.startsWith('dashboard/') && path.endsWith('.go'));
  } catch {
    return false;
  }
}

function rebuildDashboardBinaryIfNeeded() {
  if (!dashboardGoSourcesChanged()) return;

  try {
    execFileSync('go', ['build', '-o', 'career-dashboard', '.'], {
      cwd: join(ROOT, 'dashboard'),
      timeout: DASHBOARD_REBUILD_TIMEOUT_MS,
      stdio: 'pipe',
    });
    console.log('dashboard binary rebuilt');
  } catch {
    console.log('dashboard binary rebuild skipped -- run: cd dashboard && go build -o career-dashboard . manually');
  }
}

function curlGet(url, extraArgs = []) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['--silent', '--fail', '--max-time', '10', ...extraArgs, url],
      { encoding: 'utf-8', timeout: 12000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      }
    );
  });
}

function resolveChannel(argv, env) {
  const idx = argv.indexOf('--channel');
  const requested = idx !== -1 ? argv[idx + 1] : env.CAREER_OPS_UPDATE_CHANNEL;
  if (requested === undefined || requested === 'release') return 'release';
  if (requested === 'main') return 'main';
  throw new Error(`Unknown --channel '${requested}'. Supported channels: release (default), main.`);
}

const RELEASE_TAG_PREFIX = 'career-ops-v';

export const RELEASE_TAG_RE = new RegExp(`^${RELEASE_TAG_PREFIX}(\\d+\\.\\d+\\.\\d+)$`);

export function releaseTagVersion(tagName) {
  const match = String(tagName || '').trim().match(RELEASE_TAG_RE);
  return match ? match[1] : '';
}

export function newerThanTarget(local, targetRef) {
  const target = releaseTagVersion(targetRef);
  return target && compareVersions(local, target) > 0 ? target : '';
}

export async function resolveTargetRef(argv, env, ctx = {}) {
  const runCurlGet = ctx.curlGet || curlGet;
  if (resolveChannel(argv, env) === 'main') {
    return 'main';
  }

  const releaseRaw = await runCurlGet(RELEASES_API, [
    '--header', 'Accept: application/vnd.github.v3+json',
    '--header', 'User-Agent: career-ops-update-checker',
  ]);
  if (releaseRaw === null) {
    throw new Error(
      `Could not reach ${RELEASES_API} to resolve the latest career-ops release. ` +
      'Retry, or run with --channel main to update from the latest commit on main instead.',
    );
  }

  let tagName = '';
  try {
    tagName = String(JSON.parse(releaseRaw)?.tag_name || '').trim();
  } catch {
  }
  if (!tagName) {
    throw new Error(
      `GitHub returned no usable release tag from ${RELEASES_API}. ` +
      'Retry, or run with --channel main to update from the latest commit on main instead.',
    );
  }
  if (!releaseTagVersion(tagName)) {
    throw new Error(
      `${RELEASES_API} returned '${tagName}', which is not a valid ${RELEASE_TAG_PREFIX}X.Y.Z release tag — ` +
      `likely the sibling 'web' component's release surfacing instead of career-ops's, or a malformed tag. ` +
      'Retry, or run with --channel main to update from the latest commit on main instead.',
    );
  }
  return tagName;
}

const DISMISS_FILE = '.update-dismissed';

export function parseDismissMarker(text) {
  if (text === null || text === undefined) return null;
  const raw = String(text).trim();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { }
  if (parsed && typeof parsed === 'object') {
    const version = typeof parsed.version === 'string' && /^\d+\.\d+\.\d+$/.test(parsed.version) ? parsed.version : '';
    const at = typeof parsed.at === 'string' && !Number.isNaN(Date.parse(parsed.at)) ? parsed.at : '';
    return { version, at };
  }
  return { version: '', at: Number.isNaN(Date.parse(raw)) ? '' : raw };
}

export function dismissalCovers(marker, remote, publishedAt) {
  if (!marker) return false;
  if (marker.version) return compareVersions(remote, marker.version) <= 0;
  const at = Date.parse(marker.at || '');
  const published = Date.parse(publishedAt || '');
  if (Number.isNaN(at) || Number.isNaN(published)) return true;
  return published <= at;
}

function readDismissMarker() {
  const path = join(ROOT, DISMISS_FILE);
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

async function latestRelease(runCurlGet) {
  const releaseRaw = await runCurlGet(RELEASES_API, [
    '--header', 'Accept: application/vnd.github.v3+json',
    '--header', 'User-Agent: career-ops-update-checker',
  ]);
  if (releaseRaw === null) return { status: 'offline' };
  let release = null;
  try { release = JSON.parse(releaseRaw); } catch { }
  const tagName = String(release?.tag_name || '').trim();
  const version = releaseTagVersion(tagName);
  if (!version) return { status: 'no-remote-version', ...(tagName ? { tag: tagName } : {}) };
  return { status: 'ok', tagName, version, publishedAt: String(release.published_at || ''), changelog: String(release.body || '') };
}

export async function checkStatus(argv, env, ctx = {}) {
  const runCurlGet = ctx.curlGet || curlGet;
  const local = (ctx.localVersion || localVersion)();
  const localSha = (ctx.localShortSha || localShortSha)();
  const marker = argv.includes('--force') ? null : parseDismissMarker((ctx.readMarker || readDismissMarker)());
  if (resolveChannel(argv, env) === 'main') return checkMainChannel(local, marker, runCurlGet, localSha);

  const latest = await latestRelease(runCurlGet);
  if (latest.status !== 'ok') return { status: latest.status, local, ...(localSha ? { local_sha: localSha } : {}), ...(latest.tag ? { tag: latest.tag } : {}) };
  const remote = latest.version;
  if (compareVersions(local, remote) >= 0) return { status: 'up-to-date', local, remote, ...(localSha ? { local_sha: localSha } : {}) };
  if (dismissalCovers(marker, remote, latest.publishedAt)) return { status: 'dismissed', local, remote, ...(localSha ? { local_sha: localSha } : {}) };
  return { status: 'update-available', local, remote, ...(localSha ? { local_sha: localSha } : {}), reason: 'version-changed', changelog: latest.changelog.slice(0, 500) };
}

async function checkMainChannel(local, marker, runCurlGet, localSha) {
  let remote = '';
  let releaseVersion = '';
  let changelog = '';
  let localCommit = '';
  let remoteCommit = '';

  const [rawVersion, releaseRaw] = await Promise.all([
    runCurlGet(RAW_VERSION_URL),
    runCurlGet(RELEASES_API, [
      '--header', 'Accept: application/vnd.github.v3+json',
      '--header', 'User-Agent: career-ops-update-checker',
    ]),
  ]);

  try { localCommit = gitQuiet('rev-parse', 'HEAD'); } catch { }
  const remoteRef = await runCurlGet('https://api.github.com/repos/career-ops-hq/career-ops/git/ref/heads/main', [
    '--header', 'Accept: application/vnd.github+json',
    '--header', 'User-Agent: career-ops-update-checker',
  ]);
  if (remoteRef !== null) {
    try { remoteCommit = String(JSON.parse(remoteRef)?.object?.sha || '').trim(); } catch { }
  }

  if (rawVersion !== null) {
    try {
      const raw = parseVersionFile(rawVersion);
      const match = raw.match(SEMVER_RE);
      remote = match ? match[1] : '';
    } catch {
    }
  }

  if (releaseRaw !== null) {
    try {
      const release = JSON.parse(releaseRaw);
      changelog = release.body || '';
      const rawTag = String(release.tag_name || '').trim();
      const match = rawTag.match(SEMVER_RE);
      releaseVersion = match ? match[1] : '';
    } catch {
    }
  }

  if (!remote && !releaseVersion) {
    const bothNetworkFailed = rawVersion === null && releaseRaw === null;
    return { status: bothNetworkFailed ? 'offline' : 'no-remote-version', local, ...(localSha ? { local_sha: localSha } : {}) };
  }

  if (!remote) {
    remote = releaseVersion;
  } else if (releaseVersion && compareVersions(releaseVersion, remote) > 0) {
    remote = releaseVersion;
  }

  let systemTreeDrift = false;
  if (localCommit && remoteCommit && localCommit !== remoteCommit) {
    try {
      gitQuiet('fetch', '--quiet', CANONICAL_REPO, 'main');
      const { SKILL_ENTRYPOINTS } = await import('./scaffolder/bin/skill-entrypoints.mjs');
      systemTreeDrift = systemTreeDiffers(
        driftPathspecExcludingSkillEntrypoints(SYSTEM_PATHS, SKILL_ENTRYPOINTS),
        'FETCH_HEAD',
      );
    } catch {
      systemTreeDrift = true;
    }
  }

  if (compareVersions(local, remote) >= 0 && !systemTreeDrift) {
    return { status: 'up-to-date', local, remote, local_commit: localCommit || undefined, ...(localSha ? { local_sha: localSha } : {}), remote_commit: remoteCommit || undefined };
  }

  if (dismissalCovers(marker, remote, '')) return { status: 'dismissed', local, remote, ...(localSha ? { local_sha: localSha } : {}) };

  return {
    status: 'update-available',
    local,
    remote,
    reason: systemTreeDrift ? 'system-files-changed' : 'version-changed',
    local_commit: localCommit || undefined,
    ...(localSha ? { local_sha: localSha } : {}),
    remote_commit: remoteCommit || undefined,
    changelog: changelog.slice(0, 500),
  };
}

async function check() {
  const foreignToplevel = gitToplevelMismatch();
  if (foreignToplevel) {
    console.log(JSON.stringify({ status: 'not-a-git-toplevel', local: localVersion(), toplevel: foreignToplevel }));
    return;
  }

  console.log(JSON.stringify(await checkStatus(process.argv, process.env)));
}

const GITIGNORE_BLOCK_HEADER = [
  '# Added by career-ops update-system.mjs.',
  '# System-owned ignore rules that were missing from this file. Your own rules',
  '# are never modified, reordered or removed: the updater only appends patterns',
  '# it cannot already find somewhere in this file. Reordering these lines, or',
  '# moving them elsewhere in the file, is safe and will not bring them back.',
  '# Deleting or commenting one out is not: they are system-owned, several of',
  '# them guard files holding personal data, and the next update re-adds any',
  '# that is no longer present as a live pattern.',
];

function gitShowRaw(spec) {
  const args = ['show', spec];
  const timeout = gitTimeoutMs(args);
  try {
    return execFileSync('git', args, {
      cwd: ROOT, encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (isTimeoutLikeError(err)) {
      throw new Error(`${describeGitCommand(args)} timed out after ${timeoutSeconds(timeout)}s. If your network is slow, retry or set ${gitTimeoutEnvVar(args)} to a larger value.`);
    }
    throw err;
  }
}

async function writeGitignoreAtomic(filePath, content) {
  const { renameSyncWithRetry } = await import('./tracker-utils.mjs');
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, content);
    renameSyncWithRetry(tmpPath, filePath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { }
    throw err;
  }
}

export function reconcileGitignore(localText, upstreamText) {
  const localLines = new Set(localText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== ''));
  const seen = new Set(localLines);

  const upstreamLines = upstreamText.split(/\r?\n/);
  const block = [];
  const added = [];
  let pendingComments = [];
  for (const raw of upstreamLines) {
    const line = raw.trim();
    if (line === '') { pendingComments = []; continue; }
    if (line.startsWith('#')) { pendingComments.push([raw, line]); continue; }
    if (seen.has(line)) {
      pendingComments = [];
      if (added.length > 0 && line.startsWith('!') && localLines.has(line)) block.push(raw);
      continue;
    }
    for (const [rawComment, comment] of pendingComments) {
      if (!seen.has(comment)) { block.push(rawComment); seen.add(comment); }
    }
    pendingComments = [];
    block.push(raw);
    added.push(line);
    seen.add(line);
  }

  if (added.length === 0) return { text: localText, added };

  const crlfCount = (localText.match(/\r\n/g) || []).length;
  const lfCount = (localText.match(/\n/g) || []).length - crlfCount;
  const eol = crlfCount > lfCount ? '\r\n' : '\n';
  const body = [...GITIGNORE_BLOCK_HEADER, ...block].join(eol);
  const separator = localText === ''
    ? ''
    : (/\r?\n$/.test(localText) ? eol : `${eol}${eol}`);
  return { text: `${localText}${separator}${body}${eol}`, added };
}

export function trustsEnvTargetRef(authenticatedReexec, legacyReexec) {
  return authenticatedReexec || legacyReexec;
}

async function apply() {
  assertOwnGitToplevel();
  const local = localVersion();
  const authenticatedReexec = consumeReexecMarker();
  const legacyReexec = isLegacyReexec();
  const isReexec = authenticatedReexec || legacyReexec ||
    (process.argv.includes('--confirm') && process.env.CAREER_OPS_UPDATE_REEXEC === '1');
  const updateForce = process.argv.includes('--force') ||
    (isReexec && process.env.CAREER_OPS_UPDATE_FORCE === '1');
  const updateConfirmed = process.argv.includes('--confirm') ||
    (isReexec && (process.env.CAREER_OPS_UPDATE_CONFIRM === '1' || legacyReexec));
  const initialStatusPaths = new Set(gitStatusEntries().map(entry => entry.path));
  const generatedBackupPaths = new Set();

  if (!updateConfirmed) {
    throw new Error(
      `Installation requires explicit confirmation. Re-run with ` +
      `\`node update-system.mjs apply${updateForce ? ' --force' : ''} --confirm\`. ` +
      'A scheduled update check never installs files.',
    );
  }

  const targetRef = trustsEnvTargetRef(authenticatedReexec, legacyReexec)
    ? (process.env.CAREER_OPS_UPDATE_TARGET_REF || 'main')
    : await resolveTargetRef(process.argv, process.env);

  const olderTarget = newerThanTarget(local, targetRef);
  if (olderTarget) {
    console.log(`Installed v${local} is newer than the latest release v${olderTarget}. Nothing to install.`);
    console.log('To follow every merge on main instead: node update-system.mjs apply --channel main --confirm');
    return;
  }

  const lockFile = join(ROOT, '.update-lock');
  if (existsSync(lockFile) && !isReexec) {
    console.error('Update already in progress (.update-lock exists). If stuck, delete it manually.');
    process.exit(1);
  }

  if (!isReexec) {
    writeFileSync(lockFile, new Date().toISOString());
  }

  try {
    const backupBranch = process.env.CAREER_OPS_UPDATE_BACKUP_BRANCH || updateBackupBranchName(local);
    if (!isReexec) {
      try {
        const wip = git('stash', 'create');
        if (wip) {
          git('update-ref', `refs/backup-pre-update-wip/${local}`, wip);
          console.log(`WIP stash ref saved: refs/backup-pre-update-wip/${local} (recover with: git stash apply refs/backup-pre-update-wip/${local})`);
        }
      } catch {
      }
      git('branch', backupBranch);
      console.log(`Backup branch created: ${backupBranch}`);
    }

    console.log(`Fetching ${targetRef} from upstream...`);
    git('fetch', CANONICAL_REPO, targetRef);

    if (!isReexec) {
      const timeout = reexecTimeoutMs();
      try {
        const reexecFiles = resolveReexecCheckout('FETCH_HEAD', 'update-system.mjs');
        const bootstrapAtRisk = locallyModifiedSystemFiles(reexecFiles, 'FETCH_HEAD');
        if (bootstrapAtRisk.length > 0) {
          console.log('');
          console.log(`${bootstrapAtRisk.length} self-bootstrap file(s) differ from upstream because THIS install changed them:`);
          for (const result of backupSystemFiles(bootstrapAtRisk)) {
            if (result.error) {
              console.log(`  ${result.file}  (could not write ${result.backup}: ${result.error})`);
            } else {
              console.log(`  ${result.file}  (local copy saved: ${result.backup})`);
            }
          }
          console.log('Self-bootstrap must load the upstream versions; the local versions remain in the backups above.');
          console.log('');
        }
        git('checkout', 'FETCH_HEAD', '--', ...reexecFiles);
        const marker = createReexecMarker();
        execFileSync(process.execPath, [
          'update-system.mjs',
          'apply',
          '--confirm',
          ...(updateForce ? ['--force'] : []),
        ], {
          cwd: ROOT,
          stdio: 'inherit',
          timeout,
          env: {
            ...process.env,
            CAREER_OPS_UPDATE_REEXEC_MARKER: marker.path,
            CAREER_OPS_UPDATE_REEXEC_TOKEN: marker.token,
            CAREER_OPS_UPDATE_REEXEC: '1',
            CAREER_OPS_UPDATE_BACKUP_BRANCH: backupBranch,
            CAREER_OPS_UPDATE_TARGET_REF: targetRef,
            ...(updateForce ? { CAREER_OPS_UPDATE_FORCE: '1' } : {}),
            CAREER_OPS_UPDATE_CONFIRM: '1',
          },
        });
        return;
      } catch (err) {
        if (isTimeoutLikeError(err)) {
          console.error(`Updater self-reexec timed out after ${timeoutSeconds(timeout)}s.`);
          throw err;
        }
        console.error(`Updater self-reexec failed: ${err.message}`);
        throw err;
      }
    }

    console.log('Updating system files...');
    const updated = [];
    let remoteSystemPaths = [];
    try {
      const remoteUpdaterSource = git('show', 'FETCH_HEAD:update-system.mjs');
      remoteSystemPaths = extractArrayFromSource(remoteUpdaterSource, 'SYSTEM_PATHS');
    } catch {
    }

    const { kept: updatePaths, refused } = rejectUserLayerPaths(
      mergePathLists(SYSTEM_PATHS, remoteSystemPaths, BOOTSTRAP_PATHS),
      effectiveUserPaths(),
      manifestProbes({
        trackedOutput: git('ls-files', '-z'),
        upstreamOutput: git('ls-tree', '-r', '--name-only', '-z', 'FETCH_HEAD'),
      }),
    );
    const refusedSet = new Set(refused);
    if (refused.length > 0) {
      console.log('');
      console.log(`Refused ${refused.length} manifest entry(ies) naming the user layer:`);
      for (const path of refused) console.log(`  ${path}`);
      console.log('Your files were NOT touched. Please report this — it is a manifest error.');
      console.log('');
    }

    const preservedPaths = [];
    const atRisk = locallyModifiedSystemFiles(updatePaths, 'FETCH_HEAD');
    if (atRisk.length > 0) {
      console.log('');
      console.log(`${atRisk.length} system file(s) differ from upstream because THIS install changed them:`);
      for (const result of backupSystemFiles(atRisk)) {
        if (result.error) {
          console.log(`  ${result.file}  (could not write ${result.backup}: ${result.error})`);
        } else {
          generatedBackupPaths.add(result.backup);
          console.log(`  ${result.file}  (local copy saved: ${result.backup})`);
        }
      }
      if (updateForce) {
        console.log('--force: overwriting them with the upstream version.');
      } else {
        preservedPaths.push(...atRisk);
        console.log('Keeping your versions. They will NOT receive upstream changes.');
        console.log('Re-run with `node update-system.mjs apply --force --confirm` to take the upstream version instead.');
      }
      console.log('');
    }
    let dataRoot = ROOT;
    try {
      const { getCareerOpsRoot } = await import('./path-resolver.mjs');
      dataRoot = getCareerOpsRoot();
    } catch {
    }
    let configuredVariantRemoteFiles = [];
    try {
      configuredVariantRemoteFiles = git('ls-tree', '-r', '--name-only', 'FETCH_HEAD', '--', 'templates')
        .split('\n').map((file) => file.trim()).filter(Boolean);
    } catch {
    }
    const configuredSnapshot = await snapshotConfiguredTemplateVariants({
      dataRoot,
      remoteFiles: configuredVariantRemoteFiles,
      readRemoteContent: (file) => gitShowRaw(`FETCH_HEAD:${file}`),
    });
    const { configuredVariants } = configuredSnapshot;
    const configuredReferencePaths = configuredSnapshot.localFiles;
    const configuredAtRisk = configuredSnapshot.preservedPaths;
    if (configuredAtRisk.length > 0) {
      preservedPaths.push(...configuredAtRisk.filter((file) => !preservedPaths.includes(file)));
      console.log(`Keeping configured template variant(s) with local content: ${configuredAtRisk.join(', ')}`);
    }
    const preserveSpecs = preservedPaths.map((file) => `${EXCLUDE_PATHSPEC_PREFIX}${file}`);

    const preservedSet = new Set(preservedPaths);

    const skippedPaths = [];
    for (const path of updatePaths) {
      const preservedState = pathFullyPreserved(path, preservedPaths, preservedSet);
      if (preservedState === true) continue;
      try {
        gitQuiet('checkout', 'FETCH_HEAD', '--', path, ...preserveSpecs);
        updated.push(path);
      } catch (err) {
        const spec = path.endsWith('/') ? path.slice(0, -1) : path;
        const absentUpstream = probeAbsentUpstream(spec);
        if (!checkoutErrorIsBenign(err, { absentUpstream, preservedState })) throw err;
        skippedPaths.push(path);
      }
    }
    if (skippedPaths.length > 0) {
      console.log(`Skipped ${skippedPaths.length} path(s) absent upstream: ${skippedPaths.join(', ')}`);
    }

    try {
      let remoteFiles = new Set();
      try {
        remoteFiles = new Set(
          git('ls-tree', '-r', '--name-only', 'FETCH_HEAD')
            .split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/'))
        );
      } catch {
      }
      if (remoteFiles.size > 0) {
        const localFiles = git('ls-files').split('\n').filter(Boolean);
        const preservedReferencePaths = mergePathLists(preservedPaths, configuredReferencePaths);
        const preservedReferenceRoots = [...new Set([ROOT, dataRoot])];
        const staleCandidates = staleSystemFiles(
          localFiles, remoteFiles, SYSTEM_PATHS, mergePathLists(USER_PATHS, preservedPaths), configuredVariants,
        );
        for (const f of staleCandidates) {
          if (isReferencedByPreservedFile(
            f, preservedReferencePaths, undefined, preservedReferenceRoots,
          )) {
            console.log(`Kept stale asset still referenced by a preserved file: ${f}`);
            continue;
          }
          if (!wasEverShippedUpstream(f, 'FETCH_HEAD')) {
            console.log(`Kept local file upstream has never shipped: ${f}`);
            continue;
          }
          try {
            unlinkSync(join(ROOT, f));
            updated.push(f);
            console.log(`Pruned stale system file: ${f}`);
          } catch (err) {
            console.error(`Failed to prune stale system file ${f}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.error(`Stale system-file prune step failed: ${err.message}`);
    }

    try {
      const gitignorePath = join(ROOT, '.gitignore');
      const upstreamGitignore = gitShowRaw('FETCH_HEAD:.gitignore');
      const gitignoreWasDirty = initialStatusPaths.has('.gitignore');
      const trackGitignore = () => {
        if (!gitignoreWasDirty) {
          updated.push('.gitignore');
          return;
        }
        console.log('.gitignore had uncommitted local changes. The new rules are applied but left');
        console.log('  unstaged, so they land in your own commit rather than in this update.');
      };
      if (!existsSync(gitignorePath)) {
        const seed = upstreamGitignore.endsWith('\n') ? upstreamGitignore : `${upstreamGitignore}\n`;
        await writeGitignoreAtomic(gitignorePath, seed);
        trackGitignore();
        console.log('Restored .gitignore (it was missing).');
      } else {
        const { text, added } = reconcileGitignore(readFileSync(gitignorePath, 'utf-8'), upstreamGitignore);
        if (added.length > 0) {
          await writeGitignoreAtomic(gitignorePath, text);
          trackGitignore();
          console.log(`.gitignore: appended ${added.length} missing rule(s): ${added.join(', ')}`);
        }
      }
    } catch (err) {
      console.error(`Could not reconcile .gitignore: ${err.message}`);
      console.error('Your own rules were left untouched. Compare manually with: git diff FETCH_HEAD -- .gitignore');
    }

    const { ensureSkillEntrypoints } = await import('./scaffolder/bin/skill-entrypoints.mjs');
    const materializedSkillEntrypoints = ensureSkillEntrypoints(ROOT);
    if (materializedSkillEntrypoints.length > 0) {
      for (const path of materializedSkillEntrypoints) {
        if (!updated.includes(path)) updated.push(path);
      }
      console.log(`Materialized ${materializedSkillEntrypoints.length} skill entrypoint(s) for filesystems without symlink support`);
    }

    const violatedUserPaths = new Set();
    try {
      const changed = gitStatusEntries()
        .map((entry) => entry.path)
        .filter((file) => !initialStatusPaths.has(file) && !generatedBackupPaths.has(file));
      for (const file of userLayerViolations(changed, updatePaths, effectiveUserPaths())) {
        console.error(`SAFETY VIOLATION: User file was modified: ${file}`);
        violatedUserPaths.add(file);
      }
    } catch (err) {
      console.error(`Aborting: could not validate user-layer safety (${err.message}).`);
      try {
        revertPaths(updated, initialStatusPaths);
      } catch (revertErr) {
        throw new Error(
          `Validation failed (${err.message}) and revert also failed (${revertErr.message})`,
          { cause: err },
        );
      }
      throw err;
    }

    if (violatedUserPaths.size > 0) {
      console.error('Aborting: user files were touched. Rolling back system files...');
      const violation = new Error('Update aborted: user files were touched.');
      try {
        revertPaths([...updated], initialStatusPaths);
      } catch (revertErr) {
        throw new Error(
          `Safety violation (${violation.message}) and revert also failed (${revertErr.message})`,
          { cause: violation },
        );
      }
      console.error(`User file(s) left as-is (your content was NOT overwritten):`);
      for (const f of violatedUserPaths) console.error(`  ${f}`);
      throw violation;
    }

    try {
      execSync('npm install --silent', { cwd: ROOT, timeout: NPM_INSTALL_TIMEOUT_MS });
    } catch {
      console.log('npm install skipped (may need manual run)');
    }

    try {
      execSync('npx playwright install chromium', { cwd: ROOT, timeout: PLAYWRIGHT_INSTALL_TIMEOUT_MS, stdio: 'ignore' });
    } catch {
      console.log('playwright install skipped (run manually: npx playwright install chromium)');
    }

    rebuildDashboardBinaryIfNeeded();

    const remote = localVersion();
    const pathsToStage = [...updated, ...preserveSpecs];
    const dismissFile = join(ROOT, '.update-dismissed');
    if (existsSync(dismissFile)) {
      const dismissMarkerTracked = isTracked('.update-dismissed');
      unlinkSync(dismissFile);
      if (dismissMarkerTracked) pathsToStage.push('.update-dismissed');
    }

    let usedIndexCommit = false;

    const expandedPathsToStage = stagingFileList(pathsToStage, preservedSet);

    try {
      prepareMaterializedSkillEntrypointsForStage(materializedSkillEntrypoints);
      addPaths(expandedPathsToStage);
      const ownedPaths = pathsToStage.filter((spec) => !spec.startsWith(EXCLUDE_PATHSPEC_PREFIX));
      const unrelated = stagedPathsOutside(
        [...ownedPaths, ...materializedSkillEntrypoints],
        preservedPaths,
      );
      usedIndexCommit = unrelated.length === 0;
      if (usedIndexCommit) {
        git('commit', '-m', `chore: auto-update system files to v${remote}`);
      } else {
        git('commit', '-m', `chore: auto-update system files to v${remote}`, '--', ...expandedPathsToStage);
      }
    } catch (e) {
      let commitFailed = false;
      try {
        const entries = gitStatusEntries();
        const changedPaths = new Set(entries.map(entry => entry.path));
        const allTargetPaths = [
          ...expandedPathsToStage.filter((spec) => !spec.startsWith(EXCLUDE_PATHSPEC_PREFIX)),
          ...materializedSkillEntrypoints,
        ];
        commitFailed = allTargetPaths.some(p => changedPaths.has(p));
      } catch (err) {
        commitFailed = true;
      }

      if (commitFailed) {
        const pathspec = expandedPathsToStage.map(p => `'${p.replace(/'/g, "'\\''")}'`).join(' ');
        const recovery = usedIndexCommit
          ? `git commit -m "chore: auto-update system files to v${remote}"`
          : `git commit -m "chore: auto-update system files to v${remote}" -- ${pathspec}`;
        throw new Error(
          `Update commit failed (files may be staged but not committed).\n` +
          `    Error: ${e.message.split('\n')[0]}\n` +
          `    Please run manually to finish the update:\n` +
          `    ${recovery}`
        );
      }
    }

    const unmaterialized = missingFromTargetManifest(
      remoteSystemPaths.filter((path) => !refusedSet.has(path)),
    );
    if (unmaterialized.length > 0) {
      console.error(`\nUpdate incomplete: v${local} → v${remote}`);
      console.error(`${unmaterialized.length} path(s) from the target manifest were not checked out:`);
      for (const path of unmaterialized) console.error(`  ${path}`);
      console.error('\nThis happens when the installed updater predates the paths the target adds.');
      console.error('Run `node update-system.mjs apply --confirm` again — the updater itself is now current,');
      console.error('so the second pass uses the target manifest and picks up what this one missed.');
      process.exit(1);
    }

    console.log(`\nUpdate complete: v${local} → v${remote}`);
    console.log(`Updated ${updated.length} system paths.`);
    console.log(`Rollback available: node update-system.mjs rollback`);

    console.log('\n-- The CareerOps Manifesto ------------------------------');
    console.log('A new way of job searching is taking shape. You are');
    console.log('already practicing it. Read it, sign it if you want to help:');
    console.log('    npm run manifesto  ·  https://career-ops.org/manifesto?utm_source=updater');

  } finally {
    if (!isReexec && existsSync(lockFile)) unlinkSync(lockFile);
  }
}

function rollback() {
  assertOwnGitToplevel();
  try {
    const branches = git('for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/backup-pre-update-*');
    const latest = newestBackupBranch(branches);

    if (!latest) {
      console.error('No backup branches found. Nothing to rollback.');
      process.exit(1);
    }

    console.log(`Rolling back to: ${latest}`);

    const restored = [];
    const removed = [];
    for (const path of SYSTEM_PATHS) {
      try {
        git('checkout', latest, '--', path);
        restored.push(path);
      } catch (err) {
        const pathspec = path.endsWith('/') ? path.slice(0, -1) : path;
        let existedInBackup = true;
        try {
          git('cat-file', '-e', `${latest}:${pathspec}`);
        } catch {
          existedInBackup = false;
        }
        if (existedInBackup) {
          throw err;
        }
        git('rm', '-r', '-f', '--ignore-unmatch', '--', pathspec);
        try {
          rmSync(join(ROOT, pathspec), { recursive: true, force: true });
        } catch {
        }
        removed.push(pathspec);
      }
    }

    if (restored.length > 0) addPaths(expandToShippedFiles(restored, latest));
    const rollbackPaths = [...restored, ...removed];
    const expandedRollbackPaths = expandToShippedFiles(rollbackPaths, latest);
    try {
      if (expandedRollbackPaths.length > 0) {
        git('commit', '-m', `chore: rollback system files from ${latest}`, '--', ...expandedRollbackPaths);
      }
    } catch {
    }

    console.log(`Rollback complete. Restored ${restored.length} path(s) from ${latest}, removed ${removed.length} path(s) added after the backup.`);
    console.log('Your data (CV, profile, tracker, reports) was not affected.');
  } catch (err) {
    console.error('Rollback failed:', err.message);
    process.exit(1);
  }
}

export async function dismiss(argv = process.argv, ctx = {}) {
  const idx = argv.indexOf('--version');
  let version = idx !== -1 ? String(argv[idx + 1] || '').trim().replace(/^v/i, '') : '';
  if (idx !== -1 && !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`--version '${argv[idx + 1] ?? ''}' is not a release version (X.Y.Z). Nothing was dismissed.`);
  }
  if (!version) {
    const latest = await latestRelease(ctx.curlGet || curlGet);
    if (latest.status === 'ok') version = latest.version;
  }
  const at = (ctx.now ? ctx.now() : new Date()).toISOString();
  writeFileSync(join(ctx.root || ROOT, DISMISS_FILE), JSON.stringify(version ? { version, at } : { at }) + '\n');
  console.log(version
    ? `Update to v${version} dismissed. You will be asked again when a newer release is out; run "node update-system.mjs check --force" or say "check for updates" to see it anyway.`
    : 'Update dismissed. You will be asked again when a newer release is out; run "node update-system.mjs check --force" or say "check for updates" to see it anyway.');
}

const canonicalizePath = realpathSync.native ?? realpathSync;
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
const selfPath = fileURLToPath(import.meta.url);
let isCli = Boolean(process.argv[1]) && entryPath === selfPath;
if (process.argv[1] && !isCli) {
  try { isCli = canonicalizePath(entryPath) === canonicalizePath(selfPath); } catch { isCli = false; }
}

if (isCli) {
  const cmd = process.argv[2] || 'check';

  try {
    const redirected = redirectToMainCheckout(cmd);
    if (redirected !== null) process.exit(redirected);

    switch (cmd) {
      case 'check': await check(); break;
      case 'status': console.log(`career-ops v${formatLocalVersion()}`); break;
      case 'apply': await apply(); break;
      case 'rollback': rollback(); break;
      case 'dismiss': await dismiss(); break;
      default:
        console.log('Usage: node update-system.mjs [check [--force] [--channel main]|status|apply --confirm [--force] [--channel main]|rollback|dismiss [--version X.Y.Z]]');
        process.exit(1);
    }
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
