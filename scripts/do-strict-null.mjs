#!/usr/bin/env node
// CÔNG CỤ ĐO, KHÔNG PHẢI GATE: còn bao xa mới bật được `strictNullChecks` cho
// toàn app.
//
// Nói rõ ngay đầu file vì repo này gần như chỉ có gate: script này KHÔNG chặn
// gì cả và KHÔNG nằm trong CI. Nó tồn tại để lát di trú tiếp theo khỏi phải
// dựng lại một tsconfig tạm mỗi lần, và để con số "còn bao nhiêu" là thứ đo
// được chứ không phải cảm giác.
//
// VÌ SAO KHÔNG BẬT CỜ MỘT PHÁT
//   Đo 11/08/2026 (trước lát đầu): 360 lỗi trên 80 file. Bật thẳng là 360 chỗ
//   phải sửa trong một PR — không ai đọc nổi diff đó, và mỗi chỗ sửa vội sẽ là
//   một `!` hoặc `?? ''` bẻ dữ liệu cho vừa kiểu.
//
// MẪU ÁP ĐẢO, và đó là tin tốt
//   176/360 lỗi là `X | null` không gán được vào `X | undefined`. Gốc chung:
//   kiểu VIẾT TAY khai `field?: string` (nghĩa là `| undefined`) trong khi DB
//   trả `| null`. Chữa bằng cách sửa KIỂU cho khớp DB, không phải rắc
//   `?? undefined` ở chỗ gọi — cái sau là bẻ dữ liệu cho vừa một cái kiểu sai,
//   và nó nhân bản theo số chỗ gọi.
//
//   node scripts/do-strict-null.mjs            # tổng quan
//   node scripts/do-strict-null.mjs --file     # xếp theo file
//   node scripts/do-strict-null.mjs --mau      # xếp theo mẫu lỗi
//
// Luôn thoát 0 — đây là thước đo, không phải cửa chặn.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function xepTheoMau(dong) {
  const mau = {};
  for (const l of dong) {
    const m = /error TS2322: Type '([^']{0,45})' is not assignable to type '([^']{0,45})'/.exec(l);
    const k = m ? `${m[1]} → ${m[2]}` : /error (TS\d+)/.exec(l)?.[1] ?? '(khác)';
    mau[k] = (mau[k] || 0) + 1;
  }
  return Object.entries(mau).sort((a, b) => b[1] - a[1]);
}

export function xepTheoFile(dong) {
  const f = {};
  for (const l of dong) {
    const k = l.split('(')[0];
    f[k] = (f[k] || 0) + 1;
  }
  return Object.entries(f).sort((a, b) => b[1] - a[1]);
}

function main() {
  const tmp = join(repoRoot, 'tsconfig.do-strict-null.json');
  writeFileSync(
    tmp,
    JSON.stringify(
      { extends: './tsconfig.app.json', compilerOptions: { strictNullChecks: true, noEmit: true } },
      null,
      2,
    ) + '\n',
  );
  let dong;
  try {
    // Gọi thẳng entrypoint JS của tsc: spawn `.cmd` với shell:false ném EINVAL
    // trên Windows/Node≥20. Cùng bẫy đã ghi ở check-ts-baseline.
    const r = spawnSync(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tmp], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    dong = String(r.stdout ?? '').split(/\r?\n/).filter((l) => /error TS/.test(l));
  } finally {
    rmSync(tmp, { force: true });
  }

  const soFile = new Set(dong.map((l) => l.split('(')[0])).size;
  console.log(`strictNullChecks: ${dong.length} lỗi trên ${soFile} file.\n`);

  if (process.argv.includes('--file')) {
    for (const [f, n] of xepTheoFile(dong).slice(0, 25)) console.log(`${String(n).padStart(4)}  ${f}`);
    return;
  }
  if (process.argv.includes('--mau')) {
    for (const [m, n] of xepTheoMau(dong).slice(0, 20)) console.log(`${String(n).padStart(4)}  ${m}`);
    return;
  }

  const mau = xepTheoMau(dong);
  const nullSangUndefined = mau
    .filter(([k]) => / \| null → .*\| undefined$/.test(k))
    .reduce((s, [, n]) => s + n, 0);
  console.log(`  ${nullSangUndefined} lỗi là "X | null → X | undefined" — kiểu viết tay hẹp hơn DB.`);
  console.log('  Chữa bằng cách sửa KIỂU cho khớp DB, KHÔNG rắc `?? undefined` ở chỗ gọi.\n');
  console.log('  Top file:  node scripts/do-strict-null.mjs --file');
  console.log('  Top mẫu :  node scripts/do-strict-null.mjs --mau');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
