import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { login } from './auth';
import { chanChayTrenProduction, xacMinhBanBuild } from './buildAttestation';
import { COPILOT_TEST_MODEL, pinCopilotTestModel, waitForCopilotAvailability } from './copilotTestModel';
import { guiVaChoModel } from './copilotModelCycle';
import { createRoomPassBrowserGuard } from './copilotRoomPassGuard';

const DEMO = 'dddd0000-0000-4000-8000-000000000001';
const executeName = 'copilot_execute_room_pass_active_v1';
const previewName = 'copilot_preview_room_pass_active_v1';

// Explicitly invoked by Task17's operator while the owned fixture and DEMO-only
// expiring flag are live. No fixture setup, flag mutation or credential copying here.
test('owned room-pass proposal waits for click; cancellation preserves state', async ({ page }) => {
  test.setTimeout(180_000);
  chanChayTrenProduction();
  const path = process.env.FLEET_ROOM_PASS_JOURNAL;
  expect(Boolean(path), 'Task17 ownership journal is required').toBe(true);
  const run = JSON.parse(readFileSync(path!, 'utf8'));
  expect(run.organizationId === DEMO && run.status === 'accepting'
    && run.fixtures?.listing?.organization_id === DEMO
    && /^[0-9a-f-]{36}$/.test(run.fixtures?.listing?.id)
    && run.controls?.current?.state === 'enabled'
    && run.controls?.current?.canary_org === DEMO
    && Date.parse(run.controls.current.expires_at) > Date.now() + 180_000,
  'Owned DEMO fixture and bounded canary must be ready').toBe(true);
  const listingId: string = run.fixtures.listing.id;
  const pin = await pinCopilotTestModel(page);
  const guard = createRoomPassBrowserGuard({ actorId: run.actorId, listingId, organizationId: DEMO });
  const failedRestRequests = new Set<string>();
  page.on('requestfailed', request => {
    const path = new URL(request.url()).pathname;
    if (/^\/rest\/v1\/(?:rpc\/)?[a-z0-9_]+$/.test(path)) failedRestRequests.add(`${request.method()} ${path}`);
  });
  let previews = 0;
  let readback: (() => Promise<boolean>) | undefined;
  await page.route('**/rest/v1/**', route => guard.route(route));
  page.on('response', async response => {
    if (response.ok() && new URL(response.url()).pathname === '/rest/v1/ai_chat_threads' && response.request().method() === 'POST') {
      guard.observeThread(response.request(), await response.json());
    }
    if (!response.url().endsWith(`/rpc/${previewName}`) || !response.ok()) return;
    const body = await response.json();
    const req = response.request(), headers = await req.allHeaders();
    let subject: string | undefined;
    try { subject = JSON.parse(Buffer.from(headers.authorization.split('.')[1], 'base64url').toString()).sub; } catch { /* checked below */ }
    if (subject !== run.actorId || body.canonical?.organization_id !== DEMO || body.canonical?.listing_id !== listingId) {
      throw new Error('browser_preview_identity_invalid');
    }
    guard.setProposal({ canonical: body.canonical, nonce: body.confirmation_nonce }); previews += 1;
    const base = response.url().split('/rest/v1/')[0];
    readback = async () => {
      const result = await page.request.get(`${base}/rest/v1/room_pass_listings`, {
        headers: { Authorization: headers.authorization, apikey: headers.apikey, 'Accept-Profile': 'public' },
        params: { id: `eq.${listingId}`, organization_id: `eq.${DEMO}`, select: 'id,active,organization_id' },
      });
      const rows = await result.json();
      expect(result.ok() && rows.length === 1 && rows[0].organization_id === DEMO, 'Owned listing readback failed').toBe(true);
      return rows[0].active;
    };
  });
  try {
    await page.addInitScript(({ organizationId, actorId }) => {
      localStorage.setItem('ihomecrm.selectedOrganizationId', organizationId);
      // This fresh browser must not start the dashboard's daily notification
      // writer on the real account. Defer that unrelated background job using
      // its existing browser-local throttle; every REST write stays guarded.
      localStorage.setItem(`schedNotif:lastRun:${actorId}`, String(Date.now()));
    }, { organizationId: DEMO, actorId: run.actorId });
    const selected = await waitForCopilotAvailability(page, DEMO, async () => {
      await login(page, 'sysadmin');
      // The unauthenticated organization bootstrap clears a persisted choice.
      // Reapply the init script with the authenticated session before opening
      // Copilot; the actual scoped availability response below proves selection.
      await page.reload(); await xacMinhBanBuild(page);
      await page.getByTestId('copilot-launcher').click();
    }, { timeoutMs: 45_000 });
    expect(selected.request().postDataJSON().p_organization_id).toBe(DEMO);
    await expect(page.getByTestId('copilot-model-select')).toHaveValue(COPILOT_TEST_MODEL);
    await expect(page.getByTestId('copilot-dang-tai-lich-su')).toHaveCount(0);
    await page.getByTitle('Cuộc trò chuyện mới', { exact: true }).click();
    const prompt = `Dùng doi_trang_thai_tin_phong_nho_sale lập đề xuất active=true cho listing_id ${listingId}, chỉ tổ chức DEMO. Chờ tôi bấm xác nhận.`;
    await guiVaChoModel(page, prompt, { organizationId: DEMO });
    await expect(page.getByTestId('copilot-confirm-card')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => previews).toBe(1);
    expect(guard.counters().writes === 0 && guard.counters().illegalWrites === 0,
      `Write attempt before consent; failed REST paths: ${[...failedRestRequests].sort().join(', ')}`).toBe(true);
    expect(await readback!(), 'Initial owned listing must be hidden').toBe(false);
    await page.getByTestId('copilot-confirm-cancel').click();
    await expect(page.getByTestId('copilot-confirm-card')).toBeHidden();
    expect(await readback!(), 'Cancellation changed listing').toBe(false);
    expect(guard.counters().writes === 0 && guard.counters().illegalWrites === 0, 'Write attempt on cancellation').toBe(true);
    await guiVaChoModel(page, prompt, { organizationId: DEMO });
    await expect(page.getByTestId('copilot-confirm-card')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => previews).toBe(2);
    expect(guard.counters().writes, 'Write attempt before second consent').toBe(0);
    const responsePromise = page.waitForResponse(response => response.url().endsWith(`/rpc/${executeName}`));
    guard.click();
    await page.getByTestId('copilot-confirm-accept').click();
    const response = await responsePromise, result = await response.json();
    expect(response.ok() && result.entity_id === listingId && result.active === true, 'Confirmed action failed').toBe(true);
    expect(await readback!()).toBe(true);
    expect(guard.counters().writes === 1 && guard.counters().illegalWrites === 0, 'Expected exactly one consent-bound execute').toBe(true);
    await expect(page.getByTestId('copilot-confirm-card')).toBeHidden();
    // Root binds process exit/build, then verifies audit/ledger and performs fresh
    // compensation. Never persist response bodies, nonce, headers or model prose.
    console.log(JSON.stringify({ roomPassBrowser: { runId: run.runId, listingId, organizationId: DEMO,
      noWriteBeforeClick: true, noWriteOnCancel: true, executedOnce: true } }));
  } finally { await pin.dispose(); }
});
