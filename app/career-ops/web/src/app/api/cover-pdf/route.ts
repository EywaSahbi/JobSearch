import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { resolveTailoredCover } from "@/lib/apply/cover";
import { companySlug } from "@/lib/company-slug.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const company = (req.nextUrl.searchParams.get("company") ?? "").trim();
  const application = (req.nextUrl.searchParams.get("application") ?? "").trim();

  if (!application && !companySlug(company)) return new Response("company required", { status: 400 });

  const file = await resolveTailoredCover(company, application);
  if (!file) return new Response("no tailored cover letter found for this offer", { status: 404 });

  try {
    const buf = fs.readFileSync(file);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${path.basename(file)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("could not read the PDF", { status: 500 });
  }
}
