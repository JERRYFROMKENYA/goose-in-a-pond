import { test, expect } from "@playwright/test";
import { mockAllApiRoutes } from "./helpers/api-mocks";
import { navigateTo } from "./helpers/nav";

test("Hub shell renders", async ({ page }) => {
  await mockAllApiRoutes(page);
  // A persisted "hub" is coerced to "dashboard" unless giap-force-hub is set; no UI entry exists.
  await page.addInitScript(() => {
    localStorage.setItem("giap-section", "hub");
    localStorage.setItem("giap-force-hub", "1");
    localStorage.setItem("goosehub_route", "home");
  });
  await page.goto("/");

  await expect(page.locator(".ghub")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[aria-label="Open menu"]')).toBeVisible();

  await expect(page.locator(".dash")).toBeVisible();
});

test("Hub rail navigation works", async ({ page }) => {
  await mockAllApiRoutes(page);
  await page.addInitScript(() => {
    localStorage.setItem("giap-section", "hub");
    localStorage.setItem("giap-force-hub", "1");
    localStorage.setItem("goosehub_route", "home");
  });
  await page.goto("/");

  await expect(page.locator(".ghub"), "Hub shell renders").toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".dash"), "Home view renders").toBeVisible();

  // The drawer's "Schedules" maps to the hub's "routines" route.
  await navigateTo(page, "Schedules");
  await expect(page.locator(".view-title")).toHaveText("Routines");

  await navigateTo(page, "Settings");
  await expect(page.locator(".view-title")).toHaveText("Settings");

  await navigateTo(page, "Home");
  await expect(page.locator(".dash")).toBeVisible();
});

test("Hub route persists to localStorage", async ({ page }) => {
  await mockAllApiRoutes(page);
  await page.addInitScript(() => {
    localStorage.setItem("giap-section", "hub");
    localStorage.setItem("giap-force-hub", "1");
    localStorage.setItem("goosehub_route", "home");
  });
  await page.goto("/");

  await expect(page.locator(".ghub")).toBeVisible({ timeout: 10_000 });

  // Schedules also pins the section-to-route mapping: the hub stores its own route name.
  await navigateTo(page, "Schedules");
  await expect(page.locator(".view-title")).toHaveText("Routines");

  const stored = await page.evaluate(() => localStorage.getItem("goosehub_route"));
  expect(stored).toBe("routines");
});

/** The tile sends the switch, then reads the device back; the value line changing is that read. */
test("Device tile toggles state in place", async ({ page }) => {
  await mockAllApiRoutes(page);
  await page.addInitScript(() => {
    localStorage.setItem("giap-section", "hub");
    localStorage.setItem("giap-force-hub", "1");
    localStorage.setItem("goosehub_route", "home");
  });
  await page.goto("/");

  await expect(page.locator(".ghub")).toBeVisible({ timeout: 10_000 });
  const tile = page.locator('[data-hook="home-controls"] .hcc__tile').first();
  await expect(tile).toBeVisible({ timeout: 8_000 });

  // Wait for the first read: an unanswered tile opens the sheet instead of switching.
  await expect(tile.locator(".hcc__value")).toHaveText("Off", { timeout: 5000 });
  await tile.click();
  await expect(tile.locator(".hcc__value")).toHaveText("On", { timeout: 5000 });
});
