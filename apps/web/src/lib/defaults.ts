import type { PrismaClient } from "@prisma/client";
import { slugify } from "@/lib/slug";

export async function ensureUserDefaults(prisma: PrismaClient, userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true }
  });

  if (!user) return;

  const displayName = user.name ?? user.email?.split("@")[0] ?? "Fedlify User";
  const orgSlug = `personal-${user.id}`;

  await prisma.$transaction(async (tx) => {
    await tx.profile.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        displayName,
        institution: user.email?.split("@")[1] ?? null
      }
    });

    const organization = await tx.organization.upsert({
      where: { slug: orgSlug },
      update: {},
      create: {
        name: `${displayName}'s Workspace`,
        slug: orgSlug,
        domain: user.email?.split("@")[1] ?? null,
        createdById: user.id
      }
    });

    await tx.orgMembership.upsert({
      where: { orgId_userId: { orgId: organization.id, userId: user.id } },
      update: {},
      create: {
        orgId: organization.id,
        userId: user.id,
        role: "ORG_ADMIN"
      }
    });

    const existingDefaultStudy = await tx.study.findFirst({
      where: { orgId: organization.id, createdById: user.id, defaultStudy: true },
      select: { id: true }
    });

    if (existingDefaultStudy) {
      await tx.ethicsApproval.deleteMany({
        where: {
          studyId: existingDefaultStudy.id,
          status: "PENDING",
          approvalNumber: null,
          approvingBody: null,
          documentId: null,
          notes: {
            in: [
              "Ethics status must be recorded before release approval.",
              "Ethics approval must be completed before generated kits can be released."
            ]
          }
        }
      });
      return;
    }

    const study = await tx.study.create({
      data: {
        orgId: organization.id,
        title: "Default Study",
        slug: slugify("Default Study"),
        description: "Default governed study workspace.",
        goal: "Define a governed health-AI federated learning pilot.",
        researchQuestion: "Can participating sites coordinate a reproducible FL workflow without moving raw clinical data?",
        clinicalUseCase: "Health AI research workflow validation",
        population: "Site-described patient cohorts remain local to each institution.",
        dataModalities: "Site-provided modality summary",
        primaryOutcome: "Operational readiness and reproducible job execution",
        intendedUse: "Research and platform validation only",
        defaultStudy: true,
        createdById: user.id
      }
    });

    await tx.studyMember.createMany({
      data: [
        { studyId: study.id, userId: user.id, role: "PRINCIPAL_INVESTIGATOR" },
        { studyId: study.id, userId: user.id, role: "DATA_SCIENTIST" }
      ],
      skipDuplicates: true
    });

  });
}
