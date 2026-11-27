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
// Đợt 6: chốt lần đầu tách khoá thành profit-first-close (dấu chung profit-close bản trước chỉ còn đọc).
const cases = [ ['profit-first-close', useCloseProfitPeriod], ['profit-unlock', useUnlockProfitMonth], ['profit-reset', useResetProfitPeriod] ] as const;
function mount(hook: typeof useCloseProfitPeriod | typeof useResetProfitPeriod | typeof useUnlockProfitMonth) {
 const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>;
 return renderHook(() => hook() as unknown as { mutateAsync: (input: ProfitInput) => Promise<unknown> }, { wrapper });
}
beforeEach(() => { localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', org); m.userId = 'actor-a'; m.rpc.mockReset(); });
afterEach(cleanup);
// Đợt 6 (cách B): mã gửi máy chủ suy từ mã của dấu; lần bấm sau gửi lại ĐÚNG mã đó (máy chủ giữ khoá tư vấn theo mã rồi tra
// profit_close_runs), không sinh mã mới, và dấu vẫn theo phạm vi người / công ty / tháng.
it.each(cases)('%s unknown survives remount and keeps scope by actor/org/month; the next press resends the same server key', async (namespace, hook) => {
 m.rpc.mockResolvedValue({ data: null, error: null }); const first = mount(hook);
 await act(async () => { await expect(first.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); }); first.unmount();
 const pending = financialPending.read({ namespace, userId: 'actor-a', organizationId: org, businessKey: `${org}:2026-07-01` }); expect(pending).not.toBeNull();
 expect(m.rpc.mock.calls[0][1].p_idempotency_key).toContain(pending?.requestKey);
 const second = mount(hook); await act(async () => { await expect(second.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); }); expect(m.rpc).toHaveBeenCalledTimes(2);
 expect(m.rpc.mock.calls[1][1].p_idempotency_key).toBe(m.rpc.mock.calls[0][1].p_idempotency_key);
});
it.each(['actor', 'organization', 'month'] as const)('pending unlock does not block another %s; back in the original scope the next press resends the original server key', async dimension => {
 m.rpc.mockResolvedValue({ data: null, error: null }); const first = mount(useUnlockProfitMonth); await act(async () => { await expect(first.result.current.mutateAsync(base)).rejects.toMatchObject({ outcome: 'unknown' }); }); first.unmount();
 const next = { ...base }; if (dimension === 'actor') m.userId = 'actor-b'; if (dimension === 'organization') { next.organizationId = 'org-b'; localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-b'); } if (dimension === 'month') next.periodMonth = '2026-08-01';
 m.rpc.mockResolvedValue({ data: { run_id: 'run-confirmed', affected_buildings: 1, idempotent_replay: false }, error: null }); const second = mount(useUnlockProfitMonth);
 await act(async () => { await expect(second.result.current.mutateAsync(next)).resolves.toMatchObject({ run_id: 'run-confirmed' }); }); second.unmount(); expect(m.rpc).toHaveBeenCalledTimes(2);
 m.userId = 'actor-a'; localStorage.setItem('ihomecrm.selectedOrganizationId', org); const third = mount(useUnlockProfitMonth);
 await act(async () => { await expect(third.result.current.mutateAsync(base)).resolves.toMatchObject({ run_id: 'run-confirmed' }); }); expect(m.rpc).toHaveBeenCalledTimes(3);
 expect(m.rpc.mock.calls[2][1].p_idempotency_key).toBe(m.rpc.mock.calls[0][1].p_idempotency_key);
 expect(m.rpc.mock.calls[1][1].p_idempotency_key).not.toBe(m.rpc.mock.calls[0][1].p_idempotency_key);
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
