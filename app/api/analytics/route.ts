import { requireActiveSession } from "@/lib/authz";
import {
  getAdminUtilizationChart,
  getBookingVolumeTrend,
  getProjectHealthMetrics,
  type VolumeGranularity,
} from "@/lib/data/analytics";
import { listProjects } from "@/lib/data/projects";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 89;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Same scoping as the rest of the app: org_owner sees all projects;
  // admin / super_admin see only the projects they own.
  const ownerId = actor.role === "org_owner" ? undefined : actor.id;

  const url = new URL(request.url);
  const fromRaw = url.searchParams.get("from") ?? daysAgoISO(DEFAULT_RANGE_DAYS);
  const toRaw = url.searchParams.get("to") ?? todayISO();
  const granularityRaw = url.searchParams.get("granularity") ?? "week";
  const projectId = url.searchParams.get("projectId") || undefined;

  let fromDate = DATE_RE.test(fromRaw) ? fromRaw : daysAgoISO(DEFAULT_RANGE_DAYS);
  let toDate = DATE_RE.test(toRaw) ? toRaw : todayISO();
  if (fromDate > toDate) {
    const tmp = fromDate;
    fromDate = toDate;
    toDate = tmp;
  }
  const granularity: VolumeGranularity = granularityRaw === "month" ? "month" : "week";

  const [volume, utilization, health, projects] = await Promise.all([
    getBookingVolumeTrend({ ownerId, projectId, fromDate, toDate, granularity }),
    getAdminUtilizationChart({ ownerId, projectId }),
    getProjectHealthMetrics({ ownerId, projectId, fromDate, toDate }),
    listProjects(ownerId),
  ]);

  return NextResponse.json({
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    volume,
    utilization,
    health,
    meta: {
      fromDate,
      toDate,
      granularity,
      projectId: projectId ?? null,
    },
  });
}
