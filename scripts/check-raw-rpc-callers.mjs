#!/usr/bin/env node
// Ratchet: caller ở tier RỦI RO CAO không được thêm lời gọi RPC/Edge thô mới.
//
// VÌ SAO CẦN (plan Đợt 5 – V2)
//   `supabase.rpc("slug", {...})` không có gì kiểm slug đó tồn tại, kiểm tham số
//   đúng tên, hay kiểm kiểu trả về. Đổi tên một RPC trong migration thì TypeScript
//   im lặng — lỗi chỉ hiện ra lúc chạy, trên production, ở đúng những đường tiền
//   và phân quyền mà repo này quan tâm nhất.
//
//   Repo đã có wrapper typed cho vài RPC (contractCreateRpc, paymentRecordRpc,
//   customerCreditRpc…). Cái thiếu là thứ ngăn số lời gọi thô TĂNG TIẾP.
//
// KHÔNG PHẢI "CẤM RAW RPC" — mà là "không thêm nữa ở chỗ đắt nhất"
//   Đo 11/08/2026: 238 lời gọi thô trên toàn src/, trong đó 100 nằm ở 24 file
//   thuộc tier đòi soi chéo (money · authorization · migration · infrastructure).
//   Cấm sạch là bất khả thi trong một lát; ratchet thì thi hành được ngay.
//
// SO TẬP VÂN TAY, KHÔNG SO SỐ ĐẾM
//   Số đếm cho phép xoá một lời gọi rồi thêm một lời gọi khác trong cùng một lát
//   mà không ai thấy. Vân tay là `<file>::<slug>`.
//
//   node scripts/check-raw-rpc-callers.mjs
//   node scripts/check-raw-rpc-callers.mjs --write   # chốt lại baseline
//
// Thoát 0 · 1 khi có vân tay mới · 3 khi KHÔNG ĐO ĐƯỢC.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { xepTier } from './check-risk-classifier.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const RISK_MAP = join(repoRoot, 'tooling', 'risk-map.json');
const BASELINE = join(repoRoot, 'tooling', 'raw-rpc-callers-baseline.json');

/**
 * Bốn dạng lời gọi thô, khai tường minh vì mỗi dạng hỏng một kiểu khác nhau.
 *
 * Dạng `DYNAMIC` (slug là biến) đáng lo nhất: không grep ra được, không đổi tên
 * an toàn được, và không công cụ nào biết nó gọi cái gì. Nó vẫn vào baseline như
 * mọi thứ khác — mục đích của lát này là chặn TĂNG, không phải xử nợ cũ.
 */
const MAU = [
  { ten: 'rpc-literal', re: /\.rpc\(\s*["'`]([a-z0-9_]+)["'`]/g, lay: (m) => m[1] },
  { ten: 'edge-invoke', re: /functions\.invoke\(\s*["'`]([a-zA-Z0-9_-]+)["'`]/g, lay: (m) => `edge:${m[1]}` },
  { ten: 'rpc-dynamic', re: /\.rpc\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g, lay: (m) => `DYNAMIC:${m[1]}` },
];

export function vanTayCuaNguon(duong, nguon) {
  const out = new Set();
  for (const { re, lay } of MAU) {
    for (const m of nguon.matchAll(new RegExp(re.source, re.flags))) {
      out.add(`${duong}::${lay(m)}`);
    }
  }
  return out;
}

/** File nguồn thuộc tier đòi soi chéo. Đây là định nghĩa "rủi ro cao" của repo. */
export function fileRuiRoCao(files, tiers) {
  const cao = new Set(Object.entries(tiers).filter(([, t]) => t.crossReview === true).map(([k]) => k));
  return files.filter((p) => cao.has(xepTier(p, tiers)));
}

function main(argv) {
  const { tiers } = JSON.parse(readFileSync(RISK_MAP, 'utf8'));
  const caoTier = Object.values(tiers).filter((t) => t.crossReview === true).length;
  if (caoTier === 0) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: risk-map không còn tier nào đòi soi chéo.');
    console.error('   Không có định nghĩa "rủi ro cao" thì ratchet này không có phạm vi — đừng đọc thành "sạch".');
    process.exit(3);
  }

  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((p) => /^src\/.*\.tsx?$/.test(p));
  } catch (error) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC danh sách file: ${error.message}`);
    process.exit(3);
  }
  if (tracked.length < 500) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ thấy ${tracked.length} file src (repo có hơn 1.200). Phép quét hỏng.`);
    process.exit(3);
  }

  const hr = fileRuiRoCao(tracked, tiers);
  if (hr.length < 50) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ ${hr.length} file rơi vào tier rủi ro cao (đo 11/08/2026: 121).`);
    console.error('   Nhiều khả năng risk-map bị thu hẹp — ratchet sẽ xanh vì không còn gì để canh.');
    process.exit(3);
  }

  const hienTai = new Set();
  for (const p of hr) {
    for (const v of vanTayCuaNguon(p, readFileSync(join(repoRoot, p), 'utf8'))) hienTai.add(v);
  }

  if (argv.includes('--write')) {
    writeFileSync(
      BASELINE,
      JSON.stringify(
        {
          $comment:
            'Vân tay `<file>::<slug>` của mọi lời gọi RPC/Edge THÔ trong file thuộc tier đòi soi chéo. Danh sách CHỈ ĐƯỢC TEO. Cách đóng một mục: chuyển lời gọi sang wrapper typed rồi chạy --write, KHÔNG phải thêm tên vào đây.',
          generatedBy: 'node scripts/check-raw-rpc-callers.mjs --write',
          fingerprints: [...hienTai].sort(),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Đã chốt baseline: ${hienTai.size} vân tay trên ${hr.length} file rủi ro cao.`);
    return;
  }

  let baseline;
  try {
    baseline = new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).fingerprints);
  } catch (error) {
    console.error(`❌ KHÔNG ĐỌC ĐƯỢC baseline: ${error.message}`);
    console.error('   Thiếu baseline thì mọi lời gọi đều "mới" — chạy --write một lần để chốt hiện trạng.');
    process.exit(3);
  }

  const moi = [...hienTai].filter((v) => !baseline.has(v)).sort();
  const daXoa = [...baseline].filter((v) => !hienTai.has(v)).sort();

  if (moi.length > 0) {
    console.error(`❌ ${moi.length} lời gọi RPC/Edge THÔ mới ở file rủi ro cao:\n`);
    for (const v of moi) console.error(`  - ${v}`);
    console.error('\n  Những file này thuộc tier đòi soi chéo (tiền, phân quyền, migration, hạ tầng).');
    console.error('  `.rpc("slug")` không kiểm slug tồn tại, không kiểm tên tham số, không kiểm kiểu trả về —');
    console.error('  đổi tên RPC trong migration thì TypeScript im lặng và lỗi chỉ hiện lúc chạy.');
    console.error('\n  → dùng wrapper typed (xem src/lib/paymentRecordRpc.ts làm mẫu),');
    console.error('    hoặc nếu thật sự phải thêm: `--write` KÈM lý do trong commit message.');
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${hienTai.size} lời gọi thô trên ${hr.length} file rủi ro cao, không có cái nào mới.`);
  if (daXoa.length > 0) {
    console.log(`\n🎉 ${daXoa.length} lời gọi đã được gỡ — chạy --write để hạ baseline:`);
    for (const v of daXoa.slice(0, 10)) console.log(`   - ${v}`);
    if (daXoa.length > 10) console.log(`   … còn ${daXoa.length - 10}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv);
