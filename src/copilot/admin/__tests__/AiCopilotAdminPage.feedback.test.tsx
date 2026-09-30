// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
interface DatabaseReply { data: unknown; error: unknown }
interface AdminQueryMock extends PromiseLike<DatabaseReply> {
 select: () => AdminQueryMock; eq: () => AdminQueryMock; order: () => AdminQueryMock;
 gte: () => AdminQueryMock; in: () => AdminQueryMock;
 range: (from: number, to: number) => Promise<DatabaseReply>;
 limit: () => Promise<DatabaseReply>; update: (input: unknown) => AdminQueryMock;
 maybeSingle: () => Promise<DatabaseReply>;
}
const m = vi.hoisted(() => ({ writes: vi.fn(), flag: vi.fn(), usageError: false, malformedUsage: false, usageRows: [] as Record<string,unknown>[], ranges: vi.fn(), fetch: vi.fn(), providers: [{ provider: 'bad', label: 'Bad AI', enabled: false, models: [{ id: 'm', label: 'M', pricing_mode: 'unknown' }], default_model: 'm', data_class: 'cloud' }] as Array<{provider:string;label:string;enabled:boolean;models:unknown;default_model:string|null;data_class:string}>, result: { data: null as unknown, error: null as unknown }, toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../copilotConfig',()=>({LLM_PROXY_BASE:'https://proxy.test',makeCopilotFetch:()=>m.fetch,newTaskId:()=> 'test-task'}));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'u' }) }));
vi.mock('sonner', () => ({ toast: m.toast }));
const settings = { chat_enabled: true, ui_control_enabled: false, rate_per_min: 20, daily_usd_cap_user: 2, daily_usd_cap_tenant: 10, daily_usd_cap_global: 100, daily_tokens_cap_user: 300000, daily_tokens_cap_tenant: 1500000 };
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => { let write = false; const q: AdminQueryMock = { select: () => q, eq: () => q, order: () => q, gte: () => q, in: () => q, range: async (from:number,to:number)=>{m.ranges(from,to);return {data:m.malformedUsage?null:m.usageRows.slice(from,to+1),error:m.usageError?{message:'private ai_usage_logs diagnostic'}:null};}, limit: async () => ({ data: [], error: m.usageError ? { message: 'private ai_usage_logs diagnostic' } : null }), then: (resolve, reject) => Promise.resolve<DatabaseReply>({ data: table === 'ai_providers' ? m.providers : [], error: null }).then(resolve, reject), update: (input: unknown) => { write = true; m.writes(input); return q; }, maybeSingle: async () => write ? m.result : { data: settings, error: null } }; return q; } } }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsSuperAdmin: () => ({ data: true, isLoading: false }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'u' } }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org', organizations: [] }) }));
vi.mock('../../featureFlags', () => ({ useCopilotAvailability: () => ({ data: { revision: 1 }, refetch: vi.fn() }), rolloutRowsFromAvailability: () => [{ scope: 'page', contractId: 'room', label: 'Phòng', state: 'disabled' }], nhomRolloutTheoScope: (rows: unknown[]) => [{ scope: 'page', nhan: 'Trang', rows }], copilotRolloutTransitions: () => ['canary'], setCopilotFeatureFlagV2: m.flag, formatCopilotRolloutError: () => 'Chưa đổi được rollout.' }));
import AiCopilotAdminPage from '../AiCopilotAdminPage';
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><AiCopilotAdminPage /></QueryClientProvider>);
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); m.usageError = false; m.malformedUsage=false;m.usageRows=[];m.providers=[{provider:'bad',label:'Bad AI',enabled:false,models:[{id:'m',label:'M',pricing_mode:'unknown'}],default_model:'m',data_class:'cloud'}];m.result = { data: null, error: null }; });
afterEach(cleanup);
it.each([['Rate limit (request/phút/user)', '-2'], ['Cap TOKEN/ngày mỗi USER', '1.5'], ['Cap USD/ngày mỗi USER', '12abc']])('cấu hình %s giữ chuỗi sai và focus khi lưu', async (label, value) => {
 mount(); const input = await screen.findByLabelText(label); fireEvent.change(input, { target: { value } }); fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));
 await waitFor(() => expect(document.activeElement).toBe(input)); expect(input.getAttribute('aria-invalid')).toBe('true'); expect((input as HTMLInputElement).value).toBe(value); expect(m.writes).not.toHaveBeenCalled();
});
it('null receipt giữ budget draft và khóa lưu, không toast success', async () => {
 mount(); const input = await screen.findByLabelText('Cap USD/ngày mỗi USER'); fireEvent.change(input, { target: { value: '4.2' } }); fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));
 await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận')); expect((input as HTMLInputElement).value).toBe('4.2'); expect(m.toast.success).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Lưu cài đặt' }).hasAttribute('disabled')).toBe(true);
});

it('bật provider có model lỗi tự mở phần sửa và focus models', async () => {
 mount(); await screen.findByLabelText('Rate limit (request/phút/user)'); fireEvent.mouseDown(screen.getByRole('tab', { name: 'Providers' }), { button: 0, ctrlKey: false });
 await screen.findByText('Bad AI'); fireEvent.click(screen.getByRole('switch'));
 await waitFor(() => expect(document.activeElement?.getAttribute('name')).toBe('models')); expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true'); expect(m.writes).not.toHaveBeenCalled();
});
it('rollout thiếu lý do đưa focus và báo đỏ trước RPC', async () => {
 mount(); await screen.findByLabelText('Rate limit (request/phút/user)'); fireEvent.mouseDown(screen.getByRole('tab', { name: 'Rollout' }), { button: 0, ctrlKey: false });
 await screen.findByText('Phòng'); fireEvent.click(screen.getByRole('button', { name: 'canary' }));
 await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Lý do bắt buộc'))); expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true'); expect(m.flag).not.toHaveBeenCalled();
});
it('rollout null receipt giữ lý do và khóa chuyển tiếp', async () => {
 m.flag.mockResolvedValue(null); mount(); await screen.findByLabelText('Rate limit (request/phút/user)'); fireEvent.mouseDown(screen.getByRole('tab', { name: 'Rollout' }), { button: 0, ctrlKey: false }); await screen.findByText('Phòng');
 fireEvent.change(screen.getByLabelText('Lý do bắt buộc'), { target: { value: 'Pilot' } }); fireEvent.change(screen.getByLabelText('Liên kết bằng chứng'), { target: { value: 'evidence' } }); fireEvent.change(screen.getByLabelText('Tham chiếu rollback'), { target: { value: 'rollback' } }); fireEvent.click(screen.getByRole('button', { name: 'canary' }));
 await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận')); expect((screen.getByLabelText('Lý do bắt buộc') as HTMLInputElement).value).toBe('Pilot'); expect(m.toast.success).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'canary' }).hasAttribute('disabled')).toBe(true);
});

it('thống kê Copilot lỗi nguồn không hiện tổng rỗng hoặc số 0 như dữ liệu thật', async () => {
 m.usageError = true; mount(); await screen.findByLabelText('Rate limit (request/phút/user)'); fireEvent.mouseDown(screen.getByRole('tab', { name: 'Sử dụng' }), { button: 0, ctrlKey: false });
 await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa tải được')); expect(screen.queryByText('Request 7 ngày')).toBeNull(); expect(document.body.textContent).not.toContain('private ai_usage_logs diagnostic');
});

const showProviders = async () => { mount(); await screen.findByLabelText('Rate limit (request/phút/user)'); fireEvent.mouseDown(screen.getByRole('tab',{name:'Providers'}),{button:0,ctrlKey:false});await screen.findByText('Bad AI'); };
it('test key thiếu model mở editor/red/focus và không gửi request',async()=>{
 m.providers[0]={...m.providers[0],enabled:true,models:[],default_model:null};await showProviders();fireEvent.click(screen.getByRole('button',{name:'Test key'}));
 await waitFor(()=>expect(document.activeElement?.getAttribute('name')).toBe('models'));expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');expect(m.fetch).not.toHaveBeenCalled();
});
it.each([{body:null},{body:{}},{body:{choices:[]}},{body:{choices:[{message:{role:'assistant',content:''}}]}}])('HTTP200 test key malformed không báo kết nối OK: %j',async({body})=>{
 m.providers[0]={...m.providers[0],enabled:true};m.fetch.mockResolvedValue({ok:true,status:200,json:async()=>body});await showProviders();fireEvent.click(screen.getByRole('button',{name:'Test key'}));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toMatch(/chưa xác nhận/i));expect(m.toast.success).not.toHaveBeenCalled();
});
it('test key completion có nội dung mới báo kết nối OK',async()=>{
 m.providers[0]={...m.providers[0],enabled:true};m.fetch.mockResolvedValue({ok:true,status:200,json:async()=>({choices:[{message:{role:'assistant',content:'pong'}}]})});await showProviders();fireEvent.click(screen.getByRole('button',{name:'Test key'}));await waitFor(()=>expect(m.toast.success).toHaveBeenCalledWith(expect.stringMatching(/Bad AI: OK/)));
});
it('usage pagination không cắt 1000 request khi nguồn có 1001 dòng',async()=>{
 m.usageRows=Array.from({length:1001},(_,i)=>({id:`log-${i}`,user_id:'u',owner_id:'u',provider:'p',model:'m',feature:'chat',total_tokens:1,cost_usd:0,reserved_cost_usd:0,status:'ok',created_at:'2026-09-30T00:00:00Z'}));
 mount();await screen.findByLabelText('Rate limit (request/phút/user)');fireEvent.mouseDown(screen.getByRole('tab',{name:'Sử dụng'}),{button:0,ctrlKey:false});await screen.findByText('Request 7 ngày');
 expect(m.ranges).toHaveBeenCalledWith(1000,1999);expect(screen.getByText('Request 7 ngày').parentElement?.textContent).toContain('1001');
});
it('usage null page không hiện 0 tổng như nguồn xác nhận',async()=>{
 m.malformedUsage=true;mount();await screen.findByLabelText('Rate limit (request/phút/user)');fireEvent.mouseDown(screen.getByRole('tab',{name:'Sử dụng'}),{button:0,ctrlKey:false});await screen.findByRole('alert');expect(screen.queryByText('Request 7 ngày')).toBeNull();
});

it('settings unknown sau remount không gửi writer lần hai', async () => {
 const first = mount(); let input = await screen.findByLabelText('Cap USD/ngày mỗi USER'); fireEvent.change(input, { target: { value: '4.2' } }); fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));
 await waitFor(() => expect(m.writes).toHaveBeenCalledOnce()); await screen.findByRole('alert'); first.unmount();
 mount(); input = await screen.findByLabelText('Cap USD/ngày mỗi USER'); fireEvent.change(input, { target: { value: '4.2' } }); fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));
 await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa xác nhận')); expect(m.writes).toHaveBeenCalledOnce(); expect((input as HTMLInputElement).value).toBe('4.2');
});
