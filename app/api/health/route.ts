import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.admin.count();
    return NextResponse.json({ status: "ok", database: "connected" });
  } catch (err: unknown) {
    console.error("[health] database probe failed:", err);
    return NextResponse.json(
      { status: "error", database: "unreachable", message: "Database unavailable" },
      { status: 503 }
    );
  }
}
