import { requireActiveSession } from "@/lib/authz";
import { listProjects } from "@/lib/data/projects";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const ownerId = actor.role === "org_owner" || actor.role === "super_admin" ? undefined : actor.id;
  const projects = await listProjects(ownerId);
  return NextResponse.json(projects);
}
