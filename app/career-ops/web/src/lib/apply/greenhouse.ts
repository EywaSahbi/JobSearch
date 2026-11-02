export type GhField = { label: string; type: string; required: boolean; options: string[] };

export function parseGreenhouse(url: string): { token: string; jobId: string } | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)greenhouse\.io$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/([^/]+)\/jobs\/(\d+)/);
    if (m) return { token: m[1], jobId: m[2] };
    const forToken = u.searchParams.get("for");
    const jobId = u.searchParams.get("token");
    if (forToken && jobId) return { token: forToken, jobId };
    return null;
  } catch {
    return null;
  }
}

const GH_TYPE: Record<string, GhField["type"]> = {
  input_text: "text",
  textarea: "textarea",
  input_file: "file",
  multi_value_single_select: "select",
  multi_value_multi_select: "select",
  multi_select: "select",
  single_select: "select",
  boolean: "select",
};

export async function fetchGreenhouseSchema(token: string, jobId: string): Promise<Map<string, GhField> | null> {
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(jobId)}?questions=true`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { questions?: Array<{ label?: string; required?: boolean; fields?: Array<{ name?: string; type?: string; values?: Array<{ label?: string }> }> }> };
    const map = new Map<string, GhField>();
    for (const q of data.questions ?? []) {
      const label = (q.label ?? "").replace(/\s*\*+\s*$/, "").trim();
      for (const f of q.fields ?? []) {
        if (!f.name) continue;
        const gf: GhField = {
          label,
          type: GH_TYPE[f.type ?? ""] ?? "text",
          required: !!q.required,
          options: (f.values ?? []).map((v) => (v.label ?? "").trim()).filter(Boolean),
        };
        map.set(f.name, gf);
        if (label) map.set(`label:${label.toLowerCase()}`, gf);
      }
    }
    return map.size ? map : null;
  } catch {
    return null;
  }
}
