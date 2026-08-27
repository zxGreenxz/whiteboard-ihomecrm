#!/usr/bin/env node
// Fixture DEMO cho chu trình hoàn cọc E2E (.e2e-fleet/specs/termination-refund-full-cycle.spec.ts).
//
// VÌ SAO PHẢI SEED: đo 28/08/2026, org DEMO có 0 hồ sơ thanh lý với số hoàn dương
// — mọi hồ sơ đều "khách còn nợ" hoặc hoàn 0đ, nên nút "Tạo phiếu hoàn" luôn vô
// hiệu và nhánh GHI của E2E không bao giờ chạy. Điều kiện §17.6 (chạy trót lọt
// một ca thanh lý → nghĩa vụ → phiếu hoàn trên DEMO trước khi khoá đường cũ) vì
// thế không đo được nếu thiếu fixture này.
//
// FIXTURE GỒM HAI NỬA, vì trang /reports/real-estate/terminations liệt kê HỢP
// ĐỒNG TERMINATED/EXPIRED chứ không phải hồ sơ thanh lý:
//   1. một hợp đồng DEMO đang ACTIVE được chuyển TERMINATED (dọn xong trả về
//      ACTIVE — vì thế seed CHỈ chọn hợp đồng ACTIVE, để cleanup xác định);
//   2. một hồ sơ contract_terminations COMPLETED, hoàn 2.000.000đ, mang MARKER.
//
//   node scripts/seed-demo-hoan-coc.mjs --seed   # tạo, in contract number cho spec
//   node scripts/seed-demo-hoan-coc.mjs --don    # dọn phiếu + nghĩa vụ + hồ sơ + trả HĐ về ACTIVE
//   node scripts/seed-demo-hoan-coc.mjs --xem    # xem trạng thái fixture
//
// CHỈ ghi vào org DEMO (dddd…0001) — mọi câu SQL đều neo cứng org id. Idempotent:
// seed lần hai khi fixture còn sống chỉ in lại thông tin.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORG_DEMO = "dddd0000-0000-4000-8000-000000000001";
const REF = "tryymsxyyckgbrmmvozx";
const MARKER = "[E2E-FIXTURE hoan-coc — scripts/seed-demo-hoan-coc.mjs]";

function pat() {
  if (process.env.SUPABASE_PAT) return process.env.SUPABASE_PAT;
  try {
    const m = readFileSync(join(repoRoot, "CLAUDE.local.md"), "utf8").match(/sbp_[a-f0-9]+/);
    if (m) return m[0];
  } catch { /* rơi xuống lỗi bên dưới */ }
  throw new Error("Thiếu SUPABASE_PAT (env) và không đọc được CLAUDE.local.md");
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function xem() {
  return sql(`
    SELECT t.id AS termination_id, t.status AS t_status, t.refund_amount::bigint AS hoan,
           c.contract_number, c.status AS c_status,
           (SELECT count(*) FROM termination_refund_obligations o WHERE o.termination_id = t.id) AS nghia_vu,
           (SELECT count(*) FROM income_expenses ie
             WHERE ie.contract_id = t.contract_id AND ie.system_source = 'termination.refund'
               AND ie.deleted_at IS NULL AND ie.approval_status <> 'CANCELLED') AS phieu_song
      FROM contract_terminations t
      JOIN contracts c ON c.id = t.contract_id
     WHERE t.organization_id = '${ORG_DEMO}' AND t.notes LIKE '%${MARKER}%'`);
}

async function seed() {
  const song = await xem();
  if (song.length > 0) {
    console.log("Fixture đã tồn tại — không tạo thêm:");
    console.log(JSON.stringify(song, null, 2));
    return;
  }
  const rows = await sql(`
    WITH hd AS (
      SELECT c.id, c.contract_number, c.user_id
        FROM contracts c
       WHERE c.organization_id = '${ORG_DEMO}' AND c.room_id IS NOT NULL
         AND c.deleted_at IS NULL AND c.status = 'ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM contract_terminations t WHERE t.contract_id = c.id)
       LIMIT 1
    ),
    doi_hd AS (
      UPDATE contracts c SET status = 'TERMINATED', actual_end_date = CURRENT_DATE
        FROM hd WHERE c.id = hd.id RETURNING c.id
    )
    INSERT INTO contract_terminations
      (user_id, organization_id, contract_id, actual_move_out_date,
       termination_type, total_deposit, refund_method, status, notes)
    SELECT hd.user_id, '${ORG_DEMO}', hd.id, CURRENT_DATE,
           'NORMAL', 2000000, 'TM', 'COMPLETED',
           'Hồ sơ dựng cho E2E chu trình hoàn cọc. HĐ gốc đang ACTIVE, cleanup sẽ trả về ACTIVE. ${MARKER}'
      FROM hd
    RETURNING id,
      (SELECT contract_number FROM contracts WHERE id = contract_id) AS contract_number,
      refund_amount::bigint AS hoan`);
  if (rows.length === 0) throw new Error("DEMO không còn hợp đồng ACTIVE nào chưa thanh lý — không seed được");
  console.log("✅ Đã seed fixture (HĐ → TERMINATED, hồ sơ COMPLETED hoàn 2.000.000đ, chưa có cọc thật):");
  console.log(JSON.stringify(rows, null, 2));
  console.log(
    `\nChạy spec:\n  cd .e2e-fleet && FLEET_FIXTURE_CONTRACT='${rows[0].contract_number}' ` +
    `FLEET_PASS_CHUNHA=... npx playwright test specs/termination-refund-full-cycle.spec.ts`,
  );
}

async function don() {
  // Thứ tự: items → nghĩa vụ → phiếu → hồ sơ → trả hợp đồng về ACTIVE. Chỉ đụng
  // hàng treo dưới hồ sơ mang MARKER; mọi vị ngữ đều neo org DEMO. Không bao giờ
  // xoá phiếu đã POSTED — fixture không thể tạo ra phiếu POSTED (phiếu ra CHỜ
  // DUYỆT), nên nếu thấy POSTED nghĩa là ai đó đã duyệt tay: để lại và báo.
  const out = await sql(`
    WITH ho_so AS (
      SELECT id, contract_id FROM contract_terminations
       WHERE organization_id = '${ORG_DEMO}' AND notes LIKE '%${MARKER}%'
    ),
    phieu AS (
      SELECT ie.id FROM income_expenses ie
       WHERE ie.organization_id = '${ORG_DEMO}'
         AND ie.system_source = 'termination.refund'
         AND ie.contract_id IN (SELECT contract_id FROM ho_so)
         AND ie.posting_status IS DISTINCT FROM 'POSTED'
    ),
    d_items AS (
      DELETE FROM income_expense_items WHERE income_expense_id IN (SELECT id FROM phieu) RETURNING 1
    ),
    d_ob AS (
      DELETE FROM termination_refund_obligations
       WHERE organization_id = '${ORG_DEMO}' AND termination_id IN (SELECT id FROM ho_so) RETURNING 1
    ),
    d_phieu AS (
      DELETE FROM income_expenses WHERE id IN (SELECT id FROM phieu) RETURNING 1
    ),
    d_ho_so AS (
      DELETE FROM contract_terminations WHERE id IN (SELECT id FROM ho_so) RETURNING 1
    ),
    hoi_hd AS (
      UPDATE contracts SET status = 'ACTIVE', actual_end_date = NULL
       WHERE id IN (SELECT contract_id FROM ho_so) AND status = 'TERMINATED'
       RETURNING 1
    )
    SELECT (SELECT count(*) FROM d_ho_so) AS ho_so,
           (SELECT count(*) FROM d_ob) AS nghia_vu,
           (SELECT count(*) FROM d_phieu) AS phieu,
           (SELECT count(*) FROM d_items) AS items,
           (SELECT count(*) FROM hoi_hd) AS hd_ve_active`);
  console.log("✅ Đã dọn fixture:", JSON.stringify(out[0]));
  const conPosted = await sql(`
    SELECT ie.code FROM income_expenses ie
     WHERE ie.organization_id = '${ORG_DEMO}' AND ie.system_source = 'termination.refund'
       AND ie.posting_status = 'POSTED' AND ie.notes LIKE '%${MARKER}%'`);
  if (conPosted.length > 0) {
    console.log(`⚠ ${conPosted.length} phiếu fixture đã bị duyệt+POSTED — KHÔNG xoá, xử lý tay:`,
      conPosted.map((r) => r.code).join(", "));
  }
}

const mode = process.argv[2];
if (mode === "--seed") await seed();
else if (mode === "--don") await don();
else if (mode === "--xem") console.log(JSON.stringify(await xem(), null, 2));
else {
  console.log("Dùng: node scripts/seed-demo-hoan-coc.mjs --seed | --don | --xem");
  process.exit(1);
}
