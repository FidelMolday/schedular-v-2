import { requireActiveSession } from "@/lib/authz";
import { checkAdminUnavailableAccess } from "@/lib/admin-unavailable-access";
import { commitAdminUnavailableAction } from "@/lib/actions";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { adminId, fromDate, toDate } = await req.json();

  if (!(await checkAdminUnavailableAccess(actor, adminId, fromDate, toDate))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await commitAdminUnavailableAction(adminId, fromDate, toDate);
  return NextResponse.json(result);
}
