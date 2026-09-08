#!/usr/bin/env node
// Task17: only --prepare runs from the CLI. The reviewed root operator imports
// runRoomPassAcceptance with explicit transports and the real browser process.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DEMO, ACTION, UUID, RoomPassRun, RoomPassError, prepareRoomPassRun, digest, requireThat, responseCode } from './lib/copilot-room-pass-live.mjs';
import { actionSnapshot, assertDeniedUnchanged, assertLinkedExecution, createEmergencyFixture, removeEmergencyFixture,
  withScopeRevocation } from './lib/copilot-room-pass-admin-fixtures.mjs';
import { runLockCase } from './lib/copilot-room-pass-sessions.mjs';

export const REQUIRED_CASES = Object.freeze(['fresh_consent_toggles', 'nonce_replay', 'stale_second_nonce', 'aba', 'conflict_atomicity',
  'disallowed_role_preview', 'scope_revoked', 'other_building_scope', 'flag_revoked', 'global_emergency', 'scoped_emergency', 'future_emergency',
  'expired_emergency', 'unrelated_permission_emergency', 'plan_execute', 'plan_repreview', 'plan_cancel', 'browser_consent',
  'same_nonce_sessions', 'parent_relationship_race', 'listing_revision_race', 'nonce_expiry_wait', 'flag_expiry_wait',
  'global_emergency_wait', 'scoped_emergency_wait']);

async function record(runner, name, proof) {
  requireThat(REQUIRED_CASES.includes(name), 'case_invalid');
  (runner.run.results ??= []).push({ name, status: 'pass', ...proof }); await runner.save();
}
async function waitUntil(timestamp, progress = async () => {}) {
  requireThat(Number.isFinite(timestamp) && timestamp - Date.now() <= 305_000, 'wait_deadline_invalid');
  while (Date.now() < timestamp) {
    await progress({ phase: 'nonce_expiry_wait', remainingMs: Math.max(0, timestamp - Date.now()) });
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(15_000, Math.max(1, timestamp - Date.now()))));
  }
}
async function deny(runner, management, proposal, acceptedCodes) {
  const before = await actionSnapshot(runner, management, proposal);
  const response = await runner.execute(proposal);
  requireThat(acceptedCodes.includes(responseCode(response)), 'expected_denial_missing');
  assertDeniedUnchanged(before, await actionSnapshot(runner, management, proposal));
}

async function plans(runner, management) {
  const create = async kind => {
    const key = `${runner.run.marker}-${kind}`;
    const owned = { id: null, clientRequestId: key, status: 'intent' };
    runner.run.fixtures.plans.push(owned); await runner.save();
    const response = await runner.mutate('plan_create', key, { method: 'POST', rpc: 'copilot_plan_create_v1', args: {
      p_organization_id: DEMO, p_client_request_id: key,
      p_steps: [{ hanh_dong: ACTION, du_lieu: { listing_id: runner.run.fixtures.listing.id, active: true } }],
    } });
    requireThat(responseCode(response) === 'ok' && response.body.ok === true && response.body.client_request_id === key
      && response.body.da_ton_tai === false && UUID.test(response.body.plan_id)
      && response.body.organization_id === DEMO && /^[0-9a-f]{64}$/.test(response.body.consent_nonce), 'plan_create_failed');
    owned.id = response.body.plan_id; owned.status = 'created'; await runner.save(); return response.body;
  };
  const get = async id => {
    requireThat(runner.run.fixtures.plans.some(plan => plan.id === id), 'plan_not_owned');
    const result = await runner.rpc('copilot_plan_get_v1', { p_plan_id: id });
    requireThat(responseCode(result) === 'ok' && result.body.organization_id === DEMO && result.body.plan_id === id, 'plan_read_failed');
    return result.body;
  };
  for (const kind of ['plan_execute', 'plan_repreview', 'plan_cancel']) {
    await runner.domainSet(false);
    const plan = await create(kind);
    try {
      const read = await get(plan.plan_id);
      requireThat(read.plan_status === 'DRAFT' && !read.consent_nonce, 'plan_initial_state_invalid');
      const before = await actionSnapshot(runner, management);
      if (kind === 'plan_cancel') {
        requireThat(responseCode(await runner.mutate('plan_cancel', plan.plan_id, { method: 'POST', rpc: 'copilot_plan_cancel_v1',
          args: { p_plan_id: plan.plan_id, p_expected_plan_version: read.plan_version, p_reason: runner.run.marker } })) === 'ok', 'plan_cancel_failed');
        requireThat((await get(plan.plan_id)).plan_status === 'CANCELLED', 'plan_cancel_unverified');
        const after = await actionSnapshot(runner, management);
        requireThat(digest(before) === digest(after), 'plan_cancel_wrote_action');
      } else {
        const approval = await runner.mutate('plan_approve', plan.plan_id, { method: 'POST', rpc: 'copilot_plan_approve_v1', args: {
          p_plan_id: plan.plan_id, p_consent_nonce: plan.consent_nonce, p_plan_digest: plan.plan_digest,
          p_expected_plan_version: read.plan_version,
        } });
        requireThat(responseCode(approval) === 'ok' && approval.body.plan_status === 'APPROVED', 'plan_approval_failed');
        if (kind === 'plan_repreview') await runner.domainSet(false); // same active, new revision
        const version = approval.body.plan_version;
        const executed = await runner.mutate('plan_execute', plan.plan_id, { method: 'POST', rpc: 'copilot_plan_execute_step_v1', args: {
          p_plan_id: plan.plan_id, p_step_no: 1, p_expected_plan_version: version, p_organization_id: DEMO,
        } });
        const after = await actionSnapshot(runner, management), final = await get(plan.plan_id);
        if (kind === 'plan_repreview') {
          requireThat(responseCode(executed) === 'ok' && final.plan_status === 'FAILED'
            && final.steps?.[0]?.status === 'BLOCKED' && final.steps[0].error_code === 'payload_changed'
            && digest(before.listing) === digest(after.listing) && digest(before.audits) === digest(after.audits)
            && digest(before.ledger) === digest(after.ledger), 'plan_repreview_not_atomic');
        } else {
          const newAudits = after.audits.filter(a => !before.audits.some(b => a.id === b.id));
          const newLedger = after.ledger.filter(a => !before.ledger.some(b => a.id === b.id));
          requireThat(responseCode(executed) === 'ok' && final.plan_status === 'DONE' && final.steps?.[0]?.status === 'DONE'
            && after.listing.active === true && newAudits.length === 1 && newLedger.length === 1
            && newLedger[0].audit_id === newAudits[0].id, 'plan_execute_unverified');
          const replay = await runner.mutate('plan_execute', plan.plan_id, { method: 'POST', rpc: 'copilot_plan_execute_step_v1',
            args: { p_plan_id: plan.plan_id, p_step_no: 1, p_expected_plan_version: version, p_organization_id: DEMO } });
          requireThat(['plan_version_stale', 'plan_not_approved', 'plan_busy'].includes(responseCode(replay))
            && digest(after) === digest(await actionSnapshot(runner, management)), 'plan_replay_wrote_action');
        }
      }
      await record(runner, kind, { planId: plan.plan_id });
    } finally {
      const latest = await get(plan.plan_id);
      if (['DRAFT', 'APPROVED'].includes(latest.plan_status)) {
        requireThat(responseCode(await runner.mutate('plan_cancel', plan.plan_id, { method: 'POST', rpc: 'copilot_plan_cancel_v1',
          args: { p_plan_id: plan.plan_id, p_expected_plan_version: latest.plan_version, p_reason: runner.run.marker } })) === 'ok', 'plan_cleanup_failed');
        requireThat((await get(plan.plan_id)).plan_status === 'CANCELLED', 'plan_cleanup_unverified');
      }
    }
  }
}

/** This function does not count a local injected-transport test as live proof.
 * Root must supply source/build admission, ordinary authenticated transports,
 * reviewed administrative fixture transport and a terminal real browser result. */
export async function runRoomPassAcceptance({ run, journalPath, transport, management, adminTransport, adminActorId,
  disallowedTransport, disallowedActorId, browser, admission, progress = async () => {} }) {
  requireThat(admission?.reviewed === true && /^[0-9a-f]{40}$/.test(admission.sourceSha)
    && /^[0-9a-f]{40}$/.test(admission.buildSha) && admission.organizationId === DEMO
    && admission.actorId === run.actorId && admission.administrativeFixtureReviewed === true
    && typeof browser === 'function', 'live_admission_required');
  const runner = new RoomPassRun({ run, journalPath, transport });
  requireThat(UUID.test(disallowedActorId) && disallowedActorId !== run.actorId, 'disallowed_actor_required');
  const otherContext = { ...runner.context, actorId: disallowedActorId };
  const other = await disallowedTransport.identity(otherContext);
  requireThat(other.actorId === disallowedActorId && other.organizationId === DEMO && other.authenticated, 'disallowed_identity_invalid');
  const policy = await runner.rpc('get_copilot_action_policy_v1', {});
  const currentAuth = await runner.rpc('get_authorization_context_v1', { p_organization_id: DEMO });
  const otherAuth = await disallowedTransport.request(otherContext, { method: 'POST', rpc: 'get_authorization_context_v1', args: { p_organization_id: DEMO } });
  requireThat(responseCode(policy) === 'ok' && policy.body.allowed_roles?.includes('superadmin') && !policy.body.allowed_roles?.includes('owner')
    && responseCode(currentAuth) === 'ok' && currentAuth.body.isPlatformAdmin === true
    && currentAuth.body.permissions?.['sale_phong.manage_pass_listings'] === true
    && responseCode(otherAuth) === 'ok' && otherAuth.body.isPlatformAdmin === false
    && otherAuth.body.permissions?.['sale_phong.manage_pass_listings'] === true, 'role_policy_preflight_failed');
  await runner.acquireLease();
  run.admission = { sourceSha: admission.sourceSha, buildSha: admission.buildSha, organizationId: DEMO,
    actorId: run.actorId, reviewed: true, administrativeFixtureReviewed: true }; await runner.save();
  let failure = null;
  try {
    await runner.setup(); await runner.enable(); run.status = 'accepting'; await runner.save();
    for (const active of [true, false, true, false]) {
      const first = await runner.preview(active), second = await runner.preview(active);
      requireThat(digest(first.canonical) === digest(second.canonical) && first.confirmation_nonce !== second.confirmation_nonce, 'preview_nondeterministic');
      const before = await actionSnapshot(runner, management, first), result = await runner.execute(first);
      requireThat(responseCode(result) === 'ok', 'toggle_failed');
      const after = await actionSnapshot(runner, management, first); assertLinkedExecution(before, after, result.body);
      requireThat(responseCode(await runner.execute(first)) === 'confirmation_already_used'
        && digest(after) === digest(await actionSnapshot(runner, management, first)), 'replay_not_atomic');
      await deny(runner, management, second, ['payload_changed']);
    }
    for (const name of ['fresh_consent_toggles', 'nonce_replay', 'stale_second_nonce']) await record(runner, name, { count: 4 });
    const aba = await runner.preview(true); await runner.domainSet(true); await runner.domainSet(false);
    await deny(runner, management, aba, ['payload_changed']); await record(runner, 'aba', {});
    const conflict = await runner.preview(true); await runner.createCompetitor();
    try { await runner.domainSet(true, run.fixtures.competitor.id); await deny(runner, management, conflict, ['unique_conflict']); }
    finally { await runner.deleteCompetitor(); }
    await record(runner, 'conflict_atomicity', {});
    const deniedRole = await disallowedTransport.request(otherContext, { method: 'POST', rpc: 'copilot_preview_room_pass_active_v1',
      args: { p_organization_id: DEMO, p_payload: { listing_id: run.fixtures.listing.id, active: true } } });
    requireThat(responseCode(deniedRole) === 'not_permitted', 'role_boundary_missing'); await record(runner, 'disallowed_role_preview', {});
    const scoped = await runner.preview(true);
    await withScopeRevocation(runner, management, adminTransport, adminActorId, async () => {
      const auth = await runner.rpc('get_authorization_context_v1', { p_organization_id: DEMO });
      const scope = auth.body?.scopeSets?.[auth.body?.scopes?.['sale_phong.manage_pass_listings']];
      requireThat(responseCode(auth) === 'ok' && scope?.orgWide === false
        && !scope.buildingIds.includes(run.fixtures.building.id) && scope.buildingIds.includes(run.fixtures.scopeBuilding.id), 'building_scope_ids_unproven');
      const deniedPreview = await runner.mutate('preview_denied', run.fixtures.listing.id, { method: 'POST', rpc: 'copilot_preview_room_pass_active_v1',
        args: { p_organization_id: DEMO, p_payload: { listing_id: run.fixtures.listing.id, active: true } } });
      requireThat(responseCode(deniedPreview) === 'not_permitted', 'building_scope_preview_not_denied');
      await deny(runner, management, scoped, ['not_permitted']);
    });
    await record(runner, 'scope_revoked', {}); await record(runner, 'other_building_scope', {});
    const flag = await runner.preview(true); await runner.transitionFlag('disabled');
    try { await deny(runner, management, flag, ['copilot_action_disabled']); } finally { await runner.enable(); }
    await record(runner, 'flag_revoked', {});
    for (const [name, permission] of [['global_emergency', null], ['scoped_emergency', 'sale_phong.manage_pass_listings']]) {
      const proposal = await runner.preview(true), emergency = await createEmergencyFixture(runner, management, { permission });
      try { await deny(runner, management, proposal, ['tenant_emergency_denied', 'not_permitted']); }
      finally { await removeEmergencyFixture(runner, management, emergency); }
      await record(runner, name, {});
    }
    for (const [name, options] of [['future_emergency', { delayMs: 30_000 }], ['expired_emergency', { durationMs: 1_000 }],
      ['unrelated_permission_emergency', { permission: 'rooms.view' }]]) {
      const emergency = await createEmergencyFixture(runner, management, options);
      try {
        if (name === 'expired_emergency') await waitUntil(Date.parse(emergency.row.expires_at) + 100, progress);
        const result = await runner.execute(await runner.preview(false));
        requireThat(responseCode(result) === 'ok', 'emergency_exclusion_failed');
      } finally { await removeEmergencyFixture(runner, management, emergency); }
      await record(runner, name, {});
    }
    await plans(runner, management);
    await runner.enable({ renew: true });
    await runner.domainSet(false);
    const browserBefore = await actionSnapshot(runner, management);
    run.browser = { state: 'intent', runId: run.runId }; await runner.save();
    const receipt = await browser({ journalPath, runId: run.runId, actorId: run.actorId, listingId: run.fixtures.listing.id, sourceSha: admission.sourceSha, buildSha: admission.buildSha });
    if (receipt?.terminal === true) { run.browser.state = 'settled'; await runner.save(); }
    requireThat(receipt?.terminal === true && receipt.exitCode === 0 && receipt.runId === run.runId
      && receipt.buildSha === admission.buildSha && receipt.noWriteBeforeClick === true && receipt.noWriteOnCancel === true
      && receipt.executedOnce === true, 'browser_evidence_invalid');
    const browserAfter = await actionSnapshot(runner, management);
    const browserAudit = browserAfter.audits.filter(row => !browserBefore.audits.some(old => old.id === row.id));
    const browserLedger = browserAfter.ledger.filter(row => !browserBefore.ledger.some(old => old.id === row.id));
    requireThat(browserAfter.listing.active === true && browserAfter.audits.length === browserBefore.audits.length + 1
      && browserAfter.ledger.length === browserBefore.ledger.length + 1 && browserAudit.length === 1 && browserLedger.length === 1
      && browserLedger[0].audit_id === browserAudit[0].id && browserAudit[0].idempotency_key === `copilot_action:${ACTION}:${browserLedger[0].consent_id}`, 'browser_action_unverified');
    await record(runner, 'browser_consent', { buildSha: admission.buildSha });
    await runSessionCases(runner, management, progress);
    requireThat(digest((await runner.rpc('get_copilot_action_policy_v1', {})).body) === digest(policy.body), 'policy_changed_during_acceptance');
  } catch (error) {
    failure = 'acceptance_failed';
    run.failure = { code: error instanceof RoomPassError ? error.code : 'transport_or_operator_failed',
      lastOperation: run.operations.at(-1)?.name ?? 'preflight' };
  }
  finally {
    try { await runner.cleanupFixtures(); } catch { failure = 'cleanup_requires_recovery'; }
    try { await runner.restoreControl(); } catch { failure = 'control_requires_recovery'; }
    run.status = failure ?? 'accepted';
    run.fullAcceptance = !failure && REQUIRED_CASES.every(name => run.results?.some(result => result.name === name && result.status === 'pass'));
    if (!run.fullAcceptance && !failure) run.status = 'incomplete';
    await runner.save(); await runner.releaseLease();
  }
  return { runId: run.runId, status: run.status, fullAcceptance: run.fullAcceptance,
    passed: run.results?.map(result => result.name) ?? [], missing: REQUIRED_CASES.filter(name => !run.results?.some(result => result.name === name)),
    fixtureCleanup: run.fixtureCleanup ?? { status: 'pending' }, controlsRestored: run.controls?.restored === true };
}

async function runSessionCases(runner, management, progress) {
  await runner.enable({ renew: true });
  for (const [name, change, expected] of [['same_nonce_sessions', 'none', 'confirmation_already_used'],
    ['parent_relationship_race', 'room_parent_changed', 'entity_not_found'], ['listing_revision_race', 'listing_revision', 'payload_changed']]) {
    await runner.domainSet(false);
    const proposal = await runner.preview(true), before = await actionSnapshot(runner, management, proposal);
    try {
      const result = await runLockCase({ runner, transport: management, proposal, name, change, sameNonce: name === 'same_nonce_sessions' });
      requireThat(result.outcomes[0] === 'ok' && result.outcomes.at(-1) === expected, 'session_outcome_invalid');
      const after = await actionSnapshot(runner, management, proposal);
      if (name === 'same_nonce_sessions') {
        const audit = after.audits.find(row => !before.audits.some(old => old.id === row.id));
        const ledger = after.ledger.find(row => !before.ledger.some(old => old.id === row.id));
        requireThat(result.outcomes[1] === 'ok' && audit && ledger, 'same_nonce_not_atomic');
        assertLinkedExecution(before, after, { audit_id: audit.id, ledger_id: ledger.id });
      }
      else assertDeniedUnchanged(before, after);
      await record(runner, name, { barrier: result.barrier });
    } finally {
      if (change === 'room_parent_changed' && !runner.run.scenarios.some(s => s.state !== 'settled')) {
        requireThat(responseCode(await runner.mutate('restore_room_parent', runner.run.fixtures.room.id, { method: 'PATCH', table: 'rooms',
          filters: { id: runner.run.fixtures.room.id, building_id: runner.run.fixtures.scopeBuilding.id, organization_id: DEMO, name: runner.run.marker },
          body: { building_id: runner.run.fixtures.building.id } })) === 'ok', 'parent_restore_failed');
        await runner.ownedParents();
      }
    }
  }
  await runner.domainSet(false);
  const expiring = await runner.preview(true), expiryBefore = await actionSnapshot(runner, management, expiring);
  await waitUntil(Date.parse(expiryBefore.consent.expires_at) - 10_000, progress);
  const expiry = await runLockCase({ runner, transport: management, proposal: expiring, name: 'nonce_expiry_wait', seconds: 20 });
  requireThat(expiry.outcomes[1] === 'confirmation_expired', 'nonce_expiry_missing');
  assertDeniedUnchanged(expiryBefore, await actionSnapshot(runner, management, expiring));
  await record(runner, 'nonce_expiry_wait', { barrier: expiry.barrier });
  // Shadow is an allowed action state. Its short DEMO expiry starts before the
  // request; the acquired-lock barrier proves it expires while execute is waiting.
  await runner.transitionFlag('shadow', new Date(Date.now() + 12_000).toISOString());
  const flag = await runner.preview(true), flagBefore = await actionSnapshot(runner, management, flag);
  const flagWait = await runLockCase({ runner, transport: management, proposal: flag, name: 'flag_expiry_wait' });
  requireThat(flagWait.outcomes[1] === 'copilot_action_disabled', 'flag_expiry_missing');
  assertDeniedUnchanged(flagBefore, await actionSnapshot(runner, management, flag));
  await runner.transitionFlag('enabled', new Date(Date.now() + 900_000).toISOString());
  await record(runner, 'flag_expiry_wait', { barrier: flagWait.barrier });
  for (const [name, permission] of [['global_emergency_wait', null], ['scoped_emergency_wait', 'sale_phong.manage_pass_listings']]) {
    const proposal = await runner.preview(true), before = await actionSnapshot(runner, management, proposal);
    let emergency;
    try {
      const outcome = await runLockCase({ runner, transport: management, proposal, name, afterWait: async evidence => {
        emergency = await createEmergencyFixture(runner, management, { permission });
        requireThat(Date.parse(emergency.row.active_from) > Date.parse(evidence.executors[0].transactionStarted), 'emergency_boundary_unproven');
      } });
      requireThat(outcome.outcomes[1] === 'tenant_emergency_denied', 'emergency_wall_clock_missing');
      assertDeniedUnchanged(before, await actionSnapshot(runner, management, proposal));
      await record(runner, name, { barrier: outcome.barrier });
    } finally { if (emergency) await removeEmergencyFixture(runner, management, emergency); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--prepare' && process.argv.length === 5) {
    prepareRoomPassRun({ organizationId: DEMO, actorId: process.argv[4], journalPath: process.argv[3] })
      .then(run => console.log(JSON.stringify({ runId: run.runId, status: run.status, liveExecuted: false, requiredCases: REQUIRED_CASES.length })))
      .catch(() => { console.error('Task17 preparation failed'); process.exitCode = 1; });
  } else {
    console.log(JSON.stringify({ mode: 'dry-run', liveExecuted: false, requiredCases: REQUIRED_CASES,
      usage: 'node scripts/copilot-room-pass-live-acceptance.mjs --prepare <new-journal.json> <actor-uuid>' }));
  }
}
