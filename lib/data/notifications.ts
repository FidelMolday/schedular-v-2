import { db } from "@/lib/db";
import { recordAudit } from "@/lib/data/audit";
import type { EmailCategory, EmailAudience, NotificationStatus } from "@prisma/client";
import { getActiveTemplate, renderTemplate, MOCK_PREVIEW_CONTEXT } from "@/lib/data/templates";
import { ALL_CATEGORIES } from "@/lib/template-utils";

/**
 * Lists recent notification logs, optionally scoped to the given owner's
 * projects. Matches the app-wide scoping convention: org_owner passes no
 * ownerId (sees all projects); super_admin / admin pass their own id.
 */
export async function listNotificationLogs(ownerId?: string, limit = 100) {
  const where = ownerId ? { project: { ownerId } } : {};
  return db.notificationLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export const CATEGORY_LABEL = new Map(ALL_CATEGORIES.map((c) => [c.value, c.label]));

export async function logNotification(input: {
  templateId?: string;
  category: EmailCategory;
  projectId?: string;
  recipientEmail: string;
  recipientRole: EmailAudience;
  subject: string;
  renderedBody: string;
  status: NotificationStatus;
  hoursBefore?: number;
  dedupKey?: string;
}) {
  return db.notificationLog.create({
    data: {
      templateId: input.templateId ?? null,
      category: input.category,
      projectId: input.projectId ?? null,
      recipientEmail: input.recipientEmail,
      recipientRole: input.recipientRole,
      subject: input.subject,
      renderedBody: input.renderedBody,
      status: input.status,
      hoursBefore: input.hoursBefore ?? null,
      dedupKey: input.dedupKey ?? null,
    },
  });
}

/**
 * Stubbed send — does NOT send a real email. Resolves the active template for the
 * given category, renders it with MOCK_PREVIEW_CONTEXT, and writes a log row with
 * status "test". This is the placeholder until Microsoft Graph mail-send is integrated.
 */
export async function sendTestEmail(
  templateId: string,
  recipientEmail: string,
  actor?: { id: string; name: string }
) {
  const template = await db.emailTemplate.findUniqueOrThrow({
    where: { id: templateId },
  });

  const rendered = renderTemplate(template, MOCK_PREVIEW_CONTEXT);

  const log = await logNotification({
    templateId: template.id,
    category: template.category,
    projectId: template.projectId ?? undefined,
    recipientEmail,
    recipientRole: template.audience,
    subject: rendered.subject,
    renderedBody: rendered.bodyHtml,
    status: "test",
  });

  // Audit: non-blocking, best-effort
  recordAudit({
    action: "notification_sent",
    actorType: "admin",
    actorId: actor?.id,
    actorLabel: actor?.name ?? "System",
    entityType: "NotificationLog",
    entityId: log.id,
    projectId: template.projectId ?? undefined,
    afterState: { category: template.category, recipientEmail, subject: rendered.subject },
  }).catch(() => {});

  return log;
}
