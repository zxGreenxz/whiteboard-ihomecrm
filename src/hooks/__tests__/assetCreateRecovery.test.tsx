// @vitest-environment jsdom
// Đợt 9 (plan sửa khoá vĩnh viễn sau rớt mạng, luật 5): TẠO tài sản, biên bản bàn giao, di chuyển, bảo trì không giữ dấu
// «chờ đối chiếu» nữa. Mã do trình duyệt sinh (`createRecordOnce`; production 26/11/2026: bốn bảng có `id uuid default
// gen_random_uuid()`, trigger BEFORE INSERT không đụng `new.id`, duy nhất chỉ khoá chính), lần bấm lại gửi ĐÚNG mã cũ nên
// khoá chính chặn bản thứ hai. Kết quả chưa rõ báo rõ, không khoá form; dấu bản trước (khoá chung `create`) gỡ sau lần tạo.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from './fakeRecordServer';

type Row = Record<string, unknown>;
const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table) } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { FinancialAlreadyRecordedError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import { recordWriteBlocked } from '@/lib/recordWriteOutcome';
import { forgetUnconfirmedCreates } from '@/lib/clientRecordCreate';
import { useCreateAsset, useCreateAssetHandover, useCreateAssetMaintenance, useCreateAssetMovement } from '../useAssets';

type Run = (input: unknown) => Promise<unknown>;
interface Kind { table: string; namespace: string; run: () => Run; input: Row; changed: Row }
const KINDS: Array<[string, Kind]> = [
  ['tài sản', {
    table: 'assets', namespace: 'asset-create',
    run: () => { const { result } = renderHook(() => useCreateAsset()); return (result.current as unknown as { mutationFn: Run }).mutationFn; },
    input: { name: 'Ghế xoay', code: 'TS-01', category_id: 'cat-1', supplier_id: null, quantity: 2, condition: 'GOOD', purchase_date: null, purchase_price: 500, building_id: null, room_id: null, description: null },
    changed: { quantity: 3 },
  }],
  ['biên bản bàn giao', {
    table: 'asset_handovers', namespace: 'asset-handover-create',
    run: () => { const { result } = renderHook(() => useCreateAssetHandover()); return (result.current as unknown as { mutationFn: Run }).mutationFn; },
    input: { contract_id: 'hd-1', type: 'CHECK_IN', handover_date: '2026-11-26', items: '{"items":[]}' },
    changed: { items: '{"items":["ghế"]}' },
  }],
  ['di chuyển tài sản', {
    table: 'asset_movements', namespace: 'asset-movement-create',
    run: () => { const { result } = renderHook(() => useCreateAssetMovement()); return (result.current as unknown as { mutationFn: Run }).mutationFn; },
    input: { asset_id: 'ts-1', from_room_id: null, to_room_id: 'phong-2', quantity: 1, movement_date: '2026-11-26', from_location: null, to_location: 'P2', reason: null },
    changed: { to_room_id: 'phong-3', to_location: 'P3' },
  }],
  ['phiếu bảo trì', {
    table: 'asset_maintenance', namespace: 'asset-maintenance-create',
    run: () => { const { result } = renderHook(() => useCreateAssetMaintenance()); return (result.current as unknown as { mutationFn: Run }).mutationFn; },
    input: { asset_id: 'ts-1', issue_description: 'Hỏng chân ghế', maintenance_date: '2026-11-26', status: 'PENDING', cost: null, assigned_to: null, notes: null },
    changed: { notes: 'cần gấp' },
  }],
];

const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);
const rows = (table: string): Row[] => io.server.rows[table] ?? [];
const sentIds = (table: string) => io.server.inserts.filter(item => item.table === table).map(item => (item.payload as Row).id);

beforeEach(() => {
  io.server = fakeRecordServer();
  forgetUnconfirmedCreates();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
});

describe.each(KINDS)('tạo %s', (_label, kind) => {
  it('lệnh không tới máy chủ: báo rõ, không khoá, không dấu; bấm lại tạo đúng một bản', async () => {
    io.server.failNext(kind.table, 'insert', 'drop-before');
    const error = await kind.run()(kind.input).catch(failure => failure);
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    expect(recordWriteBlocked(error)).toBe(false);
    expect(pendingKeys()).toEqual([]);
    expect(rows(kind.table)).toEqual([]);
    await kind.run()(kind.input);
    expect(rows(kind.table)).toHaveLength(1);
    expect(rows(kind.table)[0]).toMatchObject({ ...kind.input, user_id: 'actor', organization_id: 'org-a' });
  });

  it('tới nhưng mất phản hồi: bấm lại gửi đúng mã cũ, báo đã tạo ở lần trước, không có bản thứ hai', async () => {
    io.server.failNext(kind.table, 'insert', 'drop-after');
    const error = await kind.run()(kind.input).catch(failure => failure);
    expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
    expect(recordWriteBlocked(error)).toBe(false);
    expect(pendingKeys()).toEqual([]);
    const created = await kind.run()(kind.input);
    expect(created).toMatchObject({ id: rows(kind.table)[0].id, replayed: true });
    expect(rows(kind.table)).toHaveLength(1);
    expect(new Set(sentIds(kind.table)).size).toBe(1);
    expect(sentIds(kind.table)).toHaveLength(2);
  });

  it('mất phản hồi và đọc lại cũng hỏng: vẫn chưa rõ (không báo xong); bấm lại sau đó ra đúng một bản', async () => {
    io.server.failNext(kind.table, 'insert', 'drop-after');
    await kind.run()(kind.input).catch(failure => failure);
    io.server.failNext(kind.table, 'read', 'drop-before');
    expect(await kind.run()(kind.input).catch(failure => failure)).toBeInstanceOf(RepeatableWriteUnknownError);
    await kind.run()(kind.input);
    expect(rows(kind.table)).toHaveLength(1);
    expect(new Set(sentIds(kind.table)).size).toBe(1);
  });

  it('sửa thông tin giữa hai lần bấm khi lần trước đã ghi: báo đã tạo kèm mã, không tạo thêm; bấm lại nữa là lượt mới', async () => {
    io.server.failNext(kind.table, 'insert', 'drop-after');
    await kind.run()(kind.input).catch(failure => failure);
    const id = String(rows(kind.table)[0].id);
    const changed = { ...kind.input, ...kind.changed };
    const error = await kind.run()(changed).catch(failure => failure);
    expect(error).toBeInstanceOf(FinancialAlreadyRecordedError);
    expect((error as Error).message).toContain(id);
    expect(recordWriteBlocked(error)).toBe(false);
    expect(rows(kind.table)).toHaveLength(1);
    await kind.run()(changed);
    expect(rows(kind.table)).toHaveLength(2);
  });

  it('dấu bản trước (khoá create) gieo sẵn ≥ 10 phút không chặn; tạo xong thì gỡ', async () => {
    seedLegacyPending({ namespace: kind.namespace, userId: 'actor', organizationId: 'org-a', businessKey: 'create' }, TEN_MINUTES_AGO());
    const other = seedLegacyPending({ namespace: 'vehicle-create', userId: 'actor', organizationId: 'org-a', businessKey: 'create' }, TEN_MINUTES_AGO());
    await kind.run()(kind.input);
    expect(rows(kind.table)).toHaveLength(1);
    expect(pendingKeys()).toEqual([other]);
  });
});
