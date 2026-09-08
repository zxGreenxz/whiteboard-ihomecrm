import { DEMO, PERMISSION, UUID, RoomPassRun, digest, requireThat, responseCode } from './copilot-room-pass-live.mjs';
import { membershipSnapshot, removeEmergencyFixture } from './copilot-room-pass-admin-fixtures.mjs';
import { sqlUuid, sqlText } from './copilot-room-pass-sessions.mjs';

async function terminal(runner, key, evidence) {
  requireThat(/^[0-9a-f]{64}$/.test(evidence?.[key]) && typeof runner.transport.verifyTerminal === 'function', 'terminal_evidence_required');
  requireThat(await runner.transport.verifyTerminal(runner.context, { operationId: key, evidenceDigest: evidence[key] }) === true, 'terminal_evidence_unverified');
}

async function recoverScope(runner, management, adminTransport) {
  const record = runner.run.scopeRevocation;
  if (!record || record.state === 'restored') return;
  const current = await membershipSnapshot(runner, management), initial = record.before;
  requireThat(digest({ ...current, version: initial.version, overrides: [], override_scopes: [] }) === digest(initial), 'membership_concurrent_change');
  if (current.overrides.length === 0 && [initial.version, initial.version + 2].includes(current.version)) {
    record.state = 'restored'; await runner.save(); return;
  }
  requireThat(current.version === initial.version + 1 && current.overrides.length === 1 && current.override_scopes.length === 1,
    'scope_recovery_cas_failed');
  const o = current.overrides[0];
  requireThat(o.organization_id === DEMO && o.membership_id === initial.id && o.created_by === record.adminActorId
    && o.reason === record.reason && o.permission_key === PERMISSION && o.effect === 'DENY' && o.scope_mode === record.scopeMode
    && Date.parse(o.expires_at) === Date.parse(record.expiresAt) && current.override_scopes[0].override_id === o.id
    && current.override_scopes[0].scope_id === record.scopeId, 'scope_recovery_ownership_invalid');
  if (record.applied) requireThat(digest(record.applied) === digest(current), 'scope_recovery_cas_failed');
  const context = { ...runner.context, actorId: record.adminActorId }, who = await adminTransport.identity(context);
  requireThat(who.actorId === record.adminActorId && who.organizationId === DEMO && who.authenticated, 'admin_identity_invalid');
  requireThat(responseCode(await runner.externalMutation('scope_override', initial.id, () => adminTransport.request(context, {
    method: 'POST', rpc: 'update_member_authorization_v1', args: { p_membership: initial.id, p_expected_version: initial.version + 1,
      p_role_bindings: null, p_overrides: [], p_reason: record.reason },
  }))) === 'ok', 'scope_restore_failed');
  const restored = await membershipSnapshot(runner, management);
  requireThat(restored.version === initial.version + 2 && digest({ ...restored, version: initial.version }) === digest(initial), 'scope_restore_readback_failed');
  record.state = 'restored'; record.retainedRevokedOverrideId = o.id; await runner.save();
}

/** Cleanup-only recovery. Never resumes acceptance, repeats setup, reuses a nonce,
 * or infers a server request is terminal from a missing row or a stale lock file.
 * Root supplies independently verified terminal receipts for uncertain handles.
 * The existing lease is retained until recovery has verified all effects/controls. */
export async function recoverRoomPassRun({ run, journalPath, transport, management, adminTransport, terminalEvidence }) {
  const runner = new RoomPassRun({ run, journalPath, transport });
  await terminal(runner, `operator:${run.runId}`, terminalEvidence);
  // Validate EVERY unknown handle first. No recovery write while another original
  // request could still arrive, even if one fixture's readback looks settled.
  for (const op of run.operations.filter(value => ['intent', 'unknown'].includes(value.state))) await terminal(runner, op.id, terminalEvidence);
  for (const s of run.scenarios.filter(value => ['intent', 'unknown'].includes(value.state))) await terminal(runner, `session:${s.name}`, terminalEvidence);
  if (run.browser && run.browser.state !== 'settled') await terminal(runner, `browser:${run.runId}`, terminalEvidence);
  for (const s of run.scenarios) if (['intent', 'unknown'].includes(s.state)) s.state = 'reconciled_terminal';
  if (run.browser) run.browser.state = 'settled';
  for (const op of run.operations.filter(value => ['intent', 'unknown'].includes(value.state))) {
    if (['create_emergency', 'delete_emergency', 'scope_override', 'plan_create', 'plan_approve', 'plan_execute', 'plan_cancel',
      'create_competitor', 'delete_competitor', 'restore_room_parent', 'create_authorization_scope'].includes(op.name)) {
      op.state = 'reconciled_terminal'; op.terminalEvidenceDigest = terminalEvidence[op.id];
    } else await runner.reconcileUnknown({ operationId: op.id, terminal: true, evidenceDigest: terminalEvidence[op.id] });
  }
  await runner.save();
  try {
    if (run.ownedAuthorizationScope) {
      const s = run.ownedAuthorizationScope;
      const rows = await management.query(`SELECT id,organization_id,scope_type,building_id FROM public.authorization_scopes
        WHERE id=${sqlUuid(s.id)} AND organization_id=${sqlUuid(DEMO)};`);
      requireThat(rows.length <= 1 && rows.every(row => row.scope_type === 'BUILDING' && row.building_id === run.fixtures.building.id), 'scope_recovery_ownership_invalid');
      s.state = rows.length ? 'retained_for_override_history' : 'absent';
    }
    await recoverScope(runner, management, adminTransport);
    for (const e of run.emergencies ?? []) {
      if (e.state === 'removed') continue;
      const rows = await management.query(`SELECT to_jsonb(d) AS row FROM app_private.tenant_emergency_denies d
        WHERE id=${sqlUuid(e.id)} AND organization_id=${sqlUuid(DEMO)};`);
      requireThat(rows.length <= 1, 'emergency_recovery_ambiguous');
      if (!rows.length) { e.state = 'removed'; continue; }
      const row = rows[0].row;
      requireThat(row.created_by === run.actorId && row.reason === run.marker && row.permission_key === e.permission
        && Date.parse(row.expires_at) > Date.parse(row.active_from)
        && Date.parse(row.expires_at) - Date.parse(row.active_from) <= e.durationMs + 100
        && Date.parse(row.active_from) - Date.parse(row.created_at) <= e.delayMs + 100, 'emergency_recovery_ownership_invalid');
      if (e.row) requireThat(digest(e.row) === digest(row), 'emergency_recovery_cas_failed');
      e.row = row; e.state = 'active'; await runner.save(); await removeEmergencyFixture(runner, management, e);
    }
    for (const plan of run.fixtures.plans) {
      const rows = await management.query(`SELECT p.id,p.status,p.organization_id,p.user_id,p.client_request_id,p.version,
        (SELECT count(*)::int FROM app_private.copilot_plan_steps s WHERE s.plan_id=p.id AND s.action_id='room_pass.set_active'
          AND s.canonical->>'listing_id'=${sqlText(run.fixtures.listing.id)}) AS owned_steps,
        (SELECT count(*)::int FROM app_private.copilot_plan_steps s WHERE s.plan_id=p.id) AS total_steps
        FROM app_private.copilot_plans p WHERE p.user_id=${sqlUuid(run.actorId)} AND p.organization_id=${sqlUuid(DEMO)}
          AND p.client_request_id=${sqlText(plan.clientRequestId)};`);
      requireThat(rows.length <= 1, 'plan_recovery_ambiguous');
      if (!rows.length) { requireThat(!plan.id, 'known_plan_missing'); plan.status = 'absent'; continue; }
      const row = rows[0];
      requireThat((!plan.id || plan.id === row.id) && row.owned_steps === 1 && row.total_steps === 1, 'plan_recovery_ownership_invalid');
      plan.id = row.id; await runner.save();
      if (['DRAFT', 'APPROVED'].includes(row.status)) {
        requireThat(responseCode(await runner.mutate('plan_cancel', row.id, { method: 'POST', rpc: 'copilot_plan_cancel_v1', args: {
          p_plan_id: row.id, p_expected_plan_version: row.version, p_reason: run.marker,
        } })) === 'ok', 'plan_cleanup_failed');
        const final = await runner.rpc('copilot_plan_get_v1', { p_plan_id: row.id });
        requireThat(responseCode(final) === 'ok' && final.body.plan_status === 'CANCELLED' && final.body.organization_id === DEMO, 'plan_cleanup_unverified');
      }
      plan.status = 'terminal';
    }
    if (run.scenarios.some(s => s.name === 'parent_relationship_race')) {
      const rooms = await runner.read('rooms', { id: run.fixtures.room.id }, 'id,building_id,organization_id,name,deleted_at');
      requireThat(rooms.length === 1 && rooms[0].name === run.marker
        && [run.fixtures.building.id, run.fixtures.scopeBuilding.id].includes(rooms[0].building_id), 'parent_recovery_ownership_invalid');
      if (rooms[0].building_id === run.fixtures.scopeBuilding.id) requireThat(responseCode(await runner.mutate('restore_room_parent', run.fixtures.room.id, {
        method: 'PATCH', table: 'rooms', filters: { id: run.fixtures.room.id, building_id: run.fixtures.scopeBuilding.id,
          organization_id: DEMO, name: run.marker }, body: { building_id: run.fixtures.building.id },
      })) === 'ok', 'parent_restore_failed');
    }
    if (run.fixtures.competitor && !run.fixtures.competitor.deleted) {
      const rows = await runner.read('room_pass_listings', { room_id: run.fixtures.room.id }, 'id,sale_policy,user_id,created_by,building_id,room_id,organization_id');
      const own = rows.filter(row => row.sale_policy === run.fixtures.competitor.marker);
      requireThat(own.length <= 1, 'competitor_recovery_ambiguous');
      if (own.length) {
        requireThat(own[0].user_id === run.actorId && own[0].created_by === run.actorId && own[0].building_id === run.fixtures.building.id
          && (!run.fixtures.competitor.id || run.fixtures.competitor.id === own[0].id), 'competitor_recovery_ownership_invalid');
        run.fixtures.competitor.id = own[0].id;
      } else run.fixtures.competitor.deleted = true;
    }
    // Re-enable only the same bounded DEMO canary if fresh compensation is needed.
    const listingRows = await runner.read('room_pass_listings', { room_id: run.fixtures.room.id }, 'id');
    if (listingRows.length) await runner.enable();
    await runner.cleanupFixtures();
    run.status = 'recovered'; run.fullAcceptance = false;
  } finally { await runner.restoreControl(); await runner.save(); }
  return { runId: run.runId, status: run.status, fullAcceptance: false, fixtureCleanup: run.fixtureCleanup,
    controlsRestored: run.controls?.restored === true, retainedLeaseForOperator: true };
}
