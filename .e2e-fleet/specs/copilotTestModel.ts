import type { Page } from '@playwright/test';

// User-selected Gemini models on the VPS, with 3.6 evaluated first. This is a test preference,
// not a claim of live response quality. No automatic fallback on transport or
// quota errors; choose another candidate only after an explicit measured decision.
export const COPILOT_TEST_MODEL_CANDIDATES = [
  '9router:ag/gemini-3.6-flash-high(high)',
  '9router:ag/gemini-3.7-flash-high(high)',
  '9router:ag/gemini-3.8-flash(high)',
] as const;
export const COPILOT_TEST_MODEL = process.env.COPILOT_E2E_MODEL || COPILOT_TEST_MODEL_CANDIDATES[0];
export async function pinCopilotTestModel(page: Page): Promise<void> {
  // Rewrite only this browser's preference READ response. Never persist a model
  // selection (changing the picker would write the profile on the server).
  await page.route('**/rest/v1/profiles?*', async route => {
    if (route.request().method() !== 'GET' || new URL(route.request().url()).searchParams.get('select') !== 'ui_preferences') return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const profile = await response.json();
    await route.fulfill({ response, json: { ...profile, ui_preferences: { ...profile.ui_preferences, copilotModel: COPILOT_TEST_MODEL } } });
  });
}
