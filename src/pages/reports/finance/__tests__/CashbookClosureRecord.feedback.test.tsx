// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ extras: {data:undefined,status:'error',fetchStatus:'idle',isLoading:false,isError:true,error:null,refetch:vi.fn()} as {data:unknown;status:'error'|'pending'|'success';fetchStatus:string;isLoading:boolean;isError:boolean;error:unknown;refetch:ReturnType<typeof vi.fn>}, closure: { closure_id:'closure-1', cashbook_id:'account-1', cashbook_name:'Quỹ chính', closed_through:'2026-09-01', confirmed_at:'2026-09-02', difference:0, system_balance:99000, counted_balance:99000 } }));
vi.mock('react-router-dom', () => ({ useParams:()=>({closureId:'closure-1'}), useNavigate:()=>vi.fn(), useSearchParams:()=>[new URLSearchParams('print=1')] }));
vi.mock('@/hooks/useCashbookClosing', () => ({ useCashbookClosings:()=>({ data:{closures:[state.closure]}, status:'success', fetchStatus:'idle', isLoading:false, isError:false, error:null, refetch:vi.fn() }) }));
vi.mock('@tanstack/react-query', () => ({useQuery:()=>state.extras}));
vi.mock('@/integrations/supabase/client', () => ({supabase:{}}));
import CashbookClosureRecord from '../CashbookClosureRecord';
describe('biên bản cần đủ nguồn trước khi in', () => {
 beforeEach(()=>{vi.useFakeTimers(); vi.stubGlobal('print',vi.fn()); state.extras={data:undefined,status:'error',fetchStatus:'idle',isLoading:false,isError:true,error:{code:'42501',message:'permission denied accounts'},refetch:vi.fn()};});
 afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
 it('không in hoặc hiển thị biên bản thiếu dữ liệu phụ khi đọc lỗi',()=>{render(<CashbookClosureRecord/>);vi.advanceTimersByTime(500);expect(window.print).not.toHaveBeenCalled();expect(screen.getByRole('alert').textContent).toContain('Chưa tải được');expect(screen.queryByText('99.000 đ')).toBeNull();expect(screen.queryByText(/permission denied/)).toBeNull();});
 it('đợi tải nguồn phụ trước khi tự in',()=>{state.extras={...state.extras,status:'pending',fetchStatus:'fetching',isLoading:true,isError:false,error:null};render(<CashbookClosureRecord/>);vi.advanceTimersByTime(500);expect(window.print).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'In biên bản'})).toBeNull();});
});
