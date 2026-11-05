/**
 * Phase 5, read-only and safe for a later live run: the public Get ready page and the two downloads. Needs no sign-in, creates
 * nothing and clicks nothing that changes state. NOT RUN (the phase forbade browsers and live hosts). Run later with
 * PLAYWRIGHT_BASE_URL set to the deployed site.
 */
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

test("Get ready page is public and covers Windows, macOS and Linux", async ({ page }) => {
  const response = await page.goto("/get-ready");
  expect(response?.status()).toBe(200);
  expect(page.url()).not.toContain("/signin");
  for (const id of ["windows", "macos", "linux", "architecture", "gpu", "headless"]) await expect(page.locator(`#${id}`)).toBeVisible();
  await expect(page.locator("#windows")).toContainText("WSL 2");
  await expect(page.locator("#windows")).toContainText("Not verified");
});

test("preflight downloads match the hashes printed on the page and send nothing", async ({ page, request }) => {
  await page.goto("/get-ready");
  const printed = await page.locator("pre").first().innerText();
  for (const [name, file] of [["preflight.sh", "/get-ready/preflight.sh"], ["preflight.ps1", "/get-ready/preflight.ps1"]] as const) {
    const res = await request.get(file);
    expect(res.status()).toBe(200);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    const body = await res.text();
    expect(printed).toContain(`${name}`);
    expect(printed).toContain(createHash("sha256").update(body).digest("hex"));
    expect(body).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|curl .*(-d|--data)/);
  }
});
