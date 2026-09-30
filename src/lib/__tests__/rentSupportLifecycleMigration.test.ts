import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { setupPayoutDb, org, room, building, actor, uuid } from './fixtures/rentSupportPayoutDb';

const db = new PGlite();
const migration = 'supabase/migrations/20260930113158_rent_support_lifecycle_reconciliation.sql';
beforeAll(async () => {
 await setupPayoutDb(db,'supabase/migrations/20260930101338_rent_support_upfront_payouts.sql');
 await db.exec(`
 ALTER TABLE public.contracts ADD actual_end_date date, ADD expected_move_out_date date, ADD payment_cycle text DEFAULT 'MONTHLY';
 CREATE TABLE public.contract_terminations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,actual_move_out_date date,termination_date date,status text);
 CREATE TABLE public.invoices(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,building_id uuid,billing_month text,kind text,status text,deleted_at timestamptz,adjustment_revision bigint DEFAULT 0,subtotal numeric,discount_amount numeric,total_amount numeric,paid_amount numeric DEFAULT 0,UNIQUE(organization_id,id));
 CREATE TABLE public.invoice_items(id uuid DEFAULT gen_random_uuid(),invoice_id uuid,organization_id uuid,accounting_class text,amount numeric);
 ALTER TABLE public.income_expenses ADD approval_version bigint DEFAULT 1,ADD posting_version bigint DEFAULT 1,ADD posting_status text DEFAULT 'UNPOSTED',ADD active_posting_id_v2 uuid,ADD attachments jsonb DEFAULT '[]';
 ALTER TABLE public.income_expense_items ADD organization_id uuid;
 CREATE TABLE public.contract_draft_documents(id uuid PRIMARY KEY,organization_id uuid,draft_id uuid,revision integer,document_sha256 text,created_by uuid);
 CREATE TABLE public.contract_draft_signings(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,document_id uuid,document_sha256 text,draft_id uuid,revision integer,signed_by uuid);
 CREATE OR REPLACE FUNCTION app_private.ie_supplement_can_read_v1(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.deny',true) IS DISTINCT FROM 'yes' AND current_setting('test.parent_deny',true) IS DISTINCT FROM 'yes' $$;
 `);
 await db.exec(readFileSync('supabase/migrations/20260930065906_invoice_rent_support_claims.sql','utf8').split('-- Replacing signatures')[0]);
 // Reuse the actual Task7 scope predicate, not an org-only fixture double.
 const salary=readFileSync('supabase/migrations/20260930112705_rent_support_salary_source_bridge.sql','utf8');
 await db.exec(salary.slice(salary.indexOf('CREATE OR REPLACE FUNCTION app_private.rent_support_party_in_building_v1('),salary.indexOf('CREATE OR REPLACE FUNCTION public.read_rent_support_deposit_candidate_v1(')));
 if(existsSync(migration))await db.exec(readFileSync(migration,'utf8'));
},30000);
afterAll(async()=>db.close());
it('fix1 upgrades existing org-only request keys without changing saved audit rows',async()=>{
 const f=await fixture(),proof=(await db.query<{r:{proof_hash:string}}>('SELECT app_private.rent_support_lifecycle_source_v1($1,$2) r',[org,f.source_id])).rows[0].r.proof_hash;
 await db.query('SELECT request_rent_support_source_lifecycle_v1($1,$2,$3,$4,$5,$6)',[org,f.source_id,'CANCEL',proof,'Preserve prior saved audit',crypto.randomUUID()]);
 const legacy=await legacyFixture(),entries=JSON.stringify([legacy.entry]);
 const q=(await db.query<{r:{batch_hash:string}}>('SELECT dry_run_rent_support_reconciliation_v1($1,$2) r',[org,entries])).rows[0].r;
 await db.query('SELECT apply_rent_support_reconciliation_v1($1,$2,$3,$4,$5)',[org,q.batch_hash,entries,'Preserve prior saved batch',crypto.randomUUID()]);
 const audit=()=>db.query(`SELECT (SELECT jsonb_agg(to_jsonb(r)) FROM app_private.rent_support_lifecycle_requests r) requests,(SELECT jsonb_agg(to_jsonb(b)) FROM app_private.rent_support_reconciliation_batches b) batches`);
 const before=(await audit()).rows;
 for(const table of ['rent_support_lifecycle_requests','rent_support_reconciliation_batches']) {
  const constraints=(await db.query<{conname:string}>(`SELECT c.conname FROM pg_constraint c WHERE c.conrelid=$1::regclass AND c.contype='u' AND pg_get_constraintdef(c.oid) LIKE '%request_id%'`,['app_private.'+table])).rows;
  for(const c of constraints)await db.exec(`ALTER TABLE app_private.${table} DROP CONSTRAINT "${c.conname}"`);
  await db.exec(`ALTER TABLE app_private.${table} ADD UNIQUE(organization_id,request_id)`);
 }
 await db.exec(readFileSync(migration,'utf8'));
 expect((await audit()).rows).toEqual(before);
 const keys=(await db.query<{d:string}>(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid IN ('app_private.rent_support_lifecycle_requests'::regclass,'app_private.rent_support_reconciliation_batches'::regclass) AND contype='u' AND pg_get_constraintdef(oid) LIKE '%request_id%'`)).rows;
 expect(keys).toEqual([{d:'UNIQUE (organization_id, actor_id, request_id)'},{d:'UNIQUE (organization_id, actor_id, request_id)'}]);
});
async function fixture() {
 const contract=crypto.randomUUID(),request=crypto.randomUUID();
 await db.query(`INSERT INTO contracts(id,organization_id,room_id,start_date,end_date,discounts,status) VALUES($1,$2,$3,'2026-09-01','2027-09-01','{}','ACTIVE')`,[contract,org,room]);
 const party=(await db.query<{r:{party_id:string}}>(`SELECT register_rent_support_party_v1($1,$2,NULL,'Party','Verified identity',$3) r`,[org,building,crypto.randomUUID()])).rows[0].r.party_id;
 const plan={version:2,start_billing_month:'2026-09',payer:'SALE',sale_party_id:party,deduction_policy:'COMMISSION_ONLY',collection_mode:'UPFRONT_COMMITTED',segments:[{month_count:6,monthly_amount:'300000'}]};
 await db.query('SELECT app_private.persist_contract_rent_support_v1($1,$2,$3)',[org,contract,JSON.stringify(plan)]);
 const payload={version:2,intents:[{intent_id:crypto.randomUUID(),source_id:null,kind:'COMMISSION',party_id:party,gross_amount:'3000000',route:'CASHBOOK',manager_id:null,account_id:null,voucher_date:'2026-09-30',payer_name:null,recipient_name:'Party',recipient_bank:null,recipient_account:null,item_description:null,attachments:[]}]};
 const quote=(await db.query<{r:{quote_hash:string}}>('SELECT quote_contract_rent_support_v1($1,$2,NULL,$3,NULL,$4) r',[org,contract,JSON.stringify(plan),JSON.stringify(payload)])).rows[0].r;
 await db.query('SELECT prepare_contract_payouts_with_support_v1($1,$2,1,$3,$4,$5)',[org,contract,quote.quote_hash,JSON.stringify(payload),request]);
 const receipt=(await db.query<{r:{operation_id:string,sources:Array<{source_id:string,voucher_id:string}>}}>('SELECT create_contract_payouts_with_support_v1($1,$2,1,$3,$4,$5) r',[org,contract,quote.quote_hash,JSON.stringify(payload),request])).rows[0].r;
 return {contract,party,plan,receipt,...receipt.sources[0]};
}
async function invoiceQuote(contract:string,month:string) {
 return (await db.query<{r:Record<string,unknown>}>('SELECT app_private.invoice_rent_support_quote_v1($1,$2,$3,\'MONTHLY\',$4,0,0,1) r',[org,contract,month,JSON.stringify([{amount:1000000,accounting_class:'REVENUE'}])])).rows[0].r;
}
it('freezes future support only after effective termination; notice does not remove full monthly support',async()=>{
 const f=await fixture();
 await db.query("UPDATE contracts SET expected_move_out_date='2026-11-15' WHERE id=$1",[f.contract]);
 expect(await invoiceQuote(f.contract,'2026-12')).toMatchObject({invoice_support:'300000',state:'READY'});
 await db.query("UPDATE contracts SET status='TERMINATED',actual_end_date='2026-11-15' WHERE id=$1",[f.contract]);
 expect(await invoiceQuote(f.contract,'2026-11')).toMatchObject({invoice_support:'300000',state:'READY'});
 expect(await invoiceQuote(f.contract,'2026-12')).toMatchObject({invoice_support:'0',state:'NEEDS_REVIEW',issue:'TERMINATION_REVIEW'});
});
it('fails closed for terminated contract without an authoritative date',async()=>{
 const f=await fixture();await db.query("UPDATE contracts SET status='TERMINATED' WHERE id=$1",[f.contract]);
 expect(await invoiceQuote(f.contract,'2026-10')).toMatchObject({state:'NEEDS_REVIEW',issue:'TERMINATION_REVIEW'});
});
it('blocks voucher amount/item mutation and cancellation while preserving immutable funding',async()=>{
 const f=await fixture();
 await expect(db.query('UPDATE income_expenses SET total_amount=3000000 WHERE id=$1',[f.voucher_id])).rejects.toMatchObject({code:'PT409'});
 await expect(db.query('UPDATE income_expense_items SET amount=3000000 WHERE income_expense_id=$1',[f.voucher_id])).rejects.toMatchObject({code:'PT409'});
 await expect(db.query("UPDATE income_expenses SET approval_status='CANCELLED' WHERE id=$1",[f.voucher_id])).rejects.toMatchObject({code:'PT409'});
 expect((await db.query('SELECT gross::text,withheld::text,net::text FROM app_private.rent_support_payout_results WHERE source_id=$1',[f.source_id])).rows[0]).toEqual({gross:'3000000',withheld:'1800000',net:'1200000'});
});
it('records durable review once; retries and changed intents cannot reopen capacity',async()=>{
 const f=await fixture();
 const read=(await db.query<{r:{sources:Array<{proof_hash:string}>}}>('SELECT read_contract_rent_support_lifecycle_v1($1,$2) r',[org,f.contract])).rows[0].r;
 const request=crypto.randomUUID(),args=[org,f.source_id,'CANCEL',read.sources[0].proof_hash,'Review cancellation',request];
 const call=()=>db.query<{r:Record<string,unknown>}>('SELECT request_rent_support_source_lifecycle_v1($1,$2,$3,$4,$5,$6) r',args);
 const result=(await call()).rows[0].r;expect(result).toMatchObject({state:'NEEDS_REVIEW',issue:'REVERSAL_REVIEW'});
 expect((await call()).rows[0].r).toEqual(result);
 args[4]='Different reason';await expect(call()).rejects.toMatchObject({code:'PT409'});
 expect((await db.query('SELECT count(*)::int n FROM app_private.rent_support_lifecycle_requests WHERE source_id=$1',[f.source_id])).rows[0]).toEqual({n:1});
});
async function legacyFixture() {
 const contract=crypto.randomUUID(),voucher=crypto.randomUUID();
 await db.query("INSERT INTO contracts(id,organization_id,room_id,start_date,end_date,discounts,status) VALUES($1,$2,$3,'2026-09-01','2027-09-01','{}','ACTIVE')",[contract,org,room]);
 const party=(await db.query<{r:{party_id:string}}>("SELECT register_rent_support_party_v1($1,$2,NULL,'Party','Identity verification',$3) r",[org,building,crypto.randomUUID()])).rows[0].r.party_id;
 await db.query("INSERT INTO income_expenses(id,organization_id,contract_id,type,commission_kind,total_amount,approval_status) VALUES($1,$2,$3,'EXPENSE','broker',1200000,'UNAPPROVED')",[voucher,org,contract]);
 await db.query('INSERT INTO income_expense_items(income_expense_id,amount) VALUES($1,1200000)',[voucher]);
 const plan={version:2,start_billing_month:'2026-09',payer:'SALE',sale_party_id:party,deduction_policy:'COMMISSION_ONLY',collection_mode:'UPFRONT_COMMITTED',segments:[{month_count:6,monthly_amount:'300000'}]};
 await db.query('SELECT app_private.persist_contract_rent_support_v1($1,$2,$3)',[org,contract,JSON.stringify(plan)]);
 const sid=(await db.query<{s:string}>("SELECT app_private.rent_support_source_id_v1($1,$2,'COMMISSION') s",[org,contract])).rows[0].s;
 return {contract,plan,entry:{source_id:sid,contract_id:contract,voucher_id:voucher,party_id:party,kind:'COMMISSION',gross:'3000000',previous_withheld:'1800000',net:'1200000',documents:[] as Array<{signing_id:string,document_id:string,sha256:string}>,confirmed:false,expected_approval_version:1,expected_posting_version:1,reason:'Historical declaration'}};
}
it('fix1 denies external party from another building in context and attestation without authority',async()=>{
 const f=await legacyFixture();
 const context=()=>db.query('SELECT read_rent_support_reconciliation_context_v1($1,$2,$3)',[org,f.contract,f.entry.voucher_id]);
 await context();
 // Local pre-existing wrong-building binding fixture; never a product writer.
 await db.exec('BEGIN;SET LOCAL session_replication_role=replica');
 await db.query('UPDATE app_private.rent_support_parties SET building_id=$1 WHERE id=$2',[uuid(999),f.entry.party_id]);
 await db.exec('COMMIT');
 await expect(context()).rejects.toMatchObject({code:'42501'});
 await expect(db.query('SELECT dry_run_rent_support_reconciliation_v1($1,$2)',[org,JSON.stringify([f.entry])])).rejects.toMatchObject({code:'42501'});
 expect((await db.query('SELECT count(*)::int n FROM app_private.rent_support_payout_sources WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:0});
});
it('fix1 isolates lifecycle request identity and replay conflicts by authorized actor',async()=>{
 const f=await fixture(),request=crypto.randomUUID();
 const proof=(await db.query<{r:{proof_hash:string}}>('SELECT app_private.rent_support_lifecycle_source_v1($1,$2) r',[org,f.source_id])).rows[0].r.proof_hash;
 const call=(reason='Same lifecycle intent')=>db.query('SELECT request_rent_support_source_lifecycle_v1($1,$2,$3,$4,$5,$6)',[org,f.source_id,'CANCEL',proof,reason,request]);
 await call();await call();await expect(call('Same actor changed reason')).rejects.toMatchObject({code:'PT409'});
 await db.query("SELECT set_config('test.actor',$1,false)",[uuid(104)]);
 try {await call();await call();await expect(call('Other actor changed reason')).rejects.toMatchObject({code:'PT409'});}finally{await db.query("SELECT set_config('test.actor',$1,false)",[actor]);}
 expect((await db.query('SELECT actor_id FROM app_private.rent_support_lifecycle_requests WHERE request_id=$1 ORDER BY actor_id',[request])).rows).toEqual([{actor_id:actor},{actor_id:uuid(104)}]);
 const second=crypto.randomUUID();await db.query('SELECT request_rent_support_source_lifecycle_v1($1,$2,$3,$4,$5,$6)',[org,f.source_id,'REVISE',proof,'First actor separate intent',second]);
 await db.query("SELECT set_config('test.actor',$1,false)",[uuid(104)]);
 try{await db.query('SELECT request_rent_support_source_lifecycle_v1($1,$2,$3,$4,$5,$6)',[org,f.source_id,'RESTORE',proof,'Second actor separate intent',second]);}finally{await db.query("SELECT set_config('test.actor',$1,false)",[actor]);}
 expect((await db.query('SELECT count(*)::int n FROM app_private.rent_support_lifecycle_requests WHERE request_id=$1',[second])).rows[0]).toEqual({n:2});
});
it('fix1 isolates reconciliation batch receipts and changed intent by authorized actor',async()=>{
 const f=await legacyFixture(),entries=JSON.stringify([f.entry]),request=crypto.randomUUID();
 const q=(await db.query<{r:{batch_hash:string}}>('SELECT dry_run_rent_support_reconciliation_v1($1,$2) r',[org,entries])).rows[0].r;
 const call=(id=request,reason='Same batch intent')=>db.query<{r:{batch_id:string}}>('SELECT apply_rent_support_reconciliation_v1($1,$2,$3,$4,$5) r',[org,q.batch_hash,entries,reason,id]);
 const first=(await call()).rows[0].r;expect((await call()).rows[0].r).toEqual(first);await expect(call(request,'Changed actor A intent')).rejects.toMatchObject({code:'PT409'});
 await db.query("SELECT set_config('test.actor',$1,false)",[uuid(104)]);
 try{const second=(await call()).rows[0].r;expect(second.batch_id).not.toBe(first.batch_id);expect((await call()).rows[0].r).toEqual(second);await expect(call(request,'Changed actor B intent')).rejects.toMatchObject({code:'PT409'});}finally{await db.query("SELECT set_config('test.actor',$1,false)",[actor]);}
 const separate=crypto.randomUUID();await call(separate,'Actor A distinct intent');await db.query("SELECT set_config('test.actor',$1,false)",[uuid(104)]);
 try{await call(separate,'Actor B distinct intent');}finally{await db.query("SELECT set_config('test.actor',$1,false)",[actor]);}
 expect((await db.query('SELECT count(*)::int n FROM app_private.rent_support_reconciliation_batches WHERE request_id=ANY($1::uuid[])',[[request,separate]])).rows[0]).toEqual({n:4});
});
it('keeps legacy net-only declarations in review without a new source or withholding',async()=>{
 const f=await legacyFixture(),entries=[f.entry];
 const q=(await db.query<{r:{state:string,batch_hash:string}}>('SELECT dry_run_rent_support_reconciliation_v1($1,$2) r',[org,JSON.stringify(entries)])).rows[0].r;
 expect(q.state).toBe('NEEDS_REVIEW');
 const args=[org,q.batch_hash,JSON.stringify(entries),'Review exact batch',crypto.randomUUID()];
 const a=(await db.query<{r:Record<string,unknown>}>('SELECT apply_rent_support_reconciliation_v1($1,$2,$3,$4,$5) r',args)).rows[0].r;
 expect(a).toMatchObject({state:'NEEDS_REVIEW'});expect((await db.query<{r:Record<string,unknown>}>('SELECT apply_rent_support_reconciliation_v1($1,$2,$3,$4,$5) r',args)).rows[0].r).toEqual(a);
 expect((await db.query('SELECT count(*)::int n FROM app_private.rent_support_payout_sources WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:0});
});
it('accepts explicit attestation backed by exact signed document identity and engine net; retry never creates money',async()=>{
 const f=await legacyFixture(),signing=crypto.randomUUID(),document=crypto.randomUUID(),draft=crypto.randomUUID(),sha='a'.repeat(64);
 await db.query('INSERT INTO contract_draft_documents VALUES($1,$2,$3,1,$4,auth.uid())',[document,org,draft,sha]);
 await db.query('INSERT INTO contract_draft_signings VALUES($1,$2,$3,$4,$5,$6,1,auth.uid())',[signing,org,f.contract,document,sha,draft]);
 f.entry.documents=[{signing_id:signing,document_id:document,sha256:sha}];f.entry.confirmed=true;
 const q=(await db.query<{r:{state:string,batch_hash:string}}> ('SELECT dry_run_rent_support_reconciliation_v1($1,$2) r',[org,JSON.stringify([f.entry])])).rows[0].r;expect(q.state).toBe('READY');
 const args=[org,q.batch_hash,JSON.stringify([f.entry]),'Attest historical withholding',crypto.randomUUID()];
 const apply=()=>db.query<{r:Record<string,unknown>}>('SELECT apply_rent_support_reconciliation_v1($1,$2,$3,$4,$5) r',args);
 const result=(await apply()).rows[0].r;expect(result.state).toBe('COMPLETED');expect((await apply()).rows[0].r).toEqual(result);
 expect((await db.query('SELECT gross::text,withheld::text,net::text,provenance FROM app_private.rent_support_reconciliations WHERE source_id=$1',[f.entry.source_id])).rows[0]).toEqual({gross:'3000000',withheld:'1800000',net:'1200000',provenance:'MANUALLY_ATTESTED'});
 expect((await db.query('SELECT count(*)::int n FROM income_expenses WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:1});
 expect((await db.query('SELECT count(*)::int n FROM app_private.rent_support_withholding_events WHERE source_id=$1',[f.entry.source_id])).rows[0]).toEqual({n:0});
 expect((await db.query<{r:{due_upfront:string}}> ('SELECT quote_contract_rent_support_v1($1,$2,NULL,$3,NULL,NULL) r',[org,f.contract,JSON.stringify(f.plan)])).rows[0].r.due_upfront).toBe('0');
});
async function reusedDocumentFixture() {
 const f=await legacyFixture(),signing=crypto.randomUUID(),document=crypto.randomUUID(),draft=crypto.randomUUID(),sha='c'.repeat(64);
 // Canonical signer may reuse customer DOCX revision 2 after private finance save 3.
 await db.query('INSERT INTO contract_draft_documents VALUES($1,$2,$3,2,$4,auth.uid())',[document,org,draft,sha]);
 await db.query('INSERT INTO contract_draft_signings VALUES($1,$2,$3,$4,$5,$6,3,auth.uid())',[signing,org,f.contract,document,sha,draft]);
 f.entry.documents=[{signing_id:signing,document_id:document,sha256:sha}];f.entry.confirmed=true;
 return {...f,signing,document,draft,sha};
}
it('reused signed DOCX lineage stays selectable when document revision is older than signing',async()=>{
 const f=await reusedDocumentFixture();
 const r=(await db.query<{r:{documents:unknown[]}}>('SELECT read_rent_support_reconciliation_context_v1($1,$2,$3) r',[org,f.contract,f.entry.voucher_id])).rows[0].r;
 expect(r.documents).toEqual(f.entry.documents);
});
it('reused signed DOCX lineage reconciles exact immutable evidence and rejects wrong document or digest',async()=>{
 const f=await reusedDocumentFixture();
 const read=()=>db.query<{r:{state:string,batch_hash:string,rows:Array<{issue:string}>}}>('SELECT dry_run_rent_support_reconciliation_v1($1,$2) r',[org,JSON.stringify([f.entry])]);
 const q=(await read()).rows[0].r;expect(q.state).toBe('READY');
 const wrongDocument=crypto.randomUUID();
 await db.query('INSERT INTO contract_draft_documents VALUES($1,$2,$3,2,$4,auth.uid())',[wrongDocument,org,f.draft,f.sha]);
 f.entry.documents[0]!.document_id=wrongDocument;
 expect((await read()).rows[0].r.rows[0].issue).toBe('EVIDENCE_REVIEW');
 f.entry.documents[0]!.document_id=f.document;f.entry.documents[0]!.sha256='d'.repeat(64);
 expect((await read()).rows[0].r.rows[0].issue).toBe('EVIDENCE_REVIEW');
 f.entry.documents[0]!.sha256=f.sha;
 const args=[org,q.batch_hash,JSON.stringify([f.entry]),'Attest canonical reused customer document',crypto.randomUUID()];
 const apply=()=>db.query<{r:{state:string}}>('SELECT apply_rent_support_reconciliation_v1($1,$2,$3,$4,$5) r',args);
 const result=(await apply()).rows[0].r;expect(result.state).toBe('COMPLETED');expect((await apply()).rows[0].r).toEqual(result);
 expect((await db.query('SELECT gross::text,withheld::text,net::text,provenance FROM app_private.rent_support_reconciliations WHERE source_id=$1',[f.entry.source_id])).rows[0]).toEqual({gross:'3000000',withheld:'1800000',net:'1200000',provenance:'MANUALLY_ATTESTED'});
 expect((await db.query('SELECT count(*)::int n FROM income_expenses WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:1});
});
it.each(['future revision','wrong organization','wrong draft'] as const)('reused signed DOCX lineage excludes %s from context and attestation',async(mismatch)=>{
 const f=await reusedDocumentFixture();
 if(mismatch==='future revision')await db.query('UPDATE contract_draft_documents SET revision=4 WHERE id=$1',[f.document]);
 if(mismatch==='wrong organization')await db.query('UPDATE contract_draft_documents SET organization_id=$2 WHERE id=$1',[f.document,crypto.randomUUID()]);
 if(mismatch==='wrong draft')await db.query('UPDATE contract_draft_documents SET draft_id=$2 WHERE id=$1',[f.document,crypto.randomUUID()]);
 const context=(await db.query<{r:{documents:unknown[]}}>('SELECT read_rent_support_reconciliation_context_v1($1,$2,$3) r',[org,f.contract,f.entry.voucher_id])).rows[0].r;
 expect(context.documents).toEqual([]);
 const q=(await db.query<{r:{rows:Array<{issue:string}>}}>('SELECT dry_run_rent_support_reconciliation_v1($1,$2) r',[org,JSON.stringify([f.entry])])).rows[0].r;
 expect(q.rows[0].issue).toBe('EVIDENCE_REVIEW');
 expect((await db.query('SELECT count(*)::int n FROM app_private.rent_support_reconciliations WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:0});
});
it('provides canonical candidate IDs without guessing a source or party in the client',async()=>{
 const f=await legacyFixture();
 const r=(await db.query<{r:Record<string,unknown>}>('SELECT read_rent_support_reconciliation_context_v1($1,$2,$3) r',[org,f.contract,f.entry.voucher_id])).rows[0].r;
 expect(r).toMatchObject({source_id:f.entry.source_id,party_id:f.entry.party_id,engine_net:'1200000',documents:[]});
});
it('rejects false document identity, wrong gross and unconfirmed attestation',async()=>{
 const f=await legacyFixture();f.entry.confirmed=true;
 f.entry.documents=[{signing_id:crypto.randomUUID(),document_id:crypto.randomUUID(),sha256:'a'.repeat(64)}];
 const read=()=>db.query<{r:{rows:Array<{issue:string}>}}>('SELECT dry_run_rent_support_reconciliation_v1($1,$2) r',[org,JSON.stringify([f.entry])]);
 expect((await read()).rows[0].r.rows[0].issue).toBe('EVIDENCE_REVIEW');
 f.entry.gross='3000001';await expect(read()).rejects.toMatchObject({code:'22023'});
});
it('denies financial reads and attestations when authorization is missing',async()=>{
 const f=await legacyFixture();await db.exec("SELECT set_config('test.deny','yes',false)");
 try {
 await expect(db.query('SELECT read_contract_rent_support_lifecycle_v1($1,$2)',[org,f.contract])).rejects.toMatchObject({code:'42501'});
 await expect(db.query('SELECT dry_run_rent_support_reconciliation_v1($1,$2)',[org,JSON.stringify([f.entry])])).rejects.toMatchObject({code:'42501'});
 } finally {await db.exec("SELECT set_config('test.deny','',false)");}
});
it('stops reversal before posting audit or cash can change',async()=>{
 const f=await fixture();
 await expect(db.query("INSERT INTO income_expense_postings(id,organization_id,voucher_id,event_kind,reversal_of_id) VALUES($1,$2,$3,'REVERSAL',$4)",[crypto.randomUUID(),org,f.voucher_id,crypto.randomUUID()])).rejects.toMatchObject({code:'PT409'});
 expect((await db.query('SELECT count(*)::int n FROM income_expense_postings WHERE voucher_id=$1',[f.voucher_id])).rows[0]).toEqual({n:0});
});
it('keeps three consumed months and the unused committed 900000 after termination',async()=>{
 const f=await fixture();
 for(const month of ['2026-09','2026-10','2026-11']) {
  const id=crypto.randomUUID();
  await db.query("INSERT INTO invoices(id,organization_id,contract_id,building_id,billing_month,kind,status,subtotal,discount_amount,total_amount,invoice_support_amount,manual_discount_amount,credit_discount_amount,rent_support_plan_revision,rent_support_request_id) VALUES($1,$2,$3,$4,$5,'MONTHLY','DRAFT',1000000,300000,700000,300000,0,0,1,$1)",[id,org,f.contract,building,month]);
  await db.exec(`DO $$ BEGIN PERFORM app_private.invoice_rent_support_items_open_v1('${id}');INSERT INTO invoice_items(invoice_id,organization_id,accounting_class,amount) VALUES('${id}','${org}','REVENUE',1000000);PERFORM app_private.invoice_rent_support_items_close_v1('${id}');END $$`);
  await db.query('SELECT app_private.resolve_invoice_rent_support_v1($1,$2,$3,$4,$5,1,$3)',[org,f.contract,id,month,JSON.stringify([{billing_month:month}])]);
 }
 await db.query("UPDATE contracts SET status='TERMINATED',actual_end_date='2026-11-15' WHERE id=$1",[f.contract]);
 const read=(await db.query<{r:Record<string,unknown>}>('SELECT read_contract_rent_support_lifecycle_v1($1,$2) r',[org,f.contract])).rows[0].r;
 expect(read).toMatchObject({committed:'1800000',consumed:'900000',unused_committed:'900000',state:'NEEDS_REVIEW'});
 expect((await db.query('SELECT count(*)::int n FROM app_private.rent_support_invoice_claims WHERE contract_id=$1 AND released_at IS NULL',[f.contract])).rows[0]).toEqual({n:3});
});
it('reapplying only this new migration is idempotent and keeps the original quote provider',async()=>{
 const before=(await db.query<{d:string}>("SELECT md5(pg_get_functiondef('app_private.invoice_rent_support_quote_before_lifecycle_v1(uuid,uuid,text,text,jsonb,numeric,numeric,bigint)'::regprocedure)) d")).rows[0].d;
 await db.exec(readFileSync(migration,'utf8'));
 const after=(await db.query<{d:string}>("SELECT md5(pg_get_functiondef('app_private.invoice_rent_support_quote_before_lifecycle_v1(uuid,uuid,text,text,jsonb,numeric,numeric,bigint)'::regprocedure)) d")).rows[0].d;
 expect(after).toBe(before);const f=await fixture();expect(await invoiceQuote(f.contract,'2026-09')).toMatchObject({state:'READY',invoice_support:'300000'});
});
it('does not present a historical voucher mismatch as an authoritative source balance',async()=>{
 const f=await fixture();
 // Pre-existing drift fixture only; production never disables guards.
 await db.exec('ALTER TABLE income_expenses DISABLE TRIGGER a00_rent_support_lifecycle');
 try {await db.query('UPDATE income_expenses SET total_amount=1200001 WHERE id=$1',[f.voucher_id]);}
 finally {await db.exec('ALTER TABLE income_expenses ENABLE TRIGGER a00_rent_support_lifecycle');}
 await expect(db.query('SELECT read_contract_rent_support_lifecycle_v1($1,$2)',[org,f.contract])).rejects.toMatchObject({code:'PT409'});
});
it('checks the stored signed digest and explicit confirmation even when all IDs are correct',async()=>{
 const f=await legacyFixture(),signing=crypto.randomUUID(),document=crypto.randomUUID(),draft=crypto.randomUUID();
 await db.query('INSERT INTO contract_draft_documents VALUES($1,$2,$3,1,$4,auth.uid())',[document,org,draft,'a'.repeat(64)]);
 await db.query('INSERT INTO contract_draft_signings VALUES($1,$2,$3,$4,$5,$6,1,auth.uid())',[signing,org,f.contract,document,'a'.repeat(64),draft]);
 f.entry.documents=[{signing_id:signing,document_id:document,sha256:'b'.repeat(64)}];f.entry.confirmed=true;
 const read=()=>db.query<{r:{state:string,rows:Array<{issue:string}>}}>('SELECT dry_run_rent_support_reconciliation_v1($1,$2) r',[org,JSON.stringify([f.entry])]);
 expect((await read()).rows[0].r.rows[0].issue).toBe('EVIDENCE_REVIEW');
 f.entry.documents[0]!.sha256='a'.repeat(64);f.entry.confirmed=false;
 expect((await read()).rows[0].r.rows[0].issue).toBe('LEGACY_REVIEW');
});
it('keeps private ledgers and delegated provider functions inaccessible to API roles',async()=>{
 expect((await db.query("SELECT has_table_privilege('authenticated','app_private.rent_support_reconciliations','SELECT') permitted")).rows[0]).toEqual({permitted:false});
 expect((await db.query("SELECT has_function_privilege('authenticated','app_private.rent_support_source_funding_before_lifecycle_v1(uuid,uuid)','EXECUTE') permitted")).rows[0]).toEqual({permitted:false});
 expect((await db.query("SELECT has_function_privilege('authenticated','public.read_contract_rent_support_lifecycle_v1(uuid,uuid)','EXECUTE') permitted")).rows[0]).toEqual({permitted:true});
});
it('refuses applying a preview after the canonical voucher version changes',async()=>{
 const f=await legacyFixture(),entries=JSON.stringify([f.entry]);
 const q=(await db.query<{r:{batch_hash:string}}>('SELECT dry_run_rent_support_reconciliation_v1($1,$2) r',[org,entries])).rows[0].r;
 await db.query('UPDATE income_expenses SET approval_version=2 WHERE id=$1',[f.entry.voucher_id]);
 await expect(db.query('SELECT apply_rent_support_reconciliation_v1($1,$2,$3,$4,$5)',[org,q.batch_hash,entries,'Verify stale preview',crypto.randomUUID()])).rejects.toMatchObject({code:'PT409'});
 expect((await db.query('SELECT count(*)::int n FROM app_private.rent_support_payout_sources WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:0});
});
it('rechecks parent voucher authority before replaying a saved reconciliation request',async()=>{
 const f=await legacyFixture(),entries=JSON.stringify([f.entry]);
 const q=(await db.query<{r:{batch_hash:string}}>('SELECT dry_run_rent_support_reconciliation_v1($1,$2) r',[org,entries])).rows[0].r;
 const args=[org,q.batch_hash,entries,'Review exact evidence',crypto.randomUUID()];
 await db.query('SELECT apply_rent_support_reconciliation_v1($1,$2,$3,$4,$5)',args);
 await db.exec("SELECT set_config('test.parent_deny','yes',false)");
 try {await expect(db.query('SELECT apply_rent_support_reconciliation_v1($1,$2,$3,$4,$5)',args)).rejects.toMatchObject({code:'42501'});}
 finally {await db.exec("SELECT set_config('test.parent_deny','',false)");}
});
