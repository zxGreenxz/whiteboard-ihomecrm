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
// Đợt 3 đổi: trước đây hộp mở lại bị khoá nút cho tới khi tải lại trang (khoá trong bộ nhớ). Nay lần bấm sau đi qua
// phép đối chiếu: dưới 2 phút báo đang chờ kết quả, không gửi lần hai; quá 2 phút không thấy đề nghị nào mới gửi lại.
it('timeout: mở lại vẫn bấm được; bấm lại trong 2 phút báo đang chờ kết quả, không gửi lần hai',async()=>{io.rpc.mockResolvedValue({data:null,error:new TypeError('Failed to fetch')});const first=renderDialog('2026-09-02');fireEvent.click(screen.getByRole('button',{name:'Chốt số'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Bấm lại sau ít phút'));expect(io.rpc).toHaveBeenCalledTimes(1);first.unmount();renderDialog('2026-09-02');const button=screen.getByRole('button',{name:'Chốt số'}) as HTMLButtonElement;expect(button.disabled).toBe(false);fireEvent.click(button);await waitFor(()=>expect(screen.getByRole('alert').textContent).toMatch(/đang chờ kết quả/));expect(io.rpc).toHaveBeenCalledTimes(1);});
