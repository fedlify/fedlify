import argon2 from "argon2";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const audit = vi.fn();
const findUser = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: (...a: unknown[]) => findUser(...a) } } }));

import { STEP_UP_MAX_FAILURES, verifyStepUp } from "@/lib/step-up";

const PASSWORD = "test-only-step-up-password";
let hash: string;
beforeAll(async () => {
  hash = await argon2.hash(PASSWORD, { memoryCost: 1024, timeCost: 2, parallelism: 1 });
});

let n = 0;
const attempt = (userId: string, password: unknown) =>
  verifyStepUp({ userId, password, action: "t.create", targetType: "X", request: {} as never });

describe("verifyStepUp rate limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUser.mockResolvedValue({ passwordHash: hash });
  });

  it("parallel guesses cannot exceed the attempt budget", async () => {
    const user = `parallel-${n++}`;
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => attempt(user, `guess-${i}`)));
    const verified = results.filter((r) => !r.ok && (r.response.status === 403)).length;
    const limited = results.filter((r) => !r.ok && r.response.status === 429).length;
    expect(verified).toBe(STEP_UP_MAX_FAILURES);
    expect(limited).toBe(30 - STEP_UP_MAX_FAILURES);
    // Only the budgeted attempts ever reached the database.
    expect(findUser).toHaveBeenCalledTimes(STEP_UP_MAX_FAILURES);
  });

  it("a correct password does not use up the budget, so successes never lock a user out", async () => {
    const user = `ok-${n++}`;
    for (let i = 0; i < STEP_UP_MAX_FAILURES * 3; i++) expect((await attempt(user, PASSWORD)).ok).toBe(true);
    // The full failure budget is still available afterwards.
    for (let i = 0; i < STEP_UP_MAX_FAILURES; i++) expect(((await attempt(user, "bad")) as { response: Response }).response.status).toBe(403);
    expect(((await attempt(user, PASSWORD)) as { response: Response }).response.status).toBe(429);
  });

  it("requests with no password at all do not spend the budget", async () => {
    const user = `empty-${n++}`;
    for (let i = 0; i < STEP_UP_MAX_FAILURES * 2; i++) expect(((await attempt(user, undefined)) as { response: Response }).response.status).toBe(403);
    expect((await attempt(user, PASSWORD)).ok).toBe(true);
  });
});
