import { expect, it } from 'vitest';
import { reconciliationEntrySchema, lifecycleReadSchema } from '../rentSupportLifecycle';
const id='00000000-0000-4000-8000-000000000001';
const entry={source_id:id,contract_id:id,voucher_id:id,party_id:id,kind:'COMMISSION',gross:'3000000',previous_withheld:'1800000',net:'1200000',documents:[{signing_id:id,document_id:id,sha256:'a'.repeat(64)}],confirmed:true,expected_approval_version:1,expected_posting_version:1,reason:'Attest exact source'};
it('validates gross/held/net with decimal precision beyond floating-point integers',()=>{
 expect(reconciliationEntrySchema.safeParse(entry).success).toBe(true);
 expect(reconciliationEntrySchema.safeParse({...entry,gross:'3000000.01'}).success).toBe(false);
 expect(reconciliationEntrySchema.safeParse({...entry,gross:'9007199254740993.02',previous_withheld:'9007199254740993.01',net:'0.01'}).success).toBe(true);
});
it('requires explicit confirmation and stable evidence identity for attestation input',()=>{
 expect(reconciliationEntrySchema.safeParse({...entry,confirmed:undefined}).success).toBe(false);
 expect(reconciliationEntrySchema.safeParse({...entry,documents:[{url:'https://example.com/proof.pdf'}]}).success).toBe(false);
 expect(reconciliationEntrySchema.safeParse({...entry,notes:'gross=3m'}).success).toBe(false);
});
it('does not accept an unknown financial read as a zero balance',()=>{
 expect(lifecycleReadSchema.safeParse({}).success).toBe(false);
 expect(lifecycleReadSchema.safeParse({version:1,contract_id:id,plan_revision:1,termination:null,committed:'1800000',consumed:'900000',unused_committed:'900000',state:'NEEDS_REVIEW',issues:[{code:'TERMINATION_REVIEW',message:'Review unused support'}],sources:[]}).success).toBe(true);
});
