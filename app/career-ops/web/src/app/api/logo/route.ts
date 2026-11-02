import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { companyDomain } from "@/lib/company";
import { companyCacheKey } from "@/lib/core/logo-cache-key.mjs";
import { companyDomains } from "@/lib/core/company-domains.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOMAIN_RE = /^[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;

function cacheDir(): string {
  return path.join(careerOpsRoot(), ".career-ops-web", "logo-cache");
}

async function fetchFavicon(domain: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`, {
      headers: { Accept: "image/*" },
      signal: AbortSignal.timeout(3500),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return ab.byteLength > 220 ? ab : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const domain = (sp.get("domain") ?? "").trim().toLowerCase();
  const company = (sp.get("company") ?? "").trim();

  let key: string;
  let candidates: string[];
  if (domain) {
    if (!DOMAIN_RE.test(domain) || domain.includes("..")) return new Response("bad domain", { status: 400 });
    key = domain.replace(/[^a-z0-9.-]/g, "_");
    candidates = [domain];
  } else if (company) {
    const companyKey = companyCacheKey(company);
    if (!companyKey) return new Response("bad company", { status: 400 });
    key = companyKey;
    candidates = companyDomains(company, companyDomain);
    if (candidates.length === 0) return new Response("no logo", { status: 404 });
  } else {
    return new Response("need domain or company", { status: 400 });
  }

  const file = path.resolve(cacheDir(), `${key}.png`);
  if (!file.startsWith(path.resolve(cacheDir()) + path.sep)) return new Response("bad key", { status: 400 });

  try {
    const buf = await fs.readFile(file);
    if (buf.byteLength > 0) {
      return new Response(new Uint8Array(buf), { status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
    }
    return new Response("no logo", { status: 404 });
  } catch {
  }

  let bytes: ArrayBuffer | null = null;
  for (const d of candidates) {
    bytes = await fetchFavicon(d);
    if (bytes) break;
  }

  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(file, bytes ? Buffer.from(bytes) : new Uint8Array(0));
  } catch {
  }

  if (!bytes) return new Response("no logo", { status: 404 });
  return new Response(bytes, { status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
}
