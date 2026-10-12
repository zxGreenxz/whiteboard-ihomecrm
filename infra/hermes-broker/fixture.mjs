import { createBroker } from './broker.mjs';

// Synthetic offline fixture only. Not a server auth provider or production default.
export async function createFixtureBroker({ clock = Date.now, limits, audit } = {}) {
  const actors = {
    a: { userId: '10000000-0000-4000-8000-000000000001', organizationId: '20000000-0000-4000-8000-000000000001' },
    b: { userId: '10000000-0000-4000-8000-000000000002', organizationId: '20000000-0000-4000-8000-000000000002' },
  };
  const expiresAt = clock() + 15 * 60_000;
  const auth = {
    async verifySession({ accessToken }) {
      const actor = actors[accessToken];
      if (!actor) throw new Error('invalid_fixture_actor');
      return { userId: actor.userId, sessionId: `fixture-${accessToken}`, expiresAt };
    },
    async readAuthorization({ userId, organizationId }) {
      const actor = Object.values(actors).find((item) => item.userId === userId);
      if (!actor || actor.organizationId !== organizationId) throw new Error('fixture_scope_denied');
      return { userId, isSuperadmin: false, activeOrganizationIds: [organizationId],
        membership: { organizationId, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null },
        epoch: 'fixture-1', permissions: { read: ['assistant.context.read'], action: [] },
        companyCeilings: { read: ['assistant.context.read'], action: [] } };
    },
  };
  const broker = createBroker({ auth, clock, limits, audit });
  const connections = {};
  for (const actor of Object.keys(actors)) {
    connections[actor] = await broker.issueConnection({ accessToken: actor,
      organizationId: actors[actor].organizationId,
      restrictions: { read: ['assistant.context.read'], action: [] } });
  }
  return { broker, connections };
}
