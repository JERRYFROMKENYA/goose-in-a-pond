import { expect, type Page, type Locator } from "@playwright/test";

/** Destinations behind "Manage" rather than in the top list. */
const MANAGE_ITEMS = new Set([
  "Devices", "Mesh", "Pairing", "Schedules", "Context", "Skills",
  "Recipes", "Logs", "Models", "Prompts", "Extensions", "Faces",
]);

/** Opens the drawer and returns its "Go to" nav: scoped, as "Home" is also a room and trips strict mode. */
export async function openDrawer(page: Page): Promise<Locator> {
  await page.locator('[aria-label="Open menu"]').click();
  await expect(page.locator('[role="dialog"][aria-label="Menu"]')).toBeVisible({
    timeout: 10_000,
  });
  return page.getByRole("navigation", { name: "Go to" });
}

/** Open the drawer, expand the group holding `label` if it has one, and click it. */
export async function navigateTo(page: Page, label: string): Promise<void> {
  const goTo = await openDrawer(page);

  if (MANAGE_ITEMS.has(label)) {
    const manage = goTo.getByRole("button", { name: "Manage" });
    if ((await manage.getAttribute("aria-expanded")) !== "true") {
      await manage.click();
    }
  }
  if (label === "Chat" || label === "Voice") {
    const pond = goTo.getByRole("button", { name: "Pond" });
    if ((await pond.getAttribute("aria-expanded")) !== "true") {
      await pond.click();
    }
  }

  await goTo.getByRole("button", { name: label, exact: true }).click();
  await expect(page.locator('[role="dialog"][aria-label="Menu"]')).toHaveCount(0);
}
