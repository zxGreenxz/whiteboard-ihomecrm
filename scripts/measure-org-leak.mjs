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

import { vanBanNguoiDung } from './lib/che-so-lieu-ci.mjs';

import { readPat, readProjectRef, runSql } from './capture-production-catalog.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DUONG_INVENTORY = join(repoRoot, 'docs/generated/org-boundary-inventory.json');
const RA = join(repoRoot, 'docs/generated/org-leak-baseline.json');

export const MA_THOAT_CHOT_HONG = 3;

const UID_MO_COI = '11111111-2222-4333-8444-555555555555';
const BANG_DOI_CHUNG = 'income_expense_types';

// ─── NHÂN VẬT TỔNG HỢP ──────────────────────────────────────────────────────
//
// Trước 08/08/2026 bộ đo này đòi ÍT NHẤT HAI tổ chức có người dùng thật, vì "rò
// chéo tổ chức" cần một tổ chức thứ hai để rò SANG. Hai tổ chức đó là Test và
// Demo — dữ liệu rác nằm trong production.
//
// Rồi hai tổ chức đó bị xoá (20260808080000), và bộ đo lập tức chết với
// "Cần ít nhất 2 tổ chức". Nó fail-closed đúng — thoát mã 3 chứ không báo "0 rò"
// giả — nhưng một gate an ninh CHẶN mà đứng được là nhờ rác trong prod thì đó là
// khuyết tật thiết kế, không phải tai nạn.
//
// Cách chữa: bộ đo TỰ DỰNG tổ chức thứ hai bên trong chính transaction
// BEGIN…ROLLBACK mà nó vẫn dùng. Không để lại gì, không phụ thuộc vào ai.
//
// Và phép thử này MẠNH HƠN bản cũ. Trước đây câu hỏi là "tổ chức B có thấy dòng
// của A không" — B có dữ liệu riêng nên số 0 có thể đến từ may mắn. Nay câu hỏi
// là "một tổ chức VỪA SINH RA, chưa có một dòng nào, thấy được những gì" —
// đáp án đúng là KHÔNG GÌ CẢ, và mọi dòng nó thấy đều là rò, không cần diễn giải.
const UID_TONG_HOP = '99999999-0000-4000-8000-000000000099';
const ORG_TONG_HOP = '99990000-0000-4000-8000-000000000099';

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
  if (d.tongHop) {
    // Nhân vật tổng hợp KHÔNG có dòng nào của mình, nên "đối chứng dương > 0"
    // không áp dụng được — với nó, thấy 0 dòng ở bảng đã rào là ĐÚNG chứ không
    // phải mù.
    //
    // Nhưng bỏ chốt chống-mù thì phải thay bằng chốt khác, nếu không một truy
    // vấn hỏng âm thầm sẽ cho ra 0 và bị đọc thành "sạch". Chốt thay thế:
    // my_org_ids() phải trả ĐÚNG tổ chức vừa dựng. Nó chứng minh phiên đang
    // sống, đang nhìn qua RLS, và bối cảnh tổ chức có thật — thứ mà một truy vấn
    // hỏng không thể giả được.
    if (d.my_orgs !== ORG_TONG_HOP) {
      loi.push(`my_org_ids() trả '${d.my_orgs}' chứ không phải tổ chức tổng hợp vừa dựng — bối cảnh không thành hình, số 0 đo ra là số 0 của sự mù.`);
    }
    if (d.doi_chung_duong_tong > 0) {
      loi.push(`Tổ chức VỪA SINH RA đã thấy ${d.doi_chung_duong_tong} dòng ở ${BANG_DOI_CHUNG} — bảng mốc đang rò.`);
    }
  } else {
    if (!(d.doi_chung_duong_tong > 0)) {
      loi.push(`Đối chứng dương (${BANG_DOI_CHUNG}) thấy 0 dòng — bài đo đang MÙ chứ không phải sạch.`);
    }
    if (d.doi_chung_duong_ngoai > 0) {
      loi.push(`Đối chứng dương lại thấy ${d.doi_chung_duong_ngoai} dòng của tổ chức khác — bảng mốc phải sạch.`);
    }
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
function sqlDoMotVai(uid, org, loBang, tongHop = false) {
  // Quét 304 bảng bằng vai người dùng thật mất vài phút, vì RLS được đánh giá
  // cho từng bảng. Riêng invoice_payment_allocations và _collections mất 14–18
  // GIÂY MỖI BẢNG — đo được đó là vấn đề CÓ SẴN của chuỗi can_access_building /
  // can_v3 trong policy RBAC của chúng, không phải do biên giới tổ chức: gỡ
  // policy biên giới ra vẫn 17,07s so với 18,08s khi có (chênh 5%).
  // Mặc định 120s của lane không đủ, và bỏ cuộc giữa chừng thì bộ đo im lặng
  // đúng lúc cần nói.
  // Dựng tổ chức thứ hai NGAY TRONG transaction này, trước khi hạ vai xuống
  // authenticated. Cả ba dòng biến mất theo ROLLBACK ở cuối — production không
  // bao giờ nhìn thấy chúng ngoài khoảng thời gian của chính phép đo.
  const dungTongHop = tongHop ? `
INSERT INTO auth.users (id) VALUES ('${UID_TONG_HOP}');
INSERT INTO public.organizations (id, slug, name)
VALUES ('${ORG_TONG_HOP}', 'zz-do-ro-tong-hop', 'ZZ tổ chức tổng hợp để đo rò');
INSERT INTO public.organization_memberships (organization_id, user_id, member_type, status)
VALUES ('${ORG_TONG_HOP}', '${UID_TONG_HOP}', 'STAFF', 'ACTIVE');
` : '';

  return `BEGIN;
SET LOCAL statement_timeout = '900s';
${dungTongHop}
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
  (SELECT array_to_string(public.my_org_ids(), ','))                                 AS my_orgs,
  (SELECT tong  FROM _kq WHERE bang = '${BANG_DOI_CHUNG}')                           AS doi_chung_duong_tong,
  (SELECT ngoai FROM _kq WHERE bang = '${BANG_DOI_CHUNG}')                           AS doi_chung_duong_ngoai,
  (SELECT coalesce(json_agg(json_build_object('bang',bang,'tong',tong,'ngoai',ngoai)),'[]'::json)
     FROM _kq)                                                                       AS bang;
ROLLBACK;`;
}

/**
 * Quét những bảng KHÔNG có cột organization_id, bằng vai tổng hợp.
 *
 * ĐIỂM MÙ ĐÃ TỒN TẠI TỪ ĐẦU: bộ đo này dò bảng theo cột organization_id, nên 12
 * bảng không có cột đó chưa từng được quét lần nào. Gate
 * build-org-boundary-inventory xếp chúng vào nhóm NO_ORG_COLUMN và coi là "có
 * chỗ đứng" — đúng về mặt sổ sách, nhưng "có chỗ đứng" không phải "đã đo".
 *
 * Với bảng không có cột org thì không có khái niệm "dòng của tổ chức khác" để
 * lọc. Nhưng có một phép thử sạch hơn nhiều, và chỉ nhân vật TỔNG HỢP mới làm
 * được: một tổ chức VỪA SINH RA không sở hữu dòng nào ở đâu cả, nên MỌI dòng nó
 * đọc được ở những bảng này đều là dữ liệu của người khác. Ngưỡng đúng là 0.
 *
 * Đo 08/08/2026 lần đầu: cả 12 bảng đều đạt — 6 bảng RLS chặn về 0, 6 bảng
 * không cấp SELECT cho authenticated nên báo thẳng permission denied. Sạch, thật,
 * nhưng trước hôm nay là sạch KHÔNG AI CANH.
 */
function sqlDoBangKhongCotOrg(loBang) {
  return `BEGIN;
SET LOCAL statement_timeout = '900s';
INSERT INTO auth.users (id) VALUES ('${UID_TONG_HOP}');
INSERT INTO public.organizations (id, slug, name)
VALUES ('${ORG_TONG_HOP}', 'zz-do-ro-tong-hop', 'ZZ tổ chức tổng hợp để đo rò');
INSERT INTO public.organization_memberships (organization_id, user_id, member_type, status)
VALUES ('${ORG_TONG_HOP}', '${UID_TONG_HOP}', 'STAFF', 'ACTIVE');

CREATE TEMP TABLE _kq(bang text, tong bigint, tu_choi boolean);
GRANT INSERT, SELECT ON _kq TO PUBLIC;

CREATE FUNCTION pg_temp._quet0() RETURNS void LANGUAGE plpgsql AS $quet$
DECLARE b text; v bigint;
BEGIN
  FOREACH b IN ARRAY ARRAY[${loBang.map((t) => `'${t}'`).join(',')}] LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I', b) INTO v;
      INSERT INTO _kq VALUES (b, v, false);
    EXCEPTION WHEN insufficient_privilege THEN
      -- Không cấp quyền đọc là dạng AN TOÀN NHẤT, không phải lỗi đo.
      INSERT INTO _kq VALUES (b, 0, true);
    WHEN OTHERS THEN
      INSERT INTO _kq VALUES (b, NULL, false);
    END;
  END LOOP;
END $quet$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"${UID_TONG_HOP}","role":"authenticated"}';
SELECT pg_temp._quet0();

SELECT
  (SELECT current_user)::text                                       AS current_user,
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)  AS rolbypassrls,
  (SELECT auth.uid())::text                                         AS auth_uid,
  (SELECT array_to_string(public.my_org_ids(), ','))                AS my_orgs,
  (SELECT coalesce(json_agg(json_build_object('bang',bang,'tong',tong,'tu_choi',tu_choi)),'[]'::json)
     FROM _kq)                                                      AS bang;
ROLLBACK;`;
}

/**
 * Phân loại dòng có organization_id IS NULL.
 *
 * ĐIỂM MÙ THỨ HAI, cùng họ với điểm mù thứ nhất nhưng khó thấy hơn. Công thức
 * biên giới đang chạy trên 302 bảng là:
 *     organization_id IS NULL OR is_super_admin() OR organization_id IN my_org_ids()
 * Nhánh đầu nghĩa là dòng NULL thì AI CŨNG THẤY.
 *
 * Còn bộ đo này định nghĩa "dòng của tổ chức khác" là
 *     organization_id IS NOT NULL AND organization_id <> org-của-mình
 * nên dòng NULL bị loại khỏi phép đếm THEO ĐÚNG ĐỊNH NGHĨA — chúng lộ cho tất
 * cả mà chưa từng bị tính là rò lần nào. Đo 09/08/2026 lần đầu: 3.621 dòng trên
 * 15 bảng, trong đó 345 dòng nhật ký kiểm toán hoá đơn.
 *
 * NULL không phải lúc nào cũng sai: với dữ liệu TOÀN HỆ (danh mục nhà cung cấp
 * LLM, cấu hình singleton, nhật ký cron) thì NULL là nhãn ĐÚNG. Nên luật không
 * phải "cấm NULL" mà là "NULL phải có hợp đồng đã kiểm chứng". Dữ liệu toàn hệ
 * khai trong org_null_is_global. Riêng personal_transactions giữ quyền theo owner:
 * exemption còn hạn + metadata đúng CHƯA đủ; phải đo RLS thật ở dưới.
 */
const PERSONAL_TABLE = 'personal_transactions';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const demHopLe = (value) => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** Only this known actor-owned table has a separate contract. Metadata alone never proves RLS. */
export function kiemDoOwnerPersonal(proof) {
  const loi = [], truth = proof?.truth;
  let ro = false;
  if (!truth || truth.table_name !== PERSONAL_TABLE) loi.push('Missing personal owner ground truth');
  for (const key of ['exemption_valid','owner_column','owner_policy','rls_enabled','not_global','orphan_absent']) {
    if (truth?.[key] !== true) loi.push(`Invalid personal owner metadata: ${key}`);
  }
  const total = demHopLe(truth?.total), nullTotal = demHopLe(truth?.null_total);
  if (total === null || nullTotal === null || nullTotal > total) loi.push('Invalid owner ground counts');
  if (typeof proof?.elapsed_ms !== 'number' || !Number.isFinite(proof.elapsed_ms) || proof.elapsed_ms < 0 || proof.elapsed_ms > 30000) loi.push('Owner probe missing/over time budget (30s)');
  const owners = new Map();
  if (!Array.isArray(truth?.owners) || !truth.owners.length || truth.owners.length > 200) loi.push('Missing/bounded owner population');
  else for (const row of truth.owners) {
    if (!UUID.test(row?.uid ?? '') || row.uid === UID_MO_COI || owners.has(row.uid) || demHopLe(row.own_total) === null || demHopLe(row.own_null) === null || Number(row.own_null) > Number(row.own_total)) loi.push('Invalid/duplicate owner truth');
    else owners.set(row.uid, { total: Number(row.own_total), null: Number(row.own_null) });
  }
  if ([...owners.values()].reduce((n,o) => n + o.total,0) !== total || [...owners.values()].reduce((n,o) => n + o.null,0) !== nullTotal) loi.push('Owner truth does not cover all rows');
  const expected = new Map([...owners, [UID_MO_COI, { total: 0, null: 0 }]]), seen = new Set();
  if (!Array.isArray(proof?.actors)) loi.push('Missing measured owner actors');
  else for (const actor of proof.actors) {
    const ownTruth = expected.get(actor?.uid);
    if (!ownTruth || seen.has(actor.uid)) { loi.push('Unknown/duplicate measured actor'); continue; }
    seen.add(actor.uid);
    if (actor.current_user !== 'authenticated' || actor.auth_uid !== actor.uid || actor.rolbypassrls !== false || actor.rolsuper !== false || actor.table_owner_member !== false || actor.row_security !== 'on' || actor.read_only !== 'on') loi.push('Owner runtime guard failed');
    const keys = ['visible_total','own_total','own_null','foreign_total','foreign_null'];
    if (keys.some(k => demHopLe(actor[k]) === null)) { loi.push('Invalid measured owner counts'); continue; }
    const n = Object.fromEntries(keys.map(k => [k, Number(actor[k])]));
    if (n.own_null !== ownTruth.null || n.own_total > ownTruth.total || n.own_null > n.own_total || n.visible_total !== n.own_total + n.foreign_total || n.foreign_null > n.foreign_total) loi.push('Owner positive control/count reconciliation failed');
    if (n.foreign_total > 0 || n.foreign_null > 0) ro = true;
  }
  if (seen.size !== expected.size) loi.push('Incomplete owner/orphan actor coverage');
  return { dat: loi.length === 0 && !ro, ro, loi, actors: seen.size, nullTotal, total };
}

/** No DDL/DML, even temporary: local GUCs retain aggregate proof within one read-only snapshot. */
export function sqlDoOwnerPersonal(uids) {
  if (!Array.isArray(uids) || !uids.length || uids.length > 200 || uids.some(u => !UUID.test(u) || u === UID_MO_COI) || new Set(uids).size !== uids.length) throw new Error('Invalid/bounded personal owner actor list (1..200 UUIDs)');
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT set_config('app.personal_owner_started',clock_timestamp()::text,true);
SELECT set_config('app.personal_owner_truth',jsonb_build_object(
 'table_name','personal_transactions',
 'exemption_valid',EXISTS(SELECT 1 FROM app_private.org_boundary_exemptions WHERE table_name='personal_transactions' AND expires_at>=current_date AND length(btrim(reason))>0 AND length(btrim(decided_by))>0 AND replacement_policy LIKE '%personal_txn_own%'),
 'owner_column',EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.personal_transactions'::regclass AND attname='user_id' AND attnum>0 AND NOT attisdropped AND attnotnull AND atttypid='uuid'::regtype),
 'owner_policy',EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.personal_transactions'::regclass AND polname='personal_txn_own' AND polcmd IN ('r','*') AND ('authenticated'::regrole::oid=ANY(polroles) OR 0::oid=ANY(polroles))),
 'rls_enabled',(SELECT relrowsecurity FROM pg_class WHERE oid='public.personal_transactions'::regclass),
 'not_global',NOT EXISTS(SELECT 1 FROM app_private.org_null_is_global WHERE table_name='personal_transactions'),
 'orphan_absent',NOT EXISTS(SELECT 1 FROM auth.users WHERE id='${UID_MO_COI}'),
 'total',(SELECT count(*) FROM public.personal_transactions),
 'null_total',(SELECT count(*) FROM public.personal_transactions WHERE organization_id IS NULL),
 'owners',(SELECT jsonb_agg(jsonb_build_object('uid',u.id,'own_total',(SELECT count(*) FROM public.personal_transactions t WHERE t.user_id=u.id),'own_null',(SELECT count(*) FROM public.personal_transactions t WHERE t.user_id=u.id AND organization_id IS NULL)) ORDER BY u.id) FROM auth.users u)
)::text,true);
SELECT set_config('app.personal_owner_probe','[]',true);
SET LOCAL ROLE authenticated;
${[...uids,UID_MO_COI].map(uid => `SET LOCAL request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}';
SET LOCAL request.jwt.claim.sub = '${uid}';
SELECT set_config('app.personal_owner_probe', (current_setting('app.personal_owner_probe')::jsonb || jsonb_build_array(
 jsonb_build_object('uid','${uid}','auth_uid',auth.uid(),'current_user',current_user,
 'rolbypassrls',(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user),
 'rolsuper',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
 'table_owner_member',(SELECT pg_has_role(current_user,relowner,'USAGE') FROM pg_class WHERE oid='public.personal_transactions'::regclass),
 'row_security',current_setting('row_security'),'read_only',current_setting('transaction_read_only')) ||
 (SELECT jsonb_build_object('visible_total',count(*),
   'own_total',count(*) FILTER (WHERE user_id=auth.uid()),
   'own_null',count(*) FILTER (WHERE user_id=auth.uid() AND organization_id IS NULL),
   'foreign_total',count(*) FILTER (WHERE user_id IS DISTINCT FROM auth.uid()),
   'foreign_null',count(*) FILTER (WHERE user_id IS DISTINCT FROM auth.uid() AND organization_id IS NULL))
  FROM public.personal_transactions)))::text,true);`).join('\n')}
RESET ROLE;
SELECT jsonb_build_object('truth',current_setting('app.personal_owner_truth')::jsonb,'actors',current_setting('app.personal_owner_probe')::jsonb,
 'elapsed_ms',extract(epoch FROM clock_timestamp()-current_setting('app.personal_owner_started')::timestamptz)*1000) AS personal_owner_probe;
ROLLBACK;`;
}

export function phanLoaiDongNull(rows, ownerProof) {
  const chuaKhai = [];
  const daKhai = [];
  const actorOwned = [], chuaDo = [], roOwner = [], seen = new Set();
  if (!Array.isArray(rows)) chuaDo.push({ bang: '(NULL scan)', loi: 'Missing/malformed NULL scan' });
  for (const r of Array.isArray(rows) ? rows : []) {
    const n = demHopLe(r?.so_dong_null);
    if (typeof r?.bang !== 'string' || !r.bang || seen.has(r.bang) || n === null || typeof r.da_khai !== 'boolean') { chuaDo.push({ bang: r?.bang, loi: 'Invalid NULL count/declaration' }); continue; }
    seen.add(r.bang);
    if (r.bang === PERSONAL_TABLE) {
      const proof = kiemDoOwnerPersonal(ownerProof);
      if (r.da_khai || proof.loi.length || proof.nullTotal !== n) chuaDo.push({ bang: r.bang, loi: proof.loi.length ? proof.loi.join('; ') : 'Personal owner proof mismatch/global mislabel' });
      else if (proof.ro) roOwner.push({ bang: r.bang, so_dong_null: n });
      else actorOwned.push({ bang: r.bang, so_dong_null: n });
      continue;
    }
    if (n === 0) continue;
    (r?.da_khai ? daKhai : chuaKhai).push({ bang: r.bang, so_dong_null: n });
  }
  if (ownerProof !== undefined && !seen.has(PERSONAL_TABLE)) {
    const proof = kiemDoOwnerPersonal(ownerProof);
    if (proof.loi.length || proof.nullTotal !== 0) chuaDo.push({ bang: PERSONAL_TABLE, loi: 'Owner proof missing from NULL scan or invalid' });
    else if (proof.ro) roOwner.push({ bang: PERSONAL_TABLE, so_dong_null: 0 });
  }
  return {
    chuaKhai,
    daKhai,
    actorOwned, chuaDo, roOwner,
    tongChuaKhai: chuaKhai.reduce((t, b) => t + b.so_dong_null, 0),
  };
}

/**
 * Đếm dòng NULL bằng quyền quản trị, KHÔNG giả lập vai.
 *
 * Đây chỉ là ground truth, KHÔNG suy rằng NULL tự nó chứng minh lộ dữ liệu.
 * Dữ liệu toàn hệ phải khai; personal_transactions phải qua owner probe thật.
 */
const SQL_DEM_DONG_NULL = `
DO $$
DECLARE r record; v bigint;
BEGIN
  CREATE TEMP TABLE _null_org(bang text, so_dong_null bigint, da_khai boolean) ON COMMIT DROP;
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id'
                         AND a.attnum > 0 AND NOT a.attisdropped AND NOT a.attnotnull
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r','p') AND NOT c.relispartition
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', r.relname) INTO v;
    IF v > 0 THEN
      INSERT INTO _null_org
      SELECT r.relname, v,
             EXISTS (SELECT 1 FROM app_private.org_null_is_global g WHERE g.table_name = r.relname);
    END IF;
  END LOOP;
END $$;
SELECT coalesce(json_agg(json_build_object('bang', bang, 'so_dong_null', so_dong_null, 'da_khai', da_khai)
                         ORDER BY so_dong_null DESC), '[]'::json) AS bang FROM _null_org;`;

/**
 * Phân loại kết quả quét bảng không có cột organization_id.
 *
 * Tách thành hàm thuần để test được cả ba lối rẽ mà không chạm production —
 * nhất là lối thứ ba, thứ mà bản đầu của chính đoạn mã này làm SAI.
 *
 * BA LỐI RẼ, và chỉ một lối là "ổn":
 *   tu_choi = true  → KHÔNG cấp SELECT cho authenticated. An toàn nhất.
 *   tong = 0        → có quyền đọc nhưng RLS chặn sạch. An toàn.
 *   tong > 0        → RÒ. Tổ chức vừa sinh ra không sở hữu gì, nên mọi dòng nó
 *                     đọc được ở đây đều là của người khác.
 *   tong = null     → CHƯA ĐO ĐƯỢC (một lỗi ngoài dự kiến trong lúc đếm).
 *
 * Bản đầu viết `Number(b.tong ?? 0) > 0`, biến null thành 0 và đọc "chưa đo
 * được" thành "sạch" — đúng cái kiểu nói dối theo hướng an toàn mà cả bộ đo này
 * sinh ra để chống. Nay null đi lối riêng và làm gate đỏ bằng mã 3, khác hẳn mã
 * 1 của "đo xong, có rò".
 */
export function phanLoaiBangKhongCotOrg(rows) {
  const ro = [];
  const chuaDo = [];
  let tuChoi = 0;
  for (const b of rows ?? []) {
    if (b?.tu_choi === true) { tuChoi += 1; continue; }
    if (b?.tong === null || b?.tong === undefined) { chuaDo.push(b); continue; }
    if (Number(b.tong) > 0) ro.push(b);
  }
  return { ro, chuaDo, tuChoi, tong: (rows ?? []).length };
}

const SQL_BANG_KHONG_COT_ORG = `
  SELECT c.relname AS ten
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r','p') AND NOT c.relispartition
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                      AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped)
   ORDER BY c.relname`;

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

/**
 * Nhãn in ra log cho một nhân vật. Email/tên đăng nhập của tài khoản THẬT không
 * được lên log CI (repo public — ai cũng đọc); mã tổ chức rút gọn đã đủ định danh.
 * Nhân vật tổng hợp mang nhãn mô tả, không phải dữ liệu người dùng.
 */
export function nhanVaiTrenLog(nv, env = process.env) {
  if (nv?.tongHop) return nv.email;
  return vanBanNguoiDung(nv?.email, env) || 'tài khoản thật (ẩn trên CI)';
}

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

  // MỘT tổ chức thật là đủ: nó giữ vế "người thật vẫn thấy dữ liệu của mình"
  // (đối chứng dương). Vế "không ai thấy dữ liệu của người khác" do nhân vật
  // TỔNG HỢP đảm nhiệm, và nhân vật đó luôn có mặt vì bộ đo tự dựng ra nó.
  //
  // Phải giữ ĐỦ HAI VẾ. Chỉ hỏi "hết rò chưa" là chưa đủ — khoá sạch mọi người
  // cũng cho ra 0.
  const nhanVatThat = chonNhanVat(await runSql(SQL_NHAN_VAT, { pat, ref }));
  if (nhanVatThat.length < 1) {
    console.error('❌ Không có tổ chức nào có người dùng thường — không giữ được vế "người thật vẫn thấy dữ liệu của mình".');
    return MA_THOAT_CHOT_HONG;
  }
  const nhanVat = [
    ...nhanVatThat,
    { uid: UID_TONG_HOP, org: ORG_TONG_HOP, email: '(tổ chức tổng hợp — vừa sinh ra, phải thấy 0)', tongHop: true },
  ];

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
      const [kq] = await runSql(sqlDoMotVai(nv.uid, nv.org, loKemDoiChung, nv.tongHop), { pat, ref });
      chotCuoi = kiemChotChongAoGiac({
        tongHop: nv.tongHop === true,
        my_orgs: kq.my_orgs,
        current_user: kq.current_user,
        rolbypassrls: kq.rolbypassrls,
        auth_uid: kq.auth_uid,
        uid_mong_doi: nv.uid,
        doi_chung_duong_tong: Number(kq.doi_chung_duong_tong ?? 0),
        doi_chung_duong_ngoai: Number(kq.doi_chung_duong_ngoai ?? 0),
        doi_chung_am: doiChungAm,
      });
      if (!chotCuoi.dat) {
        console.error(`❌ Chốt chống ảo giác HỎNG với vai ${nhanVaiTrenLog(nv)} (org ${nv.org.slice(0, 4)}…):`);
        for (const l of chotCuoi.loi) console.error(`   - ${l}`);
        console.error('   KHÔNG ghi baseline. Số đo lúc này không đáng tin.');
        return MA_THOAT_CHOT_HONG;
      }
      bang.push(...kq.bang.filter((b) => lo.includes(b.bang)));
    }
    doDuoc.push({ nhanVat: nv, bang });
    console.log(`✔ ${nhanVaiTrenLog(nv)} (org ${nv.org.slice(0, 4)}…): 4/4 chốt đạt ở cả ${cacLo.length} lô, quét ${bang.length} bảng`);
  }

  // ─── Điểm mù cũ: 12 bảng KHÔNG có cột organization_id chưa từng được quét ───
  const bangKhongCotOrg = (await runSql(SQL_BANG_KHONG_COT_ORG, { pat, ref })).map((r) => r.ten);
  const doDuocKhongOrg = [];
  for (const lo of chiaLo(bangKhongCotOrg, SO_BANG_MOI_LO)) {
    const [kq] = await runSql(sqlDoBangKhongCotOrg(lo), { pat, ref });
    const chot = kiemChotChongAoGiac({
      tongHop: true,
      my_orgs: kq.my_orgs,
      current_user: kq.current_user,
      rolbypassrls: kq.rolbypassrls,
      auth_uid: kq.auth_uid,
      uid_mong_doi: UID_TONG_HOP,
      doi_chung_duong_tong: 0,
      doi_chung_duong_ngoai: 0,
      doi_chung_am: doiChungAm,
    });
    if (!chot.dat) {
      console.error('❌ Chốt chống ảo giác HỎNG khi quét bảng không có cột organization_id:');
      for (const l of chot.loi) console.error(`   - ${l}`);
      return MA_THOAT_CHOT_HONG;
    }
    doDuocKhongOrg.push(...kq.bang);
  }
  const kq0 = phanLoaiBangKhongCotOrg(doDuocKhongOrg);
  console.log(
    `✔ bảng KHÔNG có cột organization_id: quét ${kq0.tong}, `
    + `${kq0.tuChoi} không cấp quyền đọc, `
    + `${kq0.ro.length} để tổ chức vừa sinh ra đọc được dòng`,
  );
  if (kq0.chuaDo.length > 0) {
    console.error('\n❌ Không đếm được ở bảng không có cột organization_id — số đo KHÔNG đầy đủ:');
    for (const b of kq0.chuaDo) console.error(`   ? ${b.bang}`);
    console.error('   "Chưa đo được" không phải "sạch". KHÔNG ghi baseline.');
    return MA_THOAT_CHOT_HONG;
  }
  if (kq0.ro.length > 0) {
    console.error('\n❌ Tổ chức VỪA SINH RA đọc được dòng ở bảng không có cột organization_id.');
    console.error('   Bảng không có cột org thì không có gì để lọc — mọi dòng nó thấy đều là của người khác:');
    for (const b of kq0.ro) console.error(`   ✗ ${b.bang} — ${b.tong} dòng`);
    return 1;
  }

  // Owner privacy is independent of organization/global-NULL declarations. Never exempt a live leak.
  let ownerProof;
  if (tatCaBang.includes(PERSONAL_TABLE)) {
    const users = await runSql('BEGIN READ ONLY; SELECT id::text AS uid FROM auth.users ORDER BY id; ROLLBACK;', { pat, ref });
    ownerProof = (await runSql(sqlDoOwnerPersonal(users.map(u => u.uid)), { pat, ref })).at(-1)?.personal_owner_probe;
    const check = kiemDoOwnerPersonal(ownerProof);
    if (check.loi.length) { console.error(`❌ Owner probe chưa đo được: ${check.loi.join('; ')}`); return MA_THOAT_CHOT_HONG; }
    if (check.ro) { console.error('❌ personal_transactions OWNER LEAK: actor thấy dòng của owner khác (kể cả NULL-org).'); return 1; }
    console.log(`✔ personal owner probe: ${check.actors} actors (gồm admins/orphan), ${check.total} rows/${check.nullTotal} NULL, foreign=0, ${Math.round(ownerProof.elapsed_ms)}ms`);
  }
  const nullRows = (await runSql(SQL_DEM_DONG_NULL, { pat, ref })).at(-1)?.bang;
  const kqNull = phanLoaiDongNull(nullRows, ownerProof);
  if (kqNull.chuaDo.length) { console.error(`❌ NULL/owner proof chưa đầy đủ: ${kqNull.chuaDo.map(b => `${b.bang}: ${b.loi}`).join('; ')}`); return MA_THOAT_CHOT_HONG; }
  if (kqNull.roOwner.length) { console.error('❌ personal_transactions OWNER LEAK trong NULL scan'); return 1; }
  console.log(
    `✔ dòng organization_id NULL: ${kqNull.daKhai.length} bảng đã khai là toàn hệ`
    + `${kqNull.daKhai.length ? ' (' + kqNull.daKhai.map((b) => `${b.bang}:${b.so_dong_null}`).join(', ') + ')' : ''}`
    + `, ${kqNull.actorOwned.length} bảng owner-only đã đo thực, ${kqNull.chuaKhai.length} bảng CHƯA khai`,
  );
  if (kqNull.chuaKhai.length > 0) {
    console.error(`\n❌ ${kqNull.tongChuaKhai} dòng organization_id NULL ở bảng CHƯA KHAI.`);
    console.error('   Chưa có hợp đồng và bằng chứng owner isolation cho những dòng này.');
    console.error('   Hoặc điền nhãn tổ chức đúng, hoặc khai vào');
    console.error('   app_private.org_null_is_global nếu đó thật sự là dữ liệu toàn hệ:');
    for (const b of kqNull.chuaKhai) console.error(`   ✗ ${b.bang} — ${b.so_dong_null} dòng`);
    return 1;
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
