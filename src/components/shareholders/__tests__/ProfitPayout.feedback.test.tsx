// @vitest-environment jsdom
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('@/hooks/useAccounts',()=>({useAccounts:()=>({data:[{id:'a',name:'Quỹ',is_virtual:false,organization_id:'org-a'}],status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()})}));
vi.mock('@/hooks/useIncomeExpenses',()=>({useCreateProfitDistribution:()=>({mutateAsync:m.create,isPending:false}),useCreateManagerSalaryPayout:()=>({mutateAsync:m.create,isPending:false})}));
vi.mock('@/components/ui/searchable-select',()=>({SearchableSelect:({options,onValueChange,...props}:{options:{value:string;label:string}[];onValueChange:(s:string)=>void;name:string;value:string})=><select {...props} onChange={e=>onValueChange(e.target.value)}><option value="">Chọn</option>{options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>}));
import ProfitDistributeDialog from '../ProfitDistributeDialog';
import ManagerSalaryPayoutDialog from '../ManagerSalaryPayoutDialog';
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('trống thì focus cổ đông, không gọi ghi phiếu',async()=>{
 render(<ProfitDistributeDialog open onOpenChange={vi.fn()} shareholders={[]}/>);
 fireEvent.click(screen.getByRole('button',{name:'Ghi phiếu chi'}));
 await waitFor(()=>expect(document.activeElement?.getAttribute('name')).toBe('shareholderId'));
 expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');expect(m.create).not.toHaveBeenCalled();
});
it('mất phản hồi giữ giá trị và chặn lập lại cả khi đóng rồi mở',async()=>{
 m.create.mockRejectedValue(new TypeError('Failed to fetch'));
 const close=vi.fn();const props={onOpenChange:close,shareholders:[{id:'s',name:'An'}] as never,defaultShareholderId:'s'};
 const view=render(<ProfitDistributeDialog open {...props}/>);
 fireEvent.change(document.querySelector('[name="amount"]')!,{target:{value:'500000'}});
 fireEvent.change(document.querySelector('[name="accountId"]')!,{target:{value:'a'}});
 fireEvent.click(screen.getByRole('button',{name:'Ghi phiếu chi'}));
 await screen.findByRole('alert');
 expect(close).not.toHaveBeenCalled();
 expect((screen.getByRole('button',{name:'Ghi phiếu chi'}) as HTMLButtonElement).disabled).toBe(true);
 view.rerender(<ProfitDistributeDialog open={false} {...props}/>);view.rerender(<ProfitDistributeDialog open {...props}/>);
 expect((screen.getByRole('button',{name:'Ghi phiếu chi'}) as HTMLButtonElement).disabled).toBe(true);
 expect((document.querySelector('[name="amount"]') as HTMLInputElement).value).toContain('500');expect(m.create).toHaveBeenCalledTimes(1);
});

it.each(['profit','manager'] as const)('ngày draft sai ở %s không gửi ngày cũ, giữ text/red/focus',async kind=>{
 const props={open:true,onOpenChange:vi.fn()};if(kind==='profit')render(<ProfitDistributeDialog {...props} shareholders={[{id:'s',name:'An'}] as never} defaultShareholderId="s"/>);else render(<ManagerSalaryPayoutDialog {...props} managers={[{id:'m',name:'An'}] as never} defaultManagerId="m"/>);
 fireEvent.change(document.querySelector('[name="amount"]')!,{target:{value:'500000'}});fireEvent.change(document.querySelector('[name="accountId"]')!,{target:{value:'a'}});
 const date=document.querySelector('[name="voucherDate"]') as HTMLInputElement;fireEvent.change(date,{target:{value:'31/02/2026'}});fireEvent.click(screen.getByRole('button',{name:'Ghi phiếu chi'}));
 await waitFor(()=>expect(document.activeElement).toBe(date));expect(date.getAttribute('aria-invalid')).toBe('true');expect(date.value).toBe('31/02/2026');expect(m.create).not.toHaveBeenCalled();expect(props.onOpenChange).not.toHaveBeenCalled();
});
