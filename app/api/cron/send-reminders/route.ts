import { NextResponse } from "next/server";
import { sendReminders } from "@/lib/data/reminders";
import { isValidCronAuthorization } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isValidCronAuthorization(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[cron:reminders] START");
  const results = await sendReminders();
  console.log("[cron:reminders] DONE", results);

  return NextResponse.json(results);
}
