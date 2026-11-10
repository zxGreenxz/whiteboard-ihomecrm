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
    'IF v_fail >= 5 OR v_ngay >= 20 THEN', 'IF false THEN',
  ) }), /lockout missing/);
});
