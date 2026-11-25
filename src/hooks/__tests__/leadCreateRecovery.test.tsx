// @vitest-environment jsdom
// Đợt 4: tạo khách hẹn như tạo khách: mã do trình duyệt sinh, gửi lại đúng mã, không khoá chung.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table) } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useCreateLead } from '../useLeads';

const memoryModule = '@/lib/clientRecordCreate';
async function forgetMemory() {
  const memory = await import(/* @vite-ignore */ memoryModule).catch(() => null) as { forgetUnconfirmedCreates?: () => void } | null;
  memory?.forgetUnconfirmedCreates?.();
}

type CreateFn = (input: Record<string, unknown>) => Promise<{ id: string; customer_name?: string }>;
const create = (): CreateFn => {
  const { result } = renderHook(() => useCreateLead());
  return (result.current as unknown as { mutationFn: CreateFn }).mutationFn;
};
const an = { customer_name: 'Khách hẹn An', phone: '0900000011' };
const binh = { customer_name: 'Khách hẹn Bình', phone: '0900000012' };
const leadInserts = () => io.server.inserts.filter(item => item.table === 'leads').map(item => item.payload as Record<string, unknown>);

beforeEach(async () => {
  io.server = fakeRecordServer();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  await forgetMemory();
});

describe('tạo khách hẹn', () => {
  it('lệnh không tới máy chủ: bấm lại gửi đúng mã cũ, một khách hẹn, không dấu', async () => {
    const mutate = create();
    io.server.failNext('leads', 'insert', 'drop-before');
    io.server.failNext('leads', 'read', 'drop-before');
    await expect(mutate(an)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(pendingKeys()).toEqual([]);
    const lead = await mutate(an);
    expect(lead.customer_name).toBe('Khách hẹn An');
    const [first, second] = leadInserts();
    expect(second.id).toBe(first.id);
    expect(io.server.rows.leads).toHaveLength(1);
  });

  it('lệnh tới nhưng mất phản hồi: đọc đúng mã thấy khách hẹn, không gửi lần hai', async () => {
    io.server.failNext('leads', 'insert', 'drop-after');
    const lead = await create()(an);
    expect(lead.id).toBe(leadInserts()[0].id);
    expect(leadInserts()).toHaveLength(1);
    expect(io.server.rows.leads).toHaveLength(1);
  });

  it('mất phản hồi và đọc lại cũng hỏng: bấm lại gặp trùng mã, trả đúng khách hẹn lần trước', async () => {
    const mutate = create();
    io.server.failNext('leads', 'insert', 'drop-after');
    io.server.failNext('leads', 'read', 'drop-before');
    await expect(mutate(an)).rejects.toMatchObject({ outcome: 'unknown' });
    const lead = await mutate(an);
    expect(lead.id).toBe(leadInserts()[0].id);
    expect(io.server.rows.leads).toHaveLength(1);
  });

  it('sửa SĐT giữa hai lần (lần trước đã ghi): không tạo khách hẹn thứ hai, báo mã', async () => {
    const mutate = create();
    io.server.failNext('leads', 'insert', 'drop-after');
    io.server.failNext('leads', 'read', 'drop-before');
    await expect(mutate(an)).rejects.toMatchObject({ outcome: 'unknown' });
    const firstId = String(leadInserts()[0].id);
    await expect(mutate({ ...an, phone: '0911111111' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining(firstId) });
    expect(io.server.rows.leads).toHaveLength(1);
  });

  it('dấu khoá chung của bản trước (không tên thao tác) không chặn; dấu được gỡ', async () => {
    const key = seedLegacyPending({ namespace: 'useCreateLead', userId: 'actor', organizationId: 'org-a', businessKey: 'create' }, new Date(Date.now() - 10 * 60_000));
    await create()(binh);
    expect(io.server.rows.leads).toHaveLength(1);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('dấu cũ và khách hẹn giống khách hẹn tạo quanh giờ kẹt: báo có thể đã tạo kèm mã, không tạo', async () => {
    const stuckAt = new Date(Date.now() - 10 * 60_000);
    io.server.rows.leads = [{ id: 'l-old', user_id: 'actor', organization_id: 'org-a', customer_name: 'Khách hẹn An', phone: '0900000011', created_at: stuckAt.toISOString() }];
    seedLegacyPending({ namespace: 'useCreateLead', userId: 'actor', organizationId: 'org-a', businessKey: 'create' }, stuckAt);
    await expect(create()(an)).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('l-old') });
    expect(leadInserts()).toHaveLength(0);
  });

  it('một khách hẹn kẹt không chặn khách hẹn khác', async () => {
    const mutate = create();
    io.server.failNext('leads', 'insert', 'drop-before');
    io.server.failNext('leads', 'read', 'drop-before');
    await expect(mutate(an)).rejects.toMatchObject({ outcome: 'unknown' });
    await mutate(binh);
    await mutate(an);
    const [anFirst, binhInsert, anRetry] = leadInserts();
    expect(binhInsert.id).not.toBe(anFirst.id);
    expect(anRetry.id).toBe(anFirst.id);
    expect(io.server.rows.leads).toHaveLength(2);
  });
});
