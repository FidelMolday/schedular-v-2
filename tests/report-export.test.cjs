const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@/lib/authz") return { requireActiveSession: async () => ({ id: "test-owner", role: "org_owner" }) };
  if (request === "@/lib/data/reports") return {
    REPORT_DEFINITIONS: [{ slug: "bookings-summary", label: "Bookings Summary", columns: [
      { key: "participantName", label: "Participant" }, { key: "count", label: "Count" }, { key: "dateKey", label: "Date" },
    ] }],
    generateReport: async () => [
      { participantName: '=HYPERLINK("http://evil.test","x")', count: -2, dateKey: "2026-11-15" },
      { participantName: "Alice", count: 3, dateKey: "2026-11-16" },
    ],
  };
  return originalLoad.call(this, request, parent, isMain);
};

const { GET } = require("../app/api/reports/[type]/route.ts");
const ExcelJS = require("exceljs");
const { csvCell, neutralizeSpreadsheetText, xlsxCellValue } = require("../lib/report-export.ts");

test("all dangerous spreadsheet-leading characters are prefixed only in string cells", () => {
  for (const value of ["=cmd", "+cmd", "-cmd", "@cmd", "\tcmd", "\rcmd"]) {
    assert.equal(neutralizeSpreadsheetText(value), `'${value}`);
    assert.equal(csvCell(value).includes(`'${value}`), true);
    assert.equal(xlsxCellValue(value, "participantName"), `'${value}`);
  }
  assert.equal(csvCell(-3), "-3");
  assert.equal(xlsxCellValue(-3, "count"), -3);
});

test("CSV neutralizes formula-like text and leaves ordinary values byte-identical", async () => {
  const response = await GET(new Request("http://localhost/api/reports/bookings-summary?format=csv"), { params: Promise.resolve({ type: "bookings-summary" }) });
  const csv = await response.text();
  const expected = `Participant,Count,Date\n"'=HYPERLINK(""http://evil.test"",""x"")",-2,2026-11-15\nAlice,3,2026-11-16`;
  assert.equal(csv, expected);
  console.log("RAW CSV negative:", csv.split("\n")[1]);
  console.log("RAW CSV positive:", csv.split("\n")[2]);
});

test("XLSX writes formula-like text as strings and preserves numbers and dates", async () => {
  const response = await GET(new Request("http://localhost/api/reports/bookings-summary?format=xlsx"), { params: Promise.resolve({ type: "bookings-summary" }) });
  assert.equal(response.status, 200, await response.clone().text());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const sheet = workbook.getWorksheet("Bookings Summary");
  assert.equal(sheet.getCell("A2").value, '\'=HYPERLINK("http://evil.test","x")');
  assert.equal(sheet.getCell("A2").type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell("B2").value, -2);
  assert.equal(sheet.getCell("B2").type, ExcelJS.ValueType.Number);
  assert.ok(sheet.getCell("C2").value instanceof Date);
  assert.equal(sheet.getCell("A3").value, "Alice");
  assert.equal(sheet.getCell("B3").value, 3);
  console.log("RAW XLSX negative:", JSON.stringify({ formulaText: sheet.getCell("A2").value, textType: sheet.getCell("A2").type, negativeNumber: sheet.getCell("B2").value, dateType: sheet.getCell("C2").type }));
  console.log("RAW XLSX positive:", JSON.stringify({ name: sheet.getCell("A3").value, count: sheet.getCell("B3").value }));
});
