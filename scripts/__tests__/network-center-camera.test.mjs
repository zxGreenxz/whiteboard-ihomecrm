import test from 'node:test';
import assert from 'node:assert/strict';
import { runCameraAlertsProof, runCameraProof } from '../test-network-center-camera-disposable.mjs';

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

// Cảnh báo camera (plan 2026-11-01 §6.1): 11 ca trên PostgreSQL dùng một lần,
// rồi đột biến từng luật một để chứng minh các ca không xanh rỗng.
test('camera alerts run twice and satisfy the eleven §6.1 cases on PostgreSQL', async () => {
  assert.equal((await runCameraAlertsProof()).passed, true);
});

test('camera alert proof detects closing on the first good round (no hysteresis)', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    'ELSIF cond.clear_streak + 1 >= 2 THEN', 'ELSIF cond.clear_streak + 1 >= 1 THEN',
  ) }), /first good round must only mark RECOVERING/);
});

test('camera alert proof detects a WARNING sent during the night window', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    "ELSIF v_ev ->> 'severity' = 'WARNING' AND v_in_night THEN", 'ELSIF false THEN',
  ) }), /CRITICAL at night is sent at once, the WARNING is not/);
});

test('camera alert proof detects disk/channel incidents kept open under an OFFLINE recorder (B2)', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    "PERFORM app_private.camera_alert_retire_v1(cond, 'SUPERSEDED', p_now);", 'NULL;',
  ) }), /C1 must be closed as SUPERSEDED/);
});

test('camera alert proof detects a super admin receiving sandbox/demo alerts', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    'EXISTS (SELECT 1 FROM public.super_admins sa WHERE sa.user_id = m.user_id)',
    'false AND EXISTS (SELECT 1 FROM public.super_admins sa WHERE sa.user_id = m.user_id)',
  ) }), /building A recipients must be exactly manager \+ owner/);
});

test('camera alert proof detects the company-owner branch being dropped', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    'app_private.ie_actor_is_company_owner_v1(p_org, m.user_id)\n       OR', 'false\n       OR',
  ) }), /building A recipients must be exactly manager \+ owner/);
});

test('camera alert proof detects a monitor-stale alert raised without its grace interval', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    "WHEN 'CAMERA_MONITOR_STALE' THEN app_private.camera_alert_threshold_v1(p_thresholds, 'monitorGraceSeconds', 90)",
    "WHEN 'CAMERA_MONITOR_STALE' THEN 0",
  ) }), /C4 waits one grace interval/);
});

test('camera alert proof detects an OFFLINE incident kept open after the recorder reconnects as UNKNOWN', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    "WHEN rec.status IN ('UNKNOWN', 'AUTH_DENIED') THEN 'GOOD_IF_OPEN'", "WHEN rec.status IN ('UNKNOWN', 'AUTH_DENIED') THEN 'HOLD'",
  ) }), /a reconnected recorder that answers UNKNOWN must close C2/);
});

test('camera alert proof detects a flapping OFFLINE/UNKNOWN link that never opens C2', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    "WHEN rec.status IN ('UNKNOWN', 'AUTH_DENIED') THEN 'GOOD_IF_OPEN'", "WHEN rec.status IN ('UNKNOWN', 'AUTH_DENIED') THEN 'GOOD'",
  ) }), /a link flapping OFFLINE\/UNKNOWN must still open C2/);
});

test('camera alert proof detects an expired night notice counted as delivered', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    "SET status = 'SUPPRESSED', result = d.result || jsonb_build_object('skipped', 'EXPIRED')",
    "SET status = 'DONE', result = d.result || jsonb_build_object('skipped', 'EXPIRED')",
  ) }), /a deferred notice older than 24 hours must be closed, not sent/);
});

test('camera alert proof detects incidents left open when the recorder router is gone', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    "PERFORM app_private.camera_alert_retire_v1(cond, 'ROUTER_UNAVAILABLE', p_now);", 'NULL;',
  ) }), /a recorder whose router is gone must be closed quietly/);
});

test('camera alert proof detects disk states of a non-ONLINE recorder being trusted', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    "CASE WHEN NOT v_fresh OR rec.status IS DISTINCT FROM 'ONLINE' THEN 'HOLD'\n               WHEN disk.value",
    "CASE WHEN NOT v_fresh THEN 'HOLD'\n               WHEN disk.value",
  ) }), /disk\/channel states of a non-ONLINE recorder must not be tracked/);
});

test('camera alert proof detects bell delivery being skipped when push credentials are refused', async () => {
  await assert.rejects(runCameraAlertsProof({ mutation: (sql) => sql.replace(
    "v_jwt_error := left(SQLSTATE || ': ' || SQLERRM, 300);",
    "v_jwt_error := left(SQLSTATE || ': ' || SQLERRM, 300); RAISE;",
  ) }), /JWT|TEST|55000/);
});
