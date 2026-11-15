import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { bulkImportParticipants } from "@/lib/data/participants";
import { requireActiveSession, requireProjectAccess } from "@/lib/authz";
import { getProjectBySlug } from "@/lib/data/projects";

export async function POST(req: NextRequest) {
  const actor = await requireActiveSession(() => null);
  if (!actor || !("id" in actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const projectId = formData.get("projectId") as string;
  const file = formData.get("file") as File | null;

  if (!projectId || !file) {
    return NextResponse.json({ error: "projectId and file are required" }, { status: 400 });
  }

  const project = await getProjectBySlug(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!await requireProjectAccess(actor, project.id, () => null)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const buffer = new Uint8Array(await file.arrayBuffer()) as any;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheet = workbook.getWorksheet(1);
    if (!sheet) {
      return NextResponse.json({ error: "No worksheet found in file" }, { status: 400 });
    }

    const headers: string[] = [];
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell, colNumber) => {
      headers[colNumber] = String(cell.value ?? "").toLowerCase().trim();
    });

    const nameCol = headers.findIndex((h) => h === "name");
    const emailCol = headers.findIndex((h) => h === "email");
    if (nameCol === -1 || emailCol === -1) {
      return NextResponse.json({ error: "File must have 'Name' and 'Email' columns" }, { status: 400 });
    }

    const customHeaderIndices = headers
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h && h !== "name" && h !== "email");

    const rows: { name: string; email: string; customFields?: Record<string, string> }[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const name = String(row.getCell(nameCol).value ?? "").trim();
      const email = String(row.getCell(emailCol).value ?? "").trim();
      if (!name && !email) return;

      const customFields: Record<string, string> = {};
      for (const { h, i } of customHeaderIndices) {
        const val = String(row.getCell(i).value ?? "").trim();
        if (val) customFields[h] = val;
      }

      rows.push({ name, email, customFields: Object.keys(customFields).length ? customFields : undefined });
    });

    const result = await bulkImportParticipants(project.id, rows);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to parse file: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    );
  }
}
