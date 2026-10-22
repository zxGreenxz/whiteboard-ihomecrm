import test from 'node:test';
import assert from 'node:assert/strict';
import { runCameraProof } from '../test-network-center-camera-disposable.mjs';

test('camera schema runs twice and enforces RLS, identity, dedup and stale observations on PostgreSQL', async () => {
  assert.equal((await runCameraProof()).passed, true);
});

test('camera proof detects an ingest assignment-scope bypass mutation', async () => {
  await assert.rejects(runCameraProof({ mutation: (sql) => sql.replace(
    "OR NOT app_private.network_center_worker_can_access_device_v2(worker_id,r.organization_id,r.building_id,n.device_id,'TELEMETRY')",
    'OR false',
  ) }), /revoked assignment accepted/);
});

test('camera proof detects a stale-snapshot guard mutation', async () => {
  await assert.rejects(runCameraProof({ mutation: (sql) => sql.replace(
    'observed<=c.checked_at', 'false',
  ) }), /replay created duplicate/);
});
