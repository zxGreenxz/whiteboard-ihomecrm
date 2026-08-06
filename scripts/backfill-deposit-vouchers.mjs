// Backfill phiếu thu cọc đầu kỳ cho nhóm hợp đồng import 26/04/2026.
//
// BỐI CẢNH: 208 hợp đồng ACTIVE nhập ngày 26/04/2026 mang con số `deposit_paid`
// gõ tay, KHÔNG có phiếu cọc nào. Vì `recompute_contract_deposit_paid` chỉ ghi đè
// khi hợp đồng CÓ ít nhất 1 dòng cọc, các hợp đồng này đang ở "chế độ nhập tay":
// con số đứng yên, và sẽ bị XOÁ SẠCH bởi phiếu cọc đầu tiên gắn vào.
//
// Script này tạo cho mỗi hợp đồng đúng 1 phiếu thu cọc, số tiền = ĐÚNG
// `deposit_paid` hiện tại, đặt trên SỔ ẢO "CỌC (giữ hộ khách)" nên KHÔNG sinh
// dòng sổ quỹ nào (finance_v2_auto_posting_bridge bail-out khi is_virtual).
// Kết quả: hợp đồng chuyển sang chế độ tính-từ-phiếu mà con số không đổi.
//
// AN TOÀN: bước --apply chạy trong MỘT transaction, tự đối chiếu từng hợp đồng
// sau khi ghi; lệch dù 1 đồng ở 1 hợp đồng => RAISE => rollback toàn bộ.
//
// Dùng:
//   node scripts/backfill-deposit-vouchers.mjs             # chạy thử, không ghi
//   node scripts/backfill-deposit-vouchers.mjs --rehearse  # ghi thật 1 HĐ rồi rollback
//   node scripts/backfill-deposit-vouchers.mjs --apply     # ghi thật, tự verify

import { readFileSync, writeFileSync } from 'node:fs';

const MODE = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--rehearse')
    ? 'rehearse'
    : 'dry';

// ── Tham số đã chốt với chủ (28/07/2026) ────────────────────────────────────
const IMPORT_DATE = '2026-04-26';                                   // ngày import = ngày ghi phiếu
const ACCOUNT_ID  = '332adceb-ef65-4abc-8320-f12dd3f876dc';         // CỌC (giữ hộ khách) — is_virtual
const TYPE_ID     = 'c053bbcd-37ae-4986-92d4-008a5223baf7';         // "Tiền Cọc" — is_deposit = true
const ORG_ID      = 'aaaa0000-0000-4000-8000-000000000001';
const OWNER_ID    = '90450d5f-29b6-4897-bdef-cdb5fb53f339';
const MARKER      = '[BACKFILL CỌC ĐẦU KỲ 26/04/2026]';

let pat = process.env.SUPABASE_PAT;
if (!pat) {
  try {
    const local = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
    const m = local.match(/sbp_[a-f0-9]+/);
    if (m) pat = m[0];
  } catch { /* ignore */ }
}
if (!pat) { console.error('Không tìm thấy PAT'); process.exit(1); }

const REF = 'tryymsxyyckgbrmmvozx';

async function sql(query, { allowError = false } = {}) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.text();
  if (!res.ok) {
    if (allowError) return { error: body };
    console.error('FAILED', res.status, body.slice(0, 3000));
    process.exit(1);
  }
  return { rows: JSON.parse(body) };
}

const vnd = (n) => Number(n).toLocaleString('vi-VN') + 'đ';

// ── Vị từ chọn đối tượng ────────────────────────────────────────────────────
// Ba tầng AN TOÀN. Bất biến chung: sau khi ghi phiếu, `deposit_paid` của hợp
// đồng đó phải KHÔNG ĐỔI. Mọi hình dạng khác bị loại ra để rà tay.
//
//   T1_ACTIVE  ACTIVE, chưa có dòng cọc nào, deposit_paid > 0
//              → số tiền = deposit_paid.  Tổng thành +X ⇒ dp = X (không đổi).
//   T2_TERM_B  Đã thanh lý, chưa có dòng cọc nào, deposit_paid > 0
//              → số tiền = deposit_paid.  Tương tự T1.
//   T3_TERM_A  Đã thanh lý, CHỈ có vế chi (thu_vao = 0), dp đã về 0,
//              và KHÔNG còn phiếu hoàn chờ duyệt
//              → số tiền = chi_ra.  Tổng thành 0 ⇒ dp = GREATEST(0,0) = 0 (không đổi).
//
// Ngày phiếu: 26/04, nhưng nếu hợp đồng đã có phiếu cọc sớm hơn thì lùi về
// trước phiếu đó 1 ngày, để vế thu không nằm sau vế chi.
const BASE_CTE = `
  base AS (
    SELECT c.id, c.contract_number, c.status, c.deposit_paid, c.total_deposit,
           c.room_id, r.building_id, b.name AS building, r.name AS room_number,
           COALESCE(SUM(CASE WHEN e.type='INCOME'
                        THEN COALESCE(it.amount, it.unit_price*it.quantity) ELSE 0 END), 0) AS thu_vao,
           COALESCE(SUM(CASE WHEN e.type='EXPENSE'
                        THEN COALESCE(it.amount, it.unit_price*it.quantity) ELSE 0 END), 0) AS chi_ra,
           COUNT(it.id) AS so_muc,
           MIN(e.voucher_date) AS phieu_coc_som_nhat,
           (SELECT count(*) FROM income_expenses e2
              WHERE e2.contract_id = c.id AND e2.deleted_at IS NULL
                AND e2.approval_status = 'UNAPPROVED'
                AND e2.system_source = 'termination.refund') AS refund_cho_duyet
    FROM contracts c
    LEFT JOIN rooms r ON r.id = c.room_id
    LEFT JOIN buildings b ON b.id = r.building_id
    LEFT JOIN income_expenses e
      ON e.contract_id = c.id AND e.deleted_at IS NULL AND e.approval_status = 'APPROVED'
    LEFT JOIN income_expense_items it
      ON it.income_expense_id = e.id AND it.accounting_class = 'DEPOSIT'
    WHERE c.deleted_at IS NULL AND date(c.created_at) = '${IMPORT_DATE}'
    GROUP BY c.id, c.contract_number, c.status, c.deposit_paid, c.total_deposit,
             c.room_id, r.building_id, b.name, r.name
  ),
  target AS (
    SELECT b.*,
      CASE WHEN b.status = 'ACTIVE' THEN 'T1_ACTIVE'
           WHEN b.so_muc = 0        THEN 'T2_TERM_B'
           ELSE                          'T3_TERM_A' END AS tang,
      CASE WHEN b.so_muc = 0 THEN b.deposit_paid ELSE b.chi_ra END AS so_tien,
      LEAST(DATE '${IMPORT_DATE}',
            COALESCE(b.phieu_coc_som_nhat - 1, DATE '${IMPORT_DATE}')) AS ngay_phieu
    FROM base b
    WHERE
      -- T1 + T2: chưa có dòng cọc nào, còn mang số cọc nhập tay
      (b.so_muc = 0 AND COALESCE(b.deposit_paid, 0) > 0)
      -- T3: đã thanh lý, chỉ có vế chi, dp đã về 0, không vướng phiếu hoàn chờ duyệt
      OR (b.status <> 'ACTIVE' AND b.thu_vao = 0 AND b.chi_ra > 0
          AND COALESCE(b.deposit_paid, 0) = 0 AND b.refund_cho_duyet = 0)
  )`;
const TARGET_CTE = BASE_CTE;

// ═══════════════════════════ 1. CHẠY THỬ ═══════════════════════════════════
async function dryRun() {
  const { rows } = await sql(`
    WITH ${TARGET_CTE}
    SELECT id, contract_number, status, tang, so_tien, ngay_phieu,
           deposit_paid, total_deposit, thu_vao, chi_ra, building, room_number
    FROM target ORDER BY tang, building NULLS FIRST, contract_number;
  `);

  console.log('═'.repeat(78));
  console.log('CHẠY THỬ — KHÔNG GHI GÌ VÀO DATABASE');
  console.log('═'.repeat(78));
  console.log(`Sổ ghi phiếu : CỌC (giữ hộ khách) — sổ ẢO, không sinh dòng sổ quỹ`);
  console.log(`Loại phiếu   : "Tiền Cọc" (is_deposit = true)`);
  console.log('');

  const TIER_LABEL = {
    T1_ACTIVE: 'HĐ đang hiệu lực, chưa có phiếu cọc',
    T2_TERM_B: 'HĐ đã thanh lý, chưa có phiếu cọc nào',
    T3_TERM_A: 'HĐ đã thanh lý, thiếu vế THU (đang âm sổ)',
  };
  const total = rows.reduce((s, r) => s + Number(r.so_tien), 0);
  console.log(`Số phiếu sẽ tạo : ${rows.length}`);
  console.log(`Tổng tiền cọc   : ${vnd(total)}`);
  console.log('');
  console.log('Theo tầng:');
  for (const t of ['T1_ACTIVE', 'T2_TERM_B', 'T3_TERM_A']) {
    const g = rows.filter(r => r.tang === t);
    if (!g.length) continue;
    const s = g.reduce((a, r) => a + Number(r.so_tien), 0);
    console.log(`  ${t}  ${String(g.length).padStart(4)} HĐ  ${vnd(s).padStart(18)}   ${TIER_LABEL[t]}`);
  }
  console.log('');

  const byBuilding = {};
  for (const r of rows) {
    const k = r.building || '(chưa gán toà)';
    byBuilding[k] = byBuilding[k] || { n: 0, sum: 0 };
    byBuilding[k].n += 1;
    byBuilding[k].sum += Number(r.so_tien);
  }
  console.log('Theo toà nhà:');
  for (const [b, v] of Object.entries(byBuilding).sort((a, c) => c[1].sum - a[1].sum)) {
    console.log(`  ${String(v.n).padStart(4)} HĐ  ${vnd(v.sum).padStart(18)}   ${b}`);
  }
  console.log('');
  await reportExcluded();

  // Cảnh báo: HĐ có total_deposit = 0 -> bẫy "bỏ cọc ra 0đ" vẫn còn nguyên
  const zeroTotal = rows.filter(r => Number(r.total_deposit) === 0);
  if (zeroTotal.length) {
    console.log('⚠️  CẢNH BÁO — các HĐ dưới đây có ô "cọc theo hợp đồng" = 0.');
    console.log('   Backfill KHÔNG sửa ô đó. Bấm "bỏ cọc" các HĐ này vẫn ra 0đ doanh thu.');
    console.log('   (Chủ đã quyết định 28/07: khỏi sửa.)');
    for (const r of zeroTotal) {
      console.log(`   - ${r.contract_number}  cọc đã thu ${vnd(r.deposit_paid)}  ${r.building || ''}`);
    }
    console.log('');
  }

  console.log('20 dòng đầu:');
  for (const r of rows.slice(0, 20)) {
    console.log(`  ${r.tang}  ${r.contract_number.padEnd(24)} ${vnd(r.so_tien).padStart(16)}  ${r.ngay_phieu}  ${r.building || ''} ${r.room_number || ''}`);
  }
  if (rows.length > 20) console.log(`  … và ${rows.length - 20} dòng nữa`);

  writeFileSync(
    new URL('../scripts/.backfill-deposit-plan.json', import.meta.url),
    JSON.stringify({ generated_for: IMPORT_DATE, count: rows.length, total, rows }, null, 1),
    'utf8',
  );
  console.log('');
  console.log('Đã ghi kế hoạch chi tiết ra scripts/.backfill-deposit-plan.json (mốc đối chiếu).');
  console.log('');
  await safetyChecks();
}

// ── Các hợp đồng CỐ Ý loại ra: phải rà tay, không backfill máy móc ─────────
async function reportExcluded() {
  const { rows } = await sql(`
    WITH ${TARGET_CTE}
    SELECT b.contract_number, b.deposit_paid, b.thu_vao, b.chi_ra,
           (b.thu_vao - b.chi_ra) AS tong_chua_clamp, b.refund_cho_duyet,
           CASE
             WHEN b.refund_cho_duyet > 0
               THEN 'Còn phiếu hoàn CHỜ DUYỆT — backfill giờ sẽ âm lại khi duyệt'
             WHEN b.thu_vao > 0 AND b.chi_ra > b.thu_vao
               THEN 'Nhả ra NHIỀU HƠN đã thu — thêm vế thu là bịa chứng từ'
             WHEN b.thu_vao = 0 AND b.chi_ra > 0 AND COALESCE(b.deposit_paid,0) > 0
               THEN 'Backfill sẽ LÀM ĐỔI deposit_paid — vi phạm bất biến'
             ELSE 'Đã cân bằng, không cần làm gì'
           END AS ly_do
    FROM base b
    WHERE b.id NOT IN (SELECT id FROM target)
      AND (COALESCE(b.deposit_paid,0) > 0 OR b.chi_ra > 0)
    ORDER BY (b.thu_vao - b.chi_ra);
  `);
  const canRa = rows.filter(r => !r.ly_do.startsWith('Đã cân bằng'));
  if (!canRa.length) return;
  const tongAm = canRa.reduce((s, r) => s + Math.min(0, Number(r.tong_chua_clamp)), 0);
  console.log('⚠️  LOẠI RA ĐỂ RÀ TAY — ' + canRa.length + ' hợp đồng, còn ' + vnd(tongAm) + ' số âm chưa xử lý:');
  for (const r of canRa) {
    console.log(`   ${r.contract_number.padEnd(24)} thu ${vnd(r.thu_vao).padStart(14)}  chi ${vnd(r.chi_ra).padStart(14)}  → ${r.ly_do}`);
  }
  console.log('');
}

// ── Kiểm tra an toàn: những thứ PHẢI đúng trước khi ghi ─────────────────────
async function safetyChecks() {
  const { rows } = await sql(`
    WITH ${TARGET_CTE}
    SELECT
      (SELECT count(*) FROM target) AS so_hd_muc_tieu,
      (SELECT count(*) FROM accounts WHERE id='${ACCOUNT_ID}' AND is_virtual = true AND deleted_at IS NULL) AS so_ao_hop_le,
      (SELECT count(*) FROM income_expense_types WHERE id='${TYPE_ID}' AND is_deposit = true) AS loai_hop_le,
      (SELECT count(*) FROM accounts WHERE lock_date IS NOT NULL) AS so_bi_khoa_ky,
      (SELECT count(*) FROM contracts c WHERE c.deleted_at IS NULL
         AND date(c.created_at)='${IMPORT_DATE}' AND c.status <> 'ACTIVE'
         AND COALESCE(c.deposit_paid,0) > 0) AS hd_da_thanh_ly_bi_loai,
      (SELECT count(*) FROM income_expenses WHERE notes LIKE '${MARKER}%' AND deleted_at IS NULL) AS phieu_backfill_da_ton_tai;
  `);
  const r = rows[0];
  const ok = (b) => (b ? '✅' : '❌');
  console.log('KIỂM TRA AN TOÀN');
  console.log(`  ${ok(r.so_ao_hop_le === 1)} Sổ đích tồn tại và là sổ ảo`);
  console.log(`  ${ok(r.loai_hop_le === 1)} Loại phiếu tồn tại và is_deposit = true`);
  console.log(`  ${ok(r.so_bi_khoa_ky === 0)} Không sổ nào bị khoá kỳ (lock_date) — ${r.so_bi_khoa_ky} sổ`);
  console.log(`  ${ok(r.phieu_backfill_da_ton_tai === 0)} Chưa từng chạy backfill này — ${r.phieu_backfill_da_ton_tai} phiếu`);
  console.log(`  ℹ️  Đã LOẠI ${r.hd_da_thanh_ly_bi_loai} hợp đồng không còn ACTIVE (đã thanh lý)`);
  console.log(`  ℹ️  Mục tiêu: ${r.so_hd_muc_tieu} hợp đồng`);
  if (r.phieu_backfill_da_ton_tai > 0) {
    console.log('');
    console.log('  ⛔ DỪNG: đã có phiếu mang dấu backfill này. Chạy lại sẽ nhân đôi cọc.');
  }
  return r;
}

// ── SQL ghi thật: dùng chung cho --rehearse và --apply ──────────────────────
// Tự đối chiếu BÊN TRONG transaction; lệch là RAISE => rollback tất cả.
function buildWriteSql({ limitOne = false, forceRollback = false }) {
  return `
DO $$
DECLARE
  rec        RECORD;
  v_ie       uuid;
  v_n        integer := 0;
  v_sum      numeric := 0;
  v_before   numeric;
  v_after    numeric;
  v_lech     integer := 0;
  v_report   text := '';
BEGIN
  FOR rec IN
    WITH ${TARGET_CTE}
    SELECT * FROM target ORDER BY contract_number ${limitOne ? 'LIMIT 1' : ''}
  LOOP
    v_before := rec.deposit_paid;

    INSERT INTO income_expenses (
      user_id, organization_id, type, name,
      building_id, room_id, contract_id, account_id,
      voucher_date, total_amount, approval_status,
      approved_by, approved_at, notes, system_source
    ) VALUES (
      '${OWNER_ID}', '${ORG_ID}', 'INCOME',
      'Thu cọc đầu kỳ — HĐ ' || COALESCE(rec.contract_number, rec.id::text),
      rec.building_id, rec.room_id, rec.id, '${ACCOUNT_ID}',
      rec.ngay_phieu, rec.so_tien, 'APPROVED',
      '${OWNER_ID}', now(),
      '${MARKER} [' || rec.tang || '] Hợp thức hoá tiền cọc khách đã đóng trước khi dùng phần mềm. '
        || 'Ghi trên sổ ảo CỌC (giữ hộ khách) — KHÔNG phải tiền vào két, không đụng sổ quỹ.',
      'contract.deposit'
    ) RETURNING id INTO v_ie;

    INSERT INTO income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, start_date, end_date
    ) VALUES (
      v_ie, '${TYPE_ID}', 'Tiền cọc đầu kỳ (khách đã đóng trước khi dùng phần mềm)',
      1, rec.so_tien, rec.ngay_phieu, rec.ngay_phieu
    );

    SELECT deposit_paid INTO v_after FROM contracts WHERE id = rec.id;

    IF v_after IS DISTINCT FROM v_before THEN
      v_lech := v_lech + 1;
      v_report := v_report || rec.contract_number || ': ' || v_before || ' -> ' || v_after || '; ';
    END IF;

    v_n := v_n + 1;
    v_sum := v_sum + rec.so_tien;
  END LOOP;

  IF v_lech > 0 THEN
    RAISE EXCEPTION 'HUY BO — % hop dong bi doi so cọc: %', v_lech, left(v_report, 900)
      USING ERRCODE = '55000';
  END IF;

  ${forceRollback
    ? `RAISE EXCEPTION 'DIEN_TAP_OK n=% sum=% lech=0 (da rollback, khong ghi gi)', v_n, v_sum USING ERRCODE = '55000';`
    : `RAISE NOTICE 'DA GHI % phieu, tong %', v_n, v_sum;`}
END $$;`;
}

// ═══════════════════════════ 2. DIỄN TẬP ═══════════════════════════════════
async function rehearse() {
  console.log('DIỄN TẬP — ghi thật TOÀN BỘ rồi ROLLBACK, không để lại gì.');
  console.log('Đây là phép thử đầy đủ: mọi hợp đồng đều được ghi và đối chiếu thật.\n');
  const { error } = await sql(buildWriteSql({ forceRollback: true }), { allowError: true });
  if (!error) {
    console.log('⚠️  Không nhận được tín hiệu rollback — kiểm tra lại script.');
    return;
  }
  const msg = (() => { try { return JSON.parse(error).message; } catch { return error; } })();
  if (msg.includes('DIEN_TAP_OK')) {
    console.log('✅ ĐƯỜNG GHI HOẠT ĐỘNG. Qua hết guard/trigger, số cọc KHÔNG đổi.');
    console.log('   ' + msg.split('\n')[0]);
    console.log('\n   Mọi thứ đã được rollback. Chạy --apply để ghi thật.');
  } else if (msg.includes('HUY BO')) {
    console.error('❌ SỐ CỌC BỊ ĐỔI khi ghi phiếu — KHÔNG được apply.');
    console.error('   ' + msg);
    // Trước đây hai nhánh ❌ dưới đây chỉ IN rồi kết thúc, nên script thoát 0 —
    // tức mã thoát của "diễn tập hỏng, ĐỪNG apply" giống hệt "diễn tập sạch".
    // Bất kỳ ai (hoặc script nào) đọc mã thoát đều hiểu là thành công.
    process.exitCode = 1;
  } else {
    console.error('❌ Bị chặn bởi guard hoặc lỗi khác:');
    console.error('   ' + msg);
    process.exitCode = 1;
  }
}

// ═══════════════════════════ 3. GHI THẬT ═══════════════════════════════════
async function apply() {
  const checks = await safetyChecks();
  if (checks.phieu_backfill_da_ton_tai > 0) {
    console.log('\n⛔ Dừng lại — backfill đã chạy rồi.');
    process.exit(1);
  }
  console.log('\nĐang ghi… (một transaction, tự đối chiếu, lệch là rollback toàn bộ)\n');
  const { error, rows } = await sql(buildWriteSql({}), { allowError: true });
  if (error) {
    const msg = (() => { try { return JSON.parse(error).message; } catch { return error; } })();
    console.log('❌ ĐÃ ROLLBACK — không ghi gì cả.');
    console.log('   ' + msg);
    process.exit(1);
  }
  console.log('✅ Đã ghi xong.', JSON.stringify(rows));
  console.log('\nĐối chiếu sau khi ghi:');
  const { rows: after } = await sql(`
    SELECT count(*) AS so_phieu, sum(total_amount) AS tong,
           (SELECT count(*) FROM contracts c WHERE c.deleted_at IS NULL
              AND date(c.created_at)='${IMPORT_DATE}' AND c.status='ACTIVE'
              AND COALESCE(c.deposit_paid,0) > 0
              AND NOT EXISTS (SELECT 1 FROM income_expenses e
                 JOIN income_expense_items it ON it.income_expense_id=e.id AND it.accounting_class='DEPOSIT'
                 WHERE e.contract_id=c.id AND e.deleted_at IS NULL)) AS con_lai_che_do_nhap_tay,
           (SELECT COALESCE(sum(pl.signed_amount),0) FROM income_expense_posting_lines pl
              JOIN accounts a ON a.id=pl.account_id WHERE a.is_virtual = false) AS tong_so_quy_that
    FROM income_expenses WHERE notes LIKE '${MARKER}%' AND deleted_at IS NULL;
  `);
  console.log(JSON.stringify(after[0], null, 1));
  console.log('\n→ "con_lai_che_do_nhap_tay" phải = 0');
  console.log('→ "tong_so_quy_that" phải KHÔNG đổi so với trước khi chạy');
}

if (MODE === 'dry') await dryRun();
else if (MODE === 'rehearse') await rehearse();
else await apply();
