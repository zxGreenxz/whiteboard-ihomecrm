#!/usr/bin/env node
// Kiểm chứng TỪNG bằng chứng `catalog:*` trong migration-provenance.json.
//
// VÌ SAO CẦN (plan Đợt 1b, §0.7)
//   214 file mang state `catalog-proven`, mỗi file kèm một chuỗi bằng chứng dạng
//   `catalog:function:public.terminate_contract_move_out_impl`. Chuỗi đó là LỜI
//   KHAI của bộ sinh. Cho tới nay chưa gì đối chiếu nó với catalog thật, nên
//   "catalog-proven" đúng nghĩa là "bộ sinh nói rằng nó đã chứng minh".
//
//   Plan chỉ đòi lấy mẫu ngẫu nhiên n≈30. Nhưng đối chiếu được TOÀN BỘ thì lấy
//   mẫu là tự bịt mắt: mẫu 30/214 để lọt một sai lệch với xác suất đáng kể, và
//   chi phí chạy hết cũng chỉ là vài câu truy vấn.
//
// CHỈ ĐỌC
//   Năm câu SELECT trên pg_catalog. Không ghi gì, không đụng dữ liệu nghiệp vụ.
//   PAT đọc từ CLAUDE.local.md lúc chạy và KHÔNG BAO GIỜ được in ra.
//
//   node scripts/verify-catalog-proven.mjs
//   node scripts/verify-catalog-proven.mjs --write   # ghi hồ sơ bằng chứng
//
// Thoát 0 · 1 khi có bằng chứng không đối chiếu được · 3 khi KHÔNG KIỂM ĐƯỢC
// (thiếu PAT, mạng hỏng) — "không hỏi được catalog" KHÁC "đã hỏi và khớp".

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPat, readProjectRef } from './capture-production-catalog.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROVENANCE = join(repoRoot, 'supabase', 'migration-provenance.json');
const OUT = join(repoRoot, 'docs', 'generated', 'catalog-proven-verification.json');

/** `catalog:<loai>:<ten>` → { loai, ten }. Trả null nếu không phải bằng chứng catalog. */
export function tachBangChung(chuoi) {
  const m = /^catalog:([a-z]+):(.+)$/.exec(chuoi);
  return m ? { loai: m[1], ten: m[2] } : null;
}

/**
 * Chuẩn hoá tên để so.
 *
 * Bằng chứng ghi `public.ten_ham`, còn pg_catalog trả `ten_ham` kèm schema riêng.
 * Bỏ tiền tố `public.` là đủ cho repo này (mọi object nghiệp vụ đều ở public), và
 * giữ nguyên phần còn lại — KHÔNG lowercase, vì Postgres phân biệt hoa/thường khi
 * tên được đặt trong nháy kép và ta không muốn hai object khác nhau khớp nhau.
 */
export function chuanHoa(ten) {
  // Bằng chứng có thể ghi `ten_ham` trần (ngầm hiểu public) hoặc `app_private.x`.
  // Bốn schema xuất hiện thật: public 310 · app_private 204 · storage 4 · clone_org 3.
  return ten.includes('.') ? ten : `public.${ten}`;
}

// Truy vấn TẤT CẢ schema, trả `schema.ten`.
//
// Bản đầu chỉ hỏi `nspname = 'public'` và báo 254 bằng chứng "không tìm thấy" —
// toàn bộ là `app_private.*`. Lỗi nằm ở bộ kiểm, không ở manifest. Nếu tin ngay
// kết quả đó thì kết luận sẽ là "hạ 254 file xuống unknown", tức phá một manifest
// đúng vì một truy vấn thiếu.
const SCHEMA = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'`;

// Mỗi loại object có DẠNG TÊN riêng, và đó là chỗ phép so này sai hai lần liên tiếp:
//
//   function/table/index/view   `schema.ten`        (2 phần)
//   policy/trigger              `schema.bang.ten`   (3 phần) — chúng thuộc về một bảng
//
// Lần đầu tôi chỉ hỏi schema `public` ⇒ 254 bằng chứng "không tìm thấy", toàn bộ là
// app_private. Lần hai sửa schema nhưng vẫn trả 2 phần cho policy/trigger ⇒ 56 chỗ
// nữa. Cả hai lần, tin ngay kết quả sẽ dẫn tới kết luận "hạ hàng trăm file xuống
// unknown" — phá một manifest ĐÚNG vì một truy vấn thiếu.
//
// Bài học ghi lại vì nó lặp: một phép đối chiếu tên phải khai rõ dạng tên của TỪNG
// loại, chứ không giả định mọi loại giống nhau.
const SQL = {
  function: `SELECT n.nspname || '.' || p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${SCHEMA}`,
  table: `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMA} AND c.relkind IN ('r','p')`,
  view: `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMA} AND c.relkind IN ('v','m')`,
  index: `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMA} AND c.relkind = 'i'`,
  trigger: `SELECT n.nspname || '.' || c.relname || '.' || t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMA} AND NOT t.tgisinternal`,
  policy: `SELECT n.nspname || '.' || c.relname || '.' || p.polname AS name FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMA}`,
};

/** Số phần tên kỳ vọng cho mỗi loại — dùng làm chốt chặn chống so nhầm dạng. */
const SO_PHAN = { function: 2, table: 2, view: 2, index: 2, trigger: 3, policy: 3 };

async function truyVan(sql, pat, ref) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Management API ${res.status}`); // không in body: có thể vọng lại câu SQL
  return JSON.parse(await res.text());
}

export function gomBangChung(entries) {
  const theoLoai = new Map();
  let khongPhaiCatalog = 0;
  for (const e of entries) {
    for (const ev of e.evidence ?? []) {
      const t = tachBangChung(ev);
      if (!t) {
        khongPhaiCatalog++;
        continue;
      }
      if (!theoLoai.has(t.loai)) theoLoai.set(t.loai, new Map());
      const m = theoLoai.get(t.loai);
      if (!m.has(t.ten)) m.set(t.ten, []);
      m.get(t.ten).push(e.path);
    }
  }
  return { theoLoai, khongPhaiCatalog };
}

async function main(argv) {
  const prov = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
  const cp = prov.entries.filter((e) => e.state === 'catalog-proven');

  if (cp.length < 100) {
    console.error(`❌ KHÔNG KIỂM ĐƯỢC: chỉ ${cp.length} entry catalog-proven (đo 11/08/2026: 214).`);
    console.error('   Manifest bị thu hẹp thì phép kiểm này mất phạm vi — đừng đọc thành "sạch".');
    process.exit(3);
  }

  const { theoLoai, khongPhaiCatalog } = gomBangChung(cp);
  const pat = readPat();
  if (!pat) {
    console.error('❌ KHÔNG KIỂM ĐƯỢC: không tìm thấy PAT (SUPABASE_PAT hoặc CLAUDE.local.md).');
    console.error('   "Không hỏi được catalog" KHÁC "đã hỏi và khớp".');
    process.exit(3);
  }
  const ref = readProjectRef();

  const that = new Map();
  for (const loai of theoLoai.keys()) {
    if (!SQL[loai]) {
      console.error(`❌ KHÔNG KIỂM ĐƯỢC loại bằng chứng "${loai}" — chưa có câu truy vấn tương ứng.`);
      process.exit(3);
    }
    try {
      const rows = await truyVan(SQL[loai], pat, ref);
      that.set(loai, new Set(rows.map((r) => r.name)));
    } catch (error) {
      console.error(`❌ KHÔNG KIỂM ĐƯỢC: ${error.message} khi hỏi ${loai}.`);
      process.exit(3);
    }
  }

  const thieu = [];
  const saiDang = [];
  let daKiem = 0;
  for (const [loai, ds] of theoLoai) {
    const co = that.get(loai);
    if (co.size === 0) {
      console.error(`❌ KHÔNG KIỂM ĐƯỢC: catalog trả 0 ${loai} — truy vấn hỏng, không phải "database rỗng".`);
      process.exit(3);
    }
    for (const [ten, files] of ds) {
      daKiem++;
      const day = chuanHoa(ten);
      // Chốt chặn dạng tên. Nếu bằng chứng có số phần khác kỳ vọng thì phép so
      // bên dưới sẽ LUÔN trượt, và "không tìm thấy" sẽ bị đọc thành "object
      // không tồn tại" — đúng hai lần tôi đã kết luận sai khi viết script này.
      // Sai dạng phải hiện ra là SAI ĐỊNH DẠNG, không phải thiếu object.
      if (day.split('.').length !== SO_PHAN[loai]) {
        saiDang.push({ loai, ten, mong: SO_PHAN[loai], files });
        continue;
      }
      if (!co.has(day)) thieu.push({ loai, ten, files });
    }
  }

  const ketQua = {
    $comment:
      'Đối chiếu TỪNG bằng chứng catalog:* của các entry catalog-proven với pg_catalog production. Không lấy mẫu — đối chiếu được toàn bộ thì lấy mẫu là tự bịt mắt. Chỉ đọc, không ghi gì lên production.',
    verifiedAt: new Date().toISOString().slice(0, 10),
    projectRef: ref,
    soEntryCatalogProven: cp.length,
    soBangChungDaKiem: daKiem,
    bangChungKhongPhaiCatalog: khongPhaiCatalog,
    theoLoai: Object.fromEntries([...theoLoai].map(([l, m]) => [l, m.size])),
    soCatalogThat: Object.fromEntries([...that].map(([l, s]) => [l, s.size])),
    khongDoiChieuDuoc: thieu,
    saiDinhDangTen: saiDang,
  };

  if (argv.includes('--write')) {
    writeFileSync(OUT, JSON.stringify(ketQua, null, 2) + '\n');
    console.log(`Đã ghi ${OUT.replace(repoRoot, '.')}`);
  }

  console.log(
    `Đối chiếu ${daKiem} bằng chứng catalog của ${cp.length} entry catalog-proven ` +
    `(${[...theoLoai].map(([l, m]) => `${l}:${m.size}`).join(' ')})`,
  );

  if (saiDang.length > 0) {
    console.error(`\n❌ ${saiDang.length} bằng chứng SAI ĐỊNH DẠNG tên (không phải "object thiếu"):\n`);
    for (const t of saiDang.slice(0, 10)) {
      console.error(`  - ${t.loai}:${t.ten} — kỳ vọng ${t.mong} phần (schema.${t.mong === 3 ? 'bảng.tên' : 'tên'})`);
    }
    console.error('\n  Bộ sinh manifest ghi sai dạng, hoặc script này chưa biết loại đó.');
    console.error('  Đừng hạ trạng thái file nào vì lỗi này — nó nói về ĐỊNH DẠNG, không về catalog.');
    process.exitCode = 1;
    return;
  }

  if (thieu.length > 0) {
    console.error(`\n❌ ${thieu.length} bằng chứng KHÔNG tìm thấy trong catalog production:\n`);
    for (const t of thieu.slice(0, 20)) {
      console.error(`  - ${t.loai}:${t.ten}\n      khai bởi: ${t.files.slice(0, 2).join(', ')}`);
    }
    if (thieu.length > 20) console.error(`  … còn ${thieu.length - 20}`);
    console.error('\n  "catalog-proven" nghĩa là object CÓ THẬT trong catalog. Không tìm thấy thì');
    console.error('  trạng thái đó là lời khai chưa được chứng minh — sinh lại manifest hoặc');
    console.error('  hạ trạng thái các file trên xuống unknown.');
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${daKiem}/${daKiem} bằng chứng đều khớp catalog production.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv);
