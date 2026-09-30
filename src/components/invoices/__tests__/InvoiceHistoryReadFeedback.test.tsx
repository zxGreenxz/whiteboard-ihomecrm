import type {ComponentProps} from 'react';
// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('@/hooks/useInvoiceHistory',()=>({useInvoiceHistory:()=>({data:undefined,isError:true,isLoading:false,error:{code:'42501'},refetch:vi.fn()})}));
vi.mock('@/hooks/useAccounts',()=>({useAccounts:()=>({data:[],isError:false,isLoading:false})}));
import InvoiceHistoryDialog from '../InvoiceHistoryDialog';
afterEach(cleanup);
it('lỗi đọc lịch sử không thành Chưa có lịch sử',()=>{render(<InvoiceHistoryDialog open onOpenChange={()=>{}} invoice={{id:'i1',invoice_number:'HD01'} as unknown as ComponentProps<typeof InvoiceHistoryDialog>['invoice']}/>);expect(screen.queryByText('Chưa có lịch sử chỉnh sửa.')).toBeNull();expect(screen.getByRole('alert')).toBeTruthy();});
