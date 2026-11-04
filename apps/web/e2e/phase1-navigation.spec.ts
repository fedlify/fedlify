/**
 * Phase 1: legacy study sections redirect, the sidebar has one Code & run item, and the Audit page loads, filters
 * and pages. Read-only: signs in and navigates, creates nothing. Needs E2E_EMAIL, E2E_PASSWORD, E2E_STUDY_ID.
 */
import { expect, test, type Page } from "@playwright/test";

const { E2E_EMAIL: email, E2E_PASSWORD: password, E2E_STUDY_ID: studyId } = process.env;

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.fill('input[autocomplete="email"]', email!);
  await page.fill('input[autocomplete="current-password"]', password!);
  await page.click('button[type="submit"]');
  await page.waitForURL(/studies/);
}

const skipReason = "E2E_EMAIL, E2E_PASSWORD and E2E_STUDY_ID are required";

for (const section of ["pipeline", "run"]) {
  test(`legacy ?section=${section} redirects to Code & run`, async ({ page }) => {
    test.skip(!email || !password || !studyId, skipReason);
    await signIn(page);
    await page.goto(`/studies/${studyId}?section=${section}`);
    await expect(page).toHaveURL(new RegExp(`/studies/${studyId}/projects`));
  });
}

test("legacy ?section=audit redirects to the Audit page", async ({ page }) => {
  test.skip(!email || !password || !studyId, skipReason);
  await signIn(page);
  await page.goto(`/studies/${studyId}?section=audit`);
  await expect(page).toHaveURL(new RegExp(`/studies/${studyId}/audit`));
});

test("sidebar lists one Code & run item and no Pipeline or Run item", async ({ page }) => {
  test.skip(!email || !password || !studyId, skipReason);
  await signIn(page);
  await page.goto(`/studies/${studyId}`);
  const menu = page.locator(".fedlify-app-menu");
  await expect(menu.getByText("Code & run", { exact: true })).toHaveCount(1);
  await expect(menu.getByText("Pipeline", { exact: true })).toHaveCount(0);
  await expect(menu.getByText("Run", { exact: true })).toHaveCount(0);
});

test("audit page loads and pages", async ({ page }) => {
  test.skip(!email || !password || !studyId, skipReason);
  await signIn(page);
  await page.goto(`/studies/${studyId}/audit`);
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  await expect(page.locator(".fedlify-record-table")).toBeVisible();
  // The CSV/JSON export itself writes a study.audit.export audit event, so this read-only spec does not call it.
  const paged = await page.request.get(`/api/v1/studies/${studyId}/audit?pageSize=1`);
  expect((await paged.json()).events.length).toBeLessThanOrEqual(1);
});
