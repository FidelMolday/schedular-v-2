import { requireActiveSession } from "@/lib/authz";
import { NextRequest, NextResponse } from "next/server";
import { getCalendarEvents } from "@/lib/data/dashboard";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const ownerId = actor.role === "org_owner" ? undefined : actor.id;

  const params = request.nextUrl.searchParams;
  const from = params.get("from");
  const to = params.get("to");
  if (!from || !to) {
    return NextResponse.json({ error: "from and to query params are required (ISO date strings)" }, { status: 400 });
  }
  const events = await getCalendarEvents({
    from: new Date(from),
    to: new Date(to),
    projectId: params.get("projectId") ?? undefined,
    adminId: params.get("adminId") ?? undefined,
    participantSearch: params.get("participantSearch") ?? undefined,
    ownerId,
  });
  return NextResponse.json(events);
}
