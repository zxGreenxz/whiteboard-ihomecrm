// @vitest-environment jsdom
// Đợt 8: cổ đông và quản lý lợi nhuận. Đồng bộ tỷ lệ toà (xoá toà bỏ đi + upsert theo (toà, cổ đông)) và sửa quản lý
// (đặt hồ sơ, xoá rồi chèn lại toàn bộ quy tắc lương) chạy lại cho cùng kết quả ⇒ không giữ dấu. Thêm mới tra theo tài
// khoản trước khi chèn (production 26/11/2026: hai bảng cổ đông và quản lý đều có chỉ mục duy nhất theo tài khoản):
// lần thêm trước chưa rõ kết quả mà đã tạo ⇒ báo mã, không tạo lần hai.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, NETWORK_ERROR, type FakeRecordServer } from './fakeRecordServer';

type Row = Record<string, unknown>;
type Drop = 'drop-before' | 'drop-after';
const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, upsertDrops: {} as Record<string, Drop[]> }));

/** Máy chủ giả chưa có `upsert`: thêm cục bộ, theo cột xung đột như PostgREST (`onConflict`). */
function withUpsert(table: string) {
  const query = io.server.from(table) as Row;
  query.upsert = (payload: Row | Row[], options?: { onConflict?: string }) => {
    const run = () => {
      const drop = io.upsertDrops[table]?.shift();
      if (drop === 'drop-before') return { data: null, error: NETWORK_ERROR };
      const rows = (io.server.rows[table] ??= []);
      const columns = (options?.onConflict ?? 'id').split(',');
      const stored = (Array.isArray(payload) ? payload : [payload]).map((row, index) => {
        const existing = rows.find(item => columns.every(column => item[column] === row[column]));
        if (existing) return Object.assign(existing, row);
        const created = { id: `${table}-up-${rows.length + index + 1}`, ...row };
        rows.push(created);
        return created;
      });
      if (drop === 'drop-after') return { data: null, error: NETWORK_ERROR };
      return { data: stored.map(row => ({ ...row })), error: null };
    };
    const chain = { select: () => chain, then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject) };
    return chain;
  };
  return query;
}

vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => withUpsert(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/actionFeedback', () => ({ notifyActionError: vi.fn() }));

import { useCreateShareholder, useSyncShareholderBuildings, useUpdateShareholder } from '../useShareholders';
import { useSaveManagerWithSalaries } from '../useProfitManagers';
import { RepeatableWriteUnknownError } from '@/lib/financialWorkflow';

type Writer = (input: unknown) => Promise<unknown>;
const writerOf = (hook: unknown) => (hook as { mutationFn: Writer }).mutationFn;
const TEN_PHUT = 10 * 60_000;
const scopeOf = (namespace: string, businessKey: string) => ({ namespace, userId: 'actor', organizationId: 'org-a', businessKey });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  io.server = fakeRecordServer();
  io.upsertDrops = {};
});

describe('đồng bộ tỷ lệ toà của cổ đông (cách A đặt cả bộ)', () => {
  const sync = () => writerOf(renderHook(() => useSyncShareholderBuildings()).result.current);
  const input = { shareholder_id: 's1', rows: [{ building_id: 'b1', percent: 30 }, { building_id: 'b2', percent: 40 }] };
  const shares = () => io.server.rows.building_shareholders.filter(row => row.shareholder_id === 's1').map(row => `${row.building_id}:${row.percent}`).sort();
  beforeEach(() => {
    io.server.rows.building_shareholders = [
      { id: 'bs-old', building_id: 'b-old', shareholder_id: 's1', percent: 10, user_id: 'actor', organization_id: 'org-a' },
      { id: 'bs-1', building_id: 'b1', shareholder_id: 's1', percent: 20, user_id: 'actor', organization_id: 'org-a' },
      { id: 'bs-x', building_id: 'b1', shareholder_id: 's2', percent: 50, user_id: 'actor', organization_id: 'org-a' },
    ];
  });

  it('lệnh xoá không tới máy chủ: báo chưa rõ, không để dấu, bấm lại ra đúng bộ tỷ lệ', async () => {
    io.server.failNext('building_shareholders', 'delete', 'drop-before');
    await expect(sync()(input)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    await expect(sync()(input)).resolves.toBeUndefined();
    expect(shares()).toEqual(['b1:30', 'b2:40']);
  });

  it('upsert tới nhưng mất phản hồi: bấm lại cho đúng một dòng mỗi toà, không nhân đôi', async () => {
    io.upsertDrops.building_shareholders = ['drop-after'];
    await expect(sync()(input)).rejects.toMatchObject({ outcome: 'unknown', repeatable: true });
    await expect(sync()(input)).resolves.toBeUndefined();
    expect(shares()).toEqual(['b1:30', 'b2:40']);
    expect(io.server.rows.building_shareholders.find(row => row.id === 'bs-x')).toMatchObject({ percent: 50 });
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước gieo sẵn: không chặn, gỡ sau lần lưu thành công', async () => {
    seedLegacyPending(scopeOf('shareholder-sync', 's1'), new Date(Date.now() - TEN_PHUT));
    await expect(sync()(input)).resolves.toBeUndefined();
    expect(pendingKeys()).toEqual([]);
  });

  it('xoá toà bỏ đi khớp 0 dòng mà dòng còn nguyên (RLS): từ chối rõ, không upsert, không để dấu', async () => {
    io.server.writable.building_shareholders = row => row.id !== 'bs-old';
    await expect(sync()(input)).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('quyền') });
    expect(shares()).toEqual(['b-old:10', 'b1:20']);
    expect(pendingKeys()).toEqual([]);
  });

  it('dòng toà cũ đã bị xoá ở nơi khác (khớp 0 dòng, không còn): coi như đã xoá, lưu tiếp phần còn lại', async () => {
    // Đọc cấu hình xong thì dòng toà cũ bị xoá ở nơi khác, ngay trước lệnh xoá của lượt này.
    const original = io.server.from.bind(io.server);
    let deletedElsewhere = false;
    io.server.from = (table: string) => {
      const query = original(table) as Row;
      if (table === 'building_shareholders') {
        const remove = query.delete as () => unknown;
        query.delete = () => {
          if (!deletedElsewhere) { deletedElsewhere = true; io.server.rows.building_shareholders = io.server.rows.building_shareholders.filter(row => row.id !== 'bs-old'); }
          return remove();
        };
      }
      return query;
    };
    await expect(sync()(input)).resolves.toBeUndefined();
    expect(deletedElsewhere).toBe(true);
    expect(shares()).toEqual(['b1:30', 'b2:40']);
  });
});

describe('lưu quản lý và lương điều hành', () => {
  const save = () => writerOf(renderHook(() => useSaveManagerWithSalaries()).result.current);
  const rules = [{ label: 'Lương', form: 'FIXED', basis: 'PER_BUILDING', amount: 100, percent: 0, building_ids: ['b1', 'b2'] }];
  const editInput = { id: 'm1', values: { name: 'An mới', note: null, is_active: true, auth_user_id: 'acc1' }, rules };
  const createInput = { values: { name: 'Bình', note: null, is_active: true, auth_user_id: 'acc2' }, rules };
  const liveRules = (managerId: string) => io.server.rows.profit_manager_salaries.filter(row => row.manager_id === managerId);
  const liveLinks = (managerId: string) => {
    const ids = new Set(liveRules(managerId).map(row => row.id));
    return (io.server.rows.profit_manager_salary_buildings ?? []).filter(row => ids.has(row.salary_id));
  };
  const managersOf = (account: string) => io.server.rows.profit_managers.filter(row => row.auth_user_id === account);
  beforeEach(() => {
    io.server.rows.profit_managers = [{ id: 'm1', name: 'An', note: null, is_active: true, auth_user_id: 'acc1', deleted_at: null, organization_id: 'org-a', user_id: 'actor' }];
    io.server.rows.profit_manager_salaries = [{ id: 'r-old', manager_id: 'm1', label: 'Cũ', form: 'FIXED', basis: 'PER_BUILDING', amount: 50, percent: 0, is_active: true }];
    io.server.rows.profit_manager_salary_buildings = [{ id: 'l-old', salary_id: 'r-old', building_id: 'b9' }];
  });

  it('sửa: lệnh không tới máy chủ ⇒ báo chưa rõ, không để dấu, bấm lại ghi được đúng bộ quy tắc', async () => {
    io.server.failNext('profit_managers', 'update', 'drop-before');
    await expect(save()(editInput)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(liveRules('m1').map(row => row.id)).toEqual(['r-old']);
    expect(pendingKeys()).toEqual([]);
    await expect(save()(editInput)).resolves.toEqual({ managerId: 'm1' });
    expect(liveRules('m1')).toEqual([expect.objectContaining({ label: 'Lương', amount: 100 })]);
    expect(liveLinks('m1').map(row => row.building_id).sort()).toEqual(['b1', 'b2']);
  });

  it('sửa: chèn quy tắc tới nhưng mất phản hồi ⇒ bấm lại cho đúng một quy tắc, không nhân đôi lương', async () => {
    io.server.failNext('profit_manager_salaries', 'insert', 'drop-after');
    await expect(save()(editInput)).rejects.toMatchObject({ outcome: 'unknown', repeatable: true, completed: expect.arrayContaining([expect.objectContaining({ id: 'm1' })]) });
    expect(pendingKeys()).toEqual([]);
    await expect(save()(editInput)).resolves.toEqual({ managerId: 'm1' });
    expect(liveRules('m1')).toHaveLength(1);
    expect(liveLinks('m1')).toHaveLength(2);
    expect(io.server.rows.profit_managers[0]).toMatchObject({ name: 'An mới' });
  });

  it('sửa: dấu bản trước gieo sẵn ⇒ không chặn, gỡ sau lần lưu thành công', async () => {
    seedLegacyPending(scopeOf('profit-manager-save', 'm1'), new Date(Date.now() - TEN_PHUT));
    await expect(save()(editInput)).resolves.toEqual({ managerId: 'm1' });
    expect(pendingKeys()).toEqual([]);
  });

  it('sửa khớp 0 dòng (RLS / hồ sơ đã mất): từ chối rõ, không xoá quy tắc cũ, không để dấu', async () => {
    io.server.writable.profit_managers = () => false;
    await expect(save()(editInput)).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('không tìm thấy') });
    expect(liveRules('m1').map(row => row.id)).toEqual(['r-old']);
    expect(pendingKeys()).toEqual([]);
  });

  it('sửa: xoá quy tắc cũ khớp 0 dòng mà quy tắc còn nguyên (RLS) ⇒ từ chối rõ, không chèn quy tắc mới, không để dấu', async () => {
    io.server.writable.profit_manager_salaries = () => false;
    await expect(save()(editInput)).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('quyền') });
    expect(liveRules('m1').map(row => row.id)).toEqual(['r-old']);
    expect(io.server.inserts.filter(item => item.table === 'profit_manager_salaries')).toHaveLength(0);
    expect(pendingKeys()).toEqual([]);
  });

  it('sửa: chèn quy tắc mới bị từ chối rõ sau khi đã xoá quy tắc cũ ⇒ báo rõ đã xoá mà chưa ghi lại, không khoá, lưu lại được', async () => {
    io.server.rows.profit_manager_salaries.push({ id: 'r-other', manager_id: 'm2', label: 'Lương' });
    io.server.uniqueBy.profit_manager_salaries = row => String(row.label);
    const error = await save()(editInput).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ outcome: 'failure', completed: expect.arrayContaining([expect.objectContaining({ id: 'm1' })]) });
    expect((error as Error).message).toContain('xoá quy tắc lương cũ');
    expect((error as Error).message).toContain('Lưu lại');
    expect(liveRules('m1')).toHaveLength(0);
    expect(pendingKeys()).toEqual([]);
    delete io.server.uniqueBy.profit_manager_salaries;
    await expect(save()(editInput)).resolves.toEqual({ managerId: 'm1' });
    expect(liveRules('m1')).toHaveLength(1);
  });

  it('thêm mới: chèn hồ sơ tới nhưng mất phản hồi ⇒ lần lưu sau tra theo tài khoản, báo mã đã tạo, không tạo lần hai', async () => {
    io.server.failNext('profit_managers', 'insert', 'drop-after');
    await expect(save()(createInput)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    const [created] = managersOf('acc2');
    const error = await save()(createInput).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ alreadyRecorded: true, recordIds: [created.id] });
    expect((error as Error).message).toContain(String(created.id));
    expect(managersOf('acc2')).toHaveLength(1);
    expect(io.server.inserts.filter(item => item.table === 'profit_managers')).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('thêm mới: lệnh không tới máy chủ ⇒ bấm lại tạo đúng một hồ sơ', async () => {
    io.server.failNext('profit_managers', 'insert', 'drop-before');
    await expect(save()(createInput)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(managersOf('acc2')).toHaveLength(0);
    const result = await save()(createInput) as { managerId: string };
    expect(managersOf('acc2')).toEqual([expect.objectContaining({ id: result.managerId })]);
    expect(liveRules(result.managerId)).toHaveLength(1);
  });

  it('thêm mới: dấu bản trước gieo sẵn (khoá new:tài khoản) ⇒ không chặn, gỡ sau lần tạo thành công', async () => {
    seedLegacyPending(scopeOf('profit-manager-save', 'new:acc2'), new Date(Date.now() - TEN_PHUT));
    await expect(save()(createInput)).resolves.toMatchObject({ managerId: expect.any(String) });
    expect(pendingKeys()).toEqual([]);
  });

  it('thêm mới: dấu bản trước và lần tạo cũ đã ghi (tài khoản đã có hồ sơ) ⇒ báo mã, gỡ dấu, không chèn', async () => {
    seedLegacyPending(scopeOf('profit-manager-save', 'new:acc2'), new Date(Date.now() - TEN_PHUT), ['m-old']);
    io.server.rows.profit_managers.push({ id: 'm-old', name: 'Bình', auth_user_id: 'acc2', deleted_at: null, organization_id: 'org-a', user_id: 'actor' });
    await expect(save()(createInput)).rejects.toMatchObject({ alreadyRecorded: true, recordIds: ['m-old'] });
    expect(io.server.inserts).toHaveLength(0);
    expect(pendingKeys()).toEqual([]);
  });

  it('thêm mới: không đọc được hồ sơ theo tài khoản ⇒ chưa rõ, không chèn, không để dấu', async () => {
    io.server.failNext('profit_managers', 'read', 'drop-before');
    await expect(save()(createInput)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(io.server.inserts).toHaveLength(0);
    expect(pendingKeys()).toEqual([]);
  });

  it('bấm đúp: lượt thứ hai cùng hồ sơ bị từ chối khi lượt đầu chưa xong, không nhân đôi quy tắc', async () => {
    const writer = save();
    const [first, second] = await Promise.allSettled([writer(editInput), writer(editInput)]);
    expect(first).toMatchObject({ status: 'fulfilled' });
    expect(second).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ outcome: 'failure' }) });
    expect(liveRules('m1')).toHaveLength(1);
  });
});

describe('hồ sơ cổ đông (form lưu cổ đông bỏ dấu lồng)', () => {
  const create = () => writerOf(renderHook(() => useCreateShareholder()).result.current);
  const update = () => writerOf(renderHook(() => useUpdateShareholder()).result.current);
  const values = { name: 'Chi', note: null, is_active: true, auth_user_id: 'acc3' };
  beforeEach(() => {
    io.server.rows.shareholders = [{ id: 's1', name: 'An', note: null, is_active: true, auth_user_id: 'acc1', deleted_at: null, organization_id: 'org-a', user_id: 'actor' }];
    // Production có chỉ mục duy nhất theo tài khoản: mỗi tài khoản một hồ sơ cổ đông.
    io.server.uniqueBy.shareholders = row => String(row.auth_user_id);
  });

  it('thêm mới tới nhưng mất phản hồi: lần lưu sau tra theo tài khoản, báo mã đã tạo, không tạo lần hai', async () => {
    io.server.failNext('shareholders', 'insert', 'drop-after');
    await expect(create()(values)).rejects.toBeTruthy();
    const created = io.server.rows.shareholders.find(row => row.auth_user_id === 'acc3');
    const error = await create()(values).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ alreadyRecorded: true, recordIds: [created?.id] });
    expect(io.server.inserts.filter(item => item.table === 'shareholders')).toHaveLength(1);
  });

  it('tài khoản đã có hồ sơ cổ đông: báo mã, không gửi lệnh chèn', async () => {
    const error = await create()({ ...values, auth_user_id: 'acc1' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ alreadyRecorded: true, recordIds: ['s1'] });
    expect(io.server.inserts).toHaveLength(0);
  });

  it('không đọc được hồ sơ theo tài khoản: chưa rõ, không gửi lệnh chèn', async () => {
    io.server.failNext('shareholders', 'read', 'drop-before');
    await expect(create()(values)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(io.server.inserts).toHaveLength(0);
  });

  it('thêm mới lệnh không tới máy chủ: bấm lại tạo đúng một hồ sơ', async () => {
    io.server.failNext('shareholders', 'insert', 'drop-before');
    await expect(create()(values)).rejects.toBeTruthy();
    await expect(create()(values)).resolves.toMatchObject({ auth_user_id: 'acc3' });
    expect(io.server.rows.shareholders.filter(row => row.auth_user_id === 'acc3')).toHaveLength(1);
  });

  it('sửa khớp 0 dòng (RLS / hồ sơ đã mất): từ chối rõ, không phải chưa rõ', async () => {
    io.server.writable.shareholders = () => false;
    const error = await update()({ id: 's1', values: { name: 'An', note: null, is_active: true, auth_user_id: 'acc1' } }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ outcome: 'failure', message: expect.stringContaining('không tìm thấy') });
  });

  it('sửa tới nhưng mất phản hồi: bấm lại đặt đúng giá trị đó', async () => {
    io.server.failNext('shareholders', 'update', 'drop-after');
    const patch = { id: 's1', values: { name: 'An sửa', note: 'x', is_active: true, auth_user_id: 'acc1' } };
    await expect(update()(patch)).rejects.toBeTruthy();
    await expect(update()(patch)).resolves.toBeUndefined();
    expect(io.server.rows.shareholders[0]).toMatchObject({ name: 'An sửa', note: 'x' });
  });
});
