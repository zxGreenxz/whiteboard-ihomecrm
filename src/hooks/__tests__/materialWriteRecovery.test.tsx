// @vitest-environment jsdom
// Đợt 8 (luật 5, cách A): lưu vật tư của công việc và SỬA phiếu nhập vật tư không giữ dấu «chờ đối chiếu» nữa.
// Cả hai «xoá rồi chèn lại» toàn bộ dòng của phiếu; trigger production tính lại tồn kho và tổng phiếu bằng SUM của mọi
// dòng đang có (recompute_material_stock, material_purchase_recompute_total), không cộng / trừ dồn. Nên chạy lại cùng
// nội dung cho cùng kết quả: bấm lại không nhân đôi dòng, không trừ tồn hai lần. Đường TẠO phiếu nhập vẫn giữ dấu (đợt 9).
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from './fakeRecordServer';

type Row = Record<string, unknown>;
const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, intercept: undefined as undefined | ((table: string) => unknown) }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.intercept?.(table) ?? io.server.from(table) } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import { recordWriteBlocked } from '@/lib/recordWriteOutcome';
import { materialVoucherRetryBlocked } from '@/lib/materialVoucherOutcome';
import { useUpsertJobMaterialUsage } from '../useMaterialUsages';
import { useCreateMaterialPurchase, useUpdateMaterialPurchase } from '../useMaterialPurchases';

const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);
const rows = (table: string): Row[] => io.server.rows[table] ?? [];
const sum = (list: Row[], value: (row: Row) => number) => list.reduce((total, row) => total + value(row), 0);
/** Đúng công thức recompute_material_stock (production, md5 96f2f70c…): nhập − xuất, tính lại từ mọi dòng. */
const onHand = (materialId: string) =>
  sum(rows('material_purchase_items').filter(row => row.material_id === materialId), row => Number(row.quantity))
  - sum(rows('material_usage_items').filter(row => row.material_id === materialId), row => Number(row.quantity));
const usageLines = (usageId: string) => rows('material_usage_items').filter(row => row.usage_id === usageId);
const purchaseLines = (purchaseId: string) => rows('material_purchase_items').filter(row => row.purchase_id === purchaseId);
/** Đúng công thức material_purchase_recompute_total: SUM(line_total) = SUM(quantity × unit_price). */
const purchaseTotal = (purchaseId: string) => sum(purchaseLines(purchaseId), row => Number(row.quantity) * Number(row.unit_price));
const legacy = (namespace: string, businessKey: string) => seedLegacyPending({ namespace, userId: 'actor', organizationId: 'org-a', businessKey }, TEN_MINUTES_AGO());

/** Lệnh chèn kế tiếp vào `table` bị máy chủ từ chối rõ (mã lỗi đã biết), không ghi gì. */
function rejectNextInsert(table: string, error: { code: string; message: string }) {
  io.intercept = name => {
    if (name !== table) return undefined;
    const real = io.server.from(name) as Record<string, unknown>;
    return { ...real, insert: () => { io.intercept = undefined; return { select: async () => ({ data: null, error }) }; } };
  };
}
/** Ngay trước lệnh xoá kế tiếp trên `table`, chạy `before` (giả người khác vừa xoá bản ghi). */
function beforeNextDelete(table: string, before: () => void) {
  io.intercept = name => {
    if (name !== table) return undefined;
    const real = io.server.from(name) as Record<string, unknown> & { delete: () => unknown };
    return { ...real, delete: () => { io.intercept = undefined; before(); return real.delete(); } };
  };
}

interface JobInput { job_id: string; usage_date: string; notes: string | null; items: Array<{ material_id: string; quantity: number; unit_cost_at_usage: number }> }
type SaveJob = (input: JobInput) => Promise<unknown>;
const saveJob = (): SaveJob => {
  const { result } = renderHook(() => useUpsertJobMaterialUsage({ silent: true }));
  return (result.current as unknown as { mutationFn: SaveJob }).mutationFn;
};
const jobInput: JobInput = { job_id: 'job-1', usage_date: '2026-09-30', notes: null, items: [{ material_id: 'm-1', quantity: 3, unit_cost_at_usage: 100 }] };

interface PurchaseInput { purchase_date: string; supplier_id: string | null; notes: string | null; items: Array<{ material_id: string; quantity: number; unit_price: number }> }
type UpdatePurchase = (input: { id: string; input: PurchaseInput }) => Promise<unknown>;
const updatePurchase = (): UpdatePurchase => {
  const { result } = renderHook(() => useUpdateMaterialPurchase());
  return (result.current as unknown as { mutationFn: UpdatePurchase }).mutationFn;
};
type CreatePurchase = (input: PurchaseInput) => Promise<unknown>;
const createPurchase = (): CreatePurchase => {
  const { result } = renderHook(() => useCreateMaterialPurchase());
  return (result.current as unknown as { mutationFn: CreatePurchase }).mutationFn;
};
const purchaseInput: PurchaseInput = { purchase_date: '2026-09-30', supplier_id: null, notes: 'sửa', items: [{ material_id: 'm-1', quantity: 4, unit_price: 120 }, { material_id: 'm-2', quantity: 2, unit_price: 50 }] };
const purchaseEdit = { id: 'p-1', input: purchaseInput };

/** Lỗi chưa rõ của thao tác lặp lại được: không khoá form, không để dấu. */
function expectRepeatable(error: unknown) {
  expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
  expect(recordWriteBlocked(error)).toBe(false);
  expect(materialVoucherRetryBlocked(error)).toBe(false);
  expect(pendingKeys()).toEqual([]);
}

beforeEach(() => {
  io.server = fakeRecordServer();
  io.intercept = undefined;
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  // Chỉ mục duy nhất uq_material_usages_job: mỗi công việc tối đa một phiếu xuất.
  io.server.uniqueBy.material_usages = row => String(row.job_id);
  // Hàng nhập sẵn để đo tồn: 10 m-1, 10 m-2.
  io.server.rows.material_purchase_items = [
    { id: 'stock-1', purchase_id: 'p-0', material_id: 'm-1', quantity: 10, unit_price: 100, organization_id: 'org-a' },
    { id: 'stock-2', purchase_id: 'p-0', material_id: 'm-2', quantity: 10, unit_price: 50, organization_id: 'org-a' },
  ];
});

describe('vật tư của công việc (material-job-usage): sửa vật tư đã có', () => {
  beforeEach(() => {
    io.server.rows.material_usages = [{ id: 'usage-1', job_id: 'job-1', usage_date: '2026-09-01', notes: null, organization_id: 'org-a' }];
    io.server.rows.material_usage_items = [{ id: 'line-old', usage_id: 'usage-1', material_id: 'm-1', quantity: 5, unit_cost_at_usage: 100, organization_id: 'org-a' }];
  });

  it('chèn không tới máy chủ SAU khi đã xoá: báo rõ «đã xoá vật tư cũ … bấm lưu lại», không dấu; lưu lại ghi đúng bộ dòng', async () => {
    io.server.failNext('material_usage_items', 'insert', 'drop-before');
    const error = await saveJob()(jobInput).catch(failure => failure);
    expectRepeatable(error);
    expect((error as Error).message).toMatch(/Đã xoá vật tư cũ của công việc/);
    expect((error as Error).message).toMatch(/tồn kho/);
    expect((error as Error).message).toMatch(/Lưu vật tư/);
    // Rủi ro còn lại tới đợt 10: giữa hai lần bấm, công việc không còn dòng vật tư nào (tồn đã cộng trả).
    expect(usageLines('usage-1')).toEqual([]);
    expect(onHand('m-1')).toBe(10);
    await expect(saveJob()(jobInput)).resolves.toBe('usage-1');
    expect(usageLines('usage-1')).toHaveLength(1);
    expect(usageLines('usage-1')[0]).toMatchObject({ material_id: 'm-1', quantity: 3 });
    expect(onHand('m-1')).toBe(7);
    expect(pendingKeys()).toEqual([]);
  });

  it('chèn tới máy chủ nhưng mất phản hồi: bấm lại xoá rồi ghi lại, đúng một bộ dòng, tồn trừ một lần', async () => {
    io.server.failNext('material_usage_items', 'insert', 'drop-after');
    expectRepeatable(await saveJob()(jobInput).catch(failure => failure));
    expect(usageLines('usage-1')).toHaveLength(1);
    await expect(saveJob()(jobInput)).resolves.toBe('usage-1');
    expect(usageLines('usage-1')).toHaveLength(1);
    expect(onHand('m-1')).toBe(7);
    expect(rows('material_usages')).toHaveLength(1);
  });

  it('xoá dòng cũ hoặc sửa đầu phiếu mất phản hồi: bấm lại cho đúng một kết quả', async () => {
    io.server.failNext('material_usage_items', 'delete', 'drop-after');
    const lost = await saveJob()(jobInput).catch(failure => failure);
    expectRepeatable(lost);
    // Lệnh xoá có thể đã chạy: câu báo nói phiếu có thể đang không còn dòng nào và tồn kho tạm tính như vậy.
    expect((lost as Error).message).toMatch(/Chưa xác nhận được kết quả xoá các dòng vật tư cũ/);
    expect((lost as Error).message).toMatch(/tồn kho/);
    expect((lost as Error).message).toMatch(/Lưu vật tư/);
    expect(usageLines('usage-1')).toEqual([]);
    io.server.failNext('material_usages', 'update', 'drop-before');
    expectRepeatable(await saveJob()(jobInput).catch(failure => failure));
    await expect(saveJob()(jobInput)).resolves.toBe('usage-1');
    expect(usageLines('usage-1')).toHaveLength(1);
    expect(onHand('m-1')).toBe(7);
  });

  it('dấu bản trước gieo sẵn không chặn; lưu xong thì gỡ đúng dấu đó', async () => {
    legacy('material-job-usage', 'job-1');
    const other = legacy('material-job-usage', 'job-2');
    await expect(saveJob()(jobInput)).resolves.toBe('usage-1');
    expect(usageLines('usage-1')).toHaveLength(1);
    expect(pendingKeys()).toEqual([other]);
  });

  it('chèn bị máy chủ từ chối rõ sau khi đã xoá: báo từ chối (không phải chưa rõ), nói rõ đã xoá; sửa rồi lưu lại được', async () => {
    rejectNextInsert('material_usage_items', { code: '23514', message: 'new row violates check constraint raw SQL' });
    const error = await saveJob()(jobInput).catch(failure => failure);
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(error).toMatchObject({ outcome: 'failure' });
    expect((error as Error).message).toMatch(/Đã xoá vật tư cũ của công việc/);
    expect((error as Error).message).not.toContain('raw SQL');
    expect(pendingKeys()).toEqual([]);
    await expect(saveJob()(jobInput)).resolves.toBe('usage-1');
    expect(usageLines('usage-1')).toHaveLength(1);
  });

  it('xoá hết vật tư: gỡ phiếu xuất; mất phản hồi lúc gỡ thì bấm lại báo xong, không dấu', async () => {
    io.server.failNext('material_usages', 'delete', 'drop-after');
    expectRepeatable(await saveJob()({ ...jobInput, items: [] }).catch(failure => failure));
    expect(rows('material_usages')).toEqual([]);
    await expect(saveJob()({ ...jobInput, items: [] })).resolves.toBeNull();
    expect(rows('material_usage_items')).toEqual([]);
    expect(onHand('m-1')).toBe(10);
  });

  it('gỡ phiếu rỗng khớp 0 dòng vì người khác vừa xoá: coi là đã gỡ', async () => {
    beforeNextDelete('material_usages', () => { io.server.rows.material_usages = []; });
    await expect(saveJob()({ ...jobInput, items: [] })).resolves.toBe('usage-1');
    expect(rows('material_usage_items')).toEqual([]);
  });

  it('gỡ phiếu rỗng khớp 0 dòng vì RLS không cho xoá: báo không có quyền, không phải chưa rõ', async () => {
    // Production: sửa phiếu xuất cần quyền `edit`, xoá phiếu xuất cần quyền `delete` (material_usages_delete_rbac).
    io.intercept = name => {
      if (name !== 'material_usages') return undefined;
      const real = io.server.from(name) as Record<string, unknown>;
      return { ...real, delete: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: 'PGRST116', message: 'not single' } }) }) }) }) };
    };
    const error = await saveJob()({ ...jobInput, items: [] }).catch(failure => failure);
    expect(error).toMatchObject({ outcome: 'failure' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect((error as Error).message).toMatch(/Đã xoá hết vật tư của công việc/);
    expect((error as Error).message).toMatch(/quyền/);
    expect(rows('material_usages')).toHaveLength(1);
    expect(rows('material_usage_items')).toEqual([]);
    expect(pendingKeys()).toEqual([]);
  });

  it('hàng rào: biên nhận xoá vật tư cũ sai dạng thì dừng, không chèn dòng mới lên trên; bấm lại chạy lại cả lượt', async () => {
    let malformed = true;
    io.intercept = name => {
      if (name !== 'material_usage_items' || !malformed) return undefined;
      const real = io.server.from(name) as Record<string, unknown> & { delete: () => { eq: (column: string, value: unknown) => { select: () => PromiseLike<unknown> } } };
      return { ...real, delete: () => ({ eq: (column: string, value: unknown) => ({ select: async () => { malformed = false; await real.delete().eq(column, value).select(); return { data: [{ id: null }], error: null }; } }) }) };
    };
    const error = await saveJob()(jobInput).catch(failure => failure);
    expectRepeatable(error);
    expect((error as Error).message).toMatch(/Chưa xác nhận được kết quả xoá các dòng vật tư cũ/);
    expect(io.server.inserts.filter(item => item.table === 'material_usage_items')).toEqual([]);
    io.intercept = undefined;
    await expect(saveJob()(jobInput)).resolves.toBe('usage-1');
    expect(usageLines('usage-1')).toHaveLength(1);
    expect(onHand('m-1')).toBe(7);
  });

  it('sửa đầu phiếu khớp 0 dòng (không thấy / không có quyền): từ chối rõ, không xoá dòng nào', async () => {
    io.server.writable.material_usages = () => false;
    const error = await saveJob()(jobInput).catch(failure => failure);
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(error).toMatchObject({ code: 'PGRST116' });
    expect(usageLines('usage-1')).toHaveLength(1);
    expect(usageLines('usage-1')[0].id).toBe('line-old');
    expect(pendingKeys()).toEqual([]);
  });
});

describe('vật tư của công việc: công việc chưa có phiếu xuất', () => {
  it('tạo đầu phiếu mất phản hồi: bấm lại thấy phiếu vừa tạo, không tạo phiếu thứ hai', async () => {
    io.server.failNext('material_usages', 'insert', 'drop-after');
    expectRepeatable(await saveJob()(jobInput).catch(failure => failure));
    const saved = await saveJob()(jobInput);
    expect(rows('material_usages')).toHaveLength(1);
    expect(saved).toBe(rows('material_usages')[0].id);
    expect(usageLines(String(saved))).toHaveLength(1);
    expect(onHand('m-1')).toBe(7);
  });

  it('tạo đầu phiếu không tới máy chủ: bấm lại tạo đúng một phiếu', async () => {
    io.server.failNext('material_usages', 'insert', 'drop-before');
    expectRepeatable(await saveJob()(jobInput).catch(failure => failure));
    await saveJob()(jobInput);
    expect(rows('material_usages')).toHaveLength(1);
    expect(rows('material_usage_items')).toHaveLength(1);
  });

  it('đã tạo đầu phiếu mà ghi dòng hỏng: báo rõ đã tạo phiếu, bấm lại ghi dòng vào đúng phiếu đó', async () => {
    io.server.failNext('material_usage_items', 'insert', 'drop-before');
    const error = await saveJob()(jobInput).catch(failure => failure);
    expectRepeatable(error);
    expect((error as Error).message).toMatch(/Đã tạo phiếu xuất cho công việc/);
    const saved = await saveJob()(jobInput);
    expect(rows('material_usages')).toHaveLength(1);
    expect(usageLines(String(saved))).toHaveLength(1);
  });
});

describe('sửa phiếu nhập vật tư (material-purchase, đường sửa)', () => {
  beforeEach(() => {
    io.server.rows.material_purchases = [{ id: 'p-1', organization_id: 'org-a', purchase_date: '2026-09-01', supplier_id: null, notes: null }];
    io.server.rows.material_purchase_items.push({ id: 'pl-old', purchase_id: 'p-1', material_id: 'm-1', quantity: 10, unit_price: 100, organization_id: 'org-a' });
  });

  it('chèn không tới máy chủ SAU khi đã xoá: báo rõ đã xoá dòng cũ, không dấu; bấm lại ghi đúng bộ dòng', async () => {
    io.server.failNext('material_purchase_items', 'insert', 'drop-before');
    const error = await updatePurchase()(purchaseEdit).catch(failure => failure);
    expectRepeatable(error);
    expect((error as Error).message).toMatch(/Đã xoá các dòng cũ của phiếu nhập/);
    expect((error as Error).message).toMatch(/tồn kho/);
    expect((error as Error).message).toMatch(/Cập nhật/);
    expect(purchaseLines('p-1')).toEqual([]);
    expect(onHand('m-1')).toBe(10);
    await updatePurchase()(purchaseEdit);
    expect(purchaseLines('p-1')).toHaveLength(2);
    expect(purchaseTotal('p-1')).toBe(4 * 120 + 2 * 50);
    expect(onHand('m-1')).toBe(14);
    expect(onHand('m-2')).toBe(12);
    expect(purchaseLines('p-1').every(row => row.organization_id === 'org-a')).toBe(true);
  });

  it('chèn tới máy chủ nhưng mất phản hồi: bấm lại không nhân đôi dòng, tồn và tổng phiếu đúng', async () => {
    io.server.failNext('material_purchase_items', 'insert', 'drop-after');
    expectRepeatable(await updatePurchase()(purchaseEdit).catch(failure => failure));
    expect(purchaseLines('p-1')).toHaveLength(2);
    await updatePurchase()(purchaseEdit);
    expect(purchaseLines('p-1')).toHaveLength(2);
    expect(purchaseTotal('p-1')).toBe(580);
    expect(onHand('m-1')).toBe(14);
    expect(onHand('m-2')).toBe(12);
  });

  it('xoá dòng cũ hoặc sửa đầu phiếu mất phản hồi: bấm lại cho đúng một kết quả', async () => {
    io.server.failNext('material_purchase_items', 'delete', 'drop-after');
    const lost = await updatePurchase()(purchaseEdit).catch(failure => failure);
    expectRepeatable(lost);
    expect((lost as Error).message).toMatch(/Chưa xác nhận được kết quả xoá các dòng vật tư cũ/);
    expect((lost as Error).message).toMatch(/Cập nhật/);
    expect(purchaseLines('p-1')).toEqual([]);
    expect(onHand('m-1')).toBe(10);
    io.server.failNext('material_purchases', 'update', 'drop-after');
    expectRepeatable(await updatePurchase()(purchaseEdit).catch(failure => failure));
    await updatePurchase()(purchaseEdit);
    expect(purchaseLines('p-1')).toHaveLength(2);
    expect(rows('material_purchases')[0]).toMatchObject({ purchase_date: '2026-09-30', notes: 'sửa' });
    expect(purchaseTotal('p-1')).toBe(580);
  });

  it('dấu bản trước của đúng phiếu không chặn và được gỡ; dấu của đường TẠO phiếu nhập để nguyên', async () => {
    const editKey = ['update', 'p-1'].join(':');
    legacy('material-purchase', editKey);
    const createMarker = legacy('material-purchase', 'create');
    await updatePurchase()(purchaseEdit);
    expect(purchaseLines('p-1')).toHaveLength(2);
    expect(pendingKeys()).toEqual([createMarker]);
  });

  it('chèn bị máy chủ từ chối rõ sau khi đã xoá: báo từ chối, nói rõ đã xoá dòng cũ; không khoá', async () => {
    rejectNextInsert('material_purchase_items', { code: '23514', message: 'unit_price check raw SQL' });
    const error = await updatePurchase()(purchaseEdit).catch(failure => failure);
    expect(error).toMatchObject({ outcome: 'failure' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect((error as Error).message).toMatch(/Đã xoá các dòng cũ của phiếu nhập/);
    expect((error as Error).message).not.toContain('raw SQL');
    expect(materialVoucherRetryBlocked(error)).toBe(false);
    expect(pendingKeys()).toEqual([]);
    await updatePurchase()(purchaseEdit);
    expect(purchaseLines('p-1')).toHaveLength(2);
  });

  it('sửa đầu phiếu khớp 0 dòng (đã xoá / không có quyền): từ chối rõ, không đụng dòng nào', async () => {
    io.server.writable.material_purchases = () => false;
    const error = await updatePurchase()(purchaseEdit).catch(failure => failure);
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(error).toMatchObject({ code: 'PGRST116' });
    expect(purchaseLines('p-1').map(row => row.id)).toEqual(['pl-old']);
    expect(pendingKeys()).toEqual([]);
  });

  it('hàng rào: biên nhận xoá dòng sai dạng thì dừng, không chèn dòng mới; bấm lại chạy lại cả lượt', async () => {
    let malformed = true;
    io.intercept = name => {
      if (name !== 'material_purchase_items' || !malformed) return undefined;
      const real = io.server.from(name) as Record<string, unknown> & { delete: () => { eq: (column: string, value: unknown) => { select: () => PromiseLike<unknown> } } };
      return { ...real, delete: () => ({ eq: (column: string, value: unknown) => ({ select: async () => { malformed = false; await real.delete().eq(column, value).select(); return { data: [{ id: null }], error: null }; } }) }) };
    };
    expectRepeatable(await updatePurchase()(purchaseEdit).catch(failure => failure));
    expect(io.server.inserts.filter(item => item.table === 'material_purchase_items')).toEqual([]);
    io.intercept = undefined;
    await updatePurchase()(purchaseEdit);
    expect(purchaseLines('p-1')).toHaveLength(2);
  });

  it('đường TẠO phiếu nhập vẫn giữ dấu (đợt 9): mất phản hồi thì lần tạo sau bị chặn, không tạo phiếu thứ hai', async () => {
    io.server.failNext('material_purchases', 'insert', 'drop-after');
    await expect(createPurchase()(purchaseInput)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(pendingKeys()).toHaveLength(1);
    await expect(createPurchase()(purchaseInput)).rejects.toBeInstanceOf(FinancialWorkflowError);
    expect(rows('material_purchases')).toHaveLength(2);
    expect(io.server.inserts.filter(item => item.table === 'material_purchases')).toHaveLength(1);
  });
});
