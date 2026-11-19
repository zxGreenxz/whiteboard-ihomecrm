import test from 'node:test';
import assert from 'node:assert/strict';
import { runCameraShareProof } from '../test-network-center-camera-share-disposable.mjs';

test('camera share schema runs twice and enforces scope, lockout, revoke and expiry on PostgreSQL', async () => {
  assert.equal((await runCameraShareProof()).passed, true);
});

test('camera share proof detects a removed permission check on create', async () => {
  await assert.rejects(runCameraShareProof({ mutation: (sql) => sql.replace(
    `  IF r.id IS NULL OR NOT r.enabled
     OR NOT app_private.camera_share_actor_can_v1(r.organization_id, r.building_id) THEN`,
    '  IF r.id IS NULL OR NOT r.enabled THEN',
  ) }), /ungranted actor created share/);
});

test('camera share proof detects a session that outlives its share', async () => {
  await assert.rejects(runCameraShareProof({ mutation: (sql) => sql.replace(
    `     AND s.revoked_at IS NULL
     AND s.expires_at > pg_catalog.now()
     AND r.enabled`,
    '     AND r.enabled',
  ) }), /expired share still authorized/);
});

test('camera share proof detects a removed login lockout', async () => {
  await assert.rejects(runCameraShareProof({ mutation: (sql) => sql.replace(
    'IF v_fail >= 5 THEN', 'IF false THEN',
  ) }), /lockout missing/);
});

test('camera share proof detects a window that reaches into the future (near-live viewing)', async () => {
  await assert.rejects(runCameraShareProof({ mutation: (sql) => sql.replace(
    "OR v_end > v_now OR v_start < v_now - interval '60 days'", "OR v_start < v_now - interval '60 days'",
  ) }), /future (window|end) accepted/);
});

test('camera share proof detects a removed cap on sessions per share', async () => {
  await assert.rejects(runCameraShareProof({ mutation: (sql) => sql.replace(
    'ORDER BY y.created_at DESC, y.token_hash LIMIT 5);', 'ORDER BY y.created_at DESC, y.token_hash LIMIT 500);',
  ) }), /session cap not enforced/);
});
