// @vitest-environment jsdom
// Đợt 8 (luật 5): sửa / gán tòa / xoá khu vực, sửa / xoá xe ghi lặp lại được: không giữ dấu «chờ đối chiếu», kết quả
// chưa rõ báo rõ và cho bấm lại, dấu bản trước của đúng bản ghi được gỡ sau khi ghi xong. Đường TẠO (đợt 9) không đụng.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from './fakeRecordServer';

type Row = Record<string, unknown>;
const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, refuseUpsert: false }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
// Máy chủ giả chưa có `upsert`: giả `ON CONFLICT (area_id, building_id) DO NOTHING` bằng lệnh chèn chỉ các cặp chưa có
// (máy chủ thật cũng chỉ trả các dòng mới chèn), dùng chung kiểu rớt mạng của lệnh chèn.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => Object.assign(io.server.from(table) as object, {
      upsert: (rows: Row[]) => ({
        select: () => {
          if (io.refuseUpsert) return Promise.resolve({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } });
          const pair = (row: Row) => `${row.area_id}:${row.building_id}`;
          const seen = new Set((io.server.rows[table] ?? []).map(pair));
          const fresh = rows.filter(row => !seen.has(pair(row)) && Boolean(seen.add(pair(row))));
          return (io.server.from(table) as { insert: (value: Row[]) => { select: () => PromiseLike<unknown> } }).insert(fresh).select();
        },
      }),
    }),
  },
}));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useAssignBuildingsToArea, useDeleteArea, useUpdateArea } from '../useAreas';
import { useDeleteVehicle, useUpdateVehicle } from '../useVehicles';
import { FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import { recordWriteBlocked } from '@/lib/recordWriteOutcome';

type Mutate<I> = (input: I) => Promise<unknown>;
const mutationOf = <I,>(value: unknown): Mutate<I> => (value as { mutationFn: Mutate<I> }).mutationFn;
const failureOf = (promise: Promise<unknown>) => promise.then(() => { throw new Error('Lệnh ghi phải hỏng ở lần này'); }, (caught: unknown) => caught);
const tenMinutesAgo = () => new Date(Date.now() - 10 * 60_000);
const seedOld = (namespace: string, businessKey: string) => seedLegacyPending({ namespace, userId: 'actor', organizationId: 'actor-scope', businessKey }, tenMinutesAgo());

const areaRow = (over: Row = {}): Row => ({ id: 'a1', name: 'Khu A', organization_id: 'org-a', user_id: 'actor', deleted_at: null, ...over });
const member = (buildingId: string): Row => ({ area_id: 'a1', building_id: buildingId, organization_id: 'org-a', user_id: 'actor' });
const members = () => (io.server.rows.area_buildings ?? []).map(row => String(row.building_id)).sort();
const vehicleRow = (over: Row = {}): Row => ({ id: 'v1', vehicle_name: 'Wave', license_plate: '59A-1', organization_id: 'org-a', user_id: 'actor', deleted_at: null, ...over });

beforeEach(() => {
  io.server = fakeRecordServer();
  io.refuseUpsert = false;
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
});

describe('sửa khu vực (area-write)', () => {
  const rename = () => mutationOf<{ id: string; updates: Row }>(renderHook(() => useUpdateArea()).result.current);
  beforeEach(() => { io.server.rows.areas = [areaRow()]; });

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại ghi được', async () => {
    const mutate = rename();
    io.server.failNext('areas', 'update', 'drop-before');
    const error = await failureOf(mutate({ id: 'a1', updates: { name: 'Khu B' } }));
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    expect(recordWriteBlocked(error)).toBe(false);
    expect(pendingKeys()).toEqual([]);
    await mutate({ id: 'a1', updates: { name: 'Khu B' } });
    expect(io.server.rows.areas).toEqual([expect.objectContaining({ id: 'a1', name: 'Khu B' })]);
  });

  it('lệnh tới nhưng mất phản hồi: bấm lại cho đúng một kết quả', async () => {
    const mutate = rename();
    io.server.failNext('areas', 'update', 'drop-after');
    await expect(mutate({ id: 'a1', updates: { name: 'Khu B' } })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    await expect(rename()({ id: 'a1', updates: { name: 'Khu B' } })).resolves.toMatchObject({ id: 'a1', name: 'Khu B' });
    expect(io.server.rows.areas).toHaveLength(1);
  });

  it('dấu bản trước của khu này không chặn và được gỡ; dấu của đường tạo (khoá new) để nguyên', async () => {
    seedOld('area-write', 'a1');
    const createMarker = seedOld('area-write', 'new');
    await rename()({ id: 'a1', updates: { name: 'Khu B' } });
    expect(io.server.rows.areas[0]).toMatchObject({ name: 'Khu B' });
    expect(pendingKeys()).toEqual([createMarker]);
  });

  it('khớp 0 dòng (RLS, khu đã mất): từ chối rõ, không dấu', async () => {
    io.server.writable.areas = () => false;
    const error = await failureOf(rename()({ id: 'a1', updates: { name: 'Khu B' } }));
    expect(error).toMatchObject({ code: 'PGRST116' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('gán tòa vào khu vực (area-write)', () => {
  const assign = () => mutationOf<{ areaId: string; toAddIds: string[]; toRemoveIds: string[] }>(renderHook(() => useAssignBuildingsToArea()).result.current);
  const input = { areaId: 'a1', toAddIds: ['b-new'], toRemoveIds: ['b-old'] };
  beforeEach(() => { io.server.rows.areas = [areaRow()]; io.server.rows.area_buildings = [member('b-old')]; });

  it('lệnh gỡ không tới máy chủ: báo rõ, không dấu, bấm lại ghi được', async () => {
    const mutate = assign();
    io.server.failNext('area_buildings', 'delete', 'drop-before');
    const error = await failureOf(mutate(input));
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    expect(members()).toEqual(['b-old']);
    expect(pendingKeys()).toEqual([]);
    await mutate(input);
    expect(members()).toEqual(['b-new']);
  });

  it('lệnh gỡ tới nhưng mất phản hồi: bấm lại không đảo, gán tiếp', async () => {
    io.server.failNext('area_buildings', 'delete', 'drop-after');
    await expect(assign()(input)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(members()).toEqual([]);
    await assign()(input);
    expect(members()).toEqual(['b-new']);
  });

  it('lệnh gán tới nhưng mất phản hồi: bấm lại cho đúng một liên kết', async () => {
    io.server.failNext('area_buildings', 'insert', 'drop-after');
    await expect(assign()(input)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    await assign()(input);
    expect(members()).toEqual(['b-new']);
  });

  it('đọc các tòa đang thuộc khu hỏng: từ chối rõ trước mọi lệnh ghi, không dấu', async () => {
    io.server.failNext('area_buildings', 'read', 'drop-before');
    const error = await failureOf(assign()(input));
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    expect(error).toMatchObject({ outcome: 'failure' });
    expect(members()).toEqual(['b-old']);
    expect(io.server.inserts).toEqual([]);
    expect(pendingKeys()).toEqual([]);
  });

  it('đã gỡ mà máy chủ từ chối gán: báo rõ phần đã gỡ kèm mã, không khoá; bấm lại gán được', async () => {
    io.refuseUpsert = true;
    const error = await failureOf(assign()(input));
    expect(error).toMatchObject({ message: expect.stringContaining('Đã gỡ'), completed: [expect.objectContaining({ id: 'a1:b-old' })] });
    expect(recordWriteBlocked(error)).toBe(false);
    expect(members()).toEqual([]);
    expect(pendingKeys()).toEqual([]);
    io.refuseUpsert = false;
    await assign()(input);
    expect(members()).toEqual(['b-new']);
  });

  it('dấu bản trước của khu này không chặn; gán xong thì gỡ dấu', async () => {
    seedOld('area-write', 'a1');
    await assign()(input);
    expect(members()).toEqual(['b-new']);
    expect(pendingKeys()).toEqual([]);
  });

  it('máy chủ không cho gỡ tòa (RLS, khớp 0 dòng): báo không có quyền, chưa gán gì, không dấu', async () => {
    io.server.writable.area_buildings = () => false;
    const error = await failureOf(assign()(input));
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(error).toMatchObject({ outcome: 'failure', message: expect.stringContaining('chưa có quyền xoá') });
    expect(members()).toEqual(['b-old']);
    expect(io.server.inserts).toEqual([]);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('xoá khu vực (area-write)', () => {
  const remove = () => mutationOf<string>(renderHook(() => useDeleteArea()).result.current);
  beforeEach(() => { io.server.rows.areas = [areaRow()]; io.server.rows.area_buildings = [member('b1'), member('b2')]; });

  it('lệnh xoá mềm không tới máy chủ: báo rõ, không dấu, bấm lại xoá được', async () => {
    const mutate = remove();
    io.server.failNext('areas', 'update', 'drop-before');
    const error = await failureOf(mutate('a1'));
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    // Chưa rõ khu đã xoá chưa: vẫn giữ mã khu trong câu báo để đối chiếu, không khoá.
    expect(error).toMatchObject({ areaId: 'a1', softDeleted: false, completed: [{ id: 'a1', label: 'Khu vực cần đối chiếu' }] });
    expect(recordWriteBlocked(error)).toBe(false);
    expect(io.server.rows.areas[0].deleted_at).toBeNull();
    expect(pendingKeys()).toEqual([]);
    await mutate('a1');
    expect(typeof io.server.rows.areas[0].deleted_at).toBe('string');
    expect(members()).toEqual([]);
  });

  it('lệnh xoá mềm tới nhưng mất phản hồi: bấm lại gỡ tiếp khỏi các tòa, giữ giờ xoá cũ', async () => {
    io.server.failNext('areas', 'update', 'drop-after');
    await expect(remove()('a1')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    const deletedAt = io.server.rows.areas[0].deleted_at;
    expect(typeof deletedAt).toBe('string');
    expect(members()).toEqual(['b1', 'b2']);
    await remove()('a1');
    expect(io.server.rows.areas[0].deleted_at).toBe(deletedAt);
    expect(members()).toEqual([]);
  });

  it('đã xoá mềm mà gỡ khỏi tòa không tới máy chủ: báo kèm mã khu, không khoá; bấm lại xong', async () => {
    io.server.failNext('area_buildings', 'delete', 'drop-before');
    const error = await failureOf(remove()('a1'));
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    expect(error).toMatchObject({ areaId: 'a1', completed: [{ id: 'a1', label: 'Khu vực đã xoá mềm' }] });
    expect(recordWriteBlocked(error)).toBe(false);
    expect(pendingKeys()).toEqual([]);
    await remove()('a1');
    expect(members()).toEqual([]);
  });

  it('khu đã xoá trước đó (khớp 0 dòng): báo thành công, không đổi giờ xoá', async () => {
    io.server.rows.areas = [areaRow({ deleted_at: '2026-11-01T00:00:00.000Z' })];
    io.server.rows.area_buildings = [];
    await expect(remove()('a1')).resolves.toMatchObject({ alreadyDeleted: true });
    expect(io.server.rows.areas[0].deleted_at).toBe('2026-11-01T00:00:00.000Z');
  });

  it('máy chủ không cho xoá (RLS, khớp 0 dòng): báo không có quyền, không gỡ tòa nào', async () => {
    io.server.writable.areas = () => false;
    const error = await failureOf(remove()('a1'));
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    expect(error).toMatchObject({ outcome: 'failure', message: expect.stringContaining('chưa có quyền xoá') });
    expect(io.server.rows.areas[0].deleted_at).toBeNull();
    expect(members()).toEqual(['b1', 'b2']);
  });

  it('đọc liên kết khu hỏng: từ chối rõ trước mọi lệnh ghi', async () => {
    io.server.failNext('area_buildings', 'read', 'drop-before');
    const error = await failureOf(remove()('a1'));
    expect(error).toMatchObject({ outcome: 'failure' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(io.server.rows.areas[0].deleted_at).toBeNull();
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước của khu này không chặn; xoá xong thì gỡ dấu', async () => {
    seedOld('area-write', 'a1');
    await remove()('a1');
    expect(members()).toEqual([]);
    expect(pendingKeys()).toEqual([]);
  });

  it('đã xoá mềm nhưng máy chủ không cho gỡ một tòa: báo xoá một phần kèm mã khu, không khoá, không dấu', async () => {
    io.server.writable.area_buildings = row => row.building_id !== 'b2';
    const error = await failureOf(remove()('a1'));
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    expect(error).toMatchObject({ areaId: 'a1', softDeleted: true, completed: [{ id: 'a1', label: 'Khu vực đã xoá mềm' }] });
    expect(recordWriteBlocked(error)).toBe(false);
    expect(members()).toEqual(['b2']);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('sửa xe (vehicle-update)', () => {
  const update = () => mutationOf<{ id: string; data: Row }>(renderHook(() => useUpdateVehicle()).result.current);
  beforeEach(() => { io.server.rows.vehicles = [vehicleRow()]; });

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại ghi được', async () => {
    const mutate = update();
    io.server.failNext('vehicles', 'update', 'drop-before');
    const error = await failureOf(mutate({ id: 'v1', data: { color: 'Đỏ' } }));
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    await mutate({ id: 'v1', data: { color: 'Đỏ' } });
    expect(io.server.rows.vehicles).toEqual([expect.objectContaining({ id: 'v1', color: 'Đỏ' })]);
  });

  it('lệnh tới nhưng mất phản hồi: bấm lại cho đúng một kết quả', async () => {
    io.server.failNext('vehicles', 'update', 'drop-after');
    await expect(update()({ id: 'v1', data: { color: 'Đỏ' } })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    await expect(update()({ id: 'v1', data: { color: 'Đỏ' } })).resolves.toMatchObject({ id: 'v1', color: 'Đỏ' });
    expect(io.server.rows.vehicles).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước của xe này không chặn; ghi xong thì gỡ dấu, dấu xe khác để nguyên', async () => {
    seedOld('vehicle-update', 'v1');
    const other = seedOld('vehicle-update', 'v2');
    await update()({ id: 'v1', data: { color: 'Đỏ' } });
    expect(io.server.rows.vehicles[0]).toMatchObject({ color: 'Đỏ' });
    expect(pendingKeys()).toEqual([other]);
  });

  it('khớp 0 dòng (RLS, xe đã mất): từ chối rõ, không dấu', async () => {
    io.server.writable.vehicles = () => false;
    const error = await failureOf(update()({ id: 'v1', data: { color: 'Đỏ' } }));
    expect(error).toMatchObject({ code: 'PGRST116' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('xoá xe (vehicle-delete)', () => {
  const remove = () => mutationOf<string>(renderHook(() => useDeleteVehicle()).result.current);
  beforeEach(() => { io.server.rows.vehicles = [vehicleRow()]; });

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại xoá được', async () => {
    const mutate = remove();
    io.server.failNext('vehicles', 'update', 'drop-before');
    const error = await failureOf(mutate('v1'));
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    expect(io.server.rows.vehicles[0].deleted_at).toBeNull();
    expect(pendingKeys()).toEqual([]);
    await mutate('v1');
    expect(typeof io.server.rows.vehicles[0].deleted_at).toBe('string');
  });

  it('lệnh tới nhưng mất phản hồi: bấm lại báo đã xoá trước đó, giữ giờ xoá cũ', async () => {
    io.server.failNext('vehicles', 'update', 'drop-after');
    await expect(remove()('v1')).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    const deletedAt = io.server.rows.vehicles[0].deleted_at;
    expect(typeof deletedAt).toBe('string');
    await expect(remove()('v1')).resolves.toMatchObject({ alreadyDeleted: true });
    expect(io.server.rows.vehicles[0].deleted_at).toBe(deletedAt);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước của xe này không chặn; xoá xong thì gỡ dấu', async () => {
    seedOld('vehicle-delete', 'v1');
    await remove()('v1');
    expect(typeof io.server.rows.vehicles[0].deleted_at).toBe('string');
    expect(pendingKeys()).toEqual([]);
  });

  it('xe đã xoá trước đó (khớp 0 dòng): báo thành công, không đổi giờ xoá', async () => {
    io.server.rows.vehicles = [vehicleRow({ deleted_at: '2026-11-01T00:00:00.000Z' })];
    await expect(remove()('v1')).resolves.toMatchObject({ alreadyDeleted: true });
    expect(io.server.rows.vehicles[0].deleted_at).toBe('2026-11-01T00:00:00.000Z');
  });

  it('máy chủ không cho xoá (RLS, khớp 0 dòng): báo không có quyền, không giả là đã xoá', async () => {
    io.server.writable.vehicles = () => false;
    const error = await failureOf(remove()('v1'));
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    expect(error).toMatchObject({ outcome: 'failure', message: expect.stringContaining('chưa có quyền xoá') });
    expect(io.server.rows.vehicles[0].deleted_at).toBeNull();
  });
});
