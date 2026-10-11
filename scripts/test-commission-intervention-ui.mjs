#!/usr/bin/env node
// Focused browser coverage against an isolated TEST actor and exact fixtures.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import { testConnection, signInTest, request } from './test-voucher-detail-read-authz.mjs';
import { matKhauTest } from './test-env/hau-ky.mjs';
import { sourceIdentity } from './test-env/check.mjs';
import { chromeBuildEnv, serveChromeBuild, networkAllowed, sanitizeChromeEvidence } from './test-env/chrome.mjs';
import { repoRoot } from './test-env/lib.mjs';
import { assertTestLease, withTestLock, markTestCleanupRequired, withTestCleanup } from './test-env/lock.mjs';
import { createScopedActor, assertScopedActor } from './lib/commission-e2e-scoped-actor.mjs';
import { createNavigationReadGuard } from './lib/commission-e2e-network.mjs';

const exec = promisify(execFile);
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const MARKER = `E2E-HH-AUDIT-${Date.now()}`;
const contractId = randomUUID();
const reportDir = join(homedir(), 'ihomecrm-backups', 'commission-intervention-ui', MARKER);
const report = { status: 'FAIL', checks: [], consoleErrors: [], pageErrors: [], httpErrors: [], networkErrors: [],
  blockedRequests: [], cancelledReads: [], completedHeaderReads: [], expectedFallbacks: [], expectedFallbackConsole: [], screenshots: [], cleanup: false };
await mkdir(reportDir, { recursive: true });
const connection = await testConnection();
assert.equal(connection.cred.testRef, 'hzulujxgonszuleqticb');
const secrets = Object.values(connection.cred).filter(value => typeof value === 'string');
let browser, server, page, scopedActor, db, session, existingTypes = [], navigation, originalAuditGuards, closingBrowser=false;
const pendingWrites = new Set(), uncertainWrites = new Set();
const responseStatuses = new WeakMap();
const requestIds = new WeakMap(), responseInspections = new Set(), completedRequests = new Set();
const fallbackCandidates = [], consoleMessages = [], matchedConsoleRequests = new Set(), cancelReceipts = [];
let requestSequence=0, consoleCursor=0, cancellationTarget;
const writeNames = new Set(['prepare_commission_requests_v1','execute_commission_request_v1',
  'revise_pending_income_expense_v1','intervene_commission_v1','cancel_income_expense_v1',
  'cancel_income_expense_flex_v1','cancel_unposted_income_expense_v2','ie_compat_cancel_v2',
  'set_termination_forfeit_status_v1','log_income_expense_action']);
// These are the three explicit routing signals in useCancelIncomeExpense, not
// permission/server failures to ignore. Each still needs the final exact receipt.
const expectedCancelFallbacks = new Map([
  ['set_termination_forfeit_status_v1',{status:500,code:'55000',message:'Voucher is not a termination forfeit pair'}],
  ['cancel_income_expense_flex_v1',{status:403,code:'42501',message:'[NOT_MANUAL] Phiếu do hệ thống sinh (contract.commission) — xử lý ở luồng nguồn.'}],
  ['cancel_income_expense_v1',{status:500,code:'55000',message:'Phiếu chưa thuộc luồng canonical — dùng đường legacy'}],
]);
const inspectResponse = async res => {
  const req=res.request(), url=new URL(res.url()), name=url.pathname.split('/').pop(), status=res.status();
  const requestId=requestIds.get(req);
  responseStatuses.set(req,status);
  if(status>=500 && pendingWrites.has(req))uncertainWrites.add(req);
  if(status<400 && name!=='ie_compat_cancel_v2')return;
  let body;
  try { body=await res.json(); } catch { body={unreadable:true}; }
  const record={requestId,url:res.url(),path:url.pathname,method:req.method(),status,body};
  let payload;
  try { payload=req.postDataJSON(); } catch { payload=null; }
  const expected=expectedCancelFallbacks.get(name);
  const exactTarget=cancellationTarget && (name==='cancel_income_expense_flex_v1'
    ? payload?.p_voucher===cancellationTarget.id && payload?.p_reason===cancellationTarget.reason
    : payload?.p_voucher_id===cancellationTarget.id && (name==='set_termination_forfeit_status_v1'
      ? payload?.p_status==='CANCELLED' : payload?.p_reason===cancellationTarget.reason));
  if(expected && requestId && exactTarget && req.method()==='POST' && url.origin===connection.url && url.pathname===`/rest/v1/rpc/${name}`
    && status===expected.status && body.code===expected.code && body.message===expected.message) {
    fallbackCandidates.push({...record,payload,request:req}); return;
  }
  if(status>=400) { report.httpErrors.push(record); return; }
  if(name==='ie_compat_cancel_v2' && requestId && cancellationTarget && status===200 && req.method()==='POST'
    && url.origin===connection.url && url.pathname==='/rest/v1/rpc/ie_compat_cancel_v2'
    && JSON.stringify(payload?.p_ids)===JSON.stringify([cancellationTarget.id]) && payload?.p_reason===cancellationTarget.reason && body?.cancelled===1)
    cancelReceipts.push({...record,payload,request:req});
};
const drainResponseInspections = async () => { while(responseInspections.size)await Promise.all([...responseInspections]); };
const classifyConsoleMessages = () => {
  for(;consoleCursor<consoleMessages.length;consoleCursor++) {
    const message=consoleMessages[consoleCursor];
    const status=/^Failed to load resource: the server responded with a status of (500|403) \(\)$/.exec(message.text)?.[1];
    const evidence=report.expectedFallbacks.find(row=>row.url===message.url && row.status===Number(status) && !matchedConsoleRequests.has(row.requestId));
    if(evidence) { matchedConsoleRequests.add(evidence.requestId);report.expectedFallbackConsole.push({...message,requestId:evidence.requestId,status:evidence.status}); }
    else report.consoleErrors.push(message);
  }
};
const seenWrites = [];
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const snapshot = async name => {
  const path = join(reportDir, `${name}.png`); await page.screenshot({path, fullPage:false}); report.screenshots.push(path);
};
const settle = async () => page.waitForLoadState('networkidle', {timeout:45000});
const go = async path => {
  await settle(); navigation.snapshot('navigate');
  await page.evaluate(next => { history.pushState({}, '', next); dispatchEvent(new PopStateEvent('popstate')); }, path);
};
const call = async (name, body) => {
  const result = await request(connection, session.access_token, `rpc/${name}`, body);
  assert.equal(result.status, 200, `RPC ${name}: HTTP ${result.status}, code ${result.json?.code ?? '-'}`);
  return result.json;
};
const history = voucherId => call('read_commission_interventions_v1', {p_voucher_id:voucherId});
const assertAudit = async (voucherId, stage, reason) => {
  const rows = await history(voucherId);
  assert(Array.isArray(rows), 'audit reader must return rows');
  const row = rows.find(value => value.stage === stage && value.reason === reason);
  assert(row, `audit stage ${stage} with exact user reason`);
  assert.equal(row.actor_id, session.user.id); assert(row.actor_name); assert(Number.isFinite(Date.parse(row.at)));
  assert(row.after || row.baseline, 'audit has after/baseline snapshot');
  return rows.filter(value => value.stage === stage && value.reason === reason);
};
const clean = async lease => {
  await assertTestLease(lease, connection.test);
  assert.equal(pendingWrites.size,0,'wait for all browser writers before cleanup');
  assert.equal(uncertainWrites.size,0,'ambiguous writer requires manual reconciliation; retain TEST lease');
  await db.query('rollback'); await db.query('begin'); await db.query('set local session_replication_role=replica');
  const voucherIds = (await db.query('select id from public.income_expenses where contract_id=$1',[contractId])).rows.map(row=>row.id);
  const newTypes = (await db.query(`select distinct t.id from public.income_expense_types t where not(t.id=any($1::uuid[]))
    and (t.user_id=$2 or exists(select 1 from public.income_expense_items i where i.income_expense_type_id=t.id and i.income_expense_id=any($3::uuid[])))`,
    [existingTypes,scopedActor?.id??null,voucherIds])).rows.map(row=>row.id);
  assert.equal((await db.query('select count(*)::int n from public.income_expense_items where income_expense_type_id=any($1::uuid[]) and not(income_expense_id=any($2::uuid[]))',[newTypes,voucherIds])).rows[0].n,0);
  const accountIds = scopedActor ? (await db.query('select id from public.accounts where user_id=$1',[scopedActor.id])).rows.map(row=>row.id) : [];
  const overrideIds = scopedActor ? (await db.query('select id from public.member_permission_overrides where membership_id=$1',[scopedActor.membershipId])).rows.map(row=>row.id) : [];
  const ids = [contractId,...voucherIds,...newTypes,...accountIds,...overrideIds,...(scopedActor?[scopedActor.id,scopedActor.membershipId,scopedActor.accountId]:[])];
  assert(!ids.includes(ORG), 'cleanup identities cannot include shared organization');
  const targets = (await db.query(`select n.nspname,c.relname,array_agg(a.attname::text) cols from pg_class c
    join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
    where n.nspname in ('public','app_private') and c.relkind in ('r','p') and not c.relispartition
    and (n.nspname,c.relname) not in (('public','income_expense_audit_log'),('app_private','commission_intervention_events'),
      ('app_private','income_expense_flow_ownership_events'),('app_private','income_expense_audit_chain_heads'))
    and a.attnum>0 and not a.attisdropped and a.atttypid='uuid'::regtype group by n.nspname,c.relname`)).rows;
  const quote = value => `"${value.replaceAll('"','""')}"`;
  for(const target of targets) await db.query(`delete from ${quote(target.nspname)}.${quote(target.relname)} where ${target.cols.map(col=>`${quote(col)}=any($1::uuid[])`).join(' or ')}`,[ids]);
  for(const target of targets) assert.equal((await db.query(`select count(*)::int n from ${quote(target.nspname)}.${quote(target.relname)} where ${target.cols.map(col=>`${quote(col)}=any($1::uuid[])`).join(' or ')}`,[ids])).rows[0].n,0);
  report.retainedAudit=(await db.query(`select 'income_expense_audit_log' as table_name,count(*)::int as rows from public.income_expense_audit_log where income_expense_id=any($1::uuid[])
    union all select 'commission_intervention_events',count(*)::int from app_private.commission_intervention_events where voucher_id=any($1::uuid[])`,[voucherIds])).rows;
  assert.deepEqual((await db.query("select tgname,tgenabled from pg_trigger where tgrelid='public.income_expense_audit_log'::regclass and not tgisinternal order by tgname")).rows,originalAuditGuards,'audit guards remain unchanged');
  await db.query('commit');
  if(scopedActor) {
    const deleted = await fetch(`${connection.url}/auth/v1/admin/users/${scopedActor.id}`, {method:'DELETE',headers:{apikey:connection.cred.testSecretKey,Authorization:`Bearer ${connection.cred.testSecretKey}`}});
    assert.equal(deleted.status,200,'delete exact isolated TEST auth user');
  }
  report.cleanup=true; report.cleaned={contracts:1,vouchers:voucherIds.length,types:newTypes.length,actor:!!scopedActor};
};

try {
  await withTestLock(connection, async lease => {
    const source = sourceIdentity(); report.source=source;
    const buildDir = join(reportDir,'build');
    const env = chromeBuildEnv(connection.cred,source.sha);
    for (const script of ['scripts/qr/build-wechat-wasm.mjs','scripts/ocr/build-assets.mjs']) {
      await exec(process.execPath,[join(repoRoot,script)],{cwd:repoRoot,env,windowsHide:true,timeout:240000,maxBuffer:8*1024*1024,signal:lease.signal});
    }
    await exec(process.execPath,[join(repoRoot,'node_modules/vite/bin/vite.js'),'build','--outDir',buildDir,'--emptyOutDir'],
      {cwd:repoRoot,env,windowsHide:true,timeout:240000,maxBuffer:8*1024*1024,signal:lease.signal});
    assert.equal(sourceIdentity().digest,source.digest,'source changed during browser build');
    const html = await readFile(join(buildDir,'index.html'),'utf8');
    assert(html.includes(`name="build-sha" content="${source.sha}"`));
    report.indexSha256=createHash('sha256').update(html).digest('hex');
    server=await serveChromeBuild(buildDir,connection.url); report.base=server.origin;
    check('current TEST build SHA and source digest');
    db=new pg.Client({host:connection.cred.testPoolerHost,port:5432,user:`postgres.${connection.cred.testRef}`,
      password:connection.cred.testDbPassword,database:'postgres',ssl:{rejectUnauthorized:false}});
    await db.connect();
    assert.equal((await db.query('select ref from test_env.danh_dau limit 1')).rows[0]?.ref,connection.cred.testRef);
    originalAuditGuards=(await db.query("select tgname,tgenabled from pg_trigger where tgrelid='public.income_expense_audit_log'::regclass and not tgisinternal order by tgname")).rows;
    const ownerRow=(await db.query(`select u.email,u.id from public.organization_memberships m join auth.users u on u.id=m.user_id
      where m.organization_id=$1 and m.member_type='OWNER' and m.status='ACTIVE' and u.email is not null order by m.id limit 1`,[ORG])).rows[0];
    assert(ownerRow,'TEST clone requires existing organization owner'); secrets.push(ownerRow.email);
    const owner=await signInTest(connection,ownerRow.email,matKhauTest(connection.cred.passwordSeed,ownerRow.email));
    const scope=await request(connection,owner.access_token,'rpc/list_contract_commission_followups_v2',{p_organization_id:ORG,p_unresolved_only:false,p_limit:100});
    assert.equal(scope.status,200); const seed=scope.json.rows.find(row=>row.can_manage); assert(seed,'accessible source contract');
    existingTypes=(await db.query('select id from public.income_expense_types')).rows.map(row=>row.id);
    markTestCleanupRequired(lease,connection.test);
    try {
      session=await createScopedActor({ctx:connection,db,organizationId:ORG,buildingId:seed.building_id,ownerId:owner.user.id,marker:MARKER,record:actor=>{scopedActor=actor;}});
      const authorizationScope=(await db.query("select id from public.authorization_scopes where organization_id=$1 and scope_type='BUILDING' and building_id=$2",[ORG,seed.building_id])).rows[0];
      await db.query(`with added as (insert into public.member_permission_overrides(organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode)
        select $1,$2,permission,'ALLOW',$3,$4,'SCOPED' from unnest(array['income_expenses.edit','income_expenses.approve','income_expenses.cancel']) permission returning id)
        insert into public.member_override_scopes(organization_id,override_id,scope_id) select $1,id,$5 from added`,[ORG,scopedActor.membershipId,MARKER,owner.user.id,authorizationScope.id]);
      await db.query('begin'); await db.query('set local session_replication_role=replica');
      await db.query(`insert into public.contracts(id,user_id,room_id,organization_id,status,signed_date,start_date,end_date,rent_price,public_code,contract_number)
        select $1,$2,room_id,organization_id,'TERMINATED',current_date,current_date,current_date+365,2000000,$3,$3 from public.contracts where id=$4`,
        [contractId,session.user.id,MARKER,seed.contract_id]);
      await db.query('commit');
      report.scopeProof=await assertScopedActor({ctx:connection,db,session,organizationId:ORG,buildingId:seed.building_id,fixtureContractId:contractId});
      report.scopeProof.extraScopedPermissions=['income_expenses.edit','income_expenses.approve','income_expenses.cancel'];
      check('scoped STAFF JWT: fixture visible, other building blocked');
      browser=await chromium.launch({channel:'chrome',headless:true});
      const context=await browser.newContext({viewport:{width:1440,height:1000}});
      await context.route('**/*',route=>{
        if(networkAllowed(route.request().url(),{localOrigin:server.origin,testOrigin:connection.url}))return route.continue();
        report.blockedRequests.push(new URL(route.request().url()).origin);return route.abort('blockedbyclient');
      });
      await context.addInitScript(({org,key,auth})=>{localStorage.setItem('ihomecrm.selectedOrganizationId',org);localStorage.setItem(key,JSON.stringify(auth));},
        {org:ORG,key:`sb-${connection.cred.testRef}-auth-token`,auth:session});
      page=await context.newPage(); page.setDefaultTimeout(30000);
      navigation=createNavigationReadGuard({appOrigin:server.origin,testOrigin:connection.url});
      page.on('request',req=>{navigation.started(req);if(writeNames.has(new URL(req.url()).pathname.split('/').pop())){requestIds.set(req,++requestSequence);pendingWrites.add(req);seenWrites.push(req);}});
      page.on('requestfinished',req=>{navigation.finished(req);pendingWrites.delete(req);completedRequests.add(req);});
      page.on('requestfailed',req=>{navigation.finished(req);if(pendingWrites.delete(req))uncertainWrites.add(req);
        const url=new URL(req.url()),failure=req.failure()?.errorText;
        const cancelled=navigation.cancelled(req,failure);
        if(cancelled)report.cancelledReads.push(cancelled);
        else if(failure==='net::ERR_ABORTED' && req.method()==='HEAD' && url.origin===connection.url && url.pathname==='/rest/v1/notifications' && responseStatuses.get(req)===200)
          report.completedHeaderReads.push({path:url.pathname,method:req.method(),responseStatus:200,failure,reason:'HEAD received HTTP 200 before Chromium reported body cancellation'});
        else if(closingBrowser && failure==='net::ERR_ABORTED' && req.method()==='GET' && url.origin===connection.url && url.pathname.startsWith('/rest/v1/') && !url.pathname.includes('/rpc/'))
          report.cancelledReads.push({boundary:'confirmed-browser-close',path:url.pathname,method:req.method(),failure});
        else report.networkErrors.push({path:url.pathname,error:failure,method:req.method(),responseStatus:responseStatuses.get(req),pagePath:new URL(page.url()).pathname,phase:closingBrowser?'closing':'running'});});
      page.on('response',res=>{const task=inspectResponse(res).catch(error=>report.httpErrors.push({path:new URL(res.url()).pathname,status:res.status(),inspectionError:error.message}));responseInspections.add(task);void task.finally(()=>responseInspections.delete(task));});
      page.on('console',msg=>{if(msg.type()==='error')consoleMessages.push({text:msg.text(),...msg.location()});});
      page.on('pageerror',error=>report.pageErrors.push(error.message));
      await page.goto(`${server.origin}/contracts/${contractId}`);
      const detail=page.getByLabel('Tạo hoa hồng và thưởng Sale');
      await detail.getByRole('button',{name:'Tạo phiếu hoa hồng'}).click();
      const create=page.getByRole('dialog',{name:'Tạo phiếu chi hoa hồng'});
      await create.getByLabel('Số tiền hoa hồng',{exact:true}).fill('123456');
      await create.getByLabel('Số tiền hoa hồng',{exact:true}).blur();
      const writesBefore=seenWrites.length;
      await create.getByRole('button',{name:'Tạo phiếu chi',exact:true}).click();
      await expect(create.getByLabel('Lý do điều chỉnh hoa hồng *')).toHaveAttribute('aria-invalid','true');
      assert.equal(seenWrites.length,writesBefore,'blank override reason must not call a writer');
      check('creation override blank reason blocked before request');
      const creationReason='Điều chỉnh theo thoả thuận kiểm thử riêng';
      await create.getByLabel('Lý do điều chỉnh hoa hồng *').fill(creationReason);
      await create.getByRole('button',{name:'Tạo phiếu chi',exact:true}).click();
      let voucher;
      await expect.poll(async()=>{voucher=(await db.query("select id,code,name,approval_version from public.income_expenses where contract_id=$1 and commission_kind='broker' and deleted_at is null",[contractId])).rows[0];return !!voucher;},{timeout:45000}).toBe(true);
      await assertAudit(voucher.id,'CREATE',creationReason); check('created override retains exact reason, actor, time, baseline');
      if(await create.isVisible())await create.getByRole('button',{name:/Để xử lý sau|Đóng/}).first().click();
      await go('/income-expense?layer=PENDING&approval_status=UNAPPROVED');
      await page.getByPlaceholder('Tìm mã phòng, tên/mã phiếu hoặc số tiền (±5.000đ)...').fill(voucher.code);
      let row=page.getByRole('row').filter({hasText:voucher.name}); await expect(row).toHaveCount(1);
      await row.getByTitle('Sửa phiếu chờ duyệt').click();
      const form=page.getByRole('dialog').filter({has:page.getByTestId('ie-form-save')});
      await form.getByLabel('Tên phiếu chi *').fill(`${MARKER}-edited`);
      await form.getByTestId('ie-form-save').click();
      await expect(form.getByTestId('revision-reason')).toHaveAttribute('aria-invalid','true');
      const editReason='Sửa tên phiếu để đối chiếu thoả thuận';
      await form.getByTestId('revision-reason').fill(editReason); await form.getByTestId('ie-form-save').click();
      await expect(form).toHaveCount(0);
      const editAudit=await assertAudit(voucher.id,'EDIT_PENDING',editReason);
      assert(editAudit.some(event=>event.before?.name!==event.after?.name && event.after?.name===`${MARKER}-edited`),'pending rename audit retains changed before/after');
      check('pending rename requires user reason and audited before/after');
      row=page.getByRole('row').filter({hasText:`${MARKER}-edited`}); await expect(row).toHaveCount(1);
      await row.getByTitle('Xem chi tiết').click();
      await page.getByTestId('ie-assign-commission-manager').click();
      const assign=page.getByRole('dialog',{name:'Gán quản lý nhận hoa hồng'});
      await assign.getByRole('combobox',{name:'Chọn quản lý nhận hoa hồng'}).click();
      await page.getByRole('option').first().click();
      await expect(assign.getByRole('button',{name:'Gán quản lý',exact:true})).toBeDisabled();
      const assignReason='Chuyển hoa hồng kiểm thử sang kỳ lương';
      await assign.getByLabel(/Lý do gán hoặc đổi quản lý/).fill(assignReason);
      await assign.getByRole('button',{name:'Gán quản lý',exact:true}).click();
      await expect(assign).toHaveCount(0);
      const assignAudit=await assertAudit(voucher.id,'ASSIGN_MANAGER',assignReason);
      assert(assignAudit.some(event=>event.after?.manager_id && Object.hasOwn(event.after,'manager_name')),'manager audit retains assigned identity and name');
      check('assign manager blocked without reason and saves actor/time');
      const voucherDetail=page.getByRole('dialog',{name:'Thông tin thu/chi'});
      await voucherDetail.getByRole('button',{name:'Close',exact:true}).click();
      await expect(voucherDetail).toHaveCount(0);
      await row.getByTitle('Xem lịch sử phiếu (mốc lập/duyệt/huỷ + thay đổi)').click();
      const historyDialog=page.getByRole('dialog',{name:`Lịch sử phiếu ${voucher.code}`});
      const audit=page.getByRole('region',{name:'Lịch sử can thiệp hoa hồng'});
      await expect(audit.getByText(creationReason,{exact:false}).first()).toBeVisible();
      await expect(audit.getByText(editReason,{exact:false}).first()).toBeVisible();
      await expect(audit.getByText(assignReason,{exact:false}).first()).toBeVisible();
      await snapshot('desktop-history');
      await historyDialog.getByRole('button',{name:'Close',exact:true}).click();
      await expect(historyDialog).toHaveCount(0);
      await row.getByTitle(/^Huỷ phiếu(?: —|$)/).click();
      const cancel=page.getByRole('alertdialog');
      await cancel.getByRole('button',{name:'Huỷ phiếu',exact:true}).click();
      await expect(cancel.getByRole('alert')).toContainText('Nhập lý do huỷ');
      const cancelReason='Huỷ phiếu kiểm thử sau khi đã đối chiếu';
      await cancel.getByPlaceholder(/Lý do huỷ \(bắt buộc/).fill(cancelReason);
      cancellationTarget={id:voucher.id,reason:cancelReason};
      await cancel.getByRole('button',{name:'Huỷ phiếu',exact:true}).click();
      await expect(cancel).toHaveCount(0); const cancelAudit=await assertAudit(voucher.id,'CANCEL',cancelReason);
      assert.equal(cancelAudit.length,1,'one final cancel event for this exact reason and actor');
      await settle(); await drainResponseInspections();
      const cancelledRow=(await db.query('select id,approval_status from public.income_expenses where id=$1',[voucher.id])).rows[0];
      assert.equal(cancelledRow?.id,voucher.id);assert.equal(cancelledRow?.approval_status,'CANCELLED');
      assert.equal(cancelReceipts.length,1,'exact compat cancel receipt');
      assert.equal(fallbackCandidates.length,3,'only the three known cancel routing signals');
      assert.equal(new Set(fallbackCandidates.map(value=>value.path)).size,3,'one response per routing signal');
      for(const response of [...fallbackCandidates,...cancelReceipts])assert(completedRequests.has(response.request),'cancel routing request fully completed');
      report.cancelEvidence={target:cancellationTarget,receipt:cancelReceipts.map(({request,...row})=>row),state:cancelledRow,
        audit:cancelAudit.map(({id,stage,actor_id,actor_name,at,reason})=>({id,stage,actor_id,actor_name,at,reason})),allRequestsCompleted:true};
      report.expectedFallbacks=fallbackCandidates.map(({request,...row})=>row);
      for(const row of fallbackCandidates)uncertainWrites.delete(row.request);
      classifyConsoleMessages();
      check('cancel requires exact user reason and retains audit history');
      await page.setViewportSize({width:390,height:844});
      await go(`/income-expense/voucher/${voucher.id}`);
      await page.getByText('Căn cứ và lý do điều chỉnh hoa hồng',{exact:true}).click();
      await expect(audit.getByText(cancelReason,{exact:false}).first()).toBeVisible();
      await expect(page.getByText('Đã huỷ phiếu.',{exact:true})).toHaveCount(0,{timeout:15000});
      await audit.getByText(cancelReason,{exact:false}).first().evaluate(el=>el.closest('li').scrollIntoView({block:'center',behavior:'instant'}));
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await snapshot('mobile-history');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false,'mobile history fits viewport');
      check('desktop/mobile history shows reasons and no horizontal overflow');
      await settle(); await drainResponseInspections();classifyConsoleMessages(); assert.equal(pendingWrites.size,0); assert.equal(uncertainWrites.size,0);
      assert.deepEqual(report.blockedRequests,[]); assert.deepEqual(report.httpErrors,[]);
      assert.deepEqual(report.consoleErrors,[]); assert.deepEqual(report.pageErrors,[]); assert.deepEqual(report.networkErrors,[]);
      assert.equal(sourceIdentity().digest,source.digest,'source changed during browser verification');
      check('no unclassified console/network errors; verified cancel routing signals and exact source unchanged');
    } catch(error) {
      if(page&&!page.isClosed())await snapshot('failure').catch(()=>{});
      throw error;
    } finally {
      if(page && !page.isClosed() && pendingWrites.size) {
        try { await expect.poll(()=>pendingWrites.size,{timeout:45000}).toBe(0); }
        catch { report.pendingAtCleanup=pendingWrites.size; }
      }
      if(browser){closingBrowser=true;navigation?.snapshot('close');await browser.close();browser=undefined;}
      await drainResponseInspections();classifyConsoleMessages();
      await withTestCleanup(lease,connection.test,clean);
    }
  });
  assert.deepEqual(report.consoleErrors,[]); assert.deepEqual(report.pageErrors,[]);
  assert.deepEqual(report.httpErrors,[]); assert.deepEqual(report.networkErrors,[]); assert.deepEqual(report.blockedRequests,[]);
  report.status='PASS';
} catch(error) {
  report.failure=error.message; if(page&&!page.isClosed())await snapshot('failure').catch(()=>{}); process.exitCode=1;
} finally {
  await browser?.close(); await server?.close(); await db?.end();
  const safe=sanitizeChromeEvidence(report,secrets); await writeFile(join(reportDir,'result.json'),JSON.stringify(safe,null,2));
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,cleanup:report.cleanup,report:join(reportDir,'result.json'),failure:safe.failure}));
}
