// @vitest-environment jsdom
// Đợt 9 (luật 5): TẠO MỚI ở màn thiết lập (căn hộ, công tơ, toà, xe, khu vực, dịch vụ, định mức, mẫu in) không giữ dấu «chờ
// đối chiếu» nào nữa. Mã bản ghi do trình duyệt sinh (`createRecordOnce`): lần bấm lại sau một kết quả chưa rõ gửi ĐÚNG mã cũ
// nên khoá chính chặn bản thứ hai. Ba kịch bản cho mỗi nơi: lệnh không tới máy chủ; tới nhưng mất phản hồi (kể cả khi đọc
// lại ngay cũng hỏng); dấu bản trước gieo sẵn 10 phút không tên thao tác. Thêm: trùng tên / mã với bản ghi KHÁC báo mã bản ghi
// đó; bước sau (tòa áp dụng, bậc giá) hỏng thì lần bấm sau làm tiếp trên đúng bản ghi đã tạo.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NETWORK_ERROR, fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from './fakeRecordServer';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: unknown };
const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, failLookup: false, refuseInsert: {} as Record<string, unknown> }));
/** Tên chỉ mục duy nhất thật trên production (máy chủ giả chỉ có một tên chung). */
const UNIQUE_NAME: Record<string, string> = { rooms: 'idx_rooms_unique_name_per_building', meters: 'meters_user_id_code_key' };
/**
 * Bọc máy chủ giả: đổi tên chỉ mục trong lời từ chối 23505 cho đúng production, (khi `failLookup`) làm hỏng riêng lần TRA
 * bản ghi trùng theo tên / mã (lần đọc lại theo mã vẫn chạy bình thường), và (`refuseInsert`) từ chối rõ một lần chèn.
 */
function from(table: string) {
  const query = io.server.from(table) as Record<string, (...args: unknown[]) => unknown>;
  const columns: string[] = [];
  let refusal: unknown;
  const eq = query.eq;
  query.eq = (column: unknown, value: unknown) => { columns.push(String(column)); return eq(column, value); };
  const insert = query.insert;
  query.insert = (value: unknown) => {
    if (io.refuseInsert[table]) { refusal = io.refuseInsert[table]; delete io.refuseInsert[table]; }
    return insert(value);
  };
  const lookup = () => (refusal ? { data: null, error: refusal } : io.failLookup && (columns.includes('name') || columns.includes('code')) ? { data: null, error: NETWORK_ERROR } : null);
  const rename = (result: Result): Result => {
    const error = result.error as { code?: string; message?: string } | null;
    if (!error || error.code !== '23505' || !UNIQUE_NAME[table] || !String(error.message).includes('_org_side_normalized_name_uq')) return result;
    return { ...result, error: { ...error, message: `duplicate key value violates unique constraint "${UNIQUE_NAME[table]}"` } };
  };
  for (const shape of ['single', 'maybeSingle'] as const) {
    const run = query[shape];
    query[shape] = async () => lookup() ?? rename(await (run() as Promise<Result>));
  }
  const then = query.then;
  query.then = (resolve: unknown, reject: unknown) => {
    const failed = lookup();
    return failed
      ? Promise.resolve(failed).then(resolve as (value: Result) => unknown, reject as (reason: unknown) => unknown)
      : then((result: Result) => (resolve as (value: Result) => unknown)(rename(result)), reject);
  };
  return query;
}
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => from(table) } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useCreateRoom } from '../useRooms';
import { useCreateMeter } from '../useMeters';
import { useCreateBuilding } from '../useBuildings';
import { useCreateVehicle } from '../useVehicles';
import { useCreateArea } from '../useAreas';
import { ServiceLinksPartialError, ServiceQuotaPartialError, useCreateService, useCreateServiceQuota } from '../useServices';
import { useCreateIncomeExpenseTemplate } from '../useIncomeExpenseTemplates';
import { FinancialAlreadyRecordedError, FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import { recordWriteBlocked } from '@/lib/recordWriteOutcome';
import { forgetUnconfirmedCreates } from '@/lib/clientRecordCreate';
import { isDuplicateMeterCode } from '@/lib/meterFeedback';

type Mutate = (input: never) => Promise<unknown>;
const mutationOf = (value: unknown): Mutate => (value as { mutationFn: Mutate }).mutationFn;
const failureOf = (promise: Promise<unknown>) => promise.then(() => { throw new Error('Lệnh ghi phải hỏng ở lần này'); }, (caught: unknown) => caught);
const tenMinutesAgo = () => new Date(Date.now() - 10 * 60_000);
const seedOld = (namespace: string, businessKey: string, organizationId = 'org-a') => seedLegacyPending({ namespace, userId: 'actor', organizationId, businessKey }, tenMinutesAgo());
const rowsOf = (table: string) => io.server.rows[table] ?? [];
/** Mã đã gửi ở từng lần chèn vào bảng. */
const sentIds = (table: string) => io.server.inserts.filter(item => item.table === table).map(item => (item.payload as Row).id);

beforeEach(() => {
  io.server = fakeRecordServer();
  io.failLookup = false;
  io.refuseInsert = {};
  io.server.uniqueBy.rooms = row => (row.deleted_at ? `xoa:${String(row.id)}` : `${String(row.building_id)}|${String(row.name)}`);
  io.server.uniqueBy.meters = row => `${String(row.user_id)}|${String(row.code)}`;
  io.server.uniqueBy.building_services = row => `${String(row.building_id)}|${String(row.service_id)}`;
  io.server.uniqueBy.service_quota_tiers = row => `${String(row.quota_id)}|${String(row.tier_number)}`;
  io.server.rows.services = [{ id: 'svc-dien', name: 'Tiền điện', fee_type: 'TIEN_DIEN', is_default: true, deleted_at: null, organization_id: 'org-a' }];
  forgetUnconfirmedCreates();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
});

/**
 * Ba kịch bản chung cho một nơi tạo một bản ghi. `create` dựng hook (renderHook) rồi trả `mutationFn`; `input` là dữ liệu
 * form; `rows()` đếm bản ghi chính trên máy chủ giả.
 */
function threeScenarios(label: string, setup: { table: string; namespace: string; businessKey: string; scope?: string; create: () => Mutate; input: () => unknown }) {
  describe(label, () => {
    it('lệnh không tới máy chủ: báo chưa rõ, không khoá, không dấu; bấm lại gửi đúng mã cũ và tạo đúng một bản ghi', async () => {
      io.server.failNext(setup.table, 'insert', 'drop-before');
      const error = await failureOf(setup.create()(setup.input() as never));
      expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
      expect(recordWriteBlocked(error)).toBe(false);
      expect(pendingKeys()).toEqual([]);
      expect(rowsOf(setup.table)).toHaveLength(0);
      await setup.create()(setup.input() as never);
      expect(rowsOf(setup.table)).toHaveLength(1);
      const ids = sentIds(setup.table);
      expect(ids).toHaveLength(2);
      expect(ids[1]).toBe(ids[0]);
      expect(rowsOf(setup.table)[0]?.id).toBe(ids[0]);
    });

    it('tới nhưng mất phản hồi và đọc lại cũng hỏng: bấm lại nhận ra bản ghi của lần trước, không tạo bản thứ hai', async () => {
      io.server.failNext(setup.table, 'insert', 'drop-after');
      io.server.failNext(setup.table, 'read', 'drop-before');
      const error = await failureOf(setup.create()(setup.input() as never));
      expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
      expect(recordWriteBlocked(error)).toBe(false);
      expect(pendingKeys()).toEqual([]);
      expect(rowsOf(setup.table)).toHaveLength(1);
      const saved = await setup.create()(setup.input() as never);
      expect(rowsOf(setup.table)).toHaveLength(1);
      const ids = sentIds(setup.table);
      expect(ids[1]).toBe(ids[0]);
      expect(JSON.stringify(saved)).toContain(String(ids[0]));
    });

    it('dấu bản trước gieo sẵn (10 phút, không tên thao tác) không chặn; tạo xong thì dấu được gỡ', async () => {
      seedOld(setup.namespace, setup.businessKey, setup.scope);
      await setup.create()(setup.input() as never);
      expect(rowsOf(setup.table)).toHaveLength(1);
      expect(pendingKeys()).toEqual([]);
    });
  });
}

const roomInput = (name = 'P101') => ({ building_id: 'b1', name, floor: 1, rent_price: 3_000_000, deposit_amount: 0, status: 'AVAILABLE', area: null, max_occupants: null, invoice_template_id: null, lease_template_id: null });
threeScenarios('tạo căn hộ (room-create)', { table: 'rooms', namespace: 'room-create', businessKey: 'create', create: () => mutationOf(renderHook(() => useCreateRoom()).result.current), input: () => roomInput() });

describe('tạo căn hộ trùng tên một căn hộ KHÁC trong tòa', () => {
  beforeEach(() => { io.server.rows.rooms = [{ id: 'room-cu', building_id: 'b1', name: 'P101', deleted_at: null, organization_id: 'org-a' }]; });
  it('từ chối rõ, nêu mã căn hộ đang giữ tên đó; không tạo gì, không dấu', async () => {
    const error = await failureOf(mutationOf(renderHook(() => useCreateRoom()).result.current)(roomInput() as never));
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(error).toMatchObject({ outcome: 'failure' });
    expect((error as Error).message).toContain('room-cu');
    expect(recordWriteBlocked(error)).toBe(false);
    expect(rowsOf('rooms')).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('tra căn hộ trùng tên bị hỏng: vẫn là lời từ chối chung (23505), không đoán mã', async () => {
    io.failLookup = true;
    const error = await failureOf(mutationOf(renderHook(() => useCreateRoom()).result.current)(roomInput() as never));
    expect(error).toMatchObject({ code: '23505' });
    expect(String((error as Error).message)).not.toContain('room-cu');
    expect(rowsOf('rooms')).toHaveLength(1);
  });
  it('căn hộ cũ đã xoá mềm không giữ tên: tạo được căn hộ mới cùng tên', async () => {
    io.server.rows.rooms[0]!.deleted_at = '2026-11-01T00:00:00Z';
    await mutationOf(renderHook(() => useCreateRoom()).result.current)(roomInput() as never);
    expect(rowsOf('rooms')).toHaveLength(2);
  });
});

const meterInput = (code = 'CT-1') => ({ building_id: 'b1', room_id: 'r1', meter_type: 'ELECTRICITY', code, initial_reading: 0, installation_date: null, location_note: null });
threeScenarios('tạo công tơ (meter-create)', { table: 'meters', namespace: 'meter-create', businessKey: 'create', create: () => mutationOf(renderHook(() => useCreateMeter()).result.current), input: () => meterInput() });

describe('tạo công tơ trùng mã một công tơ KHÁC của cùng người', () => {
  beforeEach(() => { io.server.rows.meters = [{ id: 'cong-to-cu', user_id: 'actor', code: 'CT-1', building_id: 'b2', organization_id: 'org-a', deleted_at: null }]; });
  it('từ chối rõ, nêu mã công tơ đang giữ mã đó, vẫn nhận ra là trùng mã công tơ (ô mã báo lỗi)', async () => {
    const error = await failureOf(mutationOf(renderHook(() => useCreateMeter()).result.current)(meterInput() as never));
    expect(error).toBeInstanceOf(FinancialWorkflowError);
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect((error as Error).message).toContain('cong-to-cu');
    expect(isDuplicateMeterCode(error)).toBe(true);
    expect(rowsOf('meters')).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
  it('tra công tơ trùng mã bị hỏng: lời từ chối chung, không đoán mã', async () => {
    io.failLookup = true;
    const error = await failureOf(mutationOf(renderHook(() => useCreateMeter()).result.current)(meterInput() as never));
    expect(isDuplicateMeterCode(error)).toBe(true);
    expect(String((error as Error).message)).not.toContain('cong-to-cu');
  });
});

const buildingInput = () => ({ name: 'Tòa G1', code: 'G1', province: 'Tỉnh', district: 'Quận', ward: 'Phường', street_address: '1 Đường', status: 'ACTIVE', has_elevator: false, commission_tiers: [{ min_months: 5, max_months: 6, rate_percent: 50 }] });
threeScenarios('tạo tòa nhà (building-create)', { table: 'buildings', namespace: 'building-create', businessKey: 'create', create: () => mutationOf(renderHook(() => useCreateBuilding()).result.current), input: buildingInput });

it('tạo tòa: máy chủ đổi người đứng tên (trigger theo công ty) không làm lần bấm lại tưởng là thông tin khác', async () => {
  io.server.failNext('buildings', 'insert', 'drop-after');
  io.server.failNext('buildings', 'read', 'drop-before');
  const create = () => mutationOf(renderHook(() => useCreateBuilding()).result.current);
  await expect(create()(buildingInput() as never)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
  io.server.rows.buildings[0]!.user_id = 'chu-cong-ty';
  await expect(create()(buildingInput() as never)).resolves.toMatchObject({ id: sentIds('buildings')[0] });
  expect(rowsOf('buildings')).toHaveLength(1);
});

it('tạo tòa: lần trước đã ghi với thông tin khác thì báo mã tòa đó, không ghi thêm; lần bấm sau là lượt mới', async () => {
  io.server.failNext('buildings', 'insert', 'drop-after');
  io.server.failNext('buildings', 'read', 'drop-before');
  const create = () => mutationOf(renderHook(() => useCreateBuilding()).result.current);
  await expect(create()(buildingInput() as never)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
  const error = await failureOf(create()({ ...buildingInput(), street_address: '2 Đường' } as never));
  expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
  expect((error as Error).message).toContain(String(sentIds('buildings')[0]));
  expect(rowsOf('buildings')).toHaveLength(1);
});

const vehicleInput = () => ({ vehicle_type: 'MOTORBIKE', vehicle_name: 'Wave', color: 'Đen', license_plate: '59A-123.45', owner_name: 'Chủ xe', ticket_number: '', image_url: '' });
threeScenarios('thêm xe (vehicle-create)', { table: 'vehicles', namespace: 'vehicle-create', businessKey: 'create', create: () => mutationOf(renderHook(() => useCreateVehicle()).result.current), input: vehicleInput });

threeScenarios('tạo khu vực (area-write, khoá new, phạm vi người dùng)', { table: 'areas', namespace: 'area-write', businessKey: 'new', scope: 'actor-scope', create: () => mutationOf(renderHook(() => useCreateArea()).result.current), input: () => ({ name: 'Khu G1' }) });

it('tạo khu vực: dấu SỬA của một khu khác (khoá theo mã khu) không bị đụng', async () => {
  const other = seedOld('area-write', 'a-khac', 'actor-scope');
  await mutationOf(renderHook(() => useCreateArea()).result.current)({ name: 'Khu G1b' } as never);
  expect(pendingKeys()).toEqual([other]);
});

const serviceInput = (name: string, over: Row = {}) => ({ name, fee_type: 'TIEN_PHI_DICH_VU', pricing_type: 'DON_GIA_CO_DINH_THANG', unit_price: 50_000, unit: 'Phòng', quota_id: null, type: 'FIXED', description: null, building_ids: ['b1', 'b2'], ...over });
const serviceRows = () => rowsOf('services').filter(row => row.id !== 'svc-dien');
describe('tạo dịch vụ (service-create)', () => {
  const create = () => mutationOf(renderHook(() => useCreateService()).result.current);
  it('lệnh tạo không tới máy chủ: chưa rõ, không dấu; bấm lại đúng một dịch vụ, đủ tòa áp dụng', async () => {
    io.server.failNext('services', 'insert', 'drop-before');
    const error = await failureOf(create()(serviceInput('Dịch vụ A') as never));
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    await create()(serviceInput('Dịch vụ A') as never);
    expect(serviceRows()).toHaveLength(1);
    expect(sentIds('services')[1]).toBe(sentIds('services')[0]);
    expect(rowsOf('building_services').map(row => row.building_id).sort()).toEqual(['b1', 'b2']);
  });
  it('lệnh tạo tới nhưng mất phản hồi, đọc lại hỏng: bấm lại không tạo dịch vụ thứ hai', async () => {
    io.server.failNext('services', 'insert', 'drop-after');
    io.server.failNext('services', 'read', 'drop-before');
    await expect(create()(serviceInput('Dịch vụ B') as never)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    await create()(serviceInput('Dịch vụ B') as never);
    expect(serviceRows()).toHaveLength(1);
    expect(rowsOf('building_services')).toHaveLength(2);
    expect(pendingKeys()).toEqual([]);
  });
  // Hộp tạo dịch vụ giữ mã dịch vụ đã tạo (khoá các ô thông tin dịch vụ) và gửi kèm `continueId` ở lần bấm sau.
  it('dịch vụ đã tạo nhưng gán tòa mất phản hồi: báo mã dịch vụ, không khoá; bấm lại (kèm mã) chỉ gán phần còn thiếu trên đúng dịch vụ đó', async () => {
    io.server.failNext('building_services', 'insert', 'drop-after');
    const error = await failureOf(create()(serviceInput('Dịch vụ C') as never));
    expect(error).toBeInstanceOf(ServiceLinksPartialError);
    const serviceId = serviceRows()[0]?.id;
    expect(error).toMatchObject({ serviceId });
    expect((error as Error).message).toContain(String(serviceId));
    expect(pendingKeys()).toEqual([]);
    await create()(serviceInput('Dịch vụ C', { continueId: serviceId }) as never);
    expect(serviceRows()).toHaveLength(1);
    expect(rowsOf('building_services').map(row => `${String(row.service_id)}:${String(row.building_id)}`).sort()).toEqual([`${String(serviceId)}:b1`, `${String(serviceId)}:b2`]);
  });
  it('gán tòa bị từ chối rõ sau khi đã tạo dịch vụ: bấm lại (đổi tòa, kèm mã) gán trên đúng dịch vụ đó', async () => {
    io.refuseInsert.building_services = { code: '42501', message: 'new row violates row-level security policy' };
    const error = await failureOf(create()(serviceInput('Dịch vụ D') as never));
    expect(error).toBeInstanceOf(ServiceLinksPartialError);
    expect(rowsOf('building_services')).toHaveLength(0);
    await create()(serviceInput('Dịch vụ D', { building_ids: ['b3'], continueId: (error as ServiceLinksPartialError).serviceId }) as never);
    expect(serviceRows()).toHaveLength(1);
    expect(rowsOf('building_services').map(row => row.building_id)).toEqual(['b3']);
  });
  it('dịch vụ đã tạo bị xoá trước lần bấm tiếp: không gắn tòa vào dịch vụ đã xoá; tạo dịch vụ mới rồi gán tòa vào đó', async () => {
    io.server.failNext('building_services', 'insert', 'drop-before');
    const error = await failureOf(create()(serviceInput('Dịch vụ E') as never));
    const oldId = (error as ServiceLinksPartialError).serviceId;
    io.server.rows.services.find(row => row.id === oldId)!.deleted_at = '2026-11-26T08:00:00Z';
    const saved = await create()(serviceInput('Dịch vụ E', { continueId: oldId }) as never) as Row;
    expect(saved.id).not.toBe(oldId);
    expect(serviceRows().filter(row => !row.deleted_at)).toHaveLength(1);
    expect(rowsOf('building_services').map(row => row.service_id)).toEqual([saved.id, saved.id]);
  });
  it('dịch vụ đã tạo không còn thấy (đã xoá hẳn): tạo dịch vụ mới, không báo thành công giả trên mã cũ', async () => {
    io.server.failNext('building_services', 'insert', 'drop-before');
    const error = await failureOf(create()(serviceInput('Dịch vụ G') as never));
    const oldId = (error as ServiceLinksPartialError).serviceId;
    io.server.rows.services = io.server.rows.services.filter(row => row.id !== oldId);
    const saved = await create()(serviceInput('Dịch vụ G', { continueId: oldId }) as never) as Row;
    expect(saved.id).not.toBe(oldId);
    expect(rowsOf('building_services').every(row => row.service_id === saved.id)).toBe(true);
  });
  it('đọc lại dịch vụ đã tạo bị hỏng: chưa rõ, không tạo dịch vụ, không gán tòa', async () => {
    io.server.failNext('building_services', 'insert', 'drop-before');
    const first = await failureOf(create()(serviceInput('Dịch vụ H') as never));
    const oldId = (first as ServiceLinksPartialError).serviceId;
    io.server.failNext('services', 'read', 'drop-before');
    const error = await failureOf(create()(serviceInput('Dịch vụ H', { continueId: oldId }) as never));
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    expect(serviceRows()).toHaveLength(1);
    expect(rowsOf('building_services')).toHaveLength(0);
    expect(io.server.inserts.filter(item => item.table === 'services')).toHaveLength(1);
  });  it('dấu bản trước gieo sẵn không chặn; tạo xong thì gỡ', async () => {
    seedOld('service-create', 'create');
    await create()(serviceInput('Dịch vụ F') as never);
    expect(serviceRows()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
});

const tiers = [{ tier_number: 1, from_value: 0, to_value: 50, unit_price: 1_800 }, { tier_number: 2, from_value: 50, to_value: null, unit_price: 2_500 }];
describe('tạo định mức (quota-create)', () => {
  const create = () => mutationOf(renderHook(() => useCreateServiceQuota()).result.current);
  it('lệnh tạo không tới máy chủ: chưa rõ, không dấu; bấm lại đúng một định mức, đủ bậc', async () => {
    io.server.failNext('service_quotas', 'insert', 'drop-before');
    await expect(create()({ name: 'Định mức A', description: null, tiers } as never)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    await create()({ name: 'Định mức A', description: null, tiers } as never);
    expect(rowsOf('service_quotas')).toHaveLength(1);
    expect(sentIds('service_quotas')[1]).toBe(sentIds('service_quotas')[0]);
    expect(rowsOf('service_quota_tiers')).toHaveLength(2);
  });
  it('lệnh tạo tới nhưng mất phản hồi, đọc lại hỏng: bấm lại không tạo định mức thứ hai', async () => {
    io.server.failNext('service_quotas', 'insert', 'drop-after');
    io.server.failNext('service_quotas', 'read', 'drop-before');
    await expect(create()({ name: 'Định mức B', description: null, tiers } as never)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    await create()({ name: 'Định mức B', description: null, tiers } as never);
    expect(rowsOf('service_quotas')).toHaveLength(1);
    expect(rowsOf('service_quota_tiers')).toHaveLength(2);
  });
  it('định mức đã tạo nhưng ghi bậc mất phản hồi: báo mã định mức, không khoá; bấm lại (kèm mã) ghi đúng một bộ bậc cho đúng định mức đó', async () => {
    io.server.failNext('service_quota_tiers', 'insert', 'drop-after');
    const error = await failureOf(create()({ name: 'Định mức C', description: null, tiers } as never));
    expect(error).toBeInstanceOf(ServiceQuotaPartialError);
    const quotaId = rowsOf('service_quotas')[0]?.id;
    expect(error).toMatchObject({ quotaId });
    expect((error as Error).message).toContain(String(quotaId));
    expect(pendingKeys()).toEqual([]);
    await create()({ name: 'Định mức C', description: null, tiers, continueId: quotaId } as never);
    expect(rowsOf('service_quotas')).toHaveLength(1);
    expect(rowsOf('service_quota_tiers').map(row => `${String(row.quota_id)}:${String(row.tier_number)}`).sort()).toEqual([`${String(quotaId)}:1`, `${String(quotaId)}:2`]);
  });
  it('định mức đã tạo bị xoá trước lần bấm tiếp: không ghi bậc vào định mức đã xoá; tạo định mức mới', async () => {
    io.server.failNext('service_quota_tiers', 'insert', 'drop-before');
    const error = await failureOf(create()({ name: 'Định mức E', description: null, tiers } as never));
    const oldId = (error as ServiceQuotaPartialError).quotaId;
    io.server.rows.service_quotas.find(row => row.id === oldId)!.deleted_at = '2026-11-26T08:00:00Z';
    const saved = await create()({ name: 'Định mức E', description: null, tiers, continueId: oldId } as never) as Row;
    expect(saved.id).not.toBe(oldId);
    expect(rowsOf('service_quota_tiers').map(row => row.quota_id)).toEqual([saved.id, saved.id]);
  });
  it('đọc lại định mức đã tạo bị hỏng: chưa rõ, không tạo định mức, không ghi bậc', async () => {
    io.server.failNext('service_quota_tiers', 'insert', 'drop-before');
    const first = await failureOf(create()({ name: 'Định mức F', description: null, tiers } as never));
    io.server.failNext('service_quotas', 'read', 'drop-before');
    const error = await failureOf(create()({ name: 'Định mức F', description: null, tiers, continueId: (first as ServiceQuotaPartialError).quotaId } as never));
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    expect(rowsOf('service_quotas')).toHaveLength(1);
    expect(rowsOf('service_quota_tiers')).toHaveLength(0);
  });  it('dấu bản trước gieo sẵn không chặn; tạo xong thì gỡ', async () => {
    seedOld('quota-create', 'create');
    await create()({ name: 'Định mức D', description: null, tiers } as never);
    expect(rowsOf('service_quotas')).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });
});

threeScenarios('tạo mẫu in thu chi (income-expense-template-create)', { table: 'income_expense_templates', namespace: 'income-expense-template-create', businessKey: 'create', create: () => mutationOf(renderHook(() => useCreateIncomeExpenseTemplate()).result.current), input: () => ({ name: 'Mẫu G1', description: null, template_file_url: null, is_default: false, is_income_template: true }) });
