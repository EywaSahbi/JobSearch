import type { Application, InboxJob } from "@/lib/career-ops";
import type { Job } from "@/components/jobs/job-store";
import { normalizeTextKey } from "@/lib/core/normalize-text-key.mjs";
import { formatBatchSpendConfirmation, requiresBatchSpendConfirmation } from "@/lib/run-cost-estimate.mjs";

export const BATCH_CAP = 12;

const CANON_STATUS = ["Evaluated", "Applied", "Responded", "Interview", "Offer", "Hired", "Rejected", "Discarded", "SKIP"];

const TAB_VALUES = [
  "INBOX", "ALL", "EVALUATED", "APPLIED", "RESPONDED", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "DISCARDED", "SKIP",
] as const;
const SORT_VALUES = ["company", "role", "score", "status", "date"] as const;

export type StartJobInput = {
  title: string;
  subtitle?: string;
  kind: string;
  input: string;
  page?: string;
  batchId?: string;
};

export type ActionCtx = {
  push: (path: string) => void;
  replace: (path: string) => void;
  startJob: (opts: StartJobInput) => string | null;
  inbox: InboxJob[];
  applications: Application[];
  jobForUrl: (url: string) => Job | undefined;
  estimateCost?: (kind: string, count: number) => { tokens?: number; usd?: number };
  rememberFact: (fact: string) => void;
  writeStatus: (n: string, status: string) => void;
  setApplyField: (idOrLabel: string, value: string) => void;
  startApply: (url: string) => void;
  applyExplore?: (patch: Record<string, unknown>, opts?: { merge?: boolean; run?: boolean }) => void;
  writeProfile?: (patch: Record<string, unknown>) => void;
  writePortals?: (roles: string[], location?: string[]) => void;
};

export type ProfilePatch = {
  name?: string;
  email?: string;
  location?: string;
  roles?: string[];
  compMin?: number;
  compMax?: number;
  currency?: string;
  remote?: string;
  seniority?: string;
};

function coerceProfile(raw: Record<string, unknown>): ProfilePatch {
  const out: ProfilePatch = {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  out.name = str(raw.name);
  out.email = str(raw.email);
  out.location = str(raw.location);
  out.currency = str(raw.currency);
  out.remote = str(raw.remote);
  out.seniority = str(raw.seniority);
  out.compMin = num(raw.compMin);
  out.compMax = num(raw.compMax);
  if (Array.isArray(raw.roles)) out.roles = raw.roles.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim()).slice(0, 6);
  return out;
}

export type DoneInfo = { jobIds?: string[]; batchId?: string; note?: string };
export type DispatchResult =
  | ({ status: "done" } & DoneInfo)
  | { status: "ignored"; note?: string }
  | { status: "confirm"; summary: string; run: () => DoneInfo };

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const normCompany = (s: string) => normalizeTextKey(s, " ");

function isAllowedPath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (/^(https?:)?\/\//i.test(p)) return false;
  const path = p.split(/[?#]/)[0];
  if (path === "/") return true;
  return /^\/(explore|pipeline|portals|analytics|cv|config|apply|jobs)(\/[^/]+)?$/.test(path);
}

function genBatchId(): string {
  return `batch-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

type ActionDef = {
  sideEffect: "none" | "spend" | "write";
  run: (raw: Record<string, unknown>, ctx: ActionCtx) => DispatchResult;
};

const ACTIONS: Record<string, ActionDef> = {
  navigate: {
    sideEffect: "none",
    run: (raw, ctx) => {
      const path = raw.path;
      if (!isStr(path) || !isAllowedPath(path)) return { status: "ignored", note: "blocked navigation" };
      ctx.push(path);
      return { status: "done" };
    },
  },

  filterPipeline: {
    sideEffect: "none",
    run: (raw, ctx) => {
      const sp = new URLSearchParams();
      const tab = typeof raw.tab === "string" ? raw.tab.toUpperCase() : "";
      if ((TAB_VALUES as readonly string[]).includes(tab)) sp.set("tab", tab);
      const min = typeof raw.min === "number" ? raw.min : parseFloat(String(raw.min ?? ""));
      if (Number.isFinite(min) && min >= 0 && min <= 5) sp.set("min", String(min));
      if (isStr(raw.q)) sp.set("q", String(raw.q).slice(0, 80));
      const sort = typeof raw.sort === "string" ? raw.sort : "";
      if ((SORT_VALUES as readonly string[]).includes(sort)) sp.set("sort", sort);
      const dir = Number(raw.dir);
      if (dir === 1 || dir === -1) sp.set("dir", String(dir));
      const qs = sp.toString();
      ctx.replace(`/pipeline${qs ? `?${qs}` : ""}`);
      return { status: "done" };
    },
  },

  evaluate: {
    sideEffect: "spend",
    run: (raw, ctx) => {
      const url = raw.url;
      if (!isStr(url) || !/^https?:\/\//i.test(url)) return { status: "ignored", note: "invalid url" };
      const ex = ctx.jobForUrl(url);
      if (ex && ex.status !== "error" && !raw.rerun) return { status: "ignored", note: "already evaluated" };
      const id = ctx.startJob({
        title: isStr(raw.title) ? String(raw.title) : "Evaluate",
        subtitle: isStr(raw.subtitle) ? String(raw.subtitle) : undefined,
        kind: "evaluate",
        input: url,
        page: "/pipeline",
      });
      return { status: "done", jobIds: id ? [id] : [] };
    },
  },

  evaluateCompany: {
    sideEffect: "spend",
    run: (raw, ctx) => {
      const company = raw.company;
      if (!isStr(company)) return { status: "ignored", note: "missing company" };
      const target = normCompany(company);
      const rerun = raw.rerun === true;
      const cap = Number.isFinite(Number(raw.max)) ? Math.min(BATCH_CAP, Number(raw.max)) : BATCH_CAP;

      const matches = ctx.inbox.filter((j) => {
        if (j.done) return false;
        const c = normCompany(j.company);
        return c === target || c.includes(target) || target.includes(c);
      });
      const pending = matches
        .filter((j) => {
          if (rerun) return true;
          const ex = ctx.jobForUrl(j.url);
          return !ex || ex.status === "error";
        })
        .slice(0, cap);

      if (pending.length === 0) {
        return {
          status: "ignored",
          note: matches.length > 0 ? `Already evaluated every ${company} posting.` : `No pending ${company} postings in your inbox.`,
        };
      }

      const fire = (): DoneInfo => {
        const batchId = pending.length > 1 ? genBatchId() : undefined;
        const ids = pending
          .map((j) =>
            ctx.startJob({
              title: `Evaluate · ${j.company}`,
              subtitle: j.role,
              kind: "evaluate",
              input: j.url,
              page: "/pipeline",
              batchId,
            }),
          )
          .filter((x): x is string => !!x);
        return { jobIds: ids, batchId };
      };

      if (!requiresBatchSpendConfirmation(pending.length)) return { status: "done", ...fire() };
      const estimate = ctx.estimateCost?.("evaluate", pending.length) ?? {};
      return {
        status: "confirm",
        summary: formatBatchSpendConfirmation(`Evaluate ${pending.length} ${company} postings`, pending.length, estimate),
        run: fire,
      };
    },
  },

  explore: {
    sideEffect: "none",
    run: (raw, ctx) => {
      if (!ctx.applyExplore) return { status: "ignored", note: "explore unavailable here" };
      const run = raw.run === true;
      const merge = raw.merge === true;
      ctx.push("/explore");
      ctx.applyExplore(raw, { merge, run });
      return { status: "done", note: run ? "Scanning the ATS network for fresh roles (free)…" : "Opened Explore with your filters." };
    },
  },

  research: {
    sideEffect: "spend",
    run: (raw, ctx) => {
      const target = raw.target;
      if (!isStr(target)) return { status: "ignored", note: "missing target" };
      const id = ctx.startJob({
        title: isStr(raw.title) ? String(raw.title) : "Research",
        kind: "research",
        input: target,
        page: "/pipeline",
      });
      return { status: "done", jobIds: id ? [id] : [] };
    },
  },

  generatePdf: {
    sideEffect: "spend",
    run: (raw, ctx) => {
      const n = String(raw.n ?? "").trim();
      if (!n) return { status: "ignored", note: "need an application #" };
      const app = ctx.applications.find((a) => a.n === n);
      const id = ctx.startJob({ title: `CV PDF · ${app?.company ?? `#${n}`}`, subtitle: "tailored CV", kind: "pdf", input: n, page: `/pipeline/${n}` });
      return { status: "done", jobIds: id ? [id] : [] };
    },
  },

  setStatus: {
    sideEffect: "write",
    run: (raw, ctx) => {
      const n = String(raw.n ?? "").trim();
      const status = String(raw.status ?? "").trim();
      const canon = CANON_STATUS.find((s) => s.toLowerCase() === status.toLowerCase());
      if (!n || !canon) return { status: "ignored", note: "need an application # and a canonical status" };
      const app = ctx.applications.find((a) => a.n === n);
      const label = app ? `${app.company} · ${app.role}` : `#${n}`;
      return {
        status: "confirm",
        summary: `Mark ${label} → ${canon}?`,
        run: () => {
          ctx.writeStatus(n, canon);
          return { note: `Marked #${n} as ${canon}.` };
        },
      };
    },
  },

  apply: {
    sideEffect: "none",
    run: (raw, ctx) => {
      const url = raw.url;
      if (!isStr(url) || !/^https?:\/\//i.test(url)) return { status: "ignored", note: "need an application form URL" };
      ctx.startApply(url);
      return { status: "done", note: "Opening the application form…" };
    },
  },

  setApplyField: {
    sideEffect: "none",
    run: (raw, ctx) => {
      const field = (raw.field ?? raw.label) as unknown;
      const value = raw.value;
      if (!isStr(field) || typeof value !== "string") return { status: "ignored", note: "need a field and a value" };
      ctx.setApplyField(String(field), value);
      return { status: "done", note: `Updated "${field}".` };
    },
  },

  remember: {
    sideEffect: "write",
    run: (raw, ctx) => {
      const fact = raw.fact;
      if (!isStr(fact)) return { status: "ignored" };
      ctx.rememberFact(String(fact).trim());
      return { status: "done" };
    },
  },

  setProfile: {
    sideEffect: "write",
    run: (raw, ctx) => {
      if (!ctx.writeProfile) return { status: "ignored", note: "profile write unavailable here" };
      const p = coerceProfile(raw);
      const has = Object.values(p).some((v) => (Array.isArray(v) ? v.length : v !== undefined));
      if (!has) return { status: "ignored", note: "nothing to save" };
      const bits = [p.roles?.length ? `roles: ${p.roles.join(", ")}` : "", p.location ? `in ${p.location}` : "", p.compMin && p.compMax ? `comp ${p.compMin}–${p.compMax}` : ""].filter(Boolean).join(" · ");
      return {
        status: "confirm",
        summary: `Save your profile?${bits ? ` (${bits})` : ""}`,
        run: () => {
          ctx.writeProfile!(p as Record<string, unknown>);
          if (p.roles?.length) ctx.writePortals?.(p.roles, p.location ? [p.location] : undefined);
          return { note: "Profile saved — your matches will sharpen." };
        },
      };
    },
  },

  setPortals: {
    sideEffect: "write",
    run: (raw, ctx) => {
      if (!ctx.writePortals) return { status: "ignored", note: "portals write unavailable here" };
      const roles = Array.isArray(raw.roles) ? raw.roles.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim()) : [];
      if (roles.length === 0) return { status: "ignored", note: "no roles" };
      const location = Array.isArray(raw.location) ? raw.location.filter((l): l is string => typeof l === "string") : undefined;
      return {
        status: "confirm",
        summary: `Set your scan targets to: ${roles.join(", ")}?`,
        run: () => {
          ctx.writePortals!(roles, location);
          return { note: "Scan targets updated." };
        },
      };
    },
  },
};

export function actionExists(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACTIONS, id);
}

export function dispatch(id: string, rawArgs: Record<string, unknown>, ctx: ActionCtx): DispatchResult {
  const def = ACTIONS[id];
  if (!def) return { status: "ignored", note: `unknown action: ${id}` };
  try {
    return def.run(rawArgs ?? {}, ctx);
  } catch {
    return { status: "ignored", note: `could not run ${id}` };
  }
}
