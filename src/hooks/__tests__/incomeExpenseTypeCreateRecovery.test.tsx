// @vitest-environment jsdom
// Đợt 4: tạo loại thu chi (cách D). Production có ràng buộc duy nhất `income_expense_types_org_side_normalized_name_uq`
// (công ty, chiều thu/chi, tên đã chuẩn hoá) nên không thể có hai loại cùng tên: không cần khoá, tên trùng thì trả loại đã có.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), rpc: vi.fn() } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/lib/ieTypesCache', () => ({ invalidateIeTypesCache: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useCreateIncomeExpenseType } from '../useIncomeExpenseTypes';

type CreateFn = (input: { name: string; type: 'income' | 'expense'; category?: string | null }) => Promise<{ id: string; name: string; existed?: boolean }>;
const create = (): CreateFn => {
  const { result } = renderHook(() => useCreateIncomeExpenseType());
  return (result.current as unknown as { mutationFn: CreateFn }).mutationFn;
};
// Cùng cách chuẩn hoá với `normalize_income_expense_type_name` của production (bỏ dấu, chữ thường, đ→d, gộp khoảng trắng).
const normalized = (name: unknown) => String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd').trim().replace(/\s+/g, ' ');
const typeInserts = () => io.server.inserts.filter(item => item.table === 'income_expense_types');

beforeEach(() => {
  io.server = fakeRecordServer();
  io.server.uniqueBy.income_expense_types = row => `${row.organization_id}|${String(row.type).trim().toLowerCase()}|${normalized(row.name)}`;
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
});

describe('tạo loại thu chi', () => {
  it('lệnh không tới máy chủ: báo chưa xác nhận, không khoá; bấm lại tạo được, một loại', async () => {
    const mutate = create();
    io.server.failNext('income_expense_types', 'insert', 'drop-before');
    await expect(mutate({ name: 'Vệ sinh', type: 'expense' })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(pendingKeys()).toEqual([]);
    const created = await mutate({ name: 'Vệ sinh', type: 'expense' });
    expect(created.name).toBe('Vệ sinh');
    expect(io.server.rows.income_expense_types).toHaveLength(1);
  });

  it('lệnh tới nhưng mất phản hồi: tra theo tên chuẩn hoá thấy loại vừa tạo, trả loại đó, không gửi lần hai', async () => {
    io.server.failNext('income_expense_types', 'insert', 'drop-after');
    const created = await create()({ name: 'Vệ sinh', type: 'expense' });
    expect(created.name).toBe('Vệ sinh');
    expect(typeInserts()).toHaveLength(1);
    expect(io.server.rows.income_expense_types).toHaveLength(1);
  });

  it('mất phản hồi, tra lại cũng hỏng: bấm lại gặp ràng buộc tên, trả đúng loại lần trước', async () => {
    const mutate = create();
    io.server.failNext('income_expense_types', 'insert', 'drop-after');
    io.server.failNext('income_expense_types', 'read', 'drop-before');
    await expect(mutate({ name: 'Vệ sinh', type: 'expense' })).rejects.toMatchObject({ outcome: 'unknown' });
    const firstId = io.server.rows.income_expense_types[0].id;
    const again = await mutate({ name: 'Vệ sinh', type: 'expense' });
    expect(again.id).toBe(firstId);
    expect(io.server.rows.income_expense_types).toHaveLength(1);
  });

  it('dấu khoá chung của bản trước (không tên thao tác) không chặn; dấu được gỡ', async () => {
    const key = seedLegacyPending({ namespace: 'income-expense-type-create', userId: 'actor', organizationId: 'org-a', businessKey: 'create' }, new Date(Date.now() - 10 * 60_000));
    await create()({ name: 'Điện nước', type: 'expense' });
    expect(io.server.rows.income_expense_types).toHaveLength(1);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('một loại kẹt không chặn loại khác', async () => {
    const mutate = create();
    io.server.failNext('income_expense_types', 'insert', 'drop-before');
    io.server.failNext('income_expense_types', 'read', 'drop-before');
    await expect(mutate({ name: 'Vệ sinh', type: 'expense' })).rejects.toMatchObject({ outcome: 'unknown' });
    await mutate({ name: 'Sửa chữa', type: 'expense' });
    expect(io.server.rows.income_expense_types).toHaveLength(1);
  });

  it('tên đã có trong công ty (khác hoa thường, dấu, khoảng trắng): trả loại đã có, không tạo thêm', async () => {
    io.server.rows.income_expense_types = [{ id: 't-old', organization_id: 'org-a', type: 'expense', name: 'Vệ Sinh  Phòng' }];
    const existing = await create()({ name: 've sinh phong', type: 'expense' });
    expect(existing).toMatchObject({ id: 't-old', existed: true });
    expect(io.server.rows.income_expense_types).toHaveLength(1);
  });

  it('tên trùng loại đã lưu trữ: báo rõ, không trả loại đó để dùng', async () => {
    io.server.rows.income_expense_types = [{ id: 't-arch', organization_id: 'org-a', type: 'expense', name: 'Vệ sinh', archived_at: '2026-10-01T00:00:00Z' }];
    await expect(create()({ name: 'Vệ sinh', type: 'expense' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('lưu trữ') });
  });

  it('tên trùng nhưng không đọc thấy loại đó (hạng mục hạn chế của người khác): báo trùng tên, không coi là chưa rõ', async () => {
    io.server.rows.income_expense_types = [{ id: 't-hidden', organization_id: 'org-a', type: 'expense', name: 'Lương', is_restricted: true }];
    // Máy chủ giả: chèn bị chặn theo tên, nhưng dòng đó không đọc được (RLS hạng mục hạn chế).
    io.server.visible.income_expense_types = row => !row.is_restricted;
    await expect(create()({ name: 'Lương', type: 'expense' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('đã có') });
  });

  it('cùng tên khác chiều thu/chi thì tạo được', async () => {
    io.server.rows.income_expense_types = [{ id: 't-old', organization_id: 'org-a', type: 'expense', name: 'Cọc' }];
    const created = await create()({ name: 'Cọc', type: 'income' });
    expect(created.id).not.toBe('t-old');
    expect(io.server.rows.income_expense_types).toHaveLength(2);
  });
});
