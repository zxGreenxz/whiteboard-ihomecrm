// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
type QueryFixture = { data: unknown; status: string; fetchStatus: string; isLoading: boolean; isError: boolean; error: unknown; refetch: ReturnType<typeof vi.fn> };
const h=vi.hoisted(()=>({q:{} as QueryFixture,navigate:vi.fn()}));
vi.mock('@/hooks/useIsAdmin',()=>({useIsAdmin:()=>h.q}));
vi.mock('react-router-dom',()=>({Navigate:(p: {to: string; replace?: boolean})=>{h.navigate(p);return <p>redirect</p>}}));
vi.mock('@/hooks/useStatBreakdowns',()=>({useDepositBreakdown:()=>h.q}));
vi.mock('@/hooks/useThanhToanLedgers',()=>({useDepositLedger:()=>h.q,useDepositLedgerSummary:()=>({total:0,posted:0,postedN:0,virtual:0,virtualN:0,pending:0,pendingN:0})}));
import {AdminOnlyRoute} from '@/components/auth/AdminOnlyRoute';
import DepositBreakdownDialog from '@/components/invoices/DepositBreakdownDialog';
import {DepositLedgerSection} from '@/components/thu-tien/SettlementPanels';
beforeEach(()=>{h.navigate.mockClear();h.q={data:undefined,status:'error',fetchStatus:'idle',isLoading:false,isError:true,error:{code:'XX000',message:'SELECT secret FROM private'},refetch:vi.fn()};});
afterEach(cleanup);
it('admin permission failure remains retryable and does not redirect or reveal content',async()=>{
 render(<AdminOnlyRoute><p>Private admin</p></AdminOnlyRoute>);
 expect(h.navigate).not.toHaveBeenCalled();expect(screen.queryByText('Private admin')).toBeNull();
 expect(screen.getByRole('alert').textContent).toContain('Chưa tải được quyền quản trị');
 expect(document.body.textContent).not.toContain('SELECT');fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await waitFor(()=>expect(h.q.refetch).toHaveBeenCalledOnce());
});
it('confirmed false admin retains the existing redirect',()=>{h.q={...h.q,data:false,status:'success',isError:false,error:null};render(<AdminOnlyRoute><p>Private admin</p></AdminOnlyRoute>);expect(h.navigate).toHaveBeenCalledOnce();});
it('deposit ledger failure hides zero summaries and genuine-empty message',()=>{render(<DepositLedgerSection period="2026-09"/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải được sổ theo dõi cọc đã thu');expect(screen.queryByText('Phiếu cọc kỳ này')).toBeNull();expect(screen.queryByText(/Kỳ này không có/)).toBeNull();});
it('deposit breakdown failure hides empty data and technical cause',()=>{render(<DepositBreakdownDialog open onOpenChange={()=>{}}/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải được cọc đã thu trong kỳ');expect(document.body.textContent).not.toContain('SELECT secret');expect(screen.getByRole('button',{name:'Tải lại'})).toBeTruthy();});
