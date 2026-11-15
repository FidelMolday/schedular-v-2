import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession } from "@/lib/authz";
import { getAdminRanges } from "@/lib/data/availability-ranges";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const fromDate = request.nextUrl.searchParams.get("fromDate");
  const toDate = request.nextUrl.searchParams.get("toDate");

  if (!fromDate || !toDate) {
    return NextResponse.json({ error: "fromDate and toDate are required" }, { status: 400 });
  }

  const ranges = await getAdminRanges(actor.id, fromDate, toDate);
  return NextResponse.json(ranges);
}
