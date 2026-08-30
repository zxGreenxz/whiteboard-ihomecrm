#!/usr/bin/env node
// BỘ KIỂM BẢO MẬT chạy trên DATABASE VỪA KHÔI PHỤC (baseline + forward lane) —
// bước cuối của bài diễn tập, nhận connection string đích thay vì Management API.
//
// VÌ SAO KHÔNG DÙNG THẲNG các gate production (check-view-invoker.mjs,
// check-stable-fn-locks.mjs, check-definer-acl.mjs, capture-production-catalog.mjs)
//   Cả bốn nói chuyện với production qua Management API + PAT, project ref ghim
//   cứng — chúng trả lời "production ĐANG sạch không?". Câu của bài diễn tập
//   khác: "bản DỰNG LẠI từ baseline + forward lane có sạch không?" — nếu không,
//   thì ngày phải khôi phục thật ta sẽ dựng lại một hệ thống hở. SQL của từng
//   phép bên dưới chép NGUYÊN VĂN từ gate gốc (ghi nguồn tại chỗ); đổi luật ở
//   gate gốc thì đổi cả đây — mỗi phép có một dòng trỏ ngược để không quên.
//
// PHẠM VI — và một phép CỐ Ý không mang sang
//   Allowlist definer-acl KHÔNG áp được trên bản khôi phục: baseline chụp bằng
//   pg_dump --no-acl, còn platform-shim tái lập default privileges của nền tảng
//   (GRANT cho anon mọi hàm mới tạo), nên "hàm anon gọi được" trên đích diễn tập
//   là artefact của môi trường đo, không phải trạng thái production. Chỉ
//   DENYLIST mới có nghĩa ở đây — các cửa đã CỐ Ý đóng bằng REVOKE trong forward
//   lane (20260807183000) phải đóng cả trên bản dựng lại; nó chứng minh REVOKE
//   thật sự chạy trong replay và không migration nào sau đó mở lại.
//
//   node scripts/kiem-bao-mat-sau-khoi-phuc.mjs --dich "postgresql://…"
//   PSQL_DOCKER=<container> node scripts/kiem-bao-mat-sau-khoi-phuc.mjs --dich "…"
//
// Thoát: 0 = sạch · 1 = có object hở · 3 = không kiểm được.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chanProduction, coPsql, hoiJson } from "./lib/goi-psql-dich.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(repoRoot, "supabase", "baseline", "manifest.json");
const ACL_BASELINE = join(repoRoot, "scripts", "definer-acl-baseline.json");

/**
 * Sàn chống rỗng. Chạy bộ kiểm này lên một database TRẮNG sẽ ra "0 vi phạm" —
 * câu đúng mà vô nghĩa. Production có 316 bảng logic public và ~1000 hàm
 * SECURITY DEFINER; đích nào đo ra dưới sàn thì không phải bản khôi phục
 * baseline, và mọi kết luận "sạch" trên đó là tự lừa.
 */
// Hạ sàn bảng 300→200 ngày 30/08/2026: migration 20260830085316 DROP 79 bảng
// openclaw_* nên bản dựng lại ĐÚNG chỉ còn ~241 bảng public. Sàn vẫn phải bắt
// được bản khôi phục cụt (vd chết giữa chừng còn vài chục bảng) — đừng hạ về 0.
export const SAN_BANG_PUBLIC = 200;
export const SAN_SECURITY_DEFINER = 400;

// ── SQL từng phép — chép nguyên văn từ gate gốc, ghi nguồn ──────────────────

// Nguồn: capture-production-catalog.mjs → bad.tablesWithoutRls.
// Loại relispartition: partition ngày kế thừa RLS từ bảng cha.
const SQL_BANG_THIEU_RLS = `
  SELECT c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    AND NOT c.relispartition AND NOT c.relrowsecurity
  ORDER BY c.relname`;

const SQL_DEM_BANG_PUBLIC = `
  SELECT count(*)::int AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition`;

// Nguồn: check-view-invoker.mjs. GOTCHA án lệ 20260704180000: recreate view làm
// RỚT security_invoker → view chạy dưới quyền owner → lộ dữ liệu tenant khác.
// MATERIALIZED VIEW là chuyện khác hẳn: KHÔNG THỂ bật invoker → lỗ vĩnh viễn.
const SQL_VIEW = `
  SELECT c.relname AS view_name,
         c.relkind::text AS relkind,
         COALESCE((
           SELECT option_value FROM pg_options_to_table(c.reloptions)
           WHERE option_name = 'security_invoker'
         ), 'false') AS security_invoker
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
  ORDER BY c.relname`;

// Nguồn: capture-production-catalog.mjs → bad.definersWithoutSearchPath.
// SECURITY DEFINER không ghim search_path là đường leo thang quyền kinh điển.
const SQL_DEFINER_THIEU_SEARCH_PATH = `
  SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public','app_private') AND p.prosecdef
    AND NOT (p.proconfig IS NOT NULL AND EXISTS (
      SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'
    ))
  ORDER BY sig`;

const SQL_DEM_SECURITY_DEFINER = `
  SELECT count(*)::int AS n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public','app_private') AND p.prosecdef`;

// Nguồn: check-stable-fn-locks.mjs — nguyên văn CTE, kể cả bước BỎ COMMENT
// (không bỏ thì gate khớp vào chính câu văn nói rằng hàm không khoá dòng) và
// LOCK TABLE (cũng ném 25006 y như FOR UPDATE trong transaction read-only).
//
// BẢN GỐC LÀ NGUỒN, bản này là bản chép: từ 26/08/2026 check-stable-fn-locks
// chạy trong CI (ci-gates.yml, job security-gates) nên nó không còn mồ côi.
// Sửa CTE thì sửa BÊN ĐÓ trước rồi chép lại sang đây — hai bản trôi khỏi nhau
// là đúng lớp lỗi khiến câu chú thích này tồn tại.
const SQL_STABLE_FN_LOCKS = `
  WITH RECURSIVE fns AS (
    SELECT p.oid, n.nspname AS ns, p.proname AS nm, p.provolatile AS vol,
           regexp_replace(
             regexp_replace(pg_get_functiondef(p.oid), '/\\*.*?\\*/', ' ', 'gs'),
             '--[^' || chr(10) || ']*', ' ', 'g') AS def,
           p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f','p') AND n.nspname IN ('public', 'app_private', 'api')
  ),
  seed AS (
    SELECT oid, nm, 0 AS depth, nm AS via FROM fns
    WHERE def ~* '\\mfor\\s+(share|update|no key update|key share)\\M'
       OR def ~* '\\mlock\\s+(table\\s+)?[a-z_.]'
  ),
  closure AS (
    SELECT oid, nm, depth, via FROM seed
    UNION
    SELECT f.oid, f.nm, c.depth + 1, c.via
    FROM fns f JOIN closure c
      ON c.depth < 4 AND f.oid <> c.oid AND f.def ~ ('\\m' || c.nm || '\\s*\\(')
  )
  SELECT DISTINCT ON (f.nm)
         f.nm AS fn_name,
         CASE f.vol WHEN 's' THEN 'STABLE' ELSE 'IMMUTABLE' END AS volatility,
         c.via AS lock_from
  FROM closure c JOIN fns f ON f.oid = c.oid
  WHERE f.ns IN ('public', 'api') AND f.vol <> 'v'
  ORDER BY f.nm, c.depth`;

// Nguồn: check-definer-acl.mjs → docTrangThaiSong (cùng bộ schema PostgREST
// expose). Trên đích diễn tập chỉ so với DENYLIST — xem khối đầu file.
const SQL_ANON_DEFINER = `
  SELECT p.oid::regprocedure::text AS sig
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname = ANY(ARRAY['public','api','graphql_public'])
    AND p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ORDER BY sig`;

/**
 * Gom vi phạm từ số liệu đã đo. Thuần tuý, không I/O — test được từng luật.
 * Trả { dat, viPham: [{ phep, danhSach }] }.
 */
export function phanTichBaoMat({ bangThieuRls, views, definerThieuSearchPath, stableLocks, anonDefiner, denylist }) {
  const viPham = [];
  if (bangThieuRls.length > 0) {
    viPham.push({ phep: "bảng public thiếu RLS", danhSach: bangThieuRls });
  }
  const matview = views.filter((v) => v.relkind === "m").map((v) => v.view_name);
  if (matview.length > 0) {
    viPham.push({ phep: "MATERIALIZED VIEW trong public (không thể bật security_invoker — bỏ qua RLS vĩnh viễn)", danhSach: matview });
  }
  const viewHo = views
    .filter((v) => v.relkind === "v" && String(v.security_invoker).toLowerCase() !== "true")
    .map((v) => v.view_name);
  if (viewHo.length > 0) {
    viPham.push({ phep: "view thiếu security_invoker (chạy dưới quyền owner)", danhSach: viewHo });
  }
  if (definerThieuSearchPath.length > 0) {
    viPham.push({ phep: "hàm SECURITY DEFINER thiếu search_path ghim", danhSach: definerThieuSearchPath });
  }
  if (stableLocks.length > 0) {
    viPham.push({
      phep: "hàm STABLE/IMMUTABLE chạm khoá dòng (ném 25006 khi gọi từ trình duyệt)",
      danhSach: stableLocks.map((r) => `${r.fn_name} [${r.volatility}] khoá đến từ: ${r.lock_from}`),
    });
  }
  const dangSong = new Set(anonDefiner);
  const camMaSong = denylist.filter((sig) => dangSong.has(sig));
  if (camMaSong.length > 0) {
    viPham.push({
      phep: "hàm trong DENYLIST mà anon vẫn gọi được (cửa đã cố ý đóng bị mở lại trên bản dựng lại)",
      danhSach: camMaSong,
    });
  }
  return { dat: viPham.length === 0, viPham };
}

function main(argv) {
  const dich = argv[argv.indexOf("--dich") + 1];
  if (!dich || !/^postgres(ql)?:\/\//.test(dich)) {
    console.error('Dùng: node scripts/kiem-bao-mat-sau-khoi-phuc.mjs --dich "postgresql://…"');
    return 3;
  }
  if (!coPsql()) {
    console.error("❌ Không tìm thấy psql. Cài PostgreSQL client 17+, HOẶC đặt PSQL_DOCKER=<container>.");
    return 3;
  }
  if (!existsSync(ACL_BASELINE)) {
    console.error("❌ Thiếu scripts/definer-acl-baseline.json — không đọc được denylist.");
    return 3;
  }
  try {
    chanProduction(dich, MANIFEST);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    return 3;
  }
  const denylist = JSON.parse(readFileSync(ACL_BASELINE, "utf8")).denylist ?? [];
  if (denylist.length === 0) {
    console.error("❌ Denylist rỗng — check-definer-acl.mjs luôn có ≥4 cửa đã đóng; rỗng nghĩa là file baseline hỏng.");
    return 3;
  }

  let soLieu;
  try {
    const soBang = hoiJson(dich, SQL_DEM_BANG_PUBLIC)[0]?.n ?? 0;
    const soDefiner = hoiJson(dich, SQL_DEM_SECURITY_DEFINER)[0]?.n ?? 0;
    if (soBang < SAN_BANG_PUBLIC || soDefiner < SAN_SECURITY_DEFINER) {
      console.error(
        `❌ Đích chỉ có ${soBang} bảng public / ${soDefiner} hàm SECURITY DEFINER ` +
          `(sàn ${SAN_BANG_PUBLIC}/${SAN_SECURITY_DEFINER}) — đây không phải bản khôi phục baseline, "0 vi phạm" trên nó vô nghĩa.`,
      );
      return 3;
    }
    soLieu = {
      bangThieuRls: hoiJson(dich, SQL_BANG_THIEU_RLS).map((r) => r.name),
      views: hoiJson(dich, SQL_VIEW),
      definerThieuSearchPath: hoiJson(dich, SQL_DEFINER_THIEU_SEARCH_PATH).map((r) => r.sig),
      stableLocks: hoiJson(dich, SQL_STABLE_FN_LOCKS),
      anonDefiner: hoiJson(dich, SQL_ANON_DEFINER).map((r) => r.sig),
      denylist,
    };
  } catch (e) {
    console.error(`❌ Không kiểm được: ${e.message}`);
    return 3;
  }

  const { dat, viPham } = phanTichBaoMat(soLieu);
  console.log(
    `Kiểm bảo mật sau khôi phục — view: ${soLieu.views.length} · definer thiếu search_path: ${soLieu.definerThieuSearchPath.length} · ` +
      `bảng thiếu RLS: ${soLieu.bangThieuRls.length} · stable-fn chạm khoá: ${soLieu.stableLocks.length} · denylist: ${denylist.length} cửa`,
  );
  if (!dat) {
    for (const v of viPham) {
      console.error(`\n❌ ${v.phep} (${v.danhSach.length}):`);
      for (const d of v.danhSach.slice(0, 15)) console.error(`   - ${d}`);
      if (v.danhSach.length > 15) console.error(`   … còn ${v.danhSach.length - 15}`);
    }
    return 1;
  }
  console.log("✅ Bản dựng lại sạch: RLS đủ, view invoker đủ, search_path ghim đủ, không hàm đọc nào chạm khoá dòng, các cửa denylist vẫn đóng.");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
