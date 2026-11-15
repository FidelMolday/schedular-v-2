import { db } from "@/lib/db";
import { requireActiveSession } from "@/lib/authz";
import { getAdminDashboardData } from "@/lib/data/dashboard";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminId = request.nextUrl.searchParams.get("adminId");
  if (!adminId) {
    return NextResponse.json({ error: "adminId is required" }, { status: 400 });
  }

  // Scope: admins can only view their own dashboard;
  // org_owner can view any admin's dashboard; super_admin can view any admin's
  // dashboard but only sees data scoped to their own projects.
  // Mirrors the dashboard page logic at app/admin/dashboard/page.tsx:51.
  const isSelf = actor.id === adminId;
  if (actor.role !== "org_owner" && actor.role !== "super_admin" && !isSelf) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // super_admin viewing another admin's dashboard: must be assigned to one of
  // the super_admin's own projects to be in scope (data is ownerId-scoped).
  if (actor.role === "super_admin" && !isSelf) {
    const inScope = await db.projectAdmin.findFirst({
      where: { adminId, project: { ownerId: actor.id } },
      select: { id: true },
    });
    if (!inScope) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const data = await getAdminDashboardData(adminId, {
    ownerId: actor.role === "super_admin" ? actor.id : undefined,
    // Self-dashboards include owned-but-not-assigned projects so the list
    // matches the Projects page (owner rule). Plain admins own nothing, so
    // this is a no-op for them.
    includeOwned: isSelf,
  });
  if (!data) {
    return NextResponse.json({ error: "Admin not found" }, { status: 404 });
  }
  return NextResponse.json(data);
}
