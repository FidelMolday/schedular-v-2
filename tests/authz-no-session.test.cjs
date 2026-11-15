const assert = require("node:assert/strict");
const { test } = require("node:test");
const { NextRequest } = require("next/server");
process.env.AZURE_AD_TENANT_ID ??= "9f6e83db-7a61-4c31-a5d8-1df830f649bf";

// Replace the request session source before loading server entrypoints. The
// guard itself still performs its normal database re-read when a session id
// exists; this case verifies the no-session edge across all private exports.
const authPath = require.resolve("../auth.ts");
require(authPath);
require.cache[authPath].exports = { auth: async () => null };
require("next/headers").headers = async () => new Headers();

const actions = require("../lib/actions.ts");
const cases = [
  ["saveAvailabilityAction", () => actions.saveAvailabilityAction("project", "admin", [])],
  ["createProjectAction", () => actions.createProjectAction({})],
  ["updateProjectAction", () => actions.updateProjectAction("missing", {})],
  ["saveTemplateAction", () => actions.saveTemplateAction({ projectId: null })],
  ["cancelBookingAction", () => actions.cancelBookingAction("missing")],
  ["markBookingCompletedAction", () => actions.markBookingCompletedAction("missing")],
  ["previewAdminUnavailableAction", () => actions.previewAdminUnavailableAction("admin", "2026-01-01", "2026-01-02")],
  ["commitAdminUnavailableAction", () => actions.commitAdminUnavailableAction("admin", "2026-01-01", "2026-01-02")],
  ["previewDateShiftAction", () => actions.previewDateShiftAction("project", "2026-01-01", "2026-01-02", 1)],
  ["commitDateShiftAction", () => actions.commitDateShiftAction("project", "2026-01-01", "2026-01-02", 1)],
  ["sendTestAction", () => actions.sendTestAction("template", "to@example.test")],
  ["inviteAssociateAction", () => actions.inviteAssociateAction({ name: "No Session", email: "no@example.test" })],
  ["changeAdminRoleAction", () => actions.changeAdminRoleAction("target", "admin")],
  ["promoteToOrgOwnerAction", () => actions.promoteToOrgOwnerAction("target", "confirm")],
  ["deactivateAdminAction", () => actions.deactivateAdminAction("target")],
  ["reactivateAdminAction", () => actions.reactivateAdminAction("target")],
  ["saveAvailabilityRangesAction", () => actions.saveAvailabilityRangesAction("2026-01-01", [])],
  ["addParticipantAction", () => actions.addParticipantAction("project", "Name", "person@example.test")],
  ["sendInvitesNowAction", () => actions.sendInvitesNowAction("project")],
  ["removeParticipantAction", () => actions.removeParticipantAction("participant")],
  ["manuallyResolveFlaggedBookingAction", () => actions.manuallyResolveFlaggedBookingAction("booking", "admin")],
  ["createCertificationAction", () => actions.createCertificationAction("Name")],
  ["updateCertificationAction", () => actions.updateCertificationAction("id", "Name")],
  ["deleteCertificationAction", () => actions.deleteCertificationAction("id")],
  ["setAdminCertificationsAction", () => actions.setAdminCertificationsAction("admin", [])],
  ["setProjectCertificationRequirementsAction", () => actions.setProjectCertificationRequirementsAction("project", [])],
  ["createSessionTypeAction", () => actions.createSessionTypeAction("Name")],
  ["updateSessionTypeAction", () => actions.updateSessionTypeAction("id", "Name")],
  ["deleteSessionTypeAction", () => actions.deleteSessionTypeAction("id")],
  ["reactivateSessionTypeAction", () => actions.reactivateSessionTypeAction("id")],
  ["createZoomAccountAction", () => actions.createZoomAccountAction({})],
  ["setZoomAccountActiveAction", () => actions.setZoomAccountActiveAction("id", true)],
  ["deleteZoomAccountAction", () => actions.deleteZoomAccountAction("id")],
  ["syncZoomPoolAction", () => actions.syncZoomPoolAction()],
  ["getZoomPoolStatusAction", () => actions.getZoomPoolStatusAction()],
  ["updateNotificationPreferencesAction", () => actions.updateNotificationPreferencesAction(true)],
  ["getManageLinkAction", () => actions.getManageLinkAction("booking")],
];

const routeCases = [
  ["admins GET", require("../app/api/admins/route.ts").GET],
  ["analytics GET", () => require("../app/api/analytics/route.ts").GET(new Request("http://localhost/api/analytics"))],
  ["availability ranges GET", () => require("../app/api/availability-ranges/route.ts").GET(new Request("http://localhost/api/availability-ranges"))],
  ["calendar GET", () => require("../app/api/calendar/route.ts").GET(new Request("http://localhost/api/calendar"))],
  ["dashboard GET", () => require("../app/api/dashboard/admin/route.ts").GET(new Request("http://localhost/api/dashboard/admin?adminId=x"))],
  ["graph status GET", () => require("../app/api/graph-status/route.ts").GET(new Request("http://localhost/api/graph-status?adminId=x"))],
  ["participant import POST", () => require("../app/api/participants/import/route.ts").POST(new Request("http://localhost/api/participants/import", { method: "POST" }))],
  ["projects GET", require("../app/api/projects/route.ts").GET],
  ["reports GET", () => require("../app/api/reports/[type]/route.ts").GET(new Request("http://localhost/api/reports/bookings-summary"), { params: Promise.resolve({ type: "bookings-summary" }) })],
  ["commit unavailable POST", () => require("../app/api/reschedule/commit-admin-unavailable/route.ts").POST(new NextRequest("http://localhost/api/reschedule/commit-admin-unavailable", { method: "POST", body: "{}" }))],
  ["commit date shift POST", () => require("../app/api/reschedule/commit-date-shift/route.ts").POST(new NextRequest("http://localhost/api/reschedule/commit-date-shift", { method: "POST", body: "{}" }))],
  ["preview unavailable POST", () => require("../app/api/reschedule/preview-admin-unavailable/route.ts").POST(new NextRequest("http://localhost/api/reschedule/preview-admin-unavailable", { method: "POST", body: "{}" }))],
  ["preview date shift POST", () => require("../app/api/reschedule/preview-date-shift/route.ts").POST(new NextRequest("http://localhost/api/reschedule/preview-date-shift", { method: "POST", body: "{}" }))],
  ["super-admins GET", require("../app/api/super-admins/route.ts").GET],
  ["team availability GET", () => require("../app/api/team-availability/route.ts").GET(new Request("http://localhost/api/team-availability"))],
];

test("all private action and API entrypoints reject a missing session", async () => {
  const rejected = [];
  for (const [name, invoke] of cases) {
    let denied = false;
    try {
      const result = await invoke();
      denied = result === undefined || result?.ok === false || result?.status === 401 || result?.status === 403;
    } catch {
      denied = true;
    }
    assert.equal(denied, true, `${name} allowed an unauthenticated caller`);
    rejected.push(name);
  }
  for (const [name, invoke] of routeCases) {
    const response = await invoke();
    assert.ok([401, 403].includes(response.status), `${name} returned ${response.status} without a session`);
    rejected.push(name);
  }
  console.log("RAW no-session entrypoint matrix:", JSON.stringify({ attempted: rejected.length, rejected: rejected.length, pass: rejected.length, fail: 0 }));
});
