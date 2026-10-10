import type { Page, Frame } from "playwright-core";
import type { ApplyField } from "./extract";
import type { ApplyIssue } from "./issue";

export type { ApplyIssue };

export function statusBlock(status: number | null | undefined, headers: Record<string, string>): ApplyIssue | null {
  if (!status) return null;
  const cf = headers["cf-ray"] || headers["cf-mitigated"] || headers["cf-request-id"];
  if (status === 401 || status === 407) return { level: "block", code: "auth-required", message: "This page needs you to sign in first. Open it directly, log in, then paste the application-form URL here." };
  if (status === 451) return { level: "block", code: "geo-block", message: "This page is blocked for legal/region reasons. We can't open the form here." };
  if (status === 403) return { level: "block", code: cf ? "bot-block" : "forbidden", message: cf ? "This page is behind a bot check. Open it directly in your browser, then paste the URL back here." : "This page returned “403 access denied”. Open it directly in your browser to check." };
  if (status === 429) return { level: "block", code: "rate-limited", message: "The site is rate-limiting requests right now. Wait a minute, then try again or open it directly." };
  if (status >= 500) return { level: "block", code: "server-error", message: `The site returned an error (status ${status}). Try again shortly, or open it directly.` };
  if (status === 404 || status === 410) return { level: "block", code: "not-found", message: "This posting is gone (404). It's likely closed, or the link is wrong." };
  return null;
}

const CONSENT_ROOTS =
  '#onetrust-banner-sdk, #CybotCookiebotDialog, #truste-consent-track, .qc-cmp2-container, #usercentrics-root, [id*="cookie" i][class*="banner" i], [class*="cookie-consent" i], [aria-label*="cookie" i]';
const CONSENT_BUTTONS = [
  "#onetrust-accept-btn-handler",
  "#onetrust-button-accept-all",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  '.qc-cmp2-button[mode="primary"]',
  "#truste-consent-button",
];

export async function dismissConsent(page: Page): Promise<ApplyIssue[]> {
  try {
    const root = page.locator(CONSENT_ROOTS).first();
    if (!(await root.count().catch(() => 0))) return [];
    if (!(await root.isVisible().catch(() => false))) return [];
    for (const sel of CONSENT_BUTTONS) {
      const b = page.locator(sel).first();
      if ((await b.count().catch(() => 0)) && (await b.isVisible().catch(() => false))) {
        await b.click({ timeout: 2000 }).catch(() => {});
        return [{ level: "info", code: "consent-dismissed", message: "Dismissed a cookie banner to reach the form." }];
      }
    }
    const g = page.getByRole("button", { name: /^(accept|allow|agree|got it|i agree|accept all)/i }).first();
    if (await g.count().catch(() => 0)) {
      await g.click({ timeout: 2000 }).catch(() => {});
      return [{ level: "info", code: "consent-dismissed", message: "Dismissed a cookie banner to reach the form." }];
    }
  } catch {
  }
  return [];
}

export async function dropNewTabs(page: Page): Promise<void> {
  for (const fr of page.frames()) {
    await fr
      .evaluate(() => {
        document.querySelectorAll('a[target="_blank"], a[target="_new"], form[target]').forEach((el) => el.removeAttribute("target"));
        try {
          (window as unknown as { open: (u?: string) => Window | null }).open = (u?: string) => {
            if (u) location.href = u;
            return null;
          };
        } catch {
        }
      })
      .catch(() => {});
  }
}

export async function tryApplyTrigger(page: Page): Promise<boolean> {
  try {
    const atsLink = page.locator('a[href*="ashbyhq"], a[href*="greenhouse"], a[href*="lever.co"], a[href*="smartrecruiters"], a[href*="workable"], a[href*="recruitee"], a[href*="bamboohr"], a[href*="jobvite"], a[href*="teamtailor"], a[href*="myworkdayjobs"], a[href*="/apply"], a[href*="/application"]').first();
    if (await atsLink.count().catch(() => 0)) {
      const href = await atsLink.getAttribute("href").catch(() => null);
      if (href && /^https?:\/\//i.test(href) && !/submit/i.test(href)) {
        await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        return true;
      }
    }
    const t = page
      .getByRole("button", { name: /apply|start application|begin application/i })
      .or(page.getByRole("link", { name: /apply/i }))
      .first();
    if ((await t.count().catch(() => 0)) && (await t.isVisible().catch(() => false))) {
      const label = (await t.innerText().catch(() => "")).toLowerCase();
      if (/submit|applied|withdraw/.test(label)) return false;
      await t.click({ timeout: 3000 }).catch(() => {});
      return true;
    }
  } catch {
  }
  return false;
}

export async function classifyEmpty(page: Page, url: string): Promise<ApplyIssue> {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  const sig = await page
    .evaluate(() => {
      const t = (document.title || "").toLowerCase();
      const body = (document.body?.innerText || "").toLowerCase().slice(0, 6000);
      const hasPassword = !!document.querySelector('input[type="password"]');
      const challengeDom = !!document.querySelector(
        '#challenge-running, #challenge-form, .cf-browser-verification, iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, #px-captcha, [class*="datadome" i], #cf-please-wait',
      );
      return { t, body, hasPassword, challengeDom };
    })
    .catch(() => ({ t: "", body: "", hasPassword: false, challengeDom: false }));

  const u = url.toLowerCase();
  const challTitle = /just a moment|checking your browser|one moment please|verifying you|attention required/.test(sig.t);
  const challUrl = /__cf_chl|challenges\.cloudflare\.com|\/cdn-cgi\/|datadome|px-captcha/.test(u);
  const challText = /(verify (you|that you)|are you human|not a robot|human verification|checking your browser|enable javascript and cookies)/.test(sig.body);
  if ([challTitle, challUrl, sig.challengeDom, challText].filter(Boolean).length >= 2) {
    return { level: "block", code: "bot-challenge", message: "This page is asking you to verify you're human before showing the form. Open it directly in your browser, complete the check, then paste the URL back here." };
  }
  if (sig.hasPassword || /\/(login|sign-?in|register|sign-?up|auth|account|mfa|2fa)(\/|$|\?)/.test(u)) {
    return { level: "block", code: "login-wall", message: "This page wants you to sign in or create an account first. Open it directly, log in, then paste the actual application-form URL here." };
  }
  if (/no longer accepting|position has been filled|posting is closed|no longer available|this (job|position|posting) (is |has )?(closed|expired|been filled)/.test(sig.body) || /not found|no longer|removed|closed/.test(sig.t)) {
    return { level: "block", code: "expired", message: "This job posting is closed or expired — it's no longer accepting applications." };
  }
  if (/myworkdayjobs\.com$/i.test(host)) {
    return { level: "block", code: "workday", message: "Workday forms aren't supported for in-app fill yet (multi-step, account-gated). Open the posting and apply there directly." };
  }
  if (/^(jobs|careers|empleos|empregos|all jobs|open (positions|roles)|search jobs|current openings)/i.test(sig.t) || /\/(jobs|careers|search|positions)\/?(\?|$)/.test(u)) {
    return { level: "block", code: "listing-page", message: "This looks like the careers listing, not a single application — the posting may have moved or closed. Open the specific job and paste its “Apply” URL." };
  }
  return { level: "block", code: "no-form", message: "Couldn't find a fillable form on this page. If it's a job description, open its “Apply” form and paste that URL." };
}

export async function captchaWarning(page: Page): Promise<ApplyIssue | null> {
  const interactive = await page
    .evaluate(() => {
      const vis = (el: Element | null) => {
        if (!el) return false;
        const r = (el as HTMLElement).getBoundingClientRect();
        return (el as HTMLElement).offsetParent !== null && r.width > 40 && r.height > 20;
      };
      const some = (sel: string) => Array.from(document.querySelectorAll(sel)).some(vis);
      return (
        some('iframe[src*="recaptcha/api2/anchor"]') ||
        some('.g-recaptcha[data-size="normal"]') ||
        some('iframe[src*="hcaptcha.com"][src*="frame=checkbox"], .h-captcha iframe') ||
        some('.cf-turnstile')
      );
    })
    .catch(() => false);
  return interactive ? { level: "warn", code: "captcha-present", message: "This form has a captcha you'll need to tick — do it yourself on the real form at the end." } : null;
}

export async function multiStepInfo(page: Page): Promise<ApplyIssue | null> {
  const ms = await page
    .evaluate(() => {
      const txt = (document.body?.innerText || "").toLowerCase();
      const stepText = /\b(step|page|stage)\s*\d+\s*(of|\/)\s*\d+/.test(txt);
      const vis = (el: Element) => (el as HTMLElement).offsetParent !== null;
      const btns = Array.from(document.querySelectorAll("button, a, [role=button]"));
      const label = (b: Element) => (b.textContent || "").replace(/\s+/g, " ").trim();
      const hasNext = btns.some((b) => vis(b) && /^(next|continue|save (and|&) continue|next step|continue to)\b/i.test(label(b)));
      const hasSubmit = btns.some((b) => vis(b) && /^(submit application|submit|send application|apply now)\b/i.test(label(b)));
      return (stepText || hasNext) && !hasSubmit;
    })
    .catch(() => false);
  return ms ? { level: "info", code: "multi-step", message: "This form has more than one step — after this page, you'll continue on the real form." } : null;
}

export async function verifyFill(frame: Frame, fields: ApplyField[], answers: Record<string, string>): Promise<ApplyIssue[]> {
  const meta = fields.map((f) => ({ id: f.id, label: f.label || "this field", type: f.type, required: !!f.required, combobox: !!f.combobox }));
  type R = { mismatches: string[]; requiredEmpty: string[]; valErrors: string[] };
  const res = await frame
    .evaluate(
      ({ meta, answers }): R => {
        const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const mismatches: string[] = [];
        const requiredEmpty: string[] = [];
        for (const f of meta) {
          const intended = answers[f.id];
          const el = document.querySelector(`[data-co-field="${f.id}"]`) as HTMLElement | null;
          if (!el) continue;
          if (f.type === "file") {
            const filesEl = el as HTMLInputElement;
            const has = !!(filesEl.files && filesEl.files.length > 0);
            if (f.required && !has) requiredEmpty.push(f.label);
            continue;
          }
          let actual = "";
          if (f.type === "checkbox") {
            actual = (el as HTMLInputElement).checked ? "true" : "";
          } else if (f.type === "radio") {
            const grp = Array.from(document.querySelectorAll(`[data-co-field="${f.id}"]`)) as HTMLInputElement[];
            actual = grp.some((r) => r.checked) ? "checked" : "";
          } else if (f.combobox) {
            const shell = el.closest('[class*="select-shell" i], [class*="select__container" i], [class*="select__control" i], [class*="value-container" i]') || el.parentElement?.parentElement || el.parentElement;
            const sv = shell?.querySelector('.select__single-value, [class*="single-value" i], [class*="singleValue" i], [class*="multi-value" i]');
            const ph = shell?.querySelector('.select__placeholder, [class*="placeholder" i]');
            const svText = (sv?.textContent || "").trim();
            if (svText) actual = svText;
            else if (ph && (ph as HTMLElement).offsetParent !== null) actual = "";
            else actual = intended || "ok";
          } else {
            actual = (el as HTMLInputElement).value || "";
          }
          if (intended && intended.trim() && !norm(actual)) mismatches.push(f.label);
          else if (f.required && !norm(actual) && !(intended && intended.trim())) requiredEmpty.push(f.label);
        }
        const errSel = '[aria-invalid="true"], [role="alert"], [class*="error" i]:not([class*="clear" i]):not([class*="error-free" i])';
        const valErrors: string[] = [];
        for (const e of Array.from(document.querySelectorAll(errSel)) as HTMLElement[]) {
          const txt = (e.textContent || "").replace(/\s+/g, " ").trim();
          if (txt && txt.length > 2 && txt.length < 160 && e.offsetParent !== null) valErrors.push(txt);
        }
        return { mismatches, requiredEmpty, valErrors: Array.from(new Set(valErrors)).slice(0, 5) };
      },
      { meta, answers },
    )
    .catch(() => ({ mismatches: [], requiredEmpty: [], valErrors: [] }) as R);

  const out: ApplyIssue[] = [];
  if (res.mismatches.length) out.push({ level: "warn", code: "fill-mismatch", message: `These answers didn't seem to land on the real form — check them: ${res.mismatches.slice(0, 4).join(", ")}${res.mismatches.length > 4 ? "…" : ""}.` });
  if (res.requiredEmpty.length) out.push({ level: "warn", code: "required-empty", message: `Required and still empty — you'll need to fill ${res.requiredEmpty.length > 1 ? "these" : "this"}: ${res.requiredEmpty.slice(0, 4).join(", ")}${res.requiredEmpty.length > 4 ? "…" : ""}.` });
  for (const v of res.valErrors) out.push({ level: "warn", code: "validation", message: `The form flagged: “${v}”.` });
  return out;
}
