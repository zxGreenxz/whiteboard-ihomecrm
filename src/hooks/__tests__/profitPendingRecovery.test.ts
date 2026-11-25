// @vitest-environment jsdom
// Đợt 6: chốt / chốt lại / mở khoá / đặt lại lợi nhuận (cách B). Ba hàm production (25/11/2026) giữ khoá tư vấn theo
// (công ty, mã) TRƯỚC khi tra profit_close_runs: cùng mã cùng nội dung ⇒ trả kết quả cũ kèm `idempotent_replay`; khác ⇒
// 23505. Bản trước sinh mã ngẫu nhiên mỗi lần bấm nên gửi lại không dùng được; nay mã suy từ mã yêu cầu của dấu.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useRef: (current: unknown) => ({ current }) }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQuery: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/hooks/profit-ledger/useProfitLedgerMutations', () => ({ invalidateProfitLedgerQueries: vi.fn() }));

import { useCloseProfitPeriod, useResetProfitPeriod, useUnlockProfitMonth } from '../useShareholderProfit';

type Row = Record<string, unknown>;
const ORG = 'org-1';
const PERIOD = '2026-10-01';
const closeInput = (over: Row = {}) => ({ organizationId: ORG, periodMonth: PERIOD, buildingIds: ['b1'], adjustments: [], expectedSourceHash: 'a'.repeat(32), reason: '', reclose: false, ...over });
const unlockInput = { organizationId: ORG, periodMonth: PERIOD, buildingIds: ['b1'], reason: 'Sửa phiếu tháng trước' };
const resetInput = { organizationId: ORG, periodMonth: PERIOD, expectedStateHash: 'h', expectedSnapshotIds: ['s1'], reason: 'Đặt lại để chốt lại', targetBuildingIds: null };
const mutate = (options: unknown, input: unknown) => (options as { mutationFn: (v: unknown) => Promise<Row> }).mutationFn(input);
const keysOf = (name: string) => io.server.rpcCalls.filter(call => call.name === name).map(call => String(call.args.p_idempotency_key));
let writes = 0;
function installProfit(name: string, hashOf: (args: Row) => string) {
  const runs = new Map<string, { hash: string; result: Row }>();
  io.server.rpcHandlers[name] = args => {
    const key = String(args.p_idempotency_key);
    const prior = runs.get(key);
    if (prior) return prior.hash === hashOf(args) ? { data: { ...prior.result, idempotent_replay: true }, error: null } : { data: null, error: { code: '23505', message: 'Idempotency key was already used with a different request' } };
    writes += 1;
    const result = { run_id: `run-${writes}`, affected_buildings: 1, idempotent_replay: false };
    runs.set(key, { hash: hashOf(args), result });
    return { data: result, error: null };
  };
  return runs;
}
const closeHash = (args: Row) => JSON.stringify([args.p_period_month, args.p_building_ids, args.p_adjustments, args.p_reason, args.p_expected_source_hash]);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', ORG);
  writes = 0;
  io.server = fakeRecordServer();
});

describe('chốt lợi nhuận (cách B, mã suy từ dấu)', () => {
  it('lệnh không tới máy chủ: gửi lại ngay đúng mã cũ', async () => {
    installProfit('profit_close_v2', closeHash);
    io.server.failNext('profit_close_v2', 'rpc', 'drop-before');
    await expect(mutate(useCloseProfitPeriod(), closeInput())).rejects.toBeTruthy();
    await expect(mutate(useCloseProfitPeriod(), closeInput())).resolves.toMatchObject({ run_id: 'run-1', idempotent_replay: false });
    expect(keysOf('profit_close_v2')).toHaveLength(2);
    expect(new Set(keysOf('profit_close_v2')).size).toBe(1);
    expect(writes).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: gửi lại cùng mã, máy chủ trả kết quả cũ (idempotent_replay), chỉ một lần chốt', async () => {
    installProfit('profit_close_v2', closeHash);
    io.server.failNext('profit_close_v2', 'rpc', 'drop-after');
    await expect(mutate(useCloseProfitPeriod(), closeInput())).rejects.toBeTruthy();
    await expect(mutate(useCloseProfitPeriod(), closeInput())).resolves.toMatchObject({ run_id: 'run-1', idempotent_replay: true });
    expect(writes).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('mất phản hồi rồi bấm lại khác nội dung ⇒ 23505: báo đã ghi ở lần trước', async () => {
    installProfit('profit_close_v2', closeHash);
    io.server.failNext('profit_close_v2', 'rpc', 'drop-after');
    await expect(mutate(useCloseProfitPeriod(), closeInput())).rejects.toBeTruthy();
    await expect(mutate(useCloseProfitPeriod(), closeInput({ expectedSourceHash: 'b'.repeat(32) }))).rejects.toMatchObject({ alreadyRecorded: true });
    expect(writes).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('chốt lần đầu kẹt không chặn chốt lại (tách khoá); chốt lại dùng mã riêng của nó', async () => {
    installProfit('profit_close_v2', closeHash);
    installProfit('profit_reclose_v2', closeHash);
    io.server.failNext('profit_close_v2', 'rpc', 'drop-before');
    await expect(mutate(useCloseProfitPeriod(), closeInput())).rejects.toBeTruthy();
    await expect(mutate(useCloseProfitPeriod(), closeInput({ reclose: true, reason: 'Chốt lại sau khi sửa' }))).resolves.toMatchObject({ run_id: expect.any(String) });
    expect(keysOf('profit_reclose_v2')[0]).toMatch(/^profit-reclose-/);
  });

  it('dấu chung bản trước `profit-close` (mã máy chủ không nằm trong dấu): chặn chốt tháng đó qua hộp cảnh báo, không gửi', async () => {
    installProfit('profit_close_v2', closeHash);
    seedLegacyPending({ namespace: 'profit-close', userId: 'actor', organizationId: ORG, businessKey: `${ORG}:${PERIOD}` }, new Date(Date.now() - 10 * 60_000));
    await expect(mutate(useCloseProfitPeriod(), closeInput())).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    await expect(mutate(useCloseProfitPeriod(), closeInput({ reclose: true, reason: 'Chốt lại sau khi sửa' }))).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(keysOf('profit_close_v2')).toEqual([]);
  });
});

describe('mở khoá lợi nhuận (cách B)', () => {
  const unlockHash = (args: Row) => JSON.stringify([args.p_period_month, args.p_reason, args.p_building_ids]);
  it('lệnh không tới máy chủ: gửi lại ngay đúng mã cũ', async () => {
    installProfit('profit_unlock_v2', unlockHash);
    io.server.failNext('profit_unlock_v2', 'rpc', 'drop-before');
    await expect(mutate(useUnlockProfitMonth(), unlockInput)).rejects.toBeTruthy();
    await expect(mutate(useUnlockProfitMonth(), unlockInput)).resolves.toMatchObject({ run_id: 'run-1' });
    expect(new Set(keysOf('profit_unlock_v2')).size).toBe(1);
    expect(keysOf('profit_unlock_v2')[0]).toMatch(/^profit-unlock-/);
  });

  it('tới nhưng mất phản hồi: máy chủ trả kết quả cũ, chỉ một lần mở', async () => {
    installProfit('profit_unlock_v2', unlockHash);
    io.server.failNext('profit_unlock_v2', 'rpc', 'drop-after');
    await expect(mutate(useUnlockProfitMonth(), unlockInput)).rejects.toBeTruthy();
    await expect(mutate(useUnlockProfitMonth(), unlockInput)).resolves.toMatchObject({ idempotent_replay: true });
    expect(writes).toBe(1);
  });

  it('dấu cũ gieo sẵn (mã máy chủ ngẫu nhiên không nằm trong dấu): hộp cảnh báo, không gửi bằng mã đoán', async () => {
    installProfit('profit_unlock_v2', unlockHash);
    seedLegacyPending({ namespace: 'profit-unlock', userId: 'actor', organizationId: ORG, businessKey: `${ORG}:${PERIOD}` }, new Date(Date.now() - 10 * 60_000));
    await expect(mutate(useUnlockProfitMonth(), unlockInput)).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(keysOf('profit_unlock_v2')).toEqual([]);
    expect(pendingKeys()).toHaveLength(1);
  });
});

describe('đặt lại lợi nhuận (cách B)', () => {
  const resetHash = (args: Row) => JSON.stringify([args.p_period_month, args.p_reason, args.p_expected_state_hash, args.p_expected_snapshot_ids]);
  const reset = { ...resetInput, expectedSnapshotIds: ['s1'] };
  it('lệnh không tới máy chủ: gửi lại ngay đúng mã cũ', async () => {
    installProfit('profit_reset_checked_v2', resetHash);
    io.server.failNext('profit_reset_checked_v2', 'rpc', 'drop-before');
    await expect(mutate(useResetProfitPeriod(), reset)).rejects.toBeTruthy();
    await expect(mutate(useResetProfitPeriod(), reset)).resolves.toMatchObject({ run_id: 'run-1' });
    expect(new Set(keysOf('profit_reset_checked_v2')).size).toBe(1);
  });

  it('tới nhưng mất phản hồi: máy chủ trả kết quả cũ, chỉ một lần đặt lại', async () => {
    installProfit('profit_reset_checked_v2', resetHash);
    io.server.failNext('profit_reset_checked_v2', 'rpc', 'drop-after');
    await expect(mutate(useResetProfitPeriod(), reset)).rejects.toBeTruthy();
    await expect(mutate(useResetProfitPeriod(), reset)).resolves.toMatchObject({ idempotent_replay: true });
    expect(writes).toBe(1);
  });

  it('dấu cũ gieo sẵn: hộp cảnh báo, không gửi', async () => {
    installProfit('profit_reset_checked_v2', resetHash);
    seedLegacyPending({ namespace: 'profit-reset', userId: 'actor', organizationId: ORG, businessKey: `${ORG}:${PERIOD}` }, new Date(Date.now() - 10 * 60_000));
    await expect(mutate(useResetProfitPeriod(), reset)).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(keysOf('profit_reset_checked_v2')).toEqual([]);
  });
});
