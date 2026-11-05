/**
 * Phase 4: Results is a table linking to Run detail; the run page loads, charts stored values or says they are
 * missing, and the code view refuses traversal. Read-only: signs in and issues GETs, creates nothing. Needs
 * E2E_EMAIL, E2E_PASSWORD, E2E_STUDY_ID. Set E2E_RUN_ID to also open a specific run (otherwise the first listed run is used).
 */
import { expect, test, type Page } from "@playwright/test";

const { E2E_EMAIL: email, E2E_PASSWORD: password, E2E_STUDY_ID: studyId, E2E_RUN_ID: runIdEnv } = process.env;
const skipReason = "E2E_EMAIL, E2E_PASSWORD and E2E_STUDY_ID are required";

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.fill('input[autocomplete="email"]', email!);
  await page.fill('input[autocomplete="current-password"]', password!);
  await page.click('button[type="submit"]');
  await page.waitForURL(/studies/);
}

async function firstRunId(page: Page): Promise<string | null> {
  if (runIdEnv) return runIdEnv;
  const body = await (await page.request.get(`/api/v1/studies/${studyId}/runs`)).json();
  return body.runs?.[0]?.id ?? null;
}

test("legacy ?section=results redirects to the Results table", async ({ page }) => {
  test.skip(!email || !password || !studyId, skipReason);
  await signIn(page);
  await page.goto(`/studies/${studyId}?section=results`);
  await expect(page).toHaveURL(new RegExp(`/studies/${studyId}/runs(\\?|$)`));
  await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
  await expect(page.locator(".fedlify-record-table")).toBeVisible();
});

test("run detail loads with its tabs and an honest Performance tab", async ({ page }) => {
  test.skip(!email || !password || !studyId, skipReason);
  await signIn(page);
  const id = await firstRunId(page);
  test.skip(!id, "the study has no runs");
  await page.goto(`/studies/${studyId}/runs/${id}`);
  for (const tab of ["Summary", "Performance", "Code"]) await expect(page.getByRole("tab", { name: tab })).toBeVisible();
  await page.getByRole("tab", { name: "Performance" }).click();
  await expect(page.locator('[data-testid="metrics-chart"], [data-testid="metrics-empty"]').first()).toBeVisible();
});

test("code view rejects path traversal", async ({ page }) => {
  test.skip(!email || !password || !studyId, skipReason);
  await signIn(page);
  const id = await firstRunId(page);
  test.skip(!id, "the study has no runs");
  const res = await page.request.get(`/api/v1/studies/${studyId}/runs/${id}/code?path=${encodeURIComponent("../../etc/passwd")}`);
  expect(res.status()).toBe(400);
});

test("an unknown run id in this study is a 404", async ({ page }) => {
  // Cross-study scoping (a run id from another study) is covered by the unit test "looks the job up within the study";
  // a live check would need a second study's run id, which this read-only spec does not assume.
  test.skip(!email || !password || !studyId, skipReason);
  await signIn(page);
  const res = await page.request.get(`/api/v1/studies/${studyId}/runs/does-not-exist`);
  expect(res.status()).toBe(404);
});

test("the Results table links each run to its detail page", async ({ page }) => {
  test.skip(!email || !password || !studyId, skipReason);
  await signIn(page);
  const id = await firstRunId(page);
  test.skip(!id, "the study has no runs");
  await page.goto(`/studies/${studyId}/runs`);
  await expect(page.locator(`a[href*="/studies/${studyId}/runs/${id}"]`).first()).toBeVisible();
});

test("Audit, Model and Logs tabs open for the roles that may see them", async ({ page }) => {
  test.skip(!email || !password || !studyId, skipReason);
  await signIn(page);
  const id = await firstRunId(page);
  test.skip(!id, "the study has no runs");
  await page.goto(`/studies/${studyId}/runs/${id}`);
  await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
  for (const tab of ["Model", "Audit", "Logs"]) {
    const el = page.getByRole("tab", { name: tab });
    if ((await el.count()) === 0) continue; // hidden for this role by design
    await el.click();
    await expect(page.getByRole("tabpanel").filter({ visible: true }).first()).toBeVisible();
  }
});
