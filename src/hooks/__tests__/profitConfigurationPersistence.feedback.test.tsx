// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ reply: vi.fn(), success: vi.fn(), calls: [] as {table: string; operation: string; patch: unknown}[] }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor-a' }) }));
vi.mock('sonner', () => ({ toast: { success: m.success, info: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => {
 let operation = 'read'; let patch: unknown; const builder = { select: () => builder, eq: () => builder, in: () => builder, is: () => builder, update: (v: unknown) => { operation = 'update'; patch = v; return builder; }, insert: (v: unknown) => { operation = 'insert'; patch = v; return builder; }, upsert: (v: unknown) => { operation = 'upsert'; patch = v; return builder; }, delete: () => { operation = 'delete'; return builder; },
 // Đợt 8: thêm quản lý tra hồ sơ theo tài khoản trước khi chèn (`maybeSingle`).
 maybeSingle: async () => { m.calls.push({ table, operation: 'lookup', patch }); return m.reply(table, 'lookup', patch); },
 single: async () => { m.calls.push({ table, operation, patch }); return m.reply(table, operation, patch); }, then:(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(() => { m.calls.push({ table, operation, patch }); return m.reply(table, operation, patch); }).then(resolve, reject) }; return builder;
} } }));
import { useSaveManagerWithSalaries } from '../useProfitManagers';
import { useSyncShareholderBuildings, useUpsertBuildingShare, useDeleteBuildingShare } from '../useShareholders';
import { financialPending } from '@/lib/financialPending';
const managerInput = { values: { name: 'An', auth_user_id: 'actor-a' }, rules: [{ label: 'Lương', form: 'FIXED', basis: 'PER_BUILDING', amount: 100, percent: 0, building_ids: ['b1', 'b2'] }] } as const;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>;
function managerReply(table: string, operation: string, patch: unknown) {
 if (operation === 'lookup') return { data: null, error: null };
 if (table === 'profit_managers') return { data: operation === 'update' ? [{ id: 'm1', ...patch as object }] : { id: 'm1', ...patch as object }, error: null };
 if (table === 'profit_manager_salaries' && operation === 'read') return { data: [{ id: 'old-r1' }], error: null };
 if (table === 'profit_manager_salaries' && operation === 'delete') return { data: [{ id: 'old-r1' }], error: null };
 if (table === 'profit_manager_salaries') return { data: { id: 'r1', ...patch as object }, error: null };
 return { data: (patch as {building_id: string}[]).map((row, i) => ({ id: `rb${i}`, ...row })), error: null };
}
beforeEach(() => { vi.clearAllMocks(); m.calls = []; localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a'); m.reply.mockImplementation(managerReply); });
afterEach(cleanup);
// Đợt 8: quy tắc lương xoá rồi chèn lại cả bộ nên lần lưu sau sửa được mọi lần dở; không còn dấu chặn remount. Biên nhận
// xoá không khớp vẫn KHÔNG phải thành công: hỏng dạng ⇒ chưa rõ; thiếu dòng mà đọc lại thấy quy tắc còn ⇒ từ chối rõ.
it.each([{receipt:null,outcome:'unknown'}, {receipt:[],outcome:'failure'}, {receipt:[{id:'wrong-rule'}],outcome:'failure'}])('manager delete không xác nhận đủ old IDs giữ mã manager, không success, không giữ dấu: %j', async ({receipt,outcome}) => {
 m.reply.mockImplementation((table, operation, patch) => table === 'profit_manager_salaries' && operation === 'delete' ? { data: receipt, error: null } : managerReply(table, operation, patch));
 const first = renderHook(useSaveManagerWithSalaries, { wrapper }); await act(async () => { await expect(first.result.current.mutateAsync({ ...managerInput, rules: [...managerInput.rules].map(r => ({...r, building_ids: [...r.building_ids]})) })).rejects.toMatchObject({ outcome, completed: expect.arrayContaining([{ id: 'm1', label: 'Đã lưu hồ sơ quản lý' }]) }); }); first.unmount();
 expect(m.calls.filter(c => c.table === 'profit_manager_salaries' && c.operation === 'insert')).toHaveLength(0);
 expect(financialPending.read({namespace:'profit-manager-save',userId:'actor-a',organizationId:'org-a',businessKey:'new:actor-a'})).toBeNull(); expect(m.success).not.toHaveBeenCalled();
});
it('manager thiếu building link receipt giữ mã manager, chưa rõ, không báo toàn bộ lương đã lưu', async () => {
 m.reply.mockImplementation((table, operation, patch) => table === 'profit_manager_salary_buildings' ? { data: [{ id: 'rb1', salary_id: 'r1', building_id: 'b1' }], error: null } : managerReply(table, operation, patch)); const hook = renderHook(useSaveManagerWithSalaries, { wrapper });
 await act(async () => { await expect(hook.result.current.mutateAsync({ ...managerInput, rules: managerInput.rules.map(r => ({...r, building_ids: [...r.building_ids]})) })).rejects.toMatchObject({ outcome: 'unknown', repeatable: true, completed: expect.arrayContaining([{ id: 'm1', label: 'Đã lưu hồ sơ quản lý' }]) }); }); expect(m.success).not.toHaveBeenCalled();
});
it('manager đủ profile/rule/delete/link receipts mới success và clear pending', async () => {
 const hook = renderHook(useSaveManagerWithSalaries, { wrapper }); await act(async () => { await expect(hook.result.current.mutateAsync({ ...managerInput, rules: managerInput.rules.map(r => ({...r, building_ids: [...r.building_ids]})) })).resolves.toMatchObject({managerId:'m1'}); }); expect(m.success).toHaveBeenCalledOnce(); expect(financialPending.read({namespace:'profit-manager-save',userId:'actor-a',organizationId:'org-a',businessKey:'new:actor-a'})).toBeNull();
});
// Đợt 8: tỷ lệ toà đặt cả bộ (xoá toà bỏ đi + upsert theo duy nhất toà × cổ đông) nên chạy lại cho cùng kết quả. Biên
// nhận upsert thiếu vẫn KHÔNG phải thành công (chưa rõ); lần sau (kể cả sau remount) chạy lại, không bị dấu chặn.
it('share sync delete đúng IDs rồi upsert receipt thiếu: chưa rõ, không success, không chặn remount', async () => {
 m.reply.mockImplementation((_table, operation) => operation === 'read' ? { data: [{ id: 'old-share', building_id: 'old-b' }], error: null } : operation === 'delete' ? { data: [{ id: 'old-share' }], error: null } : { data: null, error: null });
 const first = renderHook(useSyncShareholderBuildings, { wrapper }); const input = {shareholder_id:'s1',rows:[{building_id:'b1',percent:30}]}; await act(async () => { await expect(first.result.current.mutateAsync(input)).rejects.toMatchObject({outcome:'unknown',repeatable:true}); }); first.unmount();
 const writes = m.calls.filter(c => c.operation !== 'read').length; const second = renderHook(useSyncShareholderBuildings, { wrapper }); await act(async () => { await expect(second.result.current.mutateAsync(input)).rejects.toMatchObject({outcome:'unknown'}); }); expect(m.calls.filter(c => c.operation === 'upsert')).toHaveLength(2); expect(m.calls.filter(c => c.operation !== 'read').length).toBeGreaterThan(writes);
 expect(financialPending.read({namespace:'shareholder-sync',userId:'actor-a',organizationId:'org-a',businessKey:'s1'})).toBeNull();
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
// Đợt 8: không còn dấu giữ mã dòng liên kết; lần lưu sau xoá toàn bộ quy tắc của quản lý (kéo theo liên kết) rồi tạo lại.
it('manager thiếu dòng liên kết: chưa rõ, không giữ dấu; lần lưu sau sửa đúng hồ sơ đã tạo và xoá quy tắc dở',async()=>{
 m.reply.mockImplementation((table,operation,patch)=>table==='profit_manager_salary_buildings'?{data:[{id:'rb1',user_id:'actor-a',salary_id:'r1',building_id:'b1'}],error:null}:managerReply(table,operation,patch));
 const hook=renderHook(useSaveManagerWithSalaries,{wrapper});await act(async()=>{await expect(hook.result.current.mutateAsync({...managerInput,rules:managerInput.rules.map(r=>({...r,building_ids:[...r.building_ids]}))})).rejects.toMatchObject({outcome:'unknown',repeatable:true});});
 expect(financialPending.read({namespace:'profit-manager-save',userId:'actor-a',organizationId:'org-a',businessKey:'new:actor-a'})).toBeNull();
 m.reply.mockImplementation(managerReply);m.calls=[];
 await act(async()=>{await expect(hook.result.current.mutateAsync({id:'m1',...managerInput,rules:managerInput.rules.map(r=>({...r,building_ids:[...r.building_ids]}))})).resolves.toMatchObject({managerId:'m1'});});
 expect(m.calls.map(c=>`${c.table}:${c.operation}`)).toEqual(['profit_managers:update','profit_manager_salaries:read','profit_manager_salaries:delete','profit_manager_salaries:insert','profit_manager_salary_buildings:insert']);
});
