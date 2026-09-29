/**
 * Local browser component regression: real detail layouts, QR dialog, CSS,
 * canvas and Chromium clipboard. Data hooks and unrelated dialogs are fixtures;
 * no credentials, backend requests or accounting writes. Not a live-account E2E.
 * cd .e2e-fleet && npx playwright test specs/invoice-notes-qr-components.spec.ts --workers=1
 */
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { createServer, transformWithEsbuild, type ViteDevServer } from 'vite';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import loadTailwindConfig from 'tailwindcss/loadConfig.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const note = 'Giảm tiền phòng theo thỏa thuận tháng 9\nĐã đối chiếu với khách thuê.';
const generalNote = 'Ghi chú hóa đơn riêng — không phải lý do giảm trừ.';
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'";
const invoice = {
  id: 'dddd0000-0000-4000-8000-000000000101', invoice_number: 'DEMO-NOTES-QR',
  contract_id: 'dddd0000-0000-4000-8000-000000000103', status: 'APPROVED',
  billing_month: '2026-09', issue_date: '2026-09-01', due_date: '2026-09-30',
  total_amount: 4700000, paid_amount: 0, previous_debt: 0,
  discount_amount: 300000, discount_notes: note, notes: generalNote,
  building: { name: 'Tòa kiểm thử' }, room: { name: '101' },
  contract: { status: 'ACTIVE', contract_number: 'DEMO-QR-101', public_code: 'fixture-qr-101', contract_customers: [] },
  invoice_items: [{ id: 'rent', description: 'Tiền phòng', type: 'RENT', amount: 5000000, unit_price: 5000000, quantity: 1 }],
  payments: [], invoice_adjustments: [],
};

const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import InvoiceDetailView from '@/components/invoices/InvoiceDetailView';
import {copyContractQrToClipboard} from '@/lib/contractQrImage';
import jsQR from 'jsqr';
import '@/index.css';
window.__decodeQr = jsQR;
const client = new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}});
client.setQueryData(['invoice-vouchers',${JSON.stringify(invoice.id)}],[]);
function DirectCopy(){
  const [result,setResult]=useState('');
  return <><button onClick={()=>copyContractQrToClipboard({publicCode:'fixture-qr-101',roomName:'101',buildingName:'Tòa kiểm thử'}).then(()=>setResult('Đã copy trực tiếp'),error=>setResult(error.message))}>Copy QR từ danh sách</button><output>{result}</output></>;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}>
    {new URLSearchParams(location.search).has('direct') ? <DirectCopy/> : <InvoiceDetailView id=${JSON.stringify(invoice.id)} onBack={()=>{}}/>}
  </QueryClientProvider>
);
`;

let server: ViteDevServer;
let base: string;
test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  const virtual = new Map([
    ['virtual:notes-qr-invoices', `
      const invoice=${JSON.stringify(invoice)};
      const params=new URLSearchParams(location.search);
      if(params.has('empty')) invoice.discount_notes=null;
      if(params.has('zero')) {invoice.discount_amount=0;invoice.total_amount=5000000;}
      const forbidden=()=>{throw new Error('Fixture forbids backend writes')};
      export const useInvoice=()=>({data:invoice,isLoading:false,refetch:forbidden});
      export const useCancelInvoice=()=>({mutate:forbidden});
      export const useRestoreInvoice=()=>({mutate:forbidden});
      export const useReviewInvoiceAdjustment=()=>({mutateAsync:forbidden});
    `],
    ['virtual:notes-qr-context', 'export const useMyContext=()=>({data:{isSuper:false}});'],
    ['virtual:notes-qr-permissions', 'export const useMyPermissions=()=>({data:{}});'],
    ['virtual:notes-qr-signed-url', 'export const useSignedUrl=()=>null;'],
    ['virtual:notes-qr-storage', "export const createSignedUrlFromStored=()=>{throw new Error('Fixture forbids storage access')};"],
    ['virtual:notes-qr-backend', "export const supabase=new Proxy({},{get(){throw new Error('Fixture forbids backend access')}});"],
    ['virtual:notes-qr-closed-dialog', 'export default function ClosedDialog(){return null}'],
  ]);
  server = await createServer({
    configFile: false, root,
    cacheDir: path.join(root, '.e2e-fleet/test-results/invoice-notes-qr-vite'),
    css: { postcss: { plugins: [tailwindcss({ ...loadTailwindConfig(path.join(root, 'tailwind.config.ts')), content: [path.join(root, 'src/**/*.{ts,tsx}').replaceAll('\\', '/')] }), autoprefixer()] } },
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', '@tanstack/react-query', 'lucide-react', 'zod', 'qrcode', 'jsqr', '@radix-ui/react-dialog', '@radix-ui/react-slot', '@radix-ui/react-toast'] },
    resolve: { alias: [
      { find: '@/hooks/useInvoices', replacement: 'virtual:notes-qr-invoices' },
      { find: '@/hooks/useMyContext', replacement: 'virtual:notes-qr-context' },
      { find: '@/hooks/useMyPermissions', replacement: 'virtual:notes-qr-permissions' },
      { find: '@/hooks/useSignedUrl', replacement: 'virtual:notes-qr-signed-url' },
      { find: '@/lib/storage', replacement: 'virtual:notes-qr-storage' },
      { find: '@/integrations/supabase/client', replacement: 'virtual:notes-qr-backend' },
      ...['RecordPaymentDialog', 'RecordRefundDialog', 'PrintInvoiceDialog', 'EditInvoiceDialog'].map(name => ({
        find: `@/components/invoices/${name}`, replacement: 'virtual:notes-qr-closed-dialog',
      })),
      { find: '@', replacement: path.join(root, 'src') },
    ] },
    plugins: [{
      name: 'invoice-notes-qr-browser-fixture',
      resolveId(id) {
        if (id === '/__notes_qr_fixture.tsx' || virtual.has(id)) return '\0' + id;
      },
      async load(id) {
        if (id === '\0/__notes_qr_fixture.tsx') return (await transformWithEsbuild(fixture, 'notes-qr-fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code;
        return virtual.get(id.slice(1));
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith('/__notes_qr_fixture.html')) return next();
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Content-Security-Policy', csp);
          response.end(await vite.transformIndexHtml('/__notes_qr_fixture.html', '<html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__notes_qr_fixture.tsx"></script></body></html>'));
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing local fixture address');
  base = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); });

async function readClipboardPng(page: Page) {
  return page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const blob = await item.getType('image/png');
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, 480, 480);
    const decode = (window as unknown as { __decodeQr: (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null }).__decodeQr;
    const result = {
      type: blob.type, size: blob.size, width: bitmap.width, height: bitmap.height,
      signature: Array.from(new Uint8Array(await blob.slice(0, 8).arrayBuffer())),
      publicUrl: decode(pixels.data, pixels.width, pixels.height)?.data,
      labelBackground: Array.from(ctx.getImageData(240, 515, 1, 1).data),
    };
    bitmap.close();
    return result;
  });
}

test('strict CSP rejects fetch(data:) so the fixture detects the original QR failure', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/__notes_qr_fixture.html`);
  await expect(page.getByText(generalNote, { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  const blocked = await page.evaluate(async () => {
    try { await fetch('data:image/png;base64,iVBORw0KGgo='); return false; }
    catch (error) { return error instanceof TypeError; }
  });
  expect(blocked).toBe(true);
});

for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 900 }]) {
  test(`discount notes and real QR clipboard at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const errors: string[] = [];
    const externalRequests: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) {
        externalRequests.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(`${base}/__notes_qr_fixture.html`);
    const discountNote = page.getByText(note, { exact: true });
    await expect(discountNote).toBeVisible();
    await expect(page.getByText(generalNote, { exact: true })).toBeVisible();
    const layout = await discountNote.evaluate(element => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const text = element.firstChild!;
      const range = document.createRange();
      const lineTops = [0, text.textContent!.indexOf('\n') + 1].map(offset => {
        range.setStart(text, offset); range.setEnd(text, offset + 1);
        return range.getBoundingClientRect().top;
      });
      return { whiteSpace: style.whiteSpace, textTransform: style.textTransform, height: box.height, lineTops, width: box.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    });
    expect(layout.whiteSpace).toBe('pre-wrap');
    expect(layout.textTransform).toBe('none');
    expect(layout.lineTops[1]).toBeGreaterThan(layout.lineTops[0]);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const notesScreenshot = testInfo.outputPath(`notes-${viewport.width}.png`);
    await page.screenshot({ path: notesScreenshot, fullPage: true });
    await testInfo.attach(`notes-${viewport.width}`, { path: notesScreenshot, contentType: 'image/png' });

    await page.getByRole('button', { name: 'QR hợp đồng', exact: true }).click();
    const copy = page.getByRole('button', { name: 'Copy ảnh QR', exact: true });
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect(page.getByRole('button', { name: 'Đã copy', exact: true })).toBeVisible();
    const dialogPng = await readClipboardPng(page);
    expect(dialogPng).toMatchObject({
      type: 'image/png', width: 480, height: 652,
      signature: [137, 80, 78, 71, 13, 10, 26, 10],
      publicUrl: `${base}/c/fixture-qr-101`, labelBackground: [255, 228, 230, 255],
    });
    expect(dialogPng.size).toBeGreaterThan(1000);
    const qrScreenshot = testInfo.outputPath(`qr-${viewport.width}.png`);
    await page.screenshot({ path: qrScreenshot });
    await testInfo.attach(`qr-${viewport.width}`, { path: qrScreenshot, contentType: 'image/png' });

    await page.goto(`${base}/__notes_qr_fixture.html?direct`);
    await page.getByRole('button', { name: 'Copy QR từ danh sách', exact: true }).click();
    await expect(page.locator('output')).toHaveText('Đã copy trực tiếp');
    const directPng = await readClipboardPng(page);
    expect(directPng).toEqual(dialogPng);

    await page.goto(`${base}/__notes_qr_fixture.html?empty`);
    await expect(page.getByText('Giảm trừ', { exact: true })).toBeVisible();
    await expect(page.getByText(note, { exact: true })).toHaveCount(0);
    await page.goto(`${base}/__notes_qr_fixture.html?zero`);
    await expect(page.getByText(generalNote, { exact: true })).toBeVisible();
    await expect(page.getByText(note, { exact: true })).toHaveCount(0);
    await expect(page.getByText('Giảm trừ', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
    const evidence = testInfo.outputPath('browser-evidence.json');
    await writeFile(evidence, JSON.stringify({ viewport, csp, layout, dialogPng, directPng, errors, externalRequests, backendWrites: 0 }, null, 2));
    await testInfo.attach('browser-evidence', { path: evidence, contentType: 'application/json' });
  });
}
