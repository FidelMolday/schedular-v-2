import { NextResponse } from "next/server";
import { purgeAuditAndNotificationLogs } from "@/lib/data/audit-retention";
import { isValidCronAuthorization } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isValidCronAuthorization(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[cron:purge-audit-log] START");
  const results = await purgeAuditAndNotificationLogs();
  console.log("[cron:purge-audit-log] DONE", results);

  return NextResponse.json(results);
}
