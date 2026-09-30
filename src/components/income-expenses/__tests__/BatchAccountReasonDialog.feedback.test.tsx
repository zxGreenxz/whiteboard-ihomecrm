// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import BatchAccountReasonDialog from '../BatchAccountReasonDialog';
afterEach(cleanup);
it('thiếu lý do đổi sổ đỏ và focus, không gọi mutation',async()=>{const save=vi.fn();render(<BatchAccountReasonDialog open onOpenChange={()=>{}} fromName="A" toName="B" voucherCount={2} pending={false} onConfirm={save}/>);fireEvent.click(screen.getByRole('button',{name:'Đổi sổ'}));await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole('textbox',{name:'Lý do đổi sổ *'})));expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');expect(save).not.toHaveBeenCalled();});
it('partial giữ link phiếu và khóa đổi cả đợt',()=>{render(<BatchAccountReasonDialog open onOpenChange={()=>{}} fromName="A" toName="B" voucherCount={2} pending={false} onConfirm={vi.fn()} blocked error="Đã đổi sổ một phiếu. Kiểm tra đợt trước khi tiếp tục." completedIds={['v1']}/>);expect((screen.getByRole('button',{name:'Đổi sổ'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole('link').getAttribute('href')).toBe('/income-expense/voucher/v1');});
