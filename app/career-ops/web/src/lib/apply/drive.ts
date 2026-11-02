import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import type { Page, Frame, ElementHandle } from "playwright-core";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot } from "@/lib/career-ops";
import { dropNewTabs } from "./diagnose";
import { isSubmitControl, snapshotLabel } from "./submit-guard.mjs";
import type { DriveStep } from "./issue";
import { CAPS } from "../worker-capabilities.mjs";
import { scopeFrom } from "../claude-invocation.mjs";

export type { DriveStep };

export type DriveResult = { reached: boolean; turns: number; reason: string; steps: DriveStep[] };

type ElementFacts = {
  ref: string;
  tag: string;
  type: string;
  role: string;
  inForm: boolean;
  aria: string;
  placeholder: string;
  text: string;
  value: string;
  name: string;
  title: string;
  alt: string;
};

const factsOf = (el: Element, ref: string | null): ElementFacts => {
  const field = el as HTMLInputElement;
  const tag = el.tagName.toLowerCase();
  const flat = (s: string | null) => (s || "").replace(/\s+/g, " ").trim();
  let aria = flat(el.getAttribute("aria-label"));
  if (!aria) {
    const ids = flat(el.getAttribute("aria-labelledby")).split(" ").filter(Boolean);
    aria = flat(ids.map((id) => document.getElementById(id)?.textContent || "").join(" ")).slice(0, 200);
  }
  return {
    ref: ref || el.getAttribute("data-co-ref") || "",
    tag,
    type: flat(el.getAttribute("type")).toLowerCase(),
    role: flat(el.getAttribute("role")).toLowerCase() || (tag === "a" ? "link" : tag),
    inForm: Boolean(field.form) || el.closest("form") !== null,
    aria,
    placeholder: field.placeholder || "",
    text: flat(el.textContent).slice(0, 200),
    value: field.value || "",
    name: field.name || "",
    title: flat(el.getAttribute("title")).slice(0, 200),
    alt: flat(el.getAttribute("alt")).slice(0, 200),
  };
};

const MAX_REFS = 70;

async function snapshot(frame: Frame): Promise<{ text: string; actionable: Set<string> }> {
  const epoch = `e${Math.random().toString(36).slice(2, 8)}`;
  const tagged = await frame.evaluate(
    ({ prefix, max }) => {
      for (const stale of Array.from(document.querySelectorAll("[data-co-ref]"))) stale.removeAttribute("data-co-ref");
      const vis = (el: Element) => {
        const r = el.getBoundingClientRect();
        return (el as HTMLElement).offsetParent !== null && r.width > 2 && r.height > 2;
      };
      const sel = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="combobox"], [role="checkbox"], [role="radio"], [contenteditable="true"]';
      const els = Array.from(document.querySelectorAll(sel)).filter(vis);
      let n = 0;
      for (const el of els.slice(0, max)) el.setAttribute("data-co-ref", `${prefix}-${n++}`);
      return n;
    },
    { prefix: epoch, max: MAX_REFS },
  );
  const lines: string[] = [];
  const actionable = new Set<string>();
  if (!tagged) return { text: "", actionable };
  const handles = await frame.$$(`[data-co-ref^="${epoch}-"]`);
  const els = await Promise.all(handles.map((h) => h.evaluate(factsOf, null).catch(() => null)));
  await Promise.all(handles.map((h) => h.dispose().catch(() => {})));
  for (const el of els) {
    if (!el || !el.ref) continue;
    if (el.tag === "input" && el.type === "hidden") continue;
    const label = snapshotLabel(el);
    if (isSubmitControl(el)) {
      lines.push(`[--] submit "${label}" (not actionable, the human submits)`);
      continue;
    }
    actionable.add(el.ref);
    const kind = el.tag === "input" ? el.type || "text" : el.tag === "a" ? "link" : el.tag === "select" ? "select" : el.tag === "textarea" ? "textarea" : el.role;
    lines.push(`[${el.ref}] ${kind} "${label}"`);
  }
  return { text: lines.join("\n"), actionable };
}

const PLANNER_DENIED = [scopeFrom("").disallowed, "Read", "Glob", "Grep"].join(",");

function plannerTurn(binPath: string, prompt: string, resumeId: string | null): Promise<{ out: string; sessionId: string | null }> {
  const base = resumeId ? ["-p", "--resume", resumeId, prompt] : ["-p", prompt];
  const args = [...base, "--output-format", "json", "--strict-mcp-config", "--disallowedTools", PLANNER_DENIED];
  return new Promise((resolve) => {
    const child = spawnHeadlessCli(
      binPath,
      args,
      { cwd: careerOpsRoot(), env: process.env },
      { cliId: "claude", capabilities: CAPS.localReadOnly },
    );
    let buf = "";
    child.stdout.on("data", (d: Buffer) => (buf += d.toString()));
    child.stderr.on("data", () => {});
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
      }
    }, 90_000);
    child.on("close", () => {
      clearTimeout(killer);
      let out = buf;
      let sessionId: string | null = null;
      try {
        const j = JSON.parse(buf);
        out = j.result ?? buf;
        sessionId = j.session_id ?? null;
      } catch {
      }
      resolve({ out, sessionId });
    });
    child.on("error", () => {
      clearTimeout(killer);
      resolve({ out: buf, sessionId: null });
    });
  });
}

type Action = { action: string; ref?: string; text?: string; value?: string; reason?: string };

function parseAction(out: string): Action | null {
  const m = out.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export async function driveSession(
  page: Page,
  cliId: string,
  goal: "reach" | "full",
  isFormReady: () => Promise<boolean>,
  emit: (s: DriveStep) => void,
  budget = 10,
  answers?: { label: string; value: string }[],
): Promise<DriveResult> {
  const resolved = resolveCli(cliId);
  const steps: DriveStep[] = [];
  if (!resolved || cliId !== "claude") {
    return { reached: false, turns: 0, reason: "Agentic drive currently needs Claude Code (browser-driving CLI).", steps };
  }
  const shot = async () => {
    try {
      return `data:image/jpeg;base64,${(await page.screenshot({ type: "jpeg", quality: 38 })).toString("base64")}`;
    } catch {
      return undefined;
    }
  };
  const answersBlock = (answers ?? []).filter((a) => a.value?.trim()).map((a) => `- "${a.label}": ${a.value.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  const goalText =
    goal === "reach"
      ? `Your goal: navigate to the actual fillable JOB APPLICATION form (click 'Apply', pass any interstitial/pre-screen, reach the page with the Name/Email/Resume fields). Do NOT fill anything yet. Reply {"action":"reached_form"} once the form with those fields is visible.`
      : `Your goal: FILL this job application with the candidate's answers below, matching each answer to its field by label, across all pages (click 'Next'/'Continue' between pages). Skip any field already correctly filled, and skip file-uploads (handled separately). NEVER submit — when everything is filled and you're on the final page, reply {"action":"done"}.
ANSWERS (match by the field's label):
${answersBlock || "(no answers provided — just reach/observe)"}`;
  let resumeId: string | null = null;

  const stopVerb = goal === "reach" ? '{"action":"reached_form"}            STOP — the fillable application form is now visible' : '{"action":"done"}                    STOP — every answer is filled (you NEVER submit; the human does)';
  for (let turn = 1; turn <= budget; turn++) {
    if (goal === "reach" && (await isFormReady().catch(() => false))) return { reached: true, turns: turn - 1, reason: "form-reached", steps };
    await dropNewTabs(page);
    const frame = page.mainFrame();
    const snap = await snapshot(frame).catch(() => ({ text: "", actionable: new Set<string>() }));
    const prompt =
      turn === 1
        ? `You are an agent driving a real web browser for a job seeker (we execute your actions; the human submits at the end). ${goalText}
You NEVER submit a form — there is no submit action; the human does that.
Reply with EXACTLY ONE action as a JSON object, nothing else:
  {"action":"click","ref":"<ref>"}         click an element (refs are the bracketed names below, and they change every turn)
  {"action":"type","ref":"<ref>","text":"…"}  type into a field
  {"action":"select","ref":"<ref>","value":"…"} pick an option
  {"action":"scroll"}                        scroll down to reveal more
  ${stopVerb}
  {"action":"stuck","reason":"…"}            you can't proceed (login/captcha/dead-end)

Page: "${await page.title().catch(() => "")}" (${page.url()})
Elements:
${snap.text}`
        : `New page state after your last action.
Page: "${await page.title().catch(() => "")}" (${page.url()})
Elements:
${snap.text}

Reply ONE action JSON.`;

    const { out, sessionId } = await plannerTurn(resolved.binPath, prompt, resumeId);
    if (sessionId) resumeId = sessionId;
    const act = parseAction(out);
    if (!act) {
      const s: DriveStep = { turn, action: "parse-error", detail: out.slice(0, 80), thumb: await shot() };
      steps.push(s);
      emit(s);
      continue;
    }

    if (act.action === "reached_form") return { reached: true, turns: turn, reason: "agent-reached", steps };
    if (act.action === "done") return { reached: true, turns: turn, reason: "agent-done", steps };
    if (act.action === "stuck") {
      const s: DriveStep = { turn, action: "stuck", detail: act.reason || "", thumb: await shot() };
      steps.push(s);
      emit(s);
      return { reached: false, turns: turn, reason: act.reason || "stuck", steps };
    }

    let detail = "";
    let note = "";
    let refusal: DriveStep["refusal"];
    let handle: ElementHandle<SVGElement | HTMLElement> | null = null;
    try {
      const ref = act.ref !== undefined && snap.actionable.has(act.ref) ? act.ref : null;
      handle = ref !== null ? await frame.$(`[data-co-ref="${ref}"]`).catch(() => null) : null;
      const now = handle ? await handle.evaluate(factsOf, ref).catch(() => null) : null;
      const label = now ? snapshotLabel(now) : "";
      const target = now && !isSubmitControl(now) ? handle : null;
      if (act.ref !== undefined && !target) {
        const named = String(act.ref).slice(0, 24);
        if (ref === null) {
          refusal = "not-offered";
          note = "not offered this turn";
          detail = `blocked ref ${named} (not offered this turn)`;
        } else if (!now) {
          refusal = "gone";
          note = "element gone";
          detail = `blocked ref ${named} (gone)`;
        } else {
          refusal = "submit-control";
          note = "refused to click a submit control (the human submits)";
          detail = `blocked submit "${label.slice(0, 40)}"`;
        }
      } else if (act.action === "click" && target) {
        detail = `click "${label.slice(0, 40)}"`;
        await target.scrollIntoViewIfNeeded().catch(() => {});
        await Promise.all([page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {}), target.click({ timeout: 6000 })]);
      } else if (act.action === "type" && target) {
        detail = `type into ${label.slice(0, 40) || ref}`;
        await target.fill(act.text || "").catch(async () => {
          await target.click({ timeout: 6000 });
          await page.keyboard.type(act.text || "");
        });
      } else if (act.action === "select" && target) {
        detail = `select "${act.value}"`;
        await target.selectOption({ label: act.value || "" }, { timeout: 6000 }).catch(() => target.selectOption(act.value || "", { timeout: 6000 }));
      } else if (act.action === "scroll") {
        detail = "scroll";
        await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
      } else {
        detail = `unknown action ${act.action}`;
      }
    } catch (e) {
      detail = `${act.action} failed: ${e instanceof Error ? e.message.slice(0, 50) : "err"}`;
    } finally {
      await handle?.dispose().catch(() => {});
    }
    await page.waitForTimeout(700);
    const s: DriveStep = { turn, action: act.action, detail, thumb: await shot(), note: note || undefined, refusal };
    steps.push(s);
    emit(s);
  }
  return { reached: await isFormReady().catch(() => false), turns: budget, reason: "budget-exhausted", steps };
}
