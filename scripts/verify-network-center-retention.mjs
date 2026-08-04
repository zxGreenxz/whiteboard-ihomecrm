import { readFileSync } from 'node:fs';

const migrationUrl = new URL(
  '../supabase/migrations/20260729020000_network_center_current_telemetry.sql',
  import.meta.url,
);
const lifecycleMigrationUrl = new URL(
  '../supabase/migrations/20260729131000_network_center_resource_lifecycle.sql',
  import.meta.url,
);

let sql;
let lifecycleSql;
try {
  sql = readFileSync(migrationUrl, 'utf8').replace(/\r\n/g, '\n');
  lifecycleSql = readFileSync(lifecycleMigrationUrl, 'utf8').replace(/\r\n/g, '\n');
} catch (error) {
  console.error(`❌ Không đọc được migration telemetry: ${error.message}`);
  process.exit(1);
}

const allSql = `${sql}\n${lifecycleSql}`;

const failures = [];
const requireMatch = (label, pattern) => {
  if (!pattern.test(sql)) failures.push(label);
};
const requireCount = (label, pattern, expected) => {
  const count = (sql.match(pattern) ?? []).length;
  if (count !== expected) failures.push(`${label} (có ${count}, cần ${expected})`);
};

requireCount('Hai raw parent phải partition theo observed_at', /PARTITION BY RANGE \(observed_at\)/gi, 2);
if (/PARTITION OF public\.network_(device|interface)_samples\s+DEFAULT/i.test(sql)) {
  failures.push('Phát hiện DEFAULT partition; raw telemetry có thể vượt retention');
}

requireMatch('Thiếu helper tạo partition', /network_center_ensure_raw_partitions_v1\s*\(/i);
requireMatch('Helper partition chưa giới hạn khoảng tối đa', /p_through\s*>\s*p_from\s*\+\s*62/i);
requireMatch('Tên partition ngày chưa khóa định dạng', /to_char\(v_day,\s*'YYYYMMDD'\)/i);
requireCount(
  'Hai raw parent phải có trigger append-only',
  /BEFORE UPDATE OR DELETE ON public\.network_(device|interface)_samples/gi,
  2,
);
requireMatch('Thiếu SQLSTATE append-only', /ERRCODE\s*=\s*'55000'/i);

for (const [label, pattern] of [
  ['Raw retention phải đúng 14 ngày', /INTERVAL '14 days'/i],
  ['Hourly retention phải đúng 13 tháng', /INTERVAL '13 months'/i],
  ['SLA retention phải đúng 36 tháng', /INTERVAL '36 months'/i],
  ['Retention phải drop partition cũ', /DROP TABLE IF EXISTS public\.%I/i],
  ['Retention phải xóa hourly cũ', /DELETE FROM public\.network_metric_hourly/i],
  ['Retention phải xóa SLA cũ', /DELETE FROM public\.network_sla_daily/i],
  ['Hourly rollup phải repeat-safe', /network_center_rollup_hourly_v1[\s\S]+ON CONFLICT[\s\S]+DO UPDATE/i],
  ['Daily rollup phải repeat-safe', /network_center_rollup_sla_daily_v1[\s\S]+ON CONFLICT[\s\S]+DO UPDATE/i],
  ['P95 phải dùng percentile_cont', /percentile_cont\s*\(\s*0\.95\s*\)/i],
]) {
  requireMatch(label, pattern);
}

for (const [label, pattern] of [
  ['Missing 90-day client-session retention', /network_client_sessions[\s\S]+INTERVAL '90 days'/i],
  ['Missing tenant-bounded client deletion', /network_client_sessions[\s\S]+FOR UPDATE SKIP LOCKED[\s\S]+LIMIT 1000/i],
  ['Missing 16-value address history bound', /network_center_compact_client_history_v1[\s\S]+v_count\s*>=\s*16/i],
  ['Missing bounded existing-history backfill', /DO \$history_backfill\$[\s\S]+network_client_sessions[\s\S]+FOR UPDATE SKIP LOCKED[\s\S]+LIMIT 1000[\s\S]+SET address_history\s*=\s*session\.address_history/i],
  ['Missing hourly retention timestamp index', /network_metric_hourly_retention_idx[\s\S]+organization_id,\s*bucket_hour,\s*building_id/i],
  ['Missing tenant-bounded hourly deletion', /network_metric_hourly[\s\S]+FOR UPDATE SKIP LOCKED[\s\S]+LIMIT 5000[\s\S]+DELETE FROM public\.network_metric_hourly/i],
  ['Missing daily retention timestamp index', /network_sla_daily_retention_idx[\s\S]+organization_id,\s*sla_day,\s*building_id/i],
  ['Missing tenant-bounded daily deletion', /network_sla_daily[\s\S]+FOR UPDATE SKIP LOCKED[\s\S]+LIMIT 1000[\s\S]+DELETE FROM public\.network_sla_daily/i],
  ['Missing 180-day terminal command retention', /network_commands[\s\S]+INTERVAL '180 days'/i],
  ['Missing terminal finished-at retention index', /network_commands_terminal_retention_idx[\s\S]+organization_id,\s*finished_at,\s*id[\s\S]+WHERE status IN/i],
  ['Missing tenant-bounded command deletion', /network_commands[\s\S]+FOR UPDATE SKIP LOCKED[\s\S]+LIMIT 100/i],
  ['Missing sanitized command audit summary', /command\.retention_summary/i],
  ['Retention summary is not restricted to SYSTEM actor', /actor_type\s*=\s*'SYSTEM'[\s\S]+command\.retention_summary|command\.retention_summary[\s\S]+actor_type\s*=\s*'SYSTEM'/i],
  ['Missing canonical retention-summary guard', /Canonical command retention summary is missing[\s\S]+ERRCODE\s*=\s*'55000'/i],
  ['Missing command-event lifecycle delete', /DELETE FROM public\.network_command_events/i],
  ['Missing command-attempt lifecycle delete', /DELETE FROM public\.network_command_attempts/i],
  ['Missing private transaction retention context', /CREATE TABLE(?: IF NOT EXISTS)? app_private\.network_center_command_retention_contexts/i],
  ['Missing backend-bound retention context', /backend_pid\s+integer\s+NOT NULL[\s\S]+pg_backend_pid\(\)/i],
  ['Missing transaction-bound retention context', /transaction_id\s+bigint\s+NOT NULL[\s\S]+txid_current\(\)/i],
  ['Missing retention-context insert', /INSERT INTO app_private\.network_center_command_retention_contexts/i],
  ['Missing retention-context cleanup', /DELETE FROM app_private\.network_center_command_retention_contexts/i],
  ['Missing API-role context-table revoke', /REVOKE ALL ON TABLE app_private\.network_center_command_retention_contexts\s+FROM PUBLIC, anon, authenticated, service_role/i],
  ['Missing device-lease command index', /ON public\.network_device_leases\s*\(\s*command_id\s*\)/i],
  ['Missing snapshot command FK index', /ON public\.network_config_snapshots\s*\(\s*organization_id\s*,\s*building_id\s*,\s*command_id\s*\)/i],
  ['Missing audit command FK index', /ON public\.network_audit_events\s*\(\s*organization_id\s*,\s*building_id\s*,\s*command_id\s*\)/i],
]) {
  if (!pattern.test(lifecycleSql)) failures.push(label);
}

for (const guardName of [
  'network_center_guard_command_events_v2',
  'network_center_guard_command_evidence_v2',
]) {
  const escaped = guardName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const guard = lifecycleSql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION\\s+app_private\\.${escaped}\\b[\\s\\S]*?\\$fn\\$;`,
    'i',
  ))?.[0] ?? '';
  if (!/current_setting\([\s\S]*network_center_command_retention/i.test(guard)
      || !/network_center_command_retention_contexts/i.test(guard)
      || !/pg_backend_pid\(\)/i.test(guard)
      || !/txid_current\(\)/i.test(guard)) {
    failures.push(`Retention guard is not bound to a private transaction context: ${guardName}`);
  }
}

if (/DELETE FROM public\.network_audit_events/i.test(allSql)) {
  failures.push('Append-only audit events must never be purged');
}

for (const signature of [
  'app_private.network_center_ensure_raw_partitions_v1(date, date)',
  'app_private.network_center_rollup_hourly_v1(timestamp with time zone)',
  'app_private.network_center_rollup_sla_daily_v1(date)',
  'app_private.network_center_retention_v1(timestamp with time zone)',
]) {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  requireMatch(
    `Internal function chưa revoke đủ: ${signature}`,
    new RegExp(`REVOKE ALL ON FUNCTION ${escaped} FROM PUBLIC, anon, authenticated, service_role`, 'i'),
  );
}

if (failures.length) {
  console.error('❌ Network Center retention verifier thất bại:');
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exit(1);
}

console.log('✅ Hybrid A+ retention: raw 14 ngày, hourly 13 tháng, SLA 36 tháng; partition và ACL hợp lệ.');
