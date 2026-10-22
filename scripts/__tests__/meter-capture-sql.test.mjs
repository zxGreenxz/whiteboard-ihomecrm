import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const path = 'supabase/migrations/20261022144130_meter_capture_evidence_v1.sql';
const sql = readFileSync(path, 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [org, actor, building, room, meter, contract, service, foreignOrg, foreignBuilding, foreignRoom, foreignMeter] = Array.from({ length: 11 }, (_, n) => id(n + 1));
const sha = 'a'.repeat(64);
const profilePath = `${org}/profiles/${meter}/${actor}/${id(50)}`;

async function fixture(source = sql) {
 const db = new PGlite();
 await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;
 CREATE SCHEMA auth;CREATE SCHEMA app_private;CREATE SCHEMA storage;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
 CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${org}']::uuid[] $$;
 CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
 CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql STABLE AS $$ SELECT $1=auth.uid() AND current_setting('test.access',true)='yes' AND $4='${building}' $$;
 CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz);
 CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,name text);
 CREATE TABLE meters(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,room_id uuid,service_id uuid,meter_type text DEFAULT 'ELECTRICITY',code text DEFAULT 'D1',name text DEFAULT 'Điện',serial_number text DEFAULT 'S1',status text DEFAULT 'ACTIVE',deleted_at timestamptz);
 CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,status text DEFAULT 'ACTIVE',start_date date DEFAULT '2026-10-01',end_date date DEFAULT '2027-12-31',actual_end_date date,initial_electricity_reading numeric DEFAULT 100,updated_at timestamptz DEFAULT '2026-10-01',deleted_at timestamptz);
 CREATE TABLE meter_readings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,meter_id uuid,contract_id uuid,building_id uuid,room_id uuid,service_id uuid,meter_type text,reading_code text,reading_date date,previous_reading numeric(10,2),current_reading numeric(10,2),status text,approved_by uuid,approved_at timestamptz,recorded_by uuid,notes text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT clock_timestamp(),deleted_at timestamptz,CHECK(current_reading>=previous_reading));
 CREATE TABLE invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,building_id uuid,billing_month text,issue_date date,status text DEFAULT 'APPROVED',total_amount numeric DEFAULT 0,updated_at timestamptz DEFAULT clock_timestamp(),created_at timestamptz DEFAULT clock_timestamp(),deleted_at timestamptz);
 CREATE TABLE invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),invoice_id uuid,service_id uuid,previous_reading numeric,current_reading numeric,to_date date,sort_order int);
 CREATE TABLE contract_exit_cases(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,actual_move_out_on date,state text,settlement_result jsonb);
 CREATE TABLE contract_meter_boundary_sets(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,kind text,state text,revision bigint,effective_on date);
 CREATE TABLE contract_meter_boundaries(id uuid PRIMARY KEY,set_id uuid,revision bigint,meter_id uuid,state text,reading numeric);
 CREATE TABLE contract_services(contract_id uuid,organization_id uuid,service_id uuid,unit_price numeric);
 CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,metadata jsonb DEFAULT '{}',UNIQUE(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 CREATE POLICY legacy_permissive ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true);
 GRANT USAGE ON SCHEMA public,auth,storage,app_private TO authenticated,anon,service_role;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;GRANT SELECT ON storage.objects TO anon;
 INSERT INTO buildings VALUES('${building}','${org}','A',NULL),('${foreignBuilding}','${foreignOrg}','B',NULL);
 INSERT INTO rooms VALUES('${room}','${org}','${building}','101'),('${foreignRoom}','${foreignOrg}','${foreignBuilding}','201');
 INSERT INTO meters(id,organization_id,building_id,room_id,service_id) VALUES('${meter}','${org}','${building}','${room}','${service}'),('${foreignMeter}','${foreignOrg}','${foreignBuilding}','${foreignRoom}','${service}');
 INSERT INTO contracts(id,organization_id,room_id) VALUES('${contract}','${org}','${room}');
 INSERT INTO contract_services VALUES('${contract}','${org}','${service}',500);
 INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('meter-capture-media','${profilePath}','{"mimetype":"image/jpeg"}');
 -- Mirrors the old autofill bug: an unrelated future reading tries to override capture's own baseline.
 CREATE FUNCTION autofill_legacy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.previous_reading:=9999; RETURN NEW; END $$;
 CREATE TRIGGER trigger_auto_populate_previous_reading BEFORE INSERT ON meter_readings FOR EACH ROW EXECUTE FUNCTION autofill_legacy();
 CREATE FUNCTION public.create_invoice_v1(p_contract_id uuid,p_building_id uuid,p_billing_month text,p_items jsonb,p_idempotency_key text,p_total_amount numeric DEFAULT 0,p_applied_credit numeric DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql AS $$
 DECLARE v_id uuid; x jsonb; BEGIN INSERT INTO invoices(organization_id,contract_id,building_id,billing_month,issue_date,total_amount) VALUES('${org}',p_contract_id,p_building_id,p_billing_month,'2026-10-31',p_total_amount) RETURNING id INTO v_id;
 FOR x IN SELECT value FROM jsonb_array_elements(p_items) LOOP INSERT INTO invoice_items(invoice_id,service_id,previous_reading,current_reading,sort_order) VALUES(v_id,(x->>'service_id')::uuid,(x->>'previous_reading')::numeric,(x->>'current_reading')::numeric,(x->>'sort_order')::int); END LOOP;
 RETURN jsonb_build_object('invoice_id',v_id); END $$;
 -- The live credit writer (20260728150000_enable_non_cash_overpay_credit.sql) rejects zero credit.
 CREATE FUNCTION public.create_invoice_with_credit_v1(p_contract_id uuid,p_building_id uuid,p_billing_month text,p_items jsonb,p_idempotency_key text,p_total_amount numeric DEFAULT 0,p_applied_credit numeric DEFAULT 0,p_non_credit_discount_amount numeric DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql AS $$
 BEGIN IF p_applied_credit IS NULL OR p_applied_credit='NaN'::numeric OR p_applied_credit<=0 OR p_applied_credit IS DISTINCT FROM round(p_applied_credit,2) THEN RAISE EXCEPTION 'Applied credit must be positive' USING ERRCODE='22023';END IF;
 RETURN public.create_invoice_v1(p_contract_id,p_building_id,p_billing_month,p_items,p_idempotency_key,p_total_amount,p_applied_credit);END $$;
 CREATE FUNCTION public.confirm_contract_return_v1(p_organization_id uuid,p_contract_id uuid,p_actual_move_out_on date,p_settlement_mode text,p_settlement jsonb,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
 DECLARE v_id uuid;x jsonb; BEGIN
 FOR x IN SELECT value FROM jsonb_array_elements(p_settlement->'extra_charges') LOOP
 IF x ? 'meter_source' OR x ? 'meter_id' THEN RAISE EXCEPTION 'Source metadata/duplicate meter must be stripped'; END IF; END LOOP;
 INSERT INTO contract_exit_cases(organization_id,contract_id,actual_move_out_on,state) VALUES(p_organization_id,p_contract_id,p_actual_move_out_on,'FINALIZED') RETURNING id INTO v_id;
 RETURN jsonb_build_object('id',v_id,'state','FINALIZED'); END $$;
 SELECT set_config('test.actor','${actor}',false),set_config('test.access','yes',false);`);
 try { await db.exec(source); await db.exec(source); } catch(error) {
  await db.close();
  const position=Number(error.position??0); error.message+=` (migration line ${source.slice(0,position).split('\n').length}, context ${error.where??error.internalQuery??''})`;
  throw error;
 }
 return db;
}
async function rpc(db, action, payload = {}, organization = org) {
 return (await db.query('SELECT public.meter_capture_v1($1,$2,$3) AS result', [organization, action, JSON.stringify(payload)])).rows[0].result;
}
async function register(db) {
 return rpc(db, 'profile', { meterId: meter, expectedVersion: 0, serial: 'S1', displayKind: 'DIGITAL', decimalPlaces: 2, registerCode: '1.8.0', referencePath: profilePath, verified: true });
}
async function start(db, changes = {}) {
 const qr = (await rpc(db, 'catalog')).meters.find(m => m.id === meter).qrText;
 return rpc(db, 'startCapture', { clientId: id(100), meterId: meter, qrText: qr, purpose: 'MONTHLY', readingDate: '2026-10-31', month: '2026-10', capturedAt: '2026-10-31T01:00:00Z', sha256: sha, mimeType: 'image/jpeg', sizeBytes: 20, ...changes });
}
async function upload(db, started, validateImage=true) {
 const c = started.capture;
 await db.query('INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,$3)', ['meter-capture-media', started.uploadPath, { mimetype: c.mimeType }]);
 await db.query('SELECT meter_capture_media_receipt_v1($1,$2,$3,$4,$5,$6)', [c.id, started.uploadPath, c.sha256, c.sizeBytes, c.mimeType, null]);
 await rpc(db, 'finalizeCapture', { captureId: c.id, sha256: c.sha256, sizeBytes: c.sizeBytes });
 if(c.mimeType.startsWith('image/')&&validateImage){
  const job=(await db.query("SELECT meter_capture_claim_v1('validator') result")).rows[0].result;
  const engine={status:'unreadable',version:'fixture',value:null,registerCode:null,unit:null,frames:[]};
  await db.query('SELECT meter_capture_complete_v1($1,$2,$3)',[job.jobId,job.leaseToken,{mediaValidated:true,issues:[],identity:{ambiguous:false,qrTokens:[job.meter.qrToken]},server:engine,ai:engine}]);
 }
 return rpc(db,'getCapture',{captureId:c.id});
}
async function confirm(db, c, value = '120', reason = 'Đối chiếu trực tiếp ảnh và serial') {
 return rpc(db, 'confirmCapture', { captureId: c.id, expectedVersion: c.version, value, reason });
}
async function source(db, purpose = 'MONTHLY') {
 const m = (await rpc(db, 'resolveBilling', { contractId: contract, month: '2026-10', readingDate: '2026-10-31', purpose })).meters[0];
 return { meterId: meter, contractId: contract, month: '2026-10', readingDate: '2026-10-31', purpose, startReadingId: m.start.readingId, startVersion: m.start.version, endReadingId: m.end.readingId, endVersion: m.end.version, previousReading: m.start.value, currentReading: m.end.value, sortOrder: 1 };
}
const invoiceArgs = s => ({ p_contract_id: contract, p_building_id: building, p_billing_month: '2026-10', p_idempotency_key: 'invoice-test-001', p_total_amount: 10000,
 p_items: [{ service_id: service, sort_order: 1, previous_reading: s.previousReading, current_reading: s.currentReading,
 unit_price:500,quantity:Number(s.currentReading)-Number(s.previousReading),coefficient:1,amount:500*(Number(s.currentReading)-Number(s.previousReading)),meter_source: s }] });
const invoice = async (db, args, sources) => (await db.query('SELECT meter_capture_invoice_v1($1,$2,$3) AS result', [org, args, sources])).rows[0].result;

test('QR history/CAS, exact organization and building authorization; client cannot invoke worker or read private tables', async t => {
 const db = await fixture(); t.after(() => db.close());
 const profile = await register(db); assert.match(profile.qrText, /^ihome-meter:/);
 await assert.rejects(rpc(db, 'resolveQr', { qrText: profile.qrText }, foreignOrg), { code: '42501' });
 await assert.rejects(rpc(db, 'profile', { meterId: meter, expectedVersion: 0 }), { code: 'PT409' });
 await db.exec("SELECT set_config('test.access','no',false)");
 await assert.rejects(rpc(db, 'resolveQr', { qrText: profile.qrText }), { code: '42501' });
 await db.exec("SELECT set_config('test.access','yes',false)");
 await rpc(db, 'revokeQr', { meterId: meter, expectedVersion: 1, reason: 'Thay tem' });
 await assert.rejects(rpc(db, 'resolveQr', { qrText: profile.qrText }), { code: '42501' });
 const rotated = await rpc(db, 'rotateQr', { meterId: meter, expectedVersion: 2, reason: 'Cấp mới' });
 assert.notEqual(rotated.qrText, profile.qrText);
 assert.equal((await db.query('SELECT count(*)::int n FROM app_private.meter_capture_profile_history')).rows[0].n, 3);
 await db.exec('SET ROLE authenticated');
 await assert.rejects(db.query('SELECT meter_capture_claim_v1($1)', ['bad-client']), { code: '42501' });
 await assert.rejects(db.query('SELECT * FROM app_private.meter_captures'), { code: '42501' });
 await db.exec('RESET ROLE');
});

test('persisted original receipt, idempotent retry and CAS; confirm overrides unsafe latest autofill and never autoapproves', async t => {
 const db = await fixture(); t.after(() => db.close()); await register(db);
 const first = await start(db); assert.equal((await start(db)).capture.id, first.capture.id);
 await assert.rejects(start(db, { sizeBytes: 22 }), { code: '23505' });
 assert.equal((await db.query('SELECT count(*)::int n FROM meter_readings')).rows[0].n, 0);
 await assert.rejects(confirm(db, first.capture), { code: '55000' });
 await assert.rejects(rpc(db, 'finalizeCapture', { captureId: first.capture.id, sha256: sha, sizeBytes: 20 }), { code: '55000' });
 const ready = await upload(db, first);
 await assert.rejects(confirm(db, first.capture), { code: 'PT409' });
 const done = await confirm(db, ready.capture);
 assert.equal(done.capture.status, 'CONFIRMED');
 const row = (await db.query('SELECT previous_reading,current_reading,contract_id FROM meter_readings')).rows[0];
 assert.deepEqual(row, { previous_reading: '100.00', current_reading: '120.00', contract_id: contract });
 assert.equal((await confirm(db, ready.capture)).capture.confirmedReadingId, done.capture.confirmedReadingId);
 await assert.rejects(db.query("UPDATE meter_readings SET current_reading=130 WHERE id=$1", [done.capture.confirmedReadingId]), { code: '55000' });
});

test('video needs measured server duration; immutable result and late OCR cannot change human reading', async t => {
 const db = await fixture(); t.after(() => db.close()); await register(db);
 const ready = await upload(db, await start(db, { mimeType: 'video/mp4', durationSeconds: 15 }));
 await assert.rejects(confirm(db, ready.capture), { code: '55000' });
 const job = (await db.query('SELECT meter_capture_claim_v1($1) result', ['worker-1'])).rows[0].result;
 const imageSha = 'b'.repeat(64); const key = `${org}/meter-captures/${ready.capture.id}/evidence/${imageSha}.jpg`;
 await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)', ['meter-capture-media', key]);
 for (const stamp of [1, 2]) await db.query('SELECT meter_capture_evidence_receipt_v1($1,$2,$3,$4,$5)', [job.jobId, job.leaseToken, key, imageSha, stamp]);
 const engine = { value: '120.00', registerCode: '1.8.0', unit: 'kWh', status: 'ok', version: 'test-1', frames: [1, 2].map(timestampSeconds => ({ timestampSeconds, objectKey: key })) };
 const result = { mediaValidated: true, durationSeconds: 15, server: engine, ai: engine, identity: { qrTokens: [job.meter.qrToken], ambiguous: false }, issues: [] };
 await db.query('SELECT meter_capture_complete_v1($1,$2,$3)', [job.jobId, job.leaseToken, result]);
 const reviewed = (await rpc(db, 'getCapture', { captureId: ready.capture.id })).capture;
 const done = await confirm(db, reviewed, '120.00', undefined); assert.equal(done.capture.status, 'CONFIRMED');
 await assert.rejects(db.query('SELECT meter_capture_complete_v1($1,$2,$3)', [job.jobId, job.leaseToken, { ...result, issues: ['changed'] }]), { code: '23505' });
 await db.query('SELECT meter_capture_media_receipt_v1($1,$2,$3,$4,$5,$6)', [ready.capture.id, ready.uploadPath, sha, 20, 'video/mp4', null]);
 assert.equal((await rpc(db, 'getCapture', { captureId: ready.capture.id })).capture.mediaValidated, true);
});

test('private storage stays scoped even with a broad legacy policy; originals cannot be overwritten/deleted', async t => {
 const db = await fixture(); t.after(() => db.close()); await register(db); const cap = await start(db);
 await db.exec('SET ROLE authenticated');
 await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)', ['meter-capture-media', cap.uploadPath]);
 await assert.rejects(db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)', ['meter-capture-media', `${foreignOrg}/profiles/${foreignMeter}/${actor}/${id(900)}`]), { code: '42501' });
 assert.equal((await db.query("DELETE FROM storage.objects WHERE name=$1 RETURNING id", [cap.uploadPath])).rows.length, 0);
 assert.equal((await db.query("UPDATE storage.objects SET name='overwrite' WHERE name=$1 RETURNING id", [cap.uploadPath])).rows.length, 0);
 await db.exec('RESET ROLE'); await db.exec("SELECT set_config('test.access','no',false);SET ROLE authenticated");
 assert.equal((await db.query("SELECT * FROM storage.objects WHERE bucket_id='meter-capture-media'")).rows.length, 0);
 await db.exec('RESET ROLE');
});

test('billing resolver uses exact contract/period and wrapper atomically links sources, rejects stale values and duplicate retry', async t => {
 const db = await fixture(); t.after(() => db.close()); await register(db);
 await confirm(db, (await upload(db, await start(db))).capture);
 const s = await source(db); assert.equal(Number(s.previousReading), 100); assert.equal(Number(s.currentReading), 120);
 const args = invoiceArgs(s);
 await assert.rejects(invoice(db, args, [{ ...s, endVersion: 'stale' }]), { code: 'PT409' });
 assert.equal((await db.query('SELECT count(*)::int n FROM invoices')).rows[0].n, 0);
 const result = await invoice(db, args, [s]);
 assert.deepEqual(await invoice(db, args, [s]), result);
 assert.equal((await db.query('SELECT count(*)::int n FROM invoices')).rows[0].n, 1);
 const link = (await db.query('SELECT source FROM app_private.meter_capture_evidence_links')).rows[0].source;
 assert.equal(link.endReadingId, s.endReadingId); assert.ok(link.endCaptureId);
 assert.deepEqual((await rpc(db, 'documentReceipt', { kind: 'invoice', idempotencyKey: args.p_idempotency_key })).receipt, result);
 assert.equal((await rpc(db, 'documentEvidence', { kind: 'INVOICE', documentId: result.invoice_id })).sources[0].endCaptureId, link.endCaptureId);
 await assert.rejects(invoice(db, { ...args, p_total_amount: 20000 }, [s]), { code: '23505' });
});

test('zero-kWh termination retains existing confirmed reading and evidence without duplicate insert', async t => {
 const db = await fixture(); t.after(() => db.close()); await register(db);
 await confirm(db, (await upload(db, await start(db, { purpose: 'MOVE_OUT' }))).capture, '100');
 const s = await source(db, 'MOVE_OUT');
 const args = { p_organization_id: org, p_contract_id: contract, p_actual_move_out_on: '2026-10-31', p_settlement_mode: 'IMMEDIATE', p_idempotency_key: 'exit-test-001', p_settlement: { extra_charges: [{ kind: 'ELECTRIC', meter_id: meter, amount: 0, unit_price:1, previous_reading: 100, current_reading: 100, meter_source: s }] } };
 await db.query('SELECT meter_capture_exit_v1($1,$2,$3,$4)', [org, 'confirm_contract_return_v1', args, [s]]);
 assert.equal((await db.query('SELECT count(*)::int n FROM meter_readings')).rows[0].n, 1);
 assert.equal((await db.query("SELECT count(*)::int n FROM app_private.meter_capture_evidence_links WHERE document_kind='EXIT'")).rows[0].n, 1);
});

test('legacy billed start does not use this month latest or another tenant reading', async t => {
 const db = await fixture(); t.after(() => db.close()); await register(db);
 await db.exec(`UPDATE contracts SET start_date='2026-09-01';INSERT INTO invoices(id,organization_id,contract_id,building_id,billing_month,issue_date) VALUES('${id(800)}','${org}','${contract}','${building}','2026-09','2026-09-30');
 INSERT INTO invoice_items(invoice_id,service_id,current_reading,to_date) VALUES('${id(800)}','${service}',115,'2026-09-30');`);
 await confirm(db, (await upload(db, await start(db))).capture);
 const s = await source(db); assert.equal(Number(s.previousReading), 115); assert.match(s.startVersion, /^invoice:/);
 await db.exec(`UPDATE contracts SET initial_electricity_reading=9999`);
 assert.equal(Number((await source(db)).previousReading), 115);
});

test('same-month move-out starts at the billed monthly end; evidence failure rolls the invoice back', async t => {
 const db=await fixture();t.after(()=>db.close());await register(db);
 await confirm(db,(await upload(db,await start(db))).capture);const monthly=await source(db);
 await db.exec("ALTER TABLE app_private.meter_capture_evidence_links ADD CONSTRAINT reject_attachment CHECK(document_kind<>'INVOICE')");
 await assert.rejects(invoice(db,invoiceArgs(monthly),[monthly]),{code:'23514'});
 assert.equal((await db.query('SELECT count(*)::int n FROM invoices')).rows[0].n,0);
 await db.exec('ALTER TABLE app_private.meter_capture_evidence_links DROP CONSTRAINT reject_attachment');
 await invoice(db,invoiceArgs(monthly),[monthly]);
 await confirm(db,(await upload(db,await start(db,{clientId:id(101),purpose:'MOVE_OUT',sha256:'c'.repeat(64)}))).capture,'125');
 const end=await source(db,'MOVE_OUT');assert.equal(Number(end.previousReading),120);assert.equal(Number(end.currentReading),125);
});

test('failed video is reviewable but cannot be manually confirmed, and revoked profile invalidates an in-flight capture',async t=>{
 const db=await fixture();t.after(()=>db.close());await register(db);
 const cap=await upload(db,await start(db,{mimeType:'video/mp4',durationSeconds:15}));
 const job=(await db.query("SELECT meter_capture_claim_v1('worker') result")).rows[0].result;
 const engine={status:'error',version:'fixture',value:null,registerCode:null,unit:null,frames:[]};
 await db.query('SELECT meter_capture_complete_v1($1,$2,$3)',[job.jobId,job.leaseToken,{mediaValidated:false,durationSeconds:90,issues:[],identity:{ambiguous:true,qrTokens:[]},server:engine,ai:engine}]);
 const failed=(await rpc(db,'getCapture',{captureId:cap.capture.id})).capture;assert.equal(failed.status,'REVIEW');assert.ok(failed.issues.includes('MEDIA_VALIDATION_FAILED'));
 await assert.rejects(confirm(db,failed),{code:'55000'});
 const photo=await upload(db,await start(db,{clientId:id(102),sha256:'d'.repeat(64)}));
 await db.query('UPDATE meters SET serial_number=$1 WHERE id=$2',['REPLACED',meter]);
 await assert.rejects(confirm(db,photo.capture),{code:'PT409'});
 assert.equal((await rpc(db,'catalog')).meters[0].qrText,null);
});

test('engine failure retries once available, reuses verified frames, and late mismatching result cannot rewrite a confirmed reading',async t=>{
 const db=await fixture();t.after(()=>db.close());await register(db);const cap=await upload(db,await start(db),false);
 const job=(await db.query("SELECT meter_capture_claim_v1('worker') result")).rows[0].result;
 const frameSha='e'.repeat(64),key=`${org}/meter-captures/${cap.capture.id}/evidence/${frameSha}.jpg`;
 await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)',['meter-capture-media',key]);
 await db.query('SELECT meter_capture_evidence_receipt_v1($1,$2,$3,$4,0)',[job.jobId,job.leaseToken,key,frameSha]);
 const engine={status:'ok',version:'fixture',value:'120.00',registerCode:'1.8.0',unit:'kWh',frames:[{timestampSeconds:0,objectKey:key}]};
 const result={mediaValidated:true,issues:[],identity:{ambiguous:false,qrTokens:[job.meter.qrToken]},server:engine,ai:{...engine,status:'error',value:null,frames:[]}};
 await db.query('SELECT meter_capture_complete_v1($1,$2,$3)',[job.jobId,job.leaseToken,result]);
 const done=await confirm(db,(await rpc(db,'getCapture',{captureId:cap.capture.id})).capture);
 assert.equal((await db.query('SELECT count(*)::int n FROM app_private.meter_capture_jobs')).rows[0].n,2);
 await db.exec("UPDATE app_private.meter_capture_jobs SET created_at=clock_timestamp()-interval '1 second' WHERE state='QUEUED'");
 const retry=(await db.query("SELECT meter_capture_claim_v1('worker') result")).rows[0].result;
 await db.query('SELECT meter_capture_evidence_receipt_v1($1,$2,$3,$4,0)',[retry.jobId,retry.leaseToken,key,frameSha]);
 await db.query('SELECT meter_capture_complete_v1($1,$2,$3)',[retry.jobId,retry.leaseToken,{...result,server:{...engine,value:'121.00'},ai:{...engine,value:'121.00'}}]);
 const late=(await rpc(db,'getCapture',{captureId:cap.capture.id})).capture;
 assert.equal(late.status,'CONFIRMED');assert.equal(late.confirmedReadingId,done.capture.confirmedReadingId);assert.equal(Number(late.value),120);assert.ok(late.issues.includes('LATE_READING_REQUIRES_REVIEW'));
 assert.equal((await db.query('SELECT count(*)::int n FROM app_private.meter_capture_results')).rows[0].n,2);
});

test('transfer finalization preserves link CAS arguments and attaches EXIT evidence in the same transaction',async t=>{
 const db=await fixture();t.after(()=>db.close());await register(db);
 await confirm(db,(await upload(db,await start(db,{purpose:'MOVE_OUT'}))).capture);const s=await source(db,'MOVE_OUT');const caseId=id(450),linkId=id(451);
 await db.query("INSERT INTO contract_exit_cases(id,organization_id,contract_id,actual_move_out_on,state) VALUES($1,$2,$3,'2026-10-31','PENDING')",[caseId,org,contract]);
 await db.exec(`CREATE FUNCTION public.finalize_contract_transfer_exit_v1(p_organization_id uuid,p_case_id uuid,p_expected_version bigint,p_idempotency_key text,p_current_kind text,p_reason text,p_settlement jsonb,p_link_id uuid,p_expected_link_version bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
 BEGIN IF p_link_id<>'${linkId}' OR p_expected_link_version<>3 THEN RAISE EXCEPTION 'Link changed' USING ERRCODE='PT409';END IF;
 UPDATE contract_exit_cases SET state='FINALIZED' WHERE id=p_case_id;RETURN jsonb_build_object('id',p_case_id,'state','FINALIZED');END $$;`);
 const args={p_organization_id:org,p_case_id:caseId,p_expected_version:1,p_idempotency_key:'transfer-001',p_current_kind:'EARLY_RETURN',p_reason:null,p_link_id:linkId,p_expected_link_version:3,p_settlement:{extra_charges:[{kind:'ELECTRIC',meter_id:meter,amount:20,unit_price:1,previous_reading:100,current_reading:120,meter_source:s}]}};
 await assert.rejects(db.query('SELECT meter_capture_exit_v1($1,$2,$3,$4)',[org,'finalize_contract_transfer_exit_v1',{...args,p_expected_link_version:2},[s]]),{code:'PT409'});
 await db.query('SELECT meter_capture_exit_v1($1,$2,$3,$4)',[org,'finalize_contract_transfer_exit_v1',args,[s]]);
 assert.equal((await rpc(db,'documentEvidence',{documentId:caseId,kind:'EXIT'})).sources.length,1);
});

test('ordinary and positive-credit invoices choose their real writer branches and reject amounts unrelated to kWh',async t=>{
 const db=await fixture();t.after(()=>db.close());await register(db);
 await confirm(db,(await upload(db,await start(db))).capture);const s=await source(db),args=invoiceArgs(s);
 for(const patch of [{quantity:200,amount:100000},{amount:1},{unit_price:'NaN'},{coefficient:-1}]){
  await assert.rejects(invoice(db,{...args,p_items:[{...args.p_items[0],...patch}]},[s]),{code:'22023'});
 }
 // Only an exact contract service can fill a missing physical-meter service ID.
 await db.query('UPDATE meters SET service_id=NULL WHERE id=$1',[meter]);
 await invoice(db,{...args,p_applied_credit:0,p_non_credit_discount_amount:0},[s]);
 await invoice(db,{...args,p_idempotency_key:'invoice-credit-002',p_applied_credit:10,p_non_credit_discount_amount:0},[s]);
 assert.equal((await db.query('SELECT count(*)::int n FROM invoices')).rows[0].n,2);
 await assert.rejects(db.query('SELECT create_invoice_with_credit_v1($1,$2,$3,$4,$5)',[contract,building,'2026-10',[],'invalid-credit']),{code:'22023'});
});

test('decodable image required for manual confirmation; verified re-registration rotates a revoked QR',async t=>{
 const db=await fixture();t.after(()=>db.close());const before=await register(db);
 const cap=await upload(db,await start(db),false);await assert.rejects(confirm(db,cap.capture),{code:'55000'});
 const job=(await db.query("SELECT meter_capture_claim_v1('validator') result")).rows[0].result;
 const engine={status:'error',version:'fixture',value:null,registerCode:null,unit:null,frames:[]};
 await db.query('SELECT meter_capture_complete_v1($1,$2,$3)',[job.jobId,job.leaseToken,{mediaValidated:false,issues:['media_decoder_failed'],identity:{ambiguous:true,qrTokens:[]},server:engine,ai:engine}]);
 await assert.rejects(confirm(db,(await rpc(db,'getCapture',{captureId:cap.capture.id})).capture),{code:'55000'});
 await rpc(db,'revokeQr',{meterId:meter,expectedVersion:1,reason:'Tem hỏng'});
 const after=await rpc(db,'profile',{meterId:meter,expectedVersion:2,serial:'S1',displayKind:'DIGITAL',decimalPlaces:2,registerCode:'1.8.0',referencePath:profilePath,verified:true});
 assert.match(after.qrText,/^ihome-meter:/);assert.notEqual(after.qrText,before.qrText);
 await assert.rejects(rpc(db,'resolveQr',{qrText:before.qrText}),{code:'42501'});
});

test('abnormal increase is shown before confirmation and requires reason even when both readers agree',async t=>{
 const db=await fixture();t.after(()=>db.close());await register(db);
 await db.exec(`ALTER TABLE meter_readings DISABLE TRIGGER trigger_auto_populate_previous_reading;
 INSERT INTO meter_readings(organization_id,meter_id,contract_id,reading_date,previous_reading,current_reading,status,created_at) VALUES
 ('${org}','${meter}','${contract}','2026-10-01',100,110,'APPROVED','2026-10-01'),('${org}','${meter}','${contract}','2026-10-02',110,120,'APPROVED','2026-10-02'),('${org}','${meter}','${contract}','2026-10-03',120,130,'APPROVED','2026-10-03');
 ALTER TABLE meter_readings ENABLE TRIGGER trigger_auto_populate_previous_reading;`);
 const cap=await upload(db,await start(db),false);const job=(await db.query("SELECT meter_capture_claim_v1('validator') result")).rows[0].result;
 const hash='f'.repeat(64),key=`${org}/meter-captures/${cap.capture.id}/evidence/${hash}.jpg`;
 await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)',['meter-capture-media',key]);
 await db.query('SELECT meter_capture_evidence_receipt_v1($1,$2,$3,$4,0)',[job.jobId,job.leaseToken,key,hash]);
 const engine={status:'ok',version:'fixture',value:'500.00',registerCode:'1.8.0',unit:'kWh',frames:[{timestampSeconds:0,objectKey:key}]};
 await db.query('SELECT meter_capture_complete_v1($1,$2,$3)',[job.jobId,job.leaseToken,{mediaValidated:true,issues:[],identity:{ambiguous:false,qrTokens:[job.meter.qrToken]},server:engine,ai:engine}]);
 const ready=(await rpc(db,'getCapture',{captureId:cap.capture.id})).capture;assert.ok(ready.issues.includes('ABNORMAL_INCREASE'));
 await assert.rejects(rpc(db,'confirmCapture',{captureId:ready.id,expectedVersion:ready.version,value:'500.00'}),{code:'22023'});
 assert.equal((await confirm(db,ready,'500.00','Đã đối chiếu mức tăng do khách dùng máy lạnh')).capture.status,'CONFIRMED');
});

test('finalized exit exposes its immutable source on the exact settlement invoice, never another contract invoice',async t=>{
 const db=await fixture();t.after(()=>db.close());await register(db);
 await confirm(db,(await upload(db,await start(db,{purpose:'MOVE_OUT'}))).capture);const s=await source(db,'MOVE_OUT');
 await db.exec(`CREATE OR REPLACE FUNCTION public.confirm_contract_return_v1(p_organization_id uuid,p_contract_id uuid,p_actual_move_out_on date,p_settlement_mode text,p_settlement jsonb,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
 DECLARE v_invoice uuid;v_case uuid;BEGIN
 INSERT INTO invoices(organization_id,contract_id,building_id,billing_month,issue_date) VALUES(p_organization_id,p_contract_id,'${building}','2026-10',p_actual_move_out_on) RETURNING id INTO v_invoice;
 INSERT INTO contract_exit_cases(organization_id,contract_id,actual_move_out_on,state,settlement_result) VALUES(p_organization_id,p_contract_id,p_actual_move_out_on,'FINALIZED',jsonb_build_object('termination',jsonb_build_object('settlement_invoice_id',v_invoice))) RETURNING id INTO v_case;
 RETURN jsonb_build_object('id',v_case,'state','FINALIZED');END $$;`);
 const args={p_organization_id:org,p_contract_id:contract,p_actual_move_out_on:'2026-10-31',p_settlement_mode:'IMMEDIATE',p_idempotency_key:'exit-evidence-1',p_settlement:{extra_charges:[{kind:'ELECTRIC',meter_id:meter,unit_price:1,amount:20,previous_reading:100,current_reading:120,meter_source:s}]}};
 await db.query('SELECT meter_capture_exit_v1($1,$2,$3,$4)',[org,'confirm_contract_return_v1',args,[s]]);
 const inv=(await db.query('SELECT id FROM invoices')).rows[0].id;
 const sources=(await rpc(db,'documentEvidence',{documentId:inv,kind:'INVOICE'})).sources;assert.equal(sources.length,1);assert.equal(sources[0].meterId,meter);
});

test('exhausted worker lease exposes review issue and preserves an already confirmed value',async t=>{
 const db=await fixture();t.after(()=>db.close());await register(db);
 const pending=await upload(db,await start(db),false);
 await db.query("SELECT meter_capture_claim_v1('worker')");
 await db.exec("UPDATE app_private.meter_capture_jobs SET attempts=3,lease_until=clock_timestamp()-interval '1 second' WHERE state='RUNNING'");
 assert.equal((await db.query("SELECT meter_capture_claim_v1('worker') result")).rows[0].result,null);
 const reviewed=(await rpc(db,'getCapture',{captureId:pending.capture.id})).capture;
 assert.equal(reviewed.status,'REVIEW');assert.ok(reviewed.issues.includes('WORKER_LEASE_EXHAUSTED'));
 const saved=await confirm(db,(await upload(db,await start(db,{clientId:id(195),sha256:'9'.repeat(64)}))).capture);
 await db.query("INSERT INTO app_private.meter_capture_jobs(capture_id,generation,state,attempts,lease_until) VALUES($1,2,'RUNNING',3,clock_timestamp()-interval '1 second')",[saved.capture.id]);
 assert.equal((await db.query("SELECT meter_capture_claim_v1('worker') result")).rows[0].result,null);
 const confirmed=(await rpc(db,'getCapture',{captureId:saved.capture.id})).capture;
 assert.equal(confirmed.status,'CONFIRMED');assert.equal(confirmed.confirmedReadingId,saved.capture.confirmedReadingId);assert.equal(confirmed.value,saved.capture.value);
 assert.ok(confirmed.issues.includes('WORKER_LEASE_EXHAUSTED'));
});

test('mutation sentinels detect missing original validation and removed source CAS without changing migration file', async t => {
 const digest = value => createHash('sha256').update(value).digest('hex'); const before = digest(sql);
 const mutations = [
  ['original receipt', "IF NOT c.media_received OR NOT c.media_validated THEN", 'IF false THEN', async db => {
   await register(db); const cap = await start(db); await assert.rejects(confirm(db, cap.capture), { code: '55000' });
  }],
  ['source CAS', "v_match#>>'{end,version}' IS DISTINCT FROM s->>'endVersion'", 'false', async db => {
   await register(db); await confirm(db, (await upload(db, await start(db))).capture); const s = await source(db);
   const stale={...s,endVersion:'stale'};await assert.rejects(invoice(db, invoiceArgs(stale), [stale]), { code: 'PT409' });
  }],
  ['organization boundary', "OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false)", 'OR false', async db => {
   await assert.rejects(rpc(db,'catalog',{},foreignOrg),{code:'42501'});
  }],
 ];
 for (const [name, needle, replacement, probe] of mutations) {
  assert.ok(sql.includes(needle), `mutation target exists: ${name}`);
  const db = await fixture(sql.replace(needle, replacement));
  try { await assert.rejects(probe(db), { code: 'ERR_ASSERTION' }, `detector must fail for ${name}`); } finally { await db.close(); }
 }
 assert.equal(digest(readFileSync(path, 'utf8')), before);
});

test('confirmed clip evidence remains pinned when a retry uploads earlier timestamps with another value', async t => {
 const db=await fixture();t.after(()=>db.close());await register(db);
 const cap=await upload(db,await start(db,{mimeType:'video/mp4',durationSeconds:10}),false);
 const finish=async (job,times,value,retry=false) => {
  const frames=[];
  for(const timestamp of times){
   const digest=createHash('sha256').update(`${job.jobId}:${timestamp}`).digest('hex');
   const key=`${org}/meter-captures/${cap.capture.id}/evidence/${digest}.jpg`;
   await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)',['meter-capture-media',key]);
   await db.query('SELECT meter_capture_evidence_receipt_v1($1,$2,$3,$4,$5)',[job.jobId,job.leaseToken,key,digest,timestamp]);
   frames.push({timestampSeconds:timestamp,objectKey:key});
  }
  const engine={status:'ok',version:'fixture',value,registerCode:'1.8.0',unit:'kWh',frames};
  await db.query('SELECT meter_capture_complete_v1($1,$2,$3)',[job.jobId,job.leaseToken,{mediaValidated:true,durationSeconds:10,issues:[],identity:{ambiguous:false,qrTokens:[job.meter.qrToken]},server:engine,ai:retry?{...engine,status:'error',value:null,frames:[]}:engine}]);
  return frames;
 };
 const first=(await db.query("SELECT meter_capture_claim_v1('worker') result")).rows[0].result;
 const approvedFrames=await finish(first,[2,4],'120.00',true);
 await confirm(db,(await rpc(db,'getCapture',{captureId:cap.capture.id})).capture);
 const before=(await rpc(db,'evidence',{captureId:cap.capture.id})).evidence;
 assert.equal(before.imageObjectKey,approvedFrames[0].objectKey);
 await db.exec("UPDATE app_private.meter_capture_jobs SET created_at=clock_timestamp()-interval '1 second' WHERE state='QUEUED'");
 const retry=(await db.query("SELECT meter_capture_claim_v1('worker') result")).rows[0].result;
 await finish(retry,[0,1],'121.00');
 const after=(await rpc(db,'evidence',{captureId:cap.capture.id})).evidence;
 assert.deepEqual(after,before);
 const frozen=(await rpc(db,'getCapture',{captureId:cap.capture.id})).capture;
 assert.equal(frozen.serverResult.value,'120.00');
 assert.equal(frozen.imageObjectKey,approvedFrames[0].objectKey);
 assert.ok(frozen.issues.includes('LATE_READING_REQUIRES_REVIEW'));
});
