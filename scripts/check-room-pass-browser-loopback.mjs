// Local real-browser regression only. No product origin, credentials or model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
async function sourceModule(name) {
  const text = await readFile(new URL('../.e2e-fleet/specs/' + name + '.ts', import.meta.url), 'utf8');
  const { outputText } = transpileModule(text, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
const { createRoomPassBrowserGuard } = await sourceModule('copilotRoomPassGuard');
const { pinCopilotTestModel, COPILOT_TEST_MODEL } = await sourceModule('copilotTestModel');
const reached = [];
const server = createServer((req, res) => {
  reached.push(req.url);
  res.setHeader('Content-Type', req.url === '/' ? 'text/html' : 'application/json');
  res.end(req.url === '/' ? '<!doctype html><title>loopback only</title>' : JSON.stringify({ ui_preferences: { copilotModel: 'stored-model' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin);
  const pin = await pinCopilotTestModel(page);
  const guard = createRoomPassBrowserGuard({ actorId: '11111111-1111-4111-8111-111111111111', listingId: '22222222-2222-4222-8222-222222222222', organizationId: 'dddd0000-0000-4000-8000-000000000001' });
  await page.route('**/rest/v1/**', route => guard.route(route));
  const model = await page.evaluate(async () => (await (await fetch('/rest/v1/profiles?select=ui_preferences')).json()).ui_preferences.copilotModel);
  assert.equal(model, COPILOT_TEST_MODEL);
  const forbidden = ['income_expenses', 'ai_write_audit', 'rpc/ie_compat_insert_v2', 'rpc/create_income_expense_v1'];
  for (const path of forbidden) {
    const blocked = await page.evaluate(async path => { try { await fetch('/rest/v1/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organization_id: 'foreign' }) }); return false; } catch { return true; } }, path);
    assert.equal(blocked, true);
    assert.equal(reached.includes('/rest/v1/' + path), false);
  }
  assert.equal(guard.counters().illegalWrites, forbidden.length);
  await pin.dispose();
  console.log(JSON.stringify({ loopbackOnly: true, selectedModelHandlerExecuted: true, blockedBeforeNetwork: forbidden.length }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
