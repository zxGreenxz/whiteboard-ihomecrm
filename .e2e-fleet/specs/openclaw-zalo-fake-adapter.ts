import { requireLocalPreviewEnv, assertDemoOrganization, type OpenClawFixtureEnv } from './openclaw-zalo-admin';

/**
 * Drivers for the deterministic fake Zalo adapter.
 *
 * These call test-only runtime endpoints that MUST NOT exist on a production
 * cell: they mint QR payloads, inject inbound messages, kick sessions, and force a
 * send to succeed, be rejected, or time out ambiguously. A production cell that
 * answered them would let anyone fabricate delivery evidence.
 *
 * The endpoints are part of Task 26 Step 3 and are not built yet. Every driver
 * below therefore fails loudly against a server that does not implement them,
 * rather than degrading into a no-op that would let a scenario "pass" while
 * exercising nothing. See `assertFixtureApi`.
 */

/** Where the fixture endpoints live, relative to the preview server. */
const FIXTURE_ROOT = '/__openclaw-fixture__';

export type FakeSendOutcome =
  /** The provider acknowledges; the outbox should reach SENT. */
  | 'SUCCESS'
  /** The provider refuses; the outbox should reach a terminal failure. */
  | 'REJECTED'
  /**
   * The provider neither acknowledges nor refuses before the deadline. This is the
   * one that must produce UNKNOWN and must NEVER auto-retry: a silent retry here
   * is how a customer receives the same message twice.
   */
  | 'AMBIGUOUS_TIMEOUT';

export interface FakeAdapter {
  env: OpenClawFixtureEnv;
  organizationId: string;
  /** Produces a QR payload the connect flow will accept. */
  issueQr(): Promise<{ challengeId: string }>;
  /** Expires the outstanding QR without the client asking, as a real one does. */
  expireQr(challengeId: string): Promise<void>;
  /** Reports the fake session as connected, so the UI leaves QR_PENDING. */
  completeConnection(challengeId: string): Promise<void>;
  /** Ends the session the way the provider does when the phone signs in elsewhere. */
  kickSession(): Promise<void>;
  /** Delivers an inbound message into the fake conversation. */
  pushInbound(input: { conversationId: string; text: string }): Promise<void>;
  /** Fixes what the next send will do, before it is dispatched. */
  setSendOutcome(outcome: FakeSendOutcome): Promise<void>;
  /** Publishes an exact peer/group directory, so allowlists resolve by stable id. */
  setDirectory(entries: readonly { targetId: string; kind: 'PEER' | 'SALES_GROUP' }[]): Promise<void>;
  /** Moves the deterministic clock; schedules and grace periods depend on it. */
  advanceClock(seconds: number): Promise<void>;
  /** Removes everything this adapter created. Safe to call twice. */
  reset(): Promise<void>;
}

async function fixtureCall(
  env: OpenClawFixtureEnv,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${env.baseUrl}${FIXTURE_ROOT}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Echoed back by the endpoint; a server that ignores it is not the fixture
      // server, and answering anyway would be worse than refusing.
      'x-openclaw-fixture-env': env.fixtureEnv,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Fixture ${path} trả về ${response.status}. ` +
        'Các endpoint test-only của Task 26 Step 3 chưa được dựng — ' +
        'chưa chạy được kịch bản nào cần adapter giả.',
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Fails early and clearly when the fixture API is absent.
 *
 * Without this a scenario would hit its first `issueQr()` deep inside a test and
 * report a network error, which reads like a flake. It is not a flake: it is the
 * fixture server not being there.
 */
export async function assertFixtureApi(env: OpenClawFixtureEnv): Promise<void> {
  let reachable = false;
  try {
    const health = await fetch(`${env.baseUrl}${FIXTURE_ROOT}/health`);
    reachable = health.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    throw new Error(
      `Không thấy API fixture ở ${env.baseUrl}${FIXTURE_ROOT}. ` +
        'Task 26 Step 3 (endpoint runtime test-only + adapter giả) chưa dựng, ' +
        'nên các kịch bản cần nó KHÔNG chạy được — và không được coi là đã kiểm.',
    );
  }
}

export function createFakeAdapter(organizationId: string): FakeAdapter {
  const env = requireLocalPreviewEnv();
  // Checked on every construction, not once at import: a scenario that reads the
  // organization from page state could otherwise carry a production id in here.
  const scoped = assertDemoOrganization(organizationId);

  const call = (path: string, body: Record<string, unknown> = {}) =>
    fixtureCall(env, path, { organizationId: scoped, ...body });

  return {
    env,
    organizationId: scoped,
    async issueQr() {
      const result = await call('/qr/issue');
      return { challengeId: String(result.challengeId) };
    },
    async expireQr(challengeId) { await call('/qr/expire', { challengeId }); },
    async completeConnection(challengeId) { await call('/qr/complete', { challengeId }); },
    async kickSession() { await call('/session/kick'); },
    async pushInbound(input) { await call('/inbound', { ...input }); },
    async setSendOutcome(outcome) { await call('/send/outcome', { outcome }); },
    async setDirectory(entries) { await call('/directory', { entries }); },
    async advanceClock(seconds) { await call('/clock/advance', { seconds }); },
    async reset() { await call('/reset'); },
  };
}
