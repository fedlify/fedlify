/**
 * Phase 3: creating a site kit asks for the account password. Sends a wrong password only, so no kit is
 * created and the site token is not rotated. Needs E2E_EMAIL, E2E_PASSWORD and E2E_SITE_ID.
 */
import { expect, test } from "@playwright/test";

const { E2E_EMAIL: email, E2E_PASSWORD: password, E2E_SITE_ID: siteId } = process.env;

test("kit creation asks for the password and rejects a wrong one", async ({ page }) => {
  test.skip(!email || !password || !siteId, "E2E_EMAIL, E2E_PASSWORD and E2E_SITE_ID are required");
  await page.goto("/signin");
  await page.fill('input[autocomplete="email"]', email!);
  await page.fill('input[autocomplete="current-password"]', password!);
  await page.click('button[type="submit"]');
  await page.waitForURL(/studies/);
  await page.goto(`/sites/${siteId}`);
  await page.getByRole("tab", { name: "Startup kit" }).click();
  await page.getByRole("button", { name: "Create encrypted kit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Confirm your password to create a kit")).toBeVisible();
  await dialog.getByPlaceholder("Account password").fill("definitely-not-the-password");
  const response = page.waitForResponse((r) => r.url().includes("/join-package") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Create kit" }).click();
  expect((await response).status()).toBe(403);
  await expect(page.locator("code, pre").filter({ hasText: /^[a-z]+(-[a-z]+){6}$/ })).toHaveCount(0);
});
