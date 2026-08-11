#!/usr/bin/env node
// Gate: TÊN THAM SỐ của mỗi lời gọi `supabase.rpc()` phải khớp chữ ký server.
//
// VÌ SAO CẦN, VÀ VÌ SAO `check-rpc-surface` CHƯA ĐỦ
//   `check-rpc-surface.mjs` canh việc RPC có TỒN TẠI trên server. Nó không nhìn
//   vào tên tham số. Nhưng PostgREST gọi hàm Postgres bằng THAM SỐ CÓ TÊN, nên
//   sai một tên không phải "thiếu một trường" — Postgres không tìm ra overload
//   nào khớp và trả `PGRST202: Could not find the function ... in the schema
//   cache`. Cả lời gọi hỏng, và thông báo lỗi lại nói "không tìm thấy hàm",
//   khiến người sửa đi tìm migration bị thiếu thay vì nhìn vào tên tham số.
//
//   Đây đúng lớp lỗi đã bắt được nhiều lần ở phía bảng (tên CỘT sai →
//   `PGRST204`), chỉ khác là ở phía HÀM thì TypeScript che được ít hơn: chữ ký
//   trong `types.ts` chỉ phủ `src/`, còn Edge Function chạy Deno và `services/`
//   nằm ngoài tầm tsc hoàn toàn.
//
//   Đo 11/08/2026: 186 lời gọi đọc được, 0 cái sai. Mã đang sạch — gate này để
//   nó KHÔNG bẩn lại. Một migration đổi `p_building_id` thành `p_building` là
//   mọi caller vỡ câm, và không gì khác trong repo bắt được.
//
// KIỂM HAI CHIỀU
//   (1) Truyền tên KHÔNG có trong chữ ký nào của hàm.
//   (2) Bỏ sót tham số BẮT BUỘC — tham số không có `DEFAULT`. Phân biệt được vì
//       `pg_get_function_arguments` in nguyên chữ `DEFAULT` vào chữ ký; 90/230
//       định nghĩa có nó.
//   Hàm nạp chồng (nhiều definition) chỉ cần khớp ÍT NHẤT MỘT overload — đó
//   đúng là cách Postgres phân giải.
//
// CÁI GATE NÀY KHÔNG ĐO ĐƯỢC, và nói to ra
//   Đo 11/08/2026: 7 lời gọi truyền BIẾN (`rpc(ten, thamSo)`), 7 lời gọi có
//   SPREAD (`{ ...baseParams(f), p_bucket }`), 38 lời gọi không tham số. Nội
//   dung một biến hay một spread không đọc tĩnh được. Gate in ba số này mỗi
//   lượt; im lặng bỏ qua sẽ khiến "0 vi phạm" đọc thành "đã phủ hết", mà thực
//   tế mới phủ 186/238.
//
//   Chỗ này suýt hỏng theo hướng ngược lại: bản đầu tiên coi spread là VI PHẠM
//   và báo 7 lỗi giả trên mã hoàn toàn đúng. Một gate hay kêu oan cũng chết
//   như một gate không kêu — người ta tắt nó đi.
//
//   node scripts/check-rpc-arg-names.mjs
//
// Đọc contracts/surfaces/rpc-surface.json (đã sinh từ catalog live) — KHÔNG tự
// gọi mạng. Thoát 0 · 1 vi phạm · 3 KHÔNG ĐO ĐƯỢC.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boChuThichJs } from './lib/bo-chu-thich.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE_MANIFEST = join(repoRoot, 'contracts', 'surfaces', 'rpc-surface.json');

/** Dưới ngần này lời gọi đọc được thì bộ dò đã hỏng, không phải repo hết RPC. */
export const SAN_LOI_GOI = 100;
/** Dưới ngần này RPC trong manifest thì manifest hỏng. */
export const SAN_RPC = 150;

/**
 * `"p_voucher uuid, p_notes text DEFAULT NULL::text"` →
 * `{ tatCa: ['p_voucher','p_notes'], batBuoc: ['p_voucher'] }`.
 *
 * Cắt theo dấu phẩy Ở NGOÀI ngoặc: kiểu `numeric(12,2)` mang dấu phẩy bên trong
 * và cắt thô sẽ đẻ ra một tham số ma tên `2`.
 */
export function docChuKy(args) {
  const phan = [];
  let sau = 0;
  let cur = '';
  for (const ch of String(args || '')) {
    if (ch === '(' || ch === '[') sau += 1;
    else if (ch === ')' || ch === ']') sau -= 1;
    if (ch === ',' && sau === 0) {
      phan.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) phan.push(cur);

  const tatCa = [];
  const batBuoc = [];
  for (const p of phan) {
    const m = /^\s*(?:VARIADIC\s+|OUT\s+|INOUT\s+|IN\s+)?([a-z_][a-z0-9_]*)\s+\S/i.exec(p);
    if (!m) continue;
    tatCa.push(m[1]);
    // `DEFAULT` chỉ tính khi đứng như một từ riêng — tên kiểu có thể chứa chuỗi con.
    if (!/\bDEFAULT\b/i.test(p)) batBuoc.push(m[1]);
  }
  return { tatCa, batBuoc };
}

/**
 * Lấy object literal ngay sau `rpc('ten',` bằng cách ĐẾM NGOẶC, không bằng
 * `[^{}]*`: đối số lồng object (`{ p_payload: { a: 1 } }`) làm cách kia dừng
 * sớm và bỏ sót đúng những lời gọi phức tạp nhất.
 */
export function catObjectLiteral(s, tuViTri) {
  let i = tuViTri;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  if (s[i] !== '{') return null;
  let sau = 0;
  for (let j = i; j < s.length; j += 1) {
    if (s[j] === '{') sau += 1;
    else if (s[j] === '}') {
      sau -= 1;
      if (sau === 0) return s.slice(i + 1, j);
    }
  }
  return null;
}

/**
 * Khoá cấp một của một object literal. Trả `null` khi có SPREAD — nội dung
 * `...params` không đọc tĩnh được, và đoán bừa ở đây sẽ đẻ ra báo động giả về
 * "thiếu tham số bắt buộc" cho những lời gọi hoàn toàn đúng.
 *
 * Ba thứ từng làm bộ dò này sai, đều đã kiểm bằng mã thật trong repo:
 *   - CHÚ THÍCH giữa hai khoá (`useSpecialFeeBatch.ts`): dấu phẩy và tên khoá
 *     bị một dòng `//` chen vào giữa. Án lệ chung của repo: gate đọc MÃ, không
 *     đọc văn kể lại về mã → bỏ chú thích trước khi quét.
 *   - VIẾT TẮT `{ p }` (`luckyDrawApi.ts`), tương đương `{ p: p }` nhưng không
 *     có dấu hai chấm.
 *   - SPREAD `{ ...baseParams(f), p_bucket }` (`usePublicRoomsAnalytics.ts`).
 */
export function khoaCapMot(than) {
  // Chỉ bỏ chú thích TRONG thân object đối số, không bỏ cả file: `boChuThichJs`
  // coi `/*` là mở chú thích nên sẽ cắt nhầm chuỗi kiểu `path="/x/*"` ở .tsx.
  // Thân một object đối số hầu như không chứa mẫu đó, và phạm vi hẹp thì thiệt
  // hại của việc đoán sai cũng hẹp theo.
  const sach = boChuThichJs(than);

  let sau = 0;
  let dem = '';
  for (const ch of sach) {
    if (ch === '{' || ch === '[' || ch === '(') sau += 1;
    else if (ch === '}' || ch === ']' || ch === ')') sau -= 1;
    if (sau === 0) dem += ch;
  }
  if (/\.\.\./.test(dem)) return null;

  const ra = [];
  for (const phan of dem.split(',')) {
    const m =
      /^\s*(?:'([a-z_][a-z0-9_]*)'|"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s*:/i.exec(phan) ??
      // viết tắt: cả mảnh chỉ là một định danh, không dấu hai chấm
      /^\s*([a-z_][a-z0-9_]*)\s*$/i.exec(phan);
    if (m) ra.push(m[1] ?? m[2] ?? m[3]);
  }
  return ra;
}

/** Một lời gọi hợp lệ nếu khớp ÍT NHẤT MỘT overload — đúng cách Postgres phân giải. */
export function doiChieu(truyen, dinhNghia) {
  const lyDo = [];
  for (const d of dinhNghia) {
    const { tatCa, batBuoc } = docChuKy(d.args);
    const la = truyen.filter((k) => !tatCa.includes(k));
    const thieu = batBuoc.filter((k) => !truyen.includes(k));
    if (la.length === 0 && thieu.length === 0) return { dat: true, lyDo: [] };
    lyDo.push({ args: d.args, la, thieu });
  }
  return { dat: false, lyDo };
}

function lietKe(thuMuc) {
  const ra = [];
  const di = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) di(p);
      else if (/\.(ts|tsx)$/.test(e.name)) ra.push(p);
    }
  };
  di(thuMuc);
  return ra;
}

function main() {
  let man;
  try {
    man = JSON.parse(readFileSync(FILE_MANIFEST, 'utf8'));
  } catch (e) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: không đọc được ${FILE_MANIFEST} — ${e.message}`);
    console.error('   Sinh lại: node scripts/generate-rpc-surface.mjs');
    process.exit(3);
  }
  const rpcs = man.rpcs ?? {};
  if (Object.keys(rpcs).length < SAN_RPC) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: manifest chỉ có ${Object.keys(rpcs).length} RPC (sàn ${SAN_RPC}).`);
    process.exit(3);
  }

  const files = lietKe(join(repoRoot, 'src'));
  const van = [];
  let doDuoc = 0;
  let truyenBien = 0;
  let khongThamSo = 0;
  let ngoaiManifest = 0;
  let coSpread = 0;

  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\.rpc\(\s*['"]([a-z0-9_]+)['"]\s*(,?)/gi)) {
      const ten = m[1];
      if (!m[2]) {
        khongThamSo += 1;
        continue;
      }
      const than = catObjectLiteral(s, m.index + m[0].length);
      if (than === null) {
        truyenBien += 1;
        continue;
      }
      const e = rpcs[ten];
      // Không có trong manifest = việc của check-rpc-surface, không phải của gate này.
      if (!e || !(e.definitions ?? []).length) {
        ngoaiManifest += 1;
        continue;
      }
      const khoa = khoaCapMot(than);
      if (khoa === null) {
        coSpread += 1;
        continue;
      }
      doDuoc += 1;
      const kq = doiChieu(khoa, e.definitions);
      if (!kq.dat) van.push({ file: relative(repoRoot, f).replace(/\\/g, '/'), ten, lyDo: kq.lyDo });
    }
  }

  if (doDuoc < SAN_LOI_GOI) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ đọc được ${doDuoc} lời gọi (sàn ${SAN_LOI_GOI}).`);
    console.error('   Bộ dò hỏng hoặc cách gọi rpc đã đổi — đừng đọc thành "không có vi phạm".');
    process.exit(3);
  }

  console.log(
    `Đối chiếu ${doDuoc} lời gọi rpc với ${Object.keys(rpcs).length} RPC trong manifest.\n` +
    `KHÔNG đo được: ${truyenBien} truyền biến · ${coSpread} có spread · ` +
    `${khongThamSo} không tham số · ${ngoaiManifest} RPC ngoài manifest.\n`,
  );

  if (van.length > 0) {
    console.error(`❌ ${van.length} lời gọi có tên tham số không khớp chữ ký server:\n`);
    for (const v of van) {
      console.error(`  ${v.file} → ${v.ten}`);
      for (const l of v.lyDo) {
        const phan = [];
        if (l.la.length) phan.push(`thừa [${l.la.join(', ')}]`);
        if (l.thieu.length) phan.push(`thiếu bắt buộc [${l.thieu.join(', ')}]`);
        console.error(`     vs (${l.args}) → ${phan.join(' · ')}`);
      }
    }
    console.error('\n  PostgREST phân giải hàm bằng THAM SỐ CÓ TÊN: sai tên là cả lời gọi hỏng');
    console.error('  với PGRST202 "không tìm thấy hàm" — thông báo đó dễ bị đọc nhầm là thiếu migration.');
    process.exitCode = 1;
    return;
  }

  console.log('✅ Mọi lời gọi đọc được đều khớp ít nhất một overload trên server.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
