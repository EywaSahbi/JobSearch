import type { DiscoveredOffer } from "./explore";
import { pendingOpenerLen } from "./stream-parse.mjs";
import { normalizeUrl } from "./core/url-key.mjs";

const OPEN = "<<offer:";
const CLOSE = ">>";

export type AiTraceChunk =
  | { kind: "offer"; offer: DiscoveredOffer }
  | { kind: "narration"; text: string }
  | { kind: "malformed"; raw: string };

export function canon(u: string): string {
  return normalizeUrl(u);
}

function toOffer(raw: unknown): DiscoveredOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const conf = o.confidence;
  return {
    url,
    company: str(o.company),
    title: str(o.title),
    location: str(o.location),
    postedAt: "",
    ats: str(o.ats) || "other",
    source: "ai-search",
    verification: "unconfirmed",
    why: str(o.why) || undefined,
    postedHint: str(o.postedHint) || undefined,
    confidence: conf === "low" || conf === "medium" || conf === "high" ? conf : undefined,
  };
}

export function makeAiStreamParser(opts?: { knownUrls?: Set<string> }) {
  const known = opts?.knownUrls ?? new Set<string>();
  const seen = new Set<string>();
  let buf = "";

  return {
    feed(delta: string): AiTraceChunk[] {
      buf += delta;
      const out: AiTraceChunk[] = [];
      for (;;) {
        const open = buf.indexOf(OPEN);
        if (open === -1) {
          const hold = pendingOpenerLen(buf, OPEN);
          const text = hold ? buf.slice(0, buf.length - hold) : buf;
          if (text.trim()) out.push({ kind: "narration", text });
          buf = hold ? buf.slice(buf.length - hold) : "";
          break;
        }
        const before = buf.slice(0, open);
        if (before.trim()) out.push({ kind: "narration", text: before });
        const close = buf.indexOf(CLOSE, open + OPEN.length);
        if (close === -1) {
          buf = buf.slice(open);
          break;
        }
        const json = buf.slice(open + OPEN.length, close);
        buf = buf.slice(close + CLOSE.length);
        let offer: DiscoveredOffer | null = null;
        try {
          offer = toOffer(JSON.parse(json));
        } catch {
          offer = null;
        }
        if (!offer) {
          out.push({ kind: "malformed", raw: json.slice(0, 120) });
          continue;
        }
        const key = canon(offer.url);
        if (key && (seen.has(key) || known.has(key))) continue;
        if (key) seen.add(key);
        out.push({ kind: "offer", offer });
      }
      return out;
    },
    flush(): AiTraceChunk[] {
      const text = buf;
      buf = "";
      return text.trim() ? [{ kind: "narration" as const, text }] : [];
    },
  };
}
