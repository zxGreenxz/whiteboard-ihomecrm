// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({customer:undefined as unknown,error:{code:'42501',message:'denied'} as unknown,perms:undefined as unknown}));
const query=(data:unknown,error:unknown)=>({data,error,isError:!!error,isLoading:false,status:error?'error':'success',fetchStatus:'idle',refetch:vi.fn()});
vi.mock('@/hooks/useCustomers',()=>({useCustomer:()=>query(h.customer,h.error)}));
vi.mock('@/hooks/useVehicles',()=>({useVehicles:()=>query(undefined,{code:'500',message:'raw SQL table'})}));
vi.mock('@/hooks/useCustomerDetailContracts',()=>({useCustomerDetailContracts:()=>query(undefined,{code:'500',message:'raw SQL table'})}));
vi.mock('@tanstack/react-query',()=>({useQuery:()=>query(undefined,{code:'500',message:'raw SQL table'})}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:h.perms})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{}}));
vi.mock('@/components/contracts/detail/useDragScroll',()=>({useDragScroll:()=>{}}));
vi.mock('@/components/customers/DeleteCustomerDialog',()=>({default:()=>null}));
vi.mock('@/components/residence/ResidenceDossierSection',()=>({default:()=>null}));
import CustomerDetailMobilePage from '../CustomerDetailMobilePage';
afterEach(()=>{cleanup();h.customer=undefined;h.error={code:'42501',message:'denied'};h.perms=undefined;});
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

it('shows CCCD images on mobile and opens them full screen',()=>{
 h.customer={id:'c',full_name:'An',id_images:{front:'https://img.test/front.jpg',back:'https://img.test/back.jpg',passport:''}};h.error=null;
 render(<MemoryRouter><CustomerDetailMobilePage id="c"/></MemoryRouter>);
 expect(screen.getByText('Ảnh CCCD/CMND')).toBeTruthy();
 expect(screen.getByAltText('CCCD Mặt trước').getAttribute('src')).toBe('https://img.test/front.jpg');
 expect(screen.getByAltText('CCCD Mặt sau').getAttribute('src')).toBe('https://img.test/back.jpg');
 expect(screen.queryByText('Hộ chiếu')).toBeNull();
 expect(screen.queryByRole('dialog',{name:'Ảnh đính kèm'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Xem ảnh Mặt sau'}));
 const box=screen.getByRole('dialog',{name:'Ảnh đính kèm'});
 expect(box.textContent).toContain('2 / 2');
 expect(box.querySelector('img')?.getAttribute('src')).toBe('https://img.test/back.jpg');
});

it('says when a customer has no CCCD images and offers editors a way to add them',()=>{
 h.customer={id:'c',full_name:'An',id_images:[]};h.error=null;
 render(<MemoryRouter><CustomerDetailMobilePage id="c"/></MemoryRouter>);
 expect(screen.getByText('Chưa có ảnh giấy tờ')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Bổ sung ảnh'})).toBeNull();
 cleanup();h.perms={customers:{edit:true}};
 render(<MemoryRouter><CustomerDetailMobilePage id="c"/></MemoryRouter>);
 expect(screen.getByRole('button',{name:'Bổ sung ảnh'})).toBeTruthy();
});
