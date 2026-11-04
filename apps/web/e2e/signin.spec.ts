/** Regression test: sign-in must reach the app every time, not bounce back to /signin. Needs E2E_EMAIL and E2E_PASSWORD. */
import { expect, test } from "@playwright/test";

const { E2E_EMAIL: email, E2E_PASSWORD: password } = process.env;

for (let attempt = 1; attempt <= 15; attempt++) {
  test(`sign-in reaches the app, attempt ${attempt}`, async ({ page }) => {
    test.skip(!email || !password, "E2E_EMAIL and E2E_PASSWORD are required");
    await page.goto("/signin");
    await page.fill('input[autocomplete="email"]', email!);
    await page.fill('input[autocomplete="current-password"]', password!);
    await page.click('button[type="submit"]');
    await page.waitForURL(/studies/, { timeout: 20_000 });
    await page.waitForTimeout(1000);
    await expect(page).not.toHaveURL(/signin/);
  });
}

test("sign-in ignores an external callback URL", async ({ page }) => {
  test.skip(!email || !password, "E2E_EMAIL and E2E_PASSWORD are required");
  await page.goto("/signin?callbackUrl=" + encodeURIComponent("https://example.com/"));
  await page.fill('input[autocomplete="email"]', email!);
  await page.fill('input[autocomplete="current-password"]', password!);
  await page.click('button[type="submit"]');
  await page.waitForURL(/studies/, { timeout: 20_000 });
  expect(new URL(page.url()).hostname).not.toBe("example.com");
});
