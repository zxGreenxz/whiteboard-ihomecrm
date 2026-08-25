#!/usr/bin/env node
// Tách "raw live typegen" khỏi "canonical generated types".
//
// Network Center sinh child partition theo NGÀY. Nếu để chúng trong types.ts thì
// file phình ~96 dòng/ngày và job drift đỏ mỗi lần maintenance chạy — trong khi
// logical API không đổi một chữ. Script này bỏ đúng các partition khớp policy,
// và CHỈ chúng.
//
//   node scripts/normalize-supabase-types.mjs            # liệt kê, không ghi
//   node scripts/normalize-supabase-types.mjs --write    # chuẩn hoá file tại chỗ
//   node scripts/normalize-supabase-types.mjs --check    # exit 1 nếu file còn partition (gate CI)
//   node scripts/normalize-supabase-types.mjs --stdin     # normalize stdin -> stdout
//
// Không đọc database, không cần credential: thuần biến đổi văn bản.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_PATH = join(repoRoot, 'supabase', 'generated-types-policy.json');

export function loadPolicy(policyPath = POLICY_PATH) {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const patterns = policy?.runtimePartitions?.namePatterns;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error(`Policy thiếu runtimePartitions.namePatterns: ${policyPath}`);
  }
  const pv = policy?.platformVersion;
  if (pv && (typeof pv.field !== 'string' || typeof pv.pinned !== 'string')) {
    throw new Error(`Policy platformVersion thiếu field/pinned dạng chuỗi: ${policyPath}`);
  }
  return {
    canonicalTypesPath: policy.canonicalTypesPath || 'src/integrations/supabase/types.ts',
    matchers: patterns.map((p) => new RegExp(p)),
    parentsMustExist: policy?.runtimePartitions?.parentsMustExist ?? [],
    platformVersion: pv ? { field: pv.field, pinned: pv.pinned } : null,
  };
}

/**
 * Ghim phiên bản nền tảng (`__InternalSupabase.PostgrestVersion`) về giá trị canonical.
 *
 * VÌ SAO — có án lệ 25/08/2026
 *   Supabase nâng PostgREST của họ từ 13.0.5 lên 14.17. Con số đó nằm trong
 *   output của `gen:types`, nên job generated-types-drift ĐỎ mỗi lần chạy với
 *   diff đúng MỘT dòng — không liên quan gì tới schema của repo. 3 trong 5
 *   commit gần nhất đụng types.ts là `fix(ci)` chỉ để đuổi theo nó.
 *
 * KHÔNG PHẢI CHE GIẤU: hàm trả về giá trị live tìm được để người gọi in cảnh
 * báo. Độ lệch vẫn nhìn thấy, nó chỉ thôi làm đỏ một cổng đo schema.
 */
export function pinPlatformVersion(source, platformVersion) {
  if (!platformVersion) return { output: source, live: null, changed: false };
  const { field, pinned } = platformVersion;
  const re = new RegExp(`^(\\s*)${field}: "([^"]*)"`, 'm');
  const m = re.exec(source);
  if (!m) return { output: source, live: null, changed: false };
  const live = m[2];
  if (live === pinned) return { output: source, live, changed: false };
  return {
    output: source.replace(re, `$1${field}: "${pinned}"`),
    live,
    changed: true,
  };
}

/**
 * Bỏ các entry bảng khớp matcher khỏi generated types.
 *
 * Generated file có indent cố định: key bảng ở 6 space, và block đóng bằng đúng
 * một dòng `      }` cùng mức. Mọi thứ lồng bên trong luôn indent sâu hơn, nên
 * dòng đóng cùng mức là ranh giới tin cậy — không cần đếm ngoặc (vốn dễ sai khi
 * ngoặc nằm trong chuỗi).
 */
export function stripRuntimePartitions(source, matchers) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r\n|\n/);
  const out = [];
  const removed = [];

  const KEY = /^ {6}([A-Za-z0-9_]+): \{$/;
  const CLOSE = /^ {6}\}$/;

  for (let i = 0; i < lines.length; i += 1) {
    const m = KEY.exec(lines[i]);
    if (!m || !matchers.some((re) => re.test(m[1]))) {
      out.push(lines[i]);
      continue;
    }

    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (CLOSE.test(lines[j])) { end = j; break; }
      // Gặp key bảng khác trước dòng đóng ⇒ giả định indent đã sai, dừng an toàn.
      if (KEY.test(lines[j])) break;
    }
    if (end === -1) {
      throw new Error(
        `Không tìm được ranh giới kết thúc cho "${m[1]}" (dòng ${i + 1}). ` +
        'Định dạng generated file có thể đã đổi — dừng thay vì cắt bừa.',
      );
    }
    removed.push(m[1]);
    i = end;
  }

  return { output: out.join(eol), removed };
}

export function assertParentsPresent(source, parents) {
  const missing = parents.filter((p) => !new RegExp(`^ {6}${p}: \\{$`, 'm').test(source));
  if (missing.length > 0) {
    throw new Error(
      `Mất parent table sau khi normalize: ${missing.join(', ')}. ` +
      'Đây là lỗi thật của schema, không phải nhiễu partition.',
    );
  }
}

function main(argv) {
  const args = new Set(argv.slice(2));
  const policy = loadPolicy();

  if (args.has('--stdin')) {
    const source = readFileSync(0, 'utf8');
    const stripped = stripRuntimePartitions(source, policy.matchers);
    assertParentsPresent(stripped.output, policy.parentsMustExist);
    process.stdout.write(pinPlatformVersion(stripped.output, policy.platformVersion).output);
    return 0;
  }

  const target = join(repoRoot, policy.canonicalTypesPath);
  const source = readFileSync(target, 'utf8');
  const stripped = stripRuntimePartitions(source, policy.matchers);
  assertParentsPresent(stripped.output, policy.parentsMustExist);
  const removed = stripped.removed;
  const ghim = pinPlatformVersion(stripped.output, policy.platformVersion);
  const output = ghim.output;

  // Cảnh báo độ lệch nền tảng — IN RA TRƯỚC khi quyết định xanh/đỏ, để con số
  // thật không biến mất khỏi log chỉ vì nó thôi làm đỏ gate.
  if (ghim.changed) {
    console.log(
      `⚠ ${policy.platformVersion.field}: nền tảng đang chạy "${ghim.live}", canonical ghim ` +
      `"${policy.platformVersion.pinned}" — ghim lại theo policy. Đây KHÔNG phải drift schema; ` +
      'nâng ghim thì sửa supabase/generated-types-policy.json (đi PR riêng).',
    );
  }

  const before = source.split('\n').length;
  const after = output.split('\n').length;

  if (removed.length === 0 && !ghim.changed) {
    console.log(`✅ ${policy.canonicalTypesPath}: không có runtime partition, phiên bản nền tảng đúng ghim (${before} dòng).`);
    return 0;
  }

  if (args.has('--check')) {
    console.error(`❌ ${policy.canonicalTypesPath} chưa chuẩn hoá:`);
    if (removed.length > 0) {
      console.error(`   • còn ${removed.length} runtime partition: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ` … (+${removed.length - 5})` : ''}`);
    }
    if (ghim.changed) {
      console.error(`   • ${policy.platformVersion.field} = "${ghim.live}", phải là "${policy.platformVersion.pinned}"`);
    }
    console.error('   Chạy: node scripts/normalize-supabase-types.mjs --write');
    return 1;
  }

  if (args.has('--write')) {
    writeFileSync(target, output, 'utf8');
    const phan = [];
    if (removed.length > 0) phan.push(`bỏ ${removed.length} runtime partition`);
    if (ghim.changed) phan.push(`ghim ${policy.platformVersion.field} về "${policy.platformVersion.pinned}"`);
    console.log(`✅ Đã ${phan.join(' + ')} trong ${policy.canonicalTypesPath} (${before} → ${after} dòng).`);
    return 0;
  }

  console.log(`Tìm thấy ${removed.length} runtime partition trong ${policy.canonicalTypesPath} (${before} → ${after} dòng nếu bỏ):`);
  for (const name of removed) console.log(`  - ${name}`);
  console.log('\nChạy với --write để chuẩn hoá, --check để dùng làm gate CI.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}
