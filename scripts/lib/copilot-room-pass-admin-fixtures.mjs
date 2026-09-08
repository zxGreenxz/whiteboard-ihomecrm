// Administrative TEST fixtures only. Root reviews and injects Management transport.
// Product execute/preview/parent mutations continue using ordinary authenticated role.
import { randomUUID } from 'node:crypto';
import { DEMO, ACTION, PERMISSION, UUID, digest, requireThat, responseCode } from './copilot-room-pass-live.mjs';
import { sqlText, sqlUuid, sqlJson } from './copilot-room-pass-sessions.mjs';

const prefix = 'BEGIN; SET LOCAL statement_timeout=\'15s\'; SET LOCAL lock_timeout=\'10s\';';
function scope(run) { requireThat(run.organizationId === DEMO && UUID.test(run.actorId) && UUID.test(run.fixtures.building.id), 'admin_fixture_scope_invalid'); }

/** Exact action-row read only: authenticated has no SELECT privilege on flags. */
export async function readRoomPassFlag(management, context) {
  requireThat(context.organizationId === DEMO && UUID.test(context.actorId) && UUID.test(context.runId), 'flag_read_scope_invalid');
  const rows = await management.query(`SELECT to_jsonb(f) AS flag,
    (SELECT last_value FROM public.copilot_feature_rollout_revision_seq) AS "globalRevision"
    FROM public.copilot_feature_flags f WHERE f.scope='action' AND f.contract_id='room_pass.set_active'`);
  requireThat(rows.length === 1, 'flag_read_failed');
  return rows[0];
}

export async function actionSnapshot(runner, management, proposal = null) {
  scope(runner.run);
  const id = sqlUuid(runner.run.fixtures.listing.id), actor = sqlUuid(runner.run.actorId), org = sqlUuid(DEMO);
  if (proposal) requireThat(/^[0-9a-f]{64}$/.test(proposal.confirmation_nonce), 'nonce_invalid');
  const rows = await management.query(`SELECT
    (SELECT jsonb_build_object('id',l.id,'active',l.active,'building_id',l.building_id,'room_id',l.room_id)
      FROM public.room_pass_listings l WHERE l.id=${id} AND l.organization_id=${org}) AS listing,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'user_id',a.user_id,'organization_id',a.organization_id,
      'entity_id',a.entity_id,'idempotency_key',a.idempotency_key,'payload',a.payload) ORDER BY a.id),'[]'::jsonb)
      FROM public.ai_write_audit a WHERE a.entity_id=${id} AND a.organization_id=${org} AND a.tool=${sqlText(ACTION)}) AS audits,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'user_id',l.user_id,'organization_id',l.organization_id,
      'entity_id',l.entity_id,'audit_id',l.audit_id,'consent_id',l.consent_id,'event',l.event) ORDER BY l.id),'[]'::jsonb)
      FROM app_private.copilot_action_ledger l WHERE l.entity_id=${id} AND l.organization_id=${org}
        AND l.action_id=${sqlText(ACTION)} AND l.event='action_executed') AS ledger,
    ${proposal ? `(SELECT jsonb_build_object('id',c.id,'consumed',c.consumed_at IS NOT NULL,'expires_at',c.expires_at)
      FROM app_private.copilot_write_confirmations c WHERE c.nonce_digest=extensions.digest(decode(${sqlText(proposal.confirmation_nonce)},'hex'),'sha256')
        AND c.organization_id=${org} AND c.user_id=${actor} AND c.tool=${sqlText(ACTION)})` : 'NULL::jsonb'} AS consent;`);
  requireThat(rows.length === 1 && rows[0].listing && Array.isArray(rows[0].audits) && Array.isArray(rows[0].ledger), 'action_snapshot_invalid');
  const result = rows[0];
  runner.assertPrivate(result.audits);
  requireThat(result.audits.every(row => row.user_id === runner.run.actorId && row.organization_id === DEMO)
    && result.ledger.every(row => row.user_id === runner.run.actorId && row.organization_id === DEMO), 'audit_identity_invalid');
  return result; // Raw canonical/audit payload stays memory-only; persist digests/counts.
}

export function assertDeniedUnchanged(before, after, { listingMayChange = false } = {}) {
  requireThat((listingMayChange || digest(before.listing) === digest(after.listing))
    && digest(before.audits) === digest(after.audits) && digest(before.ledger) === digest(after.ledger)
    && after.consent?.id === before.consent?.id && after.consent?.consumed === false, 'denial_not_atomic');
}

export function assertLinkedExecution(before, after, result) {
  const audit = after.audits.filter(row => !before.audits.some(old => old.id === row.id));
  const ledger = after.ledger.filter(row => !before.ledger.some(old => old.id === row.id));
  requireThat(audit.length === 1 && ledger.length === 1 && audit[0].id === result.audit_id
    && ledger[0].id === result.ledger_id && ledger[0].audit_id === audit[0].id
    && ledger[0].consent_id === after.consent?.id && after.consent?.consumed === true
    && audit[0].idempotency_key === `copilot_action:${ACTION}:${after.consent.id}`, 'audit_ledger_linkage_invalid');
}

export async function createEmergencyFixture(runner, management, { permission = null, delayMs = 0, durationMs = 60_000 } = {}) {
  scope(runner.run);
  requireThat([null, PERMISSION, 'rooms.view'].includes(permission) && Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 30_000
    && Number.isInteger(durationMs) && durationMs >= 1_000 && durationMs <= 120_000, 'emergency_window_invalid');
  const id = randomUUID();
  const record = { id, organizationId: DEMO, permission, actorId: runner.run.actorId, reason: runner.run.marker,
    state: 'intent', delayMs, durationMs };
  (runner.run.emergencies ??= []).push(record); await runner.save();
  const rows = await runner.externalMutation('create_emergency', id, async () => ({ status: 200, body: await management.query(`${prefix}
    -- Scope an administrative test row; never edit pre-existing emergency rows.
    DO $owned$ BEGIN
      PERFORM 1 FROM public.buildings WHERE id=${sqlUuid(runner.run.fixtures.building.id)}
        AND organization_id=${sqlUuid(DEMO)} AND user_id=${sqlUuid(runner.run.actorId)} AND name=${sqlText(runner.run.marker)};
      IF NOT FOUND THEN RAISE EXCEPTION 'rp17_fixture_missing'; END IF;
      IF EXISTS(SELECT 1 FROM app_private.tenant_emergency_denies WHERE id=${sqlUuid(id)}) THEN RAISE EXCEPTION 'rp17_emergency_collision'; END IF;
    END $owned$;
    INSERT INTO app_private.tenant_emergency_denies(id,organization_id,permission_key,active_from,expires_at,reason,created_by)
    VALUES(${sqlUuid(id)},${sqlUuid(DEMO)},${permission === null ? 'NULL' : sqlText(permission)},
      clock_timestamp()+interval '${delayMs} milliseconds',clock_timestamp()+interval '${delayMs + durationMs} milliseconds',
      ${sqlText(runner.run.marker)},${sqlUuid(runner.run.actorId)});
    SELECT to_jsonb(d) AS row FROM app_private.tenant_emergency_denies d WHERE id=${sqlUuid(id)} AND organization_id=${sqlUuid(DEMO)};
    COMMIT;`) }));
  requireThat(responseCode(rows) === 'ok' && rows.body.length === 1, 'emergency_create_failed');
  record.row = rows.body[0].row; record.state = 'active'; await runner.save();
  return record;
}

export async function removeEmergencyFixture(runner, management, record) {
  scope(runner.run);
  requireThat(record.state === 'active' && record.row?.organization_id === DEMO && record.row.created_by === runner.run.actorId
    && record.row.reason === runner.run.marker && record.row.id === record.id, 'emergency_ownership_invalid');
  const response = await runner.externalMutation('delete_emergency', record.id, async () => ({ status: 200, body: await management.query(`${prefix}
    DO $cas$ DECLARE v app_private.tenant_emergency_denies%ROWTYPE; BEGIN
      SELECT * INTO v FROM app_private.tenant_emergency_denies WHERE id=${sqlUuid(record.id)} AND organization_id=${sqlUuid(DEMO)} FOR UPDATE;
      IF NOT FOUND OR to_jsonb(v) IS DISTINCT FROM ${sqlJson(record.row)} THEN RAISE EXCEPTION 'rp17_emergency_cas_failed'; END IF;
      DELETE FROM app_private.tenant_emergency_denies WHERE id=${sqlUuid(record.id)} AND organization_id=${sqlUuid(DEMO)};
    END $cas$;
    SELECT count(*)::int AS remaining FROM app_private.tenant_emergency_denies WHERE id=${sqlUuid(record.id)} AND organization_id=${sqlUuid(DEMO)};
    COMMIT;`) }));
  requireThat(response.body?.[0]?.remaining === 0, 'emergency_cleanup_failed');
  record.state = 'removed'; await runner.save();
}

export async function membershipSnapshot(runner, management) {
  const rows = await management.query(`SELECT m.id,m.user_id,m.organization_id,m.status,m.version,m.member_type,m.valid_from,m.valid_to,m.revoked_at,
    coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.role_bindings r WHERE r.membership_id=m.id),'[]'::jsonb) AS bindings,
    coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.role_binding_id,s.scope_id) FROM public.role_binding_scopes s
      JOIN public.role_bindings r ON r.id=s.role_binding_id WHERE r.membership_id=m.id),'[]'::jsonb) AS binding_scopes,
    coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM public.member_permission_overrides o
      WHERE o.membership_id=m.id AND o.revoked_at IS NULL),'[]'::jsonb) AS overrides,
    coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.override_id,s.scope_id) FROM public.member_override_scopes s
      JOIN public.member_permission_overrides o ON o.id=s.override_id WHERE o.membership_id=m.id AND o.revoked_at IS NULL),'[]'::jsonb) AS override_scopes
    FROM public.organization_memberships m WHERE m.organization_id=${sqlUuid(DEMO)} AND m.user_id=${sqlUuid(runner.run.actorId)} AND m.status='ACTIVE' AND m.revoked_at IS NULL;`);
  requireThat(rows.length === 1 && Number.isSafeInteger(rows[0].version), 'membership_snapshot_invalid'); return rows[0];
}

export async function withScopeRevocation(runner, management, adminTransport, adminActorId, work) {
  scope(runner.run);
  requireThat(UUID.test(adminActorId) && adminActorId !== runner.run.actorId, 'distinct_admin_required');
  const adminContext = { ...runner.context, actorId: adminActorId };
  const identity = await adminTransport.identity(adminContext);
  requireThat(identity.actorId === adminActorId && identity.organizationId === DEMO && identity.authenticated, 'admin_identity_invalid');
  const initial = await membershipSnapshot(runner, management);
  requireThat(initial.overrides.length === 0, 'existing_overrides_unsupported');
  // A narrow DENY removes ONLY this run's building. The other fresh owned
  // building remains authorized, proving IDs rather than scope cardinality.
  const scopeId = randomUUID();
  runner.run.ownedAuthorizationScope = { id: scopeId, buildingId: runner.run.fixtures.building.id, state: 'intent' }; await runner.save();
  const scopeCreated = await runner.externalMutation('create_authorization_scope', scopeId, async () => ({ status: 200, body: await management.query(`${prefix}
    DO $owned$ BEGIN
      PERFORM 1 FROM public.buildings WHERE id=${sqlUuid(runner.run.fixtures.building.id)} AND organization_id=${sqlUuid(DEMO)}
        AND user_id=${sqlUuid(runner.run.actorId)} AND name=${sqlText(runner.run.marker)} AND deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'rp17_fixture_missing'; END IF;
      IF EXISTS(SELECT 1 FROM public.authorization_scopes WHERE organization_id=${sqlUuid(DEMO)} AND building_id=${sqlUuid(runner.run.fixtures.building.id)})
        THEN RAISE EXCEPTION 'rp17_scope_collision'; END IF;
    END $owned$;
    INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id)
      VALUES(${sqlUuid(scopeId)},${sqlUuid(DEMO)},'BUILDING',${sqlUuid(runner.run.fixtures.building.id)});
    SELECT id FROM public.authorization_scopes WHERE id=${sqlUuid(scopeId)} AND organization_id=${sqlUuid(DEMO)};
    COMMIT;`) }));
  requireThat(scopeCreated.body?.[0]?.id === scopeId, 'building_scope_create_failed');
  runner.run.ownedAuthorizationScope.state = 'retained_for_override_history'; await runner.save();
  const reason = `${runner.run.marker}-deny`, expiresAt = new Date(Date.now() + 120_000).toISOString();
  const record = { membershipId: initial.id, before: initial, scopeId, scopeMode: 'SCOPED', reason, expiresAt, adminActorId, state: 'intent' };
  runner.run.scopeRevocation = record; await runner.save();
  const write = async (version, overrides) => runner.externalMutation('scope_override', initial.id, () => adminTransport.request(adminContext, {
    method: 'POST', rpc: 'update_member_authorization_v1', args: { p_membership: initial.id,
      p_expected_version: version, p_role_bindings: null, p_overrides: overrides, p_reason: reason },
  }));
  const unchanged = current => requireThat(digest({ ...current, version: initial.version, overrides: [], override_scopes: [] }) === digest(initial), 'membership_concurrent_change');
  try {
    const response = await write(initial.version, [{ permission_key: PERMISSION, effect: 'DENY', scope_mode: 'SCOPED',
      scope_ids: [scopeId], reason, expires_at: expiresAt }]);
    requireThat(responseCode(response) === 'ok', 'scope_revoke_failed');
    const current = await membershipSnapshot(runner, management); unchanged(current);
    requireThat(current.version === initial.version + 1 && current.overrides.length === 1
      && current.overrides[0].permission_key === PERMISSION && current.overrides[0].effect === 'DENY'
      && current.overrides[0].reason === reason && current.overrides[0].created_by === adminActorId
      && Date.parse(current.overrides[0].expires_at) === Date.parse(expiresAt)
      && current.override_scopes.length === 1 && current.override_scopes[0].scope_id === scopeId
      && current.override_scopes[0].override_id === current.overrides[0].id, 'scope_revoke_readback_failed');
    record.applied = current; record.state = 'active'; await runner.save();
    await work();
  } finally {
    // No restoration against a newer membership version, changed bindings or
    // overrides. Unknown request outcomes remain durable and block this write.
    const current = await membershipSnapshot(runner, management); unchanged(current);
    if (record.applied) {
      requireThat(digest(current) === digest(record.applied), 'scope_restore_cas_failed');
      requireThat(responseCode(await write(initial.version + 1, [])) === 'ok', 'scope_restore_failed');
      const restored = await membershipSnapshot(runner, management); unchanged(restored);
      requireThat(restored.version === initial.version + 2 && restored.overrides.length === 0, 'scope_restore_readback_failed');
      record.state = 'restored'; record.retainedRevokedOverrideId = record.applied.overrides[0].id; await runner.save();
    }
  }
}
