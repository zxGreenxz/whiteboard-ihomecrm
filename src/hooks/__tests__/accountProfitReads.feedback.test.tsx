// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ tables: {} as Record<string, unknown>, errors: {} as Record<string, unknown> }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor-a' }), getCachedSessionUser: () => ({ id: 'actor-a' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
 from: (table: string) => {
  const reply = () => Promise.resolve({ data: m.tables[table], error: m.errors[table] ?? null });
  const builder = { select: () => builder, eq: () => builder, is: () => builder, order: () => builder, limit: () => builder, maybeSingle: reply, single: reply, then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => reply().then(resolve, reject) };
  return builder;
 }, rpc: () => Promise.resolve({ data: m.tables.share_buildings, error: m.errors.share_buildings ?? null }),
} }));
import { useAdminUsers } from '../useAdminUsers';
import { useDocumentTemplate, useDocumentTemplates, useDocumentTemplatesByType } from '../useDocumentTemplates';
import { useProfitManagers, useMyProfitManager, useManagerSalaries } from '../useProfitManagers';
import { useShareholders, useMyShareholder, useMyShareBuildings, useBuildingShareholders } from '../useShareholders';
const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
beforeEach(() => { m.tables = { profiles: [], super_admins: [], staff_assignments: [] }; m.errors = {}; });
afterEach(cleanup);
const listCases = [
 ['admin profiles', 'profiles', useAdminUsers], ['admin supers', 'super_admins', useAdminUsers], ['admin assignments', 'staff_assignments', useAdminUsers],
 ['templates', 'document_templates', useDocumentTemplates], ['templates by type', 'document_templates', useDocumentTemplatesByType],
 ['managers', 'profit_managers', useProfitManagers], ['rules', 'profit_manager_salaries', useManagerSalaries],
 ['shareholders', 'shareholders', useShareholders], ['share buildings', 'share_buildings', useMyShareBuildings], ['shares', 'building_shareholders', useBuildingShareholders],
] as const;
it.each(listCases)('%s null payload phải error, không giả empty', async (_name, table, hook) => {
 m.tables[table] = null; const result = renderHook(() => hook(), { wrapper: Wrapper });
 await waitFor(() => expect(result.result.current.isError).toBe(true)); expect(result.result.current.data).toBeUndefined();
});
it.each(listCases)('%s malformed row phải error, không default giá trị', async (_name, table, hook) => {
 m.tables[table] = [{ id: 'row-a', amount: 'BAD', percent: 'BAD' }]; const result = renderHook(() => hook(), { wrapper: Wrapper });
 await waitFor(() => expect(result.result.current.isError).toBe(true)); expect(result.result.current.data).toBeUndefined();
});
it.each(listCases)('%s empty array hợp lệ vẫn empty', async (_name, table, hook) => {
 m.tables[table] = []; const result = renderHook(() => hook(), { wrapper: Wrapper });
 await waitFor(() => expect(result.result.current.isSuccess).toBe(true)); expect(result.result.current.data).toEqual([]);
});
it.each([['manager', 'profit_managers', useMyProfitManager], ['shareholder', 'shareholders', useMyShareholder]] as const)('%s maybeSingle null là không có vai trò, không phải lỗi', async (_name, table, hook) => {
 m.tables[table] = null; const result = renderHook(() => hook(), { wrapper: Wrapper }); await waitFor(() => expect(result.result.current.isSuccess).toBe(true)); expect(result.result.current.data).toBeNull();
});
it.each([['manager', 'profit_managers', useMyProfitManager], ['shareholder', 'shareholders', useMyShareholder]] as const)('%s maybeSingle malformed không nhận là vai trò thật', async (_name, table, hook) => {
 m.tables[table] = { id: 'person-a' }; const result = renderHook(() => hook(), { wrapper: Wrapper }); await waitFor(() => expect(result.result.current.isError).toBe(true));
});
it('template single wrong ID không dùng mẫu khác', async () => {
 m.tables.document_templates = { id: 'different-template' }; const result = renderHook(() => useDocumentTemplate('template-a'), { wrapper: Wrapper }); await waitFor(() => expect(result.result.current.isError).toBe(true));
});
it('lỗi quyền source admin giữ code/cause thật', async () => {
 const error = { code: '42501', message: 'private diagnostic' }; m.errors.staff_assignments = error; const result = renderHook(useAdminUsers, { wrapper: Wrapper }); await waitFor(() => expect(result.result.current.isError).toBe(true)); expect(result.result.current.error).toBe(error);
});

const person = { id: 'person-a', user_id: 'actor-a', auth_user_id: null, name: 'Người A', note: null, is_active: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null };
it.each([['manager', 'profit_managers', useProfitManagers], ['shareholder', 'shareholders', useShareholders]] as const)('%s valid disabled person giữ dữ liệu thật', async (_name, table, hook) => {
 m.tables[table] = [person]; const result = renderHook(() => hook(), { wrapper: Wrapper }); await waitFor(() => expect(result.result.current.isSuccess).toBe(true)); expect(result.result.current.data).toEqual([person]);
});
const rule = { id: 'rule-a', manager_id: 'person-a', label: null, form: 'PERCENT', basis: 'TOTAL_GROUP', amount: 0, percent: 12.5, is_active: false, profit_manager_salary_buildings: [{ building_id: 'building-a' }] };
it('salary rule giữ percent decimal/false và link thật', async () => {
 m.tables.profit_manager_salaries = [rule]; const result = renderHook(useManagerSalaries, { wrapper: Wrapper }); await waitFor(() => expect(result.result.current.isSuccess).toBe(true)); expect(result.result.current.data?.[0]).toMatchObject({ percent: 12.5, is_active: false, building_ids: ['building-a'] });
});
it.each([{ ...rule, percent: '12.5' }, { ...rule, amount: null }, { ...rule, profit_manager_salary_buildings: null }, { ...rule, profit_manager_salary_buildings: [{}] }])('salary malformed numeric/link không được ép mặc định: %j', async row => {
 m.tables.profit_manager_salaries = [row]; const result = renderHook(useManagerSalaries, { wrapper: Wrapper }); await waitFor(() => expect(result.result.current.isError).toBe(true));
});
it('admin valid nullable profile/super/assignments giữ flag và count', async () => {
 m.tables.profiles = [{ id: 'actor-a', full_name: 'Tên A', email: null, phone: null, is_active: false, created_at: '2026-01-01T00:00:00Z' }]; m.tables.super_admins = [{ user_id: 'actor-a' }]; m.tables.staff_assignments = [{ staff_id: 'actor-a' }, { staff_id: 'actor-a' }];
 const result = renderHook(useAdminUsers, { wrapper: Wrapper }); await waitFor(() => expect(result.result.current.isSuccess).toBe(true)); expect(result.result.current.data?.[0]).toMatchObject({ id: 'actor-a', is_active: false, is_super_admin: true, assignments_count: 2 });
});
it('template nullable DB fields vẫn dùng được', async () => {
 const row = { id: 'template-a', user_id: 'actor-a', name: 'Mẫu A', code: 'MHD000001', category: 'RECEIPT', file_url: 'https://storage.test/template.docx', file_name: 'template.docx', content: null, description: null, file_type: null, type: null, created_at: null, updated_at: null, deleted_at: null, file_size: null, is_active: null, is_default: null, variables: null };
 m.tables.document_templates = [row]; const result = renderHook(useDocumentTemplates, { wrapper: Wrapper }); await waitFor(() => expect(result.result.current.isSuccess).toBe(true)); expect(result.result.current.data).toEqual([row]);
});
