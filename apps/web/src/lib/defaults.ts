import type { PrismaClient } from "@prisma/client";

/**
 * Every account gets a profile and a personal workspace. It never gets a study: a person creates their own from
 * Study management ("Create your first study"), and people who are invited work in the study they were invited to.
 */
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
  });
}
