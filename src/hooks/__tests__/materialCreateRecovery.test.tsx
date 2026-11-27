// @vitest-environment jsdom
// Đợt 9 (plan sửa khoá vĩnh viễn sau rớt mạng): TẠO phiếu vật tư không giữ dấu «chờ đối chiếu» nữa. Đầu phiếu mang mã do
// trình duyệt sinh (`createRecordOnce`), các dòng cũng mang mã do trình duyệt sinh và được nhớ theo đầu phiếu: lần bấm lại
// gửi ĐÚNG các mã đó nên khoá chính chặn bản thứ hai, kể cả khi lệnh cũ tới trễ. Tồn kho production do trigger tính lại
// tuyệt đối từ mọi dòng (recompute_material_stock md5 96f2f70c…: nhập − xuất + kiểm kê IN − kiểm kê OUT), nên đo «không
// cộng dồn» bằng chính công thức đó trên máy chủ giả.
// Đặt tồn theo kiểm kê là phép CỘNG DỒN (một phiếu IN/OUT theo phần chênh): mỗi lần bấm đọc tồn hiện tại trên máy chủ rồi
// tính lại phần chênh, không bao giờ gửi lại số chênh cũ, không dùng số tồn của màn.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from './fakeRecordServer';

type Row = Record<string, unknown>;
const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, intercept: undefined as undefined | ((table: string) => unknown), materials: [] as string[] }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      // Bảng `materials`: tồn do trigger tính lại từ mọi dòng; máy chủ giả tính lại ngay lúc đọc.
      if (table === 'materials') io.server.rows.materials = io.materials.map(id => ({ id, on_hand: stock(id), organization_id: 'org-a' }));
      return io.intercept?.(table) ?? io.server.from(table);
    },
  },
}));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { FinancialAlreadyRecordedError, FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import { recordWriteBlocked } from '@/lib/recordWriteOutcome';
import { forgetUnconfirmedCreates } from '@/lib/clientRecordCreate';
import { useCreateMaterialPurchase } from '../useMaterialPurchases';
import { useCreateMaterialAdjustment, useSetMaterialStock } from '../useMaterialAdjustments';
import { useCreateMaterialUsage } from '../useMaterialUsages';

const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);
const rows = (table: string): Row[] => io.server.rows[table] ?? [];
const sum = (list: Row[], value: (row: Row) => number) => list.reduce((total, row) => total + value(row), 0);
const adjustmentType = (row: Row) => rows('material_adjustments').find(header => header.id === row.adjustment_id)?.type;
/** Đúng công thức recompute_material_stock (production 26/11/2026, md5 96f2f70c…). */
function stock(materialId: string): number {
  const of = (table: string) => rows(table).filter(row => row.material_id === materialId);
  return sum(of('material_purchase_items'), row => Number(row.quantity))
    - sum(of('material_usage_items'), row => Number(row.quantity))
    + sum(of('material_adjustment_items').filter(row => adjustmentType(row) === 'IN'), row => Number(row.quantity))
    - sum(of('material_adjustment_items').filter(row => adjustmentType(row) === 'OUT'), row => Number(row.quantity));
}
const insertsInto = (table: string) => io.server.inserts.filter(item => item.table === table);
const sentIds = (table: string) => insertsInto(table).flatMap(item => (Array.isArray(item.payload) ? item.payload : [item.payload]).map(row => row.id));
const legacy = (namespace: string, businessKey: string) => seedLegacyPending({ namespace, userId: 'actor', organizationId: 'org-a', businessKey }, TEN_MINUTES_AGO());

/** Lỗi chưa rõ của đợt 9: không khoá form, không để dấu. */
function expectRetryable(error: unknown) {
  expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
  expect(recordWriteBlocked(error)).toBe(false);
  expect(pendingKeys()).toEqual([]);
}
/** Lệnh chèn kế tiếp vào `table` bị máy chủ từ chối rõ (mã lỗi đã biết), không ghi gì. */
function rejectNextInsert(table: string, error: { code: string; message: string }) {
  io.intercept = name => {
    if (name !== table) return undefined;
    const real = io.server.from(name) as Record<string, unknown>;
    return { ...real, insert: () => { io.intercept = undefined; return { select: async () => ({ data: null, error }) }; } };
  };
}
/** Ngay trước lệnh chèn kế tiếp vào `table`, lệnh cũ (đúng các dòng đã gửi lần trước) tới máy chủ trễ và được ghi. */
function lateArrivalBeforeNextInsert(table: string, late: Row[]) {
  io.intercept = name => {
    if (name !== table) return undefined;
    const real = io.server.from(name) as Record<string, unknown> & { insert: (value: unknown) => unknown };
    return { ...real, insert: (value: unknown) => { io.intercept = undefined; io.server.rows[table] = [...rows(table), ...late.map(row => ({ ...row }))]; return real.insert(value); } };
  };
}
/** Lệnh chèn kế tiếp vào `table` tới máy chủ và đã ghi, phản hồi mất, lần đọc lại ngay sau đó cũng hỏng: kết quả chưa rõ. */
function lostResponse(table: string) {
  io.server.failNext(table, 'insert', 'drop-after');
  io.server.failNext(table, 'read', 'drop-before');
}
const lastPayload = (table: string): Row[] => {
  const last = insertsInto(table).at(-1)!.payload;
  return Array.isArray(last) ? last : [last];
};
/** Lệnh chèn kế tiếp vào `table` được ghi thật, nhưng biên nhận trả mã dòng LẠ (không phải các mã trình duyệt đã gửi). */
function foreignReceiptOnNextInsert(table: string) {
  io.intercept = name => {
    if (name !== table) return undefined;
    const real = io.server.from(name) as Record<string, unknown> & { insert: (value: unknown) => { select: () => PromiseLike<{ data: unknown; error: unknown }> } };
    return {
      ...real,
      insert: (value: unknown) => {
        io.intercept = undefined;
        const sent = real.insert(value);
        return { select: async () => { const reply = await sent.select(); return reply.error ? reply : { data: (reply.data as Row[]).map((_row, index) => ({ id: `ma-la-${index}` })), error: null }; } };
      },
    };
  };
}

type Run = (input: unknown) => Promise<unknown>;
const createPurchase = (): Run => { const { result } = renderHook(() => useCreateMaterialPurchase()); return (result.current as unknown as { mutationFn: Run }).mutationFn; };
const createAdjustment = (): Run => { const { result } = renderHook(() => useCreateMaterialAdjustment()); return (result.current as unknown as { mutationFn: Run }).mutationFn; };
const setStock = (): Run => { const { result } = renderHook(() => useSetMaterialStock({ silent: true })); return (result.current as unknown as { mutationFn: Run }).mutationFn; };
const createUsage = (): Run => { const { result } = renderHook(() => useCreateMaterialUsage()); return (result.current as unknown as { mutationFn: Run }).mutationFn; };

const purchase = { purchase_date: '2026-11-26', supplier_id: null, notes: 'nhập tháng', draft: 'nhap-1', items: [{ material_id: 'm-1', quantity: 4, unit_price: 120 }, { material_id: 'm-2', quantity: 2, unit_price: 50 }] };
const adjustment = { adjustment_date: '2026-11-26', type: 'IN', reason: 'tìm thấy thừa', draft: 'kiem-1', items: [{ material_id: 'm-1', quantity: 3 }] };
const usage = { usage_date: '2026-11-26', notes: 'xuất sửa', draft: 'xuat-1', items: [{ material_id: 'm-1', quantity: 2, unit_cost_at_usage: 100 }] };

beforeEach(() => {
  io.server = fakeRecordServer();
  io.intercept = undefined;
  io.materials = ['m-1', 'm-2'];
  forgetUnconfirmedCreates();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  // Hàng nhập sẵn để đo tồn: 10 m-1, 10 m-2.
  io.server.rows.material_purchase_items = [
    { id: 'stock-1', purchase_id: 'p-0', material_id: 'm-1', quantity: 10, unit_price: 100, organization_id: 'org-a' },
    { id: 'stock-2', purchase_id: 'p-0', material_id: 'm-2', quantity: 10, unit_price: 50, organization_id: 'org-a' },
  ];
});

describe('tạo phiếu nhập (material-purchase, khoá create)', () => {
  const headers = () => rows('material_purchases');
  const linesOf = (id: unknown) => rows('material_purchase_items').filter(row => row.purchase_id === id);

  it('đầu phiếu không tới máy chủ: báo rõ, không dấu, không khoá; bấm lại tạo đúng một phiếu, tồn cộng một lần', async () => {
    io.server.failNext('material_purchases', 'insert', 'drop-before');
    expectRetryable(await createPurchase()(purchase).catch(failure => failure));
    expect(headers()).toEqual([]);
    await createPurchase()(purchase);
    expect(headers()).toHaveLength(1);
    expect(linesOf(headers()[0].id)).toHaveLength(2);
    expect(stock('m-1')).toBe(14);
    expect(stock('m-2')).toBe(12);
    expect(pendingKeys()).toEqual([]);
  });

  it('đầu phiếu mất phản hồi nhưng đọc lại ngay thấy: ghi tiếp dòng ngay trong lần bấm đó, không chưa rõ', async () => {
    io.server.failNext('material_purchases', 'insert', 'drop-after');
    const created = await createPurchase()(purchase);
    expect(created).toMatchObject({ id: headers()[0].id, replayed: false });
    expect(headers()).toHaveLength(1);
    expect(linesOf(headers()[0].id)).toHaveLength(2);
    expect(stock('m-1')).toBe(14);
  });

  it('đầu phiếu tới nhưng mất phản hồi và đọc lại cũng hỏng: bấm lại gửi đúng mã cũ, ghi dòng vào đúng phiếu đó, không có phiếu thứ hai', async () => {
    io.server.failNext('material_purchases', 'insert', 'drop-after');
    io.server.failNext('material_purchases', 'read', 'drop-before');
    expectRetryable(await createPurchase()(purchase).catch(failure => failure));
    expect(headers()).toHaveLength(1);
    expect(linesOf(headers()[0].id)).toEqual([]);
    const created = await createPurchase()(purchase);
    expect(created).toMatchObject({ id: headers()[0].id });
    expect(headers()).toHaveLength(1);
    expect(new Set(sentIds('material_purchases')).size).toBe(1);
    expect(linesOf(headers()[0].id)).toHaveLength(2);
    expect(stock('m-1')).toBe(14);
  });

  it('dòng mất phản hồi nhưng đọc lại ngay thấy đủ dòng: báo tạo xong, không gửi lần hai', async () => {
    io.server.failNext('material_purchase_items', 'insert', 'drop-after');
    const created = await createPurchase()(purchase);
    expect(created).toMatchObject({ id: headers()[0].id, replayed: false });
    expect(insertsInto('material_purchase_items')).toHaveLength(1);
    expect(linesOf(headers()[0].id)).toHaveLength(2);
    expect(stock('m-1')).toBe(14);
  });

  it('dòng tới nhưng mất phản hồi và đọc lại cũng hỏng: bấm lại thấy đủ dòng, không gửi lệnh chèn dòng nào nữa, báo đã lưu ở lần trước', async () => {
    io.server.failNext('material_purchase_items', 'insert', 'drop-after');
    io.server.failNext('material_purchase_items', 'read', 'drop-before');
    const lost = await createPurchase()(purchase).catch(failure => failure);
    expectRetryable(lost);
    expect((lost as FinancialWorkflowError).completed.map(step => step.id)).toEqual([headers()[0].id]);
    expect(linesOf(headers()[0].id)).toHaveLength(2);
    const created = await createPurchase()(purchase);
    expect(created).toMatchObject({ id: headers()[0].id, replayed: true });
    expect(insertsInto('material_purchase_items')).toHaveLength(1);
    expect(headers()).toHaveLength(1);
    expect(linesOf(headers()[0].id)).toHaveLength(2);
    expect(stock('m-1')).toBe(14);
    expect(stock('m-2')).toBe(12);
  });

  it('dòng không tới máy chủ: không gỡ đầu phiếu; bấm lại ghi dòng vào ĐÚNG phiếu đó', async () => {
    io.server.failNext('material_purchase_items', 'insert', 'drop-before');
    expectRetryable(await createPurchase()(purchase).catch(failure => failure));
    expect(headers()).toHaveLength(1);
    await createPurchase()(purchase);
    expect(headers()).toHaveLength(1);
    expect(linesOf(headers()[0].id)).toHaveLength(2);
    expect(stock('m-1')).toBe(14);
  });

  it('lệnh chèn dòng cũ tới trễ đúng lúc bấm lại: mã dòng do trình duyệt sinh chặn bộ dòng thứ hai', async () => {
    io.server.failNext('material_purchase_items', 'insert', 'drop-before');
    expectRetryable(await createPurchase()(purchase).catch(failure => failure));
    lateArrivalBeforeNextInsert('material_purchase_items', lastPayload('material_purchase_items'));
    await createPurchase()(purchase);
    expect(headers()).toHaveLength(1);
    expect(linesOf(headers()[0].id)).toHaveLength(2);
    expect(stock('m-1')).toBe(14);
    expect(stock('m-2')).toBe(12);
  });

  it('sửa dòng giữa hai lần bấm (cùng bản nháp) khi lần trước đã ghi: báo phiếu đã tạo kèm mã, không chèn dòng', async () => {
    lostResponse('material_purchase_items');
    expectRetryable(await createPurchase()(purchase).catch(failure => failure));
    const id = String(headers()[0].id);
    const edited = { ...purchase, items: [{ material_id: 'm-1', quantity: 5, unit_price: 120 }] };
    const error = await createPurchase()(edited).catch(failure => failure);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
    expect((error as Error).message).toContain(id);
    expect(insertsInto('material_purchase_items')).toHaveLength(1);
    expect(stock('m-1')).toBe(14);
    // Bấm lại nữa là lượt mới: người dùng đã thấy mã phiếu trước và vẫn muốn tạo thêm.
    await createPurchase()(edited);
    expect(headers()).toHaveLength(2);
    expect(stock('m-1')).toBe(19);
  });

  it('sửa đầu phiếu giữa hai lần bấm (cùng bản nháp) khi lần trước đã ghi: báo phiếu đã tạo kèm mã, không tạo phiếu thứ hai', async () => {
    lostResponse('material_purchases');
    expectRetryable(await createPurchase()(purchase).catch(failure => failure));
    const error = await createPurchase()({ ...purchase, notes: 'ghi chú khác' }).catch(failure => failure);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
    expect((error as Error).message).toContain(String(headers()[0].id));
    // Phiếu của lần trước chưa có dòng nào: câu báo nói rõ để người dùng mở sửa hoặc xoá, không để phiếu rỗng sót lại im lặng.
    expect((error as Error).message).toContain('CHƯA có dòng vật tư nào');
    expect(headers()).toHaveLength(1);
    expect(rows('material_purchase_items')).toHaveLength(2);
  });

  it('sửa đầu phiếu giữa hai lần bấm khi lần trước đã ghi trọn cả dòng: báo phiếu đã tạo kèm mã, không nói «chưa có dòng»', async () => {
    lostResponse('material_purchase_items');
    expectRetryable(await createPurchase()(purchase).catch(failure => failure));
    const error = await createPurchase()({ ...purchase, notes: 'ghi chú khác' }).catch(failure => failure);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
    expect((error as Error).message).toContain(String(headers()[0].id));
    expect((error as Error).message).not.toContain('CHƯA có dòng');
    expect(headers()).toHaveLength(1);
    expect(insertsInto('material_purchase_items')).toHaveLength(1);
  });

  it('hàng rào: biên nhận chèn dòng có mã lạ ⇒ không coi là xong, đọc lại dòng của phiếu để kết luận', async () => {
    foreignReceiptOnNextInsert('material_purchase_items');
    const created = await createPurchase()(purchase);
    // Kết luận từ lần đọc lại đúng phiếu (đủ dòng), không từ biên nhận lạ; không gửi lần hai.
    expect(created).toMatchObject({ id: headers()[0].id });
    expect(insertsInto('material_purchase_items')).toHaveLength(1);
    expect(stock('m-1')).toBe(14);
  });

  it('hàng rào: biên nhận chèn dòng có mã lạ và đọc lại hỏng ⇒ chưa rõ (không báo xong); bấm lại đọc dòng của phiếu, không chèn lần hai', async () => {
    foreignReceiptOnNextInsert('material_purchase_items');
    io.server.failNext('material_purchase_items', 'read', 'drop-before');
    expectRetryable(await createPurchase()(purchase).catch(failure => failure));
    const created = await createPurchase()(purchase);
    expect(created).toMatchObject({ id: headers()[0].id, replayed: true });
    expect(insertsInto('material_purchase_items')).toHaveLength(1);
    expect(headers()).toHaveLength(1);
    expect(stock('m-1')).toBe(14);
    expect(stock('m-2')).toBe(12);
  });

  it('mở lại form (bản nháp mới) với đúng nội dung chưa rõ: vẫn nhận ra lần gửi trước, không tạo phiếu thứ hai', async () => {
    lostResponse('material_purchase_items');
    expectRetryable(await createPurchase()(purchase).catch(failure => failure));
    await createPurchase()({ ...purchase, draft: 'nhap-2' });
    expect(headers()).toHaveLength(1);
    expect(stock('m-1')).toBe(14);
  });

  it('dòng bị máy chủ từ chối rõ: gỡ phiếu tạm, báo từ chối (không khoá, không lộ lỗi gốc); bấm lại là lượt mới', async () => {
    rejectNextInsert('material_purchase_items', { code: '23514', message: 'unit_price check raw SQL' });
    const error = await createPurchase()(purchase).catch(failure => failure);
    expect(error).toMatchObject({ outcome: 'failure' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect((error as Error).message).toContain('phiếu tạm đã gỡ');
    expect((error as Error).message).not.toContain('raw SQL');
    expect(headers()).toEqual([]);
    await createPurchase()(purchase);
    expect(headers()).toHaveLength(1);
    expect(new Set(sentIds('material_purchases')).size).toBe(2);
    expect(stock('m-1')).toBe(14);
  });

  it('hàng rào: dòng mất phản hồi rồi đọc lại dòng hỏng hai lần liền ⇒ vẫn chưa rõ, không chèn chồng; bấm lại sau đó đúng một bộ dòng', async () => {
    lostResponse('material_purchase_items');
    expectRetryable(await createPurchase()(purchase).catch(failure => failure));
    io.server.failNext('material_purchase_items', 'read', 'drop-before');
    expectRetryable(await createPurchase()(purchase).catch(failure => failure));
    expect(insertsInto('material_purchase_items')).toHaveLength(1);
    await createPurchase()(purchase);
    expect(linesOf(headers()[0].id)).toHaveLength(2);
    expect(stock('m-1')).toBe(14);
  });

  it('dấu bản trước (khoá create) gieo sẵn không chặn; tạo xong thì gỡ; dấu của đường sửa để nguyên', async () => {
    legacy('material-purchase', 'create');
    const editMarker = legacy('material-purchase', ['update', 'p-9'].join(':'));
    await createPurchase()(purchase);
    expect(headers()).toHaveLength(1);
    expect(pendingKeys()).toEqual([editMarker]);
  });
});

describe('tạo phiếu kiểm kê IN/OUT (material-adjustment, khoá create)', () => {
  const headers = () => rows('material_adjustments');

  it('đầu phiếu không tới máy chủ: bấm lại ghi đúng một phiếu', async () => {
    io.server.failNext('material_adjustments', 'insert', 'drop-before');
    expectRetryable(await createAdjustment()(adjustment).catch(failure => failure));
    await createAdjustment()(adjustment);
    expect(headers()).toHaveLength(1);
    expect(stock('m-1')).toBe(13);
  });

  it('đầu phiếu mất phản hồi: bấm lại dùng đúng phiếu đó, tồn cộng một lần', async () => {
    lostResponse('material_adjustments');
    expectRetryable(await createAdjustment()(adjustment).catch(failure => failure));
    await createAdjustment()(adjustment);
    expect(headers()).toHaveLength(1);
    expect(rows('material_adjustment_items')).toHaveLength(1);
    expect(stock('m-1')).toBe(13);
  });

  it('dòng mất phản hồi: bấm lại không chèn thêm, tồn cộng một lần', async () => {
    lostResponse('material_adjustment_items');
    expectRetryable(await createAdjustment()(adjustment).catch(failure => failure));
    await expect(createAdjustment()(adjustment)).resolves.toMatchObject({ replayed: true });
    expect(insertsInto('material_adjustment_items')).toHaveLength(1);
    expect(stock('m-1')).toBe(13);
  });

  it('dấu bản trước (khoá create) gieo sẵn không chặn; tạo xong thì gỡ', async () => {
    legacy('material-adjustment', 'create');
    await createAdjustment()(adjustment);
    expect(stock('m-1')).toBe(13);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('tạo phiếu xuất tay (material-manual-usage, khoá create)', () => {
  const headers = () => rows('material_usages');

  it('đầu phiếu không tới máy chủ: bấm lại ghi đúng một phiếu, tồn trừ một lần', async () => {
    io.server.failNext('material_usages', 'insert', 'drop-before');
    expectRetryable(await createUsage()(usage).catch(failure => failure));
    await createUsage()(usage);
    expect(headers()).toHaveLength(1);
    expect(stock('m-1')).toBe(8);
  });

  it('đầu phiếu mất phản hồi: bấm lại dùng đúng phiếu đó', async () => {
    lostResponse('material_usages');
    expectRetryable(await createUsage()(usage).catch(failure => failure));
    await createUsage()(usage);
    expect(headers()).toHaveLength(1);
    expect(headers()[0]).toMatchObject({ job_id: null, organization_id: 'org-a' });
    expect(stock('m-1')).toBe(8);
  });

  it('dòng mất phản hồi: bấm lại không trừ tồn lần hai', async () => {
    lostResponse('material_usage_items');
    expectRetryable(await createUsage()(usage).catch(failure => failure));
    await createUsage()(usage);
    expect(insertsInto('material_usage_items')).toHaveLength(1);
    expect(headers()).toHaveLength(1);
    expect(stock('m-1')).toBe(8);
  });

  it('dòng bị từ chối rõ: gỡ phiếu tạm, không khoá', async () => {
    rejectNextInsert('material_usage_items', { code: '23514', message: 'quantity check raw SQL' });
    const error = await createUsage()(usage).catch(failure => failure);
    expect(error).toMatchObject({ outcome: 'failure' });
    expect((error as Error).message).toContain('phiếu tạm đã gỡ');
    expect(headers()).toEqual([]);
    await createUsage()(usage);
    expect(stock('m-1')).toBe(8);
  });

  it('dấu bản trước (khoá create) gieo sẵn không chặn; tạo xong thì gỡ', async () => {
    legacy('material-manual-usage', 'create');
    await createUsage()(usage);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('đặt tồn theo kiểm kê (material-adjustment, khoá create): phép cộng dồn', () => {
  const headers = () => rows('material_adjustments');
  const lines = () => rows('material_adjustment_items');
  const target = (quantity: number) => ({ material_id: 'm-1', target_quantity: quantity, reason: 'Kiểm kê' });

  it('đọc tồn hiện tại trên máy chủ, không dùng số tồn của màn', async () => {
    // Màn đang hiện tồn cũ 3; máy chủ đang có 10. Đặt về 7 ⇒ một phiếu OUT 3.
    await setStock()({ ...target(7), current_quantity: 3 });
    expect(headers()).toHaveLength(1);
    expect(headers()[0]).toMatchObject({ type: 'OUT' });
    expect(lines()[0]).toMatchObject({ material_id: 'm-1', quantity: 3 });
    expect(stock('m-1')).toBe(7);
  });

  it('tồn đã khớp: không ghi gì', async () => {
    await expect(setStock()(target(10))).resolves.toBeNull();
    expect(io.server.inserts).toEqual([]);
  });

  it('đọc tồn hỏng: chưa ghi gì, báo rõ, không khoá; bấm lại đặt đúng', async () => {
    io.server.failNext('materials', 'read', 'drop-before');
    expectRetryable(await setStock()(target(13)).catch(failure => failure));
    expect(io.server.inserts).toEqual([]);
    await setStock()(target(13));
    expect(stock('m-1')).toBe(13);
  });

  it('đầu phiếu không tới máy chủ: bấm lại ghi đúng một phiếu, tồn về đúng số kiểm đếm', async () => {
    io.server.failNext('material_adjustments', 'insert', 'drop-before');
    expectRetryable(await setStock()(target(13)).catch(failure => failure));
    await setStock()(target(13));
    expect(headers()).toHaveLength(1);
    expect(stock('m-1')).toBe(13);
  });

  it('đầu phiếu mất phản hồi: bấm lại dùng đúng phiếu đó, ghi dòng một lần', async () => {
    lostResponse('material_adjustments');
    expectRetryable(await setStock()(target(13)).catch(failure => failure));
    await setStock()(target(13));
    expect(headers()).toHaveLength(1);
    expect(lines()).toHaveLength(1);
    expect(stock('m-1')).toBe(13);
  });

  it('dòng mất phản hồi nhưng đọc lại ngay thấy, tồn đã về đích: báo xong ngay trong lần bấm đó', async () => {
    io.server.failNext('material_adjustment_items', 'insert', 'drop-after');
    const result = await setStock()(target(13));
    expect(result).toMatchObject({ id: headers()[0].id, replayed: false });
    expect(insertsInto('material_adjustment_items')).toHaveLength(1);
    expect(stock('m-1')).toBe(13);
  });

  it('dòng mất phản hồi (đã ghi): bấm lại đọc tồn mới thấy đã khớp, KHÔNG gửi lại số chênh cũ', async () => {
    lostResponse('material_adjustment_items');
    expectRetryable(await setStock()(target(13)).catch(failure => failure));
    expect(stock('m-1')).toBe(13);
    await expect(setStock()(target(13))).resolves.toBeNull();
    expect(insertsInto('material_adjustment_items')).toHaveLength(1);
    expect(headers()).toHaveLength(1);
    expect(stock('m-1')).toBe(13);
  });

  it('dòng cũ tới trễ sau lần đọc tồn của lần bấm lại: mã dòng chặn bản thứ hai, báo đã cập nhật ở lần bấm trước', async () => {
    io.server.failNext('material_adjustment_items', 'insert', 'drop-before');
    expectRetryable(await setStock()(target(13)).catch(failure => failure));
    lateArrivalBeforeNextInsert('material_adjustment_items', lastPayload('material_adjustment_items'));
    const result = await setStock()(target(13));
    expect(result).toMatchObject({ id: headers()[0].id, replayed: true });
    expect(headers()).toHaveLength(1);
    expect(lines()).toHaveLength(1);
    expect(stock('m-1')).toBe(13);
  });

  it('lần trước đã ghi trọn rồi phiếu khác làm tồn lệch đúng bằng phần chênh cũ: không coi là xong, báo mã phiếu trước; bấm lại đặt đúng', async () => {
    lostResponse('material_adjustment_items');
    expectRetryable(await setStock()(target(13)).catch(failure => failure));
    const first = String(headers()[0].id);
    // Người khác xuất 3 m-1 ngay sau đó: tồn về 10, phần chênh mới lại đúng +3 như lần trước.
    io.server.rows.material_usage_items = [{ id: 'xuat-khac', usage_id: 'u-khac', material_id: 'm-1', quantity: 3, unit_cost_at_usage: 100, organization_id: 'org-a' }];
    const error = await setStock()(target(13)).catch(failure => failure);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
    expect((error as Error).message).toContain(first);
    expect((error as Error).message).toContain('10');
    expect(insertsInto('material_adjustment_items')).toHaveLength(1);
    expect(stock('m-1')).toBe(10);
    await setStock()(target(13));
    expect(headers()).toHaveLength(2);
    expect(stock('m-1')).toBe(13);
  });

  it('đổi số kiểm đếm giữa hai lần bấm khi dòng cũ tới trễ: không cộng hai lần, báo phiếu trước kèm mã', async () => {
    io.server.failNext('material_adjustment_items', 'insert', 'drop-before');
    expectRetryable(await setStock()(target(13)).catch(failure => failure));
    lateArrivalBeforeNextInsert('material_adjustment_items', lastPayload('material_adjustment_items'));
    const error = await setStock()(target(14)).catch(failure => failure);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
    expect((error as Error).message).toContain(String(headers()[0].id));
    expect(lines()).toHaveLength(1);
    expect(stock('m-1')).toBe(13);
    await setStock()(target(14));
    expect(stock('m-1')).toBe(14);
  });

  it('hàng rào: lần trước đã ghi trọn mà đọc lại tồn sau đó hỏng ⇒ chưa rõ (không báo xong); bấm lại kết luận đúng', async () => {
    io.server.failNext('material_adjustment_items', 'insert', 'drop-before');
    expectRetryable(await setStock()(target(13)).catch(failure => failure));
    const late = lastPayload('material_adjustment_items');
    // Lần bấm lại: đọc tồn lần đầu được; lệnh chèn dòng cũ tới trễ ngay trước lệnh chèn mới; lần đọc tồn kiểm tra sau
    // khi thấy dòng cũ thì hỏng.
    let reads = 0;
    let arrived = false;
    io.intercept = name => {
      if (name === 'materials' && ++reads === 2) { const real = io.server.from(name) as Record<string, unknown>; return { ...real, select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }) }) }) }; }
      if (name !== 'material_adjustment_items' || arrived) return undefined;
      const real = io.server.from(name) as Record<string, unknown> & { insert: (value: unknown) => unknown };
      return { ...real, insert: (value: unknown) => { arrived = true; io.server.rows[name] = [...rows(name), ...late.map(row => ({ ...row }))]; return real.insert(value); } };
    };
    expectRetryable(await setStock()(target(13)).catch(failure => failure));
    expect(reads).toBe(2);
    expect(lines()).toHaveLength(1);
    io.intercept = undefined;
    await expect(setStock()(target(13))).resolves.toBeNull();
    expect(lines()).toHaveLength(1);
    expect(stock('m-1')).toBe(13);
  });

  it('dấu bản trước (khoá create) gieo sẵn không chặn; đặt tồn xong thì gỡ', async () => {
    legacy('material-adjustment', 'create');
    await setStock()(target(4));
    expect(stock('m-1')).toBe(4);
    expect(pendingKeys()).toEqual([]);
  });
});
