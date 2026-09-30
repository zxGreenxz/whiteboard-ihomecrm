import { expect, it, vi, beforeEach } from 'vitest';
import { payoutContextSchema, payoutOperationSchema, parseSaleBonusStatus } from '../rentSupportFunding';
import { buildSupportPayoutArgs, buildSupportQuoteArgs, executeContractPayoutOperation, readContractPayoutRequest } from '../rentSupportApi';
const rpc=vi.hoisted(()=>vi.fn());vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc}}));
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const context={version:2 as const,intents:[{intent_id:id,source_id:null,kind:'COMMISSION' as const,party_id:id,gross_amount:'3000000',route:'CASHBOOK' as const,manager_id:null,account_id:null,voucher_date:'2026-09-30',payer_name:null,recipient_name:'Broker B',recipient_bank:null,recipient_account:null,item_description:null,attachments:['evidence.png']}]};
const plan={version:2 as const,start_billing_month:'2026-09',payer:'SALE' as const,sale_party_id:id,deduction_policy:'COMMISSION_ONLY' as const,collection_mode:'UPFRONT_COMMITTED' as const,segments:[{month_count:3,monthly_amount:'300000'},{month_count:9,monthly_amount:'100000'}]};
const source={source_id:id,operation_id:id,kind:'broker',gross:'1800000',withheld:'1800000',net:'0',status:'SETTLED_BY_SUPPORT',id:null,voucher_id:null,code:null};
beforeEach(()=>rpc.mockReset());
it('requires full actionable payload and preserves bank/attachment values in quote and prepare args',()=>{
 expect(payoutContextSchema.parse(context)).toEqual(context);
 expect(payoutContextSchema.safeParse({...context,intents:[{...context.intents[0],attachments:undefined}]}).success).toBe(false);
 expect(payoutContextSchema.safeParse({...context,intents:[{...context.intents[0],forged:'x'}]}).success).toBe(false);
 expect(buildSupportQuoteArgs(id,{contractId:id,payload:plan,payoutContext:context}).p_payout_context).toEqual(context);
 expect(buildSupportPayoutArgs(id,{contractId:id,planRevision:1,quoteHash:'hash',payload:context,requestId:other})).toMatchObject({p_request_id:other,p_payload:context,p_plan_revision:1});
});
it('accepts authoritative net0 and rejects a fake voucher or inconsistent monetary identity',()=>{
 const result={operation_id:id,status:'COMPLETED',sources:[source]};expect(payoutOperationSchema.parse(result)).toEqual(result);
 for(const forged of [{...source,id:other,voucher_id:other},{...source,net:'1'},{...source,operation_id:other}])expect(payoutOperationSchema.safeParse({...result,sources:[forged]}).success).toBe(false);
 expect(payoutOperationSchema.safeParse({...result,sources:[]}).success).toBe(false);
});
it('retains safe persisted failure state and never invents a completed receipt',()=>{
 expect(payoutOperationSchema.parse({operation_id:id,status:'FAILED',sources:[],issue:{code:'PAYOUT_FAILED',message:'Tạo lại'}}).status).toBe('FAILED');
 expect(payoutOperationSchema.safeParse({operation_id:id,status:'READY',sources:[source]}).success).toBe(false);
 expect(payoutOperationSchema.parse({operation_id:null,status:'NOT_FOUND'}).status).toBe('NOT_FOUND');
});
it('retries by saved operation identity without sending a new actor, request, or source',async()=>{
 rpc.mockResolvedValue({data:{operation_id:id,status:'COMPLETED',sources:[source]},error:null});
 expect((await executeContractPayoutOperation(other,id)).status).toBe('COMPLETED');
 expect(rpc).toHaveBeenCalledWith('execute_contract_payout_operation_v1',{p_organization_id:other,p_operation_id:id});
});
it('preserves authorization errors and resolves lost prepare response through saved request',async()=>{
 const error={code:'42501',message:'Denied'};rpc.mockResolvedValueOnce({data:null,error});await expect(readContractPayoutRequest(id,other)).rejects.toBe(error);
 rpc.mockResolvedValueOnce({data:{operation_id:id,status:'READY',sources:[]},error:null});expect((await readContractPayoutRequest(id,other)).status).toBe('READY');
 expect(rpc).toHaveBeenLastCalledWith('read_contract_payout_request_v1',{p_organization_id:id,p_request_id:other});
});
it('distinguishes sale support settlement from voucher existence and cash paid',()=>{
 expect(parseSaleBonusStatus({contractId:id,alreadyPaid:false,voucherId:null,settledBySupport:true,status:'SETTLED_BY_SUPPORT'})).toMatchObject({settledBySupport:true,hasVoucher:false,cashPaymentStatus:'UNVERIFIED'});
});
