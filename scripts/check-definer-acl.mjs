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
// Dùng: node scripts/check-definer-acl.mjs   → exit 1 nếu drift.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

async function docTrangThaiSong(pat, ref) {
  const sql = `SELECT p.oid::regprocedure::text AS sig
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname = ANY(ARRAY[${SCHEMA_PHOI_RA.map((s) => `'${s}'`).join(',')}])
    AND p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ORDER BY sig`;
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    console.error('Query FAILED', res.status, (await res.text()).slice(0, 300));
    process.exit(1);
  }
  return (await res.json()).map((r) => r.sig);
}

async function main(argv) {
  const pat = process.env.SUPABASE_PAT
    || readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8').match(/sbp_[a-f0-9]+/)?.[0];
  if (!pat) { console.error('Không tìm thấy PAT'); return 1; }
  const ref = 'tryymsxyyckgbrmmvozx';

  const live = await docTrangThaiSong(pat, ref);
  const doc = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const denylist = doc.denylist ?? [];

  if (argv.includes('--update')) {
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
  if (!kq.dat) return 1;

  if (kq.daBo.length) {
    console.log(`ℹ️  ${kq.daBo.length} function trong baseline không còn anon-executable (siết chặt — tốt). Chạy --update để dọn baseline.`);
  }
  console.log(`✅ Không có SECURITY DEFINER anon-executable mới ngoài allowlist (${live.length} khớp baseline, ${denylist.length} hàm bị cấm vĩnh viễn).`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
    .then((c) => process.exit(c))
    .catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
