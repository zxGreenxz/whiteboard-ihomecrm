import { test, expect, type Page } from '@playwright/test';
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
    import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
    import Modal from '@/components/customers/CustomerDetailModal';
    const qc = new QueryClient({defaultOptions:{queries:{retry:false}}});
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={qc}><MemoryRouter><Modal open onOpenChange={()=>{}} customerId="ct01-demo-customer"/><Toaster/></MemoryRouter></QueryClientProvider>);
  `;
  const customer = { id: 'ct01-demo-customer', full_name: 'Nguyễn Văn Kiểm Thử', date_of_birth: '2001-12-05', gender: 'MALE', id_number: '012345678901', phone: '0901234567', email: 'test@example.com', id_issue_date: '2022-02-25', id_issue_place: 'Cục Cảnh Sát', detailed_address: 'Ấp Kiểm Thử, Xã Bình Mỹ', permanent_address: null };
  const modules: Record<string, string> = {
    '/__ct01_fixture.tsx': fixture,
    '@/hooks/useCustomers': `export const useCustomer=()=>({data:{...${JSON.stringify(customer)},...(location.hash==='#conflicting-address'?{permanent_address:'Địa chỉ thường trú cũ không dùng'}:{})},isLoading:false});`,
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
const owner = { full_name: 'Trần Thị Chủ Quyền', birth_year: 1970, id_number: '001234567890', id_issue_date: '2020-02-03', id_issue_place: 'Cục Cảnh Sát', permanent_address: '45 Đường Chủ Quyền' };
const link = (value: Omit<typeof building, 'deleted_at'> & { deleted_at: string | null } = building, roomName = 'A101') => ({ contract: { id: `contract-${value.id}-${roomName}`, status: 'ACTIVE', deleted_at: null, room: { id: `room-${value.id}-${roomName}`, name: roomName, deleted_at: null, building: value } } });
const consoleErrors = new Map<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  consoleErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/rest/v1/building_legal_owners?*', route => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: owner });
  });
  // Khối "Hồ sơ tạm trú" trong cùng modal đọc ảnh hồ sơ; fixture không có ảnh nào.
  await page.route('**/rest/v1/residence_dossier_files?*', route => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: [] });
  });
});
test.afterEach(async ({ page }) => {
  expect(consoleErrors.get(page)).toEqual([]);
  consoleErrors.delete(page);
});

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
  await page.clock.setFixedTime(new Date('2026-09-14T16:59:59Z'));
  await page.goto(`${base}/__ct01.html`);
  const button = page.getByRole('button', { name: /Bản khai nhân khẩu/ });
  await expect(button).toBeVisible();
  await expect(page.getByLabel('Thời hạn tạm trú')).toHaveValue('24');
  const event = page.waitForEvent('download');
  // Khối "Hồ sơ tạm trú" đã tải hợp đồng đang ở lúc mở modal; chỉ đếm request do nút CT01 tạo ra.
  const requestsBeforeClick = requests;
  await button.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(page.getByRole('button', { name: 'Đang tạo tờ khai CT01…' })).toBeDisabled();
  await expect(page.getByLabel('Thời hạn tạm trú')).toBeDisabled();
  // A slow request crossing midnight keeps the day the user requested the file.
  await page.clock.setFixedTime(new Date('2026-09-14T17:01:00Z'));
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
  expect(xml.replace(/<[^>]+>/g, '').match(/ngày 14 tháng 09 năm 2026/g)).toHaveLength(4);
  expect(xml).toContain('HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ');
  expect(xml.replace(/<[^>]+>/g, '').split('BÊN THUÊ, MƯỢN, Ở NHỜ')[1]).toContain('Hiện thường trú: Ấp Kiểm Thử, Xã Bình Mỹ');
  expect(xml).toContain(owner.full_name);
  expect(xml).toContain('Đăng ký tạm trú 24 tháng tại');
  expect(xml.replace(/<[^>]+>/g, '')).toContain('Thời hạn mượn: 24 tháng (từ 14/09/2026 đến 14/09/2028)');
  expect(xml.replace(/<[^>]+>/g, '').split('BÊN THUÊ, MƯỢN, Ở NHỜ')[1]).toContain('Sinh năm: 05/12/2001');
  expect(xml).not.toContain('A101');
  expect(xml).not.toMatch(/\{\w+\}/);
  await expect(page.getByRole('dialog', { name: 'Chi tiết khách hàng' })).toBeVisible();
  expect(page.url()).toBe(`${base}/__ct01.html`);
  expect(requests - requestsBeforeClick).toBe(1);
  expect(errors).toEqual([]);
});

test('Word dùng detailed_address của bên B khi permanent_address khác nhau', async ({ page }) => {
  await page.route('**/rest/v1/contract_customers?*', route => route.fulfill({ json: [link()] }));
  await page.goto(`${base}/__ct01.html#conflicting-address`);
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: /Bản khai nhân khẩu/ }).click();
  const download = await event;
  const xml = new PizZip(await readFile((await download.path())!)).file('word/document.xml')!.asText();
  const leaseText = xml.replace(/<[^>]+>/g, '').split('BÊN THUÊ, MƯỢN, Ở NHỜ')[1];
  expect(leaseText).toContain('Hiện thường trú: Ấp Kiểm Thử, Xã Bình Mỹ');
  expect(leaseText).not.toContain('Địa chỉ thường trú cũ không dùng');
});

test('Word chỉ lấy địa chỉ chi tiết tòa, không nối các ô phường quận còn cũ', async ({ page }) => {
  const detailedAddress = '123 Đường Kiểm Thử, Phường Bình Thạnh, Thành phố Hồ Chí Minh';
  const fullAddressBuilding = {
    ...building, street_address: `  ${detailedAddress}  `,
    ward: 'Phường 14', district: 'Quận Gò Vấp', province: 'Hồ Chí Minh',
  };
  await page.route('**/rest/v1/contract_customers?*', route => route.fulfill({ json: [link(fullAddressBuilding)] }));
  await page.goto(`${base}/__ct01.html`);
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: /Bản khai nhân khẩu/ }).click();
  const download = await event;
  const xml = new PizZip(await readFile((await download.path())!)).file('word/document.xml')!.asText();
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g)!.map(paragraph => paragraph.replace(/<[^>]+>/g, '').trim());
  const registration = paragraphs.find(paragraph => paragraph.includes('Đăng ký tạm trú'))!;
  expect(registration.slice(registration.indexOf('Đăng ký tạm trú'))).toBe(`Đăng ký tạm trú 24 tháng tại ${detailedAddress}`);
  const addressLabel = 'Đối tượng của hợp đồng này là: Một phần hoặc toàn bộ căn nhà số:';
  const leaseAddresses = paragraphs.filter(paragraph => paragraph.includes(addressLabel))
    .map(paragraph => paragraph.slice(paragraph.indexOf(addressLabel) + addressLabel.length).trim());
  expect(leaseAddresses).toEqual([detailedAddress]);
  const leaseText = xml.replace(/<[^>]+>/g, '').split('HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ')[1];
  expect(leaseText.split(detailedAddress)).toHaveLength(2);
  expect(leaseText).toContain('Tại Phường Bình Thạnh');
  expect(leaseText).not.toContain('Phường 14');
  expect(xml).toContain('Công an Phường Bình Thạnh, Thành phố Hồ Chí Minh');
  expect(xml).not.toContain('Công an Phường 14');
  expect(xml).not.toContain('Quận Gò Vấp');
});

test('nhiều tòa cho chọn, loại hợp đồng cũ và tòa đã xóa', async ({ page }) => {
  const second = { ...building, id: 'ct01-demo-second', name: 'Tòa thứ hai', street_address: '456 Đường Kiểm Thử, Phường Thủ Đức, Thành phố Hồ Chí Minh', ward: 'Phường Thủ Đức' };
  await page.route('**/rest/v1/contract_customers?*', route => route.fulfill({ json: [link(), link(second), { contract: { ...link().contract, status: 'TERMINATED' } }, link({ ...building, id: 'deleted', name: 'Đã xóa', deleted_at: '2026-01-01' })] }));
  await page.goto(`${base}/__ct01.html`);
  await page.getByLabel('Thời hạn tạm trú').selectOption('12');
  await page.getByRole('button', { name: /Bản khai nhân khẩu/ }).click();
  await expect(page.getByRole('dialog', { name: 'Chọn phòng kê khai' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Đã xóa/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Tòa thứ hai/ }).getByText(second.street_address, { exact: true })).toBeVisible();
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: /Tòa thứ hai/ }).click();
  const download = await event;
  const xml = new PizZip(await readFile((await download.path())!)).file('word/document.xml')!.asText();
  expect(xml).toContain('Công an Phường Thủ Đức');
  expect(xml).not.toContain('Phường Bình Thạnh');
  expect(xml).toContain('Đăng ký tạm trú 12 tháng tại');
  expect(xml.replace(/<[^>]+>/g, '')).toContain('Thời hạn mượn: 12 tháng');
});

test('nhiều phòng cùng tòa vẫn cho chọn phòng tải nhưng hợp đồng không in số phòng', async ({ page }) => {
  await page.route('**/rest/v1/contract_customers?*', route => route.fulfill({ json: [link(), link(building, 'B202')] }));
  await page.goto(`${base}/__ct01.html`);
  await page.getByRole('button', { name: /Bản khai nhân khẩu/ }).click();
  await expect(page.getByRole('dialog', { name: 'Chọn phòng kê khai' })).toBeVisible();
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: /B202/ }).click();
  const result = await event;
  const xml = new PizZip(await readFile((await result.path())!)).file('word/document.xml')!.asText();
  expect(xml).not.toContain('B202');
  expect(xml).not.toContain('A101');
});

test('chưa nhập chủ quyền thì báo cần bổ sung và cho thử lại', async ({ page }) => {
  await page.route('**/rest/v1/contract_customers?*', route => route.fulfill({ json: [link()] }));
  await page.route('**/rest/v1/building_legal_owners?*', route => route.fulfill({ json: null }));
  await page.goto(`${base}/__ct01.html`);
  const button = page.getByRole('button', { name: /Bản khai nhân khẩu/ });
  await button.click();
  await expect(page.getByText(/Tòa nhà chưa.*chủ quyền/)).toBeVisible();
  await expect(button).toBeEnabled();
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
  await expect(page.getByRole('region', { name: 'Hồ sơ tạm trú' })).toHaveCount(0);
});

test('khối Hồ sơ tạm trú: hai hàng ảnh, cảnh báo thiếu chủ quyền, chưa cài extension thì hướng dẫn cài', async ({ page }) => {
  await page.route('**/rest/v1/contract_customers?*', route => route.fulfill({ json: [link()] }));
  await page.goto(`${base}/__ct01.html`);
  const section = page.getByRole('region', { name: 'Hồ sơ tạm trú' });
  await expect(section.getByText(/^Tờ khai CT01 đã ký/)).toBeVisible();
  await expect(section.getByText(/^Hợp đồng thuê đã ký/)).toBeVisible();
  await expect(section.getByRole('button', { name: 'Chụp ảnh' })).toHaveCount(2);
  await expect(section.getByLabel('Chụp ảnh Tờ khai CT01 đã ký')).toHaveAttribute('capture', 'environment');
  await expect(section.getByText(/chưa có ảnh giấy tờ chỗ ở hợp pháp/)).toBeVisible();
  await expect(section.getByLabel('Hạn tạm trú trên DVC')).toHaveValue('24');
  await section.getByRole('button', { name: 'Đăng ký tạm trú trên DVC' }).click();
  await expect(page.getByRole('dialog', { name: 'Cài extension iHome Tạm trú' })).toBeVisible();
  await expect(page.getByText('extensions/tam-tru')).toBeVisible();
  await page.getByRole('button', { name: 'Đóng' }).click();
  await expect(page.getByRole('dialog', { name: 'Chi tiết khách hàng' })).toBeVisible();
});
