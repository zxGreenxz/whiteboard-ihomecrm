import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const DEMO = 'dddd0000-0000-4000-8000-000000000001';
const check = (condition, message) => { if (!condition) throw new Error(message); };

/**
 * Transport owns authentication and authoritative visibility. readSnapshot returns:
 * {authoritative:true, membership:{id,user_id,organization_id,member_type,status,version},
 * organizationScope:{id,organization_id,scope_type}, roleBindings:[complete binding +
 * scope rows in stable order], unrevokedOverrides:[{id,organization_id,membership_id,
 * permission_key,effect,scope_mode,reason,expires_at,created_by,revoked_at,scope_ids}]}.
 * Include ALL unrevoked overrides, even expired; never use a filtered detail RPC.
 * updateAuthorization calls update_member_authorization_v1 with the exact p_ args
 * and returns its raw JSON on success, throwing on transport/RPC failure.
 * run must resolve only after the selected acceptance assertions finish (no background
 * assertions). Expiry bounds impact; it does not prove cleanup or acceptance success.
 */
export async function withDemoDenyFixture({ target, adminUserId, transport, run, now = Date.now }) {
  check(target?.membershipId && target?.userId && adminUserId && target.userId !== adminUserId, 'Invalid target/admin identity');
  function identity(s) {
    const m = s?.membership;
    check(s?.authoritative === true && m?.id === target.membershipId && m.user_id === target.userId
      && m.organization_id === DEMO && ['STAFF', 'PARTNER'].includes(m.member_type)
      && m.status === 'ACTIVE' && Number.isSafeInteger(m.version) && m.version >= 0,
    'Unverified DEMO membership identity/status/version');
    check(s.organizationScope?.id && s.organizationScope.organization_id === DEMO
      && s.organizationScope.scope_type === 'ORGANIZATION'
      && Array.isArray(s.roleBindings) && Array.isArray(s.unrevokedOverrides), 'Unverified scope/complete snapshot');
  }
  const initial = structuredClone(await transport.readSnapshot());
  identity(initial);
  check(initial.unrevokedOverrides.length === 0, 'Existing unrevoked override (including expired)');
  const originalVersion = initial.membership.version;
  check(originalVersion < Number.MAX_SAFE_INTEGER - 2, 'Version overflow');
  const reason = `copilot-ca3b-explicit-deny:${randomUUID()}`;
  const expiresAt = new Date(now() + 120_000).toISOString();
  const override = { permission_key: 'income_expenses.edit', effect: 'DENY', scope_mode: 'ORGANIZATION',
    scope_ids: [initial.organizationScope.id], reason, expires_at: expiresAt };
  const evidence = { variant: 'explicit-deny', reason, expiresAt, membershipId: target.membershipId,
    originalVersion, appliedVersion: originalVersion + 1 };
  let ownedRow;
  function unchanged(s) {
    identity(s);
    check(isDeepStrictEqual({ ...s.membership, version: originalVersion }, initial.membership)
      && isDeepStrictEqual(s.organizationScope, initial.organizationScope)
      && isDeepStrictEqual(s.roleBindings, initial.roleBindings), 'Membership/roles/scope changed');
  }
  function owned(s) {
    unchanged(s);
    const o = s.unrevokedOverrides[0];
    check(s.membership.version === originalVersion + 1 && s.unrevokedOverrides.length === 1
      && typeof o?.id === 'string' && o.id.length > 0 && o.organization_id === DEMO
      && o.membership_id === target.membershipId && o.created_by === adminUserId && o.revoked_at === null
      && o.permission_key === override.permission_key && o.effect === override.effect
      && o.scope_mode === override.scope_mode && o.reason === reason
      && Date.parse(o.expires_at) === Date.parse(expiresAt)
      && isDeepStrictEqual(o.scope_ids, override.scope_ids), 'State is not the exact owned DENY/version');
    if (evidence.overrideId) check(o.id === evidence.overrideId, 'Owned override ID changed');
    if (ownedRow) check(isDeepStrictEqual(o, ownedRow), 'Owned override content changed');
    else ownedRow = structuredClone(o);
    return o.id;
  }
  function response(r, version) {
    check(r?.membershipId === target.membershipId && r.version === version, 'Malformed authorization response');
  }
  const write = (version, overrides) => transport.updateAuthorization({ p_membership: target.membershipId,
    p_expected_version: version, p_role_bindings: null, p_overrides: overrides, p_reason: reason });
  let result;
  let failure;
  try {
    response(await write(originalVersion, [override]), originalVersion + 1);
    evidence.overrideId = owned(await transport.readSnapshot());
    check(now() < Date.parse(expiresAt), 'DENY expired before callback');
    result = await run(Object.freeze({ ...evidence }));
    owned(await transport.readSnapshot());
    check(now() < Date.parse(expiresAt), 'DENY expired during callback');
  } catch (error) { failure = error; }
  finally {
    try {
      // Also recovers an apply whose response was lost: never adopt a newer CAS.
      const current = await transport.readSnapshot();
      unchanged(current);
      if (!(current.membership.version === originalVersion && current.unrevokedOverrides.length === 0)) {
        evidence.overrideId = owned(current);
        response(await write(originalVersion + 1, []), originalVersion + 2);
        const restored = await transport.readSnapshot();
        unchanged(restored);
        check(restored.membership.version === originalVersion + 2 && restored.unrevokedOverrides.length === 0,
          'Cleanup readback failed');
        evidence.restoredVersion = restored.membership.version;
      }
    } catch (error) {
      const cleanup = new Error('DENY fixture cleanup failed; owned state was not safely restored', { cause: error });
      throw failure ? new AggregateError([failure, cleanup], 'Acceptance and cleanup failed') : cleanup;
    }
  }
  if (failure) throw failure;
  check(evidence.restoredVersion === originalVersion + 2, 'Cleanup lifecycle incomplete');
  return { result, evidence };
}
