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
//   4. Hàm mà vai tự chạy qua đối tượng phụ thuộc (pg_depend) có thiếu EXECUTE cho vai đó không? Hết
//      PUBLIC thì một helper app_private mới mà quên GRANT sẽ làm truy vấn của vai đó lỗi 42501 — chỉ
//      phép này thấy trước. PostgreSQL kiểm EXECUTE theo vai ĐANG truy vấn ở mọi đường sau:
//        · policy RLS mà vai chịu;
//        · view/rule mà vai đọc/ghi — MỌI view, không chỉ security_invoker (security_invoker chỉ đổi
//          cách kiểm quyền BẢNG; hàm trong view luôn kiểm theo vai đang truy vấn). Trừ materialized
//          view: truy vấn của nó chỉ chạy lúc REFRESH, bằng chủ;
//        · default/generated, CHECK, chỉ mục biểu thức, WHEN của trigger trên bảng vai ghi được;
//        · domain: CHECK (mọi vai — ép kiểu ở bất kỳ truy vấn nào cũng chạy CHECK) và DEFAULT (vai INSERT được
//          vào bảng/view có cột mang kiểu domain đó);
//        · hàm khác mà vai gọi được: DEFAULT của tham số (luôn tính theo người gọi, kể cả hàm DEFINER)
//          và thân BEGIN ATOMIC của hàm INVOKER. Thân BEGIN ATOMIC của hàm DEFINER chạy bằng chủ, không tính.
//      Thân hàm dạng chuỗi ($$ … $$) không có trong pg_depend: hàm gọi lồng trong đó phép này không thấy.
//      Miễn anon trên hàm đã cố ý đóng (ACL cấp authenticated, không cấp anon) CHỈ ở đường policy: đo
//      prod 05/11 có 15 hàm như vậy trong policy TO public, đúng ý người đã thu (anon nhận 42501). Đường
//      khác, vd bảng cho anon INSERT có DEFAULT gọi hàm đã đóng, vẫn đỏ.
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
SELECT 'thieu', r.rolname::text, a.sig FROM pg_catalog.pg_roles r CROSS JOIN app a
 WHERE r.rolname IN ('anon','authenticated','service_role','supabase_read_only_user') AND NOT a.trig
   AND (r.rolname <> 'supabase_read_only_user' OR NOT a.prosecdef)
   AND NOT pg_catalog.has_function_privilege(r.oid, a.oid, 'EXECUTE')
   AND EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
     WHERE d.refclassid = 'pg_catalog.pg_proc'::regclass AND d.refobjid = a.oid AND (
       (d.classid = 'pg_catalog.pg_policy'::regclass AND NOT r.rolbypassrls
         AND NOT (r.rolname = 'anon'
           AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(a.proacl, pg_catalog.acldefault('f', a.proowner))) x
             WHERE x.grantee = 'authenticated'::regrole AND x.privilege_type = 'EXECUTE')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(a.proacl, pg_catalog.acldefault('f', a.proowner))) x
             WHERE x.grantee = 'anon'::regrole AND x.privilege_type = 'EXECUTE'))
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy x
         WHERE x.oid = d.objid AND (0 = ANY (x.polroles) OR EXISTS (SELECT 1 FROM unnest(x.polroles) g(oid)
           WHERE g.oid <> 0 AND pg_catalog.pg_has_role(r.oid, g.oid, 'USAGE')))
           AND pg_catalog.has_table_privilege(r.oid, x.polrelid, 'SELECT,INSERT,UPDATE,DELETE')))
       OR (d.classid = 'pg_catalog.pg_rewrite'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite x
         JOIN pg_catalog.pg_class c ON c.oid = x.ev_class WHERE x.oid = d.objid AND c.relkind <> 'm'
           AND pg_catalog.has_table_privilege(r.oid, c.oid,
             CASE x.ev_type WHEN '2' THEN 'UPDATE' WHEN '3' THEN 'INSERT' WHEN '4' THEN 'DELETE' ELSE 'SELECT' END)))
       OR (d.classid = 'pg_catalog.pg_attrdef'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_attrdef x
         WHERE x.oid = d.objid AND pg_catalog.has_table_privilege(r.oid, x.adrelid, 'INSERT,UPDATE')))
       OR (d.classid = 'pg_catalog.pg_constraint'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint x
         WHERE x.oid = d.objid AND (x.conrelid = 0 OR pg_catalog.has_table_privilege(r.oid, x.conrelid, 'INSERT,UPDATE'))))
       OR (d.classid = 'pg_catalog.pg_class'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_index x
         WHERE x.indexrelid = d.objid AND pg_catalog.has_table_privilege(r.oid, x.indrelid, 'INSERT,UPDATE')))
       OR (d.classid = 'pg_catalog.pg_trigger'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger x
         WHERE x.oid = d.objid AND pg_catalog.has_table_privilege(r.oid, x.tgrelid, 'INSERT,UPDATE,DELETE')))
       OR (d.classid = 'pg_catalog.pg_proc'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc x
         WHERE x.oid = d.objid AND pg_catalog.has_function_privilege(r.oid, x.oid, 'EXECUTE')
           AND (NOT x.prosecdef OR x.proargdefaults::text ~ (':funcid ' || a.oid::text || '([^0-9]|$)'))))
       OR (d.classid = 'pg_catalog.pg_type'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_type x
         JOIN pg_catalog.pg_attribute t ON t.atttypid = x.oid AND t.attnum > 0 AND NOT t.attisdropped
         JOIN pg_catalog.pg_class c ON c.oid = t.attrelid AND c.relkind IN ('r', 'p', 'v', 'f')
         WHERE x.oid = d.objid AND x.typtype = 'd' AND pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT')))))
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

// Chữ ký regprocedure bỏ tên schema khi schema nằm trong search_path (public), nên so khớp bỏ tiền tố `public.`.
const chuanSig = (s) => String(s).replace(/^public\./, '');

/**
 * Phân tích kết quả sqlPublicExecute. Thuần tuý, không I/O. `thua`: dòng trong danh sách vai bị chặn
 * mà vai đó không còn gọi được (hàm đã bỏ/thu) — chỉ báo, không đỏ.
 * `thieuMienTru` (publicExecute.thieuMienTru, vai → chữ ký): cặp 'thieu' đã xét và cho qua. `mienThua`: mục miễn
 * mà catalog không còn sinh ra — ĐỎ khi kiemMienThua (gate production), để danh sách chỉ teo đi. Đích không phải
 * production (bản dựng lại từ baseline --no-acl) có ACL khác nên tắt phép này ở đó.
 */
export function phanTichPublicExecute({ rows = [], blockedRoles = {}, thieuMienTru = {}, kiemMienThua = true } = {}) {
  const hamPublic = rows.filter((r) => r.kind === 'public').map((r) => r.sig);
  const reach = rows.filter((r) => r.kind === 'reach');
  const vuotQuyen = reach.filter((r) => !(blockedRoles[r.role] ?? []).includes(r.sig)).map((r) => `${r.role} → ${r.sig}`);
  const macDinh = rows.filter((r) => r.kind === 'default').map((r) => `${r.role}: ${r.sig}`);
  const mien = new Set(Object.entries(thieuMienTru).flatMap(([role, sigs]) => sigs.map((s) => `${role} → ${chuanSig(s)}`)));
  const thieuTatCa = rows.filter((r) => r.kind === 'thieu').map((r) => `${r.role} → ${chuanSig(r.sig)}`);
  const thieuQuyen = thieuTatCa.filter((x) => !mien.has(x));
  const conThieu = new Set(thieuTatCa);
  const mienThua = kiemMienThua ? [...mien].filter((x) => !conThieu.has(x)) : [];
  const conGoi = new Set(reach.map((r) => `${r.role} → ${r.sig}`));
  const thua = Object.entries(blockedRoles).flatMap(([role, sigs]) => sigs.map((s) => `${role} → ${s}`)).filter((x) => !conGoi.has(x));
  return { hamPublic, vuotQuyen, macDinh, thieuQuyen, mienThua, thua,
    dat: hamPublic.length === 0 && vuotQuyen.length === 0 && macDinh.length === 0 && thieuQuyen.length === 0 && mienThua.length === 0 };
}

/** Đọc publicExecute.thieuMienTru: đối tượng vai → mảng chữ ký; thiếu thì rỗng; sai dạng thì ném. */
export function docThieuMienTru(publicExecute) {
  const m = publicExecute?.thieuMienTru ?? {};
  if (typeof m !== 'object' || Array.isArray(m)
    || Object.entries(m).some(([vai, sigs]) => !TEN_VAI.test(vai) || !Array.isArray(sigs) || sigs.some((s) => typeof s !== 'string'))) {
    throw new Error('publicExecute.thieuMienTru phải là đối tượng vai → mảng chữ ký');
  }
  return m;
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
  if (kq.thieuQuyen.length) {
    console.error(`❌ ${kq.thieuQuyen.length} hàm mà vai tự chạy qua policy/view/default/domain/hàm khác nhưng thiếu EXECUTE (truy vấn của vai đó sẽ lỗi 42501):`);
    for (const s of kq.thieuQuyen.slice(0, 30)) console.error('   ! ' + s);
    console.error('   GRANT EXECUTE tường minh cho đúng vai đó (hàm mới không còn tự cấp PUBLIC từ 20261104173640).');
  }
  if (kq.mienThua.length) {
    console.error(`❌ ${kq.mienThua.length} mục trong publicExecute.thieuMienTru không còn cần (catalog không còn sinh ra cặp này):`);
    for (const s of kq.mienThua) console.error('   - ' + s);
    console.error('   Gỡ khỏi danh sách — danh sách miễn chỉ được teo đi.');
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
  const thieuMienTru = docThieuMienTru(doc.publicExecute);
  const kqPublic = phanTichPublicExecute({ rows: await truyVan(pat, ref, sqlPublicExecute(blockedRoles)), blockedRoles, thieuMienTru });

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
  console.log(`✅ Không hàm ứng dụng nào cấp EXECUTE cho PUBLIC; ${Object.keys(blockedRoles).length} vai bị chặn chỉ gọi được hàm DEFINER riêng của mình; mặc định hàm của postgres không cấp PUBLIC; hàm trong policy/view/default đủ EXECUTE cho vai gọi.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
    .then((c) => { process.exitCode = c; })
    .catch((e) => { console.error(`❌ ${e.message}`); process.exitCode = 1; });
}
