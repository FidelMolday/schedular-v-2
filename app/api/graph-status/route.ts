import { requireActiveSession } from "@/lib/authz";
import { getOwnerGraphStatus } from "@/lib/graph/tokens";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const adminId = url.searchParams.get("adminId");
  if (!adminId) {
    return Response.json({ status: null }, { status: 400 });
  }

  // Scope: admins can only check their own graph status;
  // super_admin and org_owner can check any admin's.
  if (actor.role !== "org_owner" && actor.role !== "super_admin" && actor.id !== adminId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const status = await getOwnerGraphStatus(adminId).catch(() => null);
  if (!status) return Response.json({ status: "token_error" });

  if (status.connected) return Response.json({ status: "connected" });
  return Response.json({ status: status.reason });
}
