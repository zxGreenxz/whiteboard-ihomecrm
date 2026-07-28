import { readFileSync } from 'node:fs';

const migrationUrl = new URL(
  '../supabase/migrations/20260729030000_network_center_operations.sql',
  import.meta.url,
);

let sql;
try {
  sql = readFileSync(migrationUrl, 'utf8').replace(/\r\n/g, '\n');
} catch (error) {
  console.error(`❌ Không đọc được migration operations: ${error.message}`);
  process.exit(1);
}

const failures = [];
const requireMatch = (label, pattern) => {
  if (!pattern.test(sql)) failures.push(label);
};
const forbidMatch = (label, pattern) => {
  if (pattern.test(sql)) failures.push(label);
};

for (const action of [
  'FLUSH_DNS_CACHE',
  'RENEW_DHCP_LEASE',
  'CYCLE_ACCESS_PORT',
  'REBOOT_ROUTER',
  'CAPTURE_SNAPSHOT',
]) {
  requireMatch(`Thiếu action allowlist ${action}`, new RegExp(`'${action}'`, 'i'));
}

forbidMatch('Không được có trạng thái phê duyệt', /pending_approval|approved_by|rejected_by|maker_checker/i);
forbidMatch('Không được lưu confirmation', /confirmation_(text|value)/i);
forbidMatch('Không được có arbitrary CLI/script payload', /\b(raw_cli|command_text|routeros_script)\b/i);

for (const [label, pattern] of [
  ['Thiếu unique idempotency actor/org', /network_commands_idempotency_uidx[\s\S]{0,180}organization_id,\s*requested_by,\s*idempotency_key/i],
  ['Thiếu so sánh request hash khi replay', /request_hash\s+IS DISTINCT FROM\s+p_request_hash/i],
  ['Thiếu runnable partial index', /network_commands_runnable_idx[\s\S]{0,250}WHERE status IN \('QUEUED', 'RETRY_WAIT'\)/i],
  ['Claim chưa dùng row locking', /FOR UPDATE SKIP LOCKED/i],
  ['Lease chưa serialize theo device', /network_device_leases\s*\([\s\S]{0,180}device_id uuid PRIMARY KEY/i],
  ['Lease claim chưa atomic-upsert', /ON CONFLICT \(device_id\) DO UPDATE/i],
  ['Thiếu helper reclaim command hết lease', /network_center_reclaim_expired_commands_v1/i],
  ['Lease command hết hạn chưa được reclaim', /lease_expires_at\s*<=\s*p_now/i],
  ['Command đã chạy bị mất lease chưa chuyển uncertain', /status\s*=\s*CASE[\s\S]{0,600}ELSE\s+'UNCERTAIN'/i],
  ['Command mới chưa bị chặn khi router còn command uncertain', /FROM public\.network_commands unresolved[\s\S]{0,220}unresolved\.status\s*=\s*'UNCERTAIN'/i],
  ['Claim chưa chọn tối đa một runnable command/device', /FROM public\.network_commands earlier[\s\S]{0,600}earlier\.device_id\s*=\s*command\.device_id/i],
  ['Claim chưa tạo attempt atomically', /WITH candidates AS MATERIALIZED[\s\S]+attempts AS\s*\([\s\S]+INSERT INTO public\.network_command_attempts/i],
  ['Command immutable fields chưa có trigger', /BEFORE UPDATE ON public\.network_commands[\s\S]{0,150}network_center_guard_command_immutable_v1/i],
]) {
  requireMatch(label, pattern);
}

for (const table of [
  'network_incident_events',
  'network_command_events',
  'network_config_snapshots',
  'network_audit_events',
  'network_outbox_events',
]) {
  requireMatch(
    `Thiếu append-only trigger cho ${table}`,
    new RegExp(`BEFORE UPDATE OR DELETE ON public\\.${table}`, 'i'),
  );
}

for (const signature of [
  'app_private.network_center_enqueue_command_v1(uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, uuid, text, text, timestamp with time zone)',
  'app_private.network_center_claim_commands_v1(text, integer, integer)',
]) {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  requireMatch(
    `Internal queue function chưa revoke đủ: ${signature}`,
    new RegExp(`REVOKE ALL ON FUNCTION ${escaped} FROM PUBLIC, anon, authenticated, service_role`, 'i'),
  );
}

if (failures.length) {
  console.error('❌ Network Center queue verifier thất bại:');
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exit(1);
}

console.log('✅ Queue: idempotent, SKIP LOCKED, lease hết hạn, serialize theo router, không có approval/arbitrary CLI.');
