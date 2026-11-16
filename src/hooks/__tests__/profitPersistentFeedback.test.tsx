// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ rpc: vi.fn(), userId: 'actor-a' }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: m.rpc } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: m.userId }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [] }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
import { useCloseProfitPeriod, useResetProfitPeriod, useUnlockProfitMonth, type CloseProfitPeriodInput, type ResetProfitPeriodInput, type UnlockProfitMonthInput } from '../useShareholderProfit';
import { financialPending } from '@/lib/financialPending';
const org = 'dddd0000-0000-4000-8000-000000000001';
type ProfitInput = CloseProfitPeriodInput & ResetProfitPeriodInput & UnlockProfitMonthInput;
const base: ProfitInput = { organizationId: org, periodMonth: '2026-07-01', buildingIds: ['b1'], reason: 'Đối chiếu lại phiếu thu chi', expectedSourceHash: 'source-hash', adjustments: [], expectedStateHash: 'state-hash', expectedSnapshotIds: ['s1'], targetBuildingIds: ['b1'], reclose: false };
const cases = [ ['profit-close', useCloseProfitPeriod], ['profit-unlock', useUnlockProfitMonth], ['profit-reset', useResetProfitPeriod] ] as const;
function mount(hook: typeof useCloseProfitPeriod | typeof useResetProfitPeriod | typeof useUnlockProfitMonth) {
 const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>;
 return renderHook(() => hook() as unknown as { mutateAsync: (input: ProfitInput) => Promise<unknown> }, { wrapper });
}
beforeEach(() => { localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', org); m.userId = 'actor-a'; m.rpc.mockReset(); });
afterEach(cleanup);
const keyOf = (call: number) => (m.rpc.mock.calls[call][1] as { p_idempotency_key: string }).p_idempotency_key;
const scopeOf = (namespace: string) => ({ namespace, userId: 'actor-a', organizationId: org, businessKey: `${org}:2026-07-01` });
const confirmed = { data: { run_id: 'run-confirmed', affected_buildings: 1, idempotent_replay: false }, error: null };
it.each(cases)('%s unknown survives remount; lần sau hỏi lại máy chủ bằng ĐÚNG khoá cũ, không gửi khoá mới', async (namespace, hook) => {
 m.rpc.mockResolvedValue({ data: null, error: null }); const first = mount(hook);
 await act(async () => { await expect(first.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); }); first.unmount();
 const pending = financialPending.read(scopeOf(namespace)); expect(pending).not.toBeNull();
 expect(keyOf(0)).toBe(`${namespace}-${pending!.requestKey}`);
 const second = mount(hook); await act(async () => { await expect(second.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); });
 expect(m.rpc).toHaveBeenCalledTimes(2); expect(keyOf(1)).toBe(keyOf(0));
 expect(financialPending.read(scopeOf(namespace))?.attemptId).toBe(pending!.attemptId);
});
it.each(cases)('%s mất phản hồi rồi máy chủ trả kết quả dưới khoá cũ ⇒ gỡ dấu, lần sau dùng khoá mới', async (namespace, hook) => {
 m.rpc.mockResolvedValueOnce({ data: null, error: null }); const first = mount(hook);
 await act(async () => { await expect(first.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); }); first.unmount();
 m.rpc.mockResolvedValue({ data: { run_id: 'run-replayed', affected_buildings: 1, idempotent_replay: true }, error: null }); const second = mount(hook);
 await act(async () => { await expect(second.result.current.mutateAsync(base)).resolves.toMatchObject({ run_id: 'run-replayed', idempotent_replay: true }); });
 expect(keyOf(1)).toBe(keyOf(0)); expect(financialPending.read(scopeOf(namespace))).toBeNull();
 await act(async () => { await expect(second.result.current.mutateAsync(base)).resolves.toMatchObject({ run_id: 'run-replayed' }); });
 expect(m.rpc).toHaveBeenCalledTimes(3); expect(keyOf(2)).not.toBe(keyOf(0));
});
it.each(cases)('%s khoá cũ đã ghi yêu cầu khác (23505) ⇒ lượt trước đã ghi xong: gỡ dấu, báo failure, không khoá nút', async (namespace, hook) => {
 m.rpc.mockResolvedValueOnce({ data: null, error: null }); const first = mount(hook);
 await act(async () => { await expect(first.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); }); first.unmount();
 m.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'Idempotency key was already used with a different request' } }); const second = mount(hook);
 await act(async () => { await expect(second.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('đã được máy chủ ghi xong') }); });
 expect(keyOf(1)).toBe(keyOf(0)); expect(financialPending.read(scopeOf(namespace))).toBeNull();
 m.rpc.mockResolvedValue(confirmed);
 await act(async () => { await expect(second.result.current.mutateAsync(base)).resolves.toMatchObject({ run_id: 'run-confirmed' }); });
 expect(keyOf(2)).not.toBe(keyOf(0));
});
it('23505 khác câu (trùng khoá duy nhất thật) KHÔNG được coi là lượt trước đã ghi: giữ dấu', async () => {
 m.rpc.mockResolvedValueOnce({ data: null, error: null }); const first = mount(useCloseProfitPeriod);
 await act(async () => { await expect(first.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); }); first.unmount();
 m.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "x"' } }); const second = mount(useCloseProfitPeriod);
 await act(async () => { await expect(second.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'failure' }); });
 expect(financialPending.read(scopeOf('profit-close'))).not.toBeNull();
});
it('đối chiếu bị máy chủ từ chối (hash nguồn cũ) ⇒ hiện đúng lý do, giữ dấu; sửa xong gửi lại khoá cũ thì gỡ dấu', async () => {
 m.rpc.mockResolvedValueOnce({ data: null, error: null }); const first = mount(useCloseProfitPeriod);
 await act(async () => { await expect(first.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); }); first.unmount();
 m.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PT409', message: 'PROFIT_SOURCE_CONFLICT expected a, current b' } }); const second = mount(useCloseProfitPeriod);
 await act(async () => { await expect(second.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining('Dữ liệu hoặc trạng thái tháng vừa thay đổi') }); });
 expect(financialPending.read(scopeOf('profit-close'))).not.toBeNull();
 m.rpc.mockResolvedValue(confirmed);
 await act(async () => { await expect(second.result.current.mutateAsync({ ...base, expectedSourceHash: 'fresh-hash' })).resolves.toMatchObject({ run_id: 'run-confirmed' }); });
 expect(keyOf(2)).toBe(keyOf(0)); expect(financialPending.read(scopeOf('profit-close'))).toBeNull();
});
it('đối chiếu vướng kiểm tra trước khi gửi ⇒ báo đúng câu kiểm tra, không gọi máy chủ, giữ dấu', async () => {
 m.rpc.mockResolvedValueOnce({ data: null, error: null }); const first = mount(useCloseProfitPeriod);
 await act(async () => { await expect(first.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); }); first.unmount();
 const second = mount(useCloseProfitPeriod);
 await act(async () => { await expect(second.result.current.mutateAsync({ ...base, buildingIds: [] })).rejects.toMatchObject({ outcome: 'failure', message: 'Không có nhà để chốt' }); });
 expect(m.rpc).toHaveBeenCalledTimes(1); expect(financialPending.read(scopeOf('profit-close'))).not.toBeNull();
});
it.each(cases)('%s dấu của bản web cũ (khoá gửi đi không lưu) không còn chặn vĩnh viễn — sự cố chốt kỳ 09/2026', async (namespace, hook) => {
 const legacy = financialPending.markPending(scopeOf(namespace), { attemptId: 'legacy-attempt', requestKey: 'legacy-attempt' });
 m.rpc.mockResolvedValue(confirmed); const mounted = mount(hook);
 await act(async () => { await expect(mounted.result.current.mutateAsync(base)).resolves.toMatchObject({ run_id: 'run-confirmed' }); });
 expect(m.rpc).toHaveBeenCalledOnce(); expect(keyOf(0)).toBe(`${namespace}-${legacy.requestKey}`);
 expect(financialPending.read(scopeOf(namespace))).toBeNull();
});
it('chốt lại sau lượt chốt mất phản hồi vẫn gửi đúng khoá cũ (chốt / chốt lại chung tiền tố)', async () => {
 m.rpc.mockResolvedValueOnce({ data: null, error: null }); const first = mount(useCloseProfitPeriod);
 await act(async () => { await expect(first.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); }); first.unmount();
 m.rpc.mockResolvedValue(confirmed); const second = mount(useCloseProfitPeriod);
 await act(async () => { await expect(second.result.current.mutateAsync({ ...base, reclose: true })).resolves.toMatchObject({ run_id: 'run-confirmed' }); });
 expect(m.rpc.mock.calls[1][0]).toBe('profit_reclose_v2'); expect(keyOf(1)).toBe(keyOf(0));
});
it.each(['actor', 'organization', 'month'] as const)('pending unlock does not block another %s; về lại phạm vi cũ thì đối chiếu bằng khoá cũ', async dimension => {
 m.rpc.mockResolvedValue({ data: null, error: null }); const first = mount(useUnlockProfitMonth); await act(async () => { await expect(first.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); }); first.unmount();
 const next = { ...base }; if (dimension === 'actor') m.userId = 'actor-b'; if (dimension === 'organization') { next.organizationId = 'org-b'; localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-b'); } if (dimension === 'month') next.periodMonth = '2026-08-01';
 m.rpc.mockResolvedValue(confirmed); const second = mount(useUnlockProfitMonth);
 await act(async () => { await expect(second.result.current.mutateAsync(next)).resolves.toMatchObject({ run_id: 'run-confirmed' }); }); second.unmount(); expect(m.rpc).toHaveBeenCalledTimes(2);
 expect(keyOf(1)).not.toBe(keyOf(0));
 m.userId = 'actor-a'; localStorage.setItem('ihomecrm.selectedOrganizationId', org); expect(financialPending.read(scopeOf('profit-unlock'))).not.toBeNull(); const third = mount(useUnlockProfitMonth);
 await act(async () => { await expect(third.result.current.mutateAsync(base)).resolves.toMatchObject({ run_id: 'run-confirmed' }); }); expect(m.rpc).toHaveBeenCalledTimes(3);
 expect(keyOf(2)).toBe(keyOf(0)); expect(financialPending.read(scopeOf('profit-unlock'))).toBeNull();
});
it('lý do xử lý chưa phân bổ sai là preflight failure; sửa xong được gửi đúng một lần', async () => {
 m.rpc.mockResolvedValue({ data: { run_id: 'run-confirmed', affected_buildings: 1 }, error: null }); const mounted = mount(useCloseProfitPeriod);
 await act(async () => { await expect(mounted.result.current.mutateAsync({ ...base, adjustments: [{ building_id: 'b1', adjustment_amount: 0, adjustment_reason: null, unallocated_disposition: 'CARRY_FORWARD', unallocated_disposition_reason: 'a' }] })).rejects.toMatchObject({ outcome: 'failure' }); });
 expect(m.rpc).not.toHaveBeenCalled(); await act(async () => { await expect(mounted.result.current.mutateAsync(base)).resolves.toMatchObject({ run_id: 'run-confirmed' }); }); expect(m.rpc).toHaveBeenCalledTimes(1);
});


it.each(cases)('%s stale payload org A/current B không ghi và không tạo pending sai scope', async (namespace, hook) => {
 localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-b'); m.rpc.mockResolvedValue({ data: { run_id: 'wrong-org-write', affected_buildings: 1 }, error: null }); const mounted = mount(hook);
 await act(async () => { await expect(mounted.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'failure' }); }); expect(m.rpc).not.toHaveBeenCalled();
 expect(financialPending.read({ namespace, userId: 'actor-a', organizationId: 'org-b', businessKey: `${org}:2026-07-01` })).toBeNull();
 expect(financialPending.read({ namespace, userId: 'actor-a', organizationId: org, businessKey: `${org}:2026-07-01` })).toBeNull();
 localStorage.setItem('ihomecrm.selectedOrganizationId', org); await act(async () => { await expect(mounted.result.current.mutateAsync(base)).resolves.toMatchObject({ run_id: 'wrong-org-write' }); }); expect(m.rpc).toHaveBeenCalledOnce();
});
