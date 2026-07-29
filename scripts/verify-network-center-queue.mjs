import { readFileSync } from 'node:fs';

const migrationUrl = new URL(
  '../supabase/migrations/20260729030000_network_center_operations.sql',
  import.meta.url,
);
const lifecycleMigrationUrl = new URL(
  '../supabase/migrations/20260729131000_network_center_resource_lifecycle.sql',
  import.meta.url,
);

let sql;
let lifecycleSql;
try {
  const operationsSql = readFileSync(migrationUrl, 'utf8').replace(/\r\n/g, '\n');
  lifecycleSql = readFileSync(lifecycleMigrationUrl, 'utf8').replace(/\r\n/g, '\n');
  sql = `${operationsSql}\n${lifecycleSql}`;
} catch (error) {
  console.error(`❌ Không đọc được migration operations: ${error.message}`);
  process.exit(1);
}

const failures = [];
const requireMatch = (label, pattern) => {
  if (!pattern.test(sql)) failures.push(label);
};
const functionBody = (name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...sql.matchAll(new RegExp(
    `CREATE OR REPLACE FUNCTION\\s+(?:app_private|public)\\.${escaped}\\b[\\s\\S]*?\\$fn\\$;`,
    'gi',
  ))];
  return matches.at(-1)?.[0] ?? '';
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

const enqueueBody = functionBody('network_center_enqueue_command_v1');
if (!enqueueBody) {
  failures.push('Missing lifecycle enqueue function body');
} else {
  const organizationLock = enqueueBody.indexOf('network-center:org:');
  const actorLock = enqueueBody.indexOf('network-center:actor:');
  const deviceLock = enqueueBody.indexOf('network-center:device:');
  if (!(organizationLock >= 0 && actorLock > organizationLock && deviceLock > actorLock)) {
    failures.push('Queue advisory locks must be ordered organization -> actor -> device');
  }

  const semanticMaterial = enqueueBody.match(
    /v_semantic_material\s*:=([\s\S]*?);/i,
  )?.[1] ?? '';
  if (!semanticMaterial.includes('p_action_type')
      || !semanticMaterial.includes('p_parameters::text')
      || semanticMaterial.includes('p_reason')
      || semanticMaterial.includes('p_idempotency_key')) {
    failures.push('Semantic fingerprint includes non-semantic request material');
  }
  if (/INSERT INTO public\.network_command_events/i.test(enqueueBody)) {
    failures.push('Rejected enqueue path must not create command events');
  }

  const postLockNow = enqueueBody.indexOf('v_now := clock_timestamp()', deviceLock);
  const semanticLookup = enqueueBody.indexOf(
    'WHERE command.semantic_fingerprint = v_semantic_fingerprint',
  );
  if (!(postLockNow > deviceLock && semanticLookup > postLockNow)) {
    failures.push('Cooldown clock must refresh after all admission locks');
  }
  if (!/semantic_fingerprint,\s*available_at,\s*created_at,\s*updated_at[\s\S]{0,500}v_semantic_fingerprint,\s*p_available_at,\s*v_now,\s*v_now/i.test(enqueueBody)) {
    failures.push('Command timestamps must use the post-lock admission clock');
  }
  if (!/command\.device_id\s*=\s*p_device_id[\s\S]{0,300}command\.action_type\s*=\s*p_action_type[\s\S]{0,300}p_action_type\s*<>\s*'CYCLE_ACCESS_PORT'[\s\S]{0,200}command\.interface_id\s*=\s*p_interface_id/i.test(enqueueBody)) {
    failures.push('Access-port cooldown must be scoped to its interface target');
  }
}

for (const indexPrefix of [
  'organization_id, created_at',
  'requested_by, created_at',
  'device_id, created_at',
]) {
  if (!sql.includes(`(${indexPrefix}`)) {
    failures.push(`Missing hourly rate index prefix ${indexPrefix}`);
  }
}

const executeBody = functionBody('network_center_execute_action_v1');
const snapshotBody = functionBody('network_center_request_snapshot_v1');
for (const [label, body, mutableChecks] of [
  ['execute action', executeBody, [
    'device.write_capability',
    'network_site_settings',
    'p_confirmation IS DISTINCT FROM v_identity',
    'SELECT interface.* INTO v_interface',
  ]],
  ['request snapshot', snapshotBody, [
    'device.write_capability',
    'connection.is_enabled',
  ]],
]) {
  const replay = body.indexOf('network_center_request_replay_v1');
  if (replay < 0) {
    failures.push(`Missing committed request replay in ${label}`);
    continue;
  }
  for (const mutableCheck of mutableChecks) {
    if (body.indexOf(mutableCheck) <= replay) {
      failures.push(`${label} revalidates mutable state before committed replay: ${mutableCheck}`);
    }
  }
}

for (const [label, pattern] of [
  ['Missing canonical semantic fingerprint', /semantic_fingerprint[\s\S]+v_semantic_material[\s\S]+p_parameters::text/i],
  ['Missing organization advisory lock', /network-center:org:/i],
  ['Missing actor advisory lock', /network-center:actor:/i],
  ['Missing device advisory lock', /network-center:device:/i],
  ['Missing one disruptive per device', /'budget',\s*'disruptive'[\s\S]{0,120}'limit',\s*1/i],
  ['Missing two nonterminal per device', /'budget',\s*'device'[\s\S]{0,120}'limit',\s*2/i],
  ['Missing eight nonterminal per actor', /'budget',\s*'actor'[\s\S]{0,120}'limit',\s*8/i],
  ['Missing thirty nonterminal per organization', /'budget',\s*'organization'[\s\S]{0,120}'limit',\s*30/i],
  ['Missing twelve per device per hour', /'budget',\s*'device_hour'[\s\S]{0,120}'limit',\s*12/i],
  ['Missing thirty per actor per hour', /'budget',\s*'actor_hour'[\s\S]{0,120}'limit',\s*30/i],
  ['Missing one hundred twenty per organization per hour', /'budget',\s*'organization_hour'[\s\S]{0,120}'limit',\s*120/i],
  ['Missing reboot cooldown', /WHEN 'REBOOT_ROUTER' THEN INTERVAL '10 minutes'/i],
  ['Missing access-port cooldown', /WHEN 'CYCLE_ACCESS_PORT' THEN INTERVAL '2 minutes'/i],
  ['Missing DNS cooldown', /WHEN 'FLUSH_DNS_CACHE' THEN INTERVAL '30 seconds'/i],
  ['Missing DHCP cooldown', /WHEN 'RENEW_DHCP_LEASE' THEN INTERVAL '30 seconds'/i],
  ['Missing snapshot cooldown', /WHEN 'CAPTURE_SNAPSHOT' THEN INTERVAL '60 seconds'/i],
  ['Missing typed queue error', /NETWORK_CENTER_(?:DEVICE_BUSY|RATE_LIMIT|COOLDOWN)/i],
]) {
  requireMatch(label, pattern);
}

const enqueue = enqueueBody;
const cooldownAssignment = enqueue.indexOf('v_cooldown := CASE p_action_type');
const semanticLookup = enqueue.indexOf(
  'WHERE command.semantic_fingerprint = v_semantic_fingerprint',
);
const deviceBudget = enqueue.indexOf(
  "IF p_action_type IN ('CYCLE_ACCESS_PORT', 'REBOOT_ROUTER')",
);
if (
  cooldownAssignment < 0
  || semanticLookup <= cooldownAssignment
  || deviceBudget <= semanticLookup
) {
  failures.push('Semantic admission must derive the action cooldown before lookup and budgets');
} else {
  const semanticConflict = enqueue.slice(semanticLookup, deviceBudget);
  if (!/created_at\s*>=\s*v_now\s*-\s*v_cooldown/i.test(semanticConflict)) {
    failures.push('Semantic duplicate lookup does not use the action cooldown');
  }
  if (/RETURN\s+v_existing\.id/i.test(semanticConflict)) {
    failures.push('A different semantic intent must conflict, never replay an old command');
  }
  for (const code of ['NETWORK_CENTER_COOLDOWN', 'NETWORK_CENTER_DUPLICATE_INTENT']) {
    if (!semanticConflict.includes(code)) {
      failures.push(`Semantic conflict is missing typed code ${code}`);
    }
  }
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
