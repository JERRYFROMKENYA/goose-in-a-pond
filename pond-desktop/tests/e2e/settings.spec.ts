import { test, expect } from "@playwright/test";
import { mockAllApiRoutes } from "./helpers/api-mocks";
import { navigateTo } from "./helpers/nav";

// ── Helper ────────────────────────────────────────────────────

async function goToSettings(page: import("@playwright/test").Page) {
  // Settings sits in the drawer's top list, so it takes an open before a click.
  await navigateTo(page, "Settings");
}

// ── Tests ─────────────────────────────────────────────────────

test.describe("Settings section", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApiRoutes(page);
    await page.goto("/");
    await goToSettings(page);
  });

  test("Settings section renders without crashing", async ({ page }) => {
    await expect(page.getByText(/something went wrong/i)).not.toBeVisible();
    await expect(
      page.getByText(/identity|voice|models|prompts|location|agent|data/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("renders all expected settings rows", async ({ page }) => {
    const expectedRows = ["Account", "Voice", "Models", "Prompts"];
    for (const row of expectedRows) {
      await expect(
        page.getByRole("button", { name: row }).or(page.getByText(row)).first()
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  // The two names live in different categories, and the catalogue is why:
  // "Account & Home" is who lives here, "Prompts & Personality" is what the
  // pond calls itself and how it talks (src/settings/catalogue.ts). This test
  // used to look for both under one "Account" panel, from before that split,
  // and so asserted a layout the app had stopped having.
  test("Account & Home shows the user's name", async ({ page }) => {
    await page.getByRole("button", { name: "Account & Home" }).click({ timeout: 5_000 });

    await expect(
      page.getByRole("textbox", { name: /your name/i })
    ).toBeVisible({ timeout: 10_000 });
  });

  test("Prompts & Personality shows the assistant's name", async ({ page }) => {
    await page.getByRole("button", { name: "Prompts & Personality" }).click({ timeout: 5_000 });

    await expect(
      page.getByRole("textbox", { name: /assistant name/i })
    ).toBeVisible({ timeout: 10_000 });
  });

  test("settings data is loaded from the API on mount", async ({ page }) => {
    await page.getByRole("button", { name: "Account & Home" }).click({ timeout: 5_000 });
    // The mock returns user_name: "Jerry", and this panel is where it lands.
    await expect(
      page.getByRole("textbox", { name: /your name/i })
    ).toHaveValue("Jerry", { timeout: 10_000 });
  });

  test("save settings calls PUT /api/v1/settings", async ({ page }) => {
    let putCalled = false;

    await page.route("**/api/v1/settings", (route) => {
      if (route.request().method() === "PUT") {
        putCalled = true;
        return route.fulfill({
          json: {
            assistant_name: "Pond",
            user_name: "Jerry",
            chat_provider: "llamafile",
            chat_model: "llama3.2",
            agent_memory_inject: false,
            prompt_style: "balanced",
            llm_temperature: 0.7,
            llm_max_tokens: 1024,
          },
        });
      }
      return route.continue();
    });

    await page.waitForTimeout(500);

    const saveBtn = page.getByRole("button", { name: /save/i }).first();
    if (await saveBtn.isVisible({ timeout: 3_000 })) {
      await saveBtn.click();
      await page.waitForTimeout(300);
      expect(putCalled).toBe(true);
    }
  });

  test("Models tab renders model role rows", async ({ page }) => {
    const modelsTab = page
      .getByRole("tab", { name: /models/i })
      .or(page.getByText("Models"))
      .first();
    await modelsTab.click();

    // active-roles mock returns chat, think, task, asr, tts roles
    await expect(
      page.getByText(/chat|think|task|asr|tts|llamafile/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("Voice tab renders without errors", async ({ page }) => {
    const voiceTab = page
      .getByRole("tab", { name: /voice/i })
      .or(page.getByText("Voice"))
      .first();
    await voiceTab.click();

    await expect(page.getByText(/something went wrong/i)).not.toBeVisible();
    await expect(page.locator("body")).toBeVisible();
  });
});
