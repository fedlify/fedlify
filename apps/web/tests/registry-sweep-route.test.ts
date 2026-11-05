import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sweep = vi.fn();
vi.mock("@/lib/registry-access", () => ({ sweepRegistry: (...a: unknown[]) => sweep(...a) }));

import { POST } from "@/app/api/webhooks/registry-sweep/route";
import { HarborError } from "@/lib/harbor-registry";

const SECRET = "unit-test-webhook-secret";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const call = (headers: Record<string, string> = {}, body = "{}") => POST(new Request("http://x/api", { method: "POST", body, headers }) as never);

describe("registry sweep webhook", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ARGO_WEBHOOK_SECRET = SECRET;
    sweep.mockResolvedValue({ pendingSwept: 1, revokingRetried: 0, orphansDeleted: 0, unexpected: 0, errors: 0 });
  });

  it("refuses unsigned, wrongly signed and unconfigured calls without sweeping", async () => {
    expect((await call())!.status).toBe(401);
    expect((await call({ "x-fedlify-signature": sign("{}", "other") }))!.status).toBe(401);
    expect((await call({ "x-fedlify-signature": sign("{} ") }))!.status).toBe(401);
    delete process.env.ARGO_WEBHOOK_SECRET;
    expect((await call({ "x-fedlify-signature": sign("{}") }))!.status).toBe(503);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("sweeps for a correctly signed call and returns counts only", async () => {
    const response = (await call({ "x-fedlify-signature": sign("{}") }))!;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { pendingSwept: 1, revokingRetried: 0, orphansDeleted: 0, unexpected: 0, errors: 0 } });
  });

  it("answers 502 when Harbor is unavailable", async () => {
    sweep.mockRejectedValue(new HarborError("Harbor is unreachable", "unavailable"));
    expect((await call({ "x-fedlify-signature": sign("{}") }))!.status).toBe(502);
  });
});
