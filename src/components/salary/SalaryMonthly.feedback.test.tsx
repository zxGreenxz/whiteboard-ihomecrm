// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdjustDialog, BulkPayoutDialog, PayoutDialog } from './SalaryMonthly';
import type { SalManager } from '@/lib/managerSalary';
const manager = {id:'staff',name:'An',short:'An',calc:{takehome:100},paid:0} as SalManager;
afterEach(cleanup);
describe('salary form feedback', () => {
  it('shows both missing fields and focuses the first in the adjustment form', async () => {
    const save = vi.fn();
    const {container} = render(<AdjustDialog m={manager} onClose={vi.fn()} onSave={save} />);
    fireEvent.click(screen.getByText('Lưu'));
    await screen.findByText('Nhập tên khoản thưởng/trừ.');
    expect(screen.getByText('Nhập số tiền lớn hơn 0 đồng.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('[name="label"]')));
    expect(save).not.toHaveBeenCalled();
  });
  it('keeps the bulk dialog visible until the actual submission succeeds', async () => {
    const close = vi.fn();
    render(<BulkPayoutDialog managers={[manager]} accounts={[{id:'a',name:'Sổ A'}]} period={{label:'Tháng 9',year:2026}} onClose={close} onSave={async () => {throw new Error('SQL internal');}} />);
    fireEvent.click(screen.getByText('Ghi 1 phiếu chi'));
    await screen.findByRole('alert');
    expect(close).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('SQL internal');
  });
});

it.each(['-100','abc100','1.5'])('rejects invalid adjustment amount %s without rewriting the entered text',async value=>{
 const save=vi.fn();const {container}=render(<AdjustDialog m={manager} onClose={vi.fn()} onSave={save}/>);
 fireEvent.change(container.querySelector('[name="label"]')!,{target:{value:'Thưởng'}});
 const field=container.querySelector('[name="amount"]') as HTMLInputElement;
 fireEvent.change(field,{target:{value}});fireEvent.click(screen.getByText('Lưu'));
 await screen.findByText(value.startsWith('-')?'Số tiền không được âm.':'Nhập số tiền nguyên theo đồng, ví dụ 800.000; không nhập chữ hoặc số lẻ.');
 expect(field.value).toBe(value);expect(field.getAttribute('aria-invalid')).toBe('true');
 await waitFor(()=>expect(document.activeElement).toBe(field));expect(save).not.toHaveBeenCalled();
});
it.each(['-100','abc100','1.5'])('rejects invalid payout amount %s without sending a positive value',async value=>{
 const save=vi.fn();const {container}=render(<PayoutDialog m={manager} accounts={[{id:'a',name:'Sổ A'}]} period={{label:'Tháng 9',year:2026}} onClose={vi.fn()} onSave={save}/>);
 const field=container.querySelector('[name="amount"]') as HTMLInputElement;
 fireEvent.change(field,{target:{value}});fireEvent.click(screen.getByText('Ghi phiếu chi'));
 await screen.findByText(value.startsWith('-')?'Số tiền không được âm.':'Nhập số tiền nguyên theo đồng, ví dụ 800.000; không nhập chữ hoặc số lẻ.');
 expect(field.value).toBe(value);expect(field.getAttribute('aria-invalid')).toBe('true');expect(save).not.toHaveBeenCalled();
});
