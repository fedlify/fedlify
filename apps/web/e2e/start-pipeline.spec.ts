/**
 * Start a pipeline screen: four paths, the three-step wizard header, template cards with a fit badge and reason,
 * the pipelines list, and no overlapping panels at common widths. Read-only: it never creates a pipeline.
 * Needs E2E_EMAIL, E2E_PASSWORD, E2E_STUDY_ID and PLAYWRIGHT_BASE_URL (skips without credentials).
 * Optional E2E_SHOT_DIR saves screenshots.
 */
import { expect, test, type Page } from "@playwright/test";

const { E2E_EMAIL: email, E2E_PASSWORD: password, E2E_STUDY_ID: studyId, E2E_SHOT_DIR: shots } = process.env;

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.fill('input[autocomplete="email"]', email!);
  await page.fill('input[autocomplete="current-password"]', password!);
  await page.click('button[type="submit"]');
  await page.waitForURL(/studies/);
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

for (const width of [1300, 1728, 800]) {
  test(`start screen shows four paths without overlap at ${width}px`, async ({ page }) => {
    test.skip(!email || !password || !studyId, "E2E_EMAIL, E2E_PASSWORD and E2E_STUDY_ID are required");
    await page.setViewportSize({ width, height: 950 });
    await signIn(page);
    await page.goto(`/studies/${studyId}/projects?start=1`);
    const screen = page.getByTestId("start-pipeline");
    await expect(screen).toBeVisible();
    await expect(page.getByRole("heading", { name: "Start a pipeline" })).toBeVisible();
    await expect(page.locator(".fedlify-start-steps li")).toHaveText([/1\s*Source/, /2\s*Data contract and run defaults/, /3\s*Name and create/]);

    for (const id of ["template", "assistant", "import", "copy"]) await expect(page.getByTestId(`path-${id}`)).toBeVisible();

    // Template cards carry a fit badge with a reason (the starter is always offered).
    const card = page.getByTestId("template-card").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("fit-badge")).toBeVisible();
    await expect(card.getByTestId("fit-reason")).not.toBeEmpty();

    // No two path panels overlap, and none sticks out of the screen.
    await page.waitForTimeout(500);
    const boxes: Box[] = [];
    for (const id of ["template", "assistant", "import", "copy"]) boxes.push((await page.getByTestId(`path-${id}`).boundingBox())!);
    const outer = (await screen.boundingBox())!;
    boxes.forEach((box, i) => {
      expect(box.x).toBeGreaterThanOrEqual(outer.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
      boxes.slice(i + 1).forEach((other) => expect(overlaps(box, other)).toBe(false));
    });
    // Cards inside the template panel stay inside it.
    const panel = boxes[0];
    for (const c of await page.getByTestId("template-card").all()) {
      const b = (await c.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(panel.x - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
    }
    if (shots) await page.screenshot({ path: `${shots}/start-w${width}.png` });
  });
}

test("wizard walks to the name step without creating anything", async ({ page }) => {
  test.skip(!email || !password || !studyId, "E2E_EMAIL, E2E_PASSWORD and E2E_STUDY_ID are required");
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  await page.goto(`/studies/${studyId}/projects?start=1`);
  await expect(page.getByTestId("template-card").first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("template-card").first().click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("wizard-step-contract")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("wizard-step-create")).toBeVisible();
  // Too-short names block creation.
  await page.getByLabel("Pipeline name").fill("ab");
  await expect(page.getByRole("button", { name: "Create pipeline" })).toBeDisabled();
  if (shots) await page.screenshot({ path: `${shots}/start-wizard-name.png` });
});

test("pipelines list opens from the header and panes below do not overlap", async ({ page }) => {
  test.skip(!email || !password || !studyId, "E2E_EMAIL, E2E_PASSWORD and E2E_STUDY_ID are required");
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  await page.goto(`/studies/${studyId}/projects`);
  const button = page.getByRole("button", { name: /Pipelines \(/ });
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();
  const list = page.getByTestId("pipelines-list");
  await expect(list).toBeVisible();
  await expect(list.getByRole("columnheader", { name: "Lineage" })).toBeVisible();
  await expect(list.getByRole("button", { name: /^Open / }).first()).toBeVisible();
  await expect(list.getByRole("button", { name: /^Copy / }).first()).toBeVisible();
  await list.getByRole("button", { name: /^Open / }).first().click();
  await expect(page.locator(".fedlify-ws-stage-main")).toHaveCount(4);
});
