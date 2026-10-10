import { pipelineSummary } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = pipelineSummary();
  return Response.json({
    inbox: s.inbox,
    applications: s.applications,
    root: s.root,
    rootExists: s.rootExists,
  });
}
