#!/usr/bin/env node
// Real SET ROLE/RLS measurement on guarded TEST. All policy mutants live in ROLLBACK only.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { credential, ketNoi, batBuocDichTest, psql, psqlJson, lit } from './test-env/lib.mjs';
import { sqlDoOwnerPersonal, kiemDoOwnerPersonal, phanLoaiDongNull } from './measure-org-leak.mjs';

const cred = credential(), { test } = await ketNoi(cred);
await batBuocDichTest(cred,test);
const url = `https://${cred.testRef}.supabase.co`, ids = [];
const headers = { apikey: cred.testSecretKey, Authorization: `Bearer ${cred.testSecretKey}`, 'Content-Type': 'application/json' };
const orgs = ['aaaa0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000001'];
let checks = 0;
async function createActor() {
 const r = await fetch(`${url}/auth/v1/admin/users`,{method:'POST',headers,body:JSON.stringify({email:`owner-null-${randomUUID()}@example.invalid`,password:randomBytes(24).toString('base64url'),email_confirm:true})});
 assert.equal(r.status,200,'fixture account creation'); const user = await r.json(); assert(user.id); ids.push(user.id); return user.id;
}
function measure(uids, mutant = '') {
 let sql = sqlDoOwnerPersonal(uids);
 if (mutant) sql = sql.replace('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', `BEGIN ISOLATION LEVEL REPEATABLE READ;\n${mutant}\nSET LOCAL transaction_read_only=on;`);
 const { stdout } = psql(test, `\\pset tuples_only on\n\\pset format unaligned\n${sql}`, { timeoutMs:45000 });
 return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
try {
 const ownerA = await createActor(), ownerB = await createActor(), admin = await createActor();
 psql(test, `BEGIN;SET LOCAL session_replication_role=replica;
 INSERT INTO public.organization_memberships(user_id,organization_id,member_type,status) VALUES(${lit(ownerA)},${lit(orgs[0])},'STAFF','ACTIVE'),(${lit(ownerB)},${lit(orgs[1])},'STAFF','ACTIVE'),(${lit(admin)},${lit(orgs[0])},'OWNER','ACTIVE');
 INSERT INTO public.super_admins(user_id,organization_id,note) VALUES(${lit(admin)},${lit(orgs[0])},'disposable owner NULL probe');
 INSERT INTO public.personal_transactions(user_id,type,amount,txn_date,organization_id,description)
 VALUES ${[ownerA,ownerB].flatMap((id,i) => ['NULL',lit(orgs[i])].map(org => `(${lit(id)},'EXPENSE',1,'2026-10-05',${org},'disposable owner NULL gate')`)).join(',')};
 COMMIT;`);
 const uids = psqlJson(test,'SELECT id::text uid FROM auth.users ORDER BY id').map(u => u.uid);
 let base;
 check('actual role probe: two owners NULL/non-NULL, admin/orphan isolated, positive controls exact', () => {
  base=measure(uids); const result=kiemDoOwnerPersonal(base); assert(result.dat,JSON.stringify(result));
  assert(base.truth.null_total>=2); assert(base.truth.total>=4);
  for(const id of [ownerA,ownerB]) {const row=base.actors.find(a => a.uid===id); assert.equal(row.own_null,1); assert.equal(row.own_total,2);}
  assert.equal(base.actors.find(a => a.uid===admin).foreign_total,0);
  const classified=phanLoaiDongNull([{bang:'personal_transactions',so_dong_null:base.truth.null_total,da_khai:false},{bang:'unrelated_undeclared',so_dong_null:1,da_khai:false}],base);
  assert.equal(classified.actorOwned.length,1); assert.equal(classified.tongChuaKhai,1);
  console.log(`MEASURE ${result.actors} actors, ${result.total} rows/${result.nullTotal} NULL, ${Math.round(base.elapsed_ms)}ms`);
 });
 for(const [name,using] of [['NULL leak','organization_id IS NULL'],['non-NULL leak','organization_id IS NOT NULL'],['admin bypass','public.is_super_admin()']]) {
  check(`TEST RLS mutant ${name} detected; rollback`, () => {
   const proof=measure(uids,`CREATE POLICY zz_owner_null_probe ON public.personal_transactions FOR SELECT TO authenticated USING (${using});`);
   const result=kiemDoOwnerPersonal(proof); assert.equal(result.ro,true,`OWNER LEAK MUST BE DETECTED: ${name}`); assert.equal(result.dat,false);
   if(name==='admin bypass') assert(proof.actors.find(a => a.uid===admin).foreign_total>=4,'admin bypass foreign rows must be nonempty');
   if(name==='NULL leak') assert(proof.actors.some(a => a.foreign_null>0),'NULL foreign witness required');
  });
 }
 for(const [name,ddl] of [
  ['deny-all positive control', 'CREATE POLICY zz_owner_null_probe ON public.personal_transactions AS RESTRICTIVE FOR SELECT TO authenticated USING (false);'],
  ['missing exemption', "DELETE FROM app_private.org_boundary_exemptions WHERE table_name='personal_transactions';"],
  ['expired exemption', "UPDATE app_private.org_boundary_exemptions SET expires_at=current_date-1 WHERE table_name='personal_transactions';"],
  ['missing owner policy', 'DROP POLICY personal_txn_own ON public.personal_transactions;'],
  ['disabled RLS', 'ALTER TABLE public.personal_transactions DISABLE ROW LEVEL SECURITY;'],
 ]) check(`fail closed ${name}; rollback`, () => { const result=kiemDoOwnerPersonal(measure(uids,ddl)); assert.equal(result.dat,false,`FAIL CLOSED: ${name}`); assert(result.loi.length>0,`FAIL CLOSED: ${name}`); });
 check('query error / missing owner column throws, never produces a zero-count proof', () => {
  assert.throws(() => measure(uids,'ALTER TABLE public.personal_transactions RENAME COLUMN user_id TO zz_owner_probe;'),/user_id|owner|column/i);
 });
 check('all TEST mutations rolled back; original probe still passes', () => assert(kiemDoOwnerPersonal(measure(uids)).dat));
 console.log(`OWNER NULL GATE: ${checks} real SQL cases PASS`);
} finally {
 if(ids.length) {
  const values=ids.map(lit).join(',');
  psql(test,`BEGIN;SET LOCAL session_replication_role=replica;DELETE FROM public.personal_transactions WHERE user_id IN (${values});DELETE FROM public.organization_memberships WHERE user_id IN (${values});DELETE FROM public.super_admins WHERE user_id IN (${values});COMMIT;`);
  for(const id of ids) {const r=await fetch(`${url}/auth/v1/admin/users/${id}`,{method:'DELETE',headers});assert(r.ok,'fixture account cleanup');}
  assert.equal(psqlJson(test,`SELECT count(*)::int n FROM public.personal_transactions WHERE user_id IN (${values})`)[0].n,0);
  console.log(`CLEANUP ${ids.length} fixture accounts and 4 fixture rows`);
 }
}
