const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
let mocks = {};
Module._load = function (request, parent, isMain) {
  if (Object.hasOwn(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};

function loadFresh(path) {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  return require(path);
}

test("report, import, and health errors have generic bodies and unchanged statuses", async () => {
  const privateMessage = "DB_PASSWORD sentinel-stack-trace at database.internal";
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Participants").addRow(["Name", "Email"]);
  const workbookBytes = Buffer.from(await workbook.xlsx.writeBuffer());
  mocks = {
    "@/lib/authz": {
      requireActiveSession: async () => ({ id: "test-actor", role: "org_owner" }),
      requireProjectAccess: async () => true,
    },
    "@/lib/data/reports": {
      REPORT_DEFINITIONS: [{ slug: "bookings-summary", label: "Bookings", columns: [] }],
      generateReport: async () => { throw new Error(privateMessage); },
    },
    "@/lib/data/participants": { bulkImportParticipants: async () => { throw new Error(privateMessage); } },
    "@/lib/data/projects": { getProjectBySlug: async () => ({ id: "project-1" }) },
    "@/lib/db": { db: { admin: { count: async () => { throw new Error(privateMessage); } } } },
  };
  const report = loadFresh("../app/api/reports/[type]/route.ts");
  const importRoute = loadFresh("../app/api/participants/import/route.ts");
  const health = loadFresh("../app/api/health/route.ts");

  const reportResponse = await report.GET(new Request("http://localhost/api/reports/bookings-summary"), { params: Promise.resolve({ type: "bookings-summary" }) });
  const form = new FormData();
  form.set("projectId", "project-1");
  form.set("file", new Blob([workbookBytes]), "valid.xlsx");
  const importResponse = await importRoute.POST(new Request("http://localhost/api/participants/import", { method: "POST", body: form }));
  const healthResponse = await health.GET();
  const bodies = await Promise.all([reportResponse.json(), importResponse.json(), healthResponse.json()]);
  for (const [response, body, status, key] of [
    [reportResponse, bodies[0], 500, "error"],
    [importResponse, bodies[1], 400, "error"],
    [healthResponse, bodies[2], 503, "message"],
  ]) {
    assert.equal(response.status, status);
    assert.equal(typeof body[key], "string");
    assert.doesNotMatch(JSON.stringify(body), /DB_PASSWORD|sentinel-stack-trace|database\.internal|Error:/);
  }
  assert.deepEqual(bodies[0], { error: "Failed to generate report" });
  assert.deepEqual(bodies[1], { error: "Failed to parse file" });
  assert.deepEqual(bodies[2], { status: "error", database: "unreachable", message: "Database unavailable" });
});

test("import route preserves row-by-row spreadsheet validation messages", async () => {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Participants");
  sheet.addRow(["Name", "Email"]);
  sheet.addRow(["Missing email", ""]);
  sheet.addRow(["Bad address", "not-an-email"]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  let importedRows;
  mocks = {
    "@/lib/authz": {
      requireActiveSession: async () => ({ id: "test-actor", role: "org_owner" }),
      requireProjectAccess: async () => true,
    },
    "@/lib/data/participants": {
      bulkImportParticipants: async (_projectId, rows) => {
        importedRows = rows;
        return { imported: 0, skipped: 0, errors: [
          { row: 2, name: "Missing email", email: "", reason: "Invalid email address" },
          { row: 3, name: "Bad address", email: "not-an-email", reason: "Invalid email address" },
        ] };
      },
    },
    "@/lib/data/projects": { getProjectBySlug: async () => ({ id: "project-1" }) },
  };
  const importRoute = loadFresh("../app/api/participants/import/route.ts");
  const form = new FormData();
  form.set("projectId", "project-1");
  form.set("file", new Blob([bytes]), "participants.xlsx");
  const response = await importRoute.POST(new Request("http://localhost/api/participants/import", { method: "POST", body: form }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(importedRows.length, 2);
  assert.deepEqual(body.errors, [
    { row: 2, name: "Missing email", email: "", reason: "Invalid email address" },
    { row: 3, name: "Bad address", email: "not-an-email", reason: "Invalid email address" },
  ]);
});
