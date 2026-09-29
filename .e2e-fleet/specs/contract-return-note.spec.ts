import { expect, test, type Page } from '@playwright/test';
import { createServer, transformWithEsbuild, type ViteDevServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Browser regression for the real dialog, hook, RPC serializer and readback panel.
// Like ct01-download.spec.ts, the route uses synthetic same-origin REST responses.
// No credentials, organization writes, real authorization or database persistence
// are exercised; unknown REST calls and every external request fail the test.
const ORG_ID = 'dddd0000-0000-4000-8000-000000000001';
const CONTRACT_ID = 'e2e00000-0000-4000-8000-000000000001';
const ROOM_ID = 'e2e00000-0000-4000-8000-000000000002';
const BUILDING_ID = 'e2e00000-0000-4000-8000-000000000003';
const CASE_ID = 'e2e00000-0000-4000-8000-000000000004';
const UPDATED_AT = '2026-09-29T03:00:00.000Z';
const KINDS = [
  { value: 'NATURAL_EXPIRY', label: 'Hết hạn hợp đồng', sample: 'Khách trả phòng do hết hạn hợp đồng.' },
  { value: 'EARLY_RETURN', label: 'Trả phòng trước hạn', sample: 'Khách trả phòng trước thời hạn hợp đồng.' },
  { value: 'FORFEIT', label: 'Bỏ cọc', sample: 'Khách trả phòng và bỏ cọc.' },
] as const;

let server: ViteDevServer;
let base: string;
test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });

test.beforeAll(async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const cssPath = path.join(await mkdtemp(path.join(tmpdir(), 'return-note-browser-')), 'app.css');
  execFileSync(process.execPath, [path.join(root, 'node_modules/tailwindcss/lib/cli.js'),
    '-i', path.join(root, 'src/index.css'), '-o', cssPath, '-c', path.join(root, 'tailwind.config.ts')],
  { cwd: root, stdio: 'pipe' });
  const css = await readFile(cssPath);
  const contract = {
    id: CONTRACT_ID, organization_id: ORG_ID, room_id: ROOM_ID, updated_at: UPDATED_AT,
    contract_number: 'E2E-NOI-DUNG-THANH-LY', status: 'ACTIVE',
    start_date: '2026-01-01', end_date: '2026-09-29', expected_move_out_date: null,
    total_deposit: 4_000_000, deposit_paid: 4_000_000, rent_price: 2_000_000,
    contract_customers: [], contract_services: [],
    room: { id: ROOM_ID, name: 'Phòng thử UI', building_id: BUILDING_ID,
      building: { id: BUILDING_ID, name: 'Tòa thử UI' } },
  };
  const modules: Record<string, string> = {
    '/__return_note_fixture.tsx': `
      import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {MemoryRouter} from 'react-router-dom'; import {Toaster} from 'sonner';
      import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
      import {TerminateDialog} from '@/components/contracts/TerminateDialog';
      import {ContractExitCasePanel} from '@/components/contracts/ContractExitCasePanel';
      const contract = ${JSON.stringify(contract)};
      const qc = new QueryClient({defaultOptions:{queries:{retry:false}}});
      function Fixture() {
        const [open, setOpen] = useState(location.hash !== '#saved');
        return <><ContractExitCasePanel contract={contract}/>
          <TerminateDialog open={open} onOpenChange={value => {setOpen(value); if(!value) location.hash='saved';}} contract={contract}/>
          <Toaster/></>;
      }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={qc}><MemoryRouter><Fixture/></MemoryRouter></QueryClientProvider>);
    `,
    '@/contexts/OrganizationContext': `export const useOrganization=()=>({selectedOrganizationId:'${ORG_ID}'});`,
    '@/hooks/useMyPermissions': 'export const useMyPermissions=()=>({data:{contracts:{view:true,terminate:true,edit:false}}});',
    '@/hooks/useContracts': 'const data=[]; export const useUnpaidInvoices=()=>({data});',
    '@/hooks/useInvoices': 'export const useExcessAmount=()=>({data:0});',
    '@/hooks/useAccounts': 'const data=[]; export const useAccounts=()=>({data});',
    '@/hooks/useMeters': 'const data=[]; export const useMeters=()=>({data,isPending:false,isError:false});',
    '@/hooks/useBuildingServices': 'const data=[]; export const useBuildingServices=()=>({data});',
    '@/components/contracts/ContractTransferLinkPanel': 'export function ContractTransferLinkPanel(){return null;}',
    '@/components/contracts/ContractMeterBoundaryPanel': 'export function ContractMeterBoundaryPanel(){return null;}',
    '@/integrations/supabase/client': `import {createClient} from '@supabase/supabase-js'; export const supabase=createClient(location.origin,'synthetic-fixture-key',{auth:{persistSession:false,autoRefreshToken:false}});`,
  };
  server = await createServer({
    configFile: false, root, cacheDir: path.join(root, 'node_modules/.vite-return-note-browser'),
    optimizeDeps: { noDiscovery: true, include: [
      'react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client',
      'react-router-dom', 'react-hook-form', '@hookform/resolvers/zod', 'zod', 'lucide-react',
      'sonner', '@supabase/supabase-js', '@tanstack/react-query', '@radix-ui/react-dialog',
      '@radix-ui/react-alert-dialog', '@radix-ui/react-label', '@radix-ui/react-radio-group',
      '@radix-ui/react-select', '@radix-ui/react-slot', '@radix-ui/react-popover',
      'class-variance-authority', 'clsx', 'tailwind-merge', 'date-fns', 'react-day-picker',
    ] },
    resolve: { alias: [
      ...Object.keys(modules).filter(id => id.startsWith('@')).map(id => ({ find: id, replacement: `virtual:return-note:${id}` })),
      { find: '@', replacement: path.join(root, 'src') },
    ] },
    plugins: [{
      name: 'contract-return-note-browser-fixture', enforce: 'pre',
      resolveId(id) {
        if (id === './ContractTransferLinkPanel' || id === './ContractMeterBoundaryPanel') {
          return `\0return-note:@/components/contracts/${id.slice(2)}`;
        }
        if (id in modules) return `\0return-note:${id}`;
        if (id.startsWith('virtual:return-note:')) return `\0return-note:${id.slice('virtual:return-note:'.length)}`;
      },
      async load(id) {
        if (id.startsWith('\0return-note:')) return (await transformWithEsbuild(
          modules[id.slice('\0return-note:'.length)], 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' },
        )).code;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url === '/__return_note.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); return; }
          if (!req.url?.startsWith('/__return_note.html')) return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(await vite.transformIndexHtml('/__return_note.html', '<html><head><meta charset="UTF-8"><link rel="stylesheet" href="/__return_note.css"></head><body><div id="root"></div><script type="module" src="/__return_note_fixture.tsx"></script></body></html>'));
        });
      },
    }], server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  base = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); });

interface Audit {
  errors: string[];
  blocked: string[];
  writes: Record<string, unknown>[];
  reads: number;
}
const audits = new Map<Page, Audit>();

test.beforeEach(async ({ page }) => {
  const audit: Audit = { errors: [], blocked: [], writes: [], reads: 0 };
  audits.set(page, audit);
  let saved: Record<string, unknown> | null = null;
  page.on('pageerror', error => audit.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') audit.errors.push(message.text()); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
    if (url.origin === base && rpc) {
      expect(request.method()).toBe('POST');
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body.p_organization_id).toBe(ORG_ID);
      if (rpc === 'confirm_contract_return_v1') {
        audit.writes.push(body);
        saved = {
          id: CASE_ID, organization_id: ORG_ID, building_id: BUILDING_ID,
          contract_id: CONTRACT_ID, room_at_handover_id: ROOM_ID,
          actual_move_out_on: body.p_actual_move_out_on,
          initial_kind: body.p_initial_kind, current_kind: body.p_initial_kind,
          return_note: body.p_return_note, settlement_mode: body.p_settlement_mode,
          state: body.p_settlement_mode === 'DEFERRED' ? 'PENDING' : 'FINALIZED',
          version: 1, created_at: UPDATED_AT, updated_at: UPDATED_AT,
          settlement_result: null, kind_history: [],
        };
        return route.fulfill({ json: saved });
      }
      if (rpc === 'list_contract_exit_cases_v1') {
        expect(body.p_contract_id).toBe(CONTRACT_ID);
        audit.reads++;
        return route.fulfill({ json: { items: saved ? [saved] : [], total: saved ? 1 : 0, limit: 1, offset: 0 } });
      }
      if (rpc === 'read_contract_transfer_links_v1') return route.fulfill({ json: [] });
    }
    if (url.origin === base && url.pathname === '/rest/v1/meters' && request.method() === 'GET') {
      return route.fulfill({ json: [] });
    }
    if (url.origin === base && !url.pathname.startsWith('/rest/') && ['GET', 'HEAD'].includes(request.method())) {
      return route.continue();
    }
    audit.blocked.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const audit = audits.get(page)!;
  await testInfo.attach('return-note-browser-audit.json', { body: JSON.stringify(audit, null, 2), contentType: 'application/json' });
  expect(audit.blocked, 'Only declared synthetic REST calls may run').toEqual([]);
  expect(audit.errors, 'Browser console and uncaught errors').toEqual([]);
  audits.delete(page);
});

async function openReturn(page: Page) {
  await page.goto(`${base}/__return_note.html`);
  const dialog = page.getByRole('dialog', { name: 'Thanh lý hợp đồng', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('nội dung bắt buộc: chọn loại không tự điền, khoảng trắng khóa cả hai nhánh', async ({ page }) => {
  const dialog = await openReturn(page);
  const note = dialog.getByRole('textbox', { name: /Nội dung thanh lý/ });
  const defer = dialog.getByRole('button', { name: 'Trả phòng, quyết toán sau', exact: true });
  const immediate = dialog.getByRole('button', { name: 'Tiếp tục quyết toán ngay', exact: true });
  await expect(note).toHaveAttribute('required', '');
  await expect(note).toHaveValue('');
  await expect(defer).toBeDisabled();
  await expect(immediate).toBeDisabled();
  for (const kind of KINDS) {
    await dialog.getByRole('radio', { name: kind.label, exact: true }).check();
    await expect(note).toHaveValue('');
    await expect(defer).toBeDisabled();
    await expect(immediate).toBeDisabled();
  }
  await note.fill('   \n\t ');
  await expect(defer).toBeDisabled();
  await expect(immediate).toBeDisabled();
  await note.fill('Khách đã bàn giao phòng; hẹn đối chiếu điện nước ngày mai.');
  await expect(defer).toBeEnabled();
  await expect(immediate).toBeEnabled();
  expect(audits.get(page)!.writes).toEqual([]);
});

test('mỗi loại có mẫu để dùng; đổi loại giữ nguyên nội dung đã nhập', async ({ page }) => {
  const dialog = await openReturn(page);
  const note = dialog.getByRole('textbox', { name: /Nội dung thanh lý/ });
  const templates = dialog.getByRole('button', { name: 'Dùng nội dung mẫu', exact: true });
  await expect(templates).toHaveCount(0);
  const samples: string[] = [];
  for (let index = 0; index < KINDS.length; index++) {
    await dialog.getByRole('radio', { name: KINDS[index].label, exact: true }).check();
    await expect(templates).toHaveCount(1);
    await expect(dialog.getByText(KINDS[index].sample, { exact: true })).toBeVisible();
    await templates.click();
    const sample = await note.inputValue();
    expect(sample).toBe(KINDS[index].sample);
    await expect(dialog.getByText(sample, { exact: true }).first()).toBeVisible();
    samples.push(sample);
  }
  expect(new Set(samples).size).toBe(3);
  const custom = 'Khách trả trước hạn do chuyển công tác; giữ nội dung nhân viên nhập.';
  await note.fill(custom);
  for (const kind of KINDS) {
    await dialog.getByRole('radio', { name: kind.label, exact: true }).check();
    await expect(note).toHaveValue(custom);
  }
  expect(audits.get(page)!.writes).toEqual([]);
});

test('quyết toán sau gửi p_return_note và đọc lại nội dung trong hồ sơ', async ({ page }) => {
  const dialog = await openReturn(page);
  const note = 'Khách bàn giao chìa khóa.\nHẹn bổ sung chỉ số nước ngày mai.';
  await dialog.getByRole('radio', { name: 'Trả phòng trước hạn', exact: true }).check();
  await dialog.getByRole('textbox', { name: /Nội dung thanh lý/ }).fill(`  ${note}  `);
  await dialog.getByRole('button', { name: 'Trả phòng, quyết toán sau', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(audits.get(page)!.writes).toHaveLength(1);
  expect(audits.get(page)!.writes[0]).toMatchObject({
    p_contract_id: CONTRACT_ID, p_expected_contract_updated_at: UPDATED_AT,
    p_initial_kind: 'EARLY_RETURN', p_settlement_mode: 'DEFERRED', p_return_note: note, p_settlement: null,
  });
  const panel = page.getByRole('region', { name: 'Hồ sơ trả phòng', exact: true });
  await expect(panel.getByText(note, { exact: true })).toBeVisible();
  const reads = audits.get(page)!.reads;
  await page.reload();
  await expect(panel.getByText(note, { exact: true })).toBeVisible();
  expect(audits.get(page)!.reads).toBeGreaterThan(reads);
  await panel.getByRole('button', { name: 'Quyết toán hồ sơ này', exact: true }).click();
  const reopen = page.getByRole('dialog', { name: 'Quyết toán hồ sơ đã trả phòng', exact: true });
  await expect(reopen.getByText(note, { exact: true })).toBeVisible();
  await expect(reopen.getByRole('textbox', { name: /Nội dung thanh lý/ })).toHaveCount(0);
  await expect(reopen.getByRole('button', { name: 'Tiếp tục quyết toán', exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('return-note-readback.png'), animations: 'disabled' });
});

test('mobile 390px: nhập và dùng mẫu không tràn ngang, cuộn tới hai hành động', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await openReturn(page);
  const note = dialog.getByRole('textbox', { name: /Nội dung thanh lý/ });
  await dialog.getByRole('radio', { name: 'Trả phòng trước hạn', exact: true }).check();
  await dialog.getByRole('button', { name: 'Dùng nội dung mẫu', exact: true }).click();
  await expect(note).toHaveValue(KINDS[1].sample);
  await note.fill('Khách giao đủ chìa khóa.\nHẹn đối chiếu điện nước sau khi nhận hóa đơn.');
  for (const name of ['Trả phòng, quyết toán sau', 'Tiếp tục quyết toán ngay']) {
    const button = dialog.getByRole('button', { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport();
    await expect(button).toBeEnabled();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await dialog.screenshot({ path: test.info().outputPath('return-note-mobile.png'), animations: 'disabled' });
});

for (const kind of KINDS) {
  test(`quyết toán ngay ${kind.label}: qua lại bước vẫn giữ nội dung và gửi đủ tham số RPC`, async ({ page }) => {
    const dialog = await openReturn(page);
    const note = `Nội dung riêng cho ${kind.label}: đã kiểm tra bàn giao.`;
    await dialog.getByRole('radio', { name: kind.label, exact: true }).check();
    await dialog.getByRole('textbox', { name: /Nội dung thanh lý/ }).fill(note);
    await dialog.getByRole('button', { name: 'Tiếp tục quyết toán ngay', exact: true }).click();
    const settlement = page.getByRole('dialog', { name: /Quyết toán — Khách/ });
    await settlement.getByRole('button', { name: 'Quay lại', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: /Nội dung thanh lý/ })).toHaveValue(note);
    await dialog.getByRole('button', { name: 'Tiếp tục quyết toán ngay', exact: true }).click();
    await settlement.getByRole('button', { name: /Lập hoá đơn & [Tt]hanh lý/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Xác nhận thanh lý', exact: true }).click();
    await expect(settlement).not.toBeVisible();
    expect(audits.get(page)!.writes).toHaveLength(1);
    expect(audits.get(page)!.writes[0]).toMatchObject({
      p_contract_id: CONTRACT_ID, p_initial_kind: kind.value,
      p_settlement_mode: 'IMMEDIATE', p_return_note: note,
    });
    expect(audits.get(page)!.writes[0].p_settlement).toEqual(expect.any(Object));
    await expect(page.getByRole('region', { name: 'Hồ sơ trả phòng', exact: true }).getByText(note, { exact: true })).toBeVisible();
  });
}
