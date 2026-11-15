import { requireActiveSession, requireRole } from "@/lib/authz";
import { listAllAdmins } from "@/lib/data/admins";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor) || !requireRole(actor, ["org_owner", "super_admin"], () => null)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admins = await listAllAdmins();
  return NextResponse.json(admins);
}
