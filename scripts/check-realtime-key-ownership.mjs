#!/usr/bin/env node
// Gate: mỗi query key mà hub realtime BẮN VÀO phải có ít nhất một query THẬT
// nhận được.
//
// LỚP LỖI NÀY LÀ CÂM TUYỆT ĐỐI
//   `invalidateQueries` khớp theo PREFIX và KHÔNG báo gì khi không khớp ai. Bắn
//   vào `["invoice-statistic"]` trong khi màn hình dùng `["invoice-statistics"]`
//   thì: không lỗi, không cảnh báo, hub vẫn chạy, sự kiện vẫn tới — chỉ là dữ
//   liệu trên màn không bao giờ mới lại. Người dùng bấm F5 rồi nghĩ mình nhớ
//   nhầm. Đây đúng lớp hỏng mà cả hệ realtime này sinh ra để chống, chỉ dịch
//   xuống một tầng: từ "bảng không được publish" thành "key không ai nghe".
//
//   `check-realtime-descriptors` đã chặn ba nguồn ở tầng BẢNG (publication ↔ hub
//   ↔ descriptor). Không gì chặn tầng KEY.
//
// ĐỌC MODULE THẬT, KHÔNG CHÉP TAY
//   Danh sách key lấy bằng cách nạp chính `src/hooks/realtime` qua vite-node —
//   cùng cách `check-realtime-descriptors` làm, và vì cùng lý do: repo này đã có
//   bốn ca "test kiểm bản chép thay vì kiểm code thật", mà một bản chép nằm
//   trong gate là cách chắc chắn nhất để gate xanh trong khi mã đã đổi.
//
// BA DẠNG BẮN ĐƯỢC PHỦ
//   (a) viết thẳng      `invalidateQueries({ queryKey: ["income-expenses"] })`
//   (b) lặp mảng tại chỗ `for (const k of [["a"],["b"]]) …({ queryKey: k })`
//   (c) hằng mảng cấp module rồi lặp:
//         const INVALIDATE_KEYS = [["a"], ["b"]] as const;
//         for (const key of INVALIDATE_KEYS) …({ queryKey: key })
//
//   Dạng (c) bị bỏ sót ở bản đầu (lô 71) và đã ghi rõ khoảng trống đó trong
//   commit thay vì để người đọc tưởng gate đã kín. Lô 72 bịt lại: `incomeVoucherCancel`
//   và `annotateMutations` dùng đúng dạng này.
//
// CHIỀU NGƯỢC LẠI THÌ KHÔNG KIỂM
//   "Query nào đọc bảng X mà hub không bắn vào" mới là câu hỏi đắt hơn, nhưng nó
//   cần biết mỗi query đọc bảng nào — thông tin không có trong query key. Gate
//   này CỐ Ý chỉ làm một chiều, và nói rõ ra, thay vì giả vờ phủ cả hai.
//
//   node scripts/check-realtime-key-ownership.mjs
//
// Không cần credential. Thoát 0 · 1 vi phạm · 3 KHÔNG ĐO ĐƯỢC.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boChuThichJs } from './lib/bo-chu-thich.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Dưới ngần này key trong descriptor thì bộ nạp hỏng, không phải hub rỗng. */
export const SAN_SO_KEY = 40;
/** Dưới ngần này gốc query key trong src thì bộ quét hỏng. */
export const SAN_SO_QUERY = 100;

/**
 * Key mà hub bắn NHƯNG cố ý không có query nào nhận, kèm lý do đo được.
 * Danh sách này phải ngắn — mỗi dòng là một lần bắn vào khoảng không.
 */
export const MIEN_TRU = {
  // Hub xử `business-performance` bằng `predicate` chứ không bằng prefix thường
  // (xem `flushBusinessPerformance`), nên nó không đi qua đường `entry.keys`
  // như các key khác. Vẫn để trong descriptor để người đọc thấy quan hệ bảng →
  // báo cáo, nhưng phép đối chiếu prefix ở đây không áp dụng.
  'business-performance': 'hub invalidate bằng predicate, không bằng prefix',
};

/**
 * Gốc query key mà ứng dụng THẬT SỰ dùng.
 *
 * Ba dạng, và dạng thứ ba là chỗ bộ dò này TỪNG báo oan: `useFinancialAnalysis`
 * viết `const FA = "financial-analysis"` rồi `queryKey: [FA, …]`. Chỉ bắt chuỗi
 * viết thẳng thì gate kết luận hub đang bắn vào khoảng không, trong khi màn hình
 * vẫn nhận bình thường. Một gate hay kêu oan chết y như gate không kêu.
 */
export function gocQueryKeyDangDung(vanBanTheoFile) {
  const ra = new Set();
  for (const noiDung of vanBanTheoFile) {
    const s = boChuThichJs(noiDung);

    // (1) hằng chuỗi trong CÙNG file: const FA = "financial-analysis"
    const hang = new Map();
    for (const m of s.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]\s*;/g)) {
      hang.set(m[1], m[2]);
    }

    // (2) queryKey: ["ten", …] · queryKey: ['ten']
    for (const m of s.matchAll(/queryKey:\s*\[\s*['"]([^'"]+)['"]/g)) ra.add(m[1]);

    // (3) queryKey: [FA, …] — giải hằng ở (1)
    for (const m of s.matchAll(/queryKey:\s*\[\s*([A-Za-z_$][\w$]*)\s*[,\]]/g)) {
      const v = hang.get(m[1]);
      if (v) ra.add(v);
    }

    // (4) const KHOA_X = ['ten'] as const → dùng qua spread ở nơi khác
    for (const m of s.matchAll(/=\s*\[\s*['"]([^'"]+)['"]\s*\]\s*as const/g)) ra.add(m[1]);

    // (5) key dựng sẵn rồi truyền viết tắt:
    //       const queryKey = useMemo(() => ['quayso', a, b] as const, […]);
    //       useQuery({ queryKey, queryFn })
    //     Nguyên mẫu: QuaySoPage.tsx. Không bắt dạng này thì gate báo màn quay số
    //     đang ghi cache vào khoảng không, trong khi nó chạy đúng.
    for (const m of s.matchAll(/queryKey\s*=\s*(?:useMemo\(\s*\(\)\s*=>\s*)?\[\s*['"]([^'"]+)['"]/g)) {
      ra.add(m[1]);
    }
  }
  return ra;
}

/**
 * Gốc key mà mã BẮN VÀO bằng `invalidateQueries`, ở ba dạng có thật trong repo
 * (xem đầu file). Dạng (b) và (c) là chỗ key chết thật sự nằm — chỉ bắt dạng (a)
 * thì gate báo "0 vi phạm" trên đúng những file có lỗi, tức tệ hơn không có gate.
 *
 * Nhận dạng (b)/(c) một cách CHẶT: phải đúng idiom `for (const X of …)` và trong
 * thân vòng lặp phải có `queryKey: X`. Bắt mọi mảng-của-mảng sẽ dính đủ thứ dữ
 * liệu không liên quan và biến gate thành máy kêu oan.
 */
export function gocKeyBiBanVao(vanBanTheoFile) {
  const ra = new Map();
  const them = (k, f) => {
    if (!ra.has(k)) ra.set(k, new Set());
    ra.get(k).add(f);
  };
  for (const [ten, noiDung] of vanBanTheoFile) {
    const s = boChuThichJs(noiDung);
    // Cả HỌ API nhắm theo key, không riêng `invalidateQueries`: `refetchQueries`,
    // `resetQueries`, `removeQueries`, `cancelQueries` cũng im lặng khi key không
    // khớp ai. Riêng `setQueryData` còn tệ hơn một bậc — ghi vào một key không ai
    // đọc thì dữ liệu nằm lại trong cache mãi mãi mà màn hình không thấy gì.
    const HO_API = /(?:invalidate|refetch|reset|remove|cancel)Queries\(\s*\{\s*queryKey:\s*\[\s*['"]([^'"]+)['"]/g;
    for (const m of s.matchAll(HO_API)) them(m[1], ten);
    for (const m of s.matchAll(/setQueryData\(\s*\[\s*['"]([^'"]+)['"]/g)) them(m[1], ten);
    for (const m of s.matchAll(/for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+\[/g)) {
      const bien = m[1];
      let sau = 0;
      let i = m.index + m[0].length - 1;
      let het = -1;
      for (let j = i; j < s.length; j += 1) {
        if (s[j] === '[') sau += 1;
        else if (s[j] === ']') {
          sau -= 1;
          if (sau === 0) {
            het = j;
            break;
          }
        }
      }
      if (het < 0) continue;
      const than = s.slice(het, het + 400);
      if (!new RegExp(`queryKey:\\s*${bien}\\b`).test(than)) continue;
      for (const k of s.slice(i, het).matchAll(/\[\s*['"]([^'"]+)['"]/g)) them(k[1], ten);
    }

    // (c) hằng mảng khai ở cấp module rồi lặp ở chỗ khác:
    //       const INVALIDATE_KEYS = [["a"], ["b"]] as const;
    //       for (const key of INVALIDATE_KEYS) invalidateQueries({ queryKey: key })
    //     Đây là dạng `incomeVoucherCancel` và `annotateMutations` dùng. Lô 71
    //     bỏ sót nó và đã nói rõ trong commit; lô 72 bịt lại.
    for (const m of s.matchAll(/for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Z][A-Z0-9_]*)\s*\)/g)) {
      const [, bien, hangTen] = m;
      const than = s.slice(m.index, m.index + 400);
      if (!new RegExp(`queryKey:\\s*${bien}\\b`).test(than)) continue;
      const khai = new RegExp(`\\bconst\\s+${hangTen}\\s*=\\s*\\[`).exec(s);
      if (!khai) continue;
      let sau = 0;
      const i = khai.index + khai[0].length - 1;
      let het = -1;
      for (let j = i; j < s.length; j += 1) {
        if (s[j] === '[') sau += 1;
        else if (s[j] === ']') {
          sau -= 1;
          if (sau === 0) {
            het = j;
            break;
          }
        }
      }
      if (het < 0) continue;
      for (const k of s.slice(i, het).matchAll(/\[\s*['"]([^'"]+)['"]/g)) them(k[1], ten);
    }
  }
  return ra;
}

/** Nạp descriptor thật qua vite-node và trả tập gốc key nó bắn vào. */
function docKeyTuHub() {
  const tmp = join(repoRoot, 'node_modules', '.cache', '__realtime-keys.ts');
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(
    tmp,
    [
      'import { SYNC_ENTRIES } from "../../src/hooks/realtime";',
      'const goc = new Set<string>();',
      'for (const e of SYNC_ENTRIES) for (const k of e.keys) if (typeof k[0] === "string") goc.add(k[0] as string);',
      'console.log(JSON.stringify([...goc]));',
    ].join('\n'),
    'utf8',
  );
  try {
    // Đường dẫn TƯƠNG ĐỐI + shell:true: npx trên Windows là npx.cmd (Node từ
    // chối spawn .cmd khi shell:false), mà shell:true lại không bọc nháy đối số
    // — đường dẫn tuyệt đối "C:\Users\Nguyen Tam\…" sẽ bị cắt ở dấu cách.
    return spawnSync('npx', ['vite-node', 'node_modules/.cache/__realtime-keys.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
      timeout: 10 * 60 * 1000,
    });
  } finally {
    rmSync(tmp, { force: true });
  }
}

function docSrc() {
  const ra = [];
  const di = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) di(p);
      // Bỏ file test: chúng cố ý dựng key giả để kiểm chính bộ invalidate.
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) {
        ra.push([relative(repoRoot, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')]);
      }
    }
  };
  di(join(repoRoot, 'src'));
  return ra;
}

function main() {
  const dump = docKeyTuHub();
  const dong = String(dump.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
  let banRa;
  try {
    banRa = JSON.parse(dong);
    if (!Array.isArray(banRa)) throw new Error('không phải mảng');
  } catch (e) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: không nạp được descriptor qua vite-node — ${e.message}`);
    console.error(String(dump.stderr ?? '').split(/\r?\n/).slice(0, 8).join('\n'));
    process.exit(3);
  }
  if (banRa.length < SAN_SO_KEY) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ đọc được ${banRa.length} gốc key (sàn ${SAN_SO_KEY}).`);
    console.error('   Descriptor đổi hình dạng hoặc bộ nạp hỏng — đừng đọc thành "không có key nào sai".');
    process.exit(3);
  }

  const src = docSrc();
  const dung = gocQueryKeyDangDung(src.map(([, t]) => t));
  if (dung.size < SAN_SO_QUERY) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ thấy ${dung.size} gốc query key trong src (sàn ${SAN_SO_QUERY}).`);
    process.exit(3);
  }

  const mienTru = Object.keys(MIEN_TRU);
  const banTuMa = gocKeyBiBanVao(src);
  const tatCaBan = new Map();
  for (const k of banRa) tatCaBan.set(k, new Set(['src/hooks/realtime (descriptor)']));
  for (const [k, nguon] of banTuMa) {
    if (!tatCaBan.has(k)) tatCaBan.set(k, new Set());
    for (const n of nguon) tatCaBan.get(k).add(n);
  }
  const mo = [...tatCaBan.keys()].filter((k) => !dung.has(k) && !mienTru.includes(k)).sort();

  console.log(
    `Bắn vào ${tatCaBan.size} gốc key (${banRa.length} từ descriptor realtime) · ` +
    `ứng dụng dùng ${dung.size} gốc key · miễn trừ ${mienTru.length}.`,
  );

  if (mo.length > 0) {
    console.error(`\n❌ ${mo.length} key được bắn vào mà KHÔNG query nào nhận:\n`);
    for (const k of mo) {
      console.error(`  - ${k}`);
      for (const n of tatCaBan.get(k)) console.error(`       ${n}`);
    }
    console.error('\n  `invalidateQueries` khớp theo prefix và IM LẶNG khi không khớp ai:');
    console.error('  không lỗi, không cảnh báo, màn hình chỉ đơn giản là không mới lại nữa.');
    console.error('  Sửa chính tả, hoặc xoá key nếu màn đó đã bỏ.');
    process.exitCode = 1;
    return;
  }

  console.log('✅ Mọi key được bắn vào đều có query thật nhận.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
