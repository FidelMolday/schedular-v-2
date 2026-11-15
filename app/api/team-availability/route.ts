import { requireActiveSession, requireRole } from "@/lib/authz";
import { NextRequest, NextResponse } from "next/server";
import { getTeamAvailability, getTeamAvailabilityWithCapacity } from "@/lib/data/availability-ranges";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireRole(actor, ["org_owner", "super_admin"], () => null)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const from = params.get("from");
  const to = params.get("to");
  if (!from || !to) {
    return NextResponse.json({ error: "from and to query params are required (ISO date strings)" }, { status: 400 });
  }

  const scopeToOwnerId = actor.role === "org_owner" ? undefined : actor.id;
  const filters = {
    adminId: params.get("adminId") ?? undefined,
    projectId: params.get("projectId") ?? undefined,
    fromDate: from,
    toDate: to,
  };

  const mode = params.get("mode");
  if (mode === "remaining") {
    const data = await getTeamAvailabilityWithCapacity(scopeToOwnerId, filters);
    return NextResponse.json(data);
  }

  const data = await getTeamAvailability(scopeToOwnerId, filters);
  return NextResponse.json(data);
}
