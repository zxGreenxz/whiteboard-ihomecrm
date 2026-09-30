// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ reply: vi.fn(), success: vi.fn(), calls: [] as {table: string; operation: string; patch: unknown}[] }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor-a' }) }));
vi.mock('sonner', () => ({ toast: { success: m.success, info: vi.fn(), error: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => {
 let operation = 'read'; let patch: unknown; const builder = { select: () => builder, eq: () => builder, in: () => builder, update: (v: unknown) => { operation = 'update'; patch = v; return builder; }, insert: (v: unknown) => { operation = 'insert'; patch = v; return builder; }, upsert: (v: unknown) => { operation = 'upsert'; patch = v; return builder; }, delete: () => { operation = 'delete'; return builder; },
 single: async () => { m.calls.push({ table, operation, patch }); return m.reply(table, operation, patch); }, then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(() => { m.calls.push({ table, operation, patch }); return m.reply(table, operation, patch); }).then(resolve, reject) }; return builder;
} } }));
import { useSaveManagerWithSalaries } from '../useProfitManagers';
import { useSyncShareholderBuildings, useUpsertBuildingShare, useDeleteBuildingShare } from '../useShareholders';
import { financialPending } from '@/lib/financialPending';
const managerInput = { values: { name: 'An', auth_user_id: 'actor-a' }, rules: [{ label: 'Lương', form: 'FIXED', basis: 'PER_BUILDING', amount: 100, percent: 0, building_ids: ['b1', 'b2'] }] } as const;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>;
function managerReply(table: string, operation: string, patch: unknown) {
 if (table === 'profit_managers') return { data: { id: 'm1', ...patch as object }, error: null };
 if (table === 'profit_manager_salaries' && operation === 'read') return { data: [{ id: 'old-r1' }], error: null };
 if (table === 'profit_manager_salaries' && operation === 'delete') return { data: [{ id: 'old-r1' }], error: null };
 if (table === 'profit_manager_salaries') return { data: { id: 'r1', ...patch as object }, error: null };
 return { data: (patch as {building_id: string}[]).map((row, i) => ({ id: `rb${i}`, ...row })), error: null };
}
beforeEach(() => { vi.clearAllMocks(); m.calls = []; localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a'); m.reply.mockImplementation(managerReply); });
afterEach(cleanup);
it.each([{receipt:null}, {receipt:[]}, {receipt:[{id:'wrong-rule'}]}])('manager delete không xác nhận đủ old IDs giữ manager và chặn remount: %j', async ({receipt}) => {
 m.reply.mockImplementation((table, operation, patch) => table === 'profit_manager_salaries' && operation === 'delete' ? { data: receipt, error: null } : managerReply(table, operation, patch));
 const first = renderHook(useSaveManagerWithSalaries, { wrapper }); await act(async () => { await expect(first.result.current.mutateAsync({ ...managerInput, rules: [...managerInput.rules].map(r => ({...r, building_ids: [...r.building_ids]})) })).rejects.toMatchObject({ outcome: 'partial', completed: expect.arrayContaining([{ id: 'm1', label: 'Đã lưu hồ sơ quản lý' }]) }); }); first.unmount();
 const writes = m.calls.filter(c => c.operation !== 'read').length; const second = renderHook(useSaveManagerWithSalaries, { wrapper }); await act(async () => { await expect(second.result.current.mutateAsync({ ...managerInput, rules: [] })).rejects.toMatchObject({ outcome: 'partial' }); }); expect(m.calls.filter(c => c.operation !== 'read')).toHaveLength(writes); expect(m.success).not.toHaveBeenCalled();
});
it('manager thiếu building link receipt giữ manager/rule IDs không báo toàn bộ lương đã lưu', async () => {
 m.reply.mockImplementation((table, operation, patch) => table === 'profit_manager_salary_buildings' ? { data: [{ id: 'rb1', salary_id: 'r1', building_id: 'b1' }], error: null } : managerReply(table, operation, patch)); const hook = renderHook(useSaveManagerWithSalaries, { wrapper });
 await act(async () => { await expect(hook.result.current.mutateAsync({ ...managerInput, rules: managerInput.rules.map(r => ({...r, building_ids: [...r.building_ids]})) })).rejects.toMatchObject({ outcome: 'partial', completed: expect.arrayContaining([{ id: 'r1', label: 'Đã tạo quy tắc Lương' }]) }); }); expect(m.success).not.toHaveBeenCalled();
});
it('manager đủ profile/rule/delete/link receipts mới success và clear pending', async () => {
 const hook = renderHook(useSaveManagerWithSalaries, { wrapper }); await act(async () => { await expect(hook.result.current.mutateAsync({ ...managerInput, rules: managerInput.rules.map(r => ({...r, building_ids: [...r.building_ids]})) })).resolves.toMatchObject({managerId:'m1'}); }); expect(m.success).toHaveBeenCalledOnce(); expect(financialPending.read({namespace:'profit-manager-save',userId:'actor-a',organizationId:'org-a',businessKey:'new:actor-a'})).toBeNull();
});
it('share sync delete đúng IDs rồi upsert receipt thiếu giữ IDs và chặn remount', async () => {
 m.reply.mockImplementation((_table, operation) => operation === 'read' ? { data: [{ id: 'old-share', building_id: 'old-b' }], error: null } : operation === 'delete' ? { data: [{ id: 'old-share' }], error: null } : { data: null, error: null });
 const first = renderHook(useSyncShareholderBuildings, { wrapper }); const input = {shareholder_id:'s1',rows:[{building_id:'b1',percent:30}]}; await act(async () => { await expect(first.result.current.mutateAsync(input)).rejects.toMatchObject({outcome:'partial',completed:expect.arrayContaining([{id:'old-share',label:'Đã xóa tỷ lệ tòa cũ'}])}); }); first.unmount();
 const writes = m.calls.filter(c => c.operation !== 'read').length; const second = renderHook(useSyncShareholderBuildings, { wrapper }); await act(async () => { await expect(second.result.current.mutateAsync(input)).rejects.toMatchObject({outcome:'partial'}); }); expect(m.calls.filter(c => c.operation !== 'read')).toHaveLength(writes);
});
it.each(['upsert','delete'] as const)('ô tỷ lệ %s zero-row không là success', async kind => {
 m.reply.mockResolvedValue({ data: null, error: null }); const mounted = renderHook(() => (kind === 'upsert' ? useUpsertBuildingShare() : useDeleteBuildingShare()) as unknown as {mutateAsync:(input:unknown)=>Promise<unknown>}, { wrapper });
 await act(async () => { await expect(mounted.result.current.mutateAsync({building_id:'b1',shareholder_id:'s1',percent:30})).rejects.toBeInstanceOf(TypeError); });
});

it('share sync đầy đủ returned IDs/values clear pending; empty confirmed config không phải rollback inference',async()=>{
 m.reply.mockImplementation((_table,operation,patch)=>operation==='read'?{data:[],error:null}:{data:(patch as object[]).map((row,i)=>({id:`share-${i}`,...row})),error:null});
 const hook=renderHook(useSyncShareholderBuildings,{wrapper});await act(async()=>{await expect(hook.result.current.mutateAsync({shareholder_id:'s1',rows:[{building_id:'b1',percent:30}]})).resolves.toBeUndefined();});
 expect(financialPending.read({namespace:'shareholder-sync',userId:'actor-a',organizationId:'org-a',businessKey:'s1'})).toBeNull();
});
it('manager partial returned link ID được lưu trước khi reject thiếu dòng',async()=>{
 m.reply.mockImplementation((table,operation,patch)=>table==='profit_manager_salary_buildings'?{data:[{id:'rb1',user_id:'actor-a',salary_id:'r1',building_id:'b1'}],error:null}:managerReply(table,operation,patch));
 const hook=renderHook(useSaveManagerWithSalaries,{wrapper});await act(async()=>{await expect(hook.result.current.mutateAsync({...managerInput,rules:managerInput.rules.map(r=>({...r,building_ids:[...r.building_ids]}))})).rejects.toMatchObject({outcome:'partial'});});
 expect(financialPending.read({namespace:'profit-manager-save',userId:'actor-a',organizationId:'org-a',businessKey:'new:actor-a'})?.completedIds).toContain('rb1');
});
