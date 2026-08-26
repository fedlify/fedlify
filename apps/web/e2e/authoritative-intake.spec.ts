import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { createHash, randomUUID } from "node:crypto";

const prisma = new PrismaClient();
const password = "AuthoritativeIntakePassw0rd!";

test.describe.serial("authoritative intake API", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const email = `intake-${suffix}@fedlify.local`;
  let userId: string;
  let orgId: string;
  let studyId: string;

  test.beforeAll(async () => {
    const staleUsers = await prisma.user.findMany({ where: { email: { startsWith: "intake-", endsWith: "@fedlify.local" } }, select: { id: true } });
    const staleUserIds = staleUsers.map(({ id }) => id);
    if (staleUserIds.length) {
      await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: staleUserIds } } });
      await prisma.organization.deleteMany({ where: { createdById: { in: staleUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: staleUserIds } } });
    }
    const user = await prisma.user.create({ data: { name: "Intake Tester", email, passwordHash: await argon2.hash(password) } });
    const organization = await prisma.organization.create({ data: { name: `Intake ${suffix}`, slug: `intake-${suffix}`, createdById: user.id } });
    await prisma.orgMembership.create({ data: { orgId: organization.id, userId: user.id, role: "ORG_ADMIN" } });
    const study = await prisma.study.create({
      data: {
        orgId: organization.id,
        title: "Authoritative intake test",
        slug: `authoritative-intake-${suffix}`,
        createdById: user.id,
        members: { create: { userId: user.id, role: "PRINCIPAL_INVESTIGATOR" } }
      }
    });
    userId = user.id;
    orgId = organization.id;
    studyId = study.id;
  });

  test.afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { OR: [{ studyId }, { actorUserId: userId }] } });
    await prisma.organization.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  test("quarantines before model access, persists hashes only, and enforces idempotency", async ({ request }) => {
    const csrf = await request.get("/api/auth/csrf");
    const { csrfToken } = await csrf.json();
    await request.post("/api/auth/callback/credentials", { form: { csrfToken, email, password, json: "true", redirect: "false" } });

    const secret = "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-DO-NOT-USE\n-----END PRIVATE KEY-----";
    const payload = {
      requestText: "Use this credential while preparing the study.",
      studyContext: "Synthetic test only.",
      profile: "hosted",
      attachments: [{ name: "credential.pem", contentHash: createHash("sha256").update(secret).digest("hex"), content: secret, sourceVersion: "v1" }]
    };
    const headers = { "idempotency-key": `intake-${suffix}`, "if-match-version": "1" };
    const first = await request.post(`/api/v1/studies/${studyId}/intake`, { headers, data: payload });
    expect(first.status(), await first.text()).toBe(201);
    const body = await first.json();
    expect(body).toMatchObject({ authoritativeLayer: "Intake classifier", disposition: "QUARANTINE", modelConsulted: false });

    const replay = await request.post(`/api/v1/studies/${studyId}/intake`, { headers, data: payload });
    expect(replay.status()).toBe(200);
    expect((await replay.json()).requestId).toBe(body.requestId);

    const collision = await request.post(`/api/v1/studies/${studyId}/intake`, { headers, data: { ...payload, requestText: "Different request" } });
    expect(collision.status()).toBe(409);

    const [decision, workItem, execution] = await Promise.all([
      prisma.decisionRecord.findUnique({ where: { id: body.requestId } }),
      prisma.workItem.findUnique({ where: { id: body.workItemId } }),
      prisma.agentExecution.findFirst({ where: { workItemId: body.workItemId } })
    ]);
    expect(decision).not.toBeNull();
    expect(workItem).toMatchObject({ controlState: "QUARANTINED", status: "FAILED" });
    expect(execution).toBeNull();
    expect(JSON.stringify(decision)).not.toContain("SYNTHETIC-DO-NOT-USE");
  });
});
