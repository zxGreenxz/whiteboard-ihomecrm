// @vitest-environment jsdom
// Đợt 4: tạo khách không còn khoá chung. Mỗi lần tạo mang mã khách do trình duyệt sinh; gửi lại dùng đúng mã đó nên
// máy chủ (khoá chính) không cho ra khách thứ hai. Một lần kẹt chỉ liên quan đúng khách đó.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), rpc: (name: string, args: Record<string, unknown>) => io.server.rpc(name, args) } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useCreateCustomer } from '../useCustomers';

// Bộ nhớ «lần tạo chưa rõ kết quả» sống theo tab; mỗi test bắt đầu sạch. Nạp động để tệp test chạy được cả trên
// mã trước đợt 4 (chưa có module này) khi kiểm test đỏ trước khi sửa.
const memoryModule = '@/lib/clientRecordCreate';
async function forgetMemory() {
  const memory = await import(/* @vite-ignore */ memoryModule).catch(() => null) as { forgetUnconfirmedCreates?: () => void } | null;
  memory?.forgetUnconfirmedCreates?.();
}

type CreateFn = (input: Record<string, unknown>) => Promise<{ customer: { id: string; full_name?: string }; vehicleError?: unknown; replayed?: boolean }>;
const create = (): CreateFn => {
  const { result } = renderHook(() => useCreateCustomer());
  return (result.current as unknown as { mutationFn: CreateFn }).mutationFn;
};
const an = { full_name: 'Khách An', phone: '0900000001' };
const binh = { full_name: 'Khách Bình', phone: '0900000002' };
const customerInserts = () => io.server.inserts.filter(item => item.table === 'customers').map(item => item.payload as Record<string, unknown>);

beforeEach(async () => {
  io.server = fakeRecordServer();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  await forgetMemory();
});

describe('tạo khách: lệnh không tới máy chủ', () => {
  it('lần đầu báo chưa xác nhận; bấm lại gửi ĐÚNG mã cũ và chỉ ra một khách, không để dấu nào', async () => {
    const mutate = create();
    io.server.failNext('customers', 'insert', 'drop-before');
    io.server.failNext('customers', 'read', 'drop-before');
    await expect(mutate(an)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(pendingKeys()).toEqual([]);
    const result = await mutate(an);
    expect(result.customer.full_name).toBe('Khách An');
    const [first, second] = customerInserts();
    expect(typeof first.id).toBe('string');
    expect(second.id).toBe(first.id);
    expect(io.server.rows.customers).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('đóng rồi mở lại hộp (hook mới) vẫn gửi lại cùng mã cho cùng khách', async () => {
    io.server.failNext('customers', 'insert', 'drop-before');
    io.server.failNext('customers', 'read', 'drop-before');
    await expect(create()(an)).rejects.toMatchObject({ outcome: 'unknown' });
    await create()(an);
    const [first, second] = customerInserts();
    expect(second.id).toBe(first.id);
    expect(io.server.rows.customers).toHaveLength(1);
  });
});

describe('tạo khách: lệnh tới nhưng mất phản hồi', () => {
  it('đọc lại đúng mã ngay trong lượt đó: khách đã có thì báo đã tạo, không gửi lần hai', async () => {
    io.server.failNext('customers', 'insert', 'drop-after');
    const result = await create()(an);
    expect(result.customer.full_name).toBe('Khách An');
    expect(customerInserts()).toHaveLength(1);
    expect(io.server.rows.customers).toHaveLength(1);
  });

  it('đọc lại cũng hỏng: bấm lại gặp trùng mã, đọc đúng mã rồi trả khách lần trước, vẫn một khách', async () => {
    const mutate = create();
    io.server.failNext('customers', 'insert', 'drop-after');
    io.server.failNext('customers', 'read', 'drop-before');
    await expect(mutate(an)).rejects.toMatchObject({ outcome: 'unknown' });
    const result = await mutate(an);
    expect(result.customer.id).toBe(customerInserts()[0].id);
    expect(result.replayed).toBe(true);
    expect(io.server.rows.customers).toHaveLength(1);
  });

  it('sửa thông tin giữa hai lần: không tạo khách thứ hai, báo khách lần trước kèm mã', async () => {
    const mutate = create();
    io.server.failNext('customers', 'insert', 'drop-after');
    io.server.failNext('customers', 'read', 'drop-before');
    await expect(mutate(an)).rejects.toMatchObject({ outcome: 'unknown' });
    const firstId = String(customerInserts()[0].id);
    await expect(mutate({ ...an, full_name: 'Khách An Nguyễn' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining(firstId) });
    expect(io.server.rows.customers).toHaveLength(1);
    // Đã báo xong: lần bấm sau là lượt mới của người dùng.
    await mutate({ ...an, full_name: 'Khách An Nguyễn' });
    expect(io.server.rows.customers).toHaveLength(2);
  });
});

describe('tạo khách: dấu khoá chung của bản trước còn trong trình duyệt', () => {
  const legacyScope = { namespace: 'customer-create', userId: 'actor', organizationId: 'org-a', businessKey: 'create' };

  it('dấu cũ không có tên thao tác không chặn tạo khách khác; dấu được gỡ', async () => {
    const key = seedLegacyPending(legacyScope, new Date(Date.now() - 10 * 60_000));
    const result = await create()(binh);
    expect(result.customer.full_name).toBe('Khách Bình');
    expect(io.server.rows.customers).toHaveLength(1);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('khách giống khách đã tạo quanh giờ kẹt: báo có thể đã tạo kèm mã, không tạo; bấm lại thì tạo', async () => {
    const stuckAt = new Date(Date.now() - 10 * 60_000);
    io.server.rows.customers = [{ id: 'c-old', user_id: 'actor', organization_id: 'org-a', full_name: 'Khách An', phone: '0900000001', created_at: new Date(stuckAt.getTime() + 2_000).toISOString() }];
    const key = seedLegacyPending(legacyScope, stuckAt);
    await expect(create()(an)).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('c-old') });
    expect(customerInserts()).toHaveLength(0);
    expect(localStorage.getItem(key)).toBeNull();
    await create()(an);
    expect(io.server.rows.customers).toHaveLength(2);
  });

  it('dấu cũ chưa đủ 2 phút (lượt cũ có thể còn chạy ở tab mở bản trước): không chặn, không gỡ, không tra', async () => {
    const key = seedLegacyPending(legacyScope, new Date(Date.now() - 30_000));
    await create()(binh);
    expect(io.server.rows.customers).toHaveLength(1);
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it('dấu cũ mang sẵn mã khách (lưu xe hỏng ở bản trước) cũng chỉ báo khi đúng khách đó', async () => {
    const stuckAt = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    io.server.rows.customers = [{ id: 'c-partial', user_id: 'actor', organization_id: 'org-a', full_name: 'Khách An', phone: '0900000001', created_at: stuckAt.toISOString() }];
    seedLegacyPending(legacyScope, stuckAt, ['c-partial']);
    await expect(create()(an)).rejects.toMatchObject({ message: expect.stringContaining('c-partial') });
  });
});

describe('tạo khách: một khách kẹt không chặn khách khác', () => {
  it('An chưa rõ kết quả; Bình vẫn tạo được ngay với mã riêng; An gửi lại đúng mã cũ', async () => {
    const mutate = create();
    io.server.failNext('customers', 'insert', 'drop-before');
    io.server.failNext('customers', 'read', 'drop-before');
    await expect(mutate(an)).rejects.toMatchObject({ outcome: 'unknown' });
    await mutate(binh);
    await mutate(an);
    const [anFirst, binhInsert, anRetry] = customerInserts();
    expect(binhInsert.id).not.toBe(anFirst.id);
    expect(anRetry.id).toBe(anFirst.id);
    expect(io.server.rows.customers?.map(row => row.full_name).sort()).toEqual(['Khách An', 'Khách Bình']);
  });
});

describe('tạo khách: bước lưu xe', () => {
  it('xe hỏng: khách đã tạo, báo chưa lưu được xe, không giữ dấu; lần tạo khách sau không bị chặn', async () => {
    io.server.failNext('vehicles', 'insert', 'drop-before');
    const result = await create()({ ...an, vehicles: [{ vehicle_type: 'MOTORBIKE', vehicle_name: 'Wave', license_plate: '59A1' }] });
    expect(result.customer.full_name).toBe('Khách An');
    expect(result.vehicleError).toBeTruthy();
    expect(pendingKeys()).toEqual([]);
    await create()(binh);
    expect(io.server.rows.customers).toHaveLength(2);
  });

  it('khách tạo ở lần trước (mất phản hồi) thì lần gửi lại lưu xe cho đúng khách đó', async () => {
    const mutate = create();
    const input = { ...an, vehicles: [{ vehicle_type: 'MOTORBIKE', vehicle_name: 'Wave', license_plate: '59A1' }] };
    io.server.failNext('customers', 'insert', 'drop-after');
    io.server.failNext('customers', 'read', 'drop-before');
    await expect(mutate(input)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(io.server.rows.vehicles ?? []).toHaveLength(0);
    const result = await mutate(input);
    expect(io.server.rows.vehicles).toHaveLength(1);
    expect(io.server.rows.vehicles?.[0].customer_id).toBe(result.customer.id);
  });
});
