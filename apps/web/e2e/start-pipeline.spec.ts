/**
 * Start a pipeline screen: a four-card chooser, one page per path, a template browser (search, filters, ten rows per
 * page, details for the selected row only), the pipelines list, and no overlapping panels at common widths.
 * Read-only: it never creates a pipeline (the create routes are blocked and asserted untouched in the mocked test).
 * Needs E2E_EMAIL, E2E_PASSWORD, E2E_STUDY_ID and PLAYWRIGHT_BASE_URL (skips without credentials).
 * Optional E2E_SHOT_DIR saves screenshots.
 */
import { expect, test, type Page } from "@playwright/test";

const { E2E_EMAIL: email, E2E_PASSWORD: password, E2E_STUDY_ID: studyId, E2E_SHOT_DIR: shots } = process.env;
const NEEDS = "E2E_EMAIL, E2E_PASSWORD and E2E_STUDY_ID are required";

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
  test(`start screen shows four plain cards without overlap at ${width}px`, async ({ page }) => {
    test.skip(!email || !password || !studyId, NEEDS);
    await page.setViewportSize({ width, height: 950 });
    await signIn(page);
    await page.goto(`/studies/${studyId}/projects?start=1`);
    const screen = page.getByTestId("start-pipeline");
    await expect(screen).toBeVisible();
    await expect(page.getByRole("heading", { name: "Start a pipeline" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "How do you want to start?" })).toBeVisible();
    await expect(page.locator(".fedlify-start-steps li")).toHaveText([/1\s*Source/, /2\s*Data contract and run defaults/, /3\s*Name and create/]);

    // Four equal cards, no controls and no lists at this level.
    const ids = ["template", "assistant", "import", "copy"];
    for (const id of ids) await expect(page.getByTestId(`path-card-${id}`)).toBeVisible();
    await expect(page.getByTestId("start-choose").locator("input, select, textarea, ul, ol, table")).toHaveCount(0);
    const boxes: Box[] = [];
    for (const id of ids) boxes.push((await page.getByTestId(`path-card-${id}`).boundingBox())!);
    const outer = (await screen.boundingBox())!;
    boxes.forEach((box, i) => {
      expect(box.x).toBeGreaterThanOrEqual(outer.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
      boxes.slice(i + 1).forEach((other) => expect(overlaps(box, other)).toBe(false));
    });
    if (shots) await page.screenshot({ path: `${shots}/start-w${width}.png` });

    // Choosing a path shows only that path; the starter is always offered, and Back returns to the four cards.
    await page.getByTestId("path-card-template").click();
    await expect(page.getByTestId("path-template")).toBeVisible();
    await expect(page.getByTestId("path-assistant")).toHaveCount(0);
    const row = page.getByTestId("template-row").first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByTestId("fit-badge")).toBeVisible();
    expect(await page.getByTestId("template-row").count()).toBeLessThanOrEqual(10);
    await expect(page.getByTestId("template-details")).toHaveCount(0);
    const panel = (await page.getByTestId("path-template").boundingBox())!;
    for (const r of await page.getByTestId("template-row").all()) {
      const b = (await r.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(panel.x - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
    }
    await row.click();
    await expect(page.getByTestId("template-details")).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/start-template-w${width}.png` });
    await page.getByRole("button", { name: /Back$/ }).click();
    await expect(page.getByTestId("start-choose")).toBeVisible();
  });
}

test("describe page has one big box and a counter that does not overlap anything", async ({ page }) => {
  test.skip(!email || !password || !studyId, NEEDS);
  await page.setViewportSize({ width: 1300, height: 950 });
  await signIn(page);
  await page.goto(`/studies/${studyId}/projects?start=1`);
  await page.getByTestId("path-card-assistant").click();
  const box = page.getByLabel("What should the pipeline do");
  await expect(box).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await box.fill("Predict in-hospital mortality from admission labs and vitals.");
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled({ timeout: 30_000 });
  const counter = page.getByTestId("char-count");
  await expect(counter).toContainText("/ 2000");
  const [boxBox, counterBox, advancedBox] = [(await box.boundingBox())!, (await counter.boundingBox())!, (await page.getByText("Advanced", { exact: true }).boundingBox())!];
  expect(overlaps(boxBox, counterBox)).toBe(false);
  expect(overlaps(counterBox, advancedBox)).toBe(false);
  // The template choice is collapsed until Advanced is opened.
  await expect(page.getByLabel("Closest template")).toBeHidden();
  if (shots) await page.screenshot({ path: `${shots}/start-describe.png` });
});

test("wizard walks to the name step without creating anything", async ({ page }) => {
  test.skip(!email || !password || !studyId, NEEDS);
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  await page.goto(`/studies/${studyId}/projects?start=1`);
  await page.getByTestId("path-card-template").click();
  await expect(page.getByTestId("template-row").first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("template-row").filter({ hasText: "Mock template" }).first().click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("wizard-step-contract")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("wizard-step-create")).toBeVisible();
  // Too-short names block creation.
  await page.getByLabel("Pipeline name").fill("ab");
  await expect(page.getByRole("button", { name: "Create pipeline" })).toBeDisabled();
  if (shots) await page.screenshot({ path: `${shots}/start-wizard-name.png` });
});

test("100 mocked templates: at most ten rows, working search, no source reads until a row is selected", async ({ page }) => {
  test.skip(!email || !password || !studyId, NEEDS);
  await page.setViewportSize({ width: 1300, height: 950 });
  const sourceRequests: string[] = [];
  const createRequests: string[] = [];
  const templates = Array.from({ length: 100 }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    const unavailable = i % 20 === 19;
    return {
      id: `mock-${n}`,
      name: `Mock template ${n} ${i % 2 ? "logistic regression" : "xgboost survival"}`,
      description: null,
      scope: "PUBLIC_TEMPLATE",
      version: "1.0.0",
      spec: null,
      giteaOwner: unavailable ? null : "mock-owner",
      giteaRepo: unavailable ? null : `mock-repo-${n}`,
      currentApprovedVersion: unavailable ? null : { version: "1.0.0", gitCommit: "abcdef1234567", validationStatus: "PASSED", approvalStatus: "APPROVED", updatedAt: "2026-10-01T00:00:00Z" }
    };
  });
  await signIn(page);
  await page.route(/\/api\/v1\/pipeline-templates(\?|$)/, (route) => route.fulfill({ json: { templates } }));
  await page.route(/\/api\/v1\/pipeline-templates\/[^/?]+\/source/, (route) => {
    sourceRequests.push(route.request().url());
    return route.fulfill({ json: { files: [{ path: "fedlify-pipeline.json", content: JSON.stringify({ catalog: { task: "binary_classification", algorithm: "FedAvg", dataType: "tabular" } }) }] } });
  });
  // Safety net: the create routes must never be reached by this test.
  await page.route(/\/pipeline-projects\/(clone|import)/, (route) => {
    createRequests.push(route.request().url());
    return route.abort();
  });

  await page.goto(`/studies/${studyId}/projects?start=1`);
  await page.getByTestId("path-card-template").click();
  await expect(page.getByTestId("template-row").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("template-row")).toHaveCount(10);
  await expect(page.getByTestId("template-count")).toContainText("of 96 templates");
  await expect(page.getByRole("button", { name: "Show unavailable (5)" })).toBeVisible();
  expect(sourceRequests).toHaveLength(0);

  await page.getByLabel("Search templates").fill("Mock template 042");
  await expect(page.getByTestId("template-row")).toHaveCount(1);
  await expect(page.getByTestId("template-row").first()).toContainText("Mock template 042");
  await page.getByLabel("Search templates").fill("zzz-no-such-template");
  await expect(page.getByText("No template matches your search or filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear search and filters" }).click();
  await expect(page.getByTestId("template-row")).toHaveCount(10);

  await page.getByRole("button", { name: "Show unavailable (5)" }).click();
  await expect(page.getByTestId("template-count")).toContainText("of 101 templates");
  await expect(page.getByTestId("template-row")).toHaveCount(10);
  expect(sourceRequests).toHaveLength(0);

  // Selecting one row reads that one template's source, and only that one.
  await expect(page.getByTestId("continue-hint")).toContainText("Select a template");
  await page.getByTestId("template-row").filter({ hasText: "Mock template" }).first().click();
  await expect(page.getByTestId("template-details")).toBeVisible();
  await expect(page.getByTestId("selected-chip")).toContainText("Selected:");
  await expect(page.getByTestId("continue-hint")).toHaveCount(0);
  await expect.poll(() => sourceRequests.length).toBe(1);
  expect(createRequests).toHaveLength(0);
  if (shots) await page.screenshot({ path: `${shots}/start-mocked-100.png` });
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
