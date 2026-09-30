// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const h=vi.hoisted(()=>({save:vi.fn(),balanceError:false}));
vi.mock('@/hooks/useCashbookClosing',()=>{
  const query=(data:unknown,error:unknown=null)=>({data,error,isError:!!error,isLoading:false,status:error?'error':'success',fetchStatus:'idle',refetch:vi.fn()});
  return {useClosingBlockers:()=>query([]),useCashbookBalanceAsOf:()=>query(h.balanceError?undefined:0,h.balanceError?new Error('SQL secret'):null),useCashbookCloseConfirmers:()=>query([{user_id:'u',full_name:'An'}]),useProposeCashbookClosing:()=>({mutateAsync:h.save,isPending:false})};
});
import CloseCashbookDialog from './CloseCashbookDialog';
afterEach(cleanup);beforeEach(()=>{h.save.mockReset();h.balanceError=false;});
describe('closing form feedback',()=>{
  it('marks all missing fields in step two and focuses counted balance first',async()=>{
    render(<CloseCashbookDialog open onOpenChange={vi.fn()} cashbookId="b" candidates={[{user_id:'u',full_name:'An'}]} />);
    fireEvent.click(screen.getByText('Tiếp tục'));fireEvent.click(screen.getByText('Tiếp tục'));
    await screen.findByText('Nhập số tiền thực kiểm đếm.');expect(screen.getByText('Chọn người xác nhận chốt sổ.')).toBeTruthy();
    await waitFor(()=>expect(document.activeElement?.id).toBe('counted'));expect(h.save).not.toHaveBeenCalled();
  });
  it('blocks the wizard when its required balance could not be loaded',async()=>{
    h.balanceError=true;render(<CloseCashbookDialog open onOpenChange={vi.fn()} cashbookId="b" candidates={[]} />);
    expect(screen.getByText('Tiếp tục').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Chưa tải được dữ liệu chốt sổ/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('SQL secret');
  });
});
