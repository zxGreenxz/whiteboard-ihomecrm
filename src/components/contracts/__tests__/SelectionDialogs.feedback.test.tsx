// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({error:{code:'42501',message:'raw SQL'} as unknown}));
const query=(data:unknown)=>({data,error:h.error,isError:!!h.error,isLoading:false,status:h.error?'error':'success',fetchStatus:'idle',refetch:vi.fn()});
vi.mock('@/hooks/useCustomers',()=>({useCustomers:()=>query(h.error?undefined:{data:[]}),useSeedCustomerIntoPickerCache:()=>vi.fn()}));
vi.mock('@/hooks/useServices',()=>({useServices:()=>query(h.error?undefined:[])}));
vi.mock('@/components/customers/CreateCustomerDialog',()=>({CreateCustomerDialog:()=>null}));
import {CustomerSelectionDialog} from '../CustomerSelectionDialog';
import {ServiceSelectionDialog} from '../ServiceSelectionDialog';
afterEach(()=>{cleanup();h.error={code:'42501',message:'raw SQL'};});
it.each(['customer','service'])('does not present a failed %s picker as no results or clear existing selections',kind=>{
 const select=vi.fn();const close=vi.fn();render(kind==='customer'?<CustomerSelectionDialog open onOpenChange={close} onSelect={select} selectedCustomerIds={['old']}/>:<ServiceSelectionDialog open onOpenChange={close} onSelect={select} selectedServiceIds={['old']}/>);
 expect(screen.getByRole('alert').textContent).toContain('Chưa tải được');expect(document.body.textContent).not.toContain('raw SQL');
 fireEvent.click(screen.getByRole('button',{name:/Xác nhận/}));expect(select).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();expect(screen.queryByText(/Không tìm thấy/)).toBeNull();
});
it.each(['customer','service'])('allows truly empty %s sources without claiming a load failure',kind=>{
 h.error=null;render(kind==='customer'?<CustomerSelectionDialog open onOpenChange={vi.fn()} onSelect={vi.fn()} selectedCustomerIds={[]}/>:<ServiceSelectionDialog open onOpenChange={vi.fn()} onSelect={vi.fn()} selectedServiceIds={[]}/>);
 expect(screen.getByText(/Không tìm thấy/)).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
});
