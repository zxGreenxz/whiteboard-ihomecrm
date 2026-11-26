// @vitest-environment jsdom
// Đợt 10b (plan sửa khoá vĩnh viễn sau rớt mạng): năm nơi trước đây «xoá rồi chèn lại» bằng nhiều lệnh ở trình duyệt
// (dịch vụ mặc định của toà, sửa định mức, sửa phiếu nhập, vật tư của công việc, dịch vụ của hợp đồng khi sửa) nay gọi
// MỘT hàm máy chủ thay nguyên tử cả bộ (migration 20261126180450_xoa_chen_mot_giao_dich.sql). Máy chủ giả dưới đây dựng
// theo thân năm hàm: một giao dịch (lỗi ở bất kỳ bước nào ⇒ lùi cả, dòng cũ còn nguyên), sửa đầu phiếu, xoá mọi dòng cũ,
// còn dòng cũ nhìn thấy được ⇒ 42501, chèn bộ mới, trả đúng bộ đã ghi. Mỗi nơi: lệnh không tới máy chủ, tới nhưng mất phản
// hồi (bấm lại cho đúng MỘT bộ), dấu bản trước gieo sẵn; biên nhận lệch ⇒ chưa rõ; từ chối rõ ⇒ câu rõ, không còn câu «đã
// xoá … chưa ghi lại / thiếu …».
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from './fakeRecordServer';

type Row = Record<string, unknown>;
type Reply = { data: unknown; error: unknown };
const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, tables: [] as string[] }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }), keepPreviousData: (value: unknown) => value }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => { io.tables.push(table); return io.server.from(table); }, get rpc() { return io.server.rpc; } } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { useUpsertBuildingServices } from '../useBuildingServices';
import { useUpdateServiceQuota } from '../useServices';
import { useUpdateMaterialPurchase } from '../useMaterialPurchases';
import { useUpsertJobMaterialUsage } from '../useMaterialUsages';
import { useSyncContractServices } from '../useContracts';
import { RepeatableWriteUnknownError, isConfirmedFinancialRejection } from '@/lib/financialWorkflow';
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { loadContractEditJob, runContractEdit, type ContractEditPorts, type ContractEditRequest } from '@/lib/contractEditWorkflow';

// ── Máy chủ giả: năm hàm thay nguyên tử ─────────────────────────────────────────────────────────────────────────────
let seq = 0;
/** Lệnh kế tiếp của hàm bị máy chủ từ chối ở cuối giao dịch (sau khi đã xoá và chèn): cả giao dịch lùi. */
const refuseNext = new Map<string, { code: string; message: string }>();
/** Lệnh kế tiếp của hàm ghi thật nhưng biên nhận trả về bị sửa (hàng rào: không tin biên nhận lệch). */
const tamperNext = new Map<string, (data: unknown) => unknown>();
/** Phiếu xuất mà tài khoản sửa được nhưng không được xoá (RLS DELETE riêng). */
const undeletableUsages = new Set<string>();

const rowsOf = (table: string): Row[] => (io.server.rows[table] ??= []);
const pick = (row: Row, keys: string[]): Row => Object.fromEntries(keys.map(key => [key, row[key] ?? null]));
const byKeys = (...keys: string[]) => (a: Row, b: Row) => keys.map(key => String(a[key]).localeCompare(String(b[key]))).find(order => order !== 0) ?? 0;
const rpcCount = (name: string) => io.server.rpcCalls.filter(call => call.name === name).length;

function transaction(name: string, body: () => unknown): Reply {
  const before = structuredClone(io.server.rows);
  try {
    const data = body();
    const refusal = refuseNext.get(name);
    if (refusal) { refuseNext.delete(name); throw refusal; }
    const tamper = tamperNext.get(name);
    if (tamper) { tamperNext.delete(name); return { data: tamper(structuredClone(data)), error: null }; }
    return { data, error: null };
  } catch (error) {
    io.server.rows = before;
    return { data: null, error };
  }
}

/** Xoá mọi dòng con của cha (theo RLS sửa/xoá); còn dòng cũ ⇒ 42501; chèn bộ mới (công ty suy từ cha như trigger). */
function replaceLines(table: string, column: string, parentId: string, lines: Row[], denied: string, parentOrg: unknown, unique?: (row: Row) => string): Row[] {
  const writable = io.server.writable[table] ?? (() => true);
  io.server.rows[table] = rowsOf(table).filter(row => row[column] !== parentId || !writable(row));
  if (rowsOf(table).some(row => row[column] === parentId)) throw { code: '42501', message: denied };
  const stored: Row[] = [];
  for (const line of lines) {
    const row: Row = { id: `${table}-${++seq}`, [column]: parentId, ...line, organization_id: parentOrg };
    if ('quantity' in line && !(Number(line.quantity) > 0)) throw { code: '23514', message: `new row for relation "${table}" violates check constraint "${table}_quantity_check" raw SQL` };
    if (unique && [...rowsOf(table), ...stored].some(other => unique(other) === unique(row))) throw { code: '23505', message: `duplicate key value violates unique constraint "${table}_key" raw SQL` };
    stored.push(row);
  }
  rowsOf(table).push(...stored);
  return stored;
}

function installAtomicServer(server: FakeRecordServer) {
  server.rpcHandlers.replace_building_services_v1 = args => transaction('replace_building_services_v1', () =>
    replaceLines('building_services', 'building_id', String(args.p_building_id), (args.p_services as Row[]).map(item => pick(item, ['service_id', 'is_active', 'unit_price_override'])),
      'Chưa gỡ được dịch vụ cũ của toà: tài khoản chưa có quyền gỡ dịch vụ này. Chưa lưu thay đổi nào.', 'org-of-building', row => `${row.building_id}:${row.service_id}`)
      .map(row => pick(row, ['id', 'building_id', 'service_id', 'is_active', 'unit_price_override'])).sort(byKeys('service_id')));
  server.rpcHandlers.replace_service_quota_v1 = args => transaction('replace_service_quota_v1', () => {
    const writable = server.writable.service_quotas ?? (() => true);
    const quota = rowsOf('service_quotas').find(row => row.id === args.p_quota_id && writable(row));
    if (!quota) throw { code: 'P0002', message: 'Không tìm thấy định mức này hoặc tài khoản chưa có quyền sửa. Tải lại danh sách để kiểm tra.' };
    Object.assign(quota, { name: args.p_name, description: args.p_description });
    const tiers = replaceLines('service_quota_tiers', 'quota_id', String(quota.id), (args.p_tiers as Row[]).map(item => pick(item, ['tier_number', 'from_value', 'to_value', 'unit_price'])),
      'Chưa gỡ được bậc giá cũ của định mức: tài khoản chưa có quyền gỡ bậc. Chưa lưu thay đổi nào.', quota.organization_id, row => `${row.quota_id}:${row.tier_number}`);
    return { quota: pick(quota, ['id', 'name', 'description', 'organization_id']), tiers: tiers.map(row => pick(row, ['id', 'quota_id', 'tier_number', 'from_value', 'to_value', 'unit_price'])).sort((a, b) => Number(a.tier_number) - Number(b.tier_number)) };
  });
  server.rpcHandlers.replace_material_purchase_v1 = args => transaction('replace_material_purchase_v1', () => {
    const writable = server.writable.material_purchases ?? (() => true);
    const header = rowsOf('material_purchases').find(row => row.id === args.p_purchase_id && writable(row));
    if (!header) throw { code: 'P0002', message: 'Không tìm thấy phiếu nhập này hoặc tài khoản chưa có quyền sửa. Tải lại danh sách để kiểm tra.' };
    Object.assign(header, { purchase_date: args.p_purchase_date, supplier_id: args.p_supplier_id, notes: args.p_notes });
    const items = replaceLines('material_purchase_items', 'purchase_id', String(header.id), (args.p_items as Row[]).map(item => pick(item, ['material_id', 'quantity', 'unit_price'])),
      'Chưa gỡ được các dòng cũ của phiếu nhập: tài khoản chưa có quyền xoá dòng. Chưa lưu thay đổi nào.', header.organization_id);
    header.total = purchaseTotal(String(header.id));
    return { purchase: pick(header, ['id', 'organization_id', 'code', 'purchase_date', 'supplier_id', 'notes', 'total']), items: items.map(row => pick(row, ['id', 'purchase_id', 'material_id', 'quantity', 'unit_price'])).sort(byKeys('material_id', 'id')) };
  });
  server.rpcHandlers.save_job_material_usage_v1 = args => transaction('save_job_material_usage_v1', () => {
    const items = (args.p_items as Row[]).map(item => pick(item, ['material_id', 'quantity', 'unit_cost_at_usage']));
    const writable = server.writable.material_usages ?? (() => true);
    const denied = 'Chưa gỡ được vật tư cũ của công việc: tài khoản chưa có quyền xoá dòng. Chưa lưu thay đổi nào.';
    let usage = rowsOf('material_usages').find(row => row.job_id === args.p_job_id);
    let removed = false;
    if (usage) {
      if (!writable(usage)) throw { code: 'P0002', message: 'Không sửa được phiếu xuất của công việc này: tài khoản chưa có quyền sửa, hoặc phiếu vừa bị xoá. Tải lại để kiểm tra.' };
      Object.assign(usage, { usage_date: args.p_usage_date, notes: args.p_notes });
      replaceLines('material_usage_items', 'usage_id', String(usage.id), [], denied, usage.organization_id);
      if (!items.length && !undeletableUsages.has(String(usage.id))) {
        const gone = usage;
        io.server.rows.material_usages = rowsOf('material_usages').filter(row => row !== gone);
        removed = true;
      }
    } else if (!items.length) {
      return { usage_id: null, usage: null, removed: false, items: [] };
    } else {
      usage = { id: `material_usages-${++seq}`, job_id: args.p_job_id, code: `PX-${seq}`, usage_date: args.p_usage_date, notes: args.p_notes, organization_id: 'org-of-job' };
      rowsOf('material_usages').push(usage);
    }
    const lines = items.length ? replaceLines('material_usage_items', 'usage_id', String(usage.id), items, denied, usage.organization_id) : [];
    return { usage_id: usage.id, usage: removed ? null : pick(usage, ['id', 'job_id', 'code', 'usage_date', 'notes', 'organization_id']), removed,
      items: lines.map(row => pick(row, ['id', 'usage_id', 'material_id', 'quantity', 'unit_cost_at_usage'])).sort(byKeys('material_id', 'id')) };
  });
  server.rpcHandlers.replace_contract_services_v1 = args => transaction('replace_contract_services_v1', () =>
    replaceLines('contract_services', 'contract_id', String(args.p_contract_id), (args.p_services as Row[]).map(item => pick(item, ['service_id', 'unit_price', 'initial_reading'])),
      'Chưa gỡ được dịch vụ cũ của hợp đồng: tài khoản chưa có quyền gỡ dịch vụ này. Chưa lưu thay đổi nào.', 'org-of-contract', row => `${row.contract_id}:${row.service_id}`)
      .map(row => pick(row, ['id', 'contract_id', 'service_id', 'unit_price', 'initial_reading'])).sort(byKeys('service_id')));
}

// ── Kỳ vọng chung ───────────────────────────────────────────────────────────────────────────────────────────────────
type Mutation<I> = { mutationFn: (input: I) => Promise<unknown> };
const tenMinutesAgo = () => new Date(Date.now() - 10 * 60_000);
const legacy = (namespace: string, organizationId: string, businessKey: string) => seedLegacyPending({ namespace, userId: 'actor', organizationId, businessKey }, tenMinutesAgo());
/** Câu báo của cơ chế nhiều lệnh cũ (trạng thái dở giữa xoá và chèn) không được còn ở năm nơi này. */
const PARTIAL = /có thể đang thiếu|đang chưa có dòng|tạm tính như vậy|nhưng chưa (lưu|ghi)|Đã gỡ|Đã xoá (các dòng|vật tư) cũ/i;

async function rejection(task: Promise<unknown>): Promise<unknown> {
  return task.then(() => { throw new Error('Lệnh ghi phải báo lỗi'); }, (error: unknown) => error);
}
/** Chưa rõ kết quả: nói rõ máy chủ thay cả bộ trong MỘT lần, bấm lại được, không khoá, không để dấu. */
function expectUnknown(error: unknown, button: RegExp) {
  expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
  expect(recordWriteBlocked(error)).toBe(false);
  const message = (error as Error).message;
  expect(message).toMatch(/một lần/);
  expect(message).toMatch(/hoặc chưa ghi gì, hoặc đã ghi đủ/);
  expect(message).toMatch(/không nhân đôi/);
  expect(message).toMatch(button);
  expect(message).not.toMatch(PARTIAL);
  expect(pendingKeys()).toEqual([]);
}
/** Từ chối rõ: không chưa rõ, không khoá, câu không lộ SQL và không còn câu «đã xoá … / thiếu …». */
function expectRefused(error: unknown, text?: RegExp) {
  expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
  expect(isConfirmedFinancialRejection(error)).toBe(true);
  expect(recordWriteBlocked(error)).toBe(false);
  const shown = recordWriteMessage(error, 'lưu');
  if (text) expect(shown).toMatch(text);
  expect(shown).not.toMatch(PARTIAL);
  expect(shown).not.toMatch(/raw SQL|violates|duplicate key/);
  expect(pendingKeys()).toEqual([]);
}
/** Hàng rào biên nhận: các kiểu lệch chung cho mọi bộ dòng. */
const listTampers: Array<[string, (rows: Row[]) => unknown]> = [
  ['thiếu một dòng', rows => rows.slice(1)],
  ['thừa một dòng', rows => [...rows, { ...rows[0], id: 'extra-row' }]],
  ['trùng mã dòng', rows => rows.map(row => ({ ...row, id: rows[0].id }))],
  ['mã dòng không phải chuỗi', rows => rows.map((row, index) => (index ? row : { ...row, id: 7 }))],
  ['sai dạng (không phải mảng)', () => ({ rows: [] })],
];
const changeFirst = (field: string, value: unknown) => (rows: Row[]) => rows.map((row, index) => (index ? row : { ...row, [field]: value }));

beforeEach(() => {
  io.server = fakeRecordServer();
  io.tables = [];
  installAtomicServer(io.server);
  refuseNext.clear();
  tamperNext.clear();
  undeletableUsages.clear();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
});
afterEach(() => { vi.useRealTimers(); });

// ── 1. Dịch vụ mặc định của toà ─────────────────────────────────────────────────────────────────────────────────────
describe('dịch vụ mặc định của toà (replace_building_services_v1)', () => {
  type Input = { buildingId: string; services: { service_id: string; is_active: boolean; unit_price_override: number | null }[] };
  const save = () => (renderHook(() => useUpsertBuildingServices({ silent: true })).result.current as unknown as Mutation<Input>).mutationFn;
  const input: Input = { buildingId: 'b1', services: [{ service_id: 's1', is_active: true, unit_price_override: 12 }, { service_id: 's2', is_active: false, unit_price_override: null }] };
  const links = (building = 'b1') => rowsOf('building_services').filter(row => row.building_id === building).map(row => `${row.service_id}:${row.is_active}:${row.unit_price_override}`).sort();
  const TARGET = ['s1:true:12', 's2:false:null'];
  const BUTTON = /Bấm lại nút lưu/;
  beforeEach(() => {
    io.server.rows.building_services = [
      { id: 'bs-old', building_id: 'b1', service_id: 's0', is_active: true, unit_price_override: null, organization_id: 'org-a' },
      { id: 'bs-other', building_id: 'b2', service_id: 's0', is_active: true, unit_price_override: 5, organization_id: 'org-a' },
    ];
  });

  it('gửi MỘT lệnh với bộ đích đầy đủ, không gửi organization_id, không ghi thẳng bảng; trả mã các dòng đã ghi', async () => {
    const saved = await save()(input);
    expect(io.server.rpcCalls).toEqual([{ name: 'replace_building_services_v1', args: { p_building_id: 'b1', p_services: input.services } }]);
    expect(JSON.stringify(io.server.rpcCalls)).not.toContain('organization_id');
    expect(io.tables).toEqual([]);
    expect(links()).toEqual(TARGET);
    expect(links('b2')).toEqual(['s0:true:5']);
    expect([...(saved as string[])].sort()).toEqual(rowsOf('building_services').filter(row => row.building_id === 'b1').map(row => row.id).sort());
  });

  it('lệnh không tới máy chủ: báo chưa rõ (thay cả bộ một lần), không dấu; bấm lại ghi đúng bộ', async () => {
    const run = save();
    io.server.failNext('replace_building_services_v1', 'rpc', 'drop-before');
    expectUnknown(await rejection(run(input)), BUTTON);
    expect(links()).toEqual(['s0:true:null']);
    await expect(run(input)).resolves.toHaveLength(2);
    expect(links()).toEqual(TARGET);
  });

  it('tới nhưng mất phản hồi: đã ghi đủ bộ; bấm lại cho đúng MỘT bộ, không nhân đôi', async () => {
    const run = save();
    io.server.failNext('replace_building_services_v1', 'rpc', 'drop-after');
    expectUnknown(await rejection(run(input)), BUTTON);
    expect(links()).toEqual(TARGET);
    await expect(run(input)).resolves.toHaveLength(2);
    expect(links()).toEqual(TARGET);
    expect(rpcCount('replace_building_services_v1')).toBe(2);
  });

  it('dấu bản trước (phạm vi người dùng) không chặn; lưu xong thì gỡ đúng dấu của toà đó', async () => {
    const key = legacy('building-services-replace', 'actor-scope', 'b1');
    const other = legacy('building-services-replace', 'actor-scope', 'b2');
    await save()(input);
    expect(localStorage.getItem(key)).toBeNull();
    expect(pendingKeys()).toEqual([other]);
  });

  it('bộ rỗng: một lệnh với mảng rỗng, toà không còn dịch vụ mặc định nào', async () => {
    await expect(save()({ buildingId: 'b1', services: [] })).resolves.toEqual([]);
    expect(io.server.rpcCalls).toEqual([{ name: 'replace_building_services_v1', args: { p_building_id: 'b1', p_services: [] } }]);
    expect(links()).toEqual([]);
  });

  it('máy chủ từ chối giữa giao dịch (trùng dịch vụ): lùi cả, dịch vụ cũ còn nguyên; câu rõ, không gửi lại tự động', async () => {
    refuseNext.set('replace_building_services_v1', { code: '23505', message: 'duplicate key value violates unique constraint "building_services_unique" raw SQL' });
    expectRefused(await rejection(save()(input)));
    expect(links()).toEqual(['s0:true:null']);
    expect(rpcCount('replace_building_services_v1')).toBe(1);
  });

  it('không có quyền gỡ dịch vụ cũ (42501 của hàm): câu của máy chủ, chưa lưu gì', async () => {
    io.server.writable.building_services = row => row.id !== 'bs-old';
    const error = await rejection(save()(input));
    expectRefused(error, /chưa có quyền gỡ dịch vụ[\s\S]*Chưa lưu thay đổi nào/);
    expect(links()).toEqual(['s0:true:null']);
  });

  it.each([
    ...listTampers,
    ['sai giá', changeFirst('unit_price_override', 13)],
    ['sai trạng thái', changeFirst('is_active', false)],
    ['sai dịch vụ', changeFirst('service_id', 's9')],
    ['sai mã toà', changeFirst('building_id', 'b2')],
  ])('hàng rào: biên nhận lệch (%s) không được tính là đã lưu; bấm lại cho đúng một bộ', async (_label, tamper) => {
    const run = save();
    tamperNext.set('replace_building_services_v1', data => tamper(data as Row[]));
    expectUnknown(await rejection(run(input)), BUTTON);
    await expect(run(input)).resolves.toHaveLength(2);
    expect(links()).toEqual(TARGET);
  });
});

// ── 2. Định mức: tên, mô tả, bậc giá ────────────────────────────────────────────────────────────────────────────────
describe('sửa định mức (replace_service_quota_v1)', () => {
  type Tier = { tier_number: number; from_value: number; to_value: number | null; unit_price: number };
  type Input = { id: string; name: string; description?: string | null; tiers: Tier[] };
  const update = () => (renderHook(() => useUpdateServiceQuota()).result.current as unknown as Mutation<Input>).mutationFn;
  const tiersIn: Tier[] = [{ tier_number: 1, from_value: 0, to_value: 50, unit_price: 120 }, { tier_number: 2, from_value: 50, to_value: null, unit_price: 150 }];
  const input: Input = { id: 'q1', name: 'Điện bậc', description: '', tiers: tiersIn };
  const tiers = () => rowsOf('service_quota_tiers').filter(row => row.quota_id === 'q1').map(row => `${row.tier_number}:${row.from_value}-${row.to_value}:${row.unit_price}`).sort();
  const TARGET = ['1:0-50:120', '2:50-null:150'];
  const OLD = ['1:0-null:100'];
  const BUTTON = /Bấm lại nút Cập nhật/;
  const tierTamper = (change: (rows: Row[]) => unknown) => (data: unknown) => ({ ...(data as Row), tiers: change((data as Row).tiers as Row[]) });
  beforeEach(() => {
    io.server.rows.service_quotas = [{ id: 'q1', name: 'Điện', description: null, organization_id: 'org-a' }];
    io.server.rows.service_quota_tiers = [{ id: 't-old', quota_id: 'q1', tier_number: 1, from_value: 0, to_value: null, unit_price: 100, organization_id: 'org-a' }];
  });

  it('gửi MỘT lệnh: tên, mô tả (rỗng ⇒ null) và cả bộ bậc, không organization_id, không ghi thẳng bảng; trả đầu định mức', async () => {
    await expect(update()(input)).resolves.toEqual({ id: 'q1', name: 'Điện bậc', description: null, organization_id: 'org-a' });
    expect(io.server.rpcCalls).toEqual([{ name: 'replace_service_quota_v1', args: { p_quota_id: 'q1', p_name: 'Điện bậc', p_description: null, p_tiers: tiersIn } }]);
    expect(JSON.stringify(io.server.rpcCalls)).not.toContain('organization_id');
    expect(io.tables).toEqual([]);
    expect(tiers()).toEqual(TARGET);
  });

  it('lệnh không tới máy chủ: báo chưa rõ, không dấu; tên và bậc cũ còn nguyên; bấm lại ghi đủ', async () => {
    const save = update();
    io.server.failNext('replace_service_quota_v1', 'rpc', 'drop-before');
    expectUnknown(await rejection(save(input)), BUTTON);
    expect(tiers()).toEqual(OLD);
    expect(rowsOf('service_quotas')[0].name).toBe('Điện');
    await save(input);
    expect(tiers()).toEqual(TARGET);
  });

  it('tới nhưng mất phản hồi: bấm lại cho đúng MỘT bộ bậc', async () => {
    const save = update();
    io.server.failNext('replace_service_quota_v1', 'rpc', 'drop-after');
    expectUnknown(await rejection(save(input)), BUTTON);
    expect(tiers()).toEqual(TARGET);
    await save(input);
    expect(tiers()).toEqual(TARGET);
    expect(rowsOf('service_quotas')[0]).toMatchObject({ name: 'Điện bậc', description: null });
  });

  it('dấu bản trước không chặn; lưu xong thì gỡ', async () => {
    const key = legacy('quota-update', 'actor-scope', 'q1');
    await update()(input);
    expect(localStorage.getItem(key)).toBeNull();
    expect(pendingKeys()).toEqual([]);
  });

  it('định mức không còn / không có quyền sửa (P0002): câu của máy chủ, không ghi gì', async () => {
    io.server.writable.service_quotas = () => false;
    expectRefused(await rejection(update()(input)), /Không tìm thấy định mức này hoặc tài khoản chưa có quyền sửa/);
    expect(tiers()).toEqual(OLD);
    expect(rpcCount('replace_service_quota_v1')).toBe(1);
  });

  it('không có quyền gỡ bậc cũ (42501 của hàm): câu của máy chủ, tên định mức cũng không đổi', async () => {
    io.server.writable.service_quota_tiers = () => false;
    expectRefused(await rejection(update()(input)), /chưa có quyền gỡ bậc[\s\S]*Chưa lưu thay đổi nào/);
    expect(tiers()).toEqual(OLD);
    expect(rowsOf('service_quotas')[0].name).toBe('Điện');
  });

  it('trùng số bậc trong bộ gửi (23505): từ chối rõ, bậc cũ còn nguyên, không gửi lại tự động', async () => {
    expectRefused(await rejection(update()({ ...input, tiers: [tiersIn[0], { ...tiersIn[1], tier_number: 1 }] })));
    expect(tiers()).toEqual(OLD);
    expect(rpcCount('replace_service_quota_v1')).toBe(1);
  });

  it.each([
    ...listTampers.map(([label, change]) => [label, tierTamper(change)] as [string, (data: unknown) => unknown]),
    ['sai đơn giá', tierTamper(changeFirst('unit_price', 121))],
    ['sai số bậc', tierTamper(changeFirst('tier_number', 3))],
    ['sai cận trên', tierTamper(changeFirst('to_value', null))],
    ['sai mã định mức của bậc', tierTamper(changeFirst('quota_id', 'q9'))],
    ['đầu định mức sai tên', (data: unknown) => ({ ...(data as Row), quota: { ...((data as Row).quota as Row), name: 'Điện' } })],
    ['đầu định mức sai mã', (data: unknown) => ({ ...(data as Row), quota: { ...((data as Row).quota as Row), id: 'q9' } })],
    ['thiếu đầu định mức', (data: unknown) => ({ ...(data as Row), quota: null })],
  ])('hàng rào: biên nhận lệch (%s) không được tính là đã lưu; bấm lại cho đúng một bộ', async (_label, tamper) => {
    const save = update();
    tamperNext.set('replace_service_quota_v1', tamper);
    expectUnknown(await rejection(save(input)), BUTTON);
    await save(input);
    expect(tiers()).toEqual(TARGET);
  });
});

// ── 3 & 4. Vật tư: tồn kho tính lại từ mọi dòng ──────────────────────────────────────────────────────────────────────
const sum = (list: Row[], value: (row: Row) => number) => list.reduce((total, row) => total + value(row), 0);
/** Đúng công thức recompute_material_stock: nhập − xuất, tính lại từ mọi dòng đang có. */
const onHand = (materialId: string) =>
  sum(rowsOf('material_purchase_items').filter(row => row.material_id === materialId), row => Number(row.quantity))
  - sum(rowsOf('material_usage_items').filter(row => row.material_id === materialId), row => Number(row.quantity));
const purchaseLines = (purchaseId: string) => rowsOf('material_purchase_items').filter(row => row.purchase_id === purchaseId);
const usageLines = (usageId: string) => rowsOf('material_usage_items').filter(row => row.usage_id === usageId);
/** Đúng công thức material_purchase_recompute_total. */
function purchaseTotal(purchaseId: string) { return sum(purchaseLines(purchaseId), row => Number(row.quantity) * Number(row.unit_price)); }
const stock = () => {
  io.server.rows.material_purchase_items = [
    { id: 'stock-1', purchase_id: 'p-0', material_id: 'm-1', quantity: 10, unit_price: 100, organization_id: 'org-a' },
    { id: 'stock-2', purchase_id: 'p-0', material_id: 'm-2', quantity: 10, unit_price: 50, organization_id: 'org-a' },
  ];
};

describe('sửa phiếu nhập vật tư (replace_material_purchase_v1)', () => {
  type Line = { material_id: string; quantity: number; unit_price: number };
  type Input = { id: string; input: { purchase_date: string; supplier_id: string | null; notes: string | null; items: Line[] } };
  const update = () => (renderHook(() => useUpdateMaterialPurchase()).result.current as unknown as Mutation<Input>).mutationFn;
  const items: Line[] = [{ material_id: 'm-1', quantity: 4, unit_price: 120 }, { material_id: 'm-2', quantity: 2, unit_price: 50 }];
  const edit: Input = { id: 'p-1', input: { purchase_date: '2026-09-30', supplier_id: 'sup-1', notes: 'sửa', items } };
  const BUTTON = /Bấm lại «Cập nhật»/;
  const itemTamper = (change: (rows: Row[]) => unknown) => (data: unknown) => ({ ...(data as Row), items: change((data as Row).items as Row[]) });
  const headerTamper = (field: string, value: unknown) => (data: unknown) => ({ ...(data as Row), purchase: { ...((data as Row).purchase as Row), [field]: value } });
  const expectTarget = () => {
    expect(purchaseLines('p-1').map(row => `${row.material_id}:${row.quantity}:${row.unit_price}`).sort()).toEqual(['m-1:4:120', 'm-2:2:50']);
    expect(rowsOf('material_purchases')[0]).toMatchObject({ purchase_date: '2026-09-30', supplier_id: 'sup-1', notes: 'sửa', total: 580 });
    expect(onHand('m-1')).toBe(14);
    expect(onHand('m-2')).toBe(12);
  };
  const expectOld = () => {
    expect(purchaseLines('p-1').map(row => row.id)).toEqual(['pl-old']);
    expect(rowsOf('material_purchases')[0]).toMatchObject({ purchase_date: '2026-09-01', notes: null, total: 1000 });
    expect(onHand('m-1')).toBe(20);
  };
  beforeEach(() => {
    stock();
    io.server.rows.material_purchases = [{ id: 'p-1', organization_id: 'org-a', code: 'PN-1', purchase_date: '2026-09-01', supplier_id: null, notes: null, total: 1000 }];
    io.server.rows.material_purchase_items.push({ id: 'pl-old', purchase_id: 'p-1', material_id: 'm-1', quantity: 10, unit_price: 100, organization_id: 'org-a' });
  });

  it('gửi MỘT lệnh: đầu phiếu + cả bộ dòng (chỉ ba trường của dòng), không organization_id, không ghi thẳng bảng', async () => {
    await expect(update()(edit)).resolves.toBeUndefined();
    expect(io.server.rpcCalls).toEqual([{ name: 'replace_material_purchase_v1', args: { p_purchase_id: 'p-1', p_purchase_date: '2026-09-30', p_supplier_id: 'sup-1', p_notes: 'sửa', p_items: items } }]);
    expect(JSON.stringify(io.server.rpcCalls)).not.toContain('organization_id');
    expect(io.tables).toEqual([]);
    expectTarget();
  });

  it('lệnh không tới máy chủ: báo chưa rõ, không dấu; phiếu và tồn kho còn nguyên như cũ; bấm lại ghi đúng bộ', async () => {
    const save = update();
    io.server.failNext('replace_material_purchase_v1', 'rpc', 'drop-before');
    expectUnknown(await rejection(save(edit)), BUTTON);
    expectOld();
    await save(edit);
    expectTarget();
  });

  it('tới nhưng mất phản hồi: bấm lại không nhân đôi dòng, tồn và tổng phiếu không cộng hai lần', async () => {
    const save = update();
    io.server.failNext('replace_material_purchase_v1', 'rpc', 'drop-after');
    expectUnknown(await rejection(save(edit)), BUTTON);
    expectTarget();
    await save(edit);
    expectTarget();
    expect(purchaseLines('p-1')).toHaveLength(2);
  });

  it('dấu bản trước của đúng phiếu không chặn và được gỡ; dấu của đường TẠO để nguyên', async () => {
    legacy('material-purchase', 'org-a', ['update', 'p-1'].join(':'));
    const createMarker = legacy('material-purchase', 'org-a', 'create');
    await update()(edit);
    expect(pendingKeys()).toEqual([createMarker]);
  });

  it('bộ dòng rỗng: một lệnh với mảng rỗng, phiếu không còn dòng nào, tổng 0', async () => {
    await update()({ ...edit, input: { ...edit.input, items: [] } });
    expect(io.server.rpcCalls).toHaveLength(1);
    expect(purchaseLines('p-1')).toEqual([]);
    expect(rowsOf('material_purchases')[0].total).toBe(0);
  });

  it('phiếu không còn / không có quyền sửa (P0002): câu của máy chủ, không đụng dòng nào', async () => {
    io.server.writable.material_purchases = () => false;
    expectRefused(await rejection(update()(edit)), /Không tìm thấy phiếu nhập này hoặc tài khoản chưa có quyền sửa/);
    expectOld();
  });

  it('một dòng vi phạm ràng buộc (23514): lùi cả, dòng cũ và tồn còn nguyên; câu rõ; sửa rồi lưu lại được', async () => {
    const save = update();
    expectRefused(await rejection(save({ ...edit, input: { ...edit.input, items: [items[0], { ...items[1], quantity: 0 }] } })), /chưa hợp lệ/);
    expectOld();
    expect(rpcCount('replace_material_purchase_v1')).toBe(1);
    await save(edit);
    expectTarget();
  });

  it('không có quyền xoá dòng cũ (42501 của hàm): câu của máy chủ, chưa lưu gì', async () => {
    io.server.writable.material_purchase_items = row => row.id !== 'pl-old';
    expectRefused(await rejection(update()(edit)), /chưa có quyền xoá dòng[\s\S]*Chưa lưu thay đổi nào/);
    expectOld();
  });

  it.each([
    ...listTampers.map(([label, change]) => [label, itemTamper(change)] as [string, (data: unknown) => unknown]),
    ['sai số lượng', itemTamper(changeFirst('quantity', 5))],
    ['sai đơn giá', itemTamper(changeFirst('unit_price', 121))],
    ['sai vật tư', itemTamper(changeFirst('material_id', 'm-9'))],
    ['dòng sai mã phiếu', itemTamper(changeFirst('purchase_id', 'p-9'))],
    ['đầu phiếu sai mã', headerTamper('id', 'p-9')],
    ['đầu phiếu sai ngày', headerTamper('purchase_date', '2026-09-01')],
    ['đầu phiếu sai nhà cung cấp', headerTamper('supplier_id', null)],
    ['đầu phiếu sai ghi chú', headerTamper('notes', 'khác')],
    ['thiếu đầu phiếu', (data: unknown) => ({ ...(data as Row), purchase: null })],
  ])('hàng rào: biên nhận lệch (%s) không được tính là đã lưu; bấm lại cho đúng một bộ', async (_label, tamper) => {
    const save = update();
    tamperNext.set('replace_material_purchase_v1', tamper);
    expectUnknown(await rejection(save(edit)), BUTTON);
    await save(edit);
    expectTarget();
  });
});

describe('vật tư của công việc (save_job_material_usage_v1)', () => {
  type Line = { material_id: string; quantity: number; unit_cost_at_usage: number };
  type Input = { job_id: string; usage_date: string; notes: string | null; items: Line[] };
  const saveJob = () => (renderHook(() => useUpsertJobMaterialUsage({ silent: true })).result.current as unknown as Mutation<Input>).mutationFn;
  const items: Line[] = [{ material_id: 'm-1', quantity: 3, unit_cost_at_usage: 100 }, { material_id: 'm-2', quantity: 1, unit_cost_at_usage: 50 }];
  const input: Input = { job_id: 'job-1', usage_date: '2026-09-30', notes: null, items };
  const BUTTON = /Bấm lại «Lưu vật tư»/;
  const itemTamper = (change: (rows: Row[]) => unknown) => (data: unknown) => ({ ...(data as Row), items: change((data as Row).items as Row[]) });
  const replyTamper = (change: Row) => (data: unknown) => ({ ...(data as Row), ...change });
  beforeEach(() => {
    stock();
    io.server.rows.material_usages = [{ id: 'usage-1', job_id: 'job-1', code: 'PX-1', usage_date: '2026-09-01', notes: null, organization_id: 'org-a' }];
    io.server.rows.material_usage_items = [{ id: 'line-old', usage_id: 'usage-1', material_id: 'm-1', quantity: 5, unit_cost_at_usage: 100, organization_id: 'org-a' }];
  });

  it('gửi MỘT lệnh với cả bộ dòng, không organization_id, không ghi thẳng bảng; trả mã phiếu', async () => {
    await expect(saveJob()(input)).resolves.toBe('usage-1');
    expect(io.server.rpcCalls).toEqual([{ name: 'save_job_material_usage_v1', args: { p_job_id: 'job-1', p_usage_date: '2026-09-30', p_notes: null, p_items: items } }]);
    expect(JSON.stringify(io.server.rpcCalls)).not.toContain('organization_id');
    expect(io.tables).toEqual([]);
    expect(usageLines('usage-1').map(row => `${row.material_id}:${row.quantity}:${row.unit_cost_at_usage}`).sort()).toEqual(['m-1:3:100', 'm-2:1:50']);
    expect(onHand('m-1')).toBe(7);
  });

  it('lệnh không tới máy chủ: báo chưa rõ, không dấu; vật tư cũ và tồn còn nguyên; bấm lại ghi đúng bộ', async () => {
    const run = saveJob();
    io.server.failNext('save_job_material_usage_v1', 'rpc', 'drop-before');
    expectUnknown(await rejection(run(input)), BUTTON);
    expect(usageLines('usage-1').map(row => row.id)).toEqual(['line-old']);
    expect(onHand('m-1')).toBe(5);
    await expect(run(input)).resolves.toBe('usage-1');
    expect(onHand('m-1')).toBe(7);
  });

  it('tới nhưng mất phản hồi: bấm lại đúng một bộ dòng, tồn trừ một lần, một phiếu', async () => {
    const run = saveJob();
    io.server.failNext('save_job_material_usage_v1', 'rpc', 'drop-after');
    expectUnknown(await rejection(run(input)), BUTTON);
    expect(onHand('m-1')).toBe(7);
    await expect(run(input)).resolves.toBe('usage-1');
    expect(usageLines('usage-1')).toHaveLength(2);
    expect(onHand('m-1')).toBe(7);
    expect(onHand('m-2')).toBe(9);
    expect(rowsOf('material_usages')).toHaveLength(1);
  });

  it('công việc chưa có phiếu, tạo mất phản hồi: bấm lại dùng phiếu máy chủ vừa tạo, không ra phiếu thứ hai', async () => {
    io.server.rows.material_usages = [];
    io.server.rows.material_usage_items = [];
    const run = saveJob();
    io.server.failNext('save_job_material_usage_v1', 'rpc', 'drop-after');
    expectUnknown(await rejection(run(input)), BUTTON);
    const saved = await run(input);
    expect(rowsOf('material_usages')).toHaveLength(1);
    expect(saved).toBe(rowsOf('material_usages')[0].id);
    expect(usageLines(String(saved))).toHaveLength(2);
    expect(onHand('m-1')).toBe(7);
  });

  it('dấu bản trước gieo sẵn không chặn; lưu xong thì gỡ đúng dấu của công việc đó', async () => {
    legacy('material-job-usage', 'org-a', 'job-1');
    const other = legacy('material-job-usage', 'org-a', 'job-2');
    await saveJob()(input);
    expect(pendingKeys()).toEqual([other]);
  });

  it('xoá hết vật tư: máy chủ gỡ phiếu (removed) ⇒ lưu xong, tồn cộng trả', async () => {
    await expect(saveJob()({ ...input, items: [] })).resolves.toBe('usage-1');
    expect(io.server.rpcCalls).toEqual([{ name: 'save_job_material_usage_v1', args: { p_job_id: 'job-1', p_usage_date: '2026-09-30', p_notes: null, p_items: [] } }]);
    expect(rowsOf('material_usages')).toEqual([]);
    expect(onHand('m-1')).toBe(10);
  });

  it('chưa có phiếu và bộ rỗng: «không có vật tư cần lưu», không tạo phiếu', async () => {
    io.server.rows.material_usages = [];
    io.server.rows.material_usage_items = [];
    await expect(saveJob()({ ...input, items: [] })).resolves.toBeNull();
    expect(rowsOf('material_usages')).toEqual([]);
  });

  it('xoá hết vật tư mà không có quyền xoá phiếu (removed:false): báo như hôm nay, không coi là đã gỡ', async () => {
    undeletableUsages.add('usage-1');
    const error = await rejection(saveJob()({ ...input, items: [] }));
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(error).toMatchObject({ outcome: 'failure' });
    expect((error as Error).message).toMatch(/Đã xoá hết vật tư của công việc/);
    expect((error as Error).message).toMatch(/quyền xoá phiếu/);
    expect(rowsOf('material_usages')).toHaveLength(1);
    expect(usageLines('usage-1')).toEqual([]);
    expect(pendingKeys()).toEqual([]);
  });

  it('phiếu không sửa được (P0002): câu của máy chủ, vật tư cũ còn nguyên', async () => {
    io.server.writable.material_usages = () => false;
    expectRefused(await rejection(saveJob()(input)), /Không sửa được phiếu xuất của công việc này/);
    expect(usageLines('usage-1').map(row => row.id)).toEqual(['line-old']);
  });

  it('một dòng vi phạm ràng buộc (23514): lùi cả, vật tư cũ và tồn còn nguyên; sửa rồi lưu lại được', async () => {
    const run = saveJob();
    expectRefused(await rejection(run({ ...input, items: [{ ...items[0], quantity: -1 }] })), /chưa hợp lệ/);
    expect(usageLines('usage-1').map(row => row.id)).toEqual(['line-old']);
    expect(onHand('m-1')).toBe(5);
    expect(rpcCount('save_job_material_usage_v1')).toBe(1);
    await expect(run(input)).resolves.toBe('usage-1');
    expect(onHand('m-1')).toBe(7);
  });

  it('không có quyền xoá dòng cũ (42501 của hàm): câu của máy chủ, chưa lưu gì', async () => {
    io.server.writable.material_usage_items = () => false;
    expectRefused(await rejection(saveJob()(input)), /chưa có quyền xoá dòng[\s\S]*Chưa lưu thay đổi nào/);
    expect(usageLines('usage-1').map(row => row.id)).toEqual(['line-old']);
  });

  it.each([
    ...listTampers.map(([label, change]) => [label, itemTamper(change)] as [string, (data: unknown) => unknown]),
    ['sai số lượng', itemTamper(changeFirst('quantity', 4))],
    ['sai giá vốn', itemTamper(changeFirst('unit_cost_at_usage', 99))],
    ['sai vật tư', itemTamper(changeFirst('material_id', 'm-9'))],
    ['dòng sai mã phiếu', itemTamper(changeFirst('usage_id', 'usage-9'))],
    ['mã phiếu khác đầu phiếu', replyTamper({ usage_id: 'usage-9' })],
    ['đầu phiếu của công việc khác', (data: unknown) => ({ ...(data as Row), usage: { ...((data as Row).usage as Row), job_id: 'job-9' } })],
    ['đầu phiếu sai ngày', (data: unknown) => ({ ...(data as Row), usage: { ...((data as Row).usage as Row), usage_date: '2026-09-01' } })],
    ['báo đã gỡ phiếu khi còn dòng', replyTamper({ removed: true, usage: null })],
    ['thiếu đầu phiếu', replyTamper({ usage: null })],
  ])('hàng rào: biên nhận lệch (%s) không được tính là đã lưu; bấm lại cho đúng một bộ', async (_label, tamper) => {
    const run = saveJob();
    tamperNext.set('save_job_material_usage_v1', tamper);
    expectUnknown(await rejection(run(input)), BUTTON);
    await expect(run(input)).resolves.toBe('usage-1');
    expect(usageLines('usage-1')).toHaveLength(2);
    expect(onHand('m-1')).toBe(7);
  });

  it.each([
    ['không gỡ được mà cũng không còn đầu phiếu', replyTamper({ removed: false })],
    ['báo đã gỡ nhưng vẫn trả đầu phiếu', replyTamper({ usage: { id: 'usage-1', job_id: 'job-1', code: 'PX-1', usage_date: '2026-09-30', notes: null, organization_id: 'org-a' } })],
    ['báo đã gỡ mà không có mã phiếu', replyTamper({ usage_id: null })],
    ['còn dòng vật tư', replyTamper({ items: [{ id: 'line-x', usage_id: 'usage-1', material_id: 'm-1', quantity: 1, unit_cost_at_usage: 1 }] })],
    ['cờ gỡ sai dạng', replyTamper({ removed: 'yes' })],
  ])('hàng rào bộ rỗng: biên nhận gỡ phiếu lệch (%s) không được tính là đã lưu', async (_label, tamper) => {
    tamperNext.set('save_job_material_usage_v1', tamper);
    expectUnknown(await rejection(saveJob()({ ...input, items: [] })), BUTTON);
  });
});

// ── 5. Dịch vụ của hợp đồng (bước dịch vụ của luồng sửa hợp đồng) ───────────────────────────────────────────────────
describe('dịch vụ của hợp đồng khi sửa (replace_contract_services_v1)', () => {
  type Service = { service_id: string; unit_price: number; initial_reading?: number | null };
  type Input = { contractId: string; services: Service[]; organizationId?: string; skipDelete?: boolean; onPhase?: (phase: string) => void };
  const sync = () => (renderHook(() => useSyncContractServices()).result.current as unknown as Mutation<Input>).mutationFn;
  const target: Service[] = [{ service_id: 's1', unit_price: 50 }, { service_id: 's2', unit_price: 3500, initial_reading: 120 }];
  const sent = [{ service_id: 's1', unit_price: 50, initial_reading: null }, { service_id: 's2', unit_price: 3500, initial_reading: 120 }];
  const services = (contract = 'c1') => rowsOf('contract_services').filter(row => row.contract_id === contract).map(row => `${row.service_id}:${row.unit_price}:${row.initial_reading}`).sort();
  const TARGET = ['s1:50:null', 's2:3500:120'];
  const OLD = ['s0:10:null'];
  beforeEach(() => {
    io.server.rows.contract_services = [
      { id: 'cs-old', contract_id: 'c1', service_id: 's0', unit_price: 10, initial_reading: null, organization_id: 'org-c' },
      { id: 'cs-other', contract_id: 'c2', service_id: 's0', unit_price: 10, initial_reading: null, organization_id: 'org-c' },
    ];
  });

  it('gửi MỘT lệnh với bộ đích (chỉ số đầu vắng ⇒ null), không organization_id; pha «reconciling» rồi «done»', async () => {
    const onPhase = vi.fn();
    await expect(sync()({ contractId: 'c1', organizationId: 'org-c', services: target, onPhase })).resolves.toBeUndefined();
    expect(io.server.rpcCalls).toEqual([{ name: 'replace_contract_services_v1', args: { p_contract_id: 'c1', p_services: sent } }]);
    expect(JSON.stringify(io.server.rpcCalls)).not.toContain('organization_id');
    expect(io.tables).toEqual([]);
    expect(onPhase.mock.calls.flat()).toEqual(['reconciling', 'done']);
    expect(services()).toEqual(TARGET);
    expect(services('c2')).toEqual(OLD);
  });

  it('`skipDelete` không còn nghĩa: vẫn thay nguyên tử cả bộ, không để sót dịch vụ cũ', async () => {
    const onPhase = vi.fn();
    await sync()({ contractId: 'c1', services: target, skipDelete: true, onPhase });
    expect(services()).toEqual(TARGET);
    expect(onPhase.mock.calls.flat()).toEqual(['reconciling', 'done']);
  });

  it('mất phản hồi / từ chối rõ: chỉ có pha «reconciling», không «done»; từ chối rõ giữ nguyên lỗi máy chủ', async () => {
    const onPhase = vi.fn();
    io.server.failNext('replace_contract_services_v1', 'rpc', 'drop-after');
    const lost = await rejection(sync()({ contractId: 'c1', services: target, onPhase }));
    expect(isConfirmedFinancialRejection(lost)).toBe(false);
    expect(onPhase.mock.calls.flat()).toEqual(['reconciling']);
    onPhase.mockClear();
    io.server.writable.contract_services = () => false;
    const refused = await rejection(sync()({ contractId: 'c1', services: [{ service_id: 's3', unit_price: 1 }], onPhase }));
    expect(isConfirmedFinancialRejection(refused)).toBe(true);
    expect(onPhase.mock.calls.flat()).toEqual(['reconciling']);
    expect(services()).toEqual(TARGET);
  });

  it.each([
    ...listTampers,
    ['sai đơn giá', changeFirst('unit_price', 51)],
    ['đơn giá rỗng', changeFirst('unit_price', null)],
    ['sai chỉ số đầu', changeFirst('initial_reading', 0)],
    ['sai dịch vụ', changeFirst('service_id', 's9')],
    ['sai mã hợp đồng', changeFirst('contract_id', 'c2')],
  ])('hàng rào: biên nhận lệch (%s) không đánh «done»', async (_label, tamper) => {
    const onPhase = vi.fn();
    tamperNext.set('replace_contract_services_v1', data => tamper(data as Row[]));
    await expect(sync()({ contractId: 'c1', services: target, onPhase })).rejects.toBeDefined();
    expect(onPhase.mock.calls.flat()).toEqual(['reconciling']);
  });

  describe('trong luồng sửa hợp đồng (runContractEdit)', () => {
    const NOW = new Date('2026-11-26T08:00:00.000Z');
    const customers = [{ customer_id: 'k1', is_representative: true, notes: null }];
    const request: ContractEditRequest = { contractId: 'c1', expectedCustomers: customers, updates: { rent_price: 200 }, fieldsFingerprint: 'form', customers, services: sent };
    const deps = () => ({ now: () => NOW, valve: { report: vi.fn() } });
    const ports = (): ContractEditPorts => ({
      read: async () => ({
        contract: { id: 'c1', organization_id: 'org-c', rent_price: 200 },
        customers: structuredClone(customers),
        services: rowsOf('contract_services').filter(row => row.contract_id === 'c1').map(row => ({ service_id: String(row.service_id), unit_price: Number(row.unit_price), initial_reading: row.initial_reading === null ? null : Number(row.initial_reading) })),
      }),
      update: vi.fn(), customers: vi.fn(),
      services: input => sync()(input as Input),
    });

    it('lệnh dịch vụ không tới máy chủ: lần bấm sau gửi lại NGAY (không chờ 2 phút), xong và gỡ dấu', async () => {
      io.server.failNext('replace_contract_services_v1', 'rpc', 'drop-before');
      await expect(runContractEdit(request, ports(), deps())).rejects.toThrow();
      expect(await loadContractEditJob('c1')).toMatchObject({ servicesPhase: 'reconciling' });
      expect(services()).toEqual(OLD);
      await expect(runContractEdit(request, ports(), deps())).resolves.toMatchObject({ contractId: 'c1' });
      expect(rpcCount('replace_contract_services_v1')).toBe(2);
      expect(services()).toEqual(TARGET);
      expect(await loadContractEditJob('c1')).toBeNull();
    });

    it('lệnh dịch vụ tới nhưng mất phản hồi: lần bấm sau đọc lại thấy đã đúng, không gửi lần hai', async () => {
      io.server.failNext('replace_contract_services_v1', 'rpc', 'drop-after');
      await expect(runContractEdit(request, ports(), deps())).rejects.toThrow();
      expect(await loadContractEditJob('c1')).toMatchObject({ servicesPhase: 'reconciling' });
      await expect(runContractEdit(request, ports(), deps())).resolves.toMatchObject({ contractId: 'c1' });
      expect(rpcCount('replace_contract_services_v1')).toBe(1);
      expect(services()).toEqual(TARGET);
    });

    it('máy chủ từ chối rõ: pha «rejected», dịch vụ cũ còn nguyên; hết lý do từ chối thì lần sau gửi lại ngay', async () => {
      io.server.writable.contract_services = row => row.id !== 'cs-old';
      await expect(runContractEdit(request, ports(), deps())).rejects.toThrow();
      expect(await loadContractEditJob('c1')).toMatchObject({ servicesPhase: 'rejected' });
      expect(services()).toEqual(OLD);
      io.server.writable.contract_services = () => true;
      await expect(runContractEdit(request, ports(), deps())).resolves.toMatchObject({ contractId: 'c1' });
      expect(rpcCount('replace_contract_services_v1')).toBe(2);
      expect(services()).toEqual(TARGET);
    });
  });
});
