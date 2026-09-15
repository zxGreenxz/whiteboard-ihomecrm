#!/usr/bin/env node
// Chốt chống hồi quy cho RLS của `residence_dossier_files` (ảnh hồ sơ tạm trú:
// CCCD, chữ ký, giấy chủ quyền). Chạy CA THẬT dưới `SET LOCAL ROLE authenticated`
// với JWT giả lập của ba vai, rồi ROLLBACK toàn bộ.
//
// VÌ SAO CẦN RIÊNG MỘT GATE
//   Test đơn vị chỉ mock supabase-js: chúng chứng minh app GỌI ĐÚNG, không chứng
//   minh DATABASE TỪ CHỐI. Cửa ngăn dữ liệu chéo org của bảng này nằm hoàn toàn
//   trong policy; sửa policy mà không ai đo là lỗ hổng im lặng.
//
//   Án lệ ngay trong lần dựng bảng (15/09/2026): policy SELECT có
//   `deleted_at IS NULL` làm UPDATE xoá mềm ném 42501 — Postgres áp USING của
//   SELECT lên cả DÒNG MỚI khi UPDATE có WHERE. Không có phép đo sống thì bug này
//   chỉ lộ khi người dùng bấm xoá ảnh trên production.
//
//   node scripts/check-residence-dossier-rls.mjs
//
// Cần PAT (env SUPABASE_PAT hoặc CLAUDE.local.md). Exit 0 đạt · 1 có ca sai · 3 không đo được.
import { readFileSync } from 'node:fs';

let pat = process.env.SUPABASE_PAT;
if (!pat) {
  try {
    const local = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
    const m = local.match(/sbp_[a-f0-9]+/);
    if (m) pat = m[0];
  } catch { /* không có vault ở checkout này */ }
}
if (!pat) { console.error('KHÔNG ĐO ĐƯỢC: thiếu PAT (env SUPABASE_PAT hoặc CLAUDE.local.md).'); process.exit(3); }

const ref = 'tryymsxyyckgbrmmvozx';
const CHU_CTY = '0520169e-0860-4b4e-a603-675c8aa245aa';  // vai "Chủ công ty" iHome, KHÔNG super admin
const SIEU_ADMIN = '90450d5f-29b6-4897-bdef-cdb5fb53f339';
const ORG_SANDBOX = 'cccc0000-0000-4000-8000-000000000001';

// Mọi ghi nằm trong MỘT transaction kết thúc bằng ROLLBACK tường minh: không dòng
// nào của phép thử tồn tại sau khi chạy. Kết quả đi ra bằng bảng tạm đọc TRƯỚC khi
// hoàn tác, nên không phụ thuộc COMMIT và cũng không phải nhét vào thông điệp lỗi.
const sql = `
BEGIN;
DO $ktra$
DECLARE
  chu_cty uuid := '${CHU_CTY}';
  sieu_admin uuid := '${SIEU_ADMIN}';
  nguoi_ngoai uuid;
  toa uuid; org uuid; khach uuid; toa_sandbox uuid;
  kq text := ''; n int;
BEGIN
  SELECT b.id, b.organization_id INTO toa, org
    FROM public.buildings b
    JOIN public.building_legal_owners o ON o.building_id = b.id
   WHERE b.deleted_at IS NULL AND b.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
   ORDER BY b.created_at LIMIT 1;
  SELECT c.id INTO khach FROM public.customers c
   WHERE c.deleted_at IS NULL AND c.organization_id = org AND c.status_v2 = 'RENTING' LIMIT 1;
  SELECT m.user_id INTO nguoi_ngoai FROM public.organization_memberships m
   WHERE m.organization_id = 'dddd0000-0000-4000-8000-000000000001' AND m.status = 'ACTIVE'
     AND m.user_id NOT IN (chu_cty, sieu_admin) LIMIT 1;
  SELECT id INTO toa_sandbox FROM public.buildings
   WHERE organization_id = '${ORG_SANDBOX}' AND deleted_at IS NULL LIMIT 1;
  IF toa_sandbox IS NULL THEN
    -- Org sandbox có thể chưa tồn tại trên database này. Dựng org + toà tạm ngay
    -- trong transaction (ROLLBACK ở cuối) để vẫn đo được lớp che sandbox thật sự,
    -- thay vì bỏ qua ca kiểm và tưởng là đạt.
    INSERT INTO public.organizations (id, slug, name, is_demo)
    VALUES ('${ORG_SANDBOX}', 'gate-rls-tam-tru', 'GATE RLS tam tru', true)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.buildings (organization_id, user_id, name, province, district, ward)
    VALUES ('${ORG_SANDBOX}', sieu_admin, 'GATE RLS tam tru', 'Thành phố Hồ Chí Minh', 'Quận Gò Vấp', 'Phường Hạnh Thông')
    RETURNING id INTO toa_sandbox;
  END IF;
  CREATE TEMP TABLE ket_qua_rls (kq text) ON COMMIT DROP;
  IF toa IS NULL OR khach IS NULL OR nguoi_ngoai IS NULL THEN
    INSERT INTO ket_qua_rls VALUES ('thieu_fixture=1');
    RETURN;
  END IF;

  -- Vai 1: chủ công ty (có customers.print trên toà) — ghi, đọc, xoá mềm.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', chu_cty, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', chu_cty::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.residence_dossier_files (organization_id, building_id, customer_id, kind, object_name, file_name, content_type, size_bytes)
  VALUES (org, toa, khach, 'CT01', chu_cty::text || '/ct01/gate-rls.webp', 'gate-rls.webp', 'image/webp', 1);
  SELECT count(*) INTO n FROM public.residence_dossier_files WHERE object_name = chu_cty::text || '/ct01/gate-rls.webp';
  kq := kq || 'chu_doc=' || n;
  BEGIN
    INSERT INTO public.residence_dossier_files (organization_id, building_id, customer_id, kind, object_name)
    VALUES (org, toa, khach, 'CT01', 'nguoi-khac/ct01/gate-rls.webp');
    kq := kq || '|thu_muc_nguoi_khac=cho_qua';
  EXCEPTION WHEN insufficient_privilege THEN kq := kq || '|thu_muc_nguoi_khac=chan';
  END;
  -- Hàm app_private gọi trực tiếp phải ở ngoài SET ROLE (schema không cấp USAGE
  -- cho authenticated; trong policy nó chạy được vì gọi theo OID).
  EXECUTE 'RESET ROLE';
  kq := kq || '|chu_doc_object=' || app_private.residence_doc_object_can_read_v1('residence-docs', chu_cty::text || '/ct01/gate-rls.webp');
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.residence_dossier_files SET deleted_at = now() WHERE object_name = chu_cty::text || '/ct01/gate-rls.webp';
    GET DIAGNOSTICS n = ROW_COUNT; kq := kq || '|chu_xoa_mem=' || n;
  EXCEPTION WHEN insufficient_privilege THEN kq := kq || '|chu_xoa_mem=chan';
  END;
  EXECUTE 'RESET ROLE';
  -- Ảnh đã xoá mềm thì không còn đọc được nội dung, dù dòng metadata vẫn tra được.
  kq := kq || '|object_sau_xoa=' || app_private.residence_doc_object_can_read_v1('residence-docs', chu_cty::text || '/ct01/gate-rls.webp');

  -- Vai 2: người của tổ chức khác — không thấy dòng, không ghi được, không đọc được object.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', nguoi_ngoai, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', nguoi_ngoai::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.residence_dossier_files WHERE object_name = chu_cty::text || '/ct01/gate-rls.webp';
  kq := kq || '|ngoai_doc=' || n;
  BEGIN
    INSERT INTO public.residence_dossier_files (organization_id, building_id, customer_id, kind, object_name)
    VALUES (org, toa, khach, 'CT01', nguoi_ngoai::text || '/ct01/gate-rls.webp');
    kq := kq || '|ngoai_ghi=cho_qua';
  EXCEPTION WHEN insufficient_privilege THEN kq := kq || '|ngoai_ghi=chan';
  END;
  EXECUTE 'RESET ROLE';
  kq := kq || '|ngoai_doc_object=' || app_private.residence_doc_object_can_read_v1('residence-docs', chu_cty::text || '/ct01/gate-rls.webp');

  -- Vai 3: super admin — thấy dòng org thật, nhưng org sandbox phải khuất.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', sieu_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', sieu_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.residence_dossier_files WHERE object_name = chu_cty::text || '/ct01/gate-rls.webp';
  kq := kq || '|super_doc=' || n;
  EXECUTE 'RESET ROLE';
  kq := kq || '|super_doc_sandbox=' || app_private.residence_dossier_can_read_v1(toa_sandbox, '${ORG_SANDBOX}');
  kq := kq || '|super_ghi_sandbox=' || app_private.residence_dossier_can_write_v1('OWNERSHIP', toa_sandbox, '${ORG_SANDBOX}', NULL, NULL);
  INSERT INTO ket_qua_rls VALUES (kq);
END $ktra$;
SELECT kq FROM ket_qua_rls;
ROLLBACK;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const body = await res.text();
if (!res.ok) {
  console.error('KHÔNG ĐO ĐƯỢC: truy vấn lỗi.');
  console.error(body.slice(0, 700));
  process.exit(3);
}
let rows = null;
try { rows = JSON.parse(body); } catch { /* không phải JSON */ }
const raw = Array.isArray(rows) && rows.length === 1 && typeof rows[0]?.kq === 'string' ? rows[0].kq : null;
if (!raw) {
  console.error('KHÔNG ĐO ĐƯỢC: truy vấn không trả về đúng một dòng kết quả.');
  console.error(body.slice(0, 700));
  process.exit(3);
}
const facts = Object.fromEntries(raw.split('|').filter(Boolean).map((p) => p.split('=')));
if (facts.thieu_fixture) {
  console.error('KHÔNG ĐO ĐƯỢC: thiếu fixture (toà có chủ sở hữu pháp lý, khách đang thuê, thành viên tổ chức khác).');
  process.exit(3);
}

const mongDoi = {
  chu_doc: '1',                    // người có quyền đọc lại đúng dòng mình vừa ghi
  thu_muc_nguoi_khac: 'chan',      // object_name phải nằm trong thư mục của chính mình
  chu_doc_object: 'true',          // object đọc được khi dòng bảng đọc được
  chu_xoa_mem: '1',                // xoá mềm không bị chính policy SELECT chặn (án lệ 42501)
  object_sau_xoa: 'false',         // ảnh đã xoá mềm thì nội dung không đọc được nữa
  ngoai_doc: '0',                  // tổ chức khác không thấy dòng
  ngoai_ghi: 'chan',               // tổ chức khác không ghi được vào toà này
  ngoai_doc_object: 'false',       // tổ chức khác không đọc được object
  super_doc: '1',                  // super admin vẫn thấy dữ liệu tổ chức thật
  super_doc_sandbox: 'false',      // nhưng tổ chức sandbox phải khuất
  super_ghi_sandbox: 'false',
};
const cases = Object.entries(mongDoi);
const sai = cases.filter(([k, v]) => facts[k] !== v);
console.log('Ca RLS residence_dossier_files:');
for (const [k, v] of cases) console.log(`  ${facts[k] === v ? '✔' : '✘'} ${k}: ${facts[k]} (mong đợi ${v})`);
if (sai.length) {
  console.error(`\n❌ ${sai.length}/${cases.length} ca RLS sai — ảnh giấy tờ cư trú có thể lộ hoặc không xoá được.`);
  process.exit(1);
}
console.log(`\n✅ Cả ${cases.length} ca đều đúng (mọi thao tác đã ROLLBACK).`);
