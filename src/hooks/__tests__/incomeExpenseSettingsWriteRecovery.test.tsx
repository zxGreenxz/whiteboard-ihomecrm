// @vitest-environment jsdom
// Đợt 8 (luật 5), nhóm thiết lập thu chi: sửa / xoá loại thu chi, sửa / xoá / đặt mặc định mẫu in, ngưỡng tự duyệt phiếu chi
// ghi lặp lại được nên không giữ dấu «chờ đối chiếu» nào. Mỗi thao tác chịu ba kiểu sự cố: lệnh không tới máy chủ, tới mà
// mất phản hồi, và dấu bản trước còn nằm trong trình duyệt. Xoá thêm ca khớp 0 dòng (đã xoá trước đó / RLS chặn).
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from './fakeRecordServer';
import { RepeatableWriteUnknownError } from '@/lib/financialWorkflowError';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/lib/ieTypesCache', () => ({ invalidateIeTypesCache: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useDeleteIncomeExpenseType, useUpdateIncomeExpenseType } from '../useIncomeExpenseTypes';
import { useDeleteIncomeExpenseTemplate, useToggleDefaultTemplate, useUpdateIncomeExpenseTemplate } from '../useIncomeExpenseTemplates';
import { useSetIeAutoApproveThreshold } from '../useIeAutoApproveThreshold';

type Row = Record<string, unknown>;
type MutationFn<I, O = Row> = (input: I) => Promise<O>;
const mutationOf = <I, O = Row>(hook: { current: unknown }) => (hook.current as { mutationFn: MutationFn<I, O> }).mutationFn;

const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);
const marker = (namespace: string, organizationId: string, id: string) => seedLegacyPending({ namespace, userId: 'actor', organizationId, businessKey: id }, TEN_MINUTES_AGO());
const rowOf = (table: string, id: string) => (io.server.rows[table] ?? []).find(row => row.id === id);
const incomeDefaults = () => io.server.rows.income_expense_templates.filter(row => row.is_income_template === true && row.is_default === true && !row.deleted_at).map(row => row.id);

beforeEach(() => {
  io.server = fakeRecordServer();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  io.server.rows.income_expense_types = [{ id: 't1', organization_id: 'org-a', user_id: 'actor', name: 'Điện', type: 'expense' }];
  io.server.rows.income_expense_items = [];
  io.server.rows.income_expense_templates = [
    { id: 'm1', user_id: 'actor', name: 'Mẫu thu A', is_income_template: true, is_default: true, deleted_at: null },
    { id: 'm2', user_id: 'actor', name: 'Mẫu thu B', is_income_template: true, is_default: false, deleted_at: null },
    { id: 'm3', user_id: 'actor', name: 'Mẫu chi', is_income_template: false, is_default: true, deleted_at: null },
  ];
});

describe('sửa loại thu chi (income-expense-type-update)', () => {
  const save = () => mutationOf<{ id: string; updates: Row }>(renderHook(() => useUpdateIncomeExpenseType()).result);

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại ghi được', async () => {
    const mutate = save();
    io.server.failNext('income_expense_types', 'update', 'drop-before');
    await expect(mutate({ id: 't1', updates: { name: 'Điện mới' } })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    expect(rowOf('income_expense_types', 't1')?.name).toBe('Điện');
    await expect(mutate({ id: 't1', updates: { name: 'Điện mới' } })).resolves.toMatchObject({ id: 't1', name: 'Điện mới' });
  });

  it('tới nhưng mất phản hồi: bấm lại ghi lại đúng nội dung đó, một loại', async () => {
    const mutate = save();
    io.server.failNext('income_expense_types', 'update', 'drop-after');
    await expect(mutate({ id: 't1', updates: { name: 'Điện mới' } })).rejects.toMatchObject({ outcome: 'unknown', message: expect.stringContaining('Bấm lại') });
    expect(pendingKeys()).toEqual([]);
    await expect(mutate({ id: 't1', updates: { name: 'Điện mới' } })).resolves.toMatchObject({ id: 't1', name: 'Điện mới' });
    expect(io.server.rows.income_expense_types).toHaveLength(1);
  });

  it('dấu bản trước của đúng loại (≥ 10 phút) không chặn; lưu xong dấu được gỡ', async () => {
    marker('income-expense-type-update', 'org-a', 't1');
    await expect(save()({ id: 't1', updates: { name: 'Điện mới' } })).resolves.toMatchObject({ name: 'Điện mới' });
    expect(pendingKeys()).toEqual([]);
  });

  it('khớp 0 dòng (RLS không cho sửa): từ chối rõ, không phải «chưa rõ», không dấu', async () => {
    io.server.writable.income_expense_types = () => false;
    const error = await save()({ id: 't1', updates: { name: 'Điện mới' } }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'PGRST116' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('xoá loại thu chi (income-expense-type-delete)', () => {
  const remove = () => mutationOf<string>(renderHook(() => useDeleteIncomeExpenseType()).result);

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại xoá được', async () => {
    const mutate = remove();
    io.server.failNext('income_expense_types', 'delete', 'drop-before');
    await expect(mutate('t1')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    expect(rowOf('income_expense_types', 't1')).toBeDefined();
    await expect(mutate('t1')).resolves.toMatchObject({ id: 't1' });
    expect(rowOf('income_expense_types', 't1')).toBeUndefined();
  });

  it('tới nhưng mất phản hồi: bấm lại khớp 0 dòng, đọc lại không còn ⇒ báo đã xoá trước đó', async () => {
    const mutate = remove();
    io.server.failNext('income_expense_types', 'delete', 'drop-after');
    await expect(mutate('t1')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(rowOf('income_expense_types', 't1')).toBeUndefined();
    await expect(mutate('t1')).resolves.toMatchObject({ id: 't1', alreadyDeleted: true });
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước của đúng loại (≥ 10 phút) không chặn; xoá xong dấu được gỡ', async () => {
    marker('income-expense-type-delete', 'org-a', 't1');
    await expect(remove()('t1')).resolves.toMatchObject({ id: 't1' });
    expect(pendingKeys()).toEqual([]);
  });

  it('khớp 0 dòng vì RLS không cho xoá (loại còn nguyên): báo không có quyền, không phải «đã xoá»', async () => {
    io.server.writable.income_expense_types = () => false;
    await expect(remove()('t1')).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('quyền') });
    expect(rowOf('income_expense_types', 't1')).toBeDefined();
    expect(pendingKeys()).toEqual([]);
  });

  it('loại đang có phiếu dùng: vẫn chặn xoá như cũ', async () => {
    io.server.rows.income_expense_items = [{ id: 'i1', income_expense_type_id: 't1' }];
    await expect(remove()('t1')).rejects.toThrow('đang được sử dụng');
    expect(rowOf('income_expense_types', 't1')).toBeDefined();
  });
});

describe('sửa mẫu in thu chi (income-expense-template-update)', () => {
  const save = () => mutationOf<{ id: string; updates: Row }>(renderHook(() => useUpdateIncomeExpenseTemplate()).result);

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại ghi được', async () => {
    const mutate = save();
    io.server.failNext('income_expense_templates', 'update', 'drop-before');
    await expect(mutate({ id: 'm2', updates: { name: 'Mẫu mới' } })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    expect(rowOf('income_expense_templates', 'm2')?.name).toBe('Mẫu thu B');
    await expect(mutate({ id: 'm2', updates: { name: 'Mẫu mới' } })).resolves.toMatchObject({ id: 'm2', name: 'Mẫu mới' });
  });

  it('tới nhưng mất phản hồi: bấm lại ghi lại đúng nội dung đó', async () => {
    const mutate = save();
    io.server.failNext('income_expense_templates', 'update', 'drop-after');
    await expect(mutate({ id: 'm2', updates: { name: 'Mẫu mới' } })).rejects.toMatchObject({ outcome: 'unknown', message: expect.stringContaining('Bấm lại') });
    expect(pendingKeys()).toEqual([]);
    await expect(mutate({ id: 'm2', updates: { name: 'Mẫu mới' } })).resolves.toMatchObject({ id: 'm2', name: 'Mẫu mới' });
    expect(io.server.rows.income_expense_templates).toHaveLength(3);
  });

  it('dấu bản trước của đúng mẫu (≥ 10 phút) không chặn; lưu xong dấu được gỡ', async () => {
    marker('income-expense-template-update', 'org-a', 'm2');
    await expect(save()({ id: 'm2', updates: { name: 'Mẫu mới' } })).resolves.toMatchObject({ name: 'Mẫu mới' });
    expect(pendingKeys()).toEqual([]);
  });

  it('khớp 0 dòng (RLS không cho sửa): từ chối rõ, không phải «chưa rõ»', async () => {
    io.server.writable.income_expense_templates = () => false;
    const error = await save()({ id: 'm2', updates: { name: 'Mẫu mới' } }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'PGRST116' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('xoá mẫu in thu chi (income-expense-template-delete, xoá mềm)', () => {
  const remove = () => mutationOf<string>(renderHook(() => useDeleteIncomeExpenseTemplate()).result);

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại xoá được', async () => {
    const mutate = remove();
    io.server.failNext('income_expense_templates', 'update', 'drop-before');
    await expect(mutate('m2')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    expect(rowOf('income_expense_templates', 'm2')?.deleted_at).toBeNull();
    await expect(mutate('m2')).resolves.toMatchObject({ id: 'm2' });
    expect(rowOf('income_expense_templates', 'm2')?.deleted_at).toEqual(expect.any(String));
  });

  it('tới nhưng mất phản hồi: bấm lại đọc thấy đã xoá ⇒ thành công, giữ giờ xoá cũ', async () => {
    const mutate = remove();
    io.server.failNext('income_expense_templates', 'update', 'drop-after');
    await expect(mutate('m2')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    const deletedAt = rowOf('income_expense_templates', 'm2')?.deleted_at;
    expect(deletedAt).toEqual(expect.any(String));
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(mutate('m2')).resolves.toMatchObject({ id: 'm2', alreadyDeleted: true });
    expect(rowOf('income_expense_templates', 'm2')?.deleted_at).toBe(deletedAt);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước của đúng mẫu (≥ 10 phút) không chặn; xoá xong dấu được gỡ', async () => {
    marker('income-expense-template-delete', 'org-a', 'm2');
    await expect(remove()('m2')).resolves.toMatchObject({ id: 'm2' });
    expect(pendingKeys()).toEqual([]);
  });

  it('mẫu đã xoá trước đó (khớp 0 dòng): báo thành công «đã xoá trước đó»', async () => {
    io.server.rows.income_expense_templates[1].deleted_at = '2026-11-20T01:00:00.000Z';
    await expect(remove()('m2')).resolves.toMatchObject({ id: 'm2', alreadyDeleted: true });
    expect(rowOf('income_expense_templates', 'm2')?.deleted_at).toBe('2026-11-20T01:00:00.000Z');
  });

  it('khớp 0 dòng vì RLS không cho xoá (mẫu còn nguyên): báo không có quyền', async () => {
    io.server.writable.income_expense_templates = () => false;
    await expect(remove()('m2')).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('quyền') });
    expect(rowOf('income_expense_templates', 'm2')?.deleted_at).toBeNull();
    expect(pendingKeys()).toEqual([]);
  });
});

describe('đặt mẫu in mặc định (income-expense-template-default)', () => {
  type Toggle = { id: string; is_default: boolean; is_income_template: boolean };
  const toggle = () => mutationOf<Toggle, Row & { unchanged?: boolean }>(renderHook(() => useToggleDefaultTemplate()).result);

  it('lệnh bỏ mặc định cũ không tới máy chủ: báo rõ, không dấu, bấm lại ra đúng một mẫu mặc định', async () => {
    const mutate = toggle();
    io.server.failNext('income_expense_templates', 'update', 'drop-before');
    await expect(mutate({ id: 'm2', is_default: true, is_income_template: true })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    expect(incomeDefaults()).toEqual(['m1']);
    await expect(mutate({ id: 'm2', is_default: true, is_income_template: true })).resolves.toMatchObject({ id: 'm2', is_default: true });
    expect(incomeDefaults()).toEqual(['m2']);
    // Nhóm mẫu chi không bị đụng.
    expect(rowOf('income_expense_templates', 'm3')?.is_default).toBe(true);
  });

  it('bỏ mặc định cũ xong mà mất phản hồi (dở dang): bấm lại chạy nốt, đúng một mẫu mặc định', async () => {
    const mutate = toggle();
    io.server.failNext('income_expense_templates', 'update', 'drop-after');
    await expect(mutate({ id: 'm2', is_default: true, is_income_template: true })).rejects.toMatchObject({ outcome: 'unknown', message: expect.stringContaining('Bấm lại') });
    expect(incomeDefaults()).toEqual([]);
    expect(pendingKeys()).toEqual([]);
    await expect(mutate({ id: 'm2', is_default: true, is_income_template: true })).resolves.toMatchObject({ id: 'm2', is_default: true });
    expect(incomeDefaults()).toEqual(['m2']);
  });

  it('đặt mặc định đã tới mà mất phản hồi: bấm lại thấy đã đúng, không ghi thêm, đúng một mẫu mặc định', async () => {
    io.server.rows.income_expense_templates[0].is_default = false;
    const mutate = toggle();
    io.server.failNext('income_expense_templates', 'update', 'drop-after');
    await expect(mutate({ id: 'm2', is_default: true, is_income_template: true })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(incomeDefaults()).toEqual(['m2']);
    await expect(mutate({ id: 'm2', is_default: true, is_income_template: true })).resolves.toMatchObject({ id: 'm2', unchanged: true });
    expect(incomeDefaults()).toEqual(['m2']);
  });

  it('bỏ chọn mặc định mất phản hồi: bấm lại vẫn bỏ chọn (không đảo lại)', async () => {
    const mutate = toggle();
    io.server.failNext('income_expense_templates', 'update', 'drop-after');
    await expect(mutate({ id: 'm1', is_default: false, is_income_template: true })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    await expect(mutate({ id: 'm1', is_default: false, is_income_template: true })).resolves.toMatchObject({ id: 'm1', is_default: false });
    expect(incomeDefaults()).toEqual([]);
  });

  it('dấu bản trước của nhóm mẫu (≥ 10 phút, không tên thao tác) không chặn; đặt xong dấu được gỡ', async () => {
    marker('income-expense-template-default', 'actor-scope', 'default:true');
    await expect(toggle()({ id: 'm2', is_default: true, is_income_template: true })).resolves.toMatchObject({ id: 'm2', is_default: true });
    expect(incomeDefaults()).toEqual(['m2']);
    expect(pendingKeys()).toEqual([]);
  });

  it('mẫu đích đã bị xoá: báo rõ, không bỏ chọn mẫu mặc định đang có, không khoá', async () => {
    io.server.rows.income_expense_templates[1].deleted_at = '2026-11-20T01:00:00.000Z';
    const error = await toggle()({ id: 'm2', is_default: true, is_income_template: true }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ outcome: 'failure', message: expect.stringContaining('m2') });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(incomeDefaults()).toEqual(['m1']);
    expect(pendingKeys()).toEqual([]);
  });

  it('mẫu đích bị xoá giữa chừng (sau khi bỏ mặc định cũ): báo rõ mẫu nào đã bị bỏ chọn, không khoá', async () => {
    const realFrom = io.server.from;
    let updates = 0;
    io.server.from = (table: string) => {
      const query = realFrom(table) as { update: (value: Row) => unknown };
      const update = query.update;
      query.update = (value: Row) => {
        updates += 1;
        // Người khác xoá mẫu đích đúng lúc lệnh thứ hai (đặt mặc định) sắp chạy.
        if (table === 'income_expense_templates' && updates === 2) io.server.rows.income_expense_templates[1].deleted_at = '2026-11-20T01:00:00.000Z';
        return update(value);
      };
      return query;
    };
    const error = await toggle()({ id: 'm2', is_default: true, is_income_template: true }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ outcome: 'failure', message: expect.stringMatching(/m1[\s\S]*m2|m2[\s\S]*m1/) });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(incomeDefaults()).toEqual([]);
    expect(pendingKeys()).toEqual([]);
  });

  it('nhóm mẫu đọc hỏng trước khi ghi: không ghi gì, không dấu, bấm lại được', async () => {
    io.server.failNext('income_expense_templates', 'read', 'drop-before');
    await expect(toggle()({ id: 'm2', is_default: true, is_income_template: true })).rejects.toThrow();
    expect(incomeDefaults()).toEqual(['m1']);
    expect(pendingKeys()).toEqual([]);
    await expect(toggle()({ id: 'm2', is_default: true, is_income_template: true })).resolves.toMatchObject({ id: 'm2', is_default: true });
  });
});

describe('ngưỡng tự duyệt phiếu chi (auto-approve-threshold)', () => {
  let saved: { threshold: unknown; calls: number };
  beforeEach(() => {
    saved = { threshold: 50, calls: 0 };
    io.server.rpcHandlers.set_ie_auto_approve_threshold_v1 = args => {
      saved.calls += 1;
      saved.threshold = args.p_threshold;
      return { data: { organization_id: 'org-a', threshold: args.p_threshold }, error: null };
    };
  });
  const setThreshold = () => renderHook(() => useSetIeAutoApproveThreshold()).result.current;

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại lưu được', async () => {
    const save = setThreshold();
    io.server.failNext('set_ie_auto_approve_threshold_v1', 'rpc', 'drop-before');
    await expect(save(100)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    expect(saved.threshold).toBe(50);
    await expect(save(100)).resolves.toBeUndefined();
    expect(saved.threshold).toBe(100);
  });

  it('tới nhưng mất phản hồi: bấm lại đặt lại đúng giá trị đó (đặt tuyệt đối, không cộng dồn)', async () => {
    const save = setThreshold();
    io.server.failNext('set_ie_auto_approve_threshold_v1', 'rpc', 'drop-after');
    await expect(save(100)).rejects.toMatchObject({ outcome: 'unknown', message: expect.stringContaining('Bấm lại') });
    expect(saved.threshold).toBe(100);
    expect(pendingKeys()).toEqual([]);
    await expect(save(100)).resolves.toBeUndefined();
    expect(saved).toEqual({ threshold: 100, calls: 2 });
  });

  it('dấu bản trước (≥ 10 phút, không tên thao tác) không chặn; lưu xong dấu được gỡ', async () => {
    marker('auto-approve-threshold', 'actor-scope', 'settings');
    await expect(setThreshold()(null)).resolves.toBeUndefined();
    expect(saved.threshold).toBeNull();
    expect(pendingKeys()).toEqual([]);
  });

  it.each([
    ['ngưỡng khác', { organization_id: 'org-a', threshold: 200 }],
    ['thiếu công ty', { threshold: 100 }],
    ['không có biên nhận', null],
  ])('biên nhận %s: không báo đã lưu, cho bấm lại', async (_label, receipt) => {
    io.server.rpcHandlers.set_ie_auto_approve_threshold_v1 = () => ({ data: receipt, error: null });
    await expect(setThreshold()(100)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });

  it('máy chủ từ chối rõ (không phải chủ sở hữu): lời từ chối đi nguyên, không dấu', async () => {
    io.server.rpcHandlers.set_ie_auto_approve_threshold_v1 = () => ({ data: null, error: { code: '42501', message: 'Chỉ Chủ sở hữu tổ chức được đặt ngưỡng tự duyệt' } });
    const error = await setThreshold()(100).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: '42501' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });
});
