const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { db } = require("../lib/db.ts");
const { AdminPrismaAdapter } = require("../lib/auth-adapter.ts");
const { linkAzureAdminAccount } = require("../lib/data/auth-invite.ts");
const { requireAzureTenantId, azureTenantIssuer } = require("../lib/azure-tenant.ts");

test("Azure account linking pins tenant and links an active invitation exactly once", async () => {
  const suffix = randomUUID();
  const tenantId = "11111111-2222-4333-8444-555555555555";
  const ids = [];
  async function addAdmin(label, isActive = true) {
    const row = await db.admin.create({
      data: {
        name: `Azure Test ${label}`,
        initials: "AT",
        email: `${label}.${suffix}@example.test`,
        isActive,
      },
    });
    ids.push(row.id);
    return row;
  }
  const attempt = (email, providerAccountId, tid = tenantId, account = {}) =>
    linkAzureAdminAccount({
      expectedTenantId: tenantId,
      tenantId: tid,
      email,
      providerAccountId,
      account: { type: "oidc", ...account },
    });

  try {
    assert.throws(() => requireAzureTenantId(undefined), /AZURE_AD_TENANT_ID must be set/);
    assert.equal(azureTenantIssuer(tenantId), `https://login.microsoftonline.com/${tenantId}/v2.0`);
    const invited = await addAdmin("invited");
    const disabled = await addAdmin("disabled", false);
    const secondIdentityAdmin = await addAdmin("second-identity");
    const firstIdentityAdmin = await addAdmin("first-identity");
    const forged = await attempt(invited.email, `sub-forged-${suffix}`, "99999999-2222-4333-8444-555555555555");
    console.log("RAW Azure wrong-tenant decision:", JSON.stringify(forged));
    assert.deepEqual(forged, { ok: false, reason: "tenant_mismatch" });

    const firstLink = await attempt(invited.email, `sub-linked-${suffix}`);
    const linkedLogin = await attempt(invited.email, `sub-linked-${suffix}`);
    const linkedLoginWithoutEmail = await attempt(undefined, `sub-linked-${suffix}`);
    const adapterUser = await AdminPrismaAdapter().getUserByAccount({
      provider: "azure-ad",
      providerAccountId: `sub-linked-${suffix}`,
    });
    console.log("RAW Azure first link / linked sign-in:", JSON.stringify({ firstLink, linkedLogin, linkedLoginWithoutEmail, adapterUserId: adapterUser?.id }));
    assert.deepEqual(firstLink, { ok: true, adminId: invited.id, linkedNow: true });
    assert.deepEqual(linkedLogin, { ok: true, adminId: invited.id, linkedNow: false });
    assert.deepEqual(linkedLoginWithoutEmail, { ok: true, adminId: invited.id, linkedNow: false });
    assert.equal(adapterUser?.id, invited.id);

    const uninvited = await attempt(`uninvited.${suffix}@example.test`, `sub-uninvited-${suffix}`);
    console.log("RAW Azure uninvited decision:", JSON.stringify(uninvited));
    assert.deepEqual(uninvited, { ok: false, reason: "uninvited" });

    const inactive = await attempt(disabled.email, `sub-disabled-${suffix}`);
    console.log("RAW Azure deactivated decision:", JSON.stringify(inactive));
    assert.deepEqual(inactive, { ok: false, reason: "deactivated" });

    const secondIdentity = await attempt(secondIdentityAdmin.email, `sub-first-${suffix}`);
    const rejectedSecondIdentity = await attempt(secondIdentityAdmin.email, `sub-second-${suffix}`);
    console.log("RAW Azure second-identity decision:", JSON.stringify({ secondIdentity, rejectedSecondIdentity }));
    assert.equal(secondIdentity.ok, true);
    assert.deepEqual(rejectedSecondIdentity, { ok: false, reason: "admin_already_linked" });

    const firstOwner = await attempt(firstIdentityAdmin.email, `sub-one-owner-${suffix}`);
    const rejectedSecondOwner = await attempt(invited.email, `sub-one-owner-${suffix}`);
    console.log("RAW Azure identity-to-two-admin decision:", JSON.stringify({ firstOwner, rejectedSecondOwner }));
    assert.equal(firstOwner.ok, true);
    assert.deepEqual(rejectedSecondOwner, { ok: false, reason: "identity_linked_to_other_admin" });
  } finally {
    await db.account.deleteMany({ where: { userId: { in: ids } } });
    await db.admin.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
});
