import { expect, it } from 'vitest';
import { contractDraftPayloadSchema, emptyContractDraftPayload } from '../contractDrafts';
const plan={version:2,start_billing_month:'2026-09',payer:'BUILDING',sale_party_id:null,deduction_policy:'COMMISSION_ONLY',collection_mode:'UPFRONT_COMMITTED',segments:[{month_count:3,monthly_amount:'300000'},{month_count:9,monthly_amount:'100000'}]};
it('round trips v2 support in strict draft payload without averaging legacy discounts',()=>{
 const payload={...emptyContractDraftPayload(),rent_support:plan};
 expect(contractDraftPayloadSchema.safeParse(payload).success).toBe(true);
 expect(contractDraftPayloadSchema.parse(payload).rent_support).toEqual(plan);
 expect(contractDraftPayloadSchema.safeParse({...payload,rent_support:{...plan,extra:1}}).success).toBe(false);
});
import { buildSupportQuoteArgs, supportQuoteSchema, supportReadSchema } from '../rentSupportApi';
import { buildCreateContractRpcArgs } from '../contractCreateRpc';
import { buildContractDraftPayload, restoreContractDraftEditorState } from '../contractDraftEditor';
import { contractDraftSchema, emptyDraftOwner } from '../contractDrafts';
import { supportPlanInputSchema } from '../rentSupport';
const id='11111111-1111-4111-8111-111111111111';
it('sends explicit null subjects and rejects ambiguous or forged contexts at the API boundary',()=>{
 const payload=supportPlanInputSchema.parse(plan);
 expect(buildSupportQuoteArgs(id,{contractId:id,payload})).toMatchObject({p_draft_id:null,p_invoice_context:null,p_payout_context:null});
 expect(()=>buildSupportQuoteArgs(id,{contractId:id,draftId:id,payload})).toThrow();
 expect(()=>buildSupportQuoteArgs(id,{payload})).toThrow();
});
it('carries exact segments through the editor and create payload without exposing funding in discounts',()=>{
 const payload=supportPlanInputSchema.parse(plan);
 const snapshot=buildContractDraftPayload({form:{...emptyContractDraftPayload().form,rent_support:payload},selectedCustomers:[],selectedServices:[],buildingServices:[],useCustomServices:false,depositRows:[],invoiceItems:[],rentUnlocked:false,depositUnlocked:false},emptyDraftOwner());
 const restored=restoreContractDraftEditorState(contractDraftSchema.parse({id,organization_id:id,building_id:id,room_id:id,payload:snapshot,template_id:null,revision:1,created_by:id,created_at:'2026-09-29',updated_at:'2026-09-29'}));
 expect(restored.form.rent_support).toEqual(payload);
 const args=buildCreateContractRpcArgs({idempotencyKey:'rent-support-test',payload:{contract:{room_id:id,signed_date:'2026-09-29',start_date:'2026-09-01',end_date:'2027-09-01',rent_price:3000000,total_deposit:0,payment_cycle:'MONTHLY',rent_support:payload},customers:[],services:[]}});
 expect(args.p_payload).toMatchObject({contract:{rent_support:payload,discounts:{version:2,kind:'RENT_SUPPORT_SCHEDULE'}}});
});
it('accepts redacted read rows and rejects malformed money returned by a quote',()=>{
 expect(supportReadSchema.parse({total:1,rows:[{contract_id:id,kind:'LEGACY',revision:null,customer_hash:null,schedule:null,legacy:{months:3,amount_per_month:300000},months:[]}]}).rows[0]).not.toHaveProperty('financial');
 expect(supportQuoteSchema.safeParse({quote_hash:'hash',payload_hash:'payload',plan_revision:0,payload:plan,committed_total:'NaN',due_upfront:'0',sources:[],unallocated:'0',state:'NEEDS_REVIEW',issues:[],months:[]}).success).toBe(false);
});
it('rejects simultaneous legacy discount and v2 schedule instead of silently losing either agreement',()=>{
 const payload={...emptyContractDraftPayload(),rent_support:plan};
 expect(contractDraftPayloadSchema.safeParse({...payload,form:{...payload.form,discount_months:3,discount_amount_per_month:300000}}).success).toBe(false);
 expect(()=>buildCreateContractRpcArgs({idempotencyKey:'rent-support-mixed',payload:{contract:{room_id:id,signed_date:'2026-09-29',start_date:'2026-09-01',end_date:'2027-09-01',rent_price:3000000,total_deposit:0,payment_cycle:'MONTHLY',rent_support:supportPlanInputSchema.parse(plan),discounts:{months:3,amount_per_month:300000}},customers:[],services:[]}})).toThrow();
});
