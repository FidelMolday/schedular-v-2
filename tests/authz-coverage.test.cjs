const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const actionFiles = {
  "lib/actions.ts": [
    "saveAvailabilityAction", "createProjectAction", "confirmBookingAction", "updateProjectAction", "saveTemplateAction",
    "cancelBookingAction", "markBookingCompletedAction", "joinWaitlistAction", "claimWaitlistOfferAction",
    "previewAdminUnavailableAction", "commitAdminUnavailableAction", "previewDateShiftAction", "commitDateShiftAction",
    "sendTestAction", "inviteAssociateAction", "changeAdminRoleAction", "promoteToOrgOwnerAction", "deactivateAdminAction",
    "reactivateAdminAction", "saveAvailabilityRangesAction", "addParticipantAction", "sendInvitesNowAction",
    "removeParticipantAction", "manuallyResolveFlaggedBookingAction", "createCertificationAction", "updateCertificationAction",
    "deleteCertificationAction", "setAdminCertificationsAction", "setProjectCertificationRequirementsAction",
    "createSessionTypeAction", "updateSessionTypeAction", "deleteSessionTypeAction", "reactivateSessionTypeAction",
    "createZoomAccountAction", "setZoomAccountActiveAction", "deleteZoomAccountAction", "syncZoomPoolAction",
    "getZoomPoolStatusAction", "updateNotificationPreferencesAction", "getFilteredAvailabilityAction", "getManageLinkAction",
  ],
  "app/manage/[bookingId]/actions.ts": ["requestManagePin", "verifyManagePin", "participantCancelAction", "participantRescheduleAction"],
};

const publicActions = new Set([
  "lib/actions.ts::confirmBookingAction",
  "lib/actions.ts::joinWaitlistAction",
  "lib/actions.ts::getFilteredAvailabilityAction",
]);
const tokenActions = new Set([
  "lib/actions.ts::claimWaitlistOfferAction",
  "app/manage/[bookingId]/actions.ts::requestManagePin",
  "app/manage/[bookingId]/actions.ts::verifyManagePin",
  "app/manage/[bookingId]/actions.ts::participantCancelAction",
  "app/manage/[bookingId]/actions.ts::participantRescheduleAction",
]);
const roleActions = new Set([
  "createProjectAction", "changeAdminRoleAction", "promoteToOrgOwnerAction", "deactivateAdminAction", "reactivateAdminAction",
  "inviteAssociateAction", "createCertificationAction", "updateCertificationAction", "deleteCertificationAction",
  "setAdminCertificationsAction", "createSessionTypeAction", "updateSessionTypeAction", "deleteSessionTypeAction",
  "reactivateSessionTypeAction", "createZoomAccountAction", "setZoomAccountActiveAction", "deleteZoomAccountAction",
  "syncZoomPoolAction", "getZoomPoolStatusAction",
]);
const projectActions = new Set([
  "updateProjectAction", "saveTemplateAction", "cancelBookingAction", "markBookingCompletedAction",
  "previewAdminUnavailableAction", "commitAdminUnavailableAction", "previewDateShiftAction", "commitDateShiftAction",
  "sendTestAction", "addParticipantAction", "sendInvitesNowAction", "removeParticipantAction",
  "manuallyResolveFlaggedBookingAction", "setProjectCertificationRequirementsAction", "getManageLinkAction",
]);

const routeClasses = {
  "app/api/admins/route.ts:GET": "ROLE-RESTRICTED",
  "app/api/analytics/route.ts:GET": "PROJECT-SCOPED",
  "app/api/auth/request-password-reset/route.ts:POST": "PUBLIC",
  "app/api/auth/setup-password/route.ts:GET": "TOKEN-GUARDED",
  "app/api/auth/setup-password/route.ts:POST": "TOKEN-GUARDED",
  "app/api/auth/[...nextauth]/route.ts:GET": "PUBLIC",
  "app/api/auth/[...nextauth]/route.ts:POST": "PUBLIC",
  "app/api/availability-ranges/route.ts:GET": "STAFF",
  "app/api/calendar/route.ts:GET": "PROJECT-SCOPED",
  "app/api/cron/purge-audit-log/route.ts:GET": "TOKEN-GUARDED",
  "app/api/cron/reset-demo/route.ts:GET": "TOKEN-GUARDED",
  "app/api/cron/send-reminders/route.ts:GET": "TOKEN-GUARDED",
  "app/api/dashboard/admin/route.ts:GET": "PROJECT-SCOPED",
  "app/api/graph-status/route.ts:GET": "ROLE-RESTRICTED",
  "app/api/health/route.ts:GET": "PUBLIC",
  "app/api/participants/import/route.ts:POST": "PROJECT-SCOPED",
  "app/api/participants/template/route.ts:GET": "PUBLIC",
  "app/api/projects/route.ts:GET": "STAFF",
  "app/api/reports/[type]/route.ts:GET": "PROJECT-SCOPED",
  "app/api/reschedule/commit-admin-unavailable/route.ts:POST": "ROLE-RESTRICTED",
  "app/api/reschedule/commit-date-shift/route.ts:POST": "PROJECT-SCOPED",
  "app/api/reschedule/preview-admin-unavailable/route.ts:POST": "ROLE-RESTRICTED",
  "app/api/reschedule/preview-date-shift/route.ts:POST": "PROJECT-SCOPED",
  "app/api/super-admins/route.ts:GET": "ROLE-RESTRICTED",
  "app/api/team-availability/route.ts:GET": "ROLE-RESTRICTED",
};

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", ".next", "node_modules"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function discoverActions() {
  const files = walk(root).filter((file) => /\.(ts|tsx)$/.test(file));
  return files.flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    if (!/^\s*["']use server["'];/m.test(source)) return [];
    const rel = path.relative(root, file).replaceAll("\\", "/");
    return [...source.matchAll(/^export\s+async\s+function\s+(\w+)\s*\(/gm)].map((m) => `${rel}::${m[1]}`);
  });
}

function discoverRoutes() {
  return walk(path.join(root, "app")).filter((file) => file.endsWith(`${path.sep}route.ts`)).flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file).replaceAll("\\", "/");
    const methods = new Set([...source.matchAll(/^export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/gm)].map((m) => m[1]));
    const named = source.match(/export\s+const\s+\{\s*([^}]+)\s*\}\s*=\s*handlers/);
    if (named) for (const method of named[1].split(",").map((s) => s.trim())) methods.add(method);
    return [...methods].map((method) => `${rel}:${method}`);
  });
}

function validateCoverage(found, registered) {
  const missing = found.filter((name) => !registered.has(name));
  if (missing.length) throw new Error(`Missing authorization matrix coverage: ${missing.join(", ")}`);
  const stale = [...registered].filter((name) => !found.includes(name));
  if (stale.length) throw new Error(`Stale authorization matrix entries: ${stale.join(", ")}`);
}

function actionBody(key) {
  const [file, name] = key.split("::");
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const start = source.indexOf(`export async function ${name}(`);
  if (start < 0) throw new Error(`Missing action source for ${key}`);
  const next = source.indexOf("export async function ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test("matrix registry covers every use-server export and every route handler", () => {
  const actions = Object.entries(actionFiles).flatMap(([file, names]) => names.map((name) => `${file}::${name}`));
  const registered = new Set([...actions, ...Object.keys(routeClasses)]);
  const foundActions = discoverActions();
  const foundRoutes = discoverRoutes();
  validateCoverage(foundActions, new Set(actions));
  validateCoverage(foundRoutes, new Set(Object.keys(routeClasses)));

  const all = [...actions, ...Object.keys(routeClasses)];
  const classes = new Map(all.map((key) => {
    const actionName = key.split("::")[1];
    const policy = publicActions.has(key) || routeClasses[key] === "PUBLIC" ? "PUBLIC"
      : tokenActions.has(key) || routeClasses[key] === "TOKEN-GUARDED" ? "TOKEN-GUARDED"
        : roleActions.has(actionName) ? "ROLE-RESTRICTED"
          : projectActions.has(actionName) || routeClasses[key] === "PROJECT-SCOPED" ? "PROJECT-SCOPED"
            : "STAFF";
    return [key, policy];
  }));
  assert.ok([...classes.values()].every((value) => ["STAFF", "ROLE-RESTRICTED", "PROJECT-SCOPED", "PUBLIC", "TOKEN-GUARDED"].includes(value)));
  assert.equal(classes.size, 70);
  const counts = Object.fromEntries(["STAFF", "ROLE-RESTRICTED", "PROJECT-SCOPED", "PUBLIC", "TOKEN-GUARDED"].map((kind) => [kind, [...classes.values()].filter((value) => value === kind).length]));
  console.log("RAW coverage inventory:", JSON.stringify({
    actionFiles: Object.keys(actionFiles).length,
    actions: foundActions.length,
    routeHandlers: foundRoutes.length,
    routeFiles: walk(path.join(root, "app")).filter((file) => file.endsWith(`${path.sep}route.ts`)).length,
    registered: registered.size,
    classes: counts,
  }));
});

test("every non-public server action and authenticated route includes an active or scoped guard", () => {
  const guarded = /requireActiveSession|activeActorForRoles|requireRole|requireProjectAccess|requireBookingAccess|verifyWaitlistClaimToken/;
  for (const key of [...Object.entries(actionFiles).flatMap(([file, names]) => names.map((name) => `${file}::${name}`))]) {
    if (publicActions.has(key) || tokenActions.has(key)) continue;
    assert.match(actionBody(key), guarded, `${key} has no visible shared authorization guard`);
  }
  for (const [key, policy] of Object.entries(routeClasses)) {
    if (policy === "PUBLIC" || policy === "TOKEN-GUARDED") continue;
    const file = path.join(root, key.slice(0, key.lastIndexOf(":")));
    assert.match(fs.readFileSync(file, "utf8"), /requireActiveSession/, `${key} has no active-session guard`);
  }
});

test("coverage checker rejects an added unregistered action", () => {
  const found = [...discoverActions(), "lib/actions.ts::fakeUnguardedAction"];
  assert.throws(() => validateCoverage(found, new Set(Object.entries(actionFiles).flatMap(([file, names]) => names.map((name) => `${file}::${name}`)))), /fakeUnguardedAction/);
  console.log("RAW fake unguarded action rejection: PASS (missing authorization matrix coverage)");
});
