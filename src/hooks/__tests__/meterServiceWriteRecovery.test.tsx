// @vitest-environment jsdom
// Đợt 8 (luật 5): sửa / xoá chỉ số, sửa dịch vụ là thao tác ghi LẶP LẠI ĐƯỢC
// (đặt giá trị theo mã, xoá mềm theo mã, đồng bộ theo phần chênh). Rớt mạng không để lại dấu nào và
// không khoá lần bấm sau; dấu của bản trước không chặn và được gỡ sau lần ghi thành công.
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { useBulkDeleteMeterReadings, useDeleteMeterReading, useUpdateMeterReading } from '../useMeterReadings';
import { useUpdateService } from '../useServices';
import { RepeatableWriteUnknownError } from '@/lib/financialWorkflowError';
import { recordWriteBlocked } from '@/lib/recordWriteOutcome';

type Row = Record<string, unknown>;
type Mutation<I> = { mutationFn: (input: I) => Promise<unknown> };
const OLD_DELETE = '2026-01-02T03:04:05.000Z';
// Hai lần bấm ở hai giờ khác nhau thật: lần bấm lại mà đè giờ xoá thì test thấy được (cùng mili giây thì không).
const FIRST_CLICK = '2026-11-26T01:00:00.000Z';
const SECOND_CLICK = '2026-11-26T01:05:00.000Z';
const setClock = (iso: string) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)); };
const tenMinutesAgo = () => new Date(Date.now() - 10 * 60_000);
const actorMark = (namespace: string, businessKey: string) => seedLegacyPending({ namespace, userId: 'actor', organizationId: 'actor-scope', businessKey }, tenMinutesAgo());
const rows = (table: string): Row[] => io.server.rows[table] ?? [];
const rowOf = (table: string, id: string): Row | undefined => rows(table).find(row => row.id === id);
const insertCalls = (table: string) => io.server.inserts.filter(item => item.table === table).length;

async function rejection(task: Promise<unknown>): Promise<unknown> {
  return task.then(() => { throw new Error('Lệnh ghi phải báo lỗi'); }, (error: unknown) => error);
}
/** Kết quả chưa rõ của thao tác lặp lại được: báo rõ, không khoá form, không để lại dấu nào. */
function expectRepeatable(error: unknown, text?: RegExp) {
  expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
  expect(recordWriteBlocked(error)).toBe(false);
  expect((error as Error).message).toMatch(/Bấm lại/);
  if (text) expect((error as Error).message).toMatch(text);
  expect(pendingKeys()).toEqual([]);
}
/** Lời từ chối rõ: không khoá form, không để lại dấu. */
function expectRefusal(error: unknown, text: RegExp) {
  expect(error).toMatchObject({ outcome: 'failure' });
  expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
  expect(recordWriteBlocked(error)).toBe(false);
  expect((error as Error).message).toMatch(text);
  expect(pendingKeys()).toEqual([]);
}
const reading = (id: string, extra: Row = {}): Row => ({ id, building_id: 'b1', meter_id: 'm1', previous_reading: 5, current_reading: 10, reading_date: '2026-11-01', status: 'APPROVED', deleted_at: null, ...extra });
type Reply = { data: unknown; error: unknown };
type Settle = (ok: (value: Reply) => unknown, fail?: (reason: unknown) => unknown) => unknown;
/**
 * Hàng rào: lệnh kế tiếp trên `table` đã ghi thật nhưng biên nhận trả về bị sửa (mã lạ, sai mã). Phiên bản đợt 8 không
 * được coi đó là thành công; chỉ báo chưa rõ và cho bấm lại.
 */
function tamperNextReceipt(table: string, tamper: (data: unknown) => unknown, skip = 0) {
  const from = io.server.from;
  let left = skip;
  io.server.from = (name: string) => {
    const query = from(name) as { then: Settle; single: () => Promise<Reply>; maybeSingle: () => Promise<Reply> };
    if (name !== table) return query;
    if (left-- > 0) return query;
    io.server.from = from;
    const { then, single, maybeSingle } = query;
    query.then = (ok, fail) => then(value => ok({ ...value, data: tamper(value.data) }), fail);
    query.single = async () => { const value = await single(); return { ...value, data: tamper(value.data) }; };
    query.maybeSingle = async () => { const value = await maybeSingle(); return { ...value, data: tamper(value.data) }; };
    return query;
  };
}

beforeEach(() => {
  io.server = fakeRecordServer();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
});
afterEach(() => { vi.useRealTimers(); });

describe('sửa chỉ số (đặt giá trị theo mã)', () => {
  type Input = { id: string; current_reading?: number; reading_date?: string; notes?: string };
  const update = () => (renderHook(() => useUpdateMeterReading()).result.current as unknown as Mutation<Input>).mutationFn;
  beforeEach(() => { io.server.rows.meter_readings = [reading('r1')]; });

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại ghi được', async () => {
    const save = update();
    io.server.failNext('meter_readings', 'update', 'drop-before');
    expectRepeatable(await rejection(save({ id: 'r1', current_reading: 12 })), /cập nhật chỉ số/);
    expect(rowOf('meter_readings', 'r1')?.current_reading).toBe(10);
    await expect(save({ id: 'r1', current_reading: 12 })).resolves.toMatchObject({ id: 'r1', current_reading: 12 });
    expect(rowOf('meter_readings', 'r1')?.current_reading).toBe(12);
  });

  it('tới nhưng mất phản hồi: bấm lại đặt lại đúng giá trị đó, một bản ghi', async () => {
    const save = update();
    io.server.failNext('meter_readings', 'update', 'drop-after');
    expectRepeatable(await rejection(save({ id: 'r1', current_reading: 12, notes: 'sửa' })));
    await expect(save({ id: 'r1', current_reading: 12, notes: 'sửa' })).resolves.toMatchObject({ id: 'r1', current_reading: 12 });
    expect(rows('meter_readings')).toHaveLength(1);
    expect(rowOf('meter_readings', 'r1')).toMatchObject({ current_reading: 12, previous_reading: 5, notes: 'sửa' });
  });

  it('dấu bản trước (không tên thao tác) không chặn; sửa xong thì gỡ', async () => {
    const key = actorMark('useUpdateMeterReading', 'r1');
    await expect(update()({ id: 'r1', current_reading: 12 })).resolves.toMatchObject({ id: 'r1' });
    expect(localStorage.getItem(key)).toBeNull();
    expect(pendingKeys()).toEqual([]);
  });

  it('khớp 0 dòng (không còn / không có quyền): từ chối rõ, không ghi gì', async () => {
    io.server.writable.meter_readings = () => false;
    expectRefusal(await rejection(update()({ id: 'r1', current_reading: 12 })), /Không tìm thấy chỉ số|chưa có quyền/);
    expect(rowOf('meter_readings', 'r1')?.current_reading).toBe(10);
  });

  it('hàng rào: biên nhận mang mã khác không được tính là đã sửa; bấm lại ghi được', async () => {
    const save = update();
    tamperNextReceipt('meter_readings', data => ({ ...(data as Row), id: 'r9' }));
    expectRepeatable(await rejection(save({ id: 'r1', current_reading: 12 })));
    await expect(save({ id: 'r1', current_reading: 12 })).resolves.toMatchObject({ id: 'r1', current_reading: 12 });
  });
});

describe('xoá chỉ số (xoá mềm theo mã)', () => {
  const remove = () => (renderHook(() => useDeleteMeterReading()).result.current as unknown as Mutation<string>).mutationFn;

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại xoá được', async () => {
    io.server.rows.meter_readings = [reading('r1')];
    const run = remove();
    io.server.failNext('meter_readings', 'update', 'drop-before');
    expectRepeatable(await rejection(run('r1')), /xoá chỉ số/);
    expect(rowOf('meter_readings', 'r1')?.deleted_at).toBeNull();
    await run('r1');
    expect(rowOf('meter_readings', 'r1')?.deleted_at).toEqual(expect.any(String));
  });

  it('tới nhưng mất phản hồi: bấm lại báo đã xoá, không xoá lần hai', async () => {
    io.server.rows.meter_readings = [reading('r1')];
    const run = remove();
    io.server.failNext('meter_readings', 'update', 'drop-after');
    setClock(FIRST_CLICK);
    expectRepeatable(await rejection(run('r1')));
    const firstDelete = rowOf('meter_readings', 'r1')?.deleted_at;
    expect(firstDelete).toBe(FIRST_CLICK);
    setClock(SECOND_CLICK);
    await expect(run('r1')).resolves.toMatchObject({ id: 'r1', alreadyDeleted: true });
    expect(rowOf('meter_readings', 'r1')?.deleted_at).toBe(firstDelete);
  });

  it('khớp 0 dòng vì đã xoá từ trước: thành công, giữ nguyên giờ xoá cũ', async () => {
    io.server.rows.meter_readings = [reading('r1', { deleted_at: OLD_DELETE })];
    await expect(remove()('r1')).resolves.toMatchObject({ id: 'r1' });
    expect(rowOf('meter_readings', 'r1')?.deleted_at).toBe(OLD_DELETE);
    expect(pendingKeys()).toEqual([]);
  });

  it('khớp 0 dòng vì bản ghi không còn thấy: thành công', async () => {
    io.server.rows.meter_readings = [];
    await expect(remove()('r1')).resolves.toMatchObject({ id: 'r1' });
  });

  it('khớp 0 dòng vì RLS không cho xoá: báo không có quyền, không giả là đã xoá', async () => {
    io.server.rows.meter_readings = [reading('r1')];
    io.server.writable.meter_readings = () => false;
    expectRefusal(await rejection(remove()('r1')), /chưa có quyền xoá/);
    expect(rowOf('meter_readings', 'r1')?.deleted_at).toBeNull();
  });

  it('khớp 0 dòng và đọc lại hỏng: chưa rõ, bấm lại được', async () => {
    io.server.rows.meter_readings = [reading('r1')];
    io.server.writable.meter_readings = () => false;
    io.server.failNext('meter_readings', 'read', 'drop-before');
    expectRepeatable(await rejection(remove()('r1')));
  });

  it('dấu bản trước không chặn; xoá xong thì gỡ', async () => {
    io.server.rows.meter_readings = [reading('r1')];
    const key = actorMark('useDeleteMeterReading', 'r1');
    await remove()('r1');
    expect(localStorage.getItem(key)).toBeNull();
    expect(pendingKeys()).toEqual([]);
  });
});

describe('xoá chỉ số hàng loạt', () => {
  const removeMany = () => (renderHook(() => useBulkDeleteMeterReadings()).result.current as unknown as Mutation<string[]>).mutationFn;
  beforeEach(() => { io.server.rows.meter_readings = [reading('r1'), reading('r2')]; });

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại xoá đủ', async () => {
    const run = removeMany();
    io.server.failNext('meter_readings', 'update', 'drop-before');
    expectRepeatable(await rejection(run(['r2', 'r1'])), /xoá chỉ số hàng loạt/);
    await expect(run(['r2', 'r1'])).resolves.toHaveLength(2);
    expect(rows('meter_readings').every(row => typeof row.deleted_at === 'string')).toBe(true);
  });

  it('tới nhưng mất phản hồi: bấm lại không tính dòng đã xoá là lệch', async () => {
    const run = removeMany();
    io.server.failNext('meter_readings', 'update', 'drop-after');
    setClock(FIRST_CLICK);
    expectRepeatable(await rejection(run(['r1', 'r2'])));
    expect(rows('meter_readings').map(row => row.deleted_at)).toEqual([FIRST_CLICK, FIRST_CLICK]);
    setClock(SECOND_CLICK);
    await expect(run(['r1', 'r2'])).resolves.toHaveLength(2);
    expect(rows('meter_readings').map(row => row.deleted_at)).toEqual([FIRST_CLICK, FIRST_CLICK]);
  });

  it('một dòng đã xoá từ trước, một dòng còn: xoá đủ, giữ giờ xoá cũ', async () => {
    io.server.rows.meter_readings = [reading('r1', { deleted_at: OLD_DELETE }), reading('r2')];
    await expect(removeMany()(['r1', 'r2'])).resolves.toHaveLength(2);
    expect(rowOf('meter_readings', 'r1')?.deleted_at).toBe(OLD_DELETE);
    expect(rowOf('meter_readings', 'r2')?.deleted_at).toEqual(expect.any(String));
  });

  it('RLS không cho xoá một dòng: báo rõ không có quyền, không khoá', async () => {
    io.server.writable.meter_readings = row => row.id !== 'r2';
    expectRefusal(await rejection(removeMany()(['r1', 'r2'])), /chưa có quyền xoá/);
    expect(rowOf('meter_readings', 'r2')?.deleted_at).toBeNull();
  });

  it('hàng rào: biên nhận có mã ngoài lựa chọn không được tính là đã xoá; bấm lại thì xong', async () => {
    const run = removeMany();
    tamperNextReceipt('meter_readings', data => [...(data as Row[]), { id: 'r9' }]);
    expectRepeatable(await rejection(run(['r1', 'r2'])));
    await expect(run(['r1', 'r2'])).resolves.toHaveLength(2);
  });

  it('dấu bản trước của đúng lựa chọn không chặn; xoá xong thì gỡ', async () => {
    const key = actorMark('useBulkDeleteMeterReadings', 'r1,r2');
    await removeMany()(['r2', 'r1']);
    expect(localStorage.getItem(key)).toBeNull();
    expect(pendingKeys()).toEqual([]);
  });
});

describe('sửa dịch vụ (đặt giá trị + đồng bộ toà áp dụng theo phần chênh)', () => {
  type Input = { id: string; updates: Row; building_ids?: string[] };
  const update = () => (renderHook(() => useUpdateService()).result.current as unknown as Mutation<Input>).mutationFn;
  const input: Input = { id: 's1', updates: { name: 'Điện mới' }, building_ids: ['b-kept', 'b-new'] };
  const links = () => rows('building_services').filter(row => row.service_id === 's1').map(row => `${row.building_id}:${row.is_active}`).sort();
  beforeEach(() => {
    io.server.rows.services = [{ id: 's1', name: 'Điện', unit_price: 100, deleted_at: null }];
    io.server.rows.building_services = [
      { id: 'l-old', service_id: 's1', building_id: 'b-old', is_active: true },
      { id: 'l-kept', service_id: 's1', building_id: 'b-kept', is_active: false },
    ];
    io.server.uniqueBy.building_services = row => `${row.building_id}:${row.service_id}`;
  });

  it('lệnh không tới máy chủ: báo rõ, không dấu, bấm lại ghi đủ', async () => {
    const save = update();
    io.server.failNext('services', 'update', 'drop-before');
    expectRepeatable(await rejection(save(input)), /cập nhật dịch vụ/);
    expect(rowOf('services', 's1')?.name).toBe('Điện');
    await save(input);
    expect(rowOf('services', 's1')?.name).toBe('Điện mới');
    expect(links()).toEqual(['b-kept:true', 'b-new:true']);
  });

  it('thêm toà mất phản hồi: bấm lại đọc lại phần chênh, không thêm trùng', async () => {
    const save = update();
    io.server.failNext('building_services', 'insert', 'drop-after');
    expectRepeatable(await rejection(save(input)), /tòa áp dụng/);
    await save(input);
    expect(links()).toEqual(['b-kept:true', 'b-new:true']);
    expect(insertCalls('building_services')).toBe(1);
  });

  it('gỡ toà mất phản hồi: bấm lại không báo lệch', async () => {
    const save = update();
    io.server.failNext('building_services', 'delete', 'drop-after');
    expectRepeatable(await rejection(save(input)));
    await save(input);
    expect(links()).toEqual(['b-kept:true', 'b-new:true']);
  });

  it('dấu bản trước (công ty đang chọn) không chặn; lưu xong thì gỡ', async () => {
    const key = seedLegacyPending({ namespace: 'service-update', userId: 'actor', organizationId: 'org-a', businessKey: 's1' }, tenMinutesAgo());
    await update()(input);
    expect(localStorage.getItem(key)).toBeNull();
    expect(pendingKeys()).toEqual([]);
  });

  it('sửa dịch vụ khớp 0 dòng: từ chối rõ, không đụng toà áp dụng', async () => {
    io.server.writable.services = () => false;
    expectRefusal(await rejection(update()(input)), /Không tìm thấy dịch vụ|chưa có quyền/);
    expect(links()).toEqual(['b-kept:false', 'b-old:true']);
  });

  it('gỡ toà bị RLS chặn: báo rõ không có quyền, không khoá', async () => {
    io.server.writable.building_services = row => row.id !== 'l-old';
    expectRefusal(await rejection(update()(input)), /chưa có quyền xoá/);
  });

  it('hàng rào: biên nhận gỡ toà có mã lạ không được tính là xong; bấm lại thì đủ', async () => {
    const save = update();
    // Lệnh thứ hai trên building_services là lệnh gỡ (lệnh đầu đọc toà áp dụng hiện tại).
    tamperNextReceipt('building_services', data => [...(data as Row[]), { id: 'l-9' }], 1);
    expectRepeatable(await rejection(save(input)), /tòa áp dụng/);
    await save(input);
    expect(links()).toEqual(['b-kept:true', 'b-new:true']);
  });
});

// Đợt 10b: hai khối «sửa định mức (xoá rồi chèn lại bậc giá)» và «dịch vụ mặc định của toà (xoá rồi chèn lại)» chuyển sang
// xoaChenMotGiaoDichWriters.test.tsx: hai nơi đó nay gọi MỘT hàm máy chủ thay nguyên tử (replace_service_quota_v1,
// replace_building_services_v1), không còn bước gỡ / chèn riêng để rớt mạng giữa chừng.
