import { ensureGiteaOrganization, isRuntimeConfigurationError } from "@/lib/gitea";
import { giteaPublicTemplateOrg, giteaStudyOrgPrefix } from "@/lib/runtime-config";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/slug";

export function studyGiteaOrgSlug(input: { studySlug: string; studyId: string }): string {
  const shortId = input.studyId.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "");
  const prefix = slugify(giteaStudyOrgPrefix()).slice(0, 20) || "fedlify-study";
  const maxOwnerLength = 39;
  const fixedLength = prefix.length + 1 + shortId.length + 1;
  const slugLength = Math.max(6, maxOwnerLength - fixedLength);
  const studySlug = slugify(input.studySlug).slice(0, slugLength).replace(/-+$/g, "") || "study";
  return `${prefix}-${studySlug}-${shortId}`;
}

export function publicTemplateOwner(): string {
  return giteaPublicTemplateOrg();
}

export async function ensurePublicTemplateWorkspace() {
  const owner = publicTemplateOwner();
  return ensureGiteaOrganization({
    owner,
    fullName: "Fedlify Public Templates",
    description: "Approved reusable Fedlify NVFLARE template repositories.",
    visibility: "limited"
  });
}

export async function ensureStudyGiteaWorkspace(input: { studyId: string; userId?: string }) {
  const study = await prisma.study.findUnique({
    where: { id: input.studyId },
    select: { id: true, title: true, slug: true }
  });
  if (!study) {
    const error = new Error("Study was not found.");
    error.name = "NotFoundError";
    throw error;
  }

  const owner = studyGiteaOrgSlug({ studySlug: study.slug, studyId: study.id });
  const existing = await prisma.giteaWorkspace.findUnique({ where: { studyId: study.id } });

  try {
    const org = await ensureGiteaOrganization({
      owner,
      fullName: `Fedlify Study: ${study.title}`,
      description: `Private GitOps workspace for Fedlify study ${study.title}.`,
      visibility: "private"
    });

    return prisma.giteaWorkspace.upsert({
      where: { studyId: study.id },
      create: {
        studyId: study.id,
        owner: org.owner,
        url: org.url,
        status: "ACTIVE",
        createdById: input.userId
      },
      update: {
        owner: org.owner,
        url: org.url,
        status: "ACTIVE",
        lastError: null
      }
    });
  } catch (error) {
    const message =
      isRuntimeConfigurationError(error) || error instanceof Error ? error.message : "Gitea study workspace could not be provisioned.";

    if (existing) {
      return prisma.giteaWorkspace.update({
        where: { id: existing.id },
        data: { status: "FAILED", lastError: message }
      });
    }

    return prisma.giteaWorkspace.create({
      data: {
        studyId: study.id,
        owner,
        status: "FAILED",
        lastError: message,
        createdById: input.userId
      }
    });
  }
}
