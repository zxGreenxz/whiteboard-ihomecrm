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
  return {
    canonicalTypesPath: policy.canonicalTypesPath || 'src/integrations/supabase/types.ts',
    matchers: patterns.map((p) => new RegExp(p)),
    parentsMustExist: policy?.runtimePartitions?.parentsMustExist ?? [],
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
    const { output } = stripRuntimePartitions(source, policy.matchers);
    assertParentsPresent(output, policy.parentsMustExist);
    process.stdout.write(output);
    return 0;
  }

  const target = join(repoRoot, policy.canonicalTypesPath);
  const source = readFileSync(target, 'utf8');
  const { output, removed } = stripRuntimePartitions(source, policy.matchers);
  assertParentsPresent(output, policy.parentsMustExist);

  const before = source.split('\n').length;
  const after = output.split('\n').length;

  if (removed.length === 0) {
    console.log(`✅ ${policy.canonicalTypesPath}: không có runtime partition (${before} dòng).`);
    return 0;
  }

  if (args.has('--check')) {
    console.error(`❌ ${policy.canonicalTypesPath} còn ${removed.length} runtime partition:`);
    console.error(`   ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ` … (+${removed.length - 5})` : ''}`);
    console.error('   Chạy: node scripts/normalize-supabase-types.mjs --write');
    return 1;
  }

  if (args.has('--write')) {
    writeFileSync(target, output, 'utf8');
    console.log(`✅ Đã bỏ ${removed.length} runtime partition khỏi ${policy.canonicalTypesPath} (${before} → ${after} dòng).`);
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
