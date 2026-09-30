// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const refetch=vi.hoisted(()=>vi.fn());
vi.mock('@/hooks/useCollectionReport',()=>({useCollectionReport:()=>({data:undefined,invoices:[],isError:true,isPending:false,isLoading:false,error:{code:'42501'},refetch})}));
vi.mock('@/components/invoices/InvoiceRoundingReportButton',()=>({default:()=>null}));
import CollectionReport from '../CollectionReport';
afterEach(cleanup);
it('báo cáo đọc lỗi không hiện tổng0 hay chưa thu và có tải lại',async()=>{render(<CollectionReport show onClose={()=>{}} buildings={[]} defaultBuildingId="all" billingMonth="2026-09"/>);expect(screen.queryByText('Tổng đã thu')).toBeNull();expect(screen.queryByText('Chưa thu khoản nào trong phạm vi này.')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));await waitFor(()=>expect(refetch).toHaveBeenCalledOnce());});
