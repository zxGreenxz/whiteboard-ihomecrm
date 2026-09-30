// @vitest-environment jsdom
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({org:'org-a',revision:1,knowers:[] as string[],rpc:vi.fn(),update:vi.fn(),success:vi.fn()}));
const q=(data:unknown)=>({data,status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()});
type QueryOptionsFixture = { enabled?: boolean; queryKey: readonly unknown[] };
type MutationOptionsFixture = { mutationFn: (value: unknown) => Promise<unknown>; onSuccess?: (data: unknown, value: unknown) => unknown };
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({invalidateQueries:vi.fn()}),useQuery:(o:QueryOptionsFixture)=>{if(o.enabled===false)return q(undefined);const key=o.queryKey[0];if(key==='cashbook-access-admin-v2')return q({cashbook_id:o.queryKey[1],revision:m.revision,custodians:[{membership_id:'m1',user_id:'u1'}],knowers:m.knowers.map(id=>({membership_id:id,user_id:id==='m2'?'u2':'u3'})),eligible_memberships:[{membership_id:'m1',user_id:'u1'},{membership_id:'m2',user_id:'u2'},{membership_id:'m3',user_id:'u3'}]});if(key==='profile-labels')return q(new Map([['u1','Alpha'],['u2','Beta'],['u3','Gamma']]));return q(null);},useMutation:(o:MutationOptionsFixture)=>({isPending:false,mutateAsync:async(args:unknown)=>{const r=await o.mutationFn(args);await o.onSuccess?.(r,args);return r;}})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:m.rpc}}));
vi.mock('@/hooks/useAccounts',()=>({useCreateAccount:()=>({isPending:false,mutateAsync:m.update}),useUpdateAccount:()=>({isPending:false,mutateAsync:m.update})}));
vi.mock('@/hooks/use-mobile',()=>({useIsMobile:()=>false}));
vi.mock('@/hooks/useIsAdmin',()=>({useIsAdmin:()=>q(true)}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>q({})}));
vi.mock('@/lib/permissionPages',()=>({canUse:()=>true}));
vi.mock('@/hooks/useStaffUsers',()=>({useStaffUsers:()=>q([{id:'u1',full_name:'Alpha'}])}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>q([])}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>q({id:'u1'})}));
vi.mock('@/lib/financeV2Route',()=>({useFinanceV2Routes:()=>({...q({}),getOrg:()=>({})}),isCanonicalAccess:()=>true}));
vi.mock('sonner',()=>({toast:{success:m.success,error:vi.fn()}}));
import CashbookForm from '../CashbookForm';
const book=(id:string)=>({id,name:`Sổ ${id}`,user_id:'u1',organization_id:'org',initial_amount:0,initial_date:'2026-10-01'} as never);
beforeEach(()=>{m.org='org-a';vi.stubGlobal('ResizeObserver',class{observe(){} unobserve(){} disconnect(){}});m.revision=1;m.knowers=[];m.update.mockResolvedValue(undefined);m.rpc.mockImplementation(async(_name,args)=>({data:{cashbook_id:args.p_cashbook_id,revision:args.p_expected_revision+1,custodian_count:args.p_custodians.length,knower_count:args.p_knowers.length},error:null}));});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();});
it('draft quyền giữ revision gốc dù nguồn tải lại phiên bản mới',async()=>{const a=book('A');const view=render(<CashbookForm open account={a} onOpenChange={vi.fn()}/>);fireEvent.click(screen.getAllByRole('checkbox',{name:'Beta'})[1]);m.revision=2;m.knowers=['m3'];view.rerender(<CashbookForm open account={a} onOpenChange={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(m.rpc).toHaveBeenCalled());expect(m.rpc.mock.calls[0][1].p_expected_revision).toBe(1);expect(m.rpc.mock.calls[0][1].p_knowers).toEqual(['m2']);});
it('null receipt quyền sau lưu metadata là partial, giữ mã sổ và không success',async()=>{m.rpc.mockResolvedValue({data:null,error:null});const close=vi.fn();render(<CashbookForm open account={book('A')} onOpenChange={close}/>);fireEvent.click(screen.getAllByRole('checkbox',{name:'Beta'})[1]);fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('A'));expect(m.success).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();expect((screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement).disabled).toBe(true);});
it('unknown sổ A không lẫn bản nháp/khóa sang B và còn giữ khi trở về A',async()=>{m.update.mockRejectedValue(new TypeError('Failed to fetch'));const a=book('A'),b=book('B');const close=vi.fn();const view=render(<CashbookForm open account={a} onOpenChange={close}/>);fireEvent.change(screen.getByRole('textbox',{name:/Tên sổ quỹ/}),{target:{value:'Bản nháp A'}});fireEvent.click(screen.getByRole('button',{name:'Lưu'}));await waitFor(()=>expect((screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement).disabled).toBe(true));view.rerender(<CashbookForm open={false} account={a} onOpenChange={close}/>);view.rerender(<CashbookForm open account={b} onOpenChange={close}/>);expect((screen.getByRole('textbox',{name:/Tên sổ quỹ/}) as HTMLInputElement).value).toBe('Sổ B');expect((screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement).disabled).toBe(false);view.rerender(<CashbookForm open account={a} onOpenChange={close}/>);expect((screen.getByRole('textbox',{name:/Tên sổ quỹ/}) as HTMLInputElement).value).toBe('Bản nháp A');expect((screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement).disabled).toBe(true);});

vi.mock('@/lib/persistentFinancialWorkflow',async()=>{const {FinancialWorkflowGuard}=await import('@/lib/financialWorkflow');return {persistentFinancialWorkflow:()=>new FinancialWorkflowGuard()};});

vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:m.org})}));

it('draft tạo sổ lỗi của tổ chức A không chặn hoặc lộ nội dung ở tổ chức B',async()=>{
 m.update.mockRejectedValue(new TypeError('Failed to fetch'));
 const props={account:null,open:true,onOpenChange:vi.fn()};const view=render(<CashbookForm {...props}/>);
 fireEvent.change(screen.getByRole('textbox',{name:/Tên sổ quỹ/}),{target:{value:'Bản nháp riêng A'}});
 fireEvent.click(screen.getByRole('button',{name:'Lưu'}));
 await waitFor(()=>expect((screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement).disabled).toBe(true));
 m.org='org-b';view.rerender(<CashbookForm {...props}/>);
 expect((screen.getByRole('textbox',{name:/Tên sổ quỹ/}) as HTMLInputElement).value).not.toContain('riêng A');
 expect((screen.getByRole('button',{name:'Lưu'}) as HTMLButtonElement).disabled).toBe(false);
});
