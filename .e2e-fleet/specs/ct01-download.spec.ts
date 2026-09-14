import { test, expect } from '@playwright/test';
import { createServer, transformWithEsbuild, type ViteDevServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import PizZip from 'pizzip';

// Controlled browser regression: real modal, service, DOCX template and download.
// Synthetic REST responses only; no connection or write to an organization.
let server: ViteDevServer;
let base: string;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const cssPath = path.join(await mkdtemp(path.join(tmpdir(), 'ct01-browser-')), 'app.css');
  execFileSync(process.execPath, [path.join(root, 'node_modules/tailwindcss/lib/cli.js'), '-i', path.join(root, 'src/index.css'), '-o', cssPath, '-c', path.join(root, 'tailwind.config.ts')], { cwd: root, stdio: 'pipe' });
  const css = await readFile(cssPath);
  const fixture = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MemoryRouter} from 'react-router-dom'; import {Toaster} from 'sonner';
    import Modal from '@/components/customers/CustomerDetailModal';
    createRoot(document.getElementById('root')).render(<MemoryRouter><Modal open onOpenChange={()=>{}} customerId="ct01-demo-customer"/><Toaster/></MemoryRouter>);
  `;
  const customer = { id: 'ct01-demo-customer', full_name: 'Nguyễn Văn Kiểm Thử', date_of_birth: '2001-12-05', gender: 'MALE', id_number: '012345678901', phone: '0901234567', email: 'test@example.com' };
  const modules: Record<string, string> = {
    '/__ct01_fixture.tsx': fixture,
    '@/hooks/useCustomers': `export const useCustomer=()=>({data:${JSON.stringify(customer)},isLoading:false});`,
    '@/hooks/useVehicles': 'export const useVehicles=()=>({data:{data:[]}});',
    '@/hooks/useMyPermissions': "export const useMyPermissions=()=>({data:{customers:{view:true,edit:true,print:location.hash!=='#denied'}}});",
    '@/components/customers/DeleteCustomerDialog': 'export default function Delete(){return null;}',
    '@/integrations/supabase/client': `import {createClient} from '@supabase/supabase-js'; export const supabase=createClient(location.origin,'synthetic-fixture-key',{auth:{persistSession:false,autoRefreshToken:false}});`,
  };
  server = await createServer({
    configFile: false, root, cacheDir: path.join(root, 'node_modules/.vite-ct01-browser'),
    optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-router-dom', 'lucide-react', 'sonner', '@supabase/supabase-js', 'docxtemplater', 'pizzip', '@radix-ui/react-dialog', '@radix-ui/react-separator', '@radix-ui/react-slot', '@tanstack/react-query', 'class-variance-authority', 'clsx', 'tailwind-merge'] },
    resolve: { alias: [
      ...Object.keys(modules).filter(id => id.startsWith('@')).map(id => ({ find: id, replacement: `virtual:ct01:${id}` })),
      { find: '@', replacement: path.join(root, 'src') },
    ] },
    plugins: [{
      name: 'ct01-browser-fixture',
      enforce: 'pre',
      resolveId(id) {
        if (id === './DeleteCustomerDialog') return '\0ct01:@/components/customers/DeleteCustomerDialog';
        if (id in modules) return `\0ct01:${id}`;
        if (id.startsWith('virtual:ct01:')) return `\0ct01:${id.slice('virtual:ct01:'.length)}`;
      },
      async load(id) { if (id.startsWith('\0ct01:')) return (await transformWithEsbuild(modules[id.slice('\0ct01:'.length)], 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code; },
      configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
        if (req.url === '/__ct01.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); return; }
        if (!req.url?.startsWith('/__ct01.html')) return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await vite.transformIndexHtml('/__ct01.html', '<html><head><meta charset="UTF-8"><link rel="stylesheet" href="/__ct01.css"></head><body><div id="root"></div><script type="module" src="/__ct01_fixture.tsx"></script></body></html>'));
      }); },
    }], server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  base = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

const building = { id: 'ct01-demo-building', name: 'Tòa kiểm thử', street_address: '123 Đường Kiểm Thử', ward: 'Phường Bình Thạnh', district: '', province: 'Thành phố Hồ Chí Minh', deleted_at: null };
const link = (value = building) => ({ contract: { status: 'ACTIVE', deleted_at: null, room: { deleted_at: null, building: value } } });

test('bấm trong modal tải Word đúng dữ liệu, khóa bấm lặp, không chuyển trang', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } });
  let requests = 0;
  let releaseRequest: () => void = () => {};
  const pendingRequest = new Promise<void>(resolve => { releaseRequest = resolve; });
  await page.route('**/rest/v1/contract_customers?*', async route => {
    requests++;
    const url = new URL(route.request().url());
    expect(url.searchParams.get('customer_id')).toBe('eq.ct01-demo-customer');
    expect(url.searchParams.get('contract.status')).toBe('in.(ACTIVE)');
    expect(url.searchParams.get('contract.deleted_at')).toBe('is.null');
    expect(route.request().method()).toBe('GET');
    await pendingRequest;
    await route.fulfill({ json: [link(), link()] });
  });
  await page.clock.setFixedTime(new Date('2026-09-13T18:01:00Z'));
  await page.goto(`${base}/__ct01.html`);
  const button = page.getByRole('button', { name: /Bản khai nhân khẩu/ });
  await expect(button).toBeVisible();
  const event = page.waitForEvent('download');
  await button.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(page.getByRole('button', { name: 'Đang tạo tờ khai CT01…' })).toBeDisabled();
  releaseRequest();
  const download = await event;
  expect(download.suggestedFilename()).toBe('CT01 - Nguyễn Văn Kiểm Thử.docx');
  const file = await download.path();
  expect(file).toBeTruthy();
  const zip = new PizZip(await readFile(file!));
  const xml = zip.file('word/document.xml')!.asText();
  expect(xml).toContain('Nguyễn Văn Kiểm Thử');
  expect(xml).toContain('Công an Phường Bình Thạnh');
  expect(xml).toContain('123 Đường Kiểm Thử');
  expect(xml).not.toContain('MALE');
  expect(xml.match(/ngày 14 tháng 09 năm 2026/g)).toHaveLength(4);
  expect(xml).not.toMatch(/\{\w+\}/);
  await expect(page.getByRole('dialog', { name: 'Chi tiết khách hàng' })).toBeVisible();
  expect(page.url()).toBe(`${base}/__ct01.html`);
  expect(requests).toBe(1);
  expect(errors).toEqual([]);
});

test('nhiều tòa cho chọn, loại hợp đồng cũ và tòa đã xóa', async ({ page }) => {
  const second = { ...building, id: 'ct01-demo-second', name: 'Tòa thứ hai', ward: 'Phường Thủ Đức' };
  await page.route('**/rest/v1/contract_customers?*', route => route.fulfill({ json: [link(), link(second), { contract: { ...link().contract, status: 'TERMINATED' } }, link({ ...building, id: 'deleted', name: 'Đã xóa', deleted_at: '2026-01-01' })] }));
  await page.goto(`${base}/__ct01.html`);
  await page.getByRole('button', { name: /Bản khai nhân khẩu/ }).click();
  await expect(page.getByRole('dialog', { name: 'Chọn tòa nhà kê khai' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Đã xóa/ })).toHaveCount(0);
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: /Tòa thứ hai/ }).click();
  const download = await event;
  const xml = new PizZip(await readFile((await download.path())!)).file('word/document.xml')!.asText();
  expect(xml).toContain('Công an Phường Thủ Đức');
  expect(xml).not.toContain('Phường Bình Thạnh');
});

test('không có tòa hoặc thiếu phường báo rõ và thử lại được', async ({ page }) => {
  let rows: unknown[] = [];
  await page.route('**/rest/v1/contract_customers?*', route => route.fulfill({ json: rows }));
  await page.goto(`${base}/__ct01.html`);
  const button = page.getByRole('button', { name: /Bản khai nhân khẩu/ });
  await button.click();
  await expect(page.getByText(/Khách chưa có tòa nhà từ hợp đồng/)).toBeVisible();
  rows = [link({ ...building, ward: '' })];
  await button.click();
  await expect(page.getByText(/Tòa nhà chưa có phường\/xã/)).toBeVisible();
  await expect(button).toBeEnabled();
});

test('quyền không cho in thì không có nút tải', async ({ page }) => {
  await page.goto(`${base}/__ct01.html#denied`);
  await expect(page.getByRole('dialog', { name: 'Chi tiết khách hàng' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Bản khai nhân khẩu/ })).toHaveCount(0);
});
