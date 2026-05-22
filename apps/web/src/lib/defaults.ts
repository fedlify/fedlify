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
        hypothesis: "A governed federated workflow can coordinate reproducible health-AI training without centralizing raw clinical data.",
        secondaryObjectives: "Assess site onboarding, pipeline approval, run monitoring, and governed release promotion.",
        clinicalUseCase: "Health AI research workflow validation",
        studyDesign: "Federated health-AI validation study using site-local data and governed model training workflows.",
        population: "Site-described patient cohorts remain local to each institution.",
        eligibilityCriteria:
          "Participating sites enroll site-described cohorts that match the study population and apply local inclusion and exclusion rules before contributing to federated training.",
        dataModalities: "Site-provided modality summary",
        primaryOutcome: "Operational readiness and reproducible job execution",
        primaryEndpointDetails:
          "Operational readiness and reproducible job execution are assessed from approved run logs and aggregate outputs without transferring participant-level data.",
        secondaryOutcomes: "Site readiness, policy acceptance, pipeline validation, and release auditability.",
        sampleSizeRationale:
          "Pilot sample size is determined by participating site availability and local cohort suitability rather than centralized record transfer.",
        analysisPlan:
          "Analyze federated run logs, validation metrics, and approved aggregate artifacts against the primary endpoint and pre-specified operational checks.",
        dataHandlingPlan:
          "Participant-level data remains at each site. Fedlify stores governance metadata, approved pipeline artifacts, logs, and aggregate outputs only.",
        humanAiWorkflow: "Study teams review pipeline versions, run outputs, and releases before promotion.",
        fairnessPlan: "Sites should review cohort representation and subgroup performance before promoting releases.",
        disseminationPlan: "Share approved aggregate results and governed artifacts through Fedlify releases.",
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
