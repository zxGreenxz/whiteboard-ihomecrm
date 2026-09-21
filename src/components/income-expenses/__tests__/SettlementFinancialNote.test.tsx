// @vitest-environment jsdom
import {render,screen,cleanup} from '@testing-library/react';
import {afterEach,it,expect} from 'vitest';
import {SettlementFinancialNote} from '../SettlementFinancialNote';
import {parseSettlementFinancialContext} from '@/lib/contractSettlementFinancialContext';
afterEach(cleanup);
it('renders unknown money explicitly and labels current vs termination debt separately',()=>{
 const id='aaaaaaaa-0000-4000-8000-000000000001';
 const data=parseSettlementFinancialContext({schemaVersion:1,organizationId:id,roomId:id,targetContractId:id,terminationId:null,voucherId:null,sourceReceiptId:null,today:'2026-09-21',generatedAt:'2026-09-21T00:00:00Z',receiptsComplete:false,invoicesComplete:false,receipts:[],invoices:[],depositRequired:null,termination:null,obligation:null,notes:null},{organizationId:id,roomId:id,contractId:id,terminationId:null,voucherId:null,sourceReceiptId:null});
 render(<SettlementFinancialNote context={data}/>);
 expect(screen.getAllByText('Chưa xác minh').length).toBeGreaterThan(3);
 expect(screen.getByText(/Công nợ hiện tại/)).toBeTruthy();
 expect(screen.queryByText('0 đ')).toBeNull();
});

it('shows the verified settlement deductions and customer refunds as reviewable rows',()=>{
 const id='aaaaaaaa-0000-4000-8000-000000000001';
 const termination={id,contractId:id,date:'2026-09-21',debt:0,status:'COMPLETED',notes:null};
 const terminationBreakdown={complete:true,terminationId:id,contractId:id,actualMoveOutDate:'2026-09-20',depositUsed:4_200_000,outstandingDebt:0,
  earlyTerminationFee:1_912_400,rentRefundAmount:700_000,totalDeductions:1_912_400,refundAmount:2_287_600,
  excessRent:0,shortfallMode:null,settlementItems:[{description:'Tiền điện (2.628 → 3.026)',amount:1_512_400,type:'SERVICE'},{description:'Tiền vệ sinh',amount:400_000,type:'OTHER'}],
  refundItems:[{description:'Hoàn tiền phòng ngày không ở',amount:700_000,typeName:'Hoàn tiền phòng thanh lý',isDeposit:false}]};
 const data=parseSettlementFinancialContext({schemaVersion:1,organizationId:id,roomId:id,targetContractId:id,terminationId:id,voucherId:null,sourceReceiptId:null,today:'2026-09-21',generatedAt:'2026-09-21T00:00:00Z',receiptsComplete:true,invoicesComplete:true,receipts:[],invoices:[],depositRequired:4_200_000,termination,obligation:{id,terminationId:id,version:1,amount:2_987_600,status:'OK',fingerprint:'basis'},notes:null,terminationBreakdown},{organizationId:id,roomId:id,contractId:id,terminationId:id,voucherId:null,sourceReceiptId:null});
 render(<SettlementFinancialNote context={data}/>);
 expect(screen.getByRole('heading',{name:'Chi tiết quyết toán thanh lý'})).toBeTruthy();
 expect(screen.getByText('Ngày trả phòng thực tế')).toBeTruthy();
 expect(screen.getByText('20/09/2026')).toBeTruthy();
 expect(screen.getByText('Tiền điện (2.628 → 3.026)')).toBeTruthy();
 expect(screen.getByText('Tiền vệ sinh')).toBeTruthy();
 expect(screen.getByText('Hoàn tiền phòng ngày không ở')).toBeTruthy();
 expect(screen.getByText('Tổng khấu trừ')).toBeTruthy();
 expect(screen.getByText('Chủ nhà trả lại khách')).toBeTruthy();
});
