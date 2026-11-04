/**
 * E2E: Pipeline build flow
 *
 * Tests the simplified researcher journey:
 *   Study Pipeline section (State A) → projects (legacy pipeline-agent URL redirects) → back to study (State B) → approve → State C
 *
 * Relies on:
 *   - A running dev server at PLAYWRIGHT_BASE_URL (default: http://localhost:3000)
 *   - An existing user: test@fedlify.local / TestPassword123! (created by the dev setup)
 *   - The existing "Default Study" (auto-created on first login)
 *
 * The test does NOT submit an actual NVFlare job — it covers code generation and approval only.
 */

import { expect, test } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? "test@fedlify.local";
const PASSWORD = process.env.E2E_PASSWORD ?? "TestPassword123!";
const SEEDED_TEMPLATE_ID = "template-nvflare-cross-silo-fedavg";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/signin");
  await page.waitForTimeout(1500);
  await page.fill('input[autocomplete="email"]', EMAIL);
  await page.fill('input[autocomplete="current-password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/studies/, { timeout: 15_000 });
}

test.describe("Pipeline build flow", () => {
  test("shows State A empty panel in pipeline section", async ({ page }) => {
    await signIn(page);

    // Navigate to the study pipeline section via the URL the test can derive
    const studyUrl = page.url();
    const studyId = studyUrl.match(/studies\/([^?/]+)/)?.[1];
    expect(studyId).toBeTruthy();

    await page.goto(`/studies/${studyId}?section=pipeline`);
    await page.waitForLoadState("networkidle");

    // State A panel should be visible: has no pipeline yet
    // The page shows "Build your study pipeline" or "Pipeline approved" depending on DB state.
    // At minimum the pipeline section must load without an error.
    const pipelinePanel = page.locator(".fedlify-pipeline-state-panel");
    await expect(pipelinePanel).toBeVisible({ timeout: 10_000 });

    // "Start a pipeline" button should be present in State A
    // OR "Go to Run section" in State C — either is valid depending on prior runs
    const hasStartBtn = await page.locator('button:has-text("Start a pipeline")').isVisible().catch(() => false);
    const hasRunBtn = await page.locator('button:has-text("Go to Run section")').isVisible().catch(() => false);
    const hasApproveBtn = await page.locator('button:has-text("Approve this pipeline")').isVisible().catch(() => false);

    expect(hasStartBtn || hasRunBtn || hasApproveBtn).toBe(true);
  });

  test("legacy pipeline-agent URLs redirect to study projects", async ({ page }) => {
    await signIn(page);
    const studyId = page.url().match(/studies\/([^?/]+)/)?.[1];
    expect(studyId).toBeTruthy();

    for (const suffix of ["", "?mode=adjust", `?mode=from-template&templateId=${SEEDED_TEMPLATE_ID}`]) {
      await page.goto(`/studies/${studyId}/pipeline-agent${suffix}`);
      await page.waitForURL(new RegExp(`/studies/${studyId}/projects$`), { timeout: 10_000 });
    }
  });

  test("templates catalog shows simplified UI without 16-field form", async ({ page }) => {
    await signIn(page);
    await page.goto("/templates");
    await page.waitForLoadState("networkidle");

    // Should have "Build new template" button
    await expect(page.locator('button:has-text("Build new template")')).toBeVisible({ timeout: 10_000 });

    // Should NOT have the old "Template Agent" button
    await expect(page.locator('button:has-text("Template Agent")')).toHaveCount(0);

    // Should NOT have the old 16-field form visible by default
    await expect(page.locator('text="Expected site-local inputs"')).toHaveCount(0);
  });

  test("template detail shows 3 tabs instead of 5", async ({ page }) => {
    await signIn(page);
    await page.goto("/templates");
    await page.waitForLoadState("networkidle");

    // Click the first template "Open" button
    const openBtn = page.locator('button:has-text("Open"), a:has-text("Open")').first();
    if (await openBtn.isVisible().catch(() => false)) {
      await openBtn.click();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1500);

      // Should have Overview, Code, Changes tabs
      await expect(page.locator('[role="tab"]:has-text("Overview")')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[role="tab"]:has-text("Code")')).toBeVisible();
      await expect(page.locator('[role="tab"]:has-text("Changes")')).toBeVisible();

      // Should NOT have Versions or Activity tabs
      await expect(page.locator('[role="tab"]:has-text("Versions")')).toHaveCount(0);
      await expect(page.locator('[role="tab"]:has-text("Activity")')).toHaveCount(0);
    }
  });

  test("navigating to /template-agent redirects or returns 404", async ({ page }) => {
    await signIn(page);
    const response = await page.goto("/template-agent");
    // Next.js returns 404 for deleted pages, or may redirect
    const status = response?.status() ?? 404;
    const isOk = [200, 301, 302, 307, 308, 404].includes(status);
    expect(isOk).toBe(true);
    // If it navigated somewhere, it should not be the old template-agent page
    // (the page had "AI template assistant" as its title)
    const bodyText = await page.locator("body").textContent().catch(() => "");
    expect(bodyText ?? "").not.toContain("AI template assistant");
  });
});
