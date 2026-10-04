/** Browser regression for the real page, recorder, feed, image encoding and AI request builder.
 * Background data and AI responses are fixtures; no live credentials or accounting writes.
 * cd .e2e-fleet && npx playwright test specs/quick-entry-composer.spec.ts --workers=1
 */
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, transformWithEsbuild, type ViteDevServer } from 'vite';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import loadTailwindConfig from 'tailwindcss/loadConfig.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import QuickEntryPage from '@/pages/quick-entry/QuickEntryPage';
import '@/index.css';
createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/chi-tieu']} future={{v7_startTransition:true,v7_relativeSplatPath:true}}><QuickEntryPage/></MemoryRouter>
);
`;
const refs = {
  orgId: 'dddd0000-0000-4000-8000-000000000001', loading: false, canCompany: true, canPersonal: true,
  permissionsLoading:false,permissionsError:null,personalLoading:false,personalError:null,personalReady:true,
  companyLoading:false,companyError:null,companyReady:true,
  personalWallets:[{id:'11111111-1111-4111-8111-111111111111',user_id:'u1',name:'Tiền mặt',version:1,kind:'cash',icon:'wallet',is_default:true,hidden:false,opening_balance:0,balance:0}],
  personalCategories:[{id:'22222222-2222-4222-8222-222222222222',user_id:'u1',name:'Sinh hoạt',version:1,type:'EXPENSE',icon:'wallet',color:'#123456',hidden:false,seed_key:null,legacy_name:null}],
  buildings: [{ id: 'b102', name: 'Toà 102', code: '102LVT', is_virtual: false, user_id: 'u1', managed: true }],
  rooms: [], categories: [{ id: 'c1', name: 'Sửa điện', category: 'Bảo Trì', type: 'expense' }],
  cashbooks: [{ id: 'a1', label: 'Quỹ 102' }],
  resolveRefs: { buildings: [{ id: 'b102', name: 'Toà 102', code: '102LVT' }], rooms: [], feeAccounts: [] },
};
const ai = { items: [{ desc: 'Sửa điện', amount_vnd: 300000, category: 'c1', confidence: 0.9 }], total_vnd: 300000,
  date: null, vendor: null, building_mention: '102LVT', room_mention: null, customer_code: null, period_start: null, period_end: null };
const photo = { name: 'bill.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YV0AAAAASUVORK5CYII=', 'base64') };
let server: ViteDevServer;
let base: string;

test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] }, launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test.beforeAll(async () => {
  const virtual = new Map([
    ['virtual:qe-auth', "export const useAuth=()=>({data:{id:'u1'}});"],
    ['virtual:qe-mobile', 'export const usePhoneViewport=()=>innerWidth<768;'],
    ['virtual:qe-layout', 'export default function Layout({children}){return children}'],
    ['virtual:qe-refs', `const refs=${JSON.stringify(refs)}; export const useQuickEntryRefs=()=>({...refs,canCompany:!location.search.includes('personal-only'),defaultAccountFor:()=> 'a1'}); export const rememberAccount=()=>{};`],
    ['virtual:qe-save', "const forbidden=()=>{throw new Error('Fixture forbids accounting writes')}; export const useQuickEntrySave=()=>({uploadPhoto:forbidden,saveCompany:forbidden,savePersonal:forbidden});"],
    ['virtual:qe-slot', 'export const useVoucherSlotWarning=()=>({data:[]});'],
    ['virtual:qe-client', "export const supabase=new Proxy({},{get(){throw new Error('Fixture forbids backend access')}});"],
    ['virtual:qe-transport', "export const QUICK_ENTRY_BASE='/__ai'; export const makeCopilotFetch=()=>fetch; export const newTaskId=()=> 'qe-browser';"],
  ]);
  server = await createServer({
    configFile: false, root, cacheDir: path.join(root, '.e2e-fleet/test-results/quick-entry-vite'),
    css: { postcss: { plugins: [tailwindcss({ ...loadTailwindConfig(path.join(root, 'tailwind.config.ts')), content: [path.join(root, 'src/**/*.{ts,tsx}').replaceAll('\\', '/')] }), autoprefixer()] } },
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-router-dom', 'lucide-react', 'zod', '@radix-ui/react-slot'] },
    resolve: { alias: [
      { find: '@/hooks/useAuth', replacement: 'virtual:qe-auth' },
      { find: '@/hooks/use-mobile', replacement: 'virtual:qe-mobile' },
      { find: '@/components/layout/MainLayout', replacement: 'virtual:qe-layout' },
      { find: /^(?:.*\/)useQuickEntryRefs$/, replacement: 'virtual:qe-refs' },
      { find: /^(?:.*\/)useQuickEntrySave$/, replacement: 'virtual:qe-save' },
      { find: '@/hooks/useVoucherSlotWarning', replacement: 'virtual:qe-slot' },
      { find: '@/integrations/supabase/client', replacement: 'virtual:qe-client' },
      { find: '@/copilot/copilotConfig', replacement: 'virtual:qe-transport' },
      { find: '@', replacement: path.join(root, 'src') },
    ] },
    plugins: [{
      name: 'quick-entry-browser-fixture',
      resolveId(id) { if (id === '/__quick_entry.tsx' || virtual.has(id)) return '\0' + id; },
      async load(id) {
        if (id === '\0/__quick_entry.tsx') return (await transformWithEsbuild(fixture, 'quick-entry-fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code;
        return virtual.get(id.slice(1));
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith('/__quick_entry.html')) return next();
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(await vite.transformIndexHtml('/__quick_entry.html', '<html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__quick_entry.tsx"></script></body></html>'));
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  base = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

async function open(page: Page, personal = false) {
  const errors: string[] = [];
  const reads: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async route => {
    if (!route.request().url().startsWith(base)) throw new Error('Unexpected external request');
    if (route.request().url().endsWith('/audio/transcriptions')) {
      await route.fulfill({ json: { text: 'sửa điện ba trăm nghìn' } });
    } else if (route.request().url().endsWith('/chat/completions')) {
      reads.push(route.request().postDataJSON());
      await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(ai) } }] } });
    } else await route.continue();
  });
  await page.goto(`${base}/__quick_entry.html${personal ? '?personal-only' : ''}`);
  await expect(page.getByRole('button', { name: 'Ảnh kèm nội dung', exact: true })).toBeVisible().catch(error => {
    throw new Error(`${error.message}\nBrowser errors: ${errors.join('\n')}`);
  });
  return { errors, reads };
}

async function record(page: Page) {
  await page.getByRole('button', { name: 'Nói', exact: true }).click();
  await expect(page.getByText(/Đang nghe… 0:01/)).toBeVisible();
  await page.getByRole('button', { name: 'Xong', exact: true }).click();
}

for (const width of [375, 1280]) {
  test(`ảnh + chữ và ảnh + voice gửi chung, không tự lưu — ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors, reads } = await open(page);
    const attachment = page.getByRole('button', { name: 'Ảnh kèm nội dung', exact: true });
    expect((await attachment.boundingBox())!.x).toBeLessThan((await page.getByRole('button', { name: 'Chụp bill', exact: true }).boundingBox())!.x);
    const chooser = page.waitForEvent('filechooser');
    await attachment.click();
    await (await chooser).setFiles(photo);
    await expect(page.getByAltText('Ảnh chờ gửi')).toBeVisible();
    await page.getByLabel('Nội dung khoản chi').fill('102LVT sửa điện');
    await expect(page.getByRole('button', { name: 'Nói', exact: true })).toBeVisible();
    expect(reads).toHaveLength(0);
    await page.screenshot({ path: info.outputPath(`pending-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Gửi', exact: true }).click();
    await expect(page.getByText('102LVT sửa điện', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lưu phiếu chi', exact: true })).toBeVisible();
    expect(reads).toHaveLength(1);
    const parts = reads[0].messages.find(m => m.role === 'user')!.content;
    expect(parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' }), expect.objectContaining({ type: 'text', text: expect.stringContaining('102LVT sửa điện') })]));
    await page.getByLabel('Chọn ảnh kèm nội dung', { exact: true }).setInputFiles(photo);
    await page.getByLabel('Nội dung khoản chi').fill('102LVT');
    await record(page);
    await expect(page.getByText('102LVT sửa điện ba trăm nghìn', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lưu phiếu chi', exact: true })).toHaveCount(2);
    expect(reads).toHaveLength(2);
    expect(JSON.stringify(reads[1].messages)).toContain('102LVT sửa điện ba trăm nghìn');
    await expect(page.getByLabel('Nội dung khoản chi')).toHaveValue('');
    await expect(page.getByAltText('Ảnh chờ gửi')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('chỉ quyền cá nhân: voice tự gửi; huỷ ghi âm giữ ảnh/chữ và không gửi', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const { errors, reads } = await open(page, true);
  await expect(page.getByRole('group', { name: 'Ghi vào' })).toHaveCount(0);
  await record(page);
  await expect(page.getByText('sửa điện ba trăm nghìn', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lưu vào ví', exact: true })).toBeVisible();
  expect(reads).toHaveLength(1);
  await page.getByLabel('Chọn ảnh kèm nội dung', { exact: true }).setInputFiles(photo);
  await page.getByLabel('Nội dung khoản chi').fill('ghi chú');
  await page.getByRole('button', { name: 'Nói', exact: true }).click();
  await expect(page.getByText(/Đang nghe… 0:01/)).toBeVisible();
  await page.getByRole('button', { name: 'Huỷ ghi âm' }).click();
  await expect(page.getByLabel('Nội dung khoản chi')).toHaveValue('ghi chú');
  await expect(page.getByAltText('Ảnh chờ gửi')).toBeVisible();
  expect(reads).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
