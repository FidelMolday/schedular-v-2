import { requireActiveSession, requireRole } from "@/lib/authz";
import { listSuperAdmins } from "@/lib/data/admins";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireRole(actor, ["org_owner", "super_admin"], () => null)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const admins = await listSuperAdmins();
  return NextResponse.json(admins);
}
