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
