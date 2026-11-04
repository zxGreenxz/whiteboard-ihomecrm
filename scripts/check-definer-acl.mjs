// CI gate (AUTHORIZATION-PLAN §9.3 điểm 9): canh quyền EXECUTE của role `anon`
// trên các hàm SECURITY DEFINER. Hai câu hỏi KHÁC NHAU, cần hai danh sách:
//
//   ALLOWLIST (signatures) — "hàm này anon gọi được, đã xét chưa?"
//     Bắt hàm MỚI anon-executable lọt vào mà không ai để ý (vd CREATE OR REPLACE
//     reset grant về PUBLIC).
//
//   DENYLIST (denylist) — "cửa này đã có người CỐ Ý đóng, không ai được mở lại."
//     Allowlist không bao giờ trả lời được câu này, và đó là lỗ hổng thật:
//
//     ÁN LỆ 07/08/2026. `get_public_latest_invoice_by_contract(uuid)` là
//     SECURITY DEFINER không kiểm quyền, trả họ tên + SĐT khách thuê và toàn bộ
//     hoá đơn. Ngày 30/05 migration 20260530000003 đã thu hồi đúng cách (kể cả
//     PUBLIC, kèm chú thích giải thích). Hai ngày sau, 20260601000000_remove_tax_
//     fields.sql — một refactor gỡ cột thuế — tạo lại hàm và chép kèm
//     `GRANT EXECUTE ... TO anon`. Lỗ mở lại, nằm im HƠN HAI THÁNG, và gate này
//     KHÔNG hé một tiếng: hàm nằm sẵn trong allowlist nên việc cấp lại quyền
//     trông y hệt trạng thái bình thường. Ratchet đã ban phước cho đúng cái lỗ
//     nó sinh ra để canh.
//
// Regenerate allowlist CÓ CHỦ Ý khi thêm public endpoint thật:
//   node scripts/check-definer-acl.mjs --update
// (lệnh --update TỪ CHỐI chạy nếu có hàm nằm trong denylist đang anon-executable,
//  để không nuốt ngược lỗ hổng vào allowlist.)
//
// DENYLIST còn được kiem-bao-mat-sau-khoi-phuc.mjs kiểm trên bản KHÔI PHỤC từ
// baseline (chỉ denylist — allowlist không áp được ở đó, lý do ghi trong file
// ấy). Đổi cấu trúc file baseline này thì sửa cả bên đó.
//
// Từ 04/11/2026 gate còn hỏi thêm ba câu về PUBLIC EXECUTE và vai bị chặn —
// xem khối "PUBLIC EXECUTE" bên dưới (cấu hình: publicExecute trong baseline).
//
// Dùng: node scripts/check-definer-acl.mjs   → exit 1 nếu drift.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { layPat } from './lib/vault.mjs';

const baselinePath = new URL('./definer-acl-baseline.json', import.meta.url);

// Quét MỌI schema PostgREST expose, không chỉ `public`.
//
// GET /v1/projects/<ref>/postgrest trả db_schema = "api, public,graphql_public".
// `api` đứng ĐẦU nên nó là profile MẶC ĐỊNH: hàm nằm trong đó gọi thẳng được ở
// /rest/v1/rpc/<tên> mà KHÔNG cần header Content-Profile nào, và role `anon` có
// USAGE trên schema đó (đo 07/08/2026: schema tồn tại, has_schema_privilege =
// true). Tức bề mặt phơi ra DỄ nhất lại nằm ngoài vùng quét của gate.
//
// Hiện `api` có 0 hàm — cửa mở nhưng chưa ai bước vào. Đó đúng là lúc nên bịt:
// một SECURITY DEFINER thêm vào đó ngày mai sẽ có zero bằng chứng nào chặn.
const SCHEMA_PHOI_RA = ['public', 'api', 'graphql_public'];

// ── PUBLIC EXECUTE và vai bị chặn (migration 20261104173640, hậu kiểm PR #371) ─────────────
// Allowlist/denylist ở trên chỉ hỏi về anon. Lỗ đo được 01/11/2026 nằm ở tầng khác: quyền cấp cho
// PUBLIC là quyền của MỌI vai, kể cả login không qua PostgREST — hermes_store_learning đăng nhập
// qua pooler gọi được 67 hàm DEFINER rồi tự đặt request.jwt.claim.sub là giả danh người dùng. Ba
// câu hỏi thêm, cùng đọc catalog production:
//   1. Còn hàm ứng dụng (SCHEMA_UNG_DUNG, không thuộc extension) cấp EXECUTE cho PUBLIC không?
//      proacl NULL là mặc định PUBLIC, cũng tính.
//   2. Vai bị chặn (publicExecute.blockedRoles trong baseline) gọi được hàm SECURITY DEFINER nào
//      ngoài danh sách riêng của nó không? Tính qua MỌI nhóm nó là thành viên (pg_has_role MEMBER,
//      gồm cả nhóm chỉ SET ROLE được mà không thừa hưởng).
//   3. Mặc định hàm của postgres (toàn cục, hoặc theo schema) còn cấp PUBLIC không? Còn thì hàm tạo
//      sau lại cấp PUBLIC.
// Danh sách của vai bị chặn sửa TAY trong PR có review; --update không đụng tới nó.
export const SCHEMA_UNG_DUNG = ['public', 'app_private', 'api'];
const TEN_VAI = /^[a-z_][a-z0-9_]{0,62}$/;

export function sqlPublicExecute(blockedRoles) {
  const vai = Object.keys(blockedRoles ?? {});
  if (vai.length === 0 || vai.some((r) => !TEN_VAI.test(r))) throw new Error('publicExecute.blockedRoles rỗng hoặc có tên vai không hợp lệ');
  const mang = (xs) => `ARRAY[${xs.map((x) => `'${x}'`).join(',')}]::text[]`;
  return `WITH app AS (
  SELECT p.oid, p.oid::regprocedure::text AS sig, p.prosecdef, p.proacl, p.proowner,
    p.prorettype IN ('pg_catalog.trigger'::regtype,'pg_catalog.event_trigger'::regtype) AS trig
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = ANY(${mang(SCHEMA_UNG_DUNG)})
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
      WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
)
SELECT 'public' AS kind, NULL::text AS role, a.sig FROM app a
 WHERE EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(a.proacl, pg_catalog.acldefault('f', a.proowner))) x
   WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
UNION ALL
SELECT 'reach', r.rolname::text, a.sig FROM pg_catalog.pg_roles r CROSS JOIN app a
 WHERE r.rolname = ANY(${mang(vai)}) AND a.prosecdef AND NOT a.trig
   AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles g
     WHERE pg_catalog.pg_has_role(r.oid, g.oid, 'MEMBER') AND pg_catalog.has_function_privilege(g.oid, a.oid, 'EXECUTE'))
UNION ALL
SELECT 'default', 'postgres', '(toàn cục)'
 WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl da
   WHERE da.defaclrole = 'postgres'::regrole AND da.defaclnamespace = 0 AND da.defaclobjtype = 'f'
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(da.defaclacl) x WHERE x.grantee = 0))
UNION ALL
SELECT 'default', pg_catalog.pg_get_userbyid(da.defaclrole)::text, da.defaclnamespace::regnamespace::text
  FROM pg_catalog.pg_default_acl da CROSS JOIN LATERAL pg_catalog.aclexplode(da.defaclacl) x
 WHERE da.defaclobjtype = 'f' AND x.grantee = 0
   AND (da.defaclrole = 'postgres'::regrole OR da.defaclnamespace::regnamespace::text = ANY(${mang(SCHEMA_UNG_DUNG)}))
ORDER BY 1, 2, 3`;
}

/**
 * Phân tích kết quả sqlPublicExecute. Thuần tuý, không I/O. `thua`: dòng trong danh sách vai bị chặn
 * mà vai đó không còn gọi được (hàm đã bỏ/thu) — chỉ báo, không đỏ.
 */
export function phanTichPublicExecute({ rows = [], blockedRoles = {} } = {}) {
  const hamPublic = rows.filter((r) => r.kind === 'public').map((r) => r.sig);
  const reach = rows.filter((r) => r.kind === 'reach');
  const vuotQuyen = reach.filter((r) => !(blockedRoles[r.role] ?? []).includes(r.sig)).map((r) => `${r.role} → ${r.sig}`);
  const macDinh = rows.filter((r) => r.kind === 'default').map((r) => `${r.role}: ${r.sig}`);
  const conGoi = new Set(reach.map((r) => `${r.role} → ${r.sig}`));
  const thua = Object.entries(blockedRoles).flatMap(([role, sigs]) => sigs.map((s) => `${role} → ${s}`)).filter((x) => !conGoi.has(x));
  return { hamPublic, vuotQuyen, macDinh, thua, dat: hamPublic.length === 0 && vuotQuyen.length === 0 && macDinh.length === 0 };
}

/**
 * So trạng thái thật với hai danh sách. Thuần tuý, không I/O — để test được
 * từng luật mà không cần chạm production.
 */
export function phanTichAcl({ live = [], baseline = [], denylist = [] } = {}) {
  const choPhep = new Set(baseline);
  const dangSong = new Set(live);
  const cam = new Set(denylist);

  // Vi phạm cấm: hàm đã cố ý đóng mà nay anon lại gọi được. Nằm trong allowlist
  // KHÔNG cứu được — đó chính là khuyết tật đã để lỗ mở hai tháng.
  const viPhamCam = denylist.filter((s) => dangSong.has(s));

  // Mâu thuẫn cấu hình: hàm vừa bị cấm vừa được allowlist tha. Xảy ra khi ai đó
  // chạy --update lúc lỗ đang mở. Phải hét lên, không được lặng lẽ chấp nhận.
  const mauThuan = denylist.filter((s) => choPhep.has(s));

  const themMoi = live.filter((s) => !choPhep.has(s));
  const daBo = baseline.filter((s) => !dangSong.has(s));

  return {
    viPhamCam,
    mauThuan,
    themMoi,
    daBo,
    dat: viPhamCam.length === 0 && mauThuan.length === 0 && themMoi.length === 0,
  };
}

async function truyVan(pat, ref, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    throw new Error(`Query FAILED ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function docTrangThaiSong(pat, ref) {
  const sql = `SELECT p.oid::regprocedure::text AS sig
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname = ANY(ARRAY[${SCHEMA_PHOI_RA.map((s) => `'${s}'`).join(',')}])
    AND p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ORDER BY sig`;
  return (await truyVan(pat, ref, sql)).map((r) => r.sig);
}

function baoPublicExecute(kq) {
  if (kq.hamPublic.length) {
    console.error(`❌ ${kq.hamPublic.length} hàm ứng dụng còn cấp EXECUTE cho PUBLIC (mọi vai, kể cả login không qua API, gọi được):`);
    for (const s of kq.hamPublic.slice(0, 30)) console.error('   + ' + s);
    if (kq.hamPublic.length > 30) console.error(`   … còn ${kq.hamPublic.length - 30}`);
    console.error('   REVOKE EXECUTE ... FROM PUBLIC rồi GRANT tường minh cho vai thật sự gọi (xem 20261104173640).');
  }
  if (kq.vuotQuyen.length) {
    console.error(`❌ ${kq.vuotQuyen.length} hàm SECURITY DEFINER vai bị chặn gọi được ngoài danh sách riêng (publicExecute.blockedRoles):`);
    for (const s of kq.vuotQuyen.slice(0, 30)) console.error('   ! ' + s);
  }
  if (kq.macDinh.length) {
    console.error(`❌ Mặc định quyền hàm còn cấp PUBLIC — hàm tạo sau sẽ lại mở cho mọi vai: ${kq.macDinh.join(', ')}`);
  }
}

async function main(argv) {
  const pat = layPat({ bien: ['SUPABASE_PAT'] });
  if (!pat) { console.error('Không tìm thấy PAT'); return 1; }
  const ref = 'tryymsxyyckgbrmmvozx';

  const live = await docTrangThaiSong(pat, ref);
  const doc = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const denylist = doc.denylist ?? [];
  const blockedRoles = doc.publicExecute?.blockedRoles;
  if (!blockedRoles || typeof blockedRoles !== 'object' || Object.values(blockedRoles).some((v) => !Array.isArray(v))) {
    console.error('❌ definer-acl-baseline.json thiếu publicExecute.blockedRoles (đối tượng vai → mảng chữ ký) — không kiểm được.');
    return 1;
  }
  const kqPublic = phanTichPublicExecute({ rows: await truyVan(pat, ref, sqlPublicExecute(blockedRoles)), blockedRoles });

  if (argv.includes('--update')) {
    if (kqPublic.hamPublic.length) {
      console.error(`❌ Từ chối --update: ${kqPublic.hamPublic.length} hàm còn cấp PUBLIC — anon gọi được chúng nhờ PUBLIC, ghi vào allowlist lúc này là ban phước cho lỗ.`);
      return 1;
    }
    // Không cho phép --update nuốt ngược một hàm đang bị cấm vào allowlist.
    const nuot = denylist.filter((s) => live.includes(s));
    if (nuot.length) {
      console.error(`❌ Từ chối --update: ${nuot.length} hàm trong DENYLIST đang anon-executable.`);
      for (const s of nuot) console.error('   ! ' + s);
      console.error('   Cập nhật baseline lúc này sẽ ghi lỗ hổng thành "hợp lệ". REVOKE trước đã.');
      return 1;
    }
    writeFileSync(baselinePath, `${JSON.stringify({
      note: doc.note ?? 'SECURITY DEFINER functions anon-executable — allowlist baseline (Sprint 6 CI gate). Regenerate intentionally when adding a genuine public endpoint.',
      denylistNote: doc.denylistNote
        ?? 'Hàm ĐÃ CỐ Ý đóng với anon. Gate fail nếu chúng anon-executable trở lại, KỂ CẢ khi nằm trong signatures. Xem án lệ 07/08/2026 ở đầu scripts/check-definer-acl.mjs.',
      generated: new Date().toISOString().slice(0, 10),
      count: live.length,
      denylist,
      publicExecute: doc.publicExecute,
      signatures: live,
    }, null, 2)}\n`);
    console.log(`✅ Baseline updated: ${live.length} anon-executable SECURITY DEFINER functions, ${denylist.length} hàm trong denylist.`);
    return 0;
  }

  const kq = phanTichAcl({ live, baseline: doc.signatures, denylist });

  if (kq.viPhamCam.length) {
    console.error(`❌ ${kq.viPhamCam.length} hàm trong DENYLIST lại anon-executable — cửa đã cố ý đóng bị mở lại:`);
    for (const s of kq.viPhamCam) console.error('   ! ' + s);
    console.error('   Nhiều khả năng một CREATE OR REPLACE kèm GRANT đã ghi đè bản vá. Xem án lệ 07/08/2026.');
  }
  if (kq.mauThuan.length) {
    console.error(`❌ ${kq.mauThuan.length} hàm vừa nằm trong denylist vừa nằm trong allowlist — cấu hình mâu thuẫn:`);
    for (const s of kq.mauThuan) console.error('   ! ' + s);
    console.error('   Gỡ chúng khỏi "signatures"; denylist là quyết định cứng.');
  }
  if (kq.themMoi.length) {
    console.error(`❌ ${kq.themMoi.length} SECURITY DEFINER function MỚI anon-executable ngoài allowlist:`);
    for (const s of kq.themMoi) console.error('   + ' + s);
    console.error('Nếu là public endpoint có chủ đích: node scripts/check-definer-acl.mjs --update. Nếu không: REVOKE anon.');
  }
  baoPublicExecute(kqPublic);
  if (!kq.dat || !kqPublic.dat) return 1;

  if (kq.daBo.length) {
    console.log(`ℹ️  ${kq.daBo.length} function trong baseline không còn anon-executable (siết chặt — tốt). Chạy --update để dọn baseline.`);
  }
  if (kqPublic.thua.length) {
    console.log(`ℹ️  ${kqPublic.thua.length} dòng trong publicExecute.blockedRoles vai đó không còn gọi được (hàm đã bỏ/thu) — sửa tay để dọn: ${kqPublic.thua.slice(0, 5).join(', ')}`);
  }
  console.log(`✅ Không có SECURITY DEFINER anon-executable mới ngoài allowlist (${live.length} khớp baseline, ${denylist.length} hàm bị cấm vĩnh viễn).`);
  console.log(`✅ Không hàm ứng dụng nào cấp EXECUTE cho PUBLIC; ${Object.keys(blockedRoles).length} vai bị chặn chỉ gọi được hàm DEFINER riêng của mình; mặc định hàm của postgres không cấp PUBLIC.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
    .then((c) => { process.exitCode = c; })
    .catch((e) => { console.error(`❌ ${e.message}`); process.exitCode = 1; });
}
