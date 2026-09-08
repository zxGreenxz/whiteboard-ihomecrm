/**
 * Headless component fixtures only: actual collection components and CSS, no API
 * or accounting writes. This is not a substitute for DEMO RPC/end-to-end checks.
 * node .e2e-fleet/payment-rounding-components.mjs [--root <checkout>] [--output <dir>]
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const root = path.resolve(option('--root', process.cwd()));
const output = path.resolve(option('--output', path.join(root, '.tmp-payment-rounding-components')));
await mkdir(output, { recursive: true });
const entry = '\0payment-rounding-fixture.tsx';
const backend = '\0payment-rounding-backend';
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CollectKeypad } from '@/components/thu-tien/CollectKeypad';
import { CollectPayForm } from '@/components/thu-tien/CollectPayForm';
import { fmtShort } from '@/lib/collect';
import '@/index.css';
import '@/pages/thu-tien.css';
const params = new URLSearchParams(location.search);
const form = params.get('mode') === 'form';
const allowRounding = params.get('deposit') !== '1';
function Fixture() {
  const [entered, setEntered] = useState(params.get('exact') === '1' ? null : '8000');
  const [changeAmount, setChangeAmount] = useState(null);
  const [credit, setCredit] = useState(false);
  const [state, setState] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  return <div className="tt-stage"><div className="tt-phone-col"><main className="tt-page">
    <div className="hdr"><strong>KIỂM THỬ · KHÔNG GHI TIỀN</strong><p>{form ? 'Form thu tiền — MADRID 4' : 'Bàn phím — BERLIN'}</p></div>
    <div className="scroll" style={{ paddingBottom: 24 }}>
      {form ? <CollectPayForm remaining={8333000} methodAvailable={{TM:true,TK:true,TT:true}} changeAccountName="Hiệp Thối" canCredit allowRounding={allowRounding} onChange={setState} /> :
      <CollectKeypad remaining={7908000} entered={entered} onEntered={value => {setEntered(value); setChangeAmount(null);}} changeAmount={changeAmount} onChangeAmount={setChangeAmount}
        keepAsCredit={credit} onKeepAsCreditChange={value => {setCredit(value); setChangeAmount(null);}} canCredit allowRounding={allowRounding} changeAccountName="Hiệp Thối" onConfirm={() => setConfirmed(true)} />}
      {form && <div style={{padding:'0 18px'}}><button type="button" className="kp-confirm full" disabled={!state?.canSubmit} onClick={() => setConfirmed(true)}>Thu {fmtShort(state?.total ?? 8333000)}<small>{state?.keepAsCredit ? 'nợ khách ' : 'thối '}{fmtShort(state?.overpay ?? 0)}</small></button></div>}
    </div>
    <output aria-label="Payload kiểm thử" hidden>{JSON.stringify({state, confirmed})}</output>
  </main></div></div>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;
const server = await createServer({
  configFile: false, root, cacheDir: path.join(output, '.vite'),
  optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'lucide-react', 'sonner'] },
  resolve: { alias: [
    { find: '@/integrations/supabase/client', replacement: 'virtual:payment-rounding-backend' },
    { find: '@', replacement: path.join(root, 'src') },
  ] },
  plugins: [{
    name: 'payment-rounding-components-fixture',
    resolveId(id) {
      if (id === '/__rounding_fixture.tsx') return entry;
      if (id === 'virtual:payment-rounding-backend') return backend;
    },
    async load(id) {
      if (id === entry) return (await transformWithEsbuild(fixture, 'payment-rounding-fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code;
      if (id === backend) return "export const supabase = new Proxy({}, {get(){throw new Error('Backend access forbidden in component fixture')}});";
    },
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__rounding_fixture.html')) return next();
        const html = '<html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__rounding_fixture.tsx"></script></body></html>';
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__rounding_fixture.html', html));
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, strictPort: true },
});
await server.listen();
const address = server.httpServer.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const evidence = [];
try {
  for (const viewport of [{width:375,height:812}, {width:1280,height:900}]) {
    const page = await browser.newPage({ viewport, locale: 'vi-VN' });
    const errors = [];
    const externalRequests = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Fixture page error:', error.message); });
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) {
        externalRequests.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    const payload = async () => JSON.parse(await page.getByLabel('Payload kiểm thử').textContent());
    const screenshot = async name => {
      const filename = path.join(output, `${name}-${viewport.width}.png`);
      await page.screenshot({path:filename, animations:'disabled'});
      const dimensions = await page.locator('.tt-page').evaluate(element => {
        const r = element.getBoundingClientRect();
        return { x:r.x, y:r.y, width:r.width, height:r.height, scrollWidth:element.scrollWidth, clientWidth:element.clientWidth };
      });
      assert(dimensions.x >= 0 && dimensions.y >= 0 && dimensions.width <= viewport.width && dimensions.height <= viewport.height, 'fixture fits viewport');
      assert(dimensions.scrollWidth <= dimensions.clientWidth, 'no horizontal overflow');
      evidence.push({name, viewport, screenshot:filename, dimensions});
    };

    await page.goto(`${base}/__rounding_fixture.html?mode=keypad`);
    const change = page.getByRole('textbox', {name:'Tiền thối thực tế'});
    await change.waitFor();
    assert.equal(await change.inputValue(), '92.000');
    await change.fill('100000');
    await page.getByText('Bỏ qua 8.000đ — tính đóng đủ, lưu vào thống kê.').waitFor();
    const confirm = page.getByRole('button', {name:/Thu đủ 8tr/});
    assert.match(await confirm.textContent(), /thối 100k/);
    assert.equal(await confirm.isEnabled(), true);
    await screenshot('keypad-waived-8000');
    await change.fill('102000');
    await page.getByText('Còn nợ', {exact:false}).waitFor();
    assert.match(await page.locator('.kp-warn.under').textContent(), /10\.000đ/);
    assert.equal(await page.locator('.kp-warn.round').count(), 0);
    await screenshot('keypad-debt-10000');
    await change.fill('100000');
    await page.getByRole('checkbox').check();
    assert.equal(await change.count(), 0);
    await page.getByRole('checkbox').uncheck();
    assert.equal(await change.inputValue(), '92.000');
    await change.fill('100000');
    await page.getByRole('button', {name:'0',exact:true}).click();
    assert.equal(await change.inputValue(), '72.092.000');

    await page.goto(`${base}/__rounding_fixture.html?mode=keypad&exact=1`);
    await change.waitFor();
    assert.equal(await change.inputValue(), '0');
    await change.fill('5000');
    await page.getByText('Bỏ qua 5.000đ — tính đóng đủ, lưu vào thống kê.').waitFor();
    await screenshot('keypad-zero-change-editable');
    await page.goto(`${base}/__rounding_fixture.html?mode=keypad&deposit=1`);
    await change.fill('100000');
    assert.match(await page.locator('.kp-warn.under').textContent(), /8\.000đ/);
    assert.equal(await page.locator('.kp-warn.round').count(), 0);

    await page.goto(`${base}/__rounding_fixture.html?mode=form`);
    const gross = page.getByPlaceholder('Số tiền');
    await gross.fill('8500000');
    await page.waitForFunction(() => document.querySelector('[aria-label="Tiền thối thực tế"]')?.value === '167.000');
    await change.fill('170000');
    await page.getByText('Bỏ qua 3.000đ — tính đóng đủ, lưu vào thống kê.').waitFor();
    await page.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).state?.payload?.changeAmount === 170000);
    assert.equal((await payload()).state.payload.lines[0].amount, 8500000);
    assert.equal((await payload()).state.canSubmit, true);
    await screenshot('payform-waived-3000');
    await gross.fill('8600000');
    await page.waitForFunction(() => document.querySelector('[aria-label="Tiền thối thực tế"]')?.value === '267.000');
    await page.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).state?.payload?.changeAmount === 267000);
    assert.equal((await payload()).state.payload.changeAmount, 267000);
    assert.equal(await page.locator('.kp-warn.round').count(), 0);
    await gross.fill('8500000');
    await page.waitForFunction(() => document.querySelector('[aria-label="Tiền thối thực tế"]')?.value === '167.000');
    await change.fill('170000');
    await page.getByRole('checkbox').check();
    await page.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).state?.payload?.keepAsCredit === true);
    assert.equal((await payload()).state.payload.changeAmount, undefined);
    assert.equal(await change.count(), 0);
    await page.getByRole('checkbox').uncheck();
    await page.waitForFunction(() => document.querySelector('[aria-label="Tiền thối thực tế"]')?.value === '167.000');
    await page.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).state?.payload?.changeAmount === 167000);
    assert.equal((await payload()).state.payload.changeAmount, 167000);
    assert.equal((await payload()).confirmed, false);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log(JSON.stringify({viewport, keypad:'PASS', exact10000:'debt', initialZero:'editable', deposit:'not waived', formPayload:'PASS', resetAndCredit:'PASS', writes:0, errors}));
    await page.close();
  }
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify({fixtureOnly:true,root,evidence}, null, 2));
} finally {
  await browser.close();
  await server.close();
}
