import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { resolveTailoredCv } from "@/lib/apply/cv";
import { careerOpsRoot, isRegularContainedFile, pdfPathStatusForReport } from "@/lib/career-ops";
import { companySlug } from "@/lib/company-slug.mjs";
import { matchesTailoredCv, sortNewestFirst } from "@/lib/apply/cv-match.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function servePdf(file: string): Response {
  const buf = fs.readFileSync(file);
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${path.basename(file)}"`, "Cache-Control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  const n = (req.nextUrl.searchParams.get("n") ?? "").trim();
  const company = (req.nextUrl.searchParams.get("company") ?? "").trim();
  const application = (req.nextUrl.searchParams.get("application") ?? "").trim();

  if (n) {
    if (!/^\d+$/.test(n)) return new Response("invalid report number", { status: 400 });
    const exact = await pdfPathStatusForReport(n);
    if (exact.status === "found") {
      try {
        return servePdf(exact.path);
      } catch {
        return new Response("could not read the PDF", { status: 500 });
      }
    }
    if (exact.status === "rejected") return new Response("indexed tailored CV is unavailable", { status: 404 });
  }

  if (application) {
    const exact = await resolveTailoredCv(undefined, application);
    if (exact) {
      try {
        return servePdf(exact);
      } catch {
        return new Response("could not read the PDF", { status: 500 });
      }
    }
  }

  if (!company) return new Response("company required", { status: 400 });
  const key = companySlug(company);
  if (!key) return new Response("no tailored CV found for this offer", { status: 404 });
  const { slug } = key;
  const dir = path.join(careerOpsRoot(), "output");

  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .filter((f) => matchesTailoredCv(f.toLowerCase(), slug))
      .filter((f) => isRegularContainedFile(path.join(dir, f), dir));
  } catch {
    return new Response("no output directory", { status: 404 });
  }
  if (!files.length) return new Response("no tailored CV found for this offer", { status: 404 });

  const sorted = sortNewestFirst(dir, files);
  if (!sorted.length) return new Response("no tailored CV found for this offer", { status: 404 });
  try {
    return servePdf(path.join(dir, sorted[0]));
  } catch {
    return new Response("could not read the PDF", { status: 500 });
  }
}
