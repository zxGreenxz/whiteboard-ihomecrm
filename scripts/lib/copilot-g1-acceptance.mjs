import { createHash, randomUUID } from 'node:crypto';

export const DEMO = 'dddd0000-0000-4000-8000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const requireThat = (ok, code) => { if (!ok) throw new Error(code); };
// Acceptance selectors, not a second product allowlist. A source-contract test
// requires exact correspondence with COPILOT_PAGE_CONTRACTS' canonical routes.
export const G1_ROUTES = [
  ['rooms.list', '/apartments', 'Căn hộ'], ['invoices.list', '/invoices', 'Quản lý Hoá đơn'],
  ['customers.list', '/customers', 'Quản lý Khách hàng'], ['buildings.list', '/buildings', 'Toà nhà'],
  ['services.list', '/services', 'Dịch vụ'], ['assets.list', '/assets', 'Quản lý Tài sản'],
  ['materials.list', '/materials', 'Kho vật tư'], ['vehicles.list', '/vehicles', 'Quản lý Phương tiện'],
  ['leads.list', '/leads', 'Quản lý Khách hẹn'], ['deposits.list', '/deposits', 'Quản lý Cọc'],
  ['contracts.list', '/contracts', 'Hợp đồng thuê'], ['income-expenses.list', '/income-expense', 'Thu chi'],
  ['cashbooks.list', '/finance/cashbooks', 'Sổ quỹ'], ['reports.finance', '/reports/finance', 'Báo cáo Tài chính'],
  ['reports.real-estate', '/reports/real-estate', 'Báo cáo Bất động sản'], ['meter-readings.list', '/meter-readings', 'Ghi chỉ số'],
  ['thu-tien.list', '/thu-tien', 'Thu tiền'], ['chat-zalo.list', '/chat-zalo', 'Chat Zalo'], ['tasks.list', '/tasks', 'Công việc'],
].map(([key, route, heading]) => ({ key, route, heading }));
export const MOBILE_MARKERS = { 'rooms.list': 'rooms.list.room.search', 'invoices.list': 'invoices.list.invoice.search', 'customers.list': 'customers.list.customer.search' };
export const G1_CASES = [...G1_ROUTES.map(r => `route:${r.key}`), ...Object.keys(MOBILE_MARKERS).map(k => `mobile:${k}`), 'knowledge', 'memory'];
export const G1_FLAG_KEYS = [...G1_ROUTES.map(r => r.key), 'copilot.navigation'];
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function normalizedAdmission(a) {
  return { sourceSha: a.sourceSha, buildSha: a.buildSha, actorId: a.actorId, organizationId: a.organizationId,
    baseUrl: a.baseUrl, supabaseOrigin: a.supabaseOrigin, model: a.model,
    flags: a.flags.map(f => ({ scope: f.scope, contract_id: f.contract_id, state: f.state, revision: f.revision,
      canary_org: f.canary_org, expires_at: new Date(f.expires_at).toISOString() })).sort((x, y) => x.contract_id.localeCompare(y.contract_id)) };
}
export const admissionDigest = a => digest(normalizedAdmission(a));
export function validateAdmission(a, now = Date.now()) {
  requireThat(a && SHA.test(a.sourceSha) && a.sourceSha === a.buildSha, 'g1_build_invalid');
  requireThat(UUID.test(a.actorId) && a.organizationId === DEMO && a.authorizationOrganizationId === DEMO
    && a.isSuperAdmin === true, 'g1_identity_invalid');
  requireThat(typeof a.model === 'string' && /^9router:ag\/gemini-[a-z0-9.()_-]+$/i.test(a.model), 'g1_model_invalid');
  for (const field of ['baseUrl', 'supabaseOrigin']) {
    const u = new URL(a[field]);
    requireThat(u.origin === a[field] && !u.username && !u.password && u.protocol === 'https:', 'g1_origin_invalid');
  }
  requireThat(!['ptcrm.vercel.app', 'chillhome.io.vn', 'www.chillhome.io.vn'].includes(new URL(a.baseUrl).hostname), 'g1_preview_required');
  requireThat(/^[a-z0-9-]+\.supabase\.co$/.test(new URL(a.supabaseOrigin).hostname), 'g1_supabase_origin_invalid');
  const checked = Date.parse(a.checkedAt);
  requireThat(Number.isFinite(checked) && checked <= now, 'g1_admission_time_invalid');
  requireThat(Array.isArray(a.flags) && a.flags.length === 20 && new Set(a.flags.map(f => f.contract_id)).size === 20, 'g1_flags_incomplete');
  for (const f of a.flags) requireThat(f.scope === 'page' && G1_FLAG_KEYS.includes(f.contract_id) && f.state === 'enabled'
    && Number.isSafeInteger(f.revision) && f.revision > 0 && f.canary_org === DEMO
    && Date.parse(f.expires_at) > now + 30_000 && Date.parse(f.expires_at) <= checked + 14 * 86_400_000, 'g1_flag_not_admitted');
  requireThat(Array.isArray(a.availableKeys) && G1_FLAG_KEYS.every(k => a.availableKeys.includes(`page:${k}`)), 'g1_availability_incomplete');
}
export function createReceipt(admission, now = Date.now()) {
  validateAdmission(admission, now);
  return { schemaVersion: 1, runId: randomUUID(), admission: structuredClone(admission), admissionDigest: admissionDigest(admission),
    createdAt: new Date(now).toISOString(), proofs: [], attempts: [], status: 'partial' };
}
function validateProof(p, a) {
  const at = Date.parse(p?.observedAt);
  requireThat(p && G1_CASES.includes(p.caseId) && p.admissionDigest === admissionDigest(a) && p.buildSha === a.buildSha
    && p.blockedWrites === 0 && Number.isFinite(at) && at >= Date.parse(a.checkedAt)
    && a.flags.every(f => at < Date.parse(f.expires_at)), 'g1_proof_admission_invalid');
  if (p.caseId.startsWith('route:')) {
    const route = G1_ROUTES.find(r => `route:${r.key}` === p.caseId);
    requireThat(p.route === route.route && p.clickedHref === route.route && p.target === route.key && p.tool === 'mo_trang'
      && p.toolResultObserved === true && p.rendered === true && p.heading === route.heading
      && HASH.test(p.toolResultDigest) && HASH.test(p.streamDigest), 'g1_route_proof_invalid');
  } else if (p.caseId.startsWith('mobile:')) {
    requireThat(p.marker === MOBILE_MARKERS[p.caseId.slice(7)] && p.width === 375 && p.height === 812 && p.visibleCount === 1
      && p.editable === true && p.filledAndCleared === true && p.hitTest === true && p.fabOverlap === false
      && Number.isFinite(p.inset) && p.inset >= 84 && p.paddingBottom >= p.inset, 'g1_mobile_proof_invalid');
  } else if (p.caseId === 'memory') {
    requireThat(p.scope === 'read-only-panel' && p.rpcOrganizationId === DEMO && p.rpcActorId === a.actorId && p.listReadOk === true
      && p.panelVisible === true && Number.isSafeInteger(p.itemCount) && p.itemCount >= 0 && p.deleteControlCount === p.itemCount, 'g1_memory_proof_invalid');
  } else {
    requireThat(p.tool === 'huong_dan' && p.toolResultObserved === true && p.authorizedSource === true && p.citationRendered === true
      && /^huong-dan-su-dung\/[a-z0-9/-]+$/.test(p.sourceKey) && HASH.test(p.toolResultDigest) && HASH.test(p.streamDigest), 'g1_knowledge_proof_invalid');
  }
}
export function validateReceipt(receipt, admission, now = Date.now()) {
  validateAdmission(admission, now);
  requireThat(receipt?.schemaVersion === 1 && UUID.test(receipt.runId) && Array.isArray(receipt.proofs)
    && Array.isArray(receipt.attempts) && ['partial', 'complete'].includes(receipt.status), 'g1_receipt_invalid');
  requireThat(receipt.admissionDigest === admissionDigest(receipt.admission)
    && receipt.admissionDigest === admissionDigest(admission), 'g1_resume_admission_changed');
  const seen = new Set();
  for (const entry of receipt.proofs) {
    validateProof(entry.proof, receipt.admission);
    requireThat(entry.digest === digest(entry.proof) && Date.parse(entry.proof.observedAt) <= now
      && !seen.has(entry.proof.caseId), 'g1_resume_proof_invalid');
    seen.add(entry.proof.caseId);
  }
  requireThat(receipt.status !== 'complete' || (seen.size === G1_CASES.length && receipt.attempts.at(-1)?.status === 'complete'
    && receipt.attempts.at(-1)?.blockedWrites === 0 && receipt.attempts.at(-1)?.networkFailures?.length === 0), 'g1_complete_without_proofs');
}
export function addProof(receipt, proof, now = Date.now()) {
  validateAdmission(receipt.admission, now); validateProof(proof, receipt.admission);
  requireThat(Date.parse(proof.observedAt) <= now && !receipt.proofs.some(e => e.proof.caseId === proof.caseId), 'g1_duplicate_or_future_proof');
  receipt.proofs.push({ proof: structuredClone(proof), digest: digest(proof) });
  // A last proof is not a completed attempt: background requests and teardown
  // must settle before the browser operator may set the final status.
  receipt.status = 'partial';
}
export const pendingCases = receipt => G1_CASES.filter(id => !receipt.proofs.some(e => e.proof.caseId === id));

/** Authenticated table SELECT is intentionally forbidden. Bind the operator's
 * Management SELECT to the live server digest/global revision instead. */
export function admissionFromBaseline(config, rawBaseline, availability, user, isSuperAdmin, authorization, now = Date.now()) {
  const baseline = JSON.parse(rawBaseline);
  requireThat(baseline.actorId === config.actorId && user?.id === config.actorId
    && baseline.availability?.actor_user_id === config.actorId && availability?.actor_user_id === config.actorId
    && availability?.organization_id === DEMO && baseline.availability?.organization_id === DEMO, 'g1_baseline_identity_invalid');
  requireThat(HASH.test(availability.digest) && availability.digest === baseline.availability.digest
    && availability.revision === baseline.availability.revision && Number.isSafeInteger(availability.revision), 'g1_flag_baseline_drift');
  const observed = Date.parse(baseline.observedAt), fetched = Date.parse(availability.fetched_at);
  requireThat(observed <= now && now - observed < 3_600_000 && fetched <= now && now - fetched < 60_000, 'g1_baseline_stale');
  const admission = { ...config, checkedAt: new Date(now).toISOString(), isSuperAdmin,
    authorizationOrganizationId: authorization?.organizationId,
    flags: baseline.flags.filter(f => f.scope === 'page' && G1_FLAG_KEYS.includes(f.contract_id)),
    availableKeys: Object.entries(availability.states ?? {}).filter(([, s]) => s === 'enabled').map(([key]) => key),
    flagEvidenceDigest: digest(rawBaseline), flagEvidenceObservedAt: baseline.observedAt,
    availabilityDigest: availability.digest, availabilityRevision: availability.revision };
  validateAdmission(admission, now); return admission;
}
export function navigationEvidence(streams, rounds, target) {
  requireThat(streams.at(-1)?.finish === 'stop', 'g1_navigation_model_unfinished');
  for (let index = 0; index < streams.length; index++) {
    for (const call of streams[index].tools ?? []) {
      if (call.name !== 'mo_trang') continue;
      let args; try { args = JSON.parse(call.arguments); } catch { continue; }
      if (args.trang !== target.key || !call.id) continue;
      const result = rounds.slice(index + 1).flatMap(r => r.messages).find(m => m.role === 'tool' && m.tool_call_id === call.id);
      if (typeof result?.content !== 'string' || !result.content.includes(`](${target.route})`) || /lỗi|error|not_permitted|không có quyền/i.test(result.content)) continue;
      return { tool: 'mo_trang', target: target.key, toolResultObserved: true, toolResultDigest: digest(result.content), streamDigest: digest(streams) };
    }
  }
  throw new Error('g1_navigation_tool_result_missing');
}
