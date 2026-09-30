import { expect, it } from 'vitest';
import { payoutContextSchema } from '../rentSupportFunding';
const id='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const base={intent_id:id,source_id:null,kind:'COMMISSION',party_id:id,gross_amount:'3000000',route:'CASHBOOK',manager_id:null,account_id:null,voucher_date:'2026-09-30',payer_name:null,recipient_name:null,recipient_bank:null,recipient_account:null,item_description:null,attachments:[]};
const adoption={...base,action:'ADOPT_DEPOSIT_BONUS',source_id:other,kind:'BONUS',deposit_claim_id:id,deposit_voucher_id:other,bonus_voucher_id:id,expected_approval_version:1,expected_posting_version:0,item_ids:[other],source_facts_hash:'server-proof',reason:'Giữ hỗ trợ theo hợp đồng'};
it('accepts explicit v3 new/adoption intent without weakening v2',()=>{
 expect(payoutContextSchema.safeParse({version:3,intents:[{...base,action:'ISSUE_NEW'}]}).success).toBe(true);
 expect(payoutContextSchema.safeParse({version:3,intents:[adoption]}).success).toBe(true);
 expect(payoutContextSchema.safeParse({version:2,intents:[{...base,action:'ISSUE_NEW'}]}).success).toBe(false);
});
it('rejects adoption without identity/CAS/proof or with another kind/manager route',()=>{
 for(const patch of [{deposit_claim_id:undefined},{source_facts_hash:''},{item_ids:[]},{item_ids:[id,id]},{expected_approval_version:-1},{kind:'COMMISSION'},{route:'MANAGER_PAYROLL',manager_id:id}])
 expect(payoutContextSchema.safeParse({version:3,intents:[{...adoption,...patch}]}).success).toBe(false);
});

it('rejects candidate metadata that disagrees with its immutable adoption template',async()=>{
 const {depositAdoptionCandidateSchema}=await import('../rentSupportFunding');
 const {intent_id: _intent,reason: _reason,...template}=adoption;
 const candidate={source_id:other,claim_id:id,deposit_voucher_id:other,bonus_voucher_id:id,item_ids:[other],approval_version:1,posting_version:0,gross:'3000000',current_net:'3000000',already_paid:'0',proof_hash:'server-proof',intent_template:template};
 expect(depositAdoptionCandidateSchema.safeParse({version:1,state:'READY',plan_revision:1,candidate,issues:[]}).success).toBe(true);
 expect(depositAdoptionCandidateSchema.safeParse({version:1,state:'READY',plan_revision:1,candidate:{...candidate,claim_id:other},issues:[]}).success).toBe(false);
 expect(depositAdoptionCandidateSchema.safeParse({version:1,state:'READY',plan_revision:1,candidate:{...candidate,already_paid:'1'},issues:[]}).success).toBe(false);
});
