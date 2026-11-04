/**
 * Regression test: the Code & run panes must not overlap on any stage, at common window widths.
 * Needs an existing project: E2E_EMAIL, E2E_PASSWORD, E2E_STUDY_ID. Optional E2E_SHOT_DIR saves screenshots.
 */
import { expect, test } from "@playwright/test";

const { E2E_EMAIL: email, E2E_PASSWORD: password, E2E_STUDY_ID: studyId, E2E_SHOT_DIR: shots } = process.env;

for (const width of [1300, 1440, 1728, 2000]) {
  test(`panes do not overlap at ${width}px`, async ({ page }) => {
    test.skip(!email || !password || !studyId, "E2E_EMAIL, E2E_PASSWORD and E2E_STUDY_ID are required");
    await page.setViewportSize({ width, height: 950 });
    await page.goto("/signin");
    await page.fill('input[autocomplete="email"]', email!);
    await page.fill('input[autocomplete="current-password"]', password!);
    await page.click('button[type="submit"]');
    await page.waitForURL(/studies/);
    await page.goto(`/studies/${studyId}/projects`);
    const stages = page.locator(".fedlify-ws-stage-main");
    await expect(stages).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await stages.nth(i).click();
      await page.waitForTimeout(800);
      const centre = (await page.locator(".fedlify-ws-centre").boundingBox())!;
      const side = (await page.locator(".fedlify-ws-side").first().boundingBox())!;
      const assistant = (await page.locator(".fedlify-ws-assistant").boundingBox())!;
      expect(centre.x).toBeGreaterThanOrEqual(side.x + side.width - 1);
      const stacked = assistant.y >= centre.y + centre.height - 1;
      if (!stacked) expect(centre.x + centre.width).toBeLessThanOrEqual(assistant.x + 1);
      // On the Code stage the three panes line up, top and bottom.
      if (i === 0 && !stacked) {
        const code = (await page.locator(".fedlify-ws-code").boundingBox())!;
        for (const pane of [side, assistant]) {
          expect(Math.abs(pane.y - code.y)).toBeLessThanOrEqual(2);
          expect(Math.abs(pane.height - code.height)).toBeLessThanOrEqual(2);
        }
        const inner = (await page.locator(".fedlify-ws-code .fedlify-monaco-frame").first().boundingBox())!;
        expect(inner.y + inner.height).toBeLessThanOrEqual(code.y + code.height + 2);
      }
      // Nothing inside the assistant may stick out of it.
      for (const button of await page.locator(".fedlify-ws-quick-list .ant-btn").all()) {
        const box = (await button.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(assistant.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(assistant.x + assistant.width + 1);
      }
      if (shots) await page.screenshot({ path: `${shots}/w${width}-s${i + 1}.png` });
    }
  });
}

test("assistant chat renders a live reply", async ({ page }) => {
  test.skip(!email || !password || !studyId || !shots, "needs credentials and E2E_SHOT_DIR");
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto("/signin");
  await page.fill('input[autocomplete="email"]', email!);
  await page.fill('input[autocomplete="current-password"]', password!);
  await page.click('button[type="submit"]');
  await page.waitForURL(/studies/);
  await page.goto(`/studies/${studyId}/projects`);
  await page.locator(".fedlify-ws-composer .ant-segmented-item", { hasText: "Ask" }).click();
  const box = page.locator('textarea[aria-label="Message to the assistant"]');
  await box.fill("List in three short bullets what model.py does, with **bold** key terms.");
  await box.press("Enter");
  await expect(page.locator(".fedlify-ws-msg.is-assistant .fedlify-ws-msg-text").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(12_000);
  await page.screenshot({ path: `${shots}/chat.png` });
});

