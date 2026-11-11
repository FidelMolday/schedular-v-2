const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireAzureTenantId(value: string | undefined): string {
  const tenantId = value?.trim();
  if (!tenantId || !TENANT_UUID.test(tenantId)) {
    throw new Error("AZURE_AD_TENANT_ID must be set to a valid tenant UUID; Microsoft sign-in is disabled.");
  }
  return tenantId;
}

export function azureTenantIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${requireAzureTenantId(tenantId)}/v2.0`;
}
