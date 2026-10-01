/** Voice sub-screen wired to settings: pickers, speaking-rate slider, voice_tts_voice updates. */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { navigateTo } from "./helpers/nav";

const MOCK_SETTINGS = {
  assistant_name: "Pond",
  user_name: "Jerry",
  chat_provider: "llamafile",
  chat_model: "llama3.2",
  agent_memory_inject: false,
  prompt_style: "balanced",
  voice_wake_word: "hey goose",
  voice_wake_word_transcriptions: ["hey goose", "goose"],
  active_whisper_model: "ggml-base.bin",
  voice_tts_voice: "en_US-lessac-medium.onnx",
};

async function setupVoiceRoutes(
  page: Page,
  opts: {
    settings?: object;
    onUpdateSettings?: (body: unknown) => void;
  } = {},
) {
  const settings = opts.settings ?? MOCK_SETTINGS;

  // ── Core bootstrap routes ──────────────────────────────────
  await page.route("**/api/v1/health", (r) =>
    r.fulfill({ json: { status: "ok", version: "test" } }),
  );
  await page.route("**/api/v1/handshake", (r) =>
    r.fulfill({ json: { token: "e2e-test-token", session_id: "e2e-session" } }),
  );
  await page.route("**/api/v1/onboard/status", (r) =>
    r.fulfill({ json: { onboarded: true, current_step: "Completed", steps_completed: 9, total_steps: 9 } }),
  );
  await page.route("**/api/v1/onboard/complete", (r) =>
    r.fulfill({ json: { status: "completed" } }),
  );
  await page.route("**/api/v1/schedules", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/v1/sessions", (r) => r.fulfill({ json: { sessions: [] } }));
  await page.route("**/api/v1/sessions/*/messages", (r) => r.fulfill({ json: { messages: [] } }));
  await page.route("**/api/v1/devices", (r) => r.fulfill({ json: { devices: [] } }));
  await page.route("**/api/v1/memories", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/v1/skills", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/v1/prompts", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/v1/prompts/**", (r) =>
    r.fulfill({ json: { name: "balanced", content: "You are a helpful assistant.", is_system: true } }),
  );
  await page.route("**/api/v1/agent/extras", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/v1/agent/tools", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/v1/recipes", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/v1/transcribe", (r) => r.fulfill({ json: { text: "" } }));
  await page.route("**/api/v1/chat/stream", (r) =>
    r.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: 'data: {"done":true}\n\n' }),
  );
  await page.route("**/api/v1/tts", (r) => r.fulfill({ status: 503, json: { error: "off" } }));
  await page.route("**/api/v1/profiles", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/v1/extensions", (r) => r.fulfill({ json: { extensions: [] } }));
  await page.route("**/api/v1/extensions/**", (r) => r.fulfill({ json: { status: "ok" } }));
  await page.route("**/api/v1/marketplace", (r) => r.fulfill({ json: { extensions: [] } }));
  await page.route("**/api/v1/marketplace/*/install", (r) => r.fulfill({ status: 201, json: {} }));
  await page.route("**/api/v1/secrets/**", (r) => r.fulfill({ json: { keys: [] } }));
  await page.route("**/api/v1/logs", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/v1/usage", (r) => r.fulfill({ json: { total_tokens: 0, session_count: 0 } }));
  await page.route("**/api/v1/oauth/**", (r) => r.fulfill({ json: {} }));
  await page.route("**/api/v1/models/memory-status", (r) =>
    r.fulfill({ json: { total_mb: 8192, available_for_llm_mb: 4096, loaded_model: null } }),
  );
  await page.route("**/api/v1/models/download/progress", (r) =>
    r.fulfill({ json: { downloads: [] } }),
  );
  await page.route("**/api/v1/models/ollama", (r) => r.fulfill({ json: { models: [] } }));
  await page.route("**/api/v1/models/capabilities", (r) =>
    r.fulfill({ json: { thinking: false, vision: false, audio_input: false, context_window_tokens: 4096, structured_output: false } }),
  );
  await page.route("**/api/v1/models/active-roles", (r) =>
    r.fulfill({ json: { chat: null, tool: null, asr: null, tts: null, embedding: null } }),
  );
  await page.route("**/api/v1/models/scan", (r) => r.fulfill({ json: { found: 0 } }));
  await page.route("**/api/v1/models/*/*/activate", (r) => r.fulfill({ status: 204, body: "" }));
  await page.route("**/api/v1/models", (r) => r.fulfill({ json: { gguf: [], llamafile: [], whisper: [], tts: [], ollama: [], embedding: [] } }));
  await page.route("**/api/v1/voice/calibrate", (r) => r.fulfill({ status: 204, body: "" }));

  await page.route("**/api/v1/settings", async (r) => {
    if (r.request().method() === "GET") {
      return r.fulfill({ json: settings });
    }
    const body = r.request().postDataJSON();
    opts.onUpdateSettings?.(body);
    return r.fulfill({ json: { ...settings, ...body } });
  });
}

async function goToVoiceScreen(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("giap-section", "hub");
    localStorage.setItem("giap-force-hub", "1");
    localStorage.setItem("goosehub_route", "home");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForSelector(".ghub", { timeout: 10_000 });
  // The hub's icon rail is gone; Settings now lives in the drawer.
  await navigateTo(page, "Settings");
  await page.waitForSelector(".set", { timeout: 5_000 });
  await page.getByRole("button", { name: /^Voice$/ }).first().click();
  await page.waitForTimeout(600);
}

test.describe("Hub — Voice sub-screen wiring", () => {
  test("loads with settings: wake word and STT model populated", async ({ page }) => {
    await setupVoiceRoutes(page);
    await goToVoiceScreen(page);

    // .setcard__title, so sub-text with the same words doesn't collide.
    await expect(page.locator(".setcard__title", { hasText: "Listening" }).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".setcard__title", { hasText: "Speech-to-text" }).first()).toBeVisible({ timeout: 3_000 });
    await expect(page.locator(".setcard__title", { hasText: "Goose's voice" }).first()).toBeVisible({ timeout: 3_000 });

    await expect(page.getByText(/hey goose/i)).toBeVisible({ timeout: 5_000 });

    const sttSelect = page.getByRole("combobox", { name: /STT model/i });
    await expect(sttSelect).toBeVisible({ timeout: 3_000 });
    await expect(sttSelect).toHaveValue("ggml-base.bin");

    // The voice picker is a radiogroup, not a select: VoicePicker.tsx renders one
    // radio per installed voice so the accent grouping and the per-voice preview
    // button have somewhere to live. The configured voice is the checked one.
    const voiceGroup = page.getByRole("radiogroup", { name: "Voice" });
    await expect(voiceGroup).toBeVisible({ timeout: 3_000 });
    await expect(voiceGroup.getByRole("radio", { checked: true })).toBeVisible({ timeout: 3_000 });

    // "Speaking pace" on a 0.5x-2.0x scale, shown as a multiplier beside the
    // slider. It used to be "Speaking rate" as a percentage in a .hrange.
    const pace = page.getByRole("slider", { name: /speaking pace/i });
    await expect(pace).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText(/1\.00×/)).toBeVisible({ timeout: 3_000 });
  });

  test("TTS voice picker change calls updateSettings with correct voice", async ({ page }) => {
    let updatePayload: unknown = null;

    await setupVoiceRoutes(page, {
      onUpdateSettings: (body) => { updatePayload = body; },
    });
    await goToVoiceScreen(page);

    // Voice.tsx builds the list from api.listModels() filtered to TTS providers,
    // so a second voice has to exist in the catalogue before there is anything
    // to switch to. The default mock returns none, which left one radio and
    // nothing to click.
    await page.route("**/api/v1/models", (r) =>
      r.fulfill({
        json: {
          gguf: [], llamafile: [], whisper: [], ollama: [], embedding: [],
          tts: [],
          tts_kokoro: [{ name: "af_heart" }, { name: "am_michael" }],
        },
      }),
    );
    await page.reload();
    await goToVoiceScreen(page);

    const voiceGroup = page.getByRole("radiogroup", { name: "Voice" });
    await expect(voiceGroup).toBeVisible({ timeout: 5_000 });

    // Whichever one is not currently selected: the assertion is that choosing a
    // voice persists it, not which voice happens to sort first.
    const unchecked = voiceGroup.getByRole("radio", { checked: false }).first();
    await expect(unchecked).toBeVisible({ timeout: 5_000 });
    await unchecked.click();
    await page.waitForTimeout(500);

    expect(updatePayload).toBeTruthy();
    expect((updatePayload as Record<string, unknown>).voice_tts_voice).toBeTruthy();
    expect((updatePayload as Record<string, unknown>).voice_tts_voice)
      .not.toBe(MOCK_SETTINGS.voice_tts_voice);
  });

  test("speaking rate slider updates the displayed value", async ({ page }) => {
    await setupVoiceRoutes(page);
    await goToVoiceScreen(page);

    // The pace control reads in multiples of natural speed now, so the label is
    // "1.00×" rather than "100%". The slider's own value is still 0-200.
    const pace = page.getByRole("slider", { name: /speaking pace/i });
    await expect(pace).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/1\.00×/)).toBeVisible({ timeout: 3_000 });

    await pace.fill("120");
    await pace.dispatchEvent("input");
    await page.waitForTimeout(200);

    await expect(page.getByText(/1\.20×/)).toBeVisible({ timeout: 3_000 });
  });
});
