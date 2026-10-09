/** Synthetic browser coverage of the real page, guard, hooks and validated API service.
 * Auth/transport and surrounding layout are isolated; no live data or network writes. */
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, transformWithEsbuild, type ViteDevServer } from 'vite';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import loadTailwindConfig from 'tailwindcss/loadConfig.js';
import { fixtureActor, fixtureEvent, fixtureSource, fixtureStatus } from '../../src/lib/bank-events/__tests__/fixtures';
const root = fileURLToPath(new URL('../..', import.meta.url));
let server: ViteDevServer, base: string;
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Route,Routes} from 'react-router-dom';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {RequireSuperAdmin} from '@/components/auth/RequireSuperAdmin';import Page from '@/pages/bank-events/BankEventsPage';import '@/index.css';createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={['/bien-dong-so-du']} future={{v7_startTransition:true,v7_relativeSplatPath:true}}><Routes><Route path='/bien-dong-so-du' element={<RequireSuperAdmin><Page/></RequireSuperAdmin>}/><Route path='/' element={<p>Không có quyền truy cập trang tổng</p>}/></Routes></MemoryRouter></QueryClientProvider>);`;
test.describe.configure({ mode: 'default' });
test.use({ storageState: { cookies: [], origins: [] } });
test.beforeAll(async () => {
  const virtual = new Map([
    ['virtual:bank-auth', `export const useAuth=()=>({data:{id:'${fixtureActor}'},isLoading:false,error:null});`],
    ['virtual:bank-layout', 'export default function Layout({children}){return children}'],
    ['virtual:bank-client', `export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'fixture-jwt',user:{id:'${fixtureActor}'}}},error:null})},rpc:async(name)=>({data:!location.search.includes('denied'),error:null}),functions:{invoke:async(name,options)=>{const response=await fetch('/__bank-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(options.body)});return {data:await response.json(),error:null}}}};`],
  ]);
  server = await createServer({ configFile: false, root, cacheDir: path.join(root, '.e2e-fleet/test-results/bank-events-vite'), esbuild: { jsx: 'automatic' },
    css: { postcss: { plugins: [tailwindcss({ ...loadTailwindConfig(path.join(root, 'tailwind.config.ts')), content: [path.join(root, 'src/**/*.{ts,tsx}').replaceAll('\\', '/')] }), autoprefixer()] } },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'react-router-dom', '@tanstack/react-query', 'lucide-react', 'zod', '@radix-ui/react-dialog', '@radix-ui/react-tabs', '@radix-ui/react-slot', '@radix-ui/react-label'] },
    resolve: { alias: [{ find: '@/hooks/useAuth', replacement: 'virtual:bank-auth' }, { find: '@/components/layout/MainLayout', replacement: 'virtual:bank-layout' }, { find: '@/integrations/supabase/client', replacement: 'virtual:bank-client' }, { find: '@', replacement: path.join(root, 'src') }] },
    plugins: [{ name: 'bank-events-fixture', resolveId(id) { if (id === '/__bank.tsx' || virtual.has(id)) return '\0' + id; }, async load(id) { if (id === '\0/__bank.tsx') return (await transformWithEsbuild(entry, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code; return virtual.get(id.slice(1)); }, configureServer(vite) { vite.middlewares.use(async (req, res, next) => { if (!req.url?.startsWith('/__bank.html')) return next(); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml('/__bank.html', '<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__bank.tsx"></script></body></html>')); }); } }],
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  });
  await server.listen(); const address = server.httpServer?.address(); if (!address || typeof address === 'string') throw Error('No fixture port'); base = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

async function setup(page: Page) {
  const calls: Record<string, unknown>[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  let sources = [{ ...fixtureSource }];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (url.origin !== base) { errors.push(`Unexpected external request ${url.origin}`); return route.abort(); }
    if (url.pathname !== '/__bank-api') return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>; calls.push(body);
    let data: unknown;
    switch (body.action) {
      case 'status': data = fixtureStatus; break;
      case 'list_sources': data = { sources }; break;
      case 'list_events': data = { events: body.query === 'khong-co' ? [] : [fixtureEvent], nextCursor: body.cursor || body.query === 'khong-co' ? null : 'fixture-next-page' }; break;
      case 'get_event': data = { event: fixtureEvent, payload: { event: 'sms.received', sender: 'BANK-FIXTURE', body: 'NOI_DUNG_THU_NGHIEM_KHONG_PHAI_TIN_THAT' } }; break;
      case 'create_source': { const source = { ...fixtureSource, id: '44444444-4444-4444-8444-444444444444', name: String(body.name), deviceId: null }; sources.push(source); data = { source, token: 'fixture-token-' + 'x'.repeat(40) }; break; }
      case 'rotate_source': data = { source: sources.find(source => source.id === body.sourceId), token: 'fixture-rotated-' + 'y'.repeat(40) }; break;
      case 'set_source_enabled': sources = sources.map(source => source.id === body.sourceId ? { ...source, enabled: Boolean(body.enabled) } : source); data = { source: sources.find(source => source.id === body.sourceId) }; break;
      case 'revoke_source': sources = sources.map(source => source.id === body.sourceId ? { ...source, enabled: false, revokedAt: fixtureStatus.serverTime, credentialFingerprint: null, credentialCreatedAt: null } : source); data = { source: sources.find(source => source.id === body.sourceId) }; break;
      default: throw Error('Unplanned fixture action');
    }
    await route.fulfill({ json: { ok: true, data } });
  });
  return { calls, errors };
}
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) test(`inbox, raw detail and filters at ${viewport.width}px`, async ({ page }, info) => {
  await page.setViewportSize(viewport); const evidence = await setup(page); await page.goto(base + '/__bank.html', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Biến động số dư', exact: true })).toBeVisible();
  await expect(page.getByText('Điện thoại thử nghiệm', { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: info.outputPath(`bank-events-inbox-${viewport.width}.png`), fullPage: true });
  expect(evidence.calls.some(call => call.action === 'get_event')).toBe(false);
  await page.getByRole('button', { name: /Xem tin Điện thoại thử nghiệm/ }).click();
  await expect(page.getByRole('dialog')).toContainText('NOI_DUNG_THU_NGHIEM_KHONG_PHAI_TIN_THAT');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sau', exact: true }).click(); await expect(page.getByText('Trang 2 · tối đa 25 tin')).toBeVisible();
  await page.getByLabel('Tìm theo thông tin nguồn').fill('khong-co'); await page.getByRole('button', { name: 'Áp dụng bộ lọc' }).click();
  await expect(page.getByText('Chưa có dữ liệu phù hợp')).toBeVisible();
  expect(evidence.calls.at(-1)).toMatchObject({ action: 'list_events', query: 'khong-co' });
  await page.screenshot({ path: info.outputPath(`bank-events-${viewport.width}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(evidence.errors).toEqual([]);
});
test('source lifecycle shows credentials once and pauses/revokes with explicit actions', async ({ page }, info) => {
  const evidence = await setup(page); await page.goto(base + '/__bank.html', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Nguồn kết nối' }).click(); await page.getByRole('button', { name: 'Thêm nguồn' }).click();
  await page.getByLabel('Tên nguồn').fill('Nguồn mới giả lập'); await page.getByRole('button', { name: 'Tạo nguồn và cấp khóa' }).click();
  await expect(page.getByLabel('Khóa xác thực')).toHaveValue('fixture-token-' + 'x'.repeat(40));
  await page.getByRole('button', { name: 'Tôi đã lưu khóa · Đóng' }).click(); await expect(page.getByLabel('Khóa xác thực')).toHaveCount(0);
  const card = page.locator('article').filter({ hasText: 'Nguồn mới giả lập' });
  await card.getByRole('button', { name: 'Tạm dừng', exact: true }).click(); await expect(card.getByRole('button', { name: 'Bật lại' })).toBeVisible();
  await card.getByRole('button', { name: 'Thu hồi', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Thu hồi nguồn', exact: true }).click(); await expect(card.getByText('Đã thu hồi', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('bank-events-sources.png'), fullPage: true, animations: 'disabled' });
  expect(evidence.calls.filter(call => call.action === 'create_source')).toHaveLength(1); expect(evidence.errors).toEqual([]);
});
test('non-superadmin never mounts the inbox or calls the admin API', async ({ page }) => {
  const evidence = await setup(page); await page.goto(base + '/__bank.html?denied=owner-admin-sentinel', { waitUntil: 'domcontentloaded' }); await expect(page.getByText('Không có quyền truy cập trang tổng')).toBeVisible();
  expect(evidence.calls).toEqual([]); expect(evidence.errors).toEqual([]);
});
