import type {ReactNode} from 'react';
// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:io.rpc,from:()=>{const b:Record<string,unknown>={select:()=>b,eq:()=>b,gte:()=>b,order:()=>b,limit:()=>b,then:(ok:(v:unknown)=>unknown)=>Promise.resolve({data:[],error:null}).then(ok)};return b;}}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o1'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'u1'}})}));
vi.mock('@/hooks/useStaffUsers',()=>({useStaffUsers:()=>({data:[],isLoading:false,isError:false,status:'success',fetchStatus:'idle',error:null,refetch:vi.fn()})}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{}})}));
vi.mock('@/components/layout/MainLayout',()=>({default:({children}:{children:ReactNode})=>children}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import {ReconcileDialog} from '../BanGiaoReport';
import type {SettlementAccount} from '@/hooks/useSettlementReport';
const account={account_id:'test-reconcile-account',name:'Quỹ thật',current_balance:1000} as SettlementAccount;
const renderDialog=(date:string)=>render(<QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false},queries:{retry:false}}})}><ReconcileDialog account={account} asOf={date} onClose={()=>{}}/></QueryClientProvider>);
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();});afterEach(cleanup);
it('số thực tế trống không đổi thành zero; đỏ và focus',async()=>{renderDialog('2026-09-01');const input=screen.getByLabelText('Số đếm/đối chiếu thực tế');fireEvent.change(input,{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'Chốt số'}));await waitFor(()=>expect(document.activeElement).toBe(input));expect(input.getAttribute('aria-invalid')).toBe('true');expect(io.rpc).not.toHaveBeenCalled();});
// Đợt 3 đổi: trước đây hộp mở lại bị khoá nút cho tới khi tải lại trang (khoá trong bộ nhớ).
// Đợt 10a đổi tiếp (trước: «bấm lại trong 2 phút báo đang chờ kết quả, không gửi lần hai»): propose_reconciliation nhận mã
// yêu cầu và trả lại đúng đề nghị đã tạo khi gửi lại cùng mã, nên lần bấm sau gửi lại NGAY. Hàng rào giữ nguyên: lần gửi lại
// mang ĐÚNG mã cũ (máy chủ không tạo đề nghị thứ hai), và «mã đã dùng với nội dung khác» không được báo là thành công.
const {toast}=await import('sonner');
const keys=()=>io.rpc.mock.calls.map(call=>(call[1] as {p_request_key?:unknown}).p_request_key);
it('timeout: mở lại vẫn bấm được; bấm lại gửi lại ngay CÙNG mã yêu cầu; mã đã dùng với nội dung khác không coi là thành công',async()=>{io.rpc.mockResolvedValue({data:null,error:new TypeError('Failed to fetch')});const first=renderDialog('2026-09-02');fireEvent.click(screen.getByRole('button',{name:'Chốt số'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Bấm lại để gửi lại'));expect(io.rpc).toHaveBeenCalledTimes(1);first.unmount();
  io.rpc.mockResolvedValue({data:null,error:{code:'23505',message:'Mã yêu cầu đã dùng với nội dung khác',details:'rc-cu',hint:'reconciliation_request_key_payload_mismatch'}});
  renderDialog('2026-09-02');const button=screen.getByRole('button',{name:'Chốt số'}) as HTMLButtonElement;expect(button.disabled).toBe(false);fireEvent.click(button);
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toMatch(/đã được tạo ở lần gửi trước/));
  expect(io.rpc).toHaveBeenCalledTimes(2);expect(keys()[0]).toMatch(/^[0-9a-f-]{36}$/);expect(keys()[1]).toBe(keys()[0]);
  expect(toast.success).not.toHaveBeenCalled();});
it('timeout rồi bấm lại, máy chủ trả lại đề nghị đã tạo (cùng mã): báo đã chốt, chỉ một mã yêu cầu cho cả hai lần gửi',async()=>{io.rpc.mockResolvedValueOnce({data:null,error:new TypeError('Failed to fetch')});const first=renderDialog('2026-09-03');fireEvent.click(screen.getByRole('button',{name:'Chốt số'}));await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy());first.unmount();
  io.rpc.mockResolvedValueOnce({data:{id:'rc-1',status:'CONFIRMED',system_balance:1000,diff:0,replayed:true},error:null});
  renderDialog('2026-09-03');fireEvent.click(screen.getByRole('button',{name:'Chốt số'}));
  await waitFor(()=>expect(toast.success).toHaveBeenCalledTimes(1));
  expect(io.rpc).toHaveBeenCalledTimes(2);expect(keys()[1]).toBe(keys()[0]);});
