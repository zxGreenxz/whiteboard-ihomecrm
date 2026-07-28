import { readFileSync } from 'node:fs';

const migrationUrl = new URL(
  '../supabase/migrations/20260729020000_network_center_current_telemetry.sql',
  import.meta.url,
);

let sql;
try {
  sql = readFileSync(migrationUrl, 'utf8').replace(/\r\n/g, '\n');
} catch (error) {
  console.error(`❌ Không đọc được migration telemetry: ${error.message}`);
  process.exit(1);
}

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
