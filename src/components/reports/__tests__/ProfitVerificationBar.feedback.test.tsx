// @vitest-environment jsdom
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {it,expect,vi,afterEach} from 'vitest';
const m=vi.hoisted(()=>({refetch:vi.fn()}));
vi.mock('@/hooks/useProfitVerification',()=>({useProfitVerification:()=>({data:undefined,status:'error',fetchStatus:'idle',isLoading:false,isError:true,error:new Error('SQL private_table'),refetch:m.refetch})}));
import {ProfitVerificationBar} from '../ProfitVerificationBar';
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('thu gọn vẫn có lỗi nguồn an toàn và tải lại, mở chi tiết không lộ raw',async()=>{render(<ProfitVerificationBar ym="2026-09" startDate="2026-09-01" endDate="2026-09-30" monthLabel="9" accrualMode pnlOnly totalIncome={0} totalExpense={0} shownIncomeSum={0} shownExpenseSum={0} hiddenCount={0} hiddenIncomeSum={0} hiddenExpenseSum={0}/>);expect(screen.getByRole('alert').textContent).toContain('Chưa tải được');fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await Promise.resolve();expect(m.refetch).toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:/Kiểm chứng/}));expect(document.body.textContent).not.toContain('private_table');expect(document.body.textContent).not.toContain('UNAVAILABLE');});
