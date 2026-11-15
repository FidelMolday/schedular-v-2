import { requireActiveSession } from "@/lib/authz";
import { db } from "@/lib/db";
import { commitAdminUnavailableAction } from "@/lib/actions";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { adminId, fromDate, toDate } = await req.json();

  // Scope: org_owner / super_admin may target any admin; a regular admin
  // may only target an admin assigned to a project they own.
  if (actor.role !== "org_owner" && actor.role !== "super_admin") {
    const inScope = await db.projectAdmin.findFirst({
      where: { adminId, project: { ownerId: actor.id } },
      select: { id: true },
    });
    if (!inScope) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const result = await commitAdminUnavailableAction(adminId, fromDate, toDate);
  return NextResponse.json(result);
}
