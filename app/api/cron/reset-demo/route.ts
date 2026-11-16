import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resetDemoProject } from "@/lib/demo";
import { isValidCronAuthorization } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isValidCronAuthorization(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[cron:reset-demo] START");
  const result = await resetDemoProject(db);
  console.log("[cron:reset-demo] DONE", JSON.stringify(result));
  return NextResponse.json(result);
}
