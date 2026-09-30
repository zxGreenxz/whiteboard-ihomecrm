// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
const m=vi.hoisted(()=>({contractWrites:vi.fn(),relationError:null as unknown,contractError:null as unknown,parse:vi.fn(),toast:vi.fn()}));
const org='11111111-1111-4111-8111-111111111111',building='22222222-2222-4222-8222-222222222222',customer='33333333-3333-4333-8333-333333333333',room='44444444-4444-4444-8444-444444444444',contract='55555555-5555-4555-8555-555555555555';
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'11111111-1111-4111-8111-111111111111'})}));
vi.mock('@/hooks/useBuildings',()=>({useBuildings:()=>({data:[{id:'22222222-2222-4222-8222-222222222222',name:'Tòa A'}]})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'user-1'})}));
vi.mock('sonner',()=>({toast:{error:m.toast,success:m.toast}}));
vi.mock('@/components/ui/select',()=>({Select:({children,onValueChange}:{children:unknown;onValueChange:(v:string)=>void})=><div><button onClick={()=>onValueChange('22222222-2222-4222-8222-222222222222')}>Chọn Tòa A</button>{children as React.ReactNode}</div>,SelectTrigger:({children}:{children:React.ReactNode})=><span>{children}</span>,SelectValue:()=>null,SelectContent:({children}:{children:React.ReactNode})=><span>{children}</span>,SelectItem:({children}:{children:React.ReactNode})=><span>{children}</span>}));
vi.mock('@/lib/contractExcelHelpers',()=>({parseContractExcel:m.parse,downloadContractImportTemplate:vi.fn(),exportContracts:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:(table:string)=>{
 let write=false,insert=false;const port={then:(resolve:(v:unknown)=>void)=>{let data:unknown=[],error:unknown=null;
 if(table==='rooms')data=write?null:[{id:'44444444-4444-4444-8444-444444444444',name:'101',code:'101',status:'OCCUPIED',organization_id:'11111111-1111-4111-8111-111111111111'}];
 if(table==='customers')data=[{id:'33333333-3333-4333-8333-333333333333',full_name:'Khách A',phone:'0900000000',id_number:null,organization_id:'11111111-1111-4111-8111-111111111111'}];
 if(table==='contracts'){data={id:'55555555-5555-4555-8555-555555555555',organization_id:'11111111-1111-4111-8111-111111111111',room_id:'44444444-4444-4444-8444-444444444444',status:'ACTIVE',signed_date:'2026-09-01',start_date:'2026-10-01',end_date:'2027-10-01',rent_price:5000000,total_deposit:5000000};if(insert){m.contractWrites();error=m.contractError;if(error)data=null;}}
 if(table==='contract_customers'){data=[{contract_id:'55555555-5555-4555-8555-555555555555',customer_id:'33333333-3333-4333-8333-333333333333',is_representative:true}];if(write)error=m.relationError;}
 return Promise.resolve({data,error}).then(resolve);}};
 return new Proxy(port,{get:(obj,key)=>key==='then'?obj.then:(..._args:unknown[])=>{if(key==='insert'){write=true;insert=true;}if(key==='update')write=true;return new Proxy(obj,{get:(_o,k)=>k==='then'?obj.then:(...args:unknown[])=>{if(k==='insert'){write=true;insert=true;}if(k==='update')write=true;return new Proxy(obj,{get:(_p,j)=>j==='then'?obj.then:()=>new Proxy(obj,{get:(_q,x)=>x==='then'?obj.then:()=>new Proxy(obj,{get:(_r,y)=>y==='then'?obj.then:()=>obj})})});}});}});
}}}));
import {ContractImportExportDialog} from '../ContractImportExportDialog';
const dataRow={source_row:9,room_name:'101',customer_name:'Khách A',customer_phone:'0900000000',signed_date:'2026-09-01',start_date:'2026-10-01',end_date:'2027-10-01',rent_price:5000000,payment_cycle:'MONTHLY',deposit:5000000};
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('crypto',webcrypto);localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId',org);m.relationError=null;m.contractError=null;m.parse.mockResolvedValue({success:[dataRow],errors:[]});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function prepare(){const view=render(<ContractImportExportDialog open mode="import" onOpenChange={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'Chọn Tòa A'}));fireEvent.change(document.querySelector('input[type=file]')!,{target:{files:[new File(['data'],'contracts.xlsx')]}});await waitFor(()=>expect(screen.getByRole('button',{name:'Nhập dữ liệu'}).hasAttribute('disabled')).toBe(false));fireEvent.click(screen.getByRole('button',{name:'Nhập dữ liệu'}));await screen.findByRole('button',{name:/Xác nhận nhập/});return view;}
it('reports a created contract against its original source row and retains IDs after remount',async()=>{
 m.relationError={code:'42501',message:'permission denied'};
 const view=await prepare();fireEvent.click(screen.getByRole('button',{name:/Xác nhận nhập/}));await screen.findByText(/Bản ghi đã tạo/);
 expect(screen.getByText(/Bản ghi đã tạo/).textContent).toContain('dòng 9');view.unmount();
 render(<ContractImportExportDialog open mode="import" onOpenChange={vi.fn()}/>);
 await waitFor(()=>expect(screen.getByText(/Bản ghi đã tạo/).textContent).toContain(contract));expect(m.contractWrites).toHaveBeenCalledOnce();
});
it('blocks another contract writer after an unconfirmed insert across remount',async()=>{
 m.contractError=new TypeError('Failed to fetch');const view=await prepare();fireEvent.click(screen.getByRole('button',{name:/Xác nhận nhập/}));await waitFor(()=>expect(m.contractWrites).toHaveBeenCalledOnce());await screen.findAllByText(/chưa.*xác nhận|chưa.*đối chiếu/i);view.unmount();
 render(<ContractImportExportDialog open mode="import" onOpenChange={vi.fn()}/>);await waitFor(()=>expect(screen.getByText(/Lượt nhập trước chưa hoàn tất/)).toBeTruthy());expect(screen.queryByRole('button',{name:/Xác nhận nhập/})).toBeNull();expect(m.contractWrites).toHaveBeenCalledOnce();
});
