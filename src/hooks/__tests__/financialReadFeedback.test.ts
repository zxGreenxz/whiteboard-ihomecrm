// @vitest-environment jsdom
import {renderHook,cleanup} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:vi.fn(),rpc:io.rpc}}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:unknown)=>options,useMutation:(options:unknown)=>options,useQueryClient:()=>({invalidateQueries:vi.fn()}),keepPreviousData:(value:unknown)=>value}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
import {useMyCashbookAccessV2,useCashbookVisibilityV2,useCustodianCashbooksV2} from '../income-expenses/financeV2Mutations';
import {incomeExpenseStatsQuery} from '../income-expenses/queries';
import {useHeldDepositSummary,useRefundForfeitSummary} from '../useDepositDashboard';
import {usePendingApprovals} from '../useApprovals';
import {invoiceStatisticsQuery} from '../useInvoices';
import {useReservationDepositSummary} from '../useDeposits';
import {usePeriodFeeStatus} from '../usePeriodFees';
import {useSaleBonusStatus,useCreateSaleBonusFromDeposit} from '../useSaleBonus';
import {useCollectionCycleReport} from '../useCollectionCycleReport';
import {useFaMonthlyPnl} from '../useFinancialAnalysis';
import {financialReadNumber} from '@/lib/financialReadValidation';
const usePnlRead=()=>(useFaMonthlyPnl('2026-09-01','2026-09-30') as unknown as {queryFn:()=>Promise<unknown>}).queryFn();
beforeEach(()=>vi.clearAllMocks());
afterEach(cleanup);
describe('báo cáo không dùng zero khi thiếu số liệu',()=>{
 it('RPC null không phải danh sách rỗng',async()=>{io.rpc.mockResolvedValue({data:null,error:null});await expect(usePnlRead()).rejects.toThrow('Chưa đọc');});
 it('thu nhập malformed không thành zero',async()=>{io.rpc.mockResolvedValue({data:[{month:'2026-09',revenue:'invalid',expense:0,net:0}],error:null});await expect(usePnlRead()).rejects.toThrow('Chưa đọc');});
 it('số zero thật được giữ',async()=>{io.rpc.mockResolvedValue({data:[{month:'2026-09',revenue:0,expense:0,net:0}],error:null});await expect(usePnlRead()).resolves.toMatchObject([{revenue:0,net:0}]);});
 it.each([null,undefined,'',NaN,Infinity,true])('từ chối số bắt buộc %s',value=>{expect(()=>financialReadNumber(value)).toThrow();});
});

it.each([null,{}])('tổng cọc thiếu dữ liệu không thành zero %s',async data=>{io.rpc.mockResolvedValue({data,error:null});const query=useReservationDepositSummary() as unknown as {queryFn:()=>Promise<unknown>};await expect(query.queryFn()).rejects.toThrow();});
it('trạng thái phí không biến tiền đã đóng lỗi thành chưa đóng',async()=>{io.rpc.mockResolvedValue({data:[{building_id:'b1',category_key:'wifi',paid_amount:'invalid',draft_amount:0}],error:null});const {result}=renderHook(()=>usePeriodFeeStatus('2026-09',['wifi'],['b1']));await expect((result.current as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});

it.each([null,{}, {contractId:'c1',alreadyPaid:null}, {contractId:'c1',alreadyPaid:true}])('thưởng Sale chưa xác minh không thành chưa trả %s',async data=>{io.rpc.mockResolvedValue({data,error:null});const query=useSaleBonusStatus('c1') as unknown as {queryFn:()=>Promise<unknown>};await expect(query.queryFn()).rejects.toThrow();});
it('thiếu mã phiếu thưởng vừa tạo là chưa xác nhận',async()=>{io.rpc.mockResolvedValue({data:{amount:1000},error:null});const hook=useCreateSaleBonusFromDeposit() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};await expect(hook.mutationFn({depositVoucherId:'d1',amount:1000})).rejects.toThrow('Chưa xác nhận');});

it.each([null,{}, {total_amount:'not-a-number'}])('thống kê hoá đơn không biến dữ liệu thiếu thành zero %s',async data=>{io.rpc.mockResolvedValue({data,error:null});await expect(invoiceStatisticsQuery().queryFn()).rejects.toThrow();});

it('tổng phiếu thu chi thiếu phản hồi không thành zero',async()=>{io.rpc.mockResolvedValue({data:null,error:null});await expect(incomeExpenseStatsQuery({},false).queryFn()).rejects.toThrow();});
it('danh sách chờ duyệt null không thành không có phiếu',async()=>{io.rpc.mockResolvedValue({data:null,error:null});await expect((usePendingApprovals() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});
it.each([useHeldDepositSummary,useRefundForfeitSummary])('tổng cọc trên dashboard thiếu phản hồi không thành zero',async hook=>{io.rpc.mockResolvedValue({data:null,error:null});await expect((hook() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});

const cycleFixture={manager:{id:'u1',name:null},from:'2026-09-01',to:'2026-09-30',building_count:0,
 summary:{collected_period:0,handed_over_period:0,outstanding_current:0,total_billed_current:0,collected_all:0},buildings:[],timeline:[]};
const useCycleRead=()=>(useCollectionCycleReport('u1','2026-09-01','2026-09-30') as unknown as {queryFn:()=>Promise<unknown>}).queryFn();
it.each([null, {...cycleFixture,summary:{...cycleFixture.summary,collected_period:null}}, {...cycleFixture,timeline:[{type:'CURRENT',net:null,collected_in_segment:'invalid',outstanding_as_of:0}]}])('chu kỳ bàn giao thiếu số liệu không hiển thị0: %s',async data=>{
 io.rpc.mockResolvedValue({data,error:null});await expect(useCycleRead()).rejects.toThrow();
});
it('chu kỳ bàn giao giữ0 thật và mã lỗi quyền để UI phân loại',async()=>{
 io.rpc.mockResolvedValue({data:cycleFixture,error:null});await expect(useCycleRead()).resolves.toMatchObject(cycleFixture);
 const error={code:'42501',message:'permission denied'};io.rpc.mockResolvedValue({data:null,error});await expect(useCycleRead()).rejects.toBe(error);
});

it.each([useMyCashbookAccessV2,useCashbookVisibilityV2,()=>useCustodianCashbooksV2(true)])('danh mục quyền/sổ quỹ null không thành không có sổ',async hook=>{
 io.rpc.mockResolvedValue({data:null,error:null});await expect((hook() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();
});
const feeStatus=(v:unknown)=>[{building_id:'b1',category_key:'wifi',paid_amount:0,draft_amount:100,vouchers:[v]}];
it.each([{id:'v1',status:'APPROVED',amount:null},{id:'v1',status:'unexpected',amount:100}])('phiếu phí thiếu tiền/trạng thái không thành0/đã duyệt %s',async voucher=>{
 io.rpc.mockResolvedValue({data:feeStatus(voucher),error:null});const {result}=renderHook(()=>usePeriodFeeStatus('2026-09',['wifi'],['b1']));await expect((result.current as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();
});
