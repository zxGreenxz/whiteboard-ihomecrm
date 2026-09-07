import test from 'node:test';
import assert from 'node:assert/strict';
import { withDemoDenyFixture } from '../copilot-demo-deny-fixture.mjs';

const org = 'dddd0000-0000-4000-8000-000000000001';
function fixture() {
  let time = Date.parse('2026-09-07T06:00:00Z');
  const state = { authoritative: true,
    membership: { id: 'member', user_id: 'target', organization_id: org, member_type: 'STAFF', status: 'ACTIVE', version: 3 },
    organizationScope: { id: 'scope', organization_id: org, scope_type: 'ORGANIZATION' },
    roleBindings: [{ id: 'binding', scope_ids: ['building'] }], unrevokedOverrides: [] };
  const calls = [];
  const transport = {
    async readSnapshot() { return structuredClone(state); },
    async updateAuthorization(args) {
      calls.push(structuredClone(args));
      assert.equal(args.p_membership, 'member');
      assert.equal(args.p_role_bindings, null);
      if (args.p_expected_version !== state.membership.version) throw new Error('40001');
      state.membership.version++;
      state.unrevokedOverrides = args.p_overrides.map(o => ({ ...o, id: 'owned-id', organization_id: org, membership_id: 'member', created_by: 'admin', revoked_at: null }));
      return { membershipId: 'member', version: state.membership.version };
    },
  };
  const options = { target: { membershipId: 'member', userId: 'target' }, adminUserId: 'admin', transport, now: () => time, run: async () => 'accepted' };
  return { state, calls, transport, options, expire() { time += 120_000; } };
}
test('verified DENY runs and restores original roles with monotonic CAS', async () => {
  const f = fixture();
  f.options.run = async e => { assert.equal(e.variant, 'explicit-deny'); assert.equal(f.state.unrevokedOverrides[0].effect, 'DENY'); return 'accepted'; };
  const out = await withDemoDenyFixture(f.options);
  assert.equal(out.result, 'accepted');
  assert.equal(out.evidence.restoredVersion, 5);
  assert.equal(out.evidence.overrideId, 'owned-id');
  assert.deepEqual(f.calls.map(c => c.p_expected_version), [3, 4]);
  assert.deepEqual(f.state.unrevokedOverrides, []);
});
test('callback failure restores and propagates', async () => {
  const f = fixture(); f.options.run = async () => { throw new Error('assertion failed'); };
  await assert.rejects(withDemoDenyFixture(f.options), /assertion failed/);
  assert.deepEqual(f.state.unrevokedOverrides, []); assert.equal(f.calls.length, 2);
});
for (const [name, mutate] of [
  ['expired unrevoked override', f => f.state.unrevokedOverrides.push({ expires_at: '2000-01-01' })],
  ['wrong org', f => { f.state.membership.organization_id = 'real'; }],
  ['owner', f => { f.state.membership.member_type = 'OWNER'; }],
  ['self', f => { f.options.adminUserId = 'target'; }],
  ['unproven visibility', f => { f.state.authoritative = false; }],
  ['wrong scope', f => { f.state.organizationScope.organization_id = 'real'; }],
]) test(`rejects ${name} before any write`, async () => {
  const f = fixture(); mutate(f); await assert.rejects(withDemoDenyFixture(f.options)); assert.equal(f.calls.length, 0);
});
test('stale apply CAS never falls back to a newer version', async () => {
  const f = fixture(); const write = f.transport.updateAuthorization;
  f.transport.updateAuthorization = async a => { f.state.membership.version++; return write(a); };
  await assert.rejects(withDemoDenyFixture(f.options)); assert.equal(f.calls.length, 1);
});
test('ambiguous applied response is recovered by marker and cleaned without running case', async () => {
  const f = fixture(); const write = f.transport.updateAuthorization;
  f.transport.updateAuthorization = async a => { const out = await write(a); if (a.p_overrides.length) throw new Error('response lost'); return out; };
  f.options.run = async () => assert.fail('must not run after ambiguous response');
  await assert.rejects(withDemoDenyFixture(f.options), /response lost/);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.state.unrevokedOverrides, []);
});
test('failed apply with original state makes no cleanup write', async () => {
  const f = fixture(); f.transport.updateAuthorization = async () => { throw new Error('unavailable'); };
  await assert.rejects(withDemoDenyFixture(f.options), /unavailable/); assert.equal(f.state.membership.version, 3);
});
for (const mutate of [f => { f.state.membership.version++; }, f => { f.state.unrevokedOverrides[0].reason = 'someone else'; }, f => { f.state.roleBindings[0].scope_ids.push('other'); }]) {
  test('concurrent version, ownership or role change blocks restoration', async () => {
    const f = fixture(); f.options.run = async () => { mutate(f); throw new Error('case failed'); };
    await assert.rejects(withDemoDenyFixture(f.options), e => e instanceof AggregateError && e.errors.some(x => /cleanup/i.test(x.message)));
    assert.equal(f.calls.length, 1); assert.equal(f.state.unrevokedOverrides.length, 1);
  });
}
test('malformed successful response fails but recovers owned cleanup', async () => {
  const f = fixture(); const write = f.transport.updateAuthorization;
  f.transport.updateAuthorization = async a => { const out = await write(a); return a.p_overrides.length ? { version: 999 } : out; };
  await assert.rejects(withDemoDenyFixture(f.options), /response/); assert.equal(f.calls.length, 2);
});
test('expiry during callback cannot pass but still restores owned expired row', async () => {
  const f = fixture(); f.options.run = async () => { f.expire(); return 'passed'; };
  await assert.rejects(withDemoDenyFixture(f.options), /expired/); assert.deepEqual(f.state.unrevokedOverrides, []);
});
test('cleanup failure is surfaced alongside callback failure', async () => {
  const f = fixture(); const write = f.transport.updateAuthorization;
  f.transport.updateAuthorization = async a => { if (!a.p_overrides.length) throw new Error('cleanup denied'); return write(a); };
  f.options.run = async () => { throw new Error('case failed'); };
  await assert.rejects(withDemoDenyFixture(f.options), e => e instanceof AggregateError && e.errors.length === 2);
});
for (const thrown of [undefined, null, false, 0, '']) {
  test(`falsy callback throw ${String(thrown)} rejects after restore`, async () => {
    const f = fixture(); f.options.run = async () => { throw thrown; };
    let rejected = false;
    try { await withDemoDenyFixture(f.options); }
    catch (error) { rejected = true; assert.equal(error, thrown); }
    assert.equal(rejected, true);
    assert.deepEqual(f.state.unrevokedOverrides, []);
  });
}
test('falsy callback throw is retained when cleanup also fails', async () => {
  const f = fixture(); const write = f.transport.updateAuthorization;
  f.transport.updateAuthorization = async a => { if (!a.p_overrides.length) throw new Error('cleanup denied'); return write(a); };
  f.options.run = async () => { throw undefined; };
  await assert.rejects(withDemoDenyFixture(f.options), e => e instanceof AggregateError && e.errors.length === 2 && e.errors[0] === undefined);
});
