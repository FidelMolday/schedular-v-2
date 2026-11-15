import { db } from "@/lib/db";
import { recordAudit } from "@/lib/data/audit";
import type { EmailCategory, EmailAudience, Prisma } from "@prisma/client";
import { sanitizeTemplateHtml, type EmailTemplateWithDefault } from "@/lib/template-utils";

export type { EmailTemplateWithDefault };
export { PLACEHOLDER_TOKENS, MOCK_PREVIEW_CONTEXT, renderTemplate } from "@/lib/template-utils";

import { ALL_CATEGORIES } from "@/lib/template-utils";
import type { EmailCategoryTuple } from "@/lib/template-utils";

export const CATEGORIES_BY_VALUE = new Map<string, EmailCategoryTuple>(
  ALL_CATEGORIES.map((c) => [c.value, c])
);

async function listActiveByScope(projectId: string | null): Promise<Map<string, Prisma.EmailTemplateGetPayload<{}>>> {
  const rows = await db.emailTemplate.findMany({
    where: { projectId, isActive: true },
  });
  return new Map(rows.map((r) => [r.category, r]));
}

export async function listTemplates(projectId?: string): Promise<EmailTemplateWithDefault[]> {
  const scopeMap = projectId
    ? await listActiveByScope(projectId)
    : new Map<string, Prisma.EmailTemplateGetPayload<{}>>();
  const globalMap = await listActiveByScope(null);

  const result: EmailTemplateWithDefault[] = [];
  for (const cat of ALL_CATEGORIES) {
    const local = scopeMap.get(cat.value);
    const global = globalMap.get(cat.value);
    if (local) {
      result.push({ ...local, isGlobalDefault: false });
    } else if (global) {
      result.push({ ...global, isGlobalDefault: true });
    } else {
      result.push({
        id: "",
        category: cat.value as EmailCategory,
        audience: cat.defaultAudience as EmailAudience,
        projectId: projectId ?? null,
        subject: "",
        bodyHtml: "",
        version: 0,
        isActive: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        isGlobalDefault: true,
      });
    }
  }
  return result;
}

export async function getTemplateHistory(
  category: EmailCategory,
  projectId?: string
): Promise<Prisma.EmailTemplateGetPayload<{}>[]> {
  const where: Prisma.EmailTemplateWhereInput = { category };
  if (projectId !== undefined) {
    where.projectId = projectId;
  } else {
    where.projectId = null;
  }
  return db.emailTemplate.findMany({
    where,
    orderBy: { version: "desc" },
  });
}

export async function getActiveTemplate(
  category: EmailCategory,
  projectId?: string
): Promise<Prisma.EmailTemplateGetPayload<{}>> {
  if (projectId) {
    const projectTemplate = await db.emailTemplate.findFirst({
      where: { category, projectId, isActive: true },
    });
    if (projectTemplate) return projectTemplate;
  }

  const globalTemplate = await db.emailTemplate.findFirst({
    where: { category, projectId: null, isActive: true },
  });

  if (!globalTemplate) {
    throw new Error(
      `No active email template found for category "${category}". Ensure seed templates have been run.`
    );
  }

  return globalTemplate;
}

export async function getActiveTemplateByAudience(
  category: EmailCategory,
  audience: EmailAudience,
  projectId?: string
): Promise<Prisma.EmailTemplateGetPayload<{}>> {
  if (projectId) {
    const projectTemplate = await db.emailTemplate.findFirst({
      where: { category, audience, projectId, isActive: true },
    });
    if (projectTemplate) return projectTemplate;
  }

  const globalTemplate = await db.emailTemplate.findFirst({
    where: { category, audience, projectId: null, isActive: true },
  });

  if (!globalTemplate) {
    throw new Error(
      `No active email template found for category "${category}" audience "${audience}". Ensure seed templates have been run.`
    );
  }

  return globalTemplate;
}

export async function createTemplateVersion(input: {
  category: EmailCategory;
  audience: EmailAudience;
  projectId: string | null;
  subject: string;
  bodyHtml: string;
  actor?: { id: string; name: string };
}): Promise<Prisma.EmailTemplateGetPayload<{}>> {
  const result = await db.$transaction(async (tx) => {
    const currentActive = await tx.emailTemplate.findFirst({
      where: {
        category: input.category,
        projectId: input.projectId ?? null,
        isActive: true,
      },
      orderBy: { version: "desc" },
    });

    const nextVersion = currentActive ? currentActive.version + 1 : 1;

    if (currentActive) {
      await tx.emailTemplate.update({
        where: { id: currentActive.id },
        data: { isActive: false },
      });
    }

    const created = await tx.emailTemplate.create({
      data: {
        category: input.category,
        audience: input.audience,
        projectId: input.projectId ?? null,
        subject: input.subject,
        bodyHtml: sanitizeTemplateHtml(input.bodyHtml),
        version: nextVersion,
        isActive: true,
      },
    });

    return created;
  });

  // Audit: non-blocking, outside transaction
  recordAudit({
    action: result.version === 1 ? "template_created" : "template_updated",
    actorType: "admin",
    actorId: input.actor?.id,
    actorLabel: input.actor?.name ?? "System",
    entityType: "EmailTemplate",
    entityId: result.id,
    projectId: result.projectId ?? undefined,
    beforeState: result.version === 1 ? undefined : { previousVersion: result.version - 1 },
    afterState: { category: result.category, audience: result.audience, subject: result.subject, version: result.version },
  }).catch(() => {});

  return result;
}
