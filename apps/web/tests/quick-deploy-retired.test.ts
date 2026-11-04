import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/v1/studies/[studyId]/pipeline/quick-deploy/route";

describe("quick-deploy route", () => {
  it("is retired and returns 410 with guidance", async () => {
    const res = await POST();
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error.code).toBe("gone");
    expect(body.error.message).toMatch(/Projects/);
  });
});
