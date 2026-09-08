import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { login } from './auth';
import { chanChayTrenProduction, xacMinhBanBuild } from './buildAttestation';
import { pinCopilotTestModel, waitForCopilotAvailability } from './copilotTestModel';
import { guiVaChoModel } from './copilotModelCycle';

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
  let clicked = false, writes = 0, illegalWrites = 0, previews = 0;
  let readback: (() => Promise<boolean>) | undefined;
  let previousProposal: { canonical: Record<string, unknown>; nonce: string } | undefined;
  const writeRoutes = /\/rest\/v1\/(?:rpc\/(?:copilot_execute_|copilot_plan_create_|copilot_plan_approve_|copilot_plan_execute_|set_room_pass_listing_active|upsert_room_pass_listing|delete_room_pass_listing)|(?:room_pass_listings|buildings|rooms)(?:\?|$))/;
  await page.route('**/rest/v1/**', async route => {
    const req = route.request();
    if (!['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method()) || !writeRoutes.test(req.url())) return route.continue();
    writes += 1;
    const data = req.postDataJSON();
    const allowed = clicked && req.url().endsWith(`/rpc/${executeName}`)
      && data?.p_payload?.organization_id === DEMO && data?.p_payload?.listing_id === listingId
      && data?.p_payload?.active === true && previousProposal
      && JSON.stringify(data.p_payload) === JSON.stringify(previousProposal.canonical)
      && data.p_confirmation_nonce === previousProposal.nonce;
    if (!allowed) { illegalWrites += 1; await route.abort(); }
    else await route.continue();
  });
  page.on('response', async response => {
    if (!response.url().endsWith(`/rpc/${previewName}`) || !response.ok()) return;
    const body = await response.json();
    const req = response.request(), headers = await req.allHeaders();
    let subject: string | undefined;
    try { subject = JSON.parse(Buffer.from(headers.authorization.split('.')[1], 'base64url').toString()).sub; } catch { /* checked below */ }
    if (subject !== run.actorId || body.canonical?.organization_id !== DEMO || body.canonical?.listing_id !== listingId) {
      illegalWrites += 1; return;
    }
    previousProposal = { canonical: body.canonical, nonce: body.confirmation_nonce }; previews += 1;
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
    await page.addInitScript(([key, organizationId]) => localStorage.setItem(key, organizationId),
      ['ihomecrm.selectedOrganizationId', DEMO] as const);
    const selected = await waitForCopilotAvailability(page, DEMO, async () => {
      await login(page, 'sysadmin'); await xacMinhBanBuild(page);
      await page.getByTestId('copilot-launcher').click();
    });
    expect(selected.request().postDataJSON().p_organization_id).toBe(DEMO);
    await expect(page.getByTestId('copilot-dang-tai-lich-su')).toHaveCount(0);
    await page.getByTitle('Cuộc trò chuyện mới', { exact: true }).click();
    const prompt = `Dùng doi_trang_thai_tin_phong_nho_sale lập đề xuất active=true cho listing_id ${listingId}, chỉ tổ chức DEMO. Chờ tôi bấm xác nhận.`;
    await guiVaChoModel(page, prompt, { organizationId: DEMO });
    await expect(page.getByTestId('copilot-confirm-card')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => previews).toBe(1);
    expect(writes === 0 && illegalWrites === 0, 'Write attempt before consent').toBe(true);
    expect(await readback!(), 'Initial owned listing must be hidden').toBe(false);
    await page.getByTestId('copilot-confirm-cancel').click();
    await expect(page.getByTestId('copilot-confirm-card')).toBeHidden();
    expect(await readback!(), 'Cancellation changed listing').toBe(false);
    expect(writes === 0 && illegalWrites === 0, 'Write attempt on cancellation').toBe(true);
    await guiVaChoModel(page, prompt, { organizationId: DEMO });
    await expect(page.getByTestId('copilot-confirm-card')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => previews).toBe(2);
    expect(writes, 'Write attempt before second consent').toBe(0);
    const responsePromise = page.waitForResponse(response => response.url().endsWith(`/rpc/${executeName}`));
    clicked = true;
    await page.getByTestId('copilot-confirm-accept').click();
    const response = await responsePromise, result = await response.json();
    expect(response.ok() && result.entity_id === listingId && result.active === true, 'Confirmed action failed').toBe(true);
    expect(await readback!()).toBe(true);
    expect(writes === 1 && illegalWrites === 0, 'Expected exactly one consent-bound execute').toBe(true);
    await expect(page.getByTestId('copilot-confirm-card')).toBeHidden();
    // Root binds process exit/build, then verifies audit/ledger and performs fresh
    // compensation. Never persist response bodies, nonce, headers or model prose.
    console.log(JSON.stringify({ roomPassBrowser: { runId: run.runId, listingId, organizationId: DEMO,
      noWriteBeforeClick: true, noWriteOnCancel: true, executedOnce: true } }));
  } finally { await pin.dispose(); }
});
