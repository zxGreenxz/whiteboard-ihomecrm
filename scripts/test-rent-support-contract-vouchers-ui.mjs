// Called while the guarded TEST fixture is alive; credentials stay in memory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { buildMinimalChildEnvironment } from './gen-supabase-types.mjs';

export async function runBrowser(ctx, fixture, subject, session) {
  assert.equal(ctx.cred.testRef, 'hzulujxgonszuleqticb');
  const root = 'outputs/rent-support-contract-vouchers/', origin = 'http://127.0.0.1:8089';
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '8089', '--strictPort'], {
    windowsHide: true, env: { ...buildMinimalChildEnvironment(process.env), VITE_SUPABASE_URL: ctx.url,
      VITE_SUPABASE_PUBLISHABLE_KEY: ctx.cred.testPublishableKey, VITE_APP_ENV: 'test' },
  });
  server.stdout.on('data', d => appendFileSync(root + 'vite.log', d));
  server.stderr.on('data', d => appendFileSync(root + 'vite.log', d));
  let browser;
  const errors = [], blocked = [], writes = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { ready = (await fetch(origin)).ok; } catch { /* server startup only */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(ready, 'local TEST app must start');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const money = new Set(['register_rent_support_party_v1', 'prepare_contract_payouts_with_support_v1', 'execute_contract_payout_operation_v1']);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname.endsWith('.supabase.co') && url.origin !== ctx.url) { blocked.push(url.pathname); return route.abort(); }
      if (url.origin !== ctx.url || ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      const name = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)$/)?.[1];
      if (name && money.has(name)) {
        const body = request.postDataJSON();
        assert.equal(body.p_organization_id, fixture.org);
        if (body.p_contract_id) assert.equal(body.p_contract_id, subject.contract);
        if (body.p_building_id) assert.equal(body.p_building_id, fixture.building);
        writes.push(name); return route.continue();
      }
      // All other allowed POST RPCs are reads; reject incidental application writers.
      if (name && /^(get_|read_|list_|is_|can_|accessible_|my_|quote_|sale_bonus_status|business_performance_organizations)/.test(name)) return route.continue();
      if (url.pathname.startsWith('/auth/v1/')) return route.continue();
      blocked.push(url.pathname); return route.abort();
    });
    await page.addInitScript(({ session, org, ref }) => {
      localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify({ ...session, expires_at: Math.floor(Date.now() / 1000) + session.expires_in }));
      localStorage.setItem('ihomecrm.selectedOrganizationId', org);
      localStorage.setItem(`schedNotif:lastRun:${session.user.id}`, String(Date.now()));
    }, { session, org: fixture.org, ref: ctx.cred.testRef });
    await page.goto(`${origin}/contracts/${subject.contract}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByRole('button', { name: 'Tạo phiếu hoa hồng', exact: true }).click({ timeout: 60000 });
    const dialog = page.getByRole('dialog', { name: 'Tạo phiếu hoa hồng và hỗ trợ tiền thuê', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Người hưởng hoa hồng', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Gross hoa hồng', { exact: true }).fill('3000000');
    await dialog.getByLabel('recipient broker', { exact: true }).fill('Môi giới từ phiếu');
    await dialog.getByRole('button', { name: 'Xem khấu trừ và thực nhận', exact: true }).click();
    const create = dialog.getByRole('button', { name: 'Tạo phiếu ròng', exact: true });
    await expect(create).toBeEnabled({ timeout: 30000 });
    await expect(dialog.getByRole('cell', { name: '1.800.000 đ', exact: true })).toBeVisible();
    await expect(dialog.getByRole('cell', { name: '1.200.000 đ', exact: true })).toBeVisible();
    await page.screenshot({ path: root + 'voucher-before.png', fullPage: true });
    await create.click();
    await expect(dialog.getByText(/Đã có phiếu .*Theo thỏa thuận:/)).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: root + 'voucher-after.png', fullPage: true });
    assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
    assert(writes.includes('register_rent_support_party_v1')); assert(writes.includes('execute_contract_payout_operation_v1'));
    writeFileSync(root + 'browser-report.json', JSON.stringify({ project: ctx.cred.testRef, passed: true, errors, blocked, writes }, null, 2));
  } finally {
    await browser?.close(); server.kill();
    writeFileSync(root + 'browser-diagnostics.json', JSON.stringify({ errors, blocked, writes }, null, 2));
  }
}
