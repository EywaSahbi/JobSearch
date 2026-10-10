import { NextResponse } from "next/server";
import { detectClis } from "@/lib/clis";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ clis: detectClis() });
}
