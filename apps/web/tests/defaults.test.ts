import { describe, expect, it, vi } from "vitest";
import { ensureUserDefaults } from "@/lib/defaults";

function fakePrisma() {
  const tx = {
    profile: { upsert: vi.fn() },
    organization: { upsert: vi.fn(async () => ({ id: "org1" })) },
    orgMembership: { upsert: vi.fn() },
    study: { create: vi.fn(), findFirst: vi.fn() },
    studyMember: { createMany: vi.fn() }
  };
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ id: "u1", email: "ana@hospital.org", name: "Ana" })) },
    $transaction: vi.fn(async (run: (t: typeof tx) => Promise<void>) => run(tx))
  };
  return { prisma, tx };
}

describe("ensureUserDefaults", () => {
  it("creates the profile and the personal workspace", async () => {
    const { prisma, tx } = fakePrisma();
    await ensureUserDefaults(prisma as never, "u1");
    expect(tx.profile.upsert).toHaveBeenCalledOnce();
    expect(tx.organization.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: "personal-u1" } }));
    expect(tx.orgMembership.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { orgId: "org1", userId: "u1", role: "ORG_ADMIN" } }));
  });

  it("never creates a study", async () => {
    const { prisma, tx } = fakePrisma();
    await ensureUserDefaults(prisma as never, "u1");
    await ensureUserDefaults(prisma as never, "u1");
    expect(tx.study.create).not.toHaveBeenCalled();
    expect(tx.studyMember.createMany).not.toHaveBeenCalled();
  });

  it("does nothing for an unknown user", async () => {
    const { prisma } = fakePrisma();
    prisma.user.findUnique.mockResolvedValueOnce(null as never);
    await ensureUserDefaults(prisma as never, "ghost");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
