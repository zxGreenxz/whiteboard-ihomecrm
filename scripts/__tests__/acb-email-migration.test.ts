import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

const migration = 'supabase/migrations/20261004205216_acb_email_realtime.sql';
const db = new PGlite();
const org = '11111111-1111-4111-8111-111111111111';
const otherOrg = '11111111-1111-4111-8111-111111111112';
const actor = '22222222-2222-4222-8222-222222222222';
const other = '22222222-2222-4222-8222-222222222223';
const account = '33333333-3333-4333-8333-333333333333';
const otherAccount = '33333333-3333-4333-8333-333333333334';
let connection: string;
let lease: string;
type ConnectionStatus = 'DISCONNECTED' | 'AUTHORIZING' | 'CONNECTED' | 'RECONNECT_REQUIRED';
interface ConnectionResult {
 id: string;
 status: ConnectionStatus;
 enabled: boolean;
}
interface TransactionReceipt {
 id: string;
 status: 'PENDING' | 'POSTED' | 'IGNORED';
 reason: string | null;
 invoiceId: string | null;
 receipt: Record<string, unknown> | null;
}
interface TransactionResult extends TransactionReceipt {
 createdAt: string;
}
interface JobResult {
 connectionId: string;
 leaseToken: string;
 encryptedRefreshToken: string;
 email: string;
 historyId: string | null;
 watchExpiresAt: string | null;
 scanPageToken: string | null;
 scanHistoryId: string | null;
 historyPageToken: string | null;
 historyStartId: string | null;
 disconnect: boolean;
}
interface RpcResults {
 bank_email_setup_v1: ConnectionResult;
 bank_email_set_enabled_v1: ConnectionResult;
 bank_email_disconnect_v1: ConnectionResult;
 bank_email_oauth_begin_v1: { id: string; status: 'AUTHORIZING' };
 bank_email_list_v1: { connections: ConnectionResult[]; transactions: TransactionResult[]; hasMore: boolean };
 bank_email_review_v1: TransactionReceipt;
 bank_email_transaction_v1: TransactionResult;
 bank_email_my_connections_v1: { connections: { id: string; email: string | null; status: ConnectionStatus; organizationId: string }[] };
}
interface WorkerResults {
 oauth_consume: { connectionId: string; encryptedVerifier: string };
 oauth_complete: { id: string; status: 'CONNECTED' };
 claim: { jobs: JobResult[] };
 ingest: TransactionReceipt;
 page_pending: { pendingMessageIds: string[] };
 checkpoint: { ok: true };
 watch_metadata: { ok: true };
 scan_checkpoint: { ok: true };
 history_checkpoint: { ok: true };
 page_progress: { ok: true };
 finish: { ok: true };
}
const queryRpc = async <T>(name: string, args: unknown[]): Promise<T> =>
 (await db.query<{ result: T }>(`SELECT public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) result`, args)).rows[0].result;
const rpc = <K extends keyof RpcResults>(name: K, args: unknown[] = []): Promise<RpcResults[K]> => queryRpc<RpcResults[K]>(name, args);
const act = async (id: string = actor, role = 'authenticated') => db.query(`SELECT set_config('request.jwt.claims',$1,false),set_config('request.jwt.claim.sub',$2,false)`,[JSON.stringify({sub:id,role}),id]);
const worker = <K extends keyof WorkerResults>(op: K, payload: unknown = {}): Promise<WorkerResults[K]> => queryRpc<WorkerResults[K]>('bank_email_worker_v1',[op,JSON.stringify(payload)]);
beforeAll(async () => {
 await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
 CREATE SCHEMA auth; CREATE SCHEMA app_private;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claims',true)::jsonb->>'role' $$;
 CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text);
 INSERT INTO public.organizations VALUES('${org}','ACTIVE'),('${otherOrg}','ACTIVE');
 CREATE TABLE public.organization_memberships(id uuid DEFAULT gen_random_uuid(),organization_id uuid,user_id uuid,status text,valid_from timestamptz,valid_to timestamptz);
 INSERT INTO public.organization_memberships(organization_id,user_id,status) VALUES('${org}','${actor}','ACTIVE'),('${otherOrg}','${actor}','ACTIVE');
 CREATE TABLE public.accounts(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,is_virtual boolean);
 INSERT INTO public.accounts VALUES('${account}','${org}',null,false),('${otherAccount}','${otherOrg}',null,false);
 CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
 INSERT INTO public.buildings VALUES('${account}','${org}',null),('${otherAccount}','${otherOrg}',null);
 CREATE TABLE public.invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,invoice_number text,total_amount numeric,paid_amount numeric,deleted_at timestamptz,status text);
 INSERT INTO public.invoices(organization_id,building_id,invoice_number,total_amount,paid_amount,status) VALUES('${org}','${account}','HD-ACB-001',100000,0,'UNPAID'),('${org}','${account}','HD-ACB-002',100000,0,'UNPAID'),('${org}','${account}','HD-ACB-003',100000,0,'UNPAID');
 INSERT INTO public.invoices(organization_id,building_id,invoice_number,total_amount,paid_amount,status) VALUES('${otherOrg}','${otherAccount}','HD-ACB-001',100000,0,'UNPAID');
 CREATE TABLE public.notifications(id uuid DEFAULT gen_random_uuid(),user_id uuid,type text,channel text,subject text,content text,organization_id uuid,metadata jsonb,status text);
 CREATE TABLE public.test_rights(allowed boolean); INSERT INTO public.test_rights VALUES(true);
 CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT '{}'::uuid[] $$;
 CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
 CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT allowed FROM test_rights $$;
 CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean) LANGUAGE sql AS $$ SELECT allowed FROM test_rights $$;
 CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT allowed FROM test_rights $$;
 CREATE FUNCTION app_private.ie_has_cashbook_possession_v1(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT allowed FROM test_rights $$;
 CREATE FUNCTION app_private.receiving_cashbook_allowed_v1(uuid,uuid,text,uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT allowed FROM test_rights $$;
 CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
 CREATE TABLE public.test_v5_calls(invoice_id uuid,actor_id uuid,amount numeric);
 CREATE TABLE public.test_v5_rejection(enabled boolean);
 CREATE FUNCTION public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text) RETURNS jsonb LANGUAGE plpgsql AS $$
 BEGIN
 IF EXISTS(SELECT 1 FROM test_v5_rejection WHERE enabled) THEN RAISE EXCEPTION 'canonical writer temporarily rejects' USING ERRCODE='55000'; END IF;
 IF auth.uid() IS NULL OR $4 <> 'REJECT' OR $5 OR $3->0->>'payment_method' <> 'TK' THEN RAISE EXCEPTION 'unsafe V5 call'; END IF;
 INSERT INTO test_v5_calls VALUES($1,auth.uid(),($3->0->>'gross_amount')::numeric);
 UPDATE invoices SET paid_amount=paid_amount+($3->0->>'gross_amount')::numeric WHERE id=$1;
 RETURN jsonb_build_object('collection_id',gen_random_uuid(),'invoice_id',$1,'gross_amount',($3->0->>'gross_amount')::numeric,'applied_amount',($3->0->>'gross_amount')::numeric,'change_amount',0,'credit_amount',0,'rounding_amount',0,'credit_lot_id',NULL); END $$;
 `);
 if(existsSync(migration)){ const sql=readFileSync(migration,'utf8'); await db.exec(sql); await db.exec(sql); }
 await act();
},30000);
afterAll(()=>db.close());
it('creates owner-only connection, rejects invalid account mapping and worker caller',async()=>{
 const c=await rpc('bank_email_setup_v1',[org,'1234567890',account]); connection=c.id;
 expect(c.status).toBe('DISCONNECTED'); expect(c.enabled).toBe(false);
 await expect(rpc('bank_email_setup_v1',[otherOrg,'1234567890',otherAccount])).rejects.toThrow();
 await expect(rpc('bank_email_setup_v1',[org,'1234567899',otherAccount])).rejects.toThrow();
 expect((await rpc('bank_email_list_v1',[org,null,30])).connections[0].id).toBe(connection);
 await expect(worker('claim')).rejects.toThrow();
 await act(other); await expect(rpc('bank_email_set_enabled_v1',[connection,true])).rejects.toThrow(); await act();
});
it('consumes OAuth once; leases isolate jobs',async()=>{
 await rpc('bank_email_oauth_begin_v1',[connection,'a'.repeat(64),'encrypted-verifier']);
 await act(actor,'service_role');
 expect((await worker('oauth_consume',{stateHash:'a'.repeat(64)})).connectionId).toBe(connection);
 await expect(worker('oauth_consume',{stateHash:'a'.repeat(64)})).rejects.toThrow();
 await worker('oauth_complete',{stateHash:'a'.repeat(64),email:'test@example.com',encryptedRefreshToken:'encrypted-token',historyId:'100',watchExpiresAt:new Date(Date.now()+86400000).toISOString()});
 const jobs=(await worker('claim')).jobs; expect(jobs).toHaveLength(1); expect(jobs[0].historyId).toBe(null); lease=jobs[0].leaseToken;
 expect((await worker('claim')).jobs).toHaveLength(0);
 await expect(worker('checkpoint',{connectionId:connection,leaseToken:other,historyId:'101'})).rejects.toThrow();
 await act(); await rpc('bank_email_set_enabled_v1',[connection,true]); await act(actor,'service_role');
 await act(other); await expect(rpc('bank_email_set_enabled_v1',[connection,false])).rejects.toThrow(); await act(actor,'service_role');
});
const message = (id: string,ref: string,description='HD-ACB-001',amount=100000) => ({connectionId:connection,leaseToken:lease,messageId:id,internalDate:new Date().toISOString(),verified:true,parsed:{account:'1234567890',amount,balance:900000,currency:'VND',direction:'CREDIT',occurredAt:new Date().toISOString(),bankReference:ref,description},parseError:null});
it('posts exact unique reference with stored owner and restores JWT claims; replay does not post twice',async()=>{
 const first=await worker('ingest',message('msg1','ref1')); expect(first.status).toBe('POSTED');
 expect((await worker('ingest',message('msg1','ref1'))).id).toBe(first.id);
 expect((await worker('ingest',message('msg2','ref1','HD-ACB-002'))).id).toBe(first.id);
 expect((await db.query('SELECT * FROM test_v5_calls')).rows).toEqual([{invoice_id:first.invoiceId,actor_id:actor,amount:'100000'}]);
 expect((await db.query<{ role: string }>('SELECT auth.role() role')).rows[0].role).toBe('service_role');
});
it('keeps ambiguity, wrong amount, invalid signature, stale mail and token-boundary mismatch pending',async()=>{
 for(const [index,edit] of [
  {parsed:{...message('x','x').parsed,description:'HD-ACB-002 HD-ACB-003'}},
  {parsed:{...message('x','x').parsed,description:'HD-ACB-002',amount:99999}},
  {verified:false},
  {parsed:{...message('x','x').parsed,occurredAt:'2020-01-01T00:00:00Z'}},
  {parsed:{...message('x','x').parsed,description:'XHD-ACB-002Y'}}
 ].entries()) {
  const base=message(`bad${index}`,`badref${index}`);
  const result=await worker('ingest',{...base,...edit,parsed:{...base.parsed,...edit.parsed,bankReference:`badref${index}`}});
  expect(result.status).toBe('PENDING');
  expect(result.reason).toBe(['INVOICE_NOT_UNIQUE','AMOUNT_MISMATCH','UNSAFE_TRANSACTION','AUTO_DISABLED_OR_OLD','INVOICE_NOT_UNIQUE'][index]);
 }
 expect((await db.query('SELECT * FROM test_v5_calls')).rows).toHaveLength(1);
});
it('resumes bounded scan/history pages and fences expired leases and checkpoints',async()=>{
 await worker('scan_checkpoint',{connectionId:connection,leaseToken:lease,scanHistoryId:'120',pageToken:null,complete:false});
 await worker('page_progress',{connectionId:connection,leaseToken:lease,mode:'scan',pageToken:null,messageId:'slow-message-1'});
 expect((await worker('page_pending',{connectionId:connection,leaseToken:lease,mode:'scan',pageToken:null,messageIds:['slow-message-1','slow-message-2']})).pendingMessageIds).toEqual(['slow-message-2']);
 // One Gmail history record may contain more than 1,000 messages, despite page maxResults.
 await db.query("INSERT INTO app_private.bank_email_page_messages(connection_id,message_id) SELECT $1,'many-'||n FROM generate_series(1,1001) n",[connection]);
 await worker('page_progress',{connectionId:connection,leaseToken:lease,mode:'scan',pageToken:null,messageId:'many-1002'});
 expect((await worker('page_pending',{connectionId:connection,leaseToken:lease,mode:'scan',pageToken:null,messageIds:['many-1001','many-1002','many-1003']})).pendingMessageIds).toEqual(['many-1003']);
 await worker('page_progress',{connectionId:connection,leaseToken:lease,mode:'scan',pageToken:null,messageId:'slow-message-1'});
 await worker('finish',{connectionId:connection,leaseToken:lease});
 const partial=(await worker('claim')).jobs[0]; expect(partial).not.toHaveProperty('processedMessageIds'); lease=partial.leaseToken;
 expect((await worker('page_pending',{connectionId:connection,leaseToken:lease,mode:'scan',pageToken:null,messageIds:['slow-message-1','many-1002','many-1003']})).pendingMessageIds).toEqual(['many-1003']);
 await expect(worker('page_progress',{connectionId:connection,leaseToken:lease,mode:'history',pageToken:null,messageId:'wrong-mode'})).rejects.toThrow();
 await expect(worker('page_progress',{connectionId:connection,leaseToken:lease,mode:'scan',pageToken:'wrong-page',messageId:'wrong-page'})).rejects.toThrow();
 await worker('scan_checkpoint',{connectionId:connection,leaseToken:lease,scanHistoryId:'120',pageToken:'page-2',complete:false});
 await worker('finish',{connectionId:connection,leaseToken:lease});
 const job=(await worker('claim')).jobs[0]; expect(job.scanPageToken).toBe('page-2'); expect(job.scanHistoryId).toBe('120'); lease=job.leaseToken;
 expect((await worker('page_pending',{connectionId:connection,leaseToken:lease,mode:'scan',pageToken:'page-2',messageIds:['slow-message-1']})).pendingMessageIds).toEqual(['slow-message-1']);
 await expect(worker('scan_checkpoint',{connectionId:connection,leaseToken:lease,scanHistoryId:'121',pageToken:'page-3',complete:false})).rejects.toThrow();
 await worker('scan_checkpoint',{connectionId:connection,leaseToken:lease,scanHistoryId:'120',pageToken:null,complete:true});
 await worker('history_checkpoint',{connectionId:connection,leaseToken:lease,startHistoryId:'120',pageToken:'history-2',complete:false});
 await worker('finish',{connectionId:connection,leaseToken:lease});
 const next=(await worker('claim')).jobs[0]; expect(next.historyPageToken).toBe('history-2'); expect(next.historyStartId).toBe('120'); lease=next.leaseToken;
 await worker('history_checkpoint',{connectionId:connection,leaseToken:lease,startHistoryId:'120',pageToken:null,complete:true,finalHistoryId:'140'});
 await worker('checkpoint',{connectionId:connection,leaseToken:lease,historyId:'130'});
 expect((await db.query<{ h: string | null }>('SELECT history_id::text h FROM app_private.bank_email_credentials')).rows[0].h).toBe('140');
 await worker('watch_metadata',{connectionId:connection,leaseToken:lease,watchExpiresAt:new Date(Date.now()+86400000).toISOString()});
 expect((await db.query<{ h: string | null }>('SELECT history_id::text h FROM app_private.bank_email_credentials')).rows[0].h).toBe('140');
 await expect(worker('watch_metadata',{connectionId:connection,leaseToken:lease,watchExpiresAt:'infinity'})).rejects.toThrow();
 await expect(worker('ingest',{...message('infinite-date','infinite-date'),internalDate:'infinity'})).rejects.toThrow();
 const infinite=message('infinite-event','infinite-event'); await expect(worker('ingest',{...infinite,parsed:{...infinite.parsed,occurredAt:'infinity'}})).rejects.toThrow();
 await db.exec("UPDATE app_private.bank_email_jobs SET leased_until=clock_timestamp()-interval '1 second'");
 await expect(worker('ingest',message('expired','expired'))).rejects.toThrow();
 await db.exec('UPDATE app_private.bank_email_jobs SET due_at=clock_timestamp()'); lease=(await worker('claim')).jobs[0].leaseToken;
});
it('persists canonical rejection and safely replays message/source without duplicate notification',async()=>{
 await db.exec('INSERT INTO test_v5_rejection VALUES(true)');
 try {
  const pending=await worker('ingest',message('writer-rejected','writer-rejected','HD-ACB-003')); expect(pending.reason).toBe('WRITER_REJECTED');
  expect((await worker('ingest',message('writer-rejected','writer-rejected','HD-ACB-003'))).id).toBe(pending.id);
  const replay=await worker('ingest',message('writer-rejected-copy','writer-rejected','HD-ACB-003')); expect(replay.reason).toBe('WRITER_REJECTED');
  expect((await db.query('SELECT * FROM notifications WHERE metadata->>\'bankEmailTransactionId\'=$1',[pending.id])).rows).toHaveLength(1);
 } finally {await db.exec('DELETE FROM test_v5_rejection');}
});
it('manual exact review uses V5, failed signatures cannot reserve sources, inbox pages stay stable',async()=>{
 const unsigned=await worker('ingest',{...message('unsigned2','second-invoice','HD-ACB-002'),verified:false}); expect(unsigned.status).toBe('PENDING');
 const pending=await worker('ingest',message('manual2','second-invoice','No invoice reference')); expect(pending.status).toBe('PENDING');
 await act();
 const target=(await db.query<{id:string}>("SELECT id FROM invoices WHERE invoice_number='HD-ACB-002'")).rows[0].id;
 await expect(rpc('bank_email_review_v1',[pending.id,'HD-ACB-002',false,other,100000])).rejects.toMatchObject({code:'PT409'});
 await expect(rpc('bank_email_review_v1',[pending.id,'HD-ACB-002',false,target,99999])).rejects.toThrow();
 expect((await db.query('SELECT * FROM test_v5_calls')).rows).toHaveLength(1);
 expect((await rpc('bank_email_review_v1',[unsigned.id,'HD-ACB-002',false,target,100000])).status).toBe('PENDING');
 expect((await rpc('bank_email_review_v1',[pending.id,'HD-ACB-002',false,target,100000])).status).toBe('POSTED');
 expect((await rpc('bank_email_transaction_v1',[pending.id])).status).toBe('POSTED');
 await act(other); await expect(rpc('bank_email_transaction_v1',[pending.id])).rejects.toThrow(); await act();
 await expect(rpc('bank_email_review_v1',[pending.id,'HD-ACB-002',false,other,100000])).rejects.toThrow();
 const first=await rpc('bank_email_list_v1',[org,null,2]); expect(first.hasMore).toBe(true);
 const second=await rpc('bank_email_list_v1',[org,first.transactions[1].createdAt,2]); expect(second.transactions.some((t: {id:string})=>first.transactions.some((a: {id:string})=>a.id===t.id))).toBe(false);
 await act(actor,'service_role');
});
it('revoked authority blocks replay and UI and disconnect stops posting',async()=>{
 await db.exec('UPDATE test_rights SET allowed=false');
 await expect(worker('ingest',message('msg1','ref1'))).rejects.toThrow();
 await db.exec('UPDATE app_private.bank_email_jobs SET lease_token=NULL,leased_until=NULL,due_at=clock_timestamp()');
 expect((await worker('claim')).jobs).toEqual([]);
 expect((await db.query('SELECT status,last_error,enabled FROM bank_email_connections')).rows[0]).toEqual({status:'RECONNECT_REQUIRED',last_error:'PERMISSION_REVOKED',enabled:false});
 await act(); await expect(rpc('bank_email_list_v1',[org,null,30])).rejects.toThrow();
 const mine=await rpc('bank_email_my_connections_v1'); expect(mine.connections).toEqual([{id:connection,email:'test@example.com',status:'RECONNECT_REQUIRED',organizationId:org}]);
 await act(other); expect((await rpc('bank_email_my_connections_v1')).connections).toEqual([]); await expect(rpc('bank_email_disconnect_v1',[connection])).rejects.toThrow(); await act();
 await rpc('bank_email_disconnect_v1',[connection]);
 await act(actor,'service_role'); await expect(worker('ingest',message('after','after','HD-ACB-002'))).rejects.toThrow();
 const revoke=(await worker('claim')).jobs[0]; expect(revoke.disconnect).toBe(true); expect(revoke.encryptedRefreshToken).toBe('encrypted-token');
 await worker('finish',{connectionId:connection,leaseToken:revoke.leaseToken});
 expect((await db.query('SELECT * FROM app_private.bank_email_credentials')).rows).toHaveLength(0);
});
