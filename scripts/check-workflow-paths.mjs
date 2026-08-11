#!/usr/bin/env node
// Gate: bộ lọc `paths:` của một workflow phải phủ MỌI script mà chính nó chạy.
//
// VÌ SAO CẦN
//   `paths:` quyết định workflow có chạy lại hay không. Nếu nó không liệt kê một
//   script mà job gọi, thì sửa đúng script đó KHÔNG kích hoạt workflow dùng nó.
//   Một checker bị làm hỏng sẽ nằm im cho tới lần có ai đó tình cờ đụng vào một
//   đường dẫn khác có trong danh sách — có thể là tuần sau, có thể là không bao giờ.
//
//   Đây không phải lo xa. Đo 11/08/2026 trên supabase-migrate.yml: job chạy ba
//   script, `paths:` chỉ liệt kê một. Hai checker migration (`check-no-auto-apply`,
//   `check-migration-provenance`) sửa xong sẽ không được chạy lại để kiểm chính nó.
//
//   Cùng họ với lỗi "matrix nói dối": một khai báo không ai đối chiếu sẽ lệch.
//
//   node scripts/check-workflow-paths.mjs
//
// Không cần credential, không đọc database.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = join(repoRoot, '.github', 'workflows');

/**
 * Glob của GitHub Actions → RegExp.
 *
 * `**` phải xử trước `*`, nếu không `scripts/**network-center**` biến thành hai
 * lần "không vượt dấu /" và không khớp gì cả. Cùng cái bẫy đã ghi ở
 * check-risk-classifier.mjs và check-test-matrix.mjs — ba chỗ, một luật.
 */
export function globSangRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

export function duocPhu(duong, globs) {
  return globs.some((g) => globSangRegex(g).test(duong));
}

/** `on:` trong YAML bị js-yaml đọc thành boolean true — đây là bẫy kinh điển của YAML 1.1. */
export function layOn(doc) {
  return doc?.on ?? doc?.[true] ?? null;
}

/** Mọi script `scripts/*.mjs` mà các job của workflow thực sự gọi. */
export function scriptDuocGoi(doc) {
  const found = new Set();
  for (const job of Object.values(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      for (const m of String(step?.run ?? '').matchAll(/\bscripts\/[\w.-]+\.mjs\b/g)) {
        found.add(m[0]);
      }
    }
  }
  return [...found].sort();
}

function main() {
  const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
  if (files.length === 0) {
    console.error('❌ KHÔNG ĐỌC ĐƯỢC workflow nào — phép đo hỏng, không phải "không có gì để kiểm".');
    process.exit(3);
  }

  const problems = [];
  let soCoLoc = 0;
  let soKiem = 0;

  for (const f of files) {
    const duong = `.github/workflows/${f}`;
    let doc;
    try {
      doc = yaml.load(readFileSync(join(WF_DIR, f), 'utf8'));
    } catch (error) {
      console.error(`❌ KHÔNG PARSE ĐƯỢC ${duong}: ${error.message}`);
      process.exit(3);
    }
    const on = layOn(doc);
    if (on === null) {
      console.error(`❌ ${duong} không đọc được mục \`on:\` — nhiều khả năng bẫy YAML 1.1 (on → true).`);
      process.exit(3);
    }

    // Kiểm TỪNG trigger riêng, không lấy hợp của chúng.
    //
    // Bản đầu lấy hợp `push ∪ pull_request`, và đột biến bắt được ngay: bỏ một
    // script khỏi `push.paths` thì gate vẫn xanh vì `pull_request.paths` còn giữ.
    // Nhưng đó đúng là lỗ thật — push lên main sẽ không chạy lại workflow, và
    // main mới là nhánh deploy. Hợp hai danh sách là cách làm cho gate dễ xanh,
    // không phải cách làm cho nó đúng.
    const theoTrigger = [
      ['push', on.push?.paths],
      ['pull_request', on.pull_request?.paths],
    ].filter(([, p]) => Array.isArray(p) && p.length > 0);

    if (theoTrigger.length === 0) continue;
    soCoLoc++;

    for (const s of scriptDuocGoi(doc)) {
      for (const [trigger, globs] of theoTrigger) {
        soKiem++;
        if (!duocPhu(s, globs)) {
          problems.push(
            `${duong}: job chạy \`${s}\` nhưng \`on.${trigger}.paths\` không phủ nó.\n` +
            `      → sửa script đó sẽ KHÔNG kích hoạt workflow này qua ${trigger}. Thêm vào paths.`,
          );
        }
      }
    }
  }

  if (soCoLoc === 0) {
    console.error('❌ KHÔNG KIỂM ĐƯỢC: không workflow nào có `paths:`. Trước 11/08/2026 có hai cái —');
    console.error('   nếu bộ lọc bị gỡ hết thì đây là thay đổi lớn, không phải trạng thái sạch.');
    process.exit(3);
  }

  if (problems.length > 0) {
    console.error(`❌ ${problems.length} script không được bộ lọc paths phủ:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${soCoLoc} workflow có bộ lọc paths, ${soKiem} lời gọi script đều được phủ.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
