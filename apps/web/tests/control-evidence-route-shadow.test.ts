import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findMany: vi.fn(async () => []), evidence: vi.fn(async () => []) }));
vi.mock("@/lib/prisma", () => ({ prisma: { evidenceRecord: { findMany: h.evidence }, quarantineRecord: { findMany: h.findMany } } }));
vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/rbac", () => ({ assertStudyAccess: async () => undefined }));

import { GET } from "@/app/api/v1/studies/[studyId]/control-plane/evidence/route";

describe("control-plane evidence list", () => {
  it("keeps assistant shadow quarantine rows out of the review queue", async () => {
    const res = (await GET({} as never, { params: Promise.resolve({ studyId: "s1" }) })) as Response;
    expect(res.status).toBe(200);
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { studyId: "s1", NOT: { sourceType: "ASSISTANT_TURN_SHADOW" } } }));
  });
});
