// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({create:vi.fn()}));
vi.mock('@/hooks/useIncomeExpenses', () => ({useCreateIncomeExpenseBatch:()=>({mutateAsync:h.create,isPending:false})}));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({useIncomeExpenseFormBuildings:()=>({data:[{id:'b1',name:'Toà A',managed:true}]}),useIncomeExpenseFormRooms:()=>({data:[]})}));
vi.mock('@/hooks/useAccounts', () => ({useAccounts:()=>({data:[{id:'a1',name:'Tiền mặt'}]})}));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({useIncomeExpenseTypes:()=>({data:[]})}));
vi.mock('@/hooks/useAuth', () => ({useAuth:()=>({data:{id:'u1'}})}));
vi.mock('@/hooks/use-mobile', () => ({useIsMobile:()=>false}));
vi.mock('../AttachmentUpload', () => ({default:()=>null}));
vi.mock('../IncomeExpenseItemSelector', () => ({default:({open,onSelect,onOpenChange}:{open:boolean;onSelect:(items:{id:string;name:string}[])=>void;onOpenChange:(open:boolean)=>void})=>open ? <button onClick={()=>{onSelect([{id:'t1',name:'Sửa chữa'}]);onOpenChange(false);}}>Chọn sửa chữa</button> : null}));
import IncomeExpenseBatchForm from '../IncomeExpenseBatchForm';
class ResizeObserverFake { observe(){} unobserve(){} disconnect(){} }
vi.stubGlobal('ResizeObserver', ResizeObserverFake);
afterEach(cleanup);
describe('C03/C04 phiếu tổng', () => {
  it('hiện lỗi Tòa nhà tại đúng dòng, không âm thầm bỏ qua lỗi items', async () => {
    render(<IncomeExpenseBatchForm open onOpenChange={()=>{}} />);
    fireEvent.click(screen.getByRole('button',{name:'Thêm hạng mục'}));
    fireEvent.click(screen.getByText('Chọn sửa chữa'));
    fireEvent.click(screen.getByRole('button',{name:'Lưu 1 phiếu'}));
    const toa = await screen.findByRole('combobox',{name:'Tòa nhà hạng mục 1'});
    await waitFor(()=>expect(toa.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText('Vui lòng chọn tòa nhà')).toBeTruthy();
    expect(toa.getAttribute('aria-describedby')).toBe('batch-item-0-building_id-error');
    const so = screen.getByRole('combobox',{name:'Sổ quỹ *'});
    await waitFor(()=>expect(document.activeElement).toBe(so));
    expect(h.create).not.toHaveBeenCalled();
  });
});
