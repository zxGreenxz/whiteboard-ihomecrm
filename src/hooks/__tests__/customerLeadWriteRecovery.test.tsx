// @vitest-environment jsdom
// Đợt 8 (luật 5), nhóm khách và khách hẹn: sửa / xoá khách, sửa / xoá khách hẹn, thêm / xoá hoạt động khách hẹn ghi
// lặp lại được nên không giữ dấu «chờ đối chiếu» nào. Mỗi thao tác chịu ba kiểu sự cố: lệnh không tới máy chủ, tới mà
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
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useDeleteCustomer, useUpdateCustomer } from '../useCustomers';
import { useDeleteLead, useUpdateLead } from '../useLeads';
import { useCreateLeadActivity, useDeleteLeadActivity } from '../useLeadActivities';

type Row = Record<string, unknown>;
type MutationFn<I, O = Row> = (input: I) => Promise<O>;
const mutationOf = <I, O = Row>(hook: { current: unknown }) => (hook.current as { mutationFn: MutationFn<I, O> }).mutationFn;

const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);
const marker = (namespace: string, organizationId: string, id: string) => seedLegacyPending({ namespace, userId: 'actor', organizationId, businessKey: id }, TEN_MINUTES_AGO());
const rowOf = (table: string, id: string) => (io.server.rows[table] ?? []).find(row => row.id === id);

beforeEach(() => {
  io.server = fakeRecordServer();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  io.server.rows.customers = [{ id: 'c1', organization_id: 'org-a', user_id: 'actor', full_name: 'An', phone: '0900000001', deleted_at: null }];
  io.server.rows.vehicles = [{ id: 'v-old', organization_id: 'org-a', customer_id: 'c1', vehicle_type: 'MOTORBIKE', vehicle_name: 'Wave', color: null, license_plate: '59A1-111.11', deleted_at: null }];
  io.server.rows.contract_customers = [];
  io.server.rows.contracts = [];
  io.server.rows.leads = [{ id: 'l1', organization_id: 'org-a', user_id: 'actor', customer_name: 'Khách hẹn An', phone: '0900000011', status: 'B1_LEAD', deleted_at: null }];
  io.server.rows.lead_activities = [{ id: 'a1', organization_id: 'org-a', lead_id: 'l1', activity_type: 'NOTE', description: 'Gọi lần đầu', created_at: '2026-11-20T01:00:00.000Z' }];
  // Thân hàm production (md5 6ace1f95…): chỉ xoá khách còn sống (khoá dòng `deleted_at IS NULL`); khách đã xoá hoặc không
  // có quyền đều trả 42501 «Customer not found or not authorized».
  io.server.rpcHandlers.soft_delete_customer = args => {
    const row = io.server.rows.customers.find(item => item.id === args.p_customer_id && !item.deleted_at);
    if (!row || row.locked) return { data: null, error: { code: '42501', message: 'Customer not found or not authorized' } };
    row.deleted_at = new Date().toISOString();
    return { data: null, error: null };
  };
});

describe('sửa khách (customer-update)', () => {
  const save = () => mutationOf<{ id: string; data: Row }, { customer: Row; vehicleError?: { outcome: string } }>(renderHook(() => useUpdateCustomer()).result);

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại ghi được', async () => {
    const mutate = save();
    io.server.failNext('customers', 'update', 'drop-before');
    await expect(mutate({ id: 'c1', data: { full_name: 'An Mới' } })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    expect(rowOf('customers', 'c1')?.full_name).toBe('An');
    const result = await mutate({ id: 'c1', data: { full_name: 'An Mới' } });
    expect(result.customer.full_name).toBe('An Mới');
    expect(rowOf('customers', 'c1')?.full_name).toBe('An Mới');
  });

  it('tới nhưng mất phản hồi: bấm lại ghi lại đúng nội dung đó, một khách', async () => {
    const mutate = save();
    io.server.failNext('customers', 'update', 'drop-after');
    await expect(mutate({ id: 'c1', data: { full_name: 'An Mới' } })).rejects.toMatchObject({ outcome: 'unknown', message: expect.stringContaining('Bấm lại') });
    expect(pendingKeys()).toEqual([]);
    await expect(mutate({ id: 'c1', data: { full_name: 'An Mới' } })).resolves.toMatchObject({ customer: { id: 'c1', full_name: 'An Mới' } });
    expect(io.server.rows.customers).toHaveLength(1);
  });

  it('xe vừa thêm mà mất phản hồi: lưu lại cùng form nhận xe đó theo biển số, không tạo trùng, không xoá rồi tạo lại', async () => {
    const mutate = save();
    const kept = { id: 'v-old', vehicle_type: 'MOTORBIKE', vehicle_name: 'Wave', color: '', license_plate: '59A1-111.11' };
    const added = { vehicle_type: 'CAR', vehicle_name: 'Vios', color: 'Trắng', license_plate: '51F-222.22' };
    io.server.failNext('vehicles', 'insert', 'drop-after');
    const first = await mutate({ id: 'c1', data: { full_name: 'An', vehicles: [kept, added] } });
    // Khách đã cập nhật; xe chưa xác nhận xong: báo, cho lưu lại, không dấu.
    expect(first).toMatchObject({ customer: { id: 'c1' }, vehicleError: { outcome: 'partial' } });
    expect(pendingKeys()).toEqual([]);
    // Người dùng gõ lại biển số khác cách viết (hoa thường, dấu cách) rồi lưu lại.
    const second = await mutate({ id: 'c1', data: { full_name: 'An', vehicles: [kept, { ...added, license_plate: '51f 22222' }] } });
    expect(second).not.toHaveProperty('vehicleError');
    expect(io.server.inserts.filter(item => item.table === 'vehicles')).toHaveLength(1);
    expect(io.server.rows.vehicles).toHaveLength(2);
    expect(io.server.rows.vehicles.every(row => !row.deleted_at)).toBe(true);
    const car = io.server.rows.vehicles.find(row => row.id !== 'v-old');
    expect(car).toMatchObject({ customer_id: 'c1', vehicle_type: 'CAR', organization_id: 'org-a', license_plate: '51f 22222' });
  });

  it('gỡ xe cũ: xe khác biển số vẫn bị gỡ như trước; xe mới chưa có thì thêm', async () => {
    const mutate = save();
    await mutate({ id: 'c1', data: { full_name: 'An', vehicles: [{ vehicle_type: 'CAR', vehicle_name: 'Vios', color: '', license_plate: '51F-333.33' }] } });
    expect(rowOf('vehicles', 'v-old')?.deleted_at).toEqual(expect.any(String));
    expect(io.server.rows.vehicles.filter(row => !row.deleted_at)).toHaveLength(1);
  });

  it('dấu bản trước của đúng khách (≥ 10 phút) không chặn; lưu xong dấu được gỡ', async () => {
    marker('customer-update', 'org-a', 'c1');
    await expect(save()({ id: 'c1', data: { full_name: 'An Mới' } })).resolves.toMatchObject({ customer: { full_name: 'An Mới' } });
    expect(pendingKeys()).toEqual([]);
  });

  it('khớp 0 dòng (RLS không cho sửa): từ chối rõ, không phải «chưa rõ»', async () => {
    io.server.writable.customers = () => false;
    const error = await save()({ id: 'c1', data: { full_name: 'An Mới' } }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'PGRST116' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('xoá khách (customer-delete)', () => {
  const remove = () => mutationOf<string, Row>(renderHook(() => useDeleteCustomer()).result);
  const deleteCalls = () => io.server.rpcCalls.filter(call => call.name === 'soft_delete_customer').length;

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại xoá được', async () => {
    const mutate = remove();
    io.server.failNext('soft_delete_customer', 'rpc', 'drop-before');
    await expect(mutate('c1')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    expect(rowOf('customers', 'c1')?.deleted_at).toBeNull();
    await expect(mutate('c1')).resolves.toMatchObject({ id: 'c1' });
    expect(rowOf('customers', 'c1')?.deleted_at).toEqual(expect.any(String));
  });

  it('tới nhưng mất phản hồi: bấm lại đọc thấy đã xoá, báo thành công, không gọi xoá lần hai', async () => {
    const mutate = remove();
    io.server.failNext('soft_delete_customer', 'rpc', 'drop-after');
    await expect(mutate('c1')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    const deletedAt = rowOf('customers', 'c1')?.deleted_at;
    expect(deletedAt).toEqual(expect.any(String));
    await expect(mutate('c1')).resolves.toMatchObject({ id: 'c1', alreadyDeleted: true });
    expect(deleteCalls()).toBe(1);
    expect(rowOf('customers', 'c1')?.deleted_at).toBe(deletedAt);
  });

  it('hàm báo 42501 vì khách vừa bị xoá (tab khác, lần gửi trước): đọc lại thấy đã xoá ⇒ thành công', async () => {
    io.server.rpcHandlers.soft_delete_customer = () => {
      io.server.rows.customers[0].deleted_at = '2026-11-26T01:00:00.000Z';
      return { data: null, error: { code: '42501', message: 'Customer not found or not authorized' } };
    };
    await expect(remove()('c1')).resolves.toMatchObject({ id: 'c1', alreadyDeleted: true });
  });

  it('không có quyền (khách còn nguyên): từ chối rõ, không phải «chưa rõ»', async () => {
    io.server.rows.customers[0].locked = true;
    const error = await remove()('c1').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: '42501' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(rowOf('customers', 'c1')?.deleted_at).toBeNull();
    expect(pendingKeys()).toEqual([]);
  });

  it('khách còn hợp đồng hiệu lực: dừng trước lệnh xoá', async () => {
    io.server.rows.contract_customers = [{ id: 'cc1', contract_id: 'k1', customer_id: 'c1' }];
    io.server.rows.contracts = [{ id: 'k1', status: 'ACTIVE', deleted_at: null }];
    await expect(remove()('c1')).rejects.toThrow('Không thể xoá khách hàng');
    expect(deleteCalls()).toBe(0);
  });

  it('dấu bản trước của đúng khách (≥ 10 phút) không chặn; xoá xong dấu được gỡ', async () => {
    marker('customer-delete', 'org-a', 'c1');
    await expect(remove()('c1')).resolves.toMatchObject({ id: 'c1' });
    expect(rowOf('customers', 'c1')?.deleted_at).toEqual(expect.any(String));
    expect(pendingKeys()).toEqual([]);
  });
});

describe('sửa khách hẹn (useUpdateLead)', () => {
  const save = () => mutationOf<Row & { id: string }>(renderHook(() => useUpdateLead()).result);

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại ghi được', async () => {
    const mutate = save();
    io.server.failNext('leads', 'update', 'drop-before');
    await expect(mutate({ id: 'l1', customer_name: 'Khách hẹn Bình' })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    await expect(mutate({ id: 'l1', customer_name: 'Khách hẹn Bình' })).resolves.toMatchObject({ id: 'l1', customer_name: 'Khách hẹn Bình' });
    expect(rowOf('leads', 'l1')?.customer_name).toBe('Khách hẹn Bình');
  });

  it('tới nhưng mất phản hồi: bấm lại cho đúng một kết quả', async () => {
    const mutate = save();
    io.server.failNext('leads', 'update', 'drop-after');
    await expect(mutate({ id: 'l1', status: 'B2_APPOINTMENT' })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    await expect(mutate({ id: 'l1', status: 'B2_APPOINTMENT' })).resolves.toMatchObject({ id: 'l1', status: 'B2_APPOINTMENT' });
    expect(io.server.rows.leads).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước (≥ 10 phút) không chặn; lưu xong dấu được gỡ', async () => {
    marker('useUpdateLead', 'org-a', 'l1');
    await expect(save()({ id: 'l1', customer_name: 'Khách hẹn Bình' })).resolves.toMatchObject({ id: 'l1' });
    expect(pendingKeys()).toEqual([]);
  });

  it('khớp 0 dòng (RLS / đã mất): từ chối rõ', async () => {
    io.server.writable.leads = () => false;
    const error = await save()({ id: 'l1', customer_name: 'Khách hẹn Bình' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'PGRST116' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
  });
});

describe('xoá khách hẹn (useDeleteLead)', () => {
  const remove = () => mutationOf<string>(renderHook(() => useDeleteLead()).result);

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại xoá được', async () => {
    const mutate = remove();
    io.server.failNext('leads', 'update', 'drop-before');
    await expect(mutate('l1')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    expect(rowOf('leads', 'l1')?.deleted_at).toBeNull();
    await expect(mutate('l1')).resolves.toMatchObject({ id: 'l1' });
    expect(rowOf('leads', 'l1')?.deleted_at).toEqual(expect.any(String));
  });

  it('tới nhưng mất phản hồi: bấm lại khớp 0 dòng, đọc thấy đã xoá ⇒ thành công, giữ giờ xoá cũ', async () => {
    const mutate = remove();
    io.server.failNext('leads', 'update', 'drop-after');
    await expect(mutate('l1')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    const deletedAt = rowOf('leads', 'l1')?.deleted_at;
    expect(deletedAt).toEqual(expect.any(String));
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(mutate('l1')).resolves.toMatchObject({ id: 'l1', alreadyDeleted: true });
    expect(rowOf('leads', 'l1')?.deleted_at).toBe(deletedAt);
    expect(pendingKeys()).toEqual([]);
  });

  it('khớp 0 dòng vì đã xoá trước đó: thành công «đã xoá trước đó», không đổi giờ xoá', async () => {
    io.server.rows.leads[0].deleted_at = '2026-11-20T01:00:00.000Z';
    await expect(remove()('l1')).resolves.toMatchObject({ id: 'l1', alreadyDeleted: true });
    expect(rowOf('leads', 'l1')?.deleted_at).toBe('2026-11-20T01:00:00.000Z');
  });

  it('khớp 0 dòng vì RLS chặn (khách hẹn còn nguyên): báo không có quyền', async () => {
    io.server.writable.leads = () => false;
    await expect(remove()('l1')).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('chưa có quyền xoá') });
    expect(rowOf('leads', 'l1')?.deleted_at).toBeNull();
  });

  it('dấu bản trước (≥ 10 phút) không chặn; xoá xong dấu được gỡ', async () => {
    marker('useDeleteLead', 'org-a', 'l1');
    await expect(remove()('l1')).resolves.toMatchObject({ id: 'l1' });
    expect(pendingKeys()).toEqual([]);
  });
});

describe('thêm hoạt động khách hẹn (lead-activity-create)', () => {
  const add = () => mutationOf<Row>(renderHook(() => useCreateLeadActivity()).result);
  const note = { lead_id: 'l1', activity_type: 'CALL', description: 'Gọi lại', notes: null, scheduled_at: null };
  const activityInserts = () => io.server.inserts.filter(item => item.table === 'lead_activities').map(item => item.payload as Row);
  const created = () => io.server.rows.lead_activities.filter(row => row.id !== 'a1');

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại gửi đúng mã cũ, một hoạt động', async () => {
    const mutate = add();
    io.server.failNext('lead_activities', 'insert', 'drop-before');
    await expect(mutate({ ...note, completed_at: '2026-11-26T01:00:00.000Z' })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    // Lần bấm sau dựng lại giờ hoàn tất mới: vẫn là cùng hoạt động đó.
    await expect(mutate({ ...note, completed_at: '2026-11-26T01:00:30.000Z' })).resolves.toMatchObject({ lead_id: 'l1', description: 'Gọi lại' });
    const [first, second] = activityInserts();
    expect(second.id).toBe(first.id);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ organization_id: 'org-a', performed_by: 'actor' });
  });

  it('tới nhưng mất phản hồi: đọc đúng mã thấy hoạt động, không gửi lần hai', async () => {
    io.server.failNext('lead_activities', 'insert', 'drop-after');
    const activity = await add()({ ...note, completed_at: '2026-11-26T01:00:00.000Z' });
    expect(activity.id).toBe(activityInserts()[0].id);
    expect(activityInserts()).toHaveLength(1);
    expect(created()).toHaveLength(1);
  });

  it('mất phản hồi và đọc lại cũng hỏng: bấm lại gặp trùng mã, trả đúng hoạt động lần trước', async () => {
    const mutate = add();
    io.server.failNext('lead_activities', 'insert', 'drop-after');
    io.server.failNext('lead_activities', 'read', 'drop-before');
    await expect(mutate({ ...note, completed_at: '2026-11-26T01:00:00.000Z' })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    await expect(mutate({ ...note, completed_at: '2026-11-26T01:00:30.000Z' })).resolves.toMatchObject({ id: activityInserts()[0].id });
    expect(created()).toHaveLength(1);
  });

  it('đã ghi xong thì lần thêm sau (cùng nội dung) là hoạt động mới', async () => {
    const mutate = add();
    await mutate({ ...note, completed_at: '2026-11-26T01:00:00.000Z' });
    await mutate({ ...note, completed_at: '2026-11-26T02:00:00.000Z' });
    expect(created()).toHaveLength(2);
  });

  it('dấu bản trước của khách hẹn đó (≥ 10 phút) không chặn; ghi xong dấu được gỡ', async () => {
    marker('lead-activity-create', 'actor-scope', 'l1');
    await expect(add()({ ...note, completed_at: '2026-11-26T01:00:00.000Z' })).resolves.toMatchObject({ lead_id: 'l1' });
    expect(pendingKeys()).toEqual([]);
  });
});

describe('xoá hoạt động khách hẹn (lead-activity-delete)', () => {
  const remove = () => mutationOf<{ activityId: string; leadId: string }>(renderHook(() => useDeleteLeadActivity()).result);

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại xoá được', async () => {
    const mutate = remove();
    io.server.failNext('lead_activities', 'delete', 'drop-before');
    await expect(mutate({ activityId: 'a1', leadId: 'l1' })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    await expect(mutate({ activityId: 'a1', leadId: 'l1' })).resolves.toMatchObject({ leadId: 'l1' });
    expect(rowOf('lead_activities', 'a1')).toBeUndefined();
  });

  it('tới nhưng mất phản hồi: bấm lại khớp 0 dòng, không còn thấy ⇒ đã xoá trước đó', async () => {
    const mutate = remove();
    io.server.failNext('lead_activities', 'delete', 'drop-after');
    await expect(mutate({ activityId: 'a1', leadId: 'l1' })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    await expect(mutate({ activityId: 'a1', leadId: 'l1' })).resolves.toMatchObject({ leadId: 'l1', alreadyDeleted: true });
  });

  it('khớp 0 dòng vì RLS chặn (hoạt động còn nguyên): báo không có quyền', async () => {
    io.server.writable.lead_activities = () => false;
    await expect(remove()({ activityId: 'a1', leadId: 'l1' })).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('chưa có quyền xoá') });
    expect(rowOf('lead_activities', 'a1')).toBeDefined();
  });

  it('dấu bản trước của đúng hoạt động (≥ 10 phút) không chặn; xoá xong dấu được gỡ', async () => {
    marker('lead-activity-delete', 'actor-scope', 'a1');
    await expect(remove()({ activityId: 'a1', leadId: 'l1' })).resolves.toMatchObject({ leadId: 'l1' });
    expect(pendingKeys()).toEqual([]);
  });
});
