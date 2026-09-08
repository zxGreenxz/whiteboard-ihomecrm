/** Owned DEMO G3 fixtures. Import-safe; credentials and transports are supplied by the caller. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './copilot-golden-browser-evidence.mjs';
export const G3_DEMO = 'dddd0000-0000-4000-8000-000000000001';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const ensure = (ok, category) => { if (!ok) throw new Error(category); };
const copy = value => structuredClone(value);
const actions = n => n === 3 ? ['income_expense.create_draft', 'income_expense.nop_ho_so'] : ['income_expense.create_draft'];
const timestamp = value => Number.isFinite(Date.parse(value));
const freshAt = (value, start, now) => timestamp(value) && Date.parse(value) >= Date.parse(start) - 5000 && Date.parse(value) <= now + 5000;
const HISTORY_PROOF_KEYS = ['schemaVersion', 'attemptId', 'caseId', 'organizationId', 'planId', 'voucherId', 'phase', 'checkedAt', 'expectedSnapshotMatched', 'approvalVersion', 'postingVersion', 'ownershipVerified', 'postingHistoryComplete', 'zeroPostingHistory', 'noActivePosting', 'noRecognitionAdjustment', 'noUnexpectedFinancialLink', 'cancelledUnpostedVerified'];
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
function decimal15x2(value) {
  ensure(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9999999999999.99, 'g3_history_proof_invalid');
  const cents = Math.round(value * 100);
  ensure(Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) <= 1e-7, 'g3_history_proof_invalid');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
export function g3OwnershipDigest(voucher) {
  const item = Array.isArray(voucher?.items) && voucher.items.length === 1 ? voucher.items[0] : null;
  ensure(voucher && item && UUID.test(voucher.id) && UUID.test(voucher.organization_id) && UUID.test(voucher.user_id) && UUID.test(voucher.building_id) && UUID.test(item.id) && UUID.test(item.income_expense_type_id) && item.income_expense_id === voucher.id && item.description === voucher.name && item.quantity === 1 && item.unit_price === voucher.total_amount, 'g3_history_proof_invalid');
  return sha256(['g3-owned-v1', voucher.id, voucher.organization_id, voucher.user_id, voucher.name, voucher.type, decimal15x2(voucher.total_amount), voucher.building_id, voucher.voucher_date, item.income_expense_type_id, item.id, String(item.quantity), decimal15x2(item.unit_price)].join('|'));
}
export function g3StateDigest(voucher, ownershipDigest) {
  ensure(voucher && HASH.test(ownershipDigest) && Number.isSafeInteger(voucher.approval_version) && Number.isSafeInteger(voucher.posting_version), 'g3_history_proof_invalid');
  return sha256(['g3-owned-state-v1', ownershipDigest, voucher.approval_status, voucher.review_state, voucher.posting_status, voucher.cancellation_kind ?? '<null>', voucher.active_posting_id_v2 ?? '<null>', voucher.reversed_by_posting_id ?? '<null>', String(voucher.approval_version), String(voucher.posting_version)].join('|'));
}
function atomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`, fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export function createG3Attempt({ actorId, caseNo, sourceSha, buildSha, runId, runAttempt, workflow, attemptId = randomUUID(), startedAt = new Date().toISOString() }) {
  ensure(UUID.test(actorId) && UUID.test(attemptId) && [3, 8].includes(caseNo) && SHA.test(sourceSha) && SHA.test(buildSha) && /^[a-zA-Z0-9_-]{1,100}$/.test(runId) && /^[1-9][0-9]*$/.test(runAttempt) && workflow === 'copilot-e2e.yml' && timestamp(startedAt), 'g3_identity');
  return Object.freeze({ actorId, organizationId: G3_DEMO, caseNo, sourceSha, buildSha, runId, runAttempt, workflow, attemptId, startedAt, marker: `E2E G3 g3:${caseNo}:${attemptId}`, requestKey: `g3:${caseNo}:${attemptId}`, actions: actions(caseNo) });
}
export function validateG3Journal(j) {
  ensure(j?.version === 1 && digest(j.attempt) === digest(createG3Attempt(j.attempt)) && HASH.test(j.attemptDigest) && j.attemptDigest === digest(j.attempt), 'g3_journal_schema');
  const allowed = ['version', 'attempt', 'attemptDigest', 'state', 'operations', 'planId', 'voucherId', 'requestId', 'canonical', 'payloadDigest', 'voucherDigest', 'approvalVersion', 'postingVersion', 'requestVersion', 'terminal', 'history', 'business', 'lockReleased', 'receiptDigest', 'ownershipRejected'];
  ensure(Object.keys(j).every(k => allowed.includes(k)) && ['prepared', 'active', 'cleanup_pending', 'cleanup_unknown', 'finalized'].includes(j.state) && Array.isArray(j.operations) && j.operations.length <= 16, 'g3_journal_schema');
  for (const op of j.operations) ensure(Object.keys(op).every(k => ['kind', 'step', 'outcome', 'responseDigest'].includes(k)) && ['preview', 'plan_create', 'approve', 'execute', 'plan_cancel', 'withdraw', 'cancel'].includes(op.kind) && ['intent', 'success', 'rejected', 'unknown', 'reconciled'].includes(op.outcome) && (op.responseDigest === undefined || HASH.test(op.responseDigest)), 'g3_journal_schema');
  for (const op of j.operations) ensure(op.step === undefined || [1, 2].includes(op.step), 'g3_journal_schema');
  for (const k of ['lockReleased', 'ownershipRejected']) ensure(j[k] === undefined || typeof j[k] === 'boolean', 'g3_journal_schema');
  for (const k of ['planId', 'voucherId', 'requestId']) ensure(j[k] === undefined || UUID.test(j[k]), 'g3_journal_schema');
  if (j.canonical) validateCanonical(j.canonical, j.attempt);
  for (const k of ['payloadDigest', 'voucherDigest', 'receiptDigest']) ensure(j[k] === undefined || HASH.test(j[k]), 'g3_journal_schema');
  ensure(j.payloadDigest === undefined || j.payloadDigest === digest(j.canonical), 'g3_journal_schema');
  ensure(['not_run', 'passed', 'failed', 'interrupted'].includes(j.business), 'g3_journal_schema');
  for (const k of ['approvalVersion', 'postingVersion', 'requestVersion']) ensure(j[k] === undefined || Number.isSafeInteger(j[k]) && j[k] >= 1, 'g3_journal_schema');
  if (j.history) ensure(Object.keys(j.history).length === 3 && j.history.complete === true && HASH.test(j.history.authorityDigest) && HASH.test(j.history.proofDigest), 'g3_journal_schema');
  if (j.terminal) {
    const t = j.terminal;
    ensure(Object.keys(t).length === 10 && t.voucherId === j.voucherId && t.approvalStatus === 'CANCELLED' && t.reviewState === 'RESOLVED' && t.postingStatus === 'UNPOSTED' && t.cancellationKind === 'CANCELLED_UNPOSTED' && t.approvalVersion === j.approvalVersion + 1 && t.postingVersion === j.postingVersion && t.requestId === (j.requestId ?? null) && t.requestState === (j.requestId ? 'CANCELLED' : null) && HASH.test(t.voucherDigest), 'g3_journal_schema');
  }
  return j;
}
export function validateG3Receipt(j) {
  validateG3Journal(j);
  ensure(j.state === 'finalized' && j.lockReleased === true && j.operations.every(op => ['success', 'rejected', 'reconciled'].includes(op.outcome)), 'g3_receipt_unfinalized');
  const { receiptDigest, ...body } = j;
  ensure(receiptDigest === digest(body), 'g3_receipt_digest');
  if (j.voucherId) ensure(j.planId && HASH.test(j.payloadDigest) && HASH.test(j.voucherDigest) && j.terminal?.voucherId === j.voucherId && j.history?.complete === true && j.operations.some(op => op.kind === 'cancel'), 'g3_receipt_terminal');
  return j;
}
/** No stale lock stealing. An operator may quarantine a dead lock before SAME-attempt recovery. */
export function createG3FileStore({ directory }) {
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, 'lock.json'), journalPath = join(directory, 'journal.json');
  let token, releasedDigest;
  const load = () => existsSync(journalPath) ? validateG3Journal(JSON.parse(readFileSync(journalPath, 'utf8'))) : null;
  const assertOwner = () => ensure(token && JSON.parse(readFileSync(lock, 'utf8')).token === token, 'g3_lock_ownership');
  function acquire(recovery = false) {
    ensure(!token, 'g3_lock_owned'); const previous = load();
    if (recovery) ensure(previous && !(previous.state === 'finalized' && previous.lockReleased === true), 'g3_recovery_missing');
    else if (previous) validateG3Receipt(previous);
    const next = randomUUID(), fd = openSync(lock, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ token: next })); fsyncSync(fd); token = next; } finally { closeSync(fd); }
    if (!recovery && previous) renameSync(journalPath, join(directory, `journal-${previous.attempt.attemptId}.json`));
  }
  return { acquire: () => acquire(), acquireRecovery: () => acquire(true), assertOwner, load,
    save(j) { validateG3Journal(j); assertOwner(); atomic(journalPath, j); },
    release() { assertOwner(); const j = load(); ensure(j.state === 'finalized' && j.lockReleased === false, 'g3_release_pending'); releasedDigest = digest(j); unlinkSync(lock); token = undefined; },
    completeReleased(j) { ensure(!existsSync(lock) && releasedDigest && digest(load()) === releasedDigest, 'g3_release_changed'); validateG3Receipt(j); atomic(journalPath, j); releasedDigest = undefined; },
  };
}
function validateCanonical(c, a) {
  ensure(c && Object.keys(c).length === 7 && c.organization_id === G3_DEMO && c.type === 'EXPENSE' && c.name === a.marker && c.amount === 1000 && UUID.test(c.building_id) && UUID.test(c.type_id) && /^\d{4}-\d{2}-\d{2}$/.test(c.voucher_date), 'g3_payload');
}
function historyProofRequest(input) {
  const { attempt, planId, voucherId, ownershipDigest, stateDigest, approvalVersion, postingVersion, phase } = input ?? {};
  ensure(attempt && digest(attempt) === digest(createG3Attempt(attempt)) && UUID.test(planId) && UUID.test(voucherId) && HASH.test(ownershipDigest) && HASH.test(stateDigest) && Number.isSafeInteger(approvalVersion) && approvalVersion >= 1 && Number.isSafeInteger(postingVersion) && postingVersion >= 1 && ['before_cancel', 'cancelled'].includes(phase), 'g3_history_proof_invalid');
  return { p_organization_id: G3_DEMO, p_attempt_id: attempt.attemptId, p_case_id: attempt.caseNo, p_client_request_id: attempt.requestKey, p_plan_id: planId, p_voucher_id: voucherId, p_digest_schema_version: 1, p_expected_ownership_digest: ownershipDigest, p_expected_state_digest: stateDigest, p_expected_approval_version: approvalVersion, p_expected_posting_version: postingVersion, p_phase: phase };
}
function validateHistoryProof(value, input) {
  const request = historyProofRequest(input);
  ensure(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === HISTORY_PROOF_KEYS.length && HISTORY_PROOF_KEYS.every(key => Object.hasOwn(value, key)) && value.schemaVersion === 1 && value.attemptId === request.p_attempt_id && value.caseId === request.p_case_id && value.organizationId === request.p_organization_id && value.planId === request.p_plan_id && value.voucherId === request.p_voucher_id && value.phase === request.p_phase && timestamp(value.checkedAt) && value.expectedSnapshotMatched === true && value.approvalVersion === request.p_expected_approval_version && value.postingVersion === request.p_expected_posting_version && value.ownershipVerified === true && value.postingHistoryComplete === true && value.zeroPostingHistory === true && value.noActivePosting === true && value.noRecognitionAdjustment === true && value.noUnexpectedFinancialLink === true && value.cancelledUnpostedVerified === (request.p_phase === 'cancelled'), 'g3_history_proof_invalid');
  return value;
}
const rpcNames = new Set(['copilot_preview_income_expense_v1', 'copilot_plan_create_v1', 'copilot_plan_approve_v1', 'copilot_plan_execute_step_v1', 'copilot_plan_cancel_v1', 'copilot_plan_get_v1', 'copilot_ledger_audit_page_v1', 'copilot_g3_owned_voucher_history_proof_v1', 'withdraw_financial_request_v1', 'cancel_income_expense_flex_v1', 'get_income_expense_detail_v2', 'list_ie_accounting_standard_v1', 'list_my_pending_approvals_compat_v2', 'get_approval_request_detail_compat_v2']);
export function createG3AppClient({ apiOrigin, actorId, credentialProvider, fetch, readPending, readRequest, verifyHistory }) {
  ensure(new URL(apiOrigin).origin === apiOrigin && apiOrigin.startsWith('https://') && UUID.test(actorId), 'g3_transport_origin');
  async function transport(path, method, args) {
    const c = await credentialProvider();
    ensure(c?.actorId === actorId && typeof c.accessToken === 'string' && c.accessToken && typeof c.apikey === 'string' && c.apikey, 'g3_transport_actor');
    const r = await fetch(`${apiOrigin}/rest/v1/${path}`, { method, redirect: 'error', headers: { Authorization: `Bearer ${c.accessToken}`, apikey: c.apikey, 'Content-Type': 'application/json', 'Content-Profile': 'public', 'Accept-Profile': 'public' }, ...(args === undefined ? {} : { body: JSON.stringify(args) }) });
    try { return { status: r.status, body: await r.json() }; } catch { throw new Error('g3_transport_unknown'); }
  }
  async function rpc(name, args) { ensure(rpcNames.has(name), 'g3_rpc_not_allowed'); return transport(`rpc/${name}`, 'POST', args); }
  async function read(name, args) { const r = await rpc(name, args); ensure(r.status === 200 && r.body != null, 'g3_read_failed'); return r.body; }
  return { rpc,
    readPlan: planId => read('copilot_plan_get_v1', { p_plan_id: planId }),
    readVoucher: voucherId => read('get_income_expense_detail_v2', { p_id: voucherId }),
    readMode: () => read('list_ie_accounting_standard_v1', {}),
    readPending: readPending ?? (async voucherId => { const rows = await read('list_my_pending_approvals_compat_v2', {}); ensure(Array.isArray(rows), 'g3_pending_shape'); return rows.filter(r => r.subject_type === 'FINANCIAL_VOUCHER' && r.subject_id === voucherId); }),
    readRequest: readRequest ?? (requestId => read('get_approval_request_detail_compat_v2', { p_request_id: requestId })),
    async readAudit(voucherId) { ensure(UUID.test(voucherId), 'g3_read_id'); const r = await transport(`ai_write_audit?organization_id=eq.${G3_DEMO}&tool=eq.tao_phieu_thu_chi_nhap&entity_id=eq.${voucherId}&select=entity_id,entity_table,organization_id,user_id,payload`, 'GET'); ensure(r.status === 200 && Array.isArray(r.body), 'g3_audit_read'); return r.body; },
    // Complete posting/effect history is not established by an RLS-filtered postings SELECT.
    verifyHistory: verifyHistory ?? (async input => validateHistoryProof(await read('copilot_g3_owned_voucher_history_proof_v1', historyProofRequest(input)), input)),
    async discoverPlans(a) {
      const until = new Date().toISOString(), ids = new Set(), cursors = new Set(); let afterAt = null, afterId = null, count = 0, total;
      for (let page = 0; page < 100; page++) {
        const p = await read('copilot_ledger_audit_page_v1', { p_organization_id: G3_DEMO, p_since: a.startedAt, p_until: until, p_stream: 'ledger', p_after_at: afterAt, p_after_id: afterId, p_limit: 200 });
        ensure(p.version === 1 && Array.isArray(p.rows) && Number.isSafeInteger(p.total) && p.total >= 0 && (total === undefined || total === p.total), 'g3_discovery_incomplete'); total = p.total;
        for (const r of p.rows) { ensure(UUID.test(r.id) && timestamp(r.created_at) && !cursors.has(`${r.created_at}:${r.id}`) && r.organization_id === G3_DEMO, 'g3_discovery_cursor'); cursors.add(`${r.created_at}:${r.id}`); if (UUID.test(r.plan_id)) ids.add(r.plan_id); }
        count += p.rows.length;
        if (count === total) { const plans = []; for (const planId of ids) { const plan = await read('copilot_plan_get_v1', { p_plan_id: planId }); if (plan.client_request_id === a.requestKey) plans.push(plan); } return plans; }
        ensure(p.rows.length === 200 && count < total, 'g3_discovery_incomplete');
        // Keep the server timestamp string, including microseconds, unchanged.
        afterAt = p.rows.at(-1).created_at; afterId = p.rows.at(-1).id;
      }
      throw new Error('g3_discovery_incomplete');
    },
  };
}
export function openG3Lifecycle({ attempt, store, client, recovery = false, now = Date.now }) {
  ensure(digest(attempt) === digest(createG3Attempt(attempt)), 'g3_attempt');
  recovery ? store.acquireRecovery() : store.acquire();
  let j = recovery ? store.load() : { version: 1, attempt: copy(attempt), attemptDigest: digest(attempt), state: 'prepared', operations: [], business: recovery ? 'interrupted' : 'not_run' };
  ensure(j.attemptDigest === digest(attempt), 'g3_recovery_identity');
  if (recovery) { j.business = 'interrupted'; j.state = 'cleanup_unknown'; j.lockReleased = false; delete j.receiptDigest; }
  const pending = new Set(); let closing = false;
  const persist = () => store.save(j);
  async function verifyBoundHistory(voucher, phase) {
    const ownershipDigest = g3OwnershipDigest(voucher);
    const input = { attempt: copy(attempt), planId: j.planId, voucherId: j.voucherId, ownershipDigest, stateDigest: g3StateDigest(voucher, ownershipDigest), approvalVersion: voucher.approval_version, postingVersion: voucher.posting_version, phase };
    const history = await client.verifyHistory(input);
    validateHistoryProof(history, input);
    ensure(freshAt(history.checkedAt, new Date(now() - 60000).toISOString(), now()), 'g3_history_authority_required');
    return history;
  }
  persist();
  async function invoke(kind, name, args, step) {
    store.assertOwner(); const op = { kind, ...(step === undefined ? {} : { step }), outcome: 'intent' }; j.operations.push(op); persist();
    let result;
    try { result = await client.rpc(name, args); } catch { op.outcome = 'unknown'; persist(); throw new Error('g3_transport_unknown'); }
    op.outcome = result?.status === 200 ? 'success' : result?.body && /^[0-9A-Z]{5}$/.test(result.body.code) && result.status >= 400 && result.status < 500 ? 'rejected' : 'unknown';
    op.responseDigest = digest(result?.body ?? null);
    // Retain the exact response ID before any later read/assertion can throw. It is
    // only a candidate until authoritative plan/ledger + voucher binding succeeds.
    const entity = result?.status === 200 && kind === 'execute' ? result.body?.step?.outcome : null;
    if (entity && UUID.test(entity.entity_id)) {
      const key = step === 1 ? 'voucherId' : 'requestId', table = step === 1 ? 'income_expenses' : 'approval_requests';
      if (entity.entity_table !== table || j[key] && j[key] !== entity.entity_id) j.ownershipRejected = true;
      else j[key] = entity.entity_id;
    }
    persist(); return result;
  }
  function issue(operation) { if (recovery || closing || j.ownershipRejected) return Promise.reject(new Error('g3_writer_closed')); const p = operation(); pending.add(p); p.then(() => pending.delete(p), () => pending.delete(p)); return p; }
  function bindPlan(p, fresh = false) {
    ensure(p && UUID.test(p.plan_id) && p.organization_id === G3_DEMO && p.client_request_id === attempt.requestKey && p.step_count === attempt.actions.length && p.steps?.length === attempt.actions.length && p.steps.every((s, i) => s.step_no === i + 1 && s.action_id === attempt.actions[i] && (i === 0 ? s.ref_step == null : s.ref_step === 1)) && freshAt(p.created_at, attempt.startedAt, now()), 'g3_plan_ownership');
    if (fresh) ensure(p.da_ton_tai === false && p.plan_status === 'DRAFT' && p.plan_version === 1 && p.steps.every(s => s.status === 'PENDING' && s.outcome == null), 'g3_plan_not_fresh');
    ensure(!j.planId || j.planId === p.plan_id, 'g3_plan_changed'); j.planId = p.plan_id; persist();
    if (!fresh) {
      ensure(!p.steps.some(s => s.status === 'UNKNOWN_EFFECT') && !p.ledger?.some(r => r.event === 'step_unknown_effect'), 'g3_unknown_effect');
      const created = p.ledger?.filter(r => r.event === 'plan_created');
      ensure(created?.length === 1 && created[0].plan_id === j.planId && created[0].user_id === attempt.actorId && created[0].organization_id === G3_DEMO && created[0].outcome?.client_request_id === attempt.requestKey, 'g3_plan_actor');
      for (let i = 0; i < p.steps.length; i++) {
        const s = p.steps[i], key = i === 0 ? 'voucherId' : 'requestId', table = i === 0 ? 'income_expenses' : 'approval_requests';
        if (!s.outcome) { ensure(s.status !== 'DONE' && !j[key], 'g3_entity_missing'); continue; }
        ensure(s.status === 'DONE' && UUID.test(s.outcome.entity_id) && s.outcome.entity_table === table, 'g3_entity_ownership');
        const rows = p.ledger.filter(r => r.step_no === i + 1);
        ensure(rows.length === 1 && rows[0].event === 'step_done' && rows[0].plan_id === j.planId && rows[0].user_id === attempt.actorId && rows[0].organization_id === G3_DEMO && rows[0].entity_id === s.outcome.entity_id && rows[0].entity_table === table && rows[0].action_id === s.action_id && rows[0].outcome?.idempotent !== true, 'g3_entity_ledger');
        ensure(!j[key] || j[key] === s.outcome.entity_id, 'g3_entity_changed'); j[key] = s.outcome.entity_id; persist();
      }
    }
    return p;
  }
  async function capture() {
    const p = bindPlan(await client.readPlan(j.planId));
    if (j.voucherId) await ownedVoucher(false);
    if (j.requestId) { const r = await client.readRequest(j.requestId); validateRequest(r); if (j.requestVersion === undefined) { ensure(r.state === 'PENDING_APPROVAL', 'g3_request_state'); j.requestVersion = r.version; persist(); } }
    return p;
  }
  function validateRequest(r) { ensure(r?.id === j.requestId && r.subject_type === 'FINANCIAL_VOUCHER' && r.subject_id === j.voucherId && r.is_maker === true && r.can_decide === false && Number.isSafeInteger(r.version) && r.version >= 1, 'g3_request_ownership'); }
  function invariantVoucher(v) {
    const c = j.canonical;
    ensure(v && c && v.id === j.voucherId && v.organization_id === G3_DEMO && v.user_id === attempt.actorId && v.name === c.name && v.type === c.type && v.total_amount === c.amount && v.building_id === c.building_id && v.voucher_date === c.voucher_date && freshAt(v.created_at, attempt.startedAt, now()) && v.deleted_at === null && v.account_id === null && v.active_posting_id_v2 === null && v.reversed_by_posting_id === null && v.posting_status === 'UNPOSTED' && v.posting_mode === 'CASHBOOK' && ['contract_id', 'invoice_id', 'room_id', 'system_source', 'payment_id', 'payment_collection_id', 'salary_staff_id', 'shareholder_id', 'profit_manager_id', 'reversal_of_income_expense_id', 'handover_id', 'handover_transfer_id', 'posting_id', 'posted_at_v2'].every(k => v[k] === null) && v.repeat_cycle === 'NONE' && v.repeat_count === 0 && v.repeat_infinity === false && v.repeat_auto_approve === false && v.repeat_next_date === null && v.repeat_parent_id === null && v.repeat_remaining === 0, 'g3_voucher_ownership');
    ensure(Array.isArray(v.items) && v.items.length === 1 && v.items[0].income_expense_id === j.voucherId && v.items[0].organization_id === G3_DEMO && v.items[0].income_expense_type_id === c.type_id && v.items[0].description === c.name && v.items[0].quantity === 1 && v.items[0].unit_price === c.amount, 'g3_voucher_items');
    ensure(Number.isSafeInteger(v.approval_version) && Number.isSafeInteger(v.posting_version), 'g3_voucher_versions');
  }
  function stableVoucher(v) { const { approval_status, review_state, approval_version, cancellation_kind, updated_at, ...stable } = v; return stable; }
  async function ownedVoucher(terminalAllowed) {
    const v = await client.readVoucher(j.voucherId); invariantVoucher(v);
    if (!j.voucherDigest) {
      ensure(v.approval_status === 'UNAPPROVED' && v.approval_version === 1 && v.posting_version === 1, 'g3_voucher_initial');
      const audit = await client.readAudit(j.voucherId);
      ensure(audit?.length === 1 && audit[0].entity_id === j.voucherId && audit[0].entity_table === 'income_expenses' && audit[0].organization_id === G3_DEMO && audit[0].user_id === attempt.actorId && digest(audit[0].payload) === j.payloadDigest, 'g3_voucher_audit');
      j.voucherDigest = digest(stableVoucher(v)); j.approvalVersion = v.approval_version; j.postingVersion = v.posting_version; persist();
    }
    ensure(digest(stableVoucher(v)) === j.voucherDigest && v.posting_version === j.postingVersion, 'g3_voucher_changed');
    if (v.approval_status === 'CANCELLED' && terminalAllowed) ensure(v.review_state === 'RESOLVED' && v.cancellation_kind === 'CANCELLED_UNPOSTED' && v.approval_version === j.approvalVersion + 1, 'g3_terminal');
    else ensure(v.approval_status === 'UNAPPROVED' && v.approval_version === j.approvalVersion, 'g3_voucher_changed');
    return v;
  }
  async function finalReceipt() {
    j.state = 'finalized'; j.lockReleased = false; persist(); store.release();
    j.lockReleased = true; const { receiptDigest: ignored, ...body } = j; j.receiptDigest = digest(body); store.completeReleased(j); return copy(j);
  }
  const api = {
    journal: () => copy(j),
    create: () => issue(async () => {
      ensure(j.operations.length === 0, 'g3_create_once');
      const payload = { loai: 'CHI', so_tien: 1000, ten_phieu: attempt.marker, toa_nha: 'DEMO Toà A', hang_muc: 'Xử lý Bồn Cầu' };
      const preview = await invoke('preview', 'copilot_preview_income_expense_v1', { p_organization_id: G3_DEMO, p_payload: payload });
      ensure(preview.status === 200, 'g3_preview_failed'); validateCanonical(preview.body?.canonical, attempt); j.canonical = copy(preview.body.canonical); j.payloadDigest = digest(j.canonical); persist();
      const steps = [{ hanh_dong: attempt.actions[0], du_lieu: { ...payload, ngay: j.canonical.voucher_date } }, ...(attempt.caseNo === 3 ? [{ hanh_dong: attempt.actions[1], du_lieu: { $ref_step: 1 } }] : [])];
      const r = await invoke('plan_create', 'copilot_plan_create_v1', { p_organization_id: G3_DEMO, p_client_request_id: attempt.requestKey, p_steps: steps });
      ensure(r.status === 200, 'g3_create_failed');
      try { bindPlan(r.body, true); } catch { j.ownershipRejected = true; persist(); throw new Error('g3_plan_not_owned'); }
      j.state = 'active'; persist(); await capture(); return r;
    }),
    approve: ({ nonce, digest: planDigest, version, stepUpToken = null }) => issue(async () => { ensure(j.planId, 'g3_plan_missing'); const r = await invoke('approve', 'copilot_plan_approve_v1', { p_plan_id: j.planId, p_consent_nonce: nonce, p_plan_digest: planDigest, p_expected_plan_version: version, p_step_up_token: stepUpToken }); await capture(); return r; }),
    execute: (step, version) => issue(async () => { ensure(j.planId && Number.isInteger(step) && step >= 1 && step <= attempt.actions.length, 'g3_step'); const r = await invoke('execute', 'copilot_plan_execute_step_v1', { p_plan_id: j.planId, p_step_no: step, p_expected_plan_version: version, p_organization_id: G3_DEMO }, step); await capture(); return r; }),
    async executePair(step, version) { const outcomes = await Promise.allSettled([api.execute(step, version), api.execute(step, version)]); const failed = outcomes.filter(r => r.status === 'rejected'); if (failed.length) throw new AggregateError(failed.map(r => r.reason), 'g3_execute_transport'); return outcomes.map(r => r.value); },
    async cleanup() {
      closing = true; await Promise.allSettled([...pending]);
      if (j.state === 'finalized' && j.lockReleased) return validateG3Receipt(copy(j));
      try {
        store.assertOwner(); ensure(!j.ownershipRejected, 'g3_ownership_unresolved'); j.state = 'cleanup_pending'; persist();
        if (!j.planId && j.operations.some(op => op.kind === 'plan_create' && op.outcome !== 'rejected')) {
          const plans = await client.discoverPlans(attempt); ensure(plans.length === 1, 'g3_create_unresolved'); bindPlan(plans[0]);
        }
        let p = j.planId ? bindPlan(await client.readPlan(j.planId)) : null;
        for (const op of j.operations) if (['unknown', 'intent'].includes(op.outcome)) {
          const proven = op.kind === 'plan_create' && p || op.kind === 'execute' && p && (p.steps[op.step - 1]?.status === 'DONE' || ['DONE', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(p.plan_status)) || op.kind === 'approve' && p && p.plan_status !== 'DRAFT' || op.kind === 'plan_cancel' && p?.plan_status === 'CANCELLED';
          if (proven) op.outcome = 'reconciled';
          else ensure(['withdraw', 'cancel', 'plan_cancel'].includes(op.kind), 'g3_unsettled_write');
        }
        persist();
        if (p && ['DRAFT', 'APPROVED'].includes(p.plan_status)) {
          ensure(!j.operations.some(op => op.kind === 'plan_cancel'), 'g3_plan_cancel_unresolved');
          const r = await invoke('plan_cancel', 'copilot_plan_cancel_v1', { p_plan_id: j.planId, p_expected_plan_version: p.plan_version, p_reason: `G3 cleanup ${attempt.marker}` });
          ensure(r.status === 200 && r.body?.ok === true, 'g3_plan_cancel_failed'); p = bindPlan(await client.readPlan(j.planId)); ensure(p.plan_status === 'CANCELLED', 'g3_plan_cancel_readback');
        }
        if (p) ensure(['DONE', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(p.plan_status), 'g3_plan_executable');
        if (j.voucherId) {
          let v = await ownedVoucher(j.operations.some(op => op.kind === 'cancel'));
          const modes = await client.readMode(); ensure(Array.isArray(modes) && modes.filter(m => m.organization_id === G3_DEMO).length === 1 && modes.find(m => m.organization_id === G3_DEMO).strict_mode === false, 'g3_strict_mode');
          let requests = await client.readPending(j.voucherId); ensure(Array.isArray(requests) && requests.length <= 1 && requests.every(r => r.id === j.requestId), 'g3_request_extra');
          if (j.requestId) {
            let r = await client.readRequest(j.requestId); validateRequest(r); j.requestVersion ??= r.version; persist();
            const attempted = j.operations.find(op => op.kind === 'withdraw');
            if (r.state === 'PENDING_APPROVAL') {
              ensure(!attempted && requests.length === 1 && r.version === j.requestVersion, 'g3_request_changed');
              try { const result = await invoke('withdraw', 'withdraw_financial_request_v1', { p_request_id: j.requestId, p_reason: `G3 cleanup ${attempt.marker}` }); ensure(result.status === 200 && result.body?.request_id === j.requestId && result.body?.state === 'CANCELLED', 'g3_withdraw_response'); } catch (error) { if (j.operations.at(-1)?.outcome !== 'unknown') throw error; }
              r = await client.readRequest(j.requestId); validateRequest(r);
            }
            ensure(j.operations.some(op => op.kind === 'withdraw') && r.state === 'CANCELLED' && r.version === j.requestVersion + 1, 'g3_withdraw_readback');
            const op = j.operations.find(op => op.kind === 'withdraw'); if (op.outcome === 'unknown' || op.outcome === 'intent') op.outcome = 'reconciled';
            requests = await client.readPending(j.voucherId); ensure(requests.length === 0, 'g3_pending_after_withdraw'); persist();
          } else ensure(requests.length === 0, 'g3_request_unowned');
          v = await ownedVoucher(j.operations.some(op => op.kind === 'cancel'));
          const beforeHistory = v.approval_status === 'CANCELLED' ? null : await verifyBoundHistory(v, 'before_cancel');
          if (v.approval_status !== 'CANCELLED') {
            ensure(!j.operations.some(op => op.kind === 'cancel'), 'g3_cancel_unresolved');
            try { const r = await invoke('cancel', 'cancel_income_expense_flex_v1', { p_voucher: j.voucherId, p_reason: `G3 cleanup ${attempt.marker}`, p_expected_approval_version: j.approvalVersion, p_expected_posting_version: j.postingVersion }); ensure(r.status === 200 && r.body?.id === j.voucherId && r.body.changed === true && r.body.cancellation_kind === 'CANCELLED_UNPOSTED' && r.body.reversal_posting_id === null, 'g3_cancel_response'); } catch (error) { if (j.operations.at(-1)?.outcome !== 'unknown') throw error; }
          }
          v = await ownedVoucher(true); ensure(v.approval_status === 'CANCELLED', 'g3_cancel_readback');
          const op = j.operations.find(op => op.kind === 'cancel'); ensure(op, 'g3_cancel_not_owned'); if (['unknown', 'intent'].includes(op.outcome)) op.outcome = 'reconciled';
          j.terminal = { voucherId: j.voucherId, approvalStatus: v.approval_status, reviewState: v.review_state, postingStatus: v.posting_status, cancellationKind: v.cancellation_kind, approvalVersion: v.approval_version, postingVersion: v.posting_version, requestId: j.requestId ?? null, requestState: j.requestId ? 'CANCELLED' : null, voucherDigest: digest(v) }; persist();
          const terminalHistory = await verifyBoundHistory(v, 'cancelled');
          j.history = { complete: true, authorityDigest: digest(beforeHistory ?? terminalHistory), proofDigest: digest(terminalHistory) }; persist();
        }
        ensure(j.operations.every(op => ['success', 'rejected', 'reconciled'].includes(op.outcome)), 'g3_unsettled_write'); return await finalReceipt();
      } catch { j.state = 'cleanup_unknown'; j.lockReleased = false; delete j.receiptDigest; try { persist(); } catch { /* existing journal/lock or absent released receipt blocks admission */ } throw new Error('g3_cleanup_unresolved'); }
    },
    async run(business) {
      let failure, result; try { result = await business(); j.business = 'passed'; } catch (error) { failure = error; j.business = 'failed'; }
      try { await api.cleanup(); } catch { const cleanup = new Error('g3_cleanup_unresolved'); if (failure) throw new AggregateError([failure, cleanup], 'g3_business_and_cleanup_failed'); throw cleanup; }
      if (failure) throw failure; return result;
    },
  };
  return api;
}
