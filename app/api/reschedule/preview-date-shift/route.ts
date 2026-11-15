import { requireActiveSession, requireProjectAccess } from "@/lib/authz";
import { previewDateShiftAction } from "@/lib/actions";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { projectId, fromDate, toDate, offsetDays } = await req.json();

  // Scope: org_owner / super_admin may target any project; a regular admin
  // may only target a project they own.
  if (!await requireProjectAccess(actor, projectId, () => null)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await previewDateShiftAction(projectId, fromDate, toDate, offsetDays);
  return NextResponse.json(result);
}
