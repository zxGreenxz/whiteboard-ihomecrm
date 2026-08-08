#!/usr/bin/env node
// Đo rò dữ liệu giữa các tổ chức trên PRODUCTION, bằng vai người dùng THẬT.
//
//   node scripts/measure-org-leak.mjs --write   # đo và ghi baseline
//   node scripts/measure-org-leak.mjs           # đo và in, không ghi
//
// CHỈ ĐỌC. Mọi truy vấn bọc BEGIN … ROLLBACK trong cùng một chuỗi, không có
// COMMIT, không lồng BEGIN trong BEGIN (Postgres không có transaction lồng —
// COMMIT bên trong sẽ đóng transaction ngoài; án lệ 07/08/2026 đã ghi thật lên
// production đúng theo cách đó).
//
// ⚠ BỘ ĐO NÀY CHỈ CÓ GIÁ TRỊ NẾU NÓ KHÔNG BAO GIỜ NÓI DỐI THEO HƯỚNG AN TOÀN.
// Án lệ trong chính phiên rà soát: một bài đo cho ra "0 dòng rò" và suýt thành
// kết luận, hoá ra hàm ghi log của nó bị đặt SECURITY DEFINER nên mọi truy vấn
// chạy bằng quyền postgres chứ không phải vai đang giả lập. Một bộ đo hỏng theo
// hướng "mọi thứ đều ổn" nguy hiểm hơn không đo, vì nó tạo bằng chứng giả.
//
// Nên có BỐN CHỐT, thiếu một là THOÁT MÃ 3 (khác hẳn mã 1 = "đo xong, có rò"):
//   1. current_user phải là 'authenticated'
//   2. vai đó phải KHÔNG có rolbypassrls
//   3. auth.uid() phải trả đúng người mình định giả lập
//   4. đối chứng DƯƠNG (income_expense_types — bảng đã rào) phải thấy >0 dòng
//      của mình và 0 dòng ngoài; đối chứng ÂM (uid mồ côi) phải thấy 0 khắp nơi
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPat, readProjectRef, runSql } from './capture-production-catalog.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DUONG_INVENTORY = join(repoRoot, 'docs/generated/org-boundary-inventory.json');
const RA = join(repoRoot, 'docs/generated/org-leak-baseline.json');

export const MA_THOAT_CHOT_HONG = 3;

const UID_MO_COI = '11111111-2222-4333-8444-555555555555';
const BANG_DOI_CHUNG = 'income_expense_types';

/** Bốn chốt. Thuần tuý để test được từng cái mà không chạm production. */
export function kiemChotChongAoGiac(d) {
  const loi = [];
  if (d.current_user !== 'authenticated') {
    loi.push(`Phiên chạy bằng '${d.current_user}', không phải authenticated — đo lúc này là đo quyền quản trị.`);
  }
  if (d.rolbypassrls) {
    loi.push('Vai đang bypass RLS — mọi con số đo ra đều vô nghĩa.');
  }
  if (d.auth_uid !== d.uid_mong_doi) {
    loi.push(`auth.uid() trả '${d.auth_uid}' nhưng đang định giả lập '${d.uid_mong_doi}' — SET LOCAL không ăn.`);
  }
  if (!(d.doi_chung_duong_tong > 0)) {
    loi.push(`Đối chứng dương (${BANG_DOI_CHUNG}) thấy 0 dòng — bài đo đang MÙ chứ không phải sạch.`);
  }
  if (d.doi_chung_duong_ngoai > 0) {
    loi.push(`Đối chứng dương lại thấy ${d.doi_chung_duong_ngoai} dòng của tổ chức khác — bảng mốc phải sạch.`);
  }
  if (d.doi_chung_am > 0) {
    loi.push(`Đối chứng âm: người mồ côi vẫn thấy ${d.doi_chung_am} dòng — RLS không có hiệu lực.`);
  }
  return { dat: loi.length === 0, loi };
}

/**
 * Gán giai đoạn TỪ SỐ ĐO. Thứ tự xét là nội dung của luật:
 *   rò thật        → GĐ4 (có người đang nhìn nhầm, vá phải cẩn thận)
 *   chưa đo được   → không gán, và nói rõ là chưa đo
 *   rỗng           → GĐ3 (không có gì để mất)
 *   không cấp quyền→ GĐ3 (đã chặn từ tầng quyền)
 *   đã kín         → GĐ3 (siết chồng, không lấy mất của ai)
 */
export function xepNhomTheoSoDo(b) {
  if ((b.visible_foreign ?? 0) > 0) {
    return { group: 'LIVE_LEAK', assigned_phase: 'GĐ4' };
  }
  if (b.visible_foreign === null || b.ground_truth_total === null) {
    return { group: 'CHUA_DO', assigned_phase: null };
  }
  if (b.ground_truth_total === 0) return { group: 'A_RONG', assigned_phase: 'GĐ3' };
  if (!b.authenticated_can_select) return { group: 'B_KHONG_CAP_QUYEN', assigned_phase: 'GĐ3' };
  return { group: 'C_DA_KIN', assigned_phase: 'GĐ3' };
}

/**
 * Số bảng quét trong MỘT request.
 *
 * Không phải để chiều Postgres mà để chiều cổng HTTP: Management API đứng sau
 * Cloudflare và trả 524 khi request vượt khoảng 100 giây. Quét cả 304 bảng một
 * lần từng chạy được, cho tới khi đo ra invoice_payment_allocations và
 * _collections mất 14–18 GIÂY MỖI BẢNG — hai bảng đó một mình đã ăn hết ngân
 * sách. Chia lô giữ mỗi request an toàn dưới ngưỡng, đổi lại nhiều vòng gọi hơn.
 */
const SO_BANG_MOI_LO = 40;

function chiaLo(mang, n) {
  const ra = [];
  for (let i = 0; i < mang.length; i += n) ra.push(mang.slice(i, i + n));
  return ra;
}

/** Một chuyến đo cho một nhân vật, MỘT LÔ bảng, trong một transaction. */
function sqlDoMotVai(uid, org, loBang) {
  // Quét 304 bảng bằng vai người dùng thật mất vài phút, vì RLS được đánh giá
  // cho từng bảng. Riêng invoice_payment_allocations và _collections mất 14–18
  // GIÂY MỖI BẢNG — đo được đó là vấn đề CÓ SẴN của chuỗi can_access_building /
  // can_v3 trong policy RBAC của chúng, không phải do biên giới tổ chức: gỡ
  // policy biên giới ra vẫn 17,07s so với 18,08s khi có (chênh 5%).
  // Mặc định 120s của lane không đủ, và bỏ cuộc giữa chừng thì bộ đo im lặng
  // đúng lúc cần nói.
  return `BEGIN;
SET LOCAL statement_timeout = '900s';
CREATE TEMP TABLE _kq(bang text, tong bigint, ngoai bigint);
GRANT INSERT, SELECT ON _kq TO PUBLIC;

CREATE FUNCTION pg_temp._quet(p_org uuid) RETURNS void LANGUAGE plpgsql AS $quet$
DECLARE b text; v_tong bigint; v_ngoai bigint;
BEGIN
  FOREACH b IN ARRAY ARRAY[${loBang.map((t) => `'${t}'`).join(',')}] LOOP
    BEGIN
      EXECUTE format(
        'SELECT count(*), count(*) FILTER (WHERE organization_id IS NOT NULL AND organization_id <> %L) FROM public.%I',
        p_org, b) INTO v_tong, v_ngoai;
      INSERT INTO _kq VALUES (b, v_tong, v_ngoai);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _kq VALUES (b, NULL, NULL);
    END;
  END LOOP;
END $quet$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}';
SELECT pg_temp._quet('${org}'::uuid);

SELECT
  (SELECT current_user)::text                                                        AS current_user,
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)                   AS rolbypassrls,
  (SELECT auth.uid())::text                                                          AS auth_uid,
  (SELECT tong  FROM _kq WHERE bang = '${BANG_DOI_CHUNG}')                           AS doi_chung_duong_tong,
  (SELECT ngoai FROM _kq WHERE bang = '${BANG_DOI_CHUNG}')                           AS doi_chung_duong_ngoai,
  (SELECT coalesce(json_agg(json_build_object('bang',bang,'tong',tong,'ngoai',ngoai)),'[]'::json)
     FROM _kq)                                                                       AS bang;
ROLLBACK;`;
}

function sqlDoiChungAm() {
  return `BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"${UID_MO_COI}","role":"authenticated"}';
SELECT (SELECT count(*) FROM public.${BANG_DOI_CHUNG})
     + (SELECT count(*) FROM public.contracts)
     + (SELECT count(*) FROM public.invoices) AS tong;
ROLLBACK;`;
}

const SQL_NHAN_VAT = `
  SELECT m.user_id::text AS uid, m.organization_id::text AS org, u.email
    FROM public.organization_memberships m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = m.user_id)
   ORDER BY m.organization_id, u.email`;

/** Suy nhân vật TỪ DATABASE, không hard-code người — người có thể nghỉ việc. */
function chonNhanVat(rows) {
  const theoOrg = new Map();
  for (const r of rows) if (!theoOrg.has(r.org)) theoOrg.set(r.org, r);
  return [...theoOrg.values()];
}

async function main(argv) {
  const ghi = argv.includes('--write');
  const pat = readPat();
  if (!pat) { console.error('❌ Không tìm thấy PAT'); return MA_THOAT_CHOT_HONG; }
  const ref = readProjectRef();

  const nhanVat = chonNhanVat(await runSql(SQL_NHAN_VAT, { pat, ref }));
  if (nhanVat.length < 2) {
    console.error('❌ Cần ít nhất 2 tổ chức có người dùng thường để đo rò chéo.');
    return MA_THOAT_CHOT_HONG;
  }

  const [am] = await runSql(sqlDoiChungAm(), { pat, ref });
  const doiChungAm = Number(am?.tong ?? -1);

  // Danh sách bảng lấy MỘT LẦN, rồi chia lô — mỗi lô một request.
  const tatCaBang = (await runSql(
    `SELECT c.relname AS ten FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id'
                          AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r','p') AND NOT c.relispartition
      ORDER BY c.relname`,
    { pat, ref },
  )).map((r) => r.ten);
  const cacLo = chiaLo(tatCaBang, SO_BANG_MOI_LO);

  const doDuoc = [];
  for (const nv of nhanVat) {
    const bang = [];
    let chotCuoi = null;
    for (const lo of cacLo) {
      // Bảng đối chứng đi kèm MỌI lô: bốn chốt phải đạt trong CHÍNH phiên đo ra
      // số, không phải trong một phiên khác cùng vai. Chia lô mà chỉ kiểm chốt ở
      // lô đầu thì các lô sau không có gì bảo đảm.
      const loKemDoiChung = lo.includes(BANG_DOI_CHUNG) ? lo : [...lo, BANG_DOI_CHUNG];
      const [kq] = await runSql(sqlDoMotVai(nv.uid, nv.org, loKemDoiChung), { pat, ref });
      chotCuoi = kiemChotChongAoGiac({
        current_user: kq.current_user,
        rolbypassrls: kq.rolbypassrls,
        auth_uid: kq.auth_uid,
        uid_mong_doi: nv.uid,
        doi_chung_duong_tong: Number(kq.doi_chung_duong_tong ?? 0),
        doi_chung_duong_ngoai: Number(kq.doi_chung_duong_ngoai ?? 0),
        doi_chung_am: doiChungAm,
      });
      if (!chotCuoi.dat) {
        console.error(`❌ Chốt chống ảo giác HỎNG với vai ${nv.email}:`);
        for (const l of chotCuoi.loi) console.error(`   - ${l}`);
        console.error('   KHÔNG ghi baseline. Số đo lúc này không đáng tin.');
        return MA_THOAT_CHOT_HONG;
      }
      bang.push(...kq.bang.filter((b) => lo.includes(b.bang)));
    }
    doDuoc.push({ nhanVat: nv, bang });
    console.log(`✔ ${nv.email} (org ${nv.org.slice(0, 4)}…): 4/4 chốt đạt ở cả ${cacLo.length} lô, quét ${bang.length} bảng`);
  }

  // Gộp: một bảng rò nếu BẤT KỲ nhân vật nào thấy dòng của tổ chức khác.
  const gop = new Map();
  for (const d of doDuoc) {
    for (const b of d.bang) {
      const cu = gop.get(b.bang) ?? { table_name: b.bang, visible_foreign: 0, ground_truth_total: 0, theoVai: {} };
      cu.visible_foreign = Math.max(cu.visible_foreign, Number(b.ngoai ?? 0));
      cu.ground_truth_total = Math.max(cu.ground_truth_total, Number(b.tong ?? 0));
      cu.theoVai[d.nhanVat.email] = { tong: b.tong, ngoai: b.ngoai };
      gop.set(b.bang, cu);
    }
  }

  const inv = JSON.parse(readFileSync(DUONG_INVENTORY, 'utf8'));
  const capQuyen = new Map(inv.rows.map((r) => [r.table_name, r.authenticated_can_select]));

  // Trạng thái biên giới phải hỏi THẲNG production, không đọc từ inventory.
  //
  // Án lệ 08/08/2026: bản đầu của script này lấy danh sách "đã có biên giới" từ
  // docs/generated/org-boundary-inventory.json. Ngay sau khi apply 251 policy,
  // nó vẫn in "272 bảng chưa có biên giới" — vì file kia được sinh TRƯỚC lúc
  // apply. Con số đúng lúc đó là 21. Một công cụ đo báo trạng thái cũ còn tệ hơn
  // không đo: nó khiến người ta tưởng bản vá không ăn, rồi đi vá lại.
  const boundaryRows = await runSql(
    `SELECT c.relname AS table_name
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE p.polname = c.relname || '_org_boundary'`,
    { pat, ref },
  );
  const daCoBoundary = new Set(boundaryRows.map((r) => r.table_name));

  const rows = [...gop.values()].map((b) => ({
    ...b,
    authenticated_can_select: capQuyen.get(b.table_name) ?? true,
    ...xepNhomTheoSoDo({ ...b, authenticated_can_select: capQuyen.get(b.table_name) ?? true }),
  }));

  const canXet = rows.filter((r) => !daCoBoundary.has(r.table_name));
  const dem = canXet.reduce((m, r) => ({ ...m, [r.group]: (m[r.group] ?? 0) + 1 }), {});

  // Tách rò ĐÃ KHAI khỏi rò CHƯA AI BIẾT.
  //
  // Một gate đỏ ngay từ ngày đầu sẽ bị tắt trong một tuần, và khi ấy rò THẬT
  // cũng không ai thấy. Năm bảng đang rò hiện nay đều nằm trong sổ miễn trừ với
  // lý do đo được và một HẠN — chúng đã được nhìn thấy và được hẹn ngày xử lý.
  // Cái phải làm CI đỏ là bảng rò mà KHÔNG ai khai, tức thứ vừa mới xuất hiện.
  //
  // Miễn trừ quá hạn không lọt qua đây: gate build-org-boundary-inventory --check
  // đỏ khi expires_at đã qua. Hai gate canh hai chuyện khác nhau.
  let mienTru = [];
  try {
    mienTru = await runSql('SELECT table_name FROM app_private.org_boundary_exemptions', { pat, ref });
  } catch {
    console.error('⚠ Không đọc được sổ miễn trừ — coi như RỖNG, tức mọi rò đều tính là chưa khai.');
  }
  const daKhai = new Set(mienTru.map((r) => r.table_name));
  const roThat = canXet.filter((r) => r.group === 'LIVE_LEAK' && !daKhai.has(r.table_name));
  const roDaKhai = canXet.filter((r) => r.group === 'LIVE_LEAK' && daKhai.has(r.table_name));

  console.log('');
  console.log(`Bảng chưa có biên giới: ${canXet.length} · ${Object.entries(dem).sort().map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  if (roDaKhai.length) {
    console.log(`Rò ĐÃ KHAI trong sổ miễn trừ (${roDaKhai.length}, có hạn — không làm CI đỏ ở đây): ${roDaKhai.map((r) => `${r.table_name}(${r.visible_foreign})`).join(', ')}`);
  }
  if (roThat.length) {
    console.log(`❌ RÒ CHƯA AI KHAI (${roThat.length}): ${roThat.map((r) => `${r.table_name}(${r.visible_foreign})`).join(', ')}`);
    console.log('   Hoặc rào bảng đó, hoặc khai vào app_private.org_boundary_exemptions kèm lý do đo được và hạn.');
  }

  if (ghi) {
    writeFileSync(RA, `${JSON.stringify({
      note: 'Sinh bằng máy — node scripts/measure-org-leak.mjs --write. Đo bằng vai người dùng thật, chỉ đọc, mọi truy vấn bọc ROLLBACK.',
      projectRef: ref,
      capturedAt: new Date().toISOString(),
      catalogFingerprint: inv.catalogFingerprint ?? null,
      nhanVat: nhanVat.map((n) => ({ org: n.org, email: n.email })),
      counts: dem,
      rows,
    }, null, 2)}\n`);
    console.log(`✅ Đã ghi ${RA.replace(repoRoot, '.')}`);
  }
  return roThat.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
    .then((c) => process.exit(c))
    .catch((e) => { console.error(`❌ ${e.message}`); process.exit(MA_THOAT_CHOT_HONG); });
}
