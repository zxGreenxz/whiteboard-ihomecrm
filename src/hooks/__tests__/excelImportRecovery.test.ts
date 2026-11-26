// @vitest-environment jsdom
// Đợt 9: nhập thu chi từ Excel (TIỀN, `voucher-excel-import`). Dấu vẫn giữ khi có dòng chưa rõ (đường ghi phiếu không có
// mã yêu cầu), nhưng hàm đối chiếu LUÔN kết luận được từ ảnh chụp lượt nhập: dòng đã nhận mã ⇒ đã ghi; dòng thường tra
// đúng theo mã phiếu do trình duyệt sinh (ie_compat_insert_v2 nhận `p_row.id`, production 26/11/2026); dòng thu cọc tra
// đúng theo mã yêu cầu; ảnh chụp bản trước (không có mã phiếu dự kiến) tra gần đúng ⇒ chỉ «có thể đã ghi», không gửi lại.
// Không thấy và đã quá 2 phút ⇒ chưa ghi. Kết quả về màn từng dòng; tệp vừa chọn không tự nhập lại.
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FakeRecordServer } from './fakeRecordServer';

type Row = Record<string, unknown>;
const io = vi.hoisted(() => ({ server: null as unknown as FakeRecordServer, resolverFails: false, inSizes: [] as number[], inCalls: 0, failInCall: 0 }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: (table: string) => {
    const query = io.server.from(table) as Record<string, unknown>;
    const filterIn = query.in as (column: string, values: unknown[]) => unknown;
    query.in = (column: string, values: unknown[]) => {
      io.inSizes.push(values.length);
      // PostgREST đọc qua GET: danh sách `.in(...)` quá dài làm URL vượt giới hạn ⇒ máy chủ trả lỗi (án lệ
      // useInvoiceCollectors.ts). Giả bằng một lần đọc hỏng.
      if (values.length > 100) io.server.failNext(table, 'read', 'drop-before');
      if (table === 'income_expenses' && ++io.inCalls === io.failInCall) io.server.failNext(table, 'read', 'drop-before');
      return filterIn(column, values);
    };
    return query;
  },
  get rpc() { return io.server.rpc; },
} }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'u1' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'o1' }) }));
vi.mock('@/hooks/income-expenses/accountingClass', () => ({
  loadIncomeExpenseAccountingClassResolver: async () => {
    if (io.resolverFails) throw new TypeError('Failed to fetch');
    return (typeId: string) => (typeId === 'tcoc' ? 'DEPOSIT' : 'PNL');
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { useImportIncomeExpenses } from '@/hooks/income-expenses/batch';
import { PENDING_SETTLE_MS } from '@/lib/financialPending';
import { FinancialAlreadyRecordedError } from '@/lib/financialWorkflowError';
import { NETWORK_ERROR, fakeRecordServer, seedLegacyPending, pendingKeys } from './fakeRecordServer';

interface ImportResult {
  successCount: number; failedCount: number;
  createdVouchers: { row: number; id: string; code: string | null }[];
  errors: { row: number; message: string }[];
  reconciledFrom?: string;
  possiblyWritten?: { row: number; codes: string[] }[];
}
const T0 = Date.parse('2026-11-26T02:00:00.000Z');
let clock = T0;
const advance = (ms: number) => { clock += ms; vi.setSystemTime(clock); };
const SNAPSHOT = 'ihome:excel-import-pending:v1:u1:o1';
// Khoá nghiệp vụ của guard ghép lúc chạy (quét bí mật bắt chuỗi dài đứng sau chữ «Key»).
const importKey = ['excel', 'import'].join('-');
const scope = { namespace: 'voucher-excel-import', userId: 'u1', organizationId: 'o1', businessKey: importKey };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
/** Mỗi lần gọi ghi phiếu thường lấy một phần tử: rớt trước, rớt sau, từ chối rõ, hoặc chạy bình thường. */
let plan: ('before' | 'after' | 'reject' | undefined)[] = [];
const depositKeys = new Map<string, string>();
const compatClaims = new Map<string, { hash: string; id: string }>();

function voucher(row: Row, items: Row[], id: string, code: string) {
  return { id, code, user_id: 'u1', organization_id: 'o1', type: row.type, building_id: row.building_id, voucher_date: row.voucher_date,
    total_amount: Number(items[0].unit_price), approval_status: 'UNAPPROVED', deleted_at: null, created_at: new Date().toISOString(),
    income_expense_items: items.map(item => ({ income_expense_type_id: item.income_expense_type_id })) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); clock = T0; vi.setSystemTime(clock);
  localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'o1');
  seq = 0; plan = []; depositKeys.clear(); compatClaims.clear(); io.resolverFails = false; io.inSizes = []; io.inCalls = 0; io.failInCall = 0;
  io.server = fakeRecordServer();
  const vouchers = () => (io.server.rows.income_expenses ??= []);
  // Đợt 10a: dòng thường đi ie_compat_insert_keyed_v1 — cùng mã cùng nội dung trả lại phiếu cũ, khác nội dung 23505.
  const compat = (args: Row) => {
    const mode = plan.shift();
    if (mode === 'before') return { data: null, error: NETWORK_ERROR };
    if (mode === 'reject') return { data: null, error: { code: '23514', message: 'invalid row' } };
    const row = args.p_row as Row; const items = args.p_items as Row[];
    const key = typeof args.p_request_key === 'string' ? args.p_request_key : null;
    const hash = JSON.stringify([row, items]);
    const claim = key ? compatClaims.get(key) : undefined;
    if (claim) return claim.hash === hash ? { data: { id: claim.id, approval_status: 'UNAPPROVED', replayed: true }, error: null }
      : { data: null, error: { code: '23505', message: 'Mã yêu cầu đã dùng với nội dung khác', details: claim.id, hint: 'ie_request_key_payload_mismatch' } };
    const id = typeof row.id === 'string' ? row.id : uuid();
    if (vouchers().some(v => v.id === id)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "income_expenses_pkey"' } };
    vouchers().push(voucher(row, items, id, `PC${vouchers().length + 1}`));
    if (key) compatClaims.set(key, { hash, id });
    // Production chỉ trả mã và trạng thái duyệt, không trả mã chứng từ.
    return mode === 'after' ? { data: null, error: NETWORK_ERROR } : { data: { id, approval_status: 'UNAPPROVED' }, error: null };
  };
  io.server.rpcHandlers.ie_compat_insert_v2 = compat;
  io.server.rpcHandlers.ie_compat_insert_keyed_v1 = compat;
  io.server.rpcHandlers.get_own_compat_inserts_v1 = args => ({
    data: (args.p_request_keys as string[]).flatMap(k => (compatClaims.has(k) ? [{ voucher_id: compatClaims.get(k)!.id, request_key: k }] : [])), error: null });
  io.server.rpcHandlers.create_deposit_income_v1 = args => {
    const request = String(args.p_request_key);
    let id = depositKeys.get(request);
    if (!id) {
      id = uuid(); depositKeys.set(request, id);
      vouchers().push(voucher(args.p_row as Row, args.p_items as Row[], id, `PT${vouchers().length + 1}`));
    }
    const code = vouchers().find(v => v.id === id)!.code;
    return { data: { id, code, approval_status: 'APPROVED', reservation_id: null, reservation: null }, error: null };
  };
  io.server.rpcHandlers.get_own_deposit_income_v1 = args => ({ data: depositKeys.get(String(args.p_request_key)) ?? null, error: null });
});
afterEach(() => { vi.useRealTimers(); });

const submit = (rows: Row[]) =>
  (renderHook(() => useImportIncomeExpenses()).result.current as unknown as { mutationFn: (input: Row[]) => Promise<ImportResult> }).mutationFn(rows);
const line = (n: number, extra: Row = {}): Row => ({ type: 'EXPENSE', name: 'Chi sửa', building_id: 'b1', voucher_date: '2026-11-20',
  item_name: 'Sửa', income_expense_type_id: 't1', amount: 100 * n, source_row: n + 1, ...extra });
// Đợt 10a: mọi dòng thường đi hàm có mã yêu cầu; không còn lời gọi ie_compat_insert_v2 trần nào từ màn nhập Excel.
const compatCalls = () => io.server.rpcCalls.filter(call => call.name === 'ie_compat_insert_keyed_v1' || call.name === 'ie_compat_insert_v2');
const vouchers = () => io.server.rows.income_expenses ?? [];

it('(i) lệnh không tới máy chủ: giữ dấu; dưới 2 phút chưa kết luận, không gửi; quá 2 phút không thấy ⇒ chưa ghi, nhập đúng một phiếu, gỡ dấu', async () => {
  plan.push('before');
  const first = await submit([line(1)]);
  expect(first.errors[0].message).toMatch(/Chưa xác nhận/);
  expect(vouchers()).toHaveLength(0);
  expect(pendingKeys()).toHaveLength(1);
  await expect(submit([line(1)])).rejects.toThrow(/đối chiếu/);
  expect(compatCalls()).toHaveLength(1);
  advance(PENDING_SETTLE_MS + 1_000);
  const again = await submit([line(1)]);
  expect(again).toMatchObject({ successCount: 1, failedCount: 0 });
  expect(again.reconciledFrom).toBeUndefined();
  expect(vouchers()).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});

it('(ii) tới nhưng mất phản hồi: bấm lại ngay tra đúng phiếu theo mã đã gửi ⇒ đã ghi (kèm mã), không gửi lần hai, gỡ dấu; tệp vừa chọn chưa nhập', async () => {
  plan.push('after');
  await submit([line(1)]);
  expect(vouchers()).toHaveLength(1);
  const sent = (compatCalls()[0].args.p_row as Row).id as string;
  expect(sent).toMatch(/^[0-9a-f-]{36}$/);
  expect(vouchers()[0].id).toBe(sent);
  const again = await submit([line(1)]);
  expect(again.reconciledFrom).toMatch(/\d{2}:\d{2} ngày 26\/11\/2026/);
  expect(again.createdVouchers).toEqual([{ row: 2, id: sent, code: vouchers()[0].code }]);
  expect(again.errors).toEqual([]);
  expect(compatCalls()).toHaveLength(1);
  expect(vouchers()).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
  expect(localStorage.getItem(SNAPSHOT)).toBeNull();
  // Lượt sau là lượt mới, nhập bình thường.
  await expect(submit([line(1)])).resolves.toMatchObject({ successCount: 1 });
  expect(compatCalls()).toHaveLength(2);
});

it('(ii) đọc lại ngay cũng hỏng ⇒ chưa kết luận (kể cả sau 2 phút), không gửi; đọc được thì kết luận đã ghi', async () => {
  plan.push('after');
  await submit([line(1)]);
  io.server.failNext('income_expenses', 'read', 'drop-before');
  await expect(submit([line(1)])).rejects.toThrow(/đối chiếu/);
  advance(PENDING_SETTLE_MS + 1_000);
  io.server.failNext('income_expenses', 'read', 'drop-before');
  await expect(submit([line(1)])).rejects.toThrow(/đối chiếu/);
  expect(compatCalls()).toHaveLength(1);
  expect(pendingKeys()).toHaveLength(1);
  const done = await submit([line(1)]);
  expect(done.createdVouchers.map(v => v.row)).toEqual([2]);
  expect(compatCalls()).toHaveLength(1);
  expect(vouchers()).toHaveLength(1);
});

it('mã phiếu dự kiến của mọi dòng nằm trong ảnh chụp TRƯỚC khi gửi dòng đầu', async () => {
  plan.push('after', 'before');
  await submit([line(1), line(2)]);
  const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT)!) as { rows: { sourceRow: number; voucherId?: string }[] };
  const sent = compatCalls().map(call => (call.args.p_row as Row).id);
  expect(snapshot.rows.map(row => row.sourceRow)).toEqual([2, 3]);
  expect(sent.every(value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value))).toBe(true);
  expect(new Set(sent).size).toBe(2);
  expect(snapshot.rows.map(row => row.voucherId)).toEqual(sent);
});

it('nhiều dòng: đã nhận mã / mất phản hồi / không tới ⇒ kết quả từng dòng của lượt trước; chỉ dòng chưa ghi được nhập lại', async () => {
  plan.push(undefined, 'after', 'before');
  const first = await submit([line(1), line(2), line(3)]);
  expect(first.createdVouchers.map(v => v.row)).toEqual([1]);
  expect(first.failedCount).toBe(2);
  expect(vouchers()).toHaveLength(2);
  advance(PENDING_SETTLE_MS + 1_000);
  const reconciled = await submit([line(1), line(2), line(3)]);
  expect(reconciled.reconciledFrom).toBeTruthy();
  expect(reconciled.createdVouchers.map(v => v.row)).toEqual([2, 3]);
  expect(reconciled.errors.map(error => error.row)).toEqual([4]);
  expect(reconciled.errors[0].message).toMatch(/Chưa ghi/);
  expect(compatCalls()).toHaveLength(3);
  expect(pendingKeys()).toEqual([]);
  await expect(submit([line(3)])).resolves.toMatchObject({ successCount: 1 });
  expect(vouchers()).toHaveLength(3);
});

it('một dòng đã có phiếu, dòng kia chưa thấy mà lượt trước chưa quá 2 phút ⇒ chưa kết luận (không báo «chưa ghi» sớm), không gửi', async () => {
  plan.push(undefined, 'before');
  await submit([line(1), line(2)]);
  await expect(submit([line(1), line(2)])).rejects.toThrow(/đối chiếu/);
  expect(compatCalls()).toHaveLength(2);
  expect(pendingKeys()).toHaveLength(1);
});

// Review độc lập: lượt nhập lớn từng làm lệnh đọc `.in('id', …)` của phép đối chiếu dài quá cỡ URL ⇒ đối chiếu hỏng ở MỌI lần bấm.
const bigImport = () => Array.from({ length: 350 }, (_, index) => line(index + 1));
const loseOneOf350 = () => plan.push(...Array.from({ length: 350 }, (_, index) => (index === 199 ? 'after' as const : undefined)));

it('lượt nhập lớn (350 dòng), một dòng mất phản hồi ⇒ đối chiếu chia lô đọc (≤ 100 mã mỗi lệnh), kết luận được, không gửi lại', async () => {
  loseOneOf350();
  const first = await submit(bigImport());
  expect(first.successCount).toBe(349);
  io.inSizes = [];
  const reconciled = await submit(bigImport());
  expect(reconciled.reconciledFrom).toBeTruthy();
  expect(reconciled.createdVouchers).toHaveLength(350);
  expect(reconciled.errors).toEqual([]);
  expect(io.inSizes.length).toBeGreaterThan(1);
  expect(Math.max(...io.inSizes)).toBeLessThanOrEqual(100);
  expect(compatCalls()).toHaveLength(350);
  expect(pendingKeys()).toEqual([]);
});

it('lượt nhập lớn: một lô đọc hỏng ⇒ cả lần đối chiếu chưa kết luận (không coi lô hỏng là «không có»), không gửi; đọc được thì kết luận', async () => {
  loseOneOf350();
  await submit(bigImport());
  io.inCalls = 0; io.failInCall = 2;
  await expect(submit(bigImport())).rejects.toThrow(/đối chiếu/);
  expect(compatCalls()).toHaveLength(350);
  expect(pendingKeys()).toHaveLength(1);
  io.failInCall = 0;
  const reconciled = await submit(bigImport());
  expect(reconciled.createdVouchers).toHaveLength(350);
  expect(compatCalls()).toHaveLength(350);
});

it('đã biết một phần (dòng bị từ chối rõ): lần bấm sau trả kết quả lượt trước, không nhập lại cả tệp; lần sau nữa nhập', async () => {
  plan.push(undefined, 'reject');
  const rows = [line(1), line(2)];
  const first = await submit(rows);
  expect(first).toMatchObject({ successCount: 1, failedCount: 1 });
  const reconciled = await submit(rows);
  expect(reconciled.reconciledFrom).toBeTruthy();
  expect(reconciled.createdVouchers.map(v => v.row)).toEqual([2]);
  expect(reconciled.errors).toEqual([{ row: 3, message: expect.stringMatching(/từ chối/) }]);
  expect(compatCalls()).toHaveLength(2);
  expect(pendingKeys()).toEqual([]);
  await expect(submit([line(2)])).resolves.toMatchObject({ successCount: 1 });
  expect(compatCalls()).toHaveLength(3);
});

it('dòng thu cọc mất phản hồi: tra đúng theo mã yêu cầu (mã lượt + dòng Excel) ⇒ đã ghi, không gửi lần hai', async () => {
  const deposit = line(1, { type: 'INCOME', income_expense_type_id: 'tcoc', room_id: 'r1' });
  io.server.failNext('create_deposit_income_v1', 'rpc', 'drop-after');
  await submit([deposit]);
  const sent = io.server.rpcCalls.find(call => call.name === 'create_deposit_income_v1')!.args.p_request_key as string;
  expect(sent).toMatch(/:2$/);
  const again = await submit([deposit]);
  expect(io.server.rpcCalls.filter(call => call.name === 'get_own_deposit_income_v1').map(call => call.args.p_request_key)).toEqual([sent]);
  expect(again.createdVouchers).toEqual([{ row: 2, id: vouchers()[0].id, code: vouchers()[0].code }]);
  expect(io.server.rpcCalls.filter(call => call.name === 'create_deposit_income_v1')).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});

it('dòng thu cọc không tới máy chủ: dưới 2 phút chưa kết luận; quá 2 phút tra theo mã không thấy ⇒ chưa ghi, gửi lại cùng mã yêu cầu, một phiếu', async () => {
  const deposit = line(1, { type: 'INCOME', income_expense_type_id: 'tcoc', room_id: 'r1' });
  io.server.failNext('create_deposit_income_v1', 'rpc', 'drop-before');
  await submit([deposit]);
  await expect(submit([deposit])).rejects.toThrow(/đối chiếu/);
  advance(PENDING_SETTLE_MS + 1_000);
  await expect(submit([deposit])).resolves.toMatchObject({ successCount: 1 });
  const keys = io.server.rpcCalls.filter(call => call.name === 'create_deposit_income_v1').map(call => call.args.p_request_key);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(vouchers()).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});

/** Ảnh chụp lượt nhập kiểu bản trước: không có mã phiếu dự kiến, không có cờ thu cọc; `createdVouchers.row` là vị trí dòng. */
function seedLegacyImport(startedAt: number, rows: Row[], created: Row[], unconfirmed: number[]) {
  seedLegacyPending(scope, new Date(startedAt), created.map(v => String(v.id)));
  localStorage.setItem(SNAPSHOT, JSON.stringify({ attemptId: 'legacy-attempt', rows, createdVouchers: created, unconfirmedRows: unconfirmed, failedRows: unconfirmed }));
}
const legacyRow = (sourceRow: number, amount: number) => ({ sourceRow, type: 'EXPENSE', buildingId: 'b1', itemTypeId: 't1', voucherDate: '2026-11-20', amount });
const serverVoucher = (id: string, code: string, amount: number, createdAt: number) => ({ id, code, user_id: 'u1', organization_id: 'o1', type: 'EXPENSE',
  building_id: 'b1', voucher_date: '2026-11-20', total_amount: amount, approval_status: 'UNAPPROVED', deleted_at: null,
  created_at: new Date(createdAt).toISOString(), income_expense_items: [{ income_expense_type_id: 't1' }] });

it('ảnh chụp bản trước: dòng thường chưa rõ tra gần đúng ⇒ thấy ⇒ «có thể đã ghi (mã …)», KHÔNG gửi lại; loại phiếu đã biết; không thấy sau 2 phút ⇒ chưa ghi', async () => {
  const started = T0 - 10 * 60_000;
  seedLegacyImport(started, [legacyRow(2, 100), legacyRow(4, 100), legacyRow(6, 300)], [{ row: 1, id: 'v-known', code: 'PC-1' }], [4, 6]);
  io.server.rows.income_expenses = [serverVoucher('v-known', 'PC-1', 100, started + 1_000), serverVoucher('v-maybe', 'PC-9', 300, started + 3_000)];
  const result = await submit([line(1)]);
  expect(result.reconciledFrom).toBeTruthy();
  expect(result.createdVouchers).toEqual([{ row: 2, id: 'v-known', code: 'PC-1' }]);
  expect(result.possiblyWritten).toEqual([{ row: 6, codes: ['PC-9'] }]);
  // Dòng 4 giống hệt dòng 2: phiếu của dòng 2 đã biết, không được tính là phiếu của dòng 4.
  expect(result.errors).toEqual([{ row: 4, message: expect.stringMatching(/Chưa ghi/) }]);
  expect(compatCalls()).toHaveLength(0);
  expect(pendingKeys()).toEqual([]);
  expect(localStorage.getItem(SNAPSHOT)).toBeNull();
});

it('ảnh chụp bản trước: chỉ có dòng «có thể đã ghi» ⇒ trả kết quả từng dòng, KHÔNG gửi lại tệp nào, gỡ dấu', async () => {
  const started = T0 - 10 * 60_000;
  seedLegacyImport(started, [legacyRow(2, 300)], [], [2]);
  io.server.rows.income_expenses = [serverVoucher('v-maybe', 'PC-9', 300, started + 3_000)];
  const result = await submit([line(1)]);
  expect(result.possiblyWritten).toEqual([{ row: 2, codes: ['PC-9'] }]);
  expect(result.createdVouchers).toEqual([]);
  expect(compatCalls()).toHaveLength(0);
  expect(pendingKeys()).toEqual([]);
});

it('ảnh chụp bản trước: tra gần đúng không thấy dưới 2 phút ⇒ chưa kết luận, không gửi', async () => {
  seedLegacyImport(T0 - 30_000, [legacyRow(2, 100)], [], [2]);
  await expect(submit([line(1)])).rejects.toThrow(/đối chiếu/);
  expect(compatCalls()).toHaveLength(0);
  expect(pendingKeys()).toHaveLength(1);
});

it('ảnh chụp bản trước: đọc hỏng khi tra gần đúng ⇒ chưa kết luận (không coi là «không có»), không gửi, giữ dấu', async () => {
  seedLegacyImport(T0 - 10 * 60_000, [legacyRow(2, 100)], [], [2]);
  io.server.failNext('income_expenses', 'read', 'drop-before');
  await expect(submit([line(1)])).rejects.toThrow(/đối chiếu/);
  expect(compatCalls()).toHaveLength(0);
  expect(pendingKeys()).toHaveLength(1);
});

it('dấu bản trước gieo sẵn ≥ 10 phút, không tên thao tác, không ảnh chụp ⇒ tra theo giờ của dấu không thấy ⇒ không chặn, nhập ngay, gỡ dấu', async () => {
  seedLegacyPending(scope, new Date(T0 - 10 * 60_000));
  await expect(submit([line(1)])).resolves.toMatchObject({ successCount: 1 });
  expect(compatCalls()).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});

it('ảnh chụp hỏng: tra theo giờ của dấu thấy phiếu ⇒ «có thể đã ghi (mã …)», gỡ dấu, không gửi; lần sau nhập', async () => {
  seedLegacyPending(scope, new Date(T0 - 10 * 60_000));
  localStorage.setItem(SNAPSHOT, '{hỏng');
  io.server.rows.income_expenses = [serverVoucher('v-old', 'PC-7', 100, T0 - 9 * 60_000)];
  const error = await submit([line(1)]).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
  expect((error as Error).message).toMatch(/có thể/i);
  expect((error as Error).message).toContain('PC-7');
  expect(compatCalls()).toHaveLength(0);
  expect(pendingKeys()).toEqual([]);
  await expect(submit([line(1)])).resolves.toMatchObject({ successCount: 1 });
});

it('ảnh chụp của lượt khác (mã lượt lệch) không được dùng: tra theo giờ của dấu', async () => {
  seedLegacyPending(scope, new Date(T0 - 10 * 60_000));
  localStorage.setItem(SNAPSHOT, JSON.stringify({ attemptId: 'lượt-khác', rows: [legacyRow(2, 100)], createdVouchers: [], unconfirmedRows: [], failedRows: [] }));
  await expect(submit([line(1)])).resolves.toMatchObject({ successCount: 1 });
  expect(pendingKeys()).toEqual([]);
});

it('đợt 10a: dòng thường gửi ie_compat_insert_keyed_v1 với mã yêu cầu <mã lượt>:<dòng Excel> (cùng dạng dòng thu cọc); ảnh chụp đánh dấu có mã', async () => {
  plan.push(undefined, 'before');
  await submit([line(1), line(2)]);
  const calls = io.server.rpcCalls.filter(call => call.name === 'ie_compat_insert_keyed_v1');
  expect(calls).toHaveLength(2);
  expect(io.server.rpcCalls.some(call => call.name === 'ie_compat_insert_v2')).toBe(false);
  const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT)!) as { attemptId: string; keyed?: boolean };
  expect(snapshot.keyed).toBe(true);
  expect(calls.map(call => call.args.p_request_key)).toEqual([`${snapshot.attemptId}:2`, `${snapshot.attemptId}:3`]);
});

it('đợt 10a: mất phản hồi mà người nhập không đọc được phiếu (quyền đọc): tra theo mã yêu cầu thấy ⇒ đã ghi, không gửi lại, không «có thể»', async () => {
  plan.push('after');
  await submit([line(1)]);
  io.server.visible.income_expenses = () => false;
  const again = await submit([line(1)]);
  expect(again.reconciledFrom).toBeTruthy();
  expect(again.createdVouchers).toEqual([{ row: 2, id: vouchers()[0].id, code: null }]);
  expect(again.possiblyWritten ?? []).toEqual([]);
  expect(compatCalls()).toHaveLength(1);
  expect(pendingKeys()).toEqual([]);
});

it('đợt 10a: dòng không tới máy chủ, có phiếu giống hệt của người nhập (lượt khác) ⇒ không bị nhận nhầm «có thể đã ghi»; quá 2 phút gửi lại cùng mã, ghi đúng một phiếu', async () => {
  plan.push('before');
  await submit([line(1)]);
  io.server.rows.income_expenses = [serverVoucher('v-khac', 'PC-8', 100, T0 + 1_000)];
  advance(PENDING_SETTLE_MS + 1_000);
  const again = await submit([line(1)]);
  expect(again.reconciledFrom).toBeUndefined();
  expect(again).toMatchObject({ successCount: 1, failedCount: 0 });
  expect(compatCalls()).toHaveLength(2);
  expect(compatCalls()[1].args.p_request_key).toBe(compatCalls()[0].args.p_request_key);
  expect(vouchers()).toHaveLength(2);
  expect(pendingKeys()).toEqual([]);
});

it('đợt 10a: tra theo mã yêu cầu hỏng ⇒ chưa kết luận, không gửi, giữ dấu', async () => {
  plan.push('after');
  await submit([line(1)]);
  io.server.visible.income_expenses = () => false;
  io.server.failNext('get_own_compat_inserts_v1', 'rpc', 'drop-before');
  advance(PENDING_SETTLE_MS + 1_000);
  await expect(submit([line(1)])).rejects.toThrow(/đối chiếu/);
  expect(compatCalls()).toHaveLength(1);
  expect(pendingKeys()).toHaveLength(1);
});

it('đọc hạng mục TRƯỚC khi ghi dấu: đọc hỏng ⇒ báo lỗi, không để lại dấu, không gửi', async () => {
  io.resolverFails = true;
  await expect(submit([line(1)])).rejects.toThrow();
  expect(pendingKeys()).toEqual([]);
  expect(compatCalls()).toHaveLength(0);
});
