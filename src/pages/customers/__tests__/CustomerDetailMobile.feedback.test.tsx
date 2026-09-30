// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({customer:undefined as unknown,error:{code:'42501',message:'denied'} as unknown}));
const query=(data:unknown,error:unknown)=>({data,error,isError:!!error,isLoading:false,status:error?'error':'success',fetchStatus:'idle',refetch:vi.fn()});
vi.mock('@/hooks/useCustomers',()=>({useCustomer:()=>query(h.customer,h.error)}));
vi.mock('@/hooks/useVehicles',()=>({useVehicles:()=>query(undefined,{code:'500',message:'raw SQL table'})}));
vi.mock('@/hooks/useCustomerDetailContracts',()=>({useCustomerDetailContracts:()=>query(undefined,{code:'500',message:'raw SQL table'})}));
vi.mock('@tanstack/react-query',()=>({useQuery:()=>query(undefined,{code:'500',message:'raw SQL table'})}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:undefined})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/components/contracts/detail/useDragScroll',()=>({useDragScroll:()=>{}}));
vi.mock('@/components/customers/DeleteCustomerDialog',()=>({default:()=>null}));
vi.mock('@/components/residence/ResidenceDossierSection',()=>({default:()=>null}));
import CustomerDetailMobilePage from '../CustomerDetailMobilePage';
afterEach(()=>{cleanup();h.customer=undefined;h.error={code:'42501',message:'denied'};});
it('does not label a permission/read failure as customer not found',()=>{
 render(<MemoryRouter><CustomerDetailMobilePage id="c"/></MemoryRouter>);
 expect(screen.getByText('Chưa tải được chi tiết khách hàng.')).toBeTruthy();
 expect(screen.queryByText('Không tìm thấy khách hàng với ID này.')).toBeNull();
});
it('shows errors for mobile vehicles/contracts without claiming empty lists',()=>{
 h.customer={id:'c',full_name:'An',phone:null};h.error=null;
 render(<MemoryRouter><CustomerDetailMobilePage id="c"/></MemoryRouter>);
 expect(screen.getByText('Chưa tải được phương tiện của khách hàng.')).toBeTruthy();
 expect(screen.getByText('Chưa tải được hợp đồng của khách hàng.')).toBeTruthy();
 expect(screen.queryByText('Chưa có phương tiện')).toBeNull();expect(screen.queryByText('Chưa có hợp đồng')).toBeNull();
 expect(document.body.textContent).not.toContain('raw SQL');
});

it('hides cached customer name after permission revocation on mobile',()=>{
 h.customer={id:'c',full_name:'Private customer'};h.error={code:'42501',message:'denied'};
 render(<MemoryRouter><CustomerDetailMobilePage id="c"/></MemoryRouter>);
 expect(screen.getByText('Chưa tải được chi tiết khách hàng.')).toBeTruthy();expect(document.body.textContent).not.toContain('Private customer');
});
