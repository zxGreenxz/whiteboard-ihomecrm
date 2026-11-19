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

// Vendor migration (20261110160847). A mutation must hit exactly one place, or the test proves nothing.
const replaceOnce = (sql, from, to) => {
  if (sql.split(from).length !== 2) throw new Error(`Mutation anchor not found exactly once: ${from}`);
  return sql.replace(from, to);
};
// The migration's own $check$ would stop a mutated body or CHECK first. Removing it leaves the runtime
// proof as the only thing that can notice, which is what these two tests measure.
const withoutSelfCheck = (sql) => {
  const stripped = sql.replace(/DO \$check\$[\s\S]*?END \$check\$;\n/, '');
  if (stripped === sql) throw new Error('Vendor migration self-check block not found');
  return stripped;
};

test('camera proof detects a worker connections payload without the vendor', async () => {
  await assert.rejects(runCameraProof({ vendorMutation: (sql) => replaceOnce(
    withoutSelfCheck(sql), ",'vendor',r.vendor) item", ') item',
  ) }), /worker connections payload missing vendor/);
});

test('camera proof detects a vendor CHECK that still refuses HIKVISION', async () => {
  await assert.rejects(runCameraProof({ vendorMutation: (sql) => replaceOnce(
    withoutSelfCheck(sql), "CHECK (vendor IN ('KBVISION','DAHUA','HIKVISION'))", "CHECK (vendor IN ('KBVISION','DAHUA'))",
  ) }), /HIKVISION enrollment rejected/);
});

test('camera vendor migration refuses to replace a connections body it was not written against', async () => {
  await assert.rejects(runCameraProof({ mutation: (sql) => replaceOnce(
    sql, 'ORDER BY r.id LIMIT p_limit', 'ORDER BY r.id DESC LIMIT p_limit',
  ) }), /network_center_worker_camera_connections_v1_body_drift/);
});

test('camera vendor migration self-check rejects a body other than the reviewed one', async () => {
  await assert.rejects(runCameraProof({ vendorMutation: (sql) => replaceOnce(
    sql, 'ORDER BY r.id LIMIT p_limit', 'ORDER BY r.id DESC LIMIT p_limit',
  ) }), /network_center_camera_vendor_hikvision_check_failed/);
});
