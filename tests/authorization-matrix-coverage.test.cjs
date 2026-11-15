const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const actionMatrixPath = path.join(__dirname, "authorization-action-matrix.test.cjs");
const routeMatrixPath = path.join(__dirname, "authorization-route-matrix.test.cjs");

const actionAllowList = new Map([
  ["confirmBookingAction", "public participant booking submission"],
  ["joinWaitlistAction", "public participant waitlist enrollment"],
  ["getFilteredAvailabilityAction", "public booking-page availability lookup"],
]);
const manageActionAllowList = new Map([
  ["requestManagePin", "participant starts the PIN verification flow"],
  ["verifyManagePin", "participant proves the PIN before receiving a manage token"],
  ["participantCancelAction", "participant manage-token flow"],
  ["participantRescheduleAction", "participant manage-token flow"],
]);
const routeAllowList = new Map([
  ["GET /api/auth/[...nextauth]", "public authentication protocol handler"],
  ["POST /api/auth/[...nextauth]", "public authentication protocol handler"],
  ["GET /api/auth/setup-password", "one-time setup-token validation"],
  ["POST /api/auth/setup-password", "one-time setup-token password setup"],
  ["POST /api/auth/request-password-reset", "public generic password-reset request"],
  ["GET /api/participants/template", "public import-template download"],
  ["GET /api/health", "public health probe"],
  ["GET /api/cron/send-reminders", "Bearer CRON_SECRET guarded job"],
  ["GET /api/cron/purge-audit-log", "Bearer CRON_SECRET guarded job"],
  ["GET /api/cron/reset-demo", "Bearer CRON_SECRET guarded job"],
]);

function collectRouteFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? collectRouteFiles(full) : entry.name === "route.ts" ? [full] : [];
  });
}

test("every server entrypoint export is in the runtime matrix or an explicit public/token allow-list", () => {
  const actionSource = fs.readFileSync(path.join(root, "lib/actions.ts"), "utf8");
  const manageSource = fs.readFileSync(path.join(root, "app/manage/[bookingId]/actions.ts"), "utf8");
  const actionMatrixSource = fs.readFileSync(actionMatrixPath, "utf8");
  const routeMatrixSource = fs.readFileSync(routeMatrixPath, "utf8");
  const missing = [];
  const matrixActions = new Set([...actionSource.matchAll(/export async function (\w+)/g)].map((match) => match[1]));

  for (const name of matrixActions) {
    if (actionAllowList.has(name)) continue;
    if (!actionMatrixSource.includes(`"${name}"`)) missing.push(`lib/actions.ts:${name}`);
  }
  for (const match of manageSource.matchAll(/export async function (\w+)/g)) {
    if (!manageActionAllowList.has(match[1])) missing.push(`app/manage/[bookingId]/actions.ts:${match[1]}`);
  }

  const actualRoutes = new Set();
  for (const file of collectRouteFiles(path.join(root, "app/api"))) {
    const routePath = path.relative(path.join(root, "app/api"), file).replace(/\\/g, "/").replace(/\/route\.ts$/, "");
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g)) {
      actualRoutes.add(`${match[1]} /api/${routePath}`);
    }
    if (source.includes("export const { GET, POST } = handlers")) {
      actualRoutes.add(`GET /api/${routePath}`);
      actualRoutes.add(`POST /api/${routePath}`);
    }
  }
  for (const route of actualRoutes) {
    if (routeAllowList.has(route)) continue;
    if (!routeMatrixSource.includes(`"${route}"`)) missing.push(route);
  }

  const staleAllowList = [
    ...[...actionAllowList.keys()].filter((name) => !matrixActions.has(name)),
    ...[...routeAllowList.keys()].filter((name) => !actualRoutes.has(name)),
  ];
  console.log("RAW authorization coverage:", JSON.stringify({ actionExports: matrixActions.size, actionAllowList: actionAllowList.size, manageActionExports: [...manageSource.matchAll(/export async function (\w+)/g)].length, routeExports: actualRoutes.size, routeAllowList: routeAllowList.size, missing, staleAllowList }));
  assert.deepEqual(missing, []);
  assert.deepEqual(staleAllowList, []);
});
