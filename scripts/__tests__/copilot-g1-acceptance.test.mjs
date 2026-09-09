import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import { G1_ROUTES, G1_CASES, DEMO, admissionDigest, validateAdmission, createReceipt, validateReceipt, addProof, pendingCases, digest, admissionFromBaseline, navigationEvidence, knowledgeEvidence, safeG1Failure } from '../lib/copilot-g1-acceptance.mjs';

const now = Date.parse('2026-09-09T01:00:00Z');
const actorId = '10000000-0000-4000-8000-000000000001';
test('acceptance destinations exactly cover the live source contract canonical routes', () => {
  const code = ts.transpileModule(readFileSync('src/app/capabilities/registry.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = { exports: {}, require: name => {
    assert.equal(name, '@/lib/network-center/runtime'); return { NETWORK_CENTER_RUNTIME_ENABLED: false };
  } };
  vm.runInNewContext(code, context);
  const contracts = context.exports.COPILOT_PAGE_CONTRACTS;
  const canonical = new Set(contracts.map(p => p.canonicalRoute ?? p.route));
  assert.equal(contracts.length >= 47, true);
  assert.deepEqual(new Set(G1_ROUTES.map(r => r.route)), canonical);
  for (const target of G1_ROUTES) assert.equal(contracts.some(c => c.key === target.key && c.route === target.route), true);
});
function admission() {
  return { sourceSha: 'a'.repeat(40), buildSha: 'a'.repeat(40), actorId, organizationId: DEMO,
    baseUrl: 'https://reviewed-preview.vercel.app', supabaseOrigin: 'https://project.supabase.co', model: '9router:ag/gemini-3.6-flash-high(high)',
    checkedAt: new Date(now).toISOString(), isSuperAdmin: true, authorizationOrganizationId: DEMO,
    flags: [...G1_ROUTES.map(r => r.key), 'copilot.navigation'].map(contract_id => ({ scope: 'page', contract_id,
      state: 'enabled', revision: 3, canary_org: DEMO, updated_by: actorId, expires_at: new Date(now + 3_600_000).toISOString() })),
    availableKeys: [...G1_ROUTES.map(r => `page:${r.key}`), 'page:copilot.navigation'],
  };
}
function routeProof(a, index = 0) {
  const r = G1_ROUTES[index];
  return { caseId: `route:${r.key}`, observedAt: new Date(now + 1000).toISOString(), admissionDigest: admissionDigest(a),
    blockedWrites: 0, route: r.route, clickedHref: r.route, tool: 'mo_trang', target: r.key,
    toolResultDigest: digest('real tool result'), streamDigest: digest('real stream'), toolResultObserved: true,
    rendered: true, heading: r.heading, buildSha: a.buildSha };
}
test('admission requires all nineteen exact page flags and independent navigation, DEMO sysadmin and expiry', () => {
  const a = admission(); validateAdmission(a, now);
  assert.equal(G1_ROUTES.length, 19); assert.equal(G1_CASES.length, 24);
  for (const mutate of [a => a.flags.pop(), a => a.flags.push(a.flags[0]), a => a.flags[0].canary_org = null,
    a => a.flags[0].state = 'shadow', a => a.flags[0].revision = 0,
    a => a.flags[0].expires_at = new Date(now - 1).toISOString(), a => a.flags[0].expires_at = new Date(now + 15 * 86_400_000).toISOString(),
    a => a.organizationId = actorId, a => a.authorizationOrganizationId = actorId, a => a.isSuperAdmin = false,
    a => a.availableKeys.pop(), a => a.buildSha = 'b'.repeat(40)]) {
    const bad = structuredClone(a); mutate(bad); assert.throws(() => validateAdmission(bad, now));
  }
});
test('Management baseline and live availability must agree, including actor, digest and global revision', () => {
  const a = admission(), availability = { actor_user_id: actorId, organization_id: DEMO, digest: 'c'.repeat(64), revision: 42,
    fetched_at: new Date(now).toISOString(), states: Object.fromEntries(a.availableKeys.map(k => [k, 'enabled'])) };
  const raw = JSON.stringify({ observedAt: new Date(now).toISOString(), actorId, flags: a.flags, availability });
  const got = admissionFromBaseline(a, raw, availability, { id: actorId }, true, { organizationId: DEMO }, now);
  assert.equal(got.flagEvidenceDigest, digest(raw));
  for (const change of [{ revision: 43 }, { actor_user_id: DEMO }, { digest: 'd'.repeat(64) }])
    assert.throws(() => admissionFromBaseline(a, raw, { ...availability, ...change }, { id: actorId }, true, { organizationId: DEMO }, now));
});
test('navigation evidence requires a current real tool call followed by its successful tool result', () => {
  const target = G1_ROUTES[0];
  const streams = [{ tools: [{ id: 'call-1', name: 'mo_trang', arguments: JSON.stringify({ trang: target.key }) }] }, { tools: [], finish: 'stop', text: '[Căn hộ](/apartments)' }];
  const rounds = [{ messages: [] }, { messages: [{ role: 'tool', tool_call_id: 'call-1', content: '[Căn hộ](/apartments)' }] }];
  assert.equal(navigationEvidence(streams, rounds, target).toolResultObserved, true);
  assert.throws(() => navigationEvidence(streams, [{ messages: [] }, { messages: [] }], target));
  assert.throws(() => navigationEvidence(streams, [{ messages: [] }, { messages: [{ role: 'tool', tool_call_id: 'call-1', content: 'Lỗi: không có quyền' }] }], target));
});
test('guide proof follows the actual human-readable citation, bound to tai_lieu and the rendered assistant', () => {
  const source = 'huong-dan-su-dung/03-quan-ly-van-hanh/hoa-don';
  const citation = '(nguồn: Hướng dẫn › Hoá đơn — danh sách & tạo lẻ § Cách làm việc)';
  assert.equal(readFileSync('docs/huong-dan-su-dung/03-quan-ly-van-hanh/hoa-don/index.md', 'utf8').includes('# Hoá đơn — danh sách & tạo lẻ'), true);
  const streams = [{ tools: [{ id: 'guide-1', name: 'huong_dan', arguments: JSON.stringify({ chu_de: 'lọc hoá đơn', tai_lieu: source }) }] }, { tools: [], finish: 'stop', text: `Dùng bộ lọc kỳ. ${citation}` }];
  const rounds = [{ messages: [] }, { messages: [{ role: 'tool', tool_call_id: 'guide-1', content: `${citation}\nDùng bộ lọc kỳ.` }] }];
  assert.equal(knowledgeEvidence(streams, rounds, source, `Dùng bộ lọc kỳ. ${citation}`).authorizedSource, true);
  assert.throws(() => knowledgeEvidence(streams, rounds, source, `User prompt mentions ${source} and nguồn only`));
  assert.throws(() => knowledgeEvidence([streams[0], { tools: [], finish: 'stop', text: 'Dùng bộ lọc kỳ.' }], rounds, source, citation));
  assert.throws(() => knowledgeEvidence(streams, [{ messages: [] }, { messages: [] }], source, citation));
});
test('failure diagnostics retain only bounded harness codes and timeout category, never raw errors', () => {
  assert.equal(safeG1Failure(new Error('g1_flag_baseline_drift')), 'g1_flag_baseline_drift');
  assert.equal(safeG1Failure({ name: 'TimeoutError', message: 'secret locator value' }), 'g1_browser_timeout');
  for (const message of ['Supabase error: Bearer PRIVATE', 'g1_error followed by PRIVATE', 'bad model transcript'])
    assert.equal(safeG1Failure(new Error(message)), 'g1_assertion_or_transport_failure');
});
test('resume retains passed proof bytes, skips only verified cases and rejects changed admission or forged labels', () => {
  const a = admission(), receipt = createReceipt(a, now);
  addProof(receipt, routeProof(a), now + 1000);
  const first = JSON.stringify(receipt.proofs[0]);
  validateReceipt(JSON.parse(JSON.stringify(receipt)), a, now + 2000);
  assert.equal(pendingCases(receipt).length, 23);
  assert.equal(pendingCases(receipt).includes(`route:${G1_ROUTES[0].key}`), false);
  assert.equal(JSON.stringify(receipt.proofs[0]), first);
  for (const mutate of [r => r.proofs[0].proof.rendered = false, r => r.proofs[0].proof.target = 'customers.list',
    r => r.proofs.push({ proof: { caseId: 'memory', status: 'pass' } }), r => r.proofs.push(r.proofs[0])]) {
    const bad = structuredClone(receipt); mutate(bad); assert.throws(() => validateReceipt(bad, a, now + 2000));
  }
  const changed = structuredClone(a); changed.flags[0].revision += 1;
  assert.throws(() => validateReceipt(receipt, changed, now + 2000));
});
test('navigation cannot be certified by page.goto, a fabricated answer link, or a blocked write', () => {
  const a = admission();
  for (const change of [{ toolResultObserved: false }, { tool: 'page.goto' }, { clickedHref: '/' }, { rendered: false }, { blockedWrites: 1 }]) {
    assert.throws(() => addProof(createReceipt(a, now), { ...routeProof(a), ...change }, now + 1000));
  }
});
test('mobile proof requires a real usable control, viewport, shared inset and no overlap; memory is explicitly read only', () => {
  const a = admission(), receipt = createReceipt(a, now);
  const base = { observedAt: new Date(now + 1000).toISOString(), admissionDigest: admissionDigest(a), blockedWrites: 0, buildSha: a.buildSha };
  const mobile = { ...base, caseId: 'mobile:rooms.list', marker: 'rooms.list.room.search', width: 375, height: 812,
    visibleCount: 1, editable: true, filledAndCleared: true, hitTest: true, fabOverlap: false, inset: 84, paddingBottom: 84 };
  for (const change of [{ filledAndCleared: false }, { hitTest: false }, { fabOverlap: true }, { paddingBottom: 0 }])
    assert.throws(() => addProof(createReceipt(a, now), { ...mobile, ...change }, now + 1000));
  addProof(receipt, mobile, now + 1000);
  addProof(receipt, { ...base, caseId: 'memory', scope: 'read-only-panel', rpcOrganizationId: DEMO, rpcActorId: actorId,
    listReadOk: true, panelVisible: true, itemCount: 0, deleteControlCount: 0 }, now + 1000);
  assert.equal(pendingCases(receipt).length, 22);
});
