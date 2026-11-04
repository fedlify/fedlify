/**
 * Phase 0 link fix: the study summary's Pipeline and Run cards open the Code & run workspace, not a legacy section.
 * Read-only: signs in and clicks, creates nothing. Needs E2E_EMAIL, E2E_PASSWORD, E2E_STUDY_ID.
 */
import { expect, test } from "@playwright/test";

const { E2E_EMAIL: email, E2E_PASSWORD: password, E2E_STUDY_ID: studyId } = process.env;

for (const card of ["Pipeline", "Run"]) {
  test(`summary ${card} card opens Code & run`, async ({ page }) => {
    test.skip(!email || !password || !studyId, "E2E_EMAIL, E2E_PASSWORD and E2E_STUDY_ID are required");
    await page.goto("/signin");
    await page.fill('input[autocomplete="email"]', email!);
    await page.fill('input[autocomplete="current-password"]', password!);
    await page.click('button[type="submit"]');
    await page.waitForURL(/studies/);
    await page.goto(`/studies/${studyId}`);
    await page.getByLabel(`Open ${card}`, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/studies/${studyId}/projects`));
    expect(page.url()).not.toMatch(/section=(pipeline|run)/);
  });
}
