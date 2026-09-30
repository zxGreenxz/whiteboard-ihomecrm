// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ reply: vi.fn(), upload: vi.fn(), remove: vi.fn(), success: vi.fn(), warning: vi.fn(), lastPatch: null as unknown }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor-a' }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'actor-a' } }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('sonner', () => ({ toast: { success: m.success, warning: m.warning, info: vi.fn(), error: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
 storage: { from: () => ({ upload: m.upload, remove: m.remove, getPublicUrl: () => ({ data: { publicUrl: 'https://storage.test/avatars/actor-a/avatar.png' } }) }) },
 from: (table: string) => {
  let operation = 'read'; let patch: unknown;
  const builder = { order: () => builder, limit: () => builder, select: () => builder, eq: () => builder, delete:()=>{operation='delete';return builder;}, insert: (value: unknown) => { operation = 'insert'; patch = value; return builder; }, upsert: (value: unknown) => { operation = 'upsert'; patch = value; return builder; }, update: (value: unknown) => { operation = 'update'; patch = value; m.lastPatch = value; return builder; },
   single: () => m.reply(table, operation, patch), then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(() => m.reply(table, operation, patch)).then(resolve, reject) };
  return builder;
 }
} }));
import { useUploadAvatar } from '../useProfile';
import { useUpdateCompanyInfo, useUpdateGeneralSetting, useUpdateIndividualSetting } from '../useSettings';
import { useCreateJob, useUpdateJob, useUpdateJobStatus, useCompleteJob, useDeleteJob } from '../useJobs';
import { useCreateJobType, useUpdateJobType, useDeleteJobType } from '../useJobTypes';
import { useCreateJobGroup } from '../useJobGroups';
import { useCreateUserSubscription, useUpdateUserSubscription, useCancelUserSubscription } from '../useSubscription';
import { useCreateDocumentTemplate, useDeleteDocumentTemplate, useUpdateDocumentTemplate, type DocumentTemplate } from '../useDocumentTemplates';
import { DeleteTemplateDialog } from '@/components/document-templates/DeleteTemplateDialog';
const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>;
beforeEach(() => { vi.clearAllMocks(); m.upload.mockResolvedValue({ error: null }); m.remove.mockResolvedValue({ error: null }); m.reply.mockResolvedValue({ data: null, error: null }); });
afterEach(cleanup);
it.each([null, { id: 'another-user', avatar_url: 'https://storage.test/avatars/actor-a/avatar.png' }, { id: 'actor-a', avatar_url: 'different-url' }])('avatar receipt sai giữ durable URL và không báo success: %j', async row => {
 m.reply.mockResolvedValue({ data: row, error: null }); const hook = renderHook(useUploadAvatar, { wrapper: Wrapper });
 await act(async () => { await expect(hook.result.current.mutateAsync(new File(['x'], 'avatar.png', { type: 'image/png' }))).rejects.toMatchObject({ uploadedUrl: 'https://storage.test/avatars/actor-a/avatar.png', profileId: 'actor-a' }); });
 expect(m.success).not.toHaveBeenCalled(); expect(m.remove).not.toHaveBeenCalled(); expect(m.upload).toHaveBeenCalledTimes(1);
});
it('avatar profile transport rejection giữ URL và cause sau upload', async () => {
 const failure = new TypeError('Failed to fetch SQL_INTERNAL'); m.reply.mockRejectedValue(failure); const hook = renderHook(useUploadAvatar, { wrapper: Wrapper });
 await act(async () => { await expect(hook.result.current.mutateAsync(new File(['x'], 'avatar.png'))).rejects.toMatchObject({ uploadedUrl: 'https://storage.test/avatars/actor-a/avatar.png', cause: failure }); }); expect(m.success).not.toHaveBeenCalled(); expect(m.remove).not.toHaveBeenCalled();
});
it('avatar đúng ID và URL mới báo đã cập nhật', async () => {
 m.reply.mockResolvedValue({ data: { id: 'actor-a', avatar_url: 'https://storage.test/avatars/actor-a/avatar.png' }, error: null }); const hook = renderHook(useUploadAvatar, { wrapper: Wrapper });
 await act(async () => { await expect(hook.result.current.mutateAsync(new File(['x'], 'avatar.png'))).resolves.toBe('https://storage.test/avatars/actor-a/avatar.png'); }); expect(m.success).toHaveBeenCalledOnce();
});
it.each([null, { id: 'another-template', deleted_at: '2026-09-30T00:00:00Z' }, { id: 'template-a', deleted_at: null }])('soft delete thiếu/sai ID/status không báo thành công: %j', async row => {
 m.reply.mockResolvedValue({ data: row, error: null }); const hook = renderHook(useDeleteDocumentTemplate, { wrapper: Wrapper });
 await act(async () => { await expect(hook.result.current.mutateAsync('template-a')).rejects.toMatchObject({ templateId: 'template-a' }); }); expect(m.success).not.toHaveBeenCalled();
});
it('soft delete receipt đúng ID và thời gian từ patch mới báo success', async () => {
 m.reply.mockImplementation((_table, _operation, patch) => Promise.resolve({ data: { id: 'template-a', ...patch }, error: null })); const hook = renderHook(useDeleteDocumentTemplate, { wrapper: Wrapper });
 await act(async () => { await expect(hook.result.current.mutateAsync('template-a')).resolves.toMatchObject({ id: 'template-a' }); }); expect(m.success).toHaveBeenCalledOnce();
});
it.each([null, { id: 'another-template', name: 'Other', code: 'WRONG' }])('update template receipt sai giữ ID/file và không cleanup: %j', async row => {
 m.reply.mockImplementation((_table, operation) => Promise.resolve(operation === 'read' ? { data: { file_url: 'https://storage.test/object/public/document-templates/actor-a/old.docx' }, error: null } : { data: row, error: null }));
 const hook = renderHook(useUpdateDocumentTemplate, { wrapper: Wrapper });
 await act(async () => { await expect(hook.result.current.mutateAsync({ id: 'template-a', name: 'New', file: new File(['x'], 'new.docx') })).rejects.toMatchObject({ templateId: 'template-a', uploadedUrl: 'https://storage.test/avatars/actor-a/avatar.png' }); }); expect(m.remove).not.toHaveBeenCalled(); expect(m.success).not.toHaveBeenCalled();
});
it('Radix Action không đóng hộp xóa khi receipt unknown; giữ tên/ID và khóa gửi lại', async () => {
 const close = vi.fn(); render(<Wrapper><DeleteTemplateDialog open onOpenChange={close} template={{ id: 'template-a', name: 'Mẫu A' } as DocumentTemplate} /></Wrapper>);
 fireEvent.click(screen.getByRole('button', { name: /^Xóa$/ })); await waitFor(() => expect(m.reply).toHaveBeenCalled()); await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/chưa xác nhận/i));
 expect(close).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: /^Xóa$/ }).getAttribute('disabled')).not.toBeNull(); expect(screen.getByText('Mẫu A')).toBeTruthy();
});

const settingsCases = [
 ['company', () => useUpdateCompanyInfo(), { company_name: 'Công ty A' }, 'company_info', { company_name: 'Công ty A' }],
 ['individual', () => useUpdateIndividualSetting('test-key'), false, 'test-key', false],
 ['general', useUpdateGeneralSetting, { key: 'test-key', value: 12, label: 'Ngưỡng' }, 'test-key', 12],
] as const;
it.each(settingsCases)('settings %s zero-row không báo đã lưu', async (_name, hook, input) => {
 const mounted = renderHook(() => hook() as unknown as { mutateAsync: (v: unknown) => Promise<unknown> }, { wrapper: Wrapper });
 await act(async () => { await expect(mounted.result.current.mutateAsync(input)).rejects.toBeInstanceOf(TypeError); }); expect(m.success).not.toHaveBeenCalled();
});
it.each(settingsCases)('settings %s đúng key/user/value mới báo success', async (_name, hook, input, key, value) => {
 m.reply.mockResolvedValue({ data: { id: 'setting-a', user_id: 'actor-a', key, value }, error: null }); const mounted = renderHook(() => hook() as unknown as { mutateAsync: (v: unknown) => Promise<unknown> }, { wrapper: Wrapper });
 await act(async () => { await expect(mounted.result.current.mutateAsync(input)).resolves.toMatchObject({ id: 'setting-a' }); }); expect(m.success).toHaveBeenCalledOnce();
});
it('settings returned old/wrong value không báo success', async () => {
 m.reply.mockResolvedValue({ data: { id: 'setting-a', user_id: 'actor-a', key: 'test-key', value: true }, error: null }); const mounted = renderHook(() => useUpdateIndividualSetting('test-key'), { wrapper: Wrapper });
 await act(async () => { await expect(mounted.result.current.mutateAsync(false)).rejects.toBeInstanceOf(TypeError); }); expect(m.success).not.toHaveBeenCalled();
});
const subscriptionCases = [ ['create', useCreateUserSubscription, { plan_id: 'plan-a', status: 'active' }], ['update', useUpdateUserSubscription, { id: 'sub-a', updates: { plan_id: 'plan-a' } }], ['cancel', useCancelUserSubscription, 'sub-a'] ] as const;
it.each(subscriptionCases)('subscription %s zero-row không báo đã lưu', async (_name, hook, input) => {
 const mounted = renderHook(() => hook() as unknown as { mutateAsync: (v: unknown) => Promise<unknown> }, { wrapper: Wrapper }); await act(async () => { await expect(mounted.result.current.mutateAsync(input)).rejects.toBeInstanceOf(TypeError); }); expect(m.success).not.toHaveBeenCalled();
});
it.each(subscriptionCases)('subscription %s wrong ID/status/value không báo success', async (name, hook, input) => {
 m.reply.mockResolvedValue({ data: { id: 'wrong-sub', user_id: 'actor-a', plan_id: 'wrong-plan', status: 'active' }, error: null });
 const mounted = renderHook(() => hook() as unknown as { mutateAsync: (v: unknown) => Promise<unknown> }, { wrapper: Wrapper }); await act(async () => { await expect(mounted.result.current.mutateAsync(input)).rejects.toBeInstanceOf(TypeError); }); expect(m.success).not.toHaveBeenCalled();
});
it.each(subscriptionCases)('subscription %s receipt thật báo tên gói', async (name, hook, input) => {
 m.reply.mockResolvedValue({ data: { id: 'sub-a', user_id: 'actor-a', plan_id: 'plan-a', status: name === 'cancel' ? 'cancelled' : 'active', plan: { name: 'Gói A' } }, error: null });
 const mounted = renderHook(() => hook() as unknown as { mutateAsync: (v: unknown) => Promise<unknown> }, { wrapper: Wrapper }); await act(async () => { await expect(mounted.result.current.mutateAsync(input)).resolves.toMatchObject({ id: 'sub-a' }); }); expect(m.success).toHaveBeenCalledWith(expect.stringContaining('Gói A'));
});

const taskCases = [
 ['job-create',useCreateJob,{title:'Việc A'}],['job-update',useUpdateJob,{id:'j1',patch:{title:'Việc A'}}],['job-status',useUpdateJobStatus,{id:'j1',status:'PENDING'}],['job-complete',useCompleteJob,{id:'j1',completion_captured_at:'2026-09-30T00:00:00Z',completion_attachments:null}],['job-delete',useDeleteJob,'j1'],
 ['type-create',useCreateJobType,{name:'Loại A'}],['type-update',useUpdateJobType,{id:'t1',updates:{name:'Loại A'}}],['type-delete',useDeleteJobType,'t1'],['group-create',useCreateJobGroup,'Nhóm A'],
] as const;
it.each(taskCases)('%s null write receipt không báo success',async(_label,hook,input)=>{
 const mounted=renderHook(()=>hook() as unknown as {mutateAsync:(v:unknown)=>Promise<unknown>},{wrapper:Wrapper});await act(async()=>{await expect(mounted.result.current.mutateAsync(input)).rejects.toBeInstanceOf(TypeError);});expect(m.success).not.toHaveBeenCalled();
});
it.each(taskCases)('%s receipt có ID/payload hợp lệ được lưu',async(label,hook,input)=>{
 m.reply.mockImplementation((_table,_op,patch)=>({data:{id:label.startsWith('job')?'j1':label.startsWith('type')?'t1':'g1',...patch},error:null}));
 const mounted=renderHook(()=>hook() as unknown as {mutateAsync:(v:unknown)=>Promise<unknown>},{wrapper:Wrapper});await act(async()=>{await expect(mounted.result.current.mutateAsync(input)).resolves.toMatchObject({id:expect.any(String)});});expect(m.success).toHaveBeenCalledOnce();
});
it('job status receipt sai ID hoặc status không success',async()=>{
 m.reply.mockResolvedValue({data:{id:'j2',status:'COMPLETED'},error:null});const mounted=renderHook(useUpdateJobStatus,{wrapper:Wrapper});await act(async()=>{await expect(mounted.result.current.mutateAsync({id:'j1',status:'PENDING'})).rejects.toBeInstanceOf(TypeError);});expect(m.success).not.toHaveBeenCalled();
});

const createTemplateInput = () => ({ name: 'Mẫu mới', category: 'RECEIPT' as const, file: new File(['x'], 'new.docx'), is_default: false });
it.each([{id:''},{name:'Mẫu khác'},{file_url:'https://storage.test/other.docx'}])('create template wrong receipt giữ uploaded path, không false success: %j', async override => {
 m.reply.mockImplementation((_table, operation, patch) => Promise.resolve({data: operation === 'read' ? [] : {id:'template-a',...patch,...override},error:null})); const hook = renderHook(useCreateDocumentTemplate,{wrapper:Wrapper});
 await act(async()=>{await expect(hook.result.current.mutateAsync(createTemplateInput())).rejects.toMatchObject({uploadedUrl:'https://storage.test/avatars/actor-a/avatar.png'});});expect(m.success).not.toHaveBeenCalled();expect(m.remove).not.toHaveBeenCalled();
});
it('create template exact receipt dùng tên/code/ID thật', async () => {
 m.reply.mockImplementation((_table, operation, patch) => Promise.resolve({data: operation === 'read' ? [] : {id:'template-a',...patch},error:null})); const hook = renderHook(useCreateDocumentTemplate,{wrapper:Wrapper});
 await act(async()=>{await expect(hook.result.current.mutateAsync(createTemplateInput())).resolves.toMatchObject({id:'template-a',name:'Mẫu mới',code:'MHD000001'});});expect(m.success).toHaveBeenCalledWith(expect.stringContaining('Mẫu mới'));
});
it.each([null,[{code:'INVALID'}]])('template code source malformed không đoán MHD000001 rồi insert: %j', async codes => {
 m.reply.mockImplementation((_table,operation,patch)=>Promise.resolve({data: operation==='read'?codes:{id:'template-a',...patch},error:null}));const hook=renderHook(useCreateDocumentTemplate,{wrapper:Wrapper});
 await act(async()=>{await expect(hook.result.current.mutateAsync(createTemplateInput())).rejects.toMatchObject({uploadedUrl:'https://storage.test/avatars/actor-a/avatar.png'});});expect(m.reply.mock.calls.some(([,op])=>op==='insert')).toBe(false);expect(m.remove).not.toHaveBeenCalled();expect(m.success).not.toHaveBeenCalled();
});
