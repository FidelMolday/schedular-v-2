import { requireActiveSession } from "@/lib/authz";
import { NextResponse } from "next/server";
import { generateReport, REPORT_DEFINITIONS } from "@/lib/data/reports";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ type: string }> }
) {
  const { type } = await params;
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "json";

  const def = REPORT_DEFINITIONS.find((d) => d.slug === type);
  if (!def) {
    return NextResponse.json({ error: `Unknown report type: ${type}` }, { status: 404 });
  }

  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const ownerId = actor.role === "org_owner" ? undefined : actor.id;
    const rows = await generateReport(type, ownerId);

    if (format === "csv") {
      const header = def.columns.map((c) => c.label).join(",");
      const body = rows
        .map((r) => def.columns.map((c) => {
          const v = r[c.key];
          if (v == null) return "";
          const s = String(v);
          return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(","))
        .join("\n");
      const csv = `${header}\n${body}`;
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${type}.csv"`,
        },
      });
    }

    if (format === "xlsx") {
      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(def.label);
      sheet.columns = def.columns.map((c) => ({ header: c.label, key: c.key, width: 20 }));
      rows.forEach((r) => sheet.addRow(r));
      const buffer = await workbook.xlsx.writeBuffer();
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${type}.xlsx"`,
        },
      });
    }

    // Default: JSON
    return NextResponse.json(rows);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
