import { requireActiveSession } from "@/lib/authz";
import { listProjects, listProjectsForAdmin } from "@/lib/data/projects";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const projects = actor.role === "org_owner"
    ? await listProjects()
    : actor.role === "super_admin"
      ? await listProjects(actor.id)
      : await listProjectsForAdmin(actor.id);
  return NextResponse.json(projects);
}
