import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as evidence from '../copilot-golden-browser-evidence.mjs';
test('registers the bounded customer executor family', () => {
  assert.equal(evidence.IMPLEMENTED_ORACLES.has('customer-nguyen-an-v1'), true);
  assert.equal(evidence.IMPLEMENTED_ORACLES.has('absent-synthetic-phone-v1'), true);
});
import { bindContractScenario, contractQuery } from '../copilot-contract-fixtures.mjs';
import { bindIncomeApprovalScenario, incomeApprovalRequest, dailyCashbookRequest } from '../copilot-income-approval-fixtures.mjs';
import { bindFinancialReadScenario, financialReadRequests, financialRoleDigest } from '../copilot-financial-read-fixtures.mjs';

test('financial family receipts require exact roles, bound full payloads, actors and later linked results',()=>{
  const invoice={id:'aaaa4000-0000-4000-8000-000000000081',invoice_number:'INV-G701',billing_month:'2026-07',total_amount:12000,status:'UNPAID',building_id:'aaaa4000-0000-4000-8000-000000000082',building_name:'DEMO Toà A',room_id:'aaaa4000-0000-4000-8000-000000000083',room_name:'G701'};
  const stats={total_amount:12000,total_paid:2000,total_remaining:10000,total_refunded:0,total_count:1,rent_amount:9000,electric_amount:1000,water_amount:1000,pdv_amount:1000,total_collected:2000,payment_tm:1000,payment_tk:1000,payment_tt:0,payment_ct:0,change_amount:0,deposit_collected:0};
  for(const id of ['C03','C05','C15','C17','C19','C24','C26']) {
    const scenario=manifest.cases.find(c=>c.id===id),requests=financialReadRequests(id);
    const roles=Object.fromEntries(Object.entries(requests).map(([role,request])=>[role,{request,payload:role==='invoice'?(id==='C15'?[]:[invoice]):role==='pnl'?[{month:'2026-07-01',building_id:invoice.building_id,building_name:invoice.building_name,is_virtual:false,revenue:18000,expense:7000,net:11000}]:id==='C19'?Object.fromEntries(Object.keys(stats).map(k=>[k,0])):stats}]));
    const b=bindFinancialReadScenario(scenario,{organizationId:evidence.DEMO_ORG,actorDigest:attestation.actorDigest,appOrigin:'https://golden.example',apiOrigin:'https://demo.supabase.co',roles});
    const run=evidence.createRun(golden,manifest,{...attestation,financialReadFixtures:{[id]:b.attestation}},[id]);
    evidence.transitionCase(run,id,{status:'running'});
    const observed={answerDigest:digest,promptDigest:evidence.digest(scenario.prompt),promptTemplateDigest:evidence.digest(scenario.prompt),bindingDigest:b.bindingDigest,fixtureDigest:b.bindingDigest,rpcDigest:financialRoleDigest(b.attestation),modelRounds:2,toolResultLinked:true,finalAnswerMounted:true,readRpc:'financial-read-roles-v1',businessWrites:0,networkErrors:0,oracleVersion:scenario.oracle,financialReads:Object.entries(b.attestation.roles).map(([role,r])=>({role,rpc:r.rpc,argsDigest:r.argsDigest,responseDigest:r.responseDigest,factDigest:r.factDigest,actorDigest:attestation.actorDigest,httpStatus:200,exactEndpoint:true,toolCallId:`call-${role}`,modelRound:0,resultRound:1}))};
    evidence.transitionCase(run,id,{status:'pass',timing:{startedAt:'2026-09-06T10:00:00.000Z',completedAt:'2026-09-06T10:00:01.000Z',totalMs:1000,humanWaitMs:0,processingMs:1000},observed});
    assert.deepEqual(evidence.validateBrowserRun(golden,manifest,run),[]);
    const mutations=[o=>{o.rpcDigest=Object.values(b.attestation.roles)[0].responseDigest},o=>{o.financialReads.pop()},o=>{o.financialReads.push(o.financialReads[0])},o=>{o.financialReads[0].httpStatus=201},o=>{o.financialReads[0].exactEndpoint=false},o=>{o.financialReads[0].actorDigest='c'.repeat(64)},o=>{o.financialReads[0].modelRound=1},o=>{o.financialReads[0].resultRound=0},o=>{o.financialReads[0].toolCallId=''},o=>{o.businessWrites=1},o=>{o.networkErrors=1},o=>{o.finalAnswerMounted=false},o=>{o.promptDigest=digest}];
    for(const field of ['argsDigest','responseDigest','factDigest'])mutations.push(o=>{o.financialReads[0][field]='c'.repeat(64)});
    mutations.push(o=>{o.financialReads[0]={role:'__proto__',actorDigest:attestation.actorDigest,httpStatus:200,exactEndpoint:true,toolCallId:'call-unknown',modelRound:0,resultRound:1}});
    for(const mutate of mutations){const bad=structuredClone(run);mutate(bad.cases.find(c=>c.id===id).observed);assert.ok(evidence.validateBrowserRun(golden,manifest,bad).length);}
    for(const field of ['actorDigest','kind','roles']){const bad=structuredClone(run);delete bad.attestation.financialReadFixtures[id][field];assert.ok(evidence.validateBrowserRun(golden,manifest,bad).length);}
    const failed=structuredClone(run);failed.cases.find(c=>c.id===id).status='blocked';failed.cases.find(c=>c.id===id).reason='fixture_unbound';assert.ok(evidence.validateBrowserRun(golden,manifest,failed).length);
    assert.equal(run.cases.length,75);assert.equal(run.cases.filter(c=>c.status==='not_selected').length,74);
  }
});

const contractRow = { hop_dong_id: 'aaaa4000-0000-4000-8000-000000000011', so_hop_dong: 'HD001', trang_thai:'ACTIVE', khach_hang: 'Demo An', phong: 'A101', ngay_bat_dau: '2026-01-01', ngay_ket_thuc: '2026-12-31', tien_thue: 3000000, tien_coc: 6000000 };
test('contract binding binds exact identity/query and rejects empty, ambiguous or drifting fixtures', () => {
  const scenario = manifest.cases.find(c => c.id === 'C31');
  const searchPayload = { hop_dong: [contractRow], gioi_han: 20, so_luong: 1 };
  assert.equal(contractQuery('C31', 'context-1', searchPayload), 'HD001');
  const bound = bindContractScenario(scenario, { query: 'HD001', searchPayload });
  assert.equal(bound.prompt, 'Tìm hợp đồng số HD001');
  assert.equal(bound.attestation.searchDigest, evidence.digest(searchPayload));
  assert.equal(bound.attestation.identityDigest, evidence.digest({ organizationId: evidence.DEMO_ORG, contractId: contractRow.hop_dong_id, code: 'HD001' }));
  for (const rows of [[], [contractRow,contractRow], [{ ...contractRow, so_hop_dong: 'HD002' }], [{ ...contractRow, hop_dong_id: 'bad' }]]) {
    assert.throws(() => bindContractScenario(scenario, { query: 'HD001', searchPayload: { ...searchPayload, hop_dong: rows } }), /fixture_unbound/);
  }
  const absent = contractQuery('C32', 'context-1');
  assert.equal(absent, 'GOLDEN_ABSENT_context-1');
  assert.throws(() => bindContractScenario(manifest.cases.find(c => c.id === 'C32'), { query: absent, searchPayload }), /fixture_unbound/);
  assert.throws(() => bindContractScenario(manifest.cases.find(c => c.id === 'C33'), { query: 'HD001', searchPayload, detailPayload: { tim_thay: true, hop_dong: { ...contractRow, hop_dong_id: 'bbbb4000-0000-4000-8000-000000000011' }, hoa_don: [] } }), /fixture_unbound/);
});

test('explicit selection retains every case and cannot imply full plan acceptance', () => {
  const run = evidence.createRun(golden, manifest, attestation, ['C31','C32','C33']);
  assert.equal(run.cases.length, 75);
  assert.equal(run.cases.filter(c => c.status === 'not_selected').length, 72);
  assert.equal(evidence.summarizeRun(run).fullPlanAccepted, false);
  assert.deepEqual(run.selection, { mode: 'selected', caseIds: ['C31','C32','C33'] });
  for (const ids of [[], ['C31','C31'], ['C99'], 'C31']) assert.throws(() => evidence.createRun(golden, manifest, attestation, ids), /selection/);
});

const golden = JSON.parse(readFileSync(new URL('../../tooling/copilot-golden-eval.json', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('../../tooling/copilot-golden-scenarios.json', import.meta.url)));
const sha = 'a'.repeat(40), digest = 'b'.repeat(64);
const attestation = {
  buildSha: sha, edgeSourceDigest: digest, deployedEdgeSourceDigest: digest,
  providerModel: '9router:cx/gpt-5.6-luna(max)', organizationId: evidence.DEMO_ORG,
  corpusDigest: evidence.digest(golden), manifestDigest: evidence.digest(manifest),
  fixtureDigest: digest, policyDigest: digest, actorDigest: digest,
  observedAt: '2026-09-06T10:00:00.000Z', contextId: 'isolated-browser-1',
};

const voucherRow = { phieu_id:'aaaa4000-0000-4000-8000-000000000021',ma_phieu:'PC001',loai:'EXPENSE',ten:'Demo repair',so_tien:11000,ngay:'2026-07-12',hang_muc:'Repair',so_quy:'Cash',trang_thai:'UNAPPROVED',trang_thai_ghi_nhan:'UNPOSTED',nguoi_tao:'Demo An',toa_nha:'DEMO Toà A' };
const pendingRow = { yeu_cau_id:'aaaa4000-0000-4000-8000-000000000022',lan_gui:1,gui_luc:'2026-09-07T00:00:00+00:00',so_tien:1000,phieu_id:voucherRow.phieu_id,ma_phieu:'PC001',ten_phieu:'Demo repair',loai:'EXPENSE',nguoi_lap:'Demo An',buoc:1 };
const financialInput = id => ({ request: incomeApprovalRequest(id), actorDigest:attestation.actorDigest,
  payload:{gioi_han:20,so_luong:id === 'C35' ? 0 : 1,[id === 'C36' ? 'hop_cho' : 'phieu']:id === 'C35' ? [] : [id === 'C36' ? pendingRow : voucherRow]} });
test('financial fixtures bind exact actor/query and preserve cancelled history rather than accepting empty positives', () => {
  assert.deepEqual(incomeApprovalRequest('C34'), {rpc:'copilot_income_expense_search_v1',args:{p_organization_id:evidence.DEMO_ORG,p_query:null,p_tu:'2026-07-01',p_den:'2026-07-31',p_loai:null,p_trang_thai:null,p_limit:20}});
  assert.deepEqual(incomeApprovalRequest('C35'), {rpc:'copilot_income_expense_search_v1',args:{p_organization_id:evidence.DEMO_ORG,p_query:null,p_tu:'2099-01-01',p_den:'2099-01-31',p_loai:'EXPENSE',p_trang_thai:null,p_limit:20}});
  assert.deepEqual(incomeApprovalRequest('C36'), {rpc:'copilot_pending_requests_v1',args:{p_organization_id:evidence.DEMO_ORG,p_limit:20}});
  for (const id of ['C34','C35','C36']) {
    const scenario = manifest.cases.find(c => c.id === id), input = financialInput(id);
    const bound = bindIncomeApprovalScenario(scenario,input);
    assert.equal(bound.prompt,scenario.prompt);
    assert.equal(bound.attestation.queryDigest,evidence.digest(input.request));
    assert.equal(bound.attestation.responseDigest,evidence.digest(input.payload));
    assert.equal(bound.attestation.actorDigest,attestation.actorDigest);
    for (const [key,value] of [['p_organization_id','other'],['p_limit',50],['p_query','other'],['p_loai','INCOME'],['p_tu','2026-06-01'],['p_den','2026-07-30'],['p_trang_thai','APPROVED']]) {
      const bad = structuredClone(input); bad.request.args[key]=value;
      assert.throws(() => bindIncomeApprovalScenario(scenario,bad),/fixture_unbound/);
    }
    for (const badActor of ['',null,[],{toString:()=>attestation.actorDigest}]) assert.throws(() => bindIncomeApprovalScenario(scenario,{...input,actorDigest:badActor}),/fixture_unbound/);
    const bad = structuredClone(input); bad.payload[id === 'C36' ? 'hop_cho' : 'phieu'] = id === 'C35' ? [voucherRow] : []; bad.payload.so_luong = id === 'C35' ? 1 : 0;
    assert.throws(() => bindIncomeApprovalScenario(scenario,bad),/fixture_unbound/);
  }
  const scenario = manifest.cases.find(c=>c.id === 'C34'), input=financialInput('C34');
  for (const change of [{so_tien:'11000'},{so_tien:-1},{ngay:'2026-02-30'},{ngay:'2026-08-01'},{phieu_id:'bad'},{trang_thai:'PENDING_APPROVAL'},{trang_thai_ghi_nhan:'invented'}]) {
    assert.throws(()=>bindIncomeApprovalScenario(scenario,{...input,payload:{...input.payload,phieu:[{...voucherRow,...change}]}}),/fixture_unbound/);
  }
  const cancelled=bindIncomeApprovalScenario(scenario,{...input,payload:{...input.payload,phieu:[{...voucherRow,trang_thai:'CANCELLED'}]}});
  assert.equal(cancelled.payload.phieu[0].trang_thai,'CANCELLED');
  assert.throws(()=>bindIncomeApprovalScenario(scenario,{...input,payload:{...input.payload,so_luong:2,phieu:[voucherRow,voucherRow]}}),/fixture_unbound/);
});

test('income/approval passes require actor-bound per-case hashes and exact observation schema', () => {
  const fixtures=Object.fromEntries(['C34','C35','C36'].map(id=>[id,bindIncomeApprovalScenario(manifest.cases.find(c=>c.id===id),financialInput(id)).attestation]));
  const run=evidence.createRun(golden,manifest,{...attestation,incomeApprovalFixtures:fixtures},['C34','C35','C36']);
  for (const id of ['C34','C35','C36']) {
    const f=fixtures[id], scenario=manifest.cases.find(c=>c.id===id);
    evidence.transitionCase(run,id,{status:'running'});
    evidence.transitionCase(run,id,{status:'pass',timing:{startedAt:'2026-09-06T10:00:00.000Z',completedAt:'2026-09-06T10:00:01.000Z',totalMs:1000,humanWaitMs:0,processingMs:1000},observed:{answerDigest:digest,promptDigest:evidence.digest(scenario.prompt),promptTemplateDigest:evidence.digest(scenario.prompt),bindingDigest:evidence.digest(f),fixtureDigest:evidence.digest(f),queryDigest:f.queryDigest,identityDigest:f.identityDigest,responseDigest:f.responseDigest,rpcDigest:f.responseDigest,modelRounds:2,toolResultLinked:true,finalAnswerMounted:true,readRpc:incomeApprovalRequest(id).rpc,businessWrites:0,networkErrors:0,oracleVersion:scenario.oracle}});
    for(const key of ['fixtureDigest','bindingDigest','queryDigest','identityDigest','responseDigest','rpcDigest','readRpc','oracleVersion','toolResultLinked']) {
      const bad=structuredClone(run); bad.cases.find(c=>c.id===id).observed[key]='c'.repeat(64);
      assert.ok(evidence.validateBrowserRun(golden,manifest,bad).length,`${id} ${key}`);
    }
    for (const key of ['organizationId','actorDigest','kind','responseDigest']) {
      const bad=structuredClone(run); bad.attestation.incomeApprovalFixtures[id][key]='c'.repeat(64);
      assert.ok(evidence.validateBrowserRun(golden,manifest,bad).length);
    }
    const missing=structuredClone(run); delete missing.attestation.incomeApprovalFixtures[id];
    assert.ok(evidence.validateBrowserRun(golden,manifest,missing).length);
    const raw=structuredClone(run); raw.attestation.incomeApprovalFixtures[id].payload={private:'raw'};
    assert.ok(evidence.validateBrowserRun(golden,manifest,raw).length);
    const wrongField=structuredClone(run); wrongField.cases.find(c=>c.id===id).observed.searchDigest=digest;
    assert.ok(evidence.validateBrowserRun(golden,manifest,wrongField).length);
  }
  assert.deepEqual(evidence.validateBrowserRun(golden,manifest,run),[]);
  assert.equal(evidence.summarizeRun(run).selectedVerdict,'pass');
  assert.equal(evidence.summarizeRun(run).fullPlanAccepted,false);
  assert.equal(run.cases.length,75);
});

test('manifest accounts for every original case and distinguishes unfinished domain oracles', () => {
  assert.deepEqual(evidence.validateManifest(golden, manifest), []);
  assert.equal(manifest.cases.length, 75);
  assert.ok(manifest.cases.every(c => c.oracle && c.fixture && c.acceptance.length));
  assert.ok(manifest.cases.find(c => c.id === 'C64').conversationGroup === 'memory-lifecycle');
  assert.ok(manifest.cases.find(c => c.id === 'C73').fixture.includes('expense'));
  assert.ok(evidence.validateManifest(golden, { ...manifest, cases: manifest.cases.slice(1) }).length);
});

test('legacy inferred arrays are rejected even when all 75 statuses say pass', () => {
  assert.ok(evidence.validateBrowserRun(golden, manifest, golden.cases.map(c => ({ ...c, status: 'pass' }))).length);
});

test('a fresh run explicitly records all cases as pending and cannot pass', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  assert.equal(run.cases.length, 75);
  assert.equal(run.cases.filter(c => c.status === 'pending').length, 75);
  assert.equal(evidence.summarizeRun(run).verdict, 'blocked');
  assert.equal(evidence.summarizeRun(run).latencyMs.p50, null);
  assert.deepEqual(evidence.validateBrowserRun(golden, manifest, run), []);
});

test('blocked result has no fabricated actual observations and cannot transition directly to pass', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  evidence.transitionCase(run, 'C01', { status: 'blocked', reason: 'quota_exhausted' });
  assert.equal(run.cases[0].observed, undefined);
  assert.throws(() => evidence.transitionCase(run, 'C01', { status: 'pass' }), /transition/);
});

test('completed assistant text alone cannot pass a case without concrete oracle evidence', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  evidence.transitionCase(run, 'C01', { status: 'running' });
  assert.throws(() => evidence.transitionCase(run, 'C01', {
    status: 'pass', observed: { answerDigest: digest, modelRounds: 1 },
  }), /evidence/);
});

test('complete allowlisted observations are accepted structurally, while fixture drift and unimplemented cases are rejected', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  const scenario = manifest.cases[0];
  evidence.transitionCase(run, 'C01', { status: 'running' });
  evidence.transitionCase(run, 'C01', { status: 'pass', timing: {
    startedAt: '2026-09-06T10:00:00.000Z', completedAt: '2026-09-06T10:00:01.000Z', totalMs: 1000, humanWaitMs: 0, processingMs: 1000,
  }, observed: { answerDigest: digest, promptDigest: evidence.digest(scenario.prompt), promptTemplateDigest: evidence.digest(scenario.prompt),
    bindingDigest: digest, rpcDigest: digest, modelRounds: 2, toolResultLinked: true, finalAnswerMounted: true,
    readRpc: 'copilot_available_rooms_v1', businessWrites: 0, networkErrors: 0, oracleVersion: scenario.oracle } });
  assert.deepEqual(evidence.validateBrowserRun(golden, manifest, run), []);
  assert.throws(() => evidence.resumeRun(run, attestation), /cannot be reused/);
  const drift = structuredClone(run); drift.cases[0].observed.rpcDigest = 'c'.repeat(64);
  assert.ok(evidence.validateBrowserRun(golden, manifest, drift).some(e => /fixture/.test(e)));
  const unsupported = structuredClone(run); unsupported.cases[1] = { ...unsupported.cases[0], id: 'C02', oracle: manifest.cases[1].oracle };
  assert.ok(evidence.validateBrowserRun(golden, manifest, unsupported).some(e => /evidence/.test(e)));
});

test('provider failure latencies are excluded from successful quantiles and pending SLA stays pending', () => {
  const summary = evidence.summarizeRun({ cases: [
    { status: 'pass', timing: { totalMs: 1000, humanWaitMs: 200, processingMs: 800 } },
    { status: 'blocked', timing: { totalMs: 1, humanWaitMs: 0, processingMs: 1 } },
    { status: 'fail', timing: { totalMs: 10, humanWaitMs: 0, processingMs: 10 } },
  ] });
  assert.equal(summary.latencyMs.p50, 1000);
  assert.equal(summary.unsuccessfulLatencyMs.p50, 1);
  assert.equal(summary.sla.status, 'pending-owner-approval');
});

test('attestation drift, duplicate IDs, unknown fields and interrupted cleanup fail closed', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  assert.throws(() => evidence.resumeRun(run, { ...attestation, providerModel: 'other:model' }), /attestation/);
  const duplicate = structuredClone(run); duplicate.cases[1].id = 'C01';
  assert.ok(evidence.validateBrowserRun(golden, manifest, duplicate).length);
  const privatePayload = structuredClone(run); privatePayload.raw = 'do not retain';
  assert.ok(evidence.validateBrowserRun(golden, manifest, privatePayload).length);
  run.cleanup.push({ caseId: 'C64', fixtureKey: 'memory-fixture', state: 'pending', cleanup: 'canonical-memory-delete' });
  assert.throws(() => evidence.resumeRun(run, attestation), /cleanup/);
});

test('checkpoint survives a roundtrip and resume never reuses previous pass or replays interrupted writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-evidence-'));
  try {
    const run = evidence.createRun(golden, manifest, attestation);
    evidence.transitionCase(run, 'C01', { status: 'running' });
    evidence.writeCheckpoint(join(dir, 'run.json'), run, golden, manifest);
    const restored = JSON.parse(readFileSync(join(dir, 'run.json')));
    assert.throws(() => evidence.resumeRun(restored, attestation), /interrupted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('building room scenario binds exactly one visible DEMO building and retains all room facts for exclusion checks', () => {
  const scenario = manifest.cases.find(c => c.id === 'C13');
  const payload = { buildings: [{ id: 'a', name: 'DEMO Toà A' }, { id: 'b', name: 'Other' }], rooms: [{ building_id: 'a', code: 'A101' }, { building_id: 'b', code: 'B101' }] };
  const bound = evidence.bindRoomScenario(scenario, payload);
  assert.ok(bound.prompt.includes('DEMO Toà A'));
  assert.ok(!bound.prompt.includes('{{'));
  assert.deepEqual(bound.payload.buildings.map(b => b.id), ['a']);
  assert.deepEqual(bound.buildingScope, { id: 'a', name: 'DEMO Toà A' });
  assert.equal(bound.payload.rooms.length, 2);
  assert.throws(() => evidence.bindRoomScenario(scenario, { ...payload, buildings: [] }), /fixture_unbound/);
  assert.throws(() => evidence.bindRoomScenario(scenario, { ...payload, buildings: [payload.buildings[0], payload.buildings[0]] }), /fixture_unbound/);
});

test('structured quota and rate errors classify without retaining raw provider text', () => {
  for (const code of ['quota_exhausted','insufficient_quota','daily_quota','daily_token_quota']) {
    assert.equal(evidence.providerFailureReason({ code, message: 'private upstream payload' }), 'quota_exhausted');
  }
  for (const code of ['rate_limited','rate_limit_exceeded','rate_limit_error']) {
    assert.equal(evidence.providerFailureReason({ code }), 'rate_exhausted');
  }
  assert.equal(evidence.providerFailureReason({ type: 'rate_limit_error' }), 'rate_exhausted');
  assert.equal(evidence.providerFailureReason({ code: 429 }), 'rate_exhausted');
  assert.equal(evidence.providerFailureReason({ code: 'unknown', message: 'quota_exhausted in prose is not a structured code' }), 'provider_failed');
});

test('model identity is explicit and shared with the fleet, not a duplicated cx-only allowlist', () => {
  for (const providerModel of ['9router:ag/gemini-3.6-flash-high(high)', '9router:ag/gemini-3.7-flash-high(high)', '9router:ag/gemini-3.8-flash(high)']) {
    const run = evidence.createRun(golden, manifest, { ...attestation, providerModel });
    assert.equal(run.attestation.providerModel, providerModel);
  }
  for (const providerModel of ['', '9router:raw private payload', 'other:ag/model']) {
    assert.throws(() => evidence.createRun(golden, manifest, { ...attestation, providerModel }), /attestation/);
  }
});

test('building scope rejects missing, non-string and empty IDs from unknown RPC payloads', () => {
  const scenario = manifest.cases.find(c => c.id === 'C13');
  for (const id of [undefined, null, 0, 123, {}, ['a'], '', ' ']) {
    assert.throws(() => evidence.bindRoomScenario(scenario, {
      buildings: [{ id, name: 'DEMO Toà A' }], rooms: [],
    }), /fixture_unbound/, `building ID ${JSON.stringify(id)} must not become a typed scope`);
  }
  assert.throws(() => evidence.bindRoomScenario(scenario, { buildings: [null], rooms: [] }), /fixture_unbound/);
});

test('attestation rejects coercible non-string fields before returning a typed run', () => {
  for (const [field, value] of Object.entries(attestation)) {
    for (const malformed of [undefined, null, 0, 123, [value], new String(value)]) {
      assert.throws(() => evidence.createRun(golden, manifest, { ...attestation, [field]: malformed }),
        /attestation/, `${field} must be a primitive string`);
    }
  }
});

test('unknown manifest inputs cannot create cases with unvalidated scenario fields', () => {
  for (const field of ['id', 'fixture', 'oracle', 'kind', 'prompt']) {
    for (const malformed of [undefined, null, 123, [manifest.cases[0][field]], '']) {
      const changed = structuredClone(manifest), corpus = structuredClone(golden);
      changed.cases[0][field] = malformed;
      if (field === 'id') corpus.cases[0].id = malformed;
      assert.ok(evidence.validateManifest(corpus, changed).length, `${field} must be a nonempty string`);
      assert.throws(() => evidence.createRun(corpus, changed, {
        ...attestation, corpusDigest: evidence.digest(corpus), manifestDigest: evidence.digest(changed),
      }), /manifest/);
    }
  }
  for (const acceptance of [undefined, null, 'claim', [], [123], [null], ['']]) {
    const changed = structuredClone(manifest); changed.cases[0].acceptance = acceptance;
    assert.ok(evidence.validateManifest(golden, changed).length, 'acceptance must contain nonempty strings');
  }
  for (const malformed of [null, {}, { cases: null }, { cases: [null] }]) {
    assert.ok(evidence.validateManifest(malformed, manifest).length);
    assert.ok(evidence.validateBrowserRun(malformed, manifest, {}).length);
  }
  const changed = structuredClone(manifest); changed.cases[0] = null;
  assert.ok(evidence.validateManifest(golden, changed).length);
  assert.ok(evidence.validateBrowserRun(golden, changed, {}).length);
});

function passedRoomRun() {
  const run = evidence.createRun(golden, manifest, attestation);
  evidence.transitionCase(run, 'C01', { status: 'running' });
  evidence.transitionCase(run, 'C01', { status: 'pass', timing: {
    startedAt: '2026-09-06T10:00:00.000Z', completedAt: '2026-09-06T10:00:01.000Z',
    totalMs: 1000, humanWaitMs: 0, processingMs: 1000,
  }, observed: {
    answerDigest: digest, promptDigest: digest, promptTemplateDigest: evidence.digest(manifest.cases[0].prompt),
    bindingDigest: digest, rpcDigest: digest, modelRounds: 2, toolResultLinked: true, finalAnswerMounted: true,
    readRpc: 'copilot_available_rooms_v1', businessWrites: 0, networkErrors: 0, oracleVersion: 'available-rooms-v1',
  } });
  run.cleanup.push({ caseId: 'C64', fixtureKey: 'memory-fixture', state: 'done', cleanup: 'canonical-memory-delete' });
  return run;
}

test('checkpoint validation rejects coercible identity, timing, observation and cleanup fields', () => {
  const run = passedRoomRun();
  assert.deepEqual(evidence.validateBrowserRun(golden, manifest, run), []);
  for (const fields of [
    ['runId', 'createdAt', 'updatedAt'], ['startedAt', 'completedAt'],
    ['answerDigest', 'promptDigest', 'promptTemplateDigest', 'bindingDigest', 'rpcDigest'],
    ['caseId', 'fixtureKey', 'state', 'cleanup'],
  ]) {
    for (const field of fields) {
      const changed = structuredClone(run);
      const target = fields[0] === 'runId' ? changed : fields[0] === 'startedAt' ? changed.cases[0].timing
        : fields[0] === 'answerDigest' ? changed.cases[0].observed : changed.cleanup[0];
      target[field] = [target[field]];
      assert.ok(evidence.validateBrowserRun(golden, manifest, changed).length, `${field} must reject array coercion`);
    }
  }
  const numeric = structuredClone(run);
  numeric.cases[0].timing = { startedAt: 0, completedAt: 0, totalMs: 0, humanWaitMs: 0, processingMs: 0 };
  assert.ok(evidence.validateBrowserRun(golden, manifest, numeric).length, 'numeric timestamps must be rejected');
  for (const field of ['fixtureKey', 'cleanup']) {
    const changed = structuredClone(run); changed.cleanup[0][field] = 123;
    assert.ok(evidence.validateBrowserRun(golden, manifest, changed).length, `${field} must reject numeric IDs`);
  }
});

test('checkpoint validation rejects malformed optional fields even on unfinished cases', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  for (const [field, malformed] of [['reason', 123], ['reason', null], ['timing', null], ['timing', 0], ['timing', false], ['timing', '']]) {
    const changed = structuredClone(run); changed.cases[0][field] = malformed;
    assert.ok(evidence.validateBrowserRun(golden, manifest, changed).length, `${field} must be validated when present`);
  }
  const changed = structuredClone(run); changed.cases[0] = null;
  assert.ok(evidence.validateBrowserRun(golden, manifest, changed).length);
});

test('valid string boundaries preserve C01, C13 and checkpoint roundtrips', () => {
  const payload = { buildings: [{ id: 'building-a', name: 'DEMO Toà A' }], rooms: [] };
  for (const id of ['C01', 'C13']) {
    const bound = evidence.bindRoomScenario(manifest.cases.find(c => c.id === id), payload);
    assert.equal(typeof bound.prompt, 'string');
    assert.match(bound.bindingDigest, /^[a-f0-9]{64}$/);
    if (id === 'C13') assert.equal(bound.buildingScope.id.toUpperCase(), 'BUILDING-A');
  }
  const run = passedRoomRun();
  assert.ok(Object.values(run.attestation).every(value => typeof value === 'string'));
  assert.equal(run.attestation.contextId.toUpperCase(), 'ISOLATED-BROWSER-1');
  const dir = mkdtempSync(join(tmpdir(), 'copilot-typed-evidence-'));
  try {
    const path = join(dir, 'run.json');
    evidence.writeCheckpoint(path, run, golden, manifest);
    const restored = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(evidence.validateBrowserRun(golden, manifest, restored), []);
    assert.equal(restored.cases[0].timing.startedAt.slice(0, 10), '2026-09-06');
    assert.equal(evidence.summarizeRun(restored).verdict, 'blocked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('contract pass requires its exact case oracle, fixture attestation and observed RPC hashes', () => {
  for (const id of ['C31','C32','C33']) {
    const scenario = manifest.cases.find(c => c.id === id), absent = id === 'C32';
    const searchPayload = { hop_dong: absent ? [] : [contractRow], gioi_han: 20, so_luong: absent ? 0 : 1 };
    const detailPayload = id === 'C33' ? { tim_thay: true, hop_dong: { ...contractRow, coc_da_thu: 6000000, coc_con_thieu: 0 }, hoa_don: [] } : undefined;
    const fixture = bindContractScenario(scenario, { query: absent ? 'GOLDEN_ABSENT_context-1' : 'HD001', searchPayload, detailPayload, customerPayload: absent ? [] : undefined });
    const run = evidence.createRun(golden, manifest, { ...attestation, contractFixtures: { [id]: fixture.attestation } }, [id]);
    evidence.transitionCase(run,id,{ status:'running' });
    evidence.transitionCase(run,id,{ status:'pass', timing: { startedAt: '2026-09-06T10:00:00.000Z', completedAt: '2026-09-06T10:00:01.000Z', totalMs:1000, humanWaitMs:0, processingMs:1000 }, observed: {
      answerDigest: digest, promptDigest: evidence.digest(fixture.prompt), promptTemplateDigest: evidence.digest(scenario.prompt), bindingDigest: fixture.bindingDigest,
      fixtureDigest: evidence.digest(fixture.attestation), queryDigest: fixture.attestation.queryDigest, identityDigest: fixture.attestation.identityDigest,
      searchDigest: fixture.attestation.searchDigest, ...(absent ? {contractCalls:1,customerCalls:0} : {}), ...(detailPayload ? { detailDigest: fixture.attestation.detailDigest } : {}),
      rpcDigest: evidence.digest(detailPayload ?? searchPayload), modelRounds: id === 'C33' ? 3 : 2, toolResultLinked:true, finalAnswerMounted:true,
      readRpc: id === 'C33' ? 'copilot_contract_detail_v1' : 'copilot_contract_search_v1', businessWrites:0, networkErrors:0, oracleVersion: scenario.oracle,
    } });
    assert.deepEqual(evidence.validateBrowserRun(golden,manifest,run),[]);
    assert.equal(evidence.summarizeRun(run).selectedVerdict,'pass');
    assert.equal(evidence.summarizeRun(run).verdict,'blocked');
    assert.equal(evidence.summarizeRun(run).fullPlanAccepted,false);
    for (const key of ['fixtureDigest','bindingDigest','queryDigest','identityDigest','searchDigest','rpcDigest','readRpc','oracleVersion','toolResultLinked']) {
      const bad = structuredClone(run); bad.cases.find(c => c.id === id).observed[key] = key === 'toolResultLinked' ? false : 'c'.repeat(64);
      assert.ok(evidence.validateBrowserRun(golden,manifest,bad).length, `${id} ${key}`);
    }
    if (absent) {
      const observed=run.cases.find(c=>c.id===id).observed;
      const multi=structuredClone(run); Object.assign(multi.cases.find(c=>c.id===id).observed,{contractCalls:3,customerCalls:2,customerDigest:fixture.attestation.customerDigest});
      assert.deepEqual(evidence.validateBrowserRun(golden,manifest,multi),[]);
      for(const patch of [{contractCalls:0},{contractCalls:11},{customerCalls:-1},{customerCalls:1},{customerDigest:fixture.attestation.customerDigest},{contractCalls:'1'},{customerCalls:0.5}]) {
        const bad=structuredClone(run); Object.assign(bad.cases.find(c=>c.id===id).observed,patch); assert.ok(evidence.validateBrowserRun(golden,manifest,bad).length);
      }
      const wrong=structuredClone(multi); wrong.cases.find(c=>c.id===id).observed.customerDigest='b'.repeat(64); assert.ok(evidence.validateBrowserRun(golden,manifest,wrong).length);
      const absentFixture=structuredClone(run); delete absentFixture.attestation.contractFixtures.C32.customerDigest; assert.ok(evidence.validateBrowserRun(golden,manifest,absentFixture).length);
      assert.equal(observed.customerCalls,0);
    }
    const missing = structuredClone(run); delete missing.attestation.contractFixtures;
    assert.ok(evidence.validateBrowserRun(golden,manifest,missing).length);
    const org = structuredClone(run); org.attestation.contractFixtures[id].organizationId = 'other';
    assert.ok(evidence.validateBrowserRun(golden,manifest,org).length);
    const raw = structuredClone(run); raw.attestation.contractFixtures[id].customer = 'raw';
    assert.ok(evidence.validateBrowserRun(golden,manifest,raw).length);
    const swap = structuredClone(run); swap.cases.find(c => c.id === id).oracle = 'available-rooms-v1';
    assert.ok(evidence.validateBrowserRun(golden,manifest,swap).length);
  }
});
test('selection corruption cannot turn omitted cases into passed or erase inventory', () => {
  const run = evidence.createRun(golden,manifest,attestation,['C31']);
  assert.deepEqual(evidence.validateBrowserRun(golden,manifest,run),[]);
  for (const selection of [null,{}, { mode:'selected',caseIds:[] }, { mode:'selected',caseIds:['C31','C31'] }, { mode:'selected',caseIds:['C31','C01'] }]) {
    assert.ok(evidence.validateBrowserRun(golden,manifest,{ ...run,selection }).length);
  }
  const mismatch = structuredClone(run); mismatch.cases[0].status = 'pending';
  assert.ok(evidence.validateBrowserRun(golden,manifest,mismatch).length);
  assert.throws(() => evidence.transitionCase(run,'C01',{status:'running'}), /transition/);
});

test('contract detail preserves contractual end date separately from the search effective end', () => {
 const scenario = manifest.cases.find(c => c.id === 'C33');
 const searchPayload = { hop_dong:[{...contractRow,ngay_ket_thuc:'2026-09-01'}],gioi_han:20,so_luong:1 };
 const detailPayload = {tim_thay:true,hop_dong:{...contractRow,ngay_ket_thuc_thuc_te:'2026-09-01',coc_da_thu:6000000,coc_con_thieu:0},hoa_don:[]};
 assert.doesNotThrow(() => bindContractScenario(scenario,{query:'HD001',searchPayload,detailPayload}));
 for (const change of [{ngay_ket_thuc:'2026-02-30'},{ngay_ket_thuc_thuc_te:'2026-08-01'},{ngay_bat_dau:'2026-02-01'},{trang_thai:'TERMINATED'}]) {
  assert.throws(() => bindContractScenario(scenario,{query:'HD001',searchPayload,detailPayload:{...detailPayload,hop_dong:{...detailPayload.hop_dong,...change}}}), /fixture_unbound/);
 }
});

test('C32 customer preflight is a required empty array and attested digest', () => {
 const scenario=manifest.cases.find(c=>c.id==='C32');
 const input={query:'GOLDEN_ABSENT_context-1',searchPayload:{gioi_han:20,so_luong:0,hop_dong:[]}};
 for(const customerPayload of [undefined,null,{},[{name:'not empty'}]]) assert.throws(()=>bindContractScenario(scenario,{...input,customerPayload}),/fixture_unbound/);
 const fixture=bindContractScenario(scenario,{...input,customerPayload:[]});
 assert.equal(fixture.attestation.customerDigest,evidence.digest([]));
});

const dailyFixtureInput=()=>({request:dailyCashbookRequest(),payload:{gioi_han:20,so_luong:2,tu:'2026-07-01',den:'2026-07-31',tong_hop:{tong_thu:9000,tong_chi:17000,rong:-8000,so_ngay_co_phat_sinh:2,phieu_han_che_bi_loai:0},theo_ngay:[{ngay:'2026-07-20',thu:9000,chi:2000,rong:7000},{ngay:'2026-07-19',thu:0,chi:15000,rong:-15000}]}});
test('C34 daily binding validates full posted report independently from unposted vouchers',()=>{
  const scenario=manifest.cases.find(c=>c.id==='C34'), primary=financialInput('C34');
  const bind=dailyCashbook=>bindIncomeApprovalScenario(scenario,{...primary,dailyCashbook});
  const input=dailyFixtureInput(), bound=bind(input), before=bindIncomeApprovalScenario(scenario,primary);
  assert.equal(bound.attestation.dailyCashbookQueryDigest,evidence.digest(input.request));
  assert.equal(bound.attestation.dailyCashbookResponseDigest,evidence.digest(input.payload));
  for(const k of ['queryDigest','identityDigest','responseDigest'])assert.equal(bound.attestation[k],before.attestation[k]);
  const changes=[v=>{v.request.rpc='copilot_other_v1'},v=>{v.extra=1},v=>{v.payload.extra=1},v=>{delete v.payload.den},v=>{v.payload.so_luong=3},v=>{v.payload.gioi_han=50},v=>{v.payload.tu='2026-06-01'},v=>{v.payload.den='2026-08-01'},v=>{v.payload.tong_hop.tong_thu=-1},v=>{v.payload.tong_hop.tong_chi=Infinity},v=>{v.payload.tong_hop.rong=8000},v=>{v.payload.tong_hop.so_ngay_co_phat_sinh=1},v=>{v.payload.tong_hop.phieu_han_che_bi_loai=-1},v=>{v.payload.theo_ngay[0].thu='9000'},v=>{v.payload.theo_ngay[0].rong=0},v=>{v.payload.theo_ngay[0].ngay='2026-08-01'},v=>{v.payload.theo_ngay[1].ngay='2026-07-20'},v=>{v.payload.theo_ngay.reverse()}];
  for(const mutate of changes){const bad=dailyFixtureInput();mutate(bad);assert.throws(()=>bind(bad),/fixture_unbound/);}
  for(const [k,v] of [['p_organization_id','other'],['p_tu','2026-06-01'],['p_den','2026-07-30'],['p_building_id','aaaaaaaa-0000-4000-8000-000000000001'],['p_limit',50],['extra',true]]){const bad=dailyFixtureInput();bad.request.args[k]=v;assert.throws(()=>bind(bad),/fixture_unbound/);}
  for(const id of ['C35','C36'])assert.throws(()=>bindIncomeApprovalScenario(manifest.cases.find(c=>c.id===id),{...financialInput(id),dailyCashbook:input}),/fixture_unbound/);
  const empty=dailyFixtureInput();empty.payload.theo_ngay=[];empty.payload.so_luong=0;Object.assign(empty.payload.tong_hop,{tong_thu:0,tong_chi:0,rong:0,so_ngay_co_phat_sinh:0});assert.doesNotThrow(()=>bind(empty));
  const truncated=dailyFixtureInput();truncated.payload.theo_ngay=Array.from({length:20},(_,i)=>({ngay:`2026-07-${String(31-i).padStart(2,'0')}`,thu:1,chi:2,rong:-1}));truncated.payload.so_luong=20;truncated.payload.tong_hop.so_ngay_co_phat_sinh=31;assert.doesNotThrow(()=>bind(truncated));
});
test('C34 daily evidence pairs attestation hashes and conditional call digest without changing primary proof',()=>{
  const scenario=manifest.cases.find(c=>c.id==='C34'), f=bindIncomeApprovalScenario(scenario,{...financialInput('C34'),dailyCashbook:dailyFixtureInput()}).attestation;
  const run=evidence.createRun(golden,manifest,{...attestation,incomeApprovalFixtures:{C34:f}},['C34']);
  evidence.transitionCase(run,'C34',{status:'running'});
  evidence.transitionCase(run,'C34',{status:'pass',timing:{startedAt:'2026-09-06T10:00:00.000Z',completedAt:'2026-09-06T10:00:01.000Z',totalMs:1000,humanWaitMs:0,processingMs:1000},observed:{answerDigest:digest,promptDigest:evidence.digest(scenario.prompt),promptTemplateDigest:evidence.digest(scenario.prompt),bindingDigest:evidence.digest(f),fixtureDigest:evidence.digest(f),queryDigest:f.queryDigest,identityDigest:f.identityDigest,responseDigest:f.responseDigest,rpcDigest:f.responseDigest,modelRounds:2,toolResultLinked:true,finalAnswerMounted:true,readRpc:incomeApprovalRequest('C34').rpc,businessWrites:0,networkErrors:0,oracleVersion:scenario.oracle,dailyCashbookCalls:1,dailyCashbookDigest:f.dailyCashbookResponseDigest}});
  assert.deepEqual(evidence.validateBrowserRun(golden,manifest,run),[]);
  for(const mutate of [r=>{delete r.attestation.incomeApprovalFixtures.C34.dailyCashbookQueryDigest},r=>{delete r.attestation.incomeApprovalFixtures.C34.dailyCashbookResponseDigest},r=>{r.attestation.incomeApprovalFixtures.C34.dailyCashbookResponseDigest='c'.repeat(64)},r=>{r.cases[33].observed.dailyCashbookCalls=2},r=>{delete r.cases[33].observed.dailyCashbookCalls},r=>{delete r.cases[33].observed.dailyCashbookDigest},r=>{r.cases[33].observed.dailyCashbookCalls=0},r=>{r.cases[33].observed.rpcDigest=f.dailyCashbookResponseDigest},r=>{r.cases[33].observed.networkErrors=1}]){const bad=structuredClone(run);mutate(bad);assert.ok(evidence.validateBrowserRun(golden,manifest,bad).length);}
  const unused=structuredClone(run);unused.cases[33].observed.dailyCashbookCalls=0;delete unused.cases[33].observed.dailyCashbookDigest;assert.deepEqual(evidence.validateBrowserRun(golden,manifest,unused),[]);
  for(const id of ['C35','C36']) {
    const fixture=bindIncomeApprovalScenario(manifest.cases.find(c=>c.id===id),financialInput(id)).attestation;
    assert.throws(()=>evidence.createRun(golden,manifest,{...attestation,incomeApprovalFixtures:{[id]:{...fixture,dailyCashbookQueryDigest:f.dailyCashbookQueryDigest,dailyCashbookResponseDigest:f.dailyCashbookResponseDigest}}},[id]));
  }
});

const customerBinder=await import('../copilot-customer-fixtures.mjs');
test('customer evidence binds case, actor, context and every digest without widening retained schemas',()=>{
  for(const id of ['C02','C14']) {
    const scenario=manifest.cases.find(c=>c.id===id),contextId=attestation.contextId;
    const row={customer_id:'aaaa4000-0000-4000-8000-000000000071',customer_name:'Nguyễn An',phone:customerBinder.customerQuery('C14',contextId),contract_id:'10b1a785-6344-4598-812c-6dc6e98837ed',contract_number:'HD-GOLDEN',contract_status:'TERMINATED',room_id:'aaaa4000-0000-4000-8000-000000000073',room_name:'G701',building_id:'aaaa4000-0000-4000-8000-000000000074',building_name:'DEMO Toà A',is_representative:false};
    const ownership={kind:'owned-c02-v1',state:'ready',organizationId:evidence.DEMO_ORG,implementationSha:attestation.buildSha,customerId:row.customer_id,associationId:'aaaa4000-0000-4000-8000-000000000075',hostId:row.contract_id,roomId:row.room_id,buildingId:row.building_id,actorDigest:attestation.actorDigest,contextDigest:evidence.digest(contextId),phoneDigest:evidence.digest(row.phone),markerDigest:evidence.digest(`COPILOT_C02_${contextId}_${row.customer_id}`),hostDigest:digest,associationsDigest:digest,customerDigest:digest,associationDigest:digest,responseDigest:evidence.digest([row]),reviewDigest:digest};
    const bound=customerBinder.bindCustomerScenario(scenario,{query:customerBinder.customerQuery(id,contextId),contextId,actorDigest:attestation.actorDigest,payload:id==='C02'?[row]:[],ownership:id==='C02'?ownership:undefined});
    assert.equal(JSON.stringify(bound.attestation).includes(row.phone),false);
    const att={...attestation,customerFixtures:{[id]:bound.attestation}};
    const run=evidence.createRun(golden,manifest,att,[id]);
    evidence.transitionCase(run,id,{status:'running'});
    const observed={answerDigest:digest,promptDigest:evidence.digest(bound.prompt),promptTemplateDigest:evidence.digest(scenario.prompt),bindingDigest:bound.bindingDigest,rpcDigest:bound.attestation.responseDigest,fixtureDigest:bound.bindingDigest,queryDigest:bound.attestation.queryDigest,identityDigest:bound.attestation.identityDigest,responseDigest:bound.attestation.responseDigest,contextDigest:bound.attestation.contextDigest,modelRounds:2,toolResultLinked:true,finalAnswerMounted:true,readRpc:'copilot_customer_search_v1',businessWrites:0,networkErrors:0,oracleVersion:scenario.oracle};
    evidence.transitionCase(run,id,{status:'pass',timing:{startedAt:'2026-09-06T10:00:00.000Z',completedAt:'2026-09-06T10:00:01.000Z',totalMs:1000,humanWaitMs:0,processingMs:1000},observed});
    assert.deepEqual(evidence.validateBrowserRun(golden,manifest,run),[]);
    for(const key of ['fixtureDigest','queryDigest','identityDigest','responseDigest','contextDigest']) {
      const missing=structuredClone(run);delete missing.cases.find(c=>c.id===id).observed[key];assert.ok(evidence.validateBrowserRun(golden,manifest,missing).length);
      const wrong=structuredClone(run);wrong.cases.find(c=>c.id===id).observed[key]='c'.repeat(64);assert.ok(evidence.validateBrowserRun(golden,manifest,wrong).length);
    }
    for(const field of ['actorDigest','contextDigest','kind']) {
      const wrong=structuredClone(run);wrong.attestation.customerFixtures[id][field]=field==='kind'?(id==='C02'?'customer-absent':'customer-search'):'c'.repeat(64);assert.ok(evidence.validateBrowserRun(golden,manifest,wrong).length);
    }
    const wrong=structuredClone(run);wrong.cases.find(c=>c.id===id).observed.customerCalls=1;assert.ok(evidence.validateBrowserRun(golden,manifest,wrong).length);
    assert.equal(run.cases.length,75);assert.equal(run.cases.find(c=>c.id==='C01').status,'not_selected');assert.equal(run.cases.find(c=>c.id==='C13').status,'not_selected');
  }
});

test('customer attestation cannot relabel a nonempty payload as synthetic absence',()=>{
  const contextId=attestation.contextId,scenario=manifest.cases.find(c=>c.id==='C14');
  const bound=customerBinder.bindCustomerScenario(scenario,{query:customerBinder.customerQuery('C14',contextId),contextId,actorDigest:attestation.actorDigest,payload:[]});
  for(const field of ['queryDigest','identityDigest','responseDigest'])assert.throws(()=>evidence.createRun(golden,manifest,{...attestation,customerFixtures:{C14:{...bound.attestation,[field]:'c'.repeat(64)}}},['C14']));
});
