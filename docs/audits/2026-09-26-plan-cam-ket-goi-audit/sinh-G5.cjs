// Sinh migration G5 (nối writer vào cổng bộ máy chi) từ thân hàm SỐNG trên production.
// CHỈ ĐỌC production. Mỗi chỗ sửa phải khớp ĐÚNG MỘT lần, không thì dừng. Ghi bằng Node, LF.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const pg = require('pg');
const REPO = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const OUT = path.join(REPO, 'supabase/migrations/20260926160000_noi_writer_vao_bo_may_chi.sql');
function pw() { const t = fs.readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8'); return t.match(/Persistent database password[^`]*`([^`]+)`/)[1]; }
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
function thay(ten, s, cu, moi) {
  const n = s.split(cu).length - 1;
  if (n !== 1) throw new Error(ten + ': chuoi can thay xuat hien ' + n + ' lan (phai dung 1):\n' + cu.slice(0, 200));
  return s.replace(cu, moi);
}

const HAM = {
  create: { sig: 'public.create_income_expense_v1(text,text,uuid,uuid,uuid,uuid,text,text,text,uuid,jsonb,boolean,text,date,jsonb,text)', md5: '7cc6fa873d8e063187ddb82a66702259', dau: 'ie_spend_gate_v1' },
  period: { sig: 'public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)', md5: '6545b554ba8732eb4362b95fbcd040e4', dau: 'ie_spend_gate_v1' },
  util:   { sig: 'public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)', md5: 'b6a36737c5fc1aeadf759f89aee552ee', dau: 'ie_spend_gate_v1' },
  special:{ sig: 'public.generate_special_fees_v1(text,uuid[],text,uuid)', md5: '6238a35926d7a960d03291557d30f8e9', dau: 'ie_spend_gate_v1' },
  recur:  { sig: 'public.generate_recurring_vouchers(uuid)', md5: 'e8b6f1e9632ed2c6e94666cf09935a88', dau: 'ie_spend_gate_v1' },
  resolve:{ sig: 'public.resolve_fixed_expense_type(uuid,text)', md5: 'e6c68ad3c2c98bfe93c4ff0b357ea16e', dau: 'fee_category = p_category_key' },
};

(async () => {
  const c = new pg.Client({ host: 'aws-1-ap-southeast-1.pooler.supabase.com', port: 5432, database: 'postgres',
    user: 'postgres.tryymsxyyckgbrmmvozx', password: pw(), ssl: { rejectUnauthorized: false } });
  await c.connect(); await c.query('BEGIN READ ONLY');
  const def = {};
  for (const [k, h] of Object.entries(HAM)) {
    const r = await c.query(`select pg_get_functiondef(to_regprocedure($1)) d`, [h.sig]);
    def[k] = r.rows[0].d;
    const m = md5(def[k]);
    if (m !== h.md5) throw new Error(k + ': md5 song ' + m + ' khac ban da ra ' + h.md5 + ' — dung lai, ra lai');
  }
  await c.query('ROLLBACK'); await c.end();

  // ---------------- create_income_expense_v1 ----------------
  let s = def.create;
  s = thay('create/declare', s, '  v_maker_can_approve boolean := false;\n',
    '  v_maker_can_approve boolean := false;\n  v_spend_gate jsonb;  -- G5 26/09/2026: cổng bộ máy chi\n');
  s = thay('create/gate', s, "  IF v_birth_status = 'APPROVED' THEN\n    v_birth_by := v_actor; v_birth_at := now();",
`  -- G5 (26/09/2026): hỏi bộ máy chi — một luật cho mọi cửa chi, đọc luật khai trên hạng mục.
  -- Chỉ ÁP khi cờ spend.engine.v1 = ON và mọi bucket của phiếu đã bật; còn lại giữ thang trên.
  IF p_type = 'EXPENSE' THEN
    v_spend_gate := app_private.ie_spend_gate_v1(
      v_org, p_building_id, 'EXPENSE', 'create_income_expense_v1', NULL, p_account_id,
      p_voucher_date,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'type_id', it->>'income_expense_type_id',
                'amount', COALESCE(NULLIF(it->>'quantity', '')::numeric, 0)
                          * COALESCE(NULLIF(it->>'unit_price', '')::numeric, 0),
                'start_date', it->>'start_date',
                'end_date', it->>'end_date')), '[]'::jsonb)
         FROM jsonb_array_elements(v_canonical_items) AS it));
    IF COALESCE((v_spend_gate->>'enforce')::boolean, false) THEN
      v_birth_status := v_spend_gate->>'status';
    END IF;
  END IF;

  IF v_birth_status = 'APPROVED' THEN
    v_birth_by := v_actor; v_birth_at := now();`);
  def.create = s;

  // ---------------- pay_period_fee ----------------
  s = def.period;
  s = thay('period/declare', s, '  v_posting  uuid;\n', '  v_posting  uuid;\n  v_spend_gate jsonb;  -- G5 26/09/2026: cổng bộ máy chi\n');
  s = thay('period/gate', s,
`  IF v_verdict IN ('VALID', 'CONFIG_REQUIRED') THEN
    v_posting := app_private.special_fee_approve_and_post_v1(v_voucher, 'SPECIAL_PAGE_FEE');
  END IF;`,
`  -- G5 (26/09/2026): hỏi bộ máy chi; phiếu đã có nên loại chính nó khỏi phần đã tiêu.
  -- Cổng chưa áp (cờ chưa ON / bucket chưa bật) ⇒ giữ nguyên luật SPECIAL_FEE_AUTOPOST_V1.
  v_spend_gate := app_private.ie_spend_gate_v1(
    v_org, p_building_id, 'EXPENSE', 'pay_period_fee', 'fixed_fee', v_acc, v_vdate,
    jsonb_build_array(jsonb_build_object('type_id', v_type, 'amount', p_amount,
                                         'start_date', v_p_start, 'end_date', v_p_end)),
    v_voucher);
  IF COALESCE((v_spend_gate->>'enforce')::boolean, false) THEN
    IF v_spend_gate->>'status' = 'APPROVED' THEN
      v_posting := app_private.special_fee_approve_and_post_v1(v_voucher, 'SPECIAL_PAGE_FEE');
    END IF;
  ELSIF v_verdict IN ('VALID', 'CONFIG_REQUIRED') THEN
    v_posting := app_private.special_fee_approve_and_post_v1(v_voucher, 'SPECIAL_PAGE_FEE');
  END IF;`);
  s = thay('period/return', s, "    'rule', v_rule,\n", "    'rule', v_rule,\n    'spend_decision', v_spend_gate - 'facts',\n");
  s = thay('period/note', s, "    'status_note', CASE\n      WHEN v_posting IS NOT NULL AND v_verdict = 'VALID'",
`    'status_note', CASE
      WHEN COALESCE((v_spend_gate->>'enforce')::boolean, false)
        THEN 'Bộ máy chi: ' || app_private.spend_reason_vi_v1(v_spend_gate->>'reason')
             || CASE WHEN v_posting IS NOT NULL THEN ' — phiếu đã duyệt và vào sổ.'
                     ELSE ' — phiếu đã tạo và đang CHỜ DUYỆT.' END
      WHEN v_posting IS NOT NULL AND v_verdict = 'VALID'`);
  def.period = s;

  // ---------------- pay_utility_bill ----------------
  s = def.util;
  s = thay('util/declare', s, '  v_appr_at timestamptz;\n', '  v_appr_at timestamptz;\n  v_spend_gate jsonb;   -- G5 26/09/2026: cổng bộ máy chi\n');
  s = thay('util/gate', s, "  UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;\n",
`  UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;
  -- G5 (26/09/2026): hỏi bộ máy chi (kiểu TRẦN của hạng mục điện/nước). Cổng chưa áp ⇒ giữ
  -- nguyên thang ngưỡng + trần ở trên. Không đụng khối INSERT mẫu neo bên dưới.
  v_spend_gate := app_private.ie_spend_gate_v1(
    v_org, p_building_id, 'EXPENSE', 'pay_utility_bill', 'utility.bill', v_acc,
    COALESCE(p_voucher_date, public.org_today_v1(NULL)),
    jsonb_build_array(jsonb_build_object('type_id', v_type, 'amount', p_amount,
                                         'start_date', v_p_start, 'end_date', v_p_end)));
  IF COALESCE((v_spend_gate->>'enforce')::boolean, false) THEN
    IF v_spend_gate->>'status' = 'APPROVED' THEN
      v_status := 'APPROVED'; v_appr_by := auth.uid(); v_appr_at := now();
    ELSE
      v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
    END IF;
  END IF;
`);
  s = thay('util/return', s, "    'ceilingVerdict', v_ceiling_verdict);", "    'ceilingVerdict', v_ceiling_verdict,\n    'spendDecision', v_spend_gate - 'facts');");
  def.util = s;

  // ---------------- generate_special_fees_v1 ----------------
  s = def.special;
  s = thay('special/declare', s, '  v_rule     jsonb;\n', '  v_rule     jsonb;\n  v_spend_gate jsonb;  -- G5 26/09/2026: cổng bộ máy chi\n');
  s = thay('special/type', s,
`    v_type := app_private.ensure_income_expense_type_v1(
                v_org, v_actor, v_label, 'expense', NULL, NULL, false, false,
                (r.fee_category = 'quan_ly'), false, false, false);`,
`    -- G5 (26/09/2026): dùng hạng mục đã ánh xạ (G3) cho khoá phí — luật chi đọc trên chính
    -- hạng mục đó; khoá chưa ánh xạ mới rơi về tìm/tạo theo tên như cũ.
    SELECT t.id INTO v_type FROM public.income_expense_types t
     WHERE t.organization_id = v_org AND t.fee_category = r.fee_category;
    IF v_type IS NULL THEN
      v_type := app_private.ensure_income_expense_type_v1(
                  v_org, v_actor, v_label, 'expense', NULL, NULL, false, false,
                  (r.fee_category = 'quan_ly'), false, false, false);
    END IF;`);
  s = thay('special/gate', s,
`      IF (v_rule->>'verdict') IN ('VALID', 'CONFIG_REQUIRED') THEN
        PERFORM app_private.special_fee_approve_and_post_v1(v_ie, 'SPECIAL_PAGE_FEE');
        v_posted := v_posted + 1;
      END IF;`,
`      -- G5 (26/09/2026): hỏi bộ máy chi; cổng chưa áp ⇒ giữ luật SPECIAL_FEE_AUTOPOST_V1.
      v_spend_gate := app_private.ie_spend_gate_v1(
        v_org, r.building_id, 'EXPENSE', 'generate_special_fees_v1', 'special_fee.v1', v_acc,
        public.org_today_v1(v_org),
        jsonb_build_array(jsonb_build_object('type_id', v_type, 'amount', r.amount,
                                             'start_date', v_m0, 'end_date', v_m1)),
        v_ie);
      IF COALESCE((v_spend_gate->>'enforce')::boolean, false) THEN
        IF v_spend_gate->>'status' = 'APPROVED' THEN
          PERFORM app_private.special_fee_approve_and_post_v1(v_ie, 'SPECIAL_PAGE_FEE');
          v_posted := v_posted + 1;
        END IF;
      ELSIF (v_rule->>'verdict') IN ('VALID', 'CONFIG_REQUIRED') THEN
        PERFORM app_private.special_fee_approve_and_post_v1(v_ie, 'SPECIAL_PAGE_FEE');
        v_posted := v_posted + 1;
      END IF;`);
  def.special = s;

  // ---------------- generate_recurring_vouchers ----------------
  s = def.recur;
  s = thay('recur/declare', s, '  v_total  int;\n', '  v_total  int;\n  v_status text;   -- G5 26/09/2026\n  v_gate   jsonb;  -- G5 26/09/2026: cổng bộ máy chi\n');
  s = thay('recur/gate', s,
`        BEGIN
          INSERT INTO income_expenses (`,
`        BEGIN
          -- G5 (26/09/2026): phiếu con định kỳ cũng hỏi bộ máy chi. Cổng chưa áp ⇒ y như cũ
          -- (theo repeat_auto_approve của phiếu cha).
          v_status := CASE WHEN parent.repeat_auto_approve THEN 'APPROVED' ELSE 'UNAPPROVED' END;
          IF parent.type = 'EXPENSE' AND parent.organization_id IS NOT NULL THEN
            v_gate := app_private.ie_spend_gate_v1(
              parent.organization_id, parent.building_id, 'EXPENSE', 'generate_recurring_vouchers', NULL,
              CASE WHEN parent.repeat_auto_approve THEN parent.account_id ELSE NULL END,
              v_target,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'type_id', ii.income_expense_type_id,
                        'amount', ii.quantity * ii.unit_price,
                        'start_date', v_target, 'end_date', v_target)), '[]'::jsonb)
                 FROM income_expense_items ii WHERE ii.income_expense_id = parent.id),
              NULL,
              jsonb_build_object('recurring_auto_approve', parent.repeat_auto_approve));
            IF COALESCE((v_gate->>'enforce')::boolean, false) THEN
              v_status := v_gate->>'status';
            END IF;
          END IF;
          INSERT INTO income_expenses (`);
  s = thay('recur/status', s,
`            CASE WHEN parent.repeat_auto_approve THEN 'APPROVED' ELSE 'UNAPPROVED' END,
            CASE WHEN parent.repeat_auto_approve THEN now() ELSE NULL END,
            CASE WHEN parent.repeat_auto_approve THEN parent.user_id ELSE NULL END,`,
`            v_status,
            CASE WHEN v_status = 'APPROVED' THEN now() ELSE NULL END,
            CASE WHEN v_status = 'APPROVED' THEN parent.user_id ELSE NULL END,`);
  def.recur = s;

  // ---------------- resolve_fixed_expense_type ----------------
  s = def.resolve;
  s = thay('resolve/map', s, '  v_organization_id := app_private.resolve_ie_type_org_for_user_v1(p_owner);\n',
`  v_organization_id := app_private.resolve_ie_type_org_for_user_v1(p_owner);

  -- G5 (26/09/2026): hạng mục đã ánh xạ (G3, duy nhất theo org) là nguồn đúng cho khoá phí —
  -- luật chi đọc trên chính hạng mục đó. Khớp theo tên bên dưới chỉ còn là đường lùi.
  SELECT type_row.id
    INTO v_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_organization_id
    AND type_row.fee_category = p_category_key
    AND lower(btrim(type_row.type)) = 'expense';
  IF v_type IS NOT NULL THEN
    RETURN v_type;
  END IF;
`);
  def.resolve = s;

  // ---------------- ghép migration ----------------
  const ghim = Object.entries(HAM).map(([k, h]) =>
    `    ('${h.sig}', '${h.md5}', '${h.dau.replace(/'/g, "''")}')`).join(',\n');
  const body = (k) => def[k].replace(/\r\n/g, '\n').trimEnd() + ';\n';
  const sql = `-- =============================================================================
-- noi_writer_vao_bo_may_chi — G5 của plan "cỗ máy chi theo cam kết" (26/09/2026)
-- =============================================================================
-- VÌ SAO
--   Mỗi cửa chi đang tự quyết phiếu sinh ra đã duyệt hay chờ theo luật chép riêng. G2 đã có
--   MỘT bộ máy (app_private.ie_spend_decide_v1) + cổng (ie_spend_gate_v1). Bước này cho 5 cửa
--   chi HỎI cổng ở đúng chỗ chúng ra quyết định:
--     create_income_expense_v1   (phiếu tay ở trang Thu chi)
--     pay_period_fee             (trang Thanh toán — phí cố định)
--     pay_utility_bill           (trang Thanh toán — điện nước)
--     generate_special_fees_v1   (sinh phí cố định hàng loạt)
--     generate_recurring_vouchers(cron phiếu định kỳ 01:00)
--   Không nối: create_income_expense_v2 và ie_compat_insert_v2 — luôn sinh CHỜ DUYỆT, không
--   tự duyệt nên không có gì để áp; sổ tiêu + bóng vẫn phủ chúng qua trigger (G4).
--
-- LUẬT ÁP
--   Cổng trả enforce=true CHỈ khi cờ spend.engine.v1 = ON và MỌI bucket (toà × hạng mục × tháng)
--   của phiếu đã bật trong spend_policy_switches. Hôm nay cờ SHADOW, 0 công tắc ⇒ enforce luôn
--   false ⇒ 5 cửa đi y như trước. Cổng vẫn khoá bucket và ghi writer cho sổ bóng.
--
-- HẠNG MỤC CHO KHOÁ PHÍ (plan §5 mục 3)
--   pay_period_fee (qua resolve_fixed_expense_type) và generate_special_fees_v1 dùng hạng mục
--   ĐÃ ÁNH XẠ (G3) trước, khớp tên chỉ còn là đường lùi — để luật chi đọc đúng hạng mục. Đo
--   26/09: cả 9 hạng mục ánh xạ đều được fee_type_matches nhận ⇒ lưới Thanh toán không đổi.
--
-- KHÔNG ĐỤNG
--   Chữ ký hàm, quyền, idempotency, kiểm trùng kỳ, khối INSERT mẫu neo của pay_utility_bill,
--   luật huỷ phí (Đ5), phiếu THU.
--
-- ĐƯỜNG LÙI
--   Không cần gỡ: để cờ spend.engine.v1 khác ON (hoặc tắt công tắc) là 5 cửa đi luật cũ.
--   Gỡ hẳn: khôi phục thân hàm từ bản backup trước áp.
--
-- Sinh tự động bởi docs/audits/2026-09-26-plan-cam-ket-goi-audit/sinh-G5.cjs từ thân hàm sống
-- (md5 ghim bên dưới). Chạy được hai lượt và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

-- 0. Nền + ghim md5 thân hàm sẽ thay (lượt hai: thân đã mang dấu G5 ⇒ cho qua).
DO $truoc$
DECLARE
  v_ham record;
  v_def text;
BEGIN
  IF to_regprocedure('app_private.ie_spend_gate_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.ie_spend_gate_v1 — chạy bo_may_chi_so_tieu_va_quyet_dinh_bong trước'
      USING ERRCODE = '55000';
  END IF;
  FOR v_ham IN
    SELECT * FROM (VALUES
${ghim}
    ) AS t(chu_ky, md5_hop_le, dau_g5)
  LOOP
    v_def := pg_get_functiondef(to_regprocedure(v_ham.chu_ky));
    IF v_def IS NOT NULL AND md5(v_def) <> v_ham.md5_hop_le
       AND position(v_ham.dau_g5 in v_def) = 0 THEN
      RAISE EXCEPTION '% đã đổi so với bản đã rà — chụp lại pg_get_functiondef rồi rà lại', v_ham.chu_ky
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$truoc$;

-- 1. Lý do của bộ máy, tiếng Việt, cho ghi chú trả về người bấm.
CREATE OR REPLACE FUNCTION app_private.spend_reason_vi_v1(p_reason text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE p_reason
    WHEN 'WITHIN_COMMITMENT'     THEN 'trong cam kết đã ký của tháng'
    WHEN 'OVER_COMMITMENT'       THEN 'vượt phần cam kết còn lại của tháng'
    WHEN 'NO_COMMITMENT'         THEN 'tháng này chưa ký cam kết cho hạng mục'
    WHEN 'UNDER_CEILING'         THEN 'dưới trần đã công bố'
    WHEN 'OVER_CEILING'          THEN 'vượt trần đã công bố'
    WHEN 'NO_CEILING'            THEN 'chưa khai trần cho hạng mục'
    WHEN 'NO_CASHBOOK'           THEN 'phiếu chi chưa gắn sổ quỹ thật'
    WHEN 'NO_CASHBOOK_RIGHT'     THEN 'người lập không giữ sổ này để chi'
    WHEN 'SELF_APPROVER'         THEN 'tự duyệt — người lập có quyền duyệt'
    WHEN 'FORCE_APPROVAL'        THEN 'hạng mục bắt buộc duyệt'
    WHEN 'OVER_THRESHOLD'        THEN 'từ ngưỡng tự duyệt trở lên'
    WHEN 'UNDER_THRESHOLD'       THEN 'dưới ngưỡng tự duyệt'
    WHEN 'RECURRING_PREAPPROVED' THEN 'phiếu định kỳ chủ đã cho tự duyệt'
    WHEN 'SYSTEM_BALANCED'       THEN 'nguồn hệ thống tự cân đối'
    WHEN 'INCOME_POLICY'         THEN 'phiếu thu'
    WHEN 'ENGINE_ERROR'          THEN 'bộ máy chi gặp lỗi — chờ duyệt cho an toàn'
    ELSE COALESCE(p_reason, 'không rõ') END;
$fn$;
REVOKE ALL ON FUNCTION app_private.spend_reason_vi_v1(text) FROM PUBLIC, anon, authenticated, service_role;

-- 2. Sổ bóng phải ghi ĐÚNG quyết định cổng đưa ra lúc sinh (thử TEST 26/09 bắt được: tính lại lúc
--    COMMIT thì phiếu sinh sau trong cùng transaction — cron định kỳ, sinh phí hàng loạt — làm
--    phiếu sinh trước bị chấm "vượt" oan, và tên writer bị writer gọi sau đè).
--    Cổng G2 đổi tên thành lõi; hàm bọc cùng chữ ký chốt kết quả cho từng phiếu:
--      cổng gọi SAU khi chèn phiếu (p_exclude_voucher)  ⇒ gắn thẳng vào phiếu đó;
--      cổng gọi TRƯỚC khi chèn                          ⇒ trigger z59 gắn vào phiếu chèn ngay sau.
DO $doi_ten$
BEGIN
  IF to_regprocedure('app_private.ie_spend_gate_core_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb)') IS NULL THEN
    IF md5(pg_get_functiondef(to_regprocedure(
         'app_private.ie_spend_gate_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb)')))
       <> 'c0fc31df0a3cf7a83fe56594000426f5' THEN
      RAISE EXCEPTION 'ie_spend_gate_v1 đã đổi so với bản G2 đã rà — chụp lại rồi rà lại' USING ERRCODE = '55000';
    END IF;
    ALTER FUNCTION app_private.ie_spend_gate_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb)
      RENAME TO ie_spend_gate_core_v1;
  END IF;
END
$doi_ten$;

CREATE OR REPLACE FUNCTION app_private.ie_spend_gate_v1(
  p_org             uuid,
  p_building        uuid,
  p_direction       text,
  p_writer          text,
  p_system_source   text,
  p_account         uuid,
  p_voucher_date    date,
  p_lines           jsonb,
  p_exclude_voucher uuid  DEFAULT NULL,
  p_context         jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_kq jsonb;
BEGIN
  v_kq := app_private.ie_spend_gate_core_v1(p_org, p_building, p_direction, p_writer, p_system_source,
            p_account, p_voucher_date, p_lines, p_exclude_voucher, p_context);
  BEGIN
    IF p_exclude_voucher IS NOT NULL THEN
      PERFORM set_config('app.spend_gate_of_' || replace(p_exclude_voucher::text, '-', ''),
                         (v_kq || jsonb_build_object('writer', p_writer))::text, true);
    ELSE
      PERFORM set_config('app.spend_gate_last',
                         (v_kq || jsonb_build_object('writer', p_writer))::text, true);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;   -- chốt vết cho sổ bóng không bao giờ được làm hỏng writer
  END;
  RETURN v_kq;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.ie_spend_gate_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.ie_spend_gate_core_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.spend_capture_gate_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_last text;
BEGIN
  v_last := NULLIF(current_setting('app.spend_gate_last', true), '');
  IF v_last IS NOT NULL THEN
    PERFORM set_config('app.spend_gate_of_' || replace(NEW.id::text, '-', ''), v_last, true);
    PERFORM set_config('app.spend_gate_last', '', true);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.spend_capture_gate_trg() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS z59_spend_capture_gate ON public.income_expenses;
CREATE TRIGGER z59_spend_capture_gate
  AFTER INSERT ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.spend_capture_gate_trg();

DO $ghim_bong$
DECLARE
  v_def text := pg_get_functiondef('app_private.spend_shadow_birth_trg()'::regprocedure);
BEGIN
  IF md5(v_def) <> '93188ef659cb9ebcd3e31b0e816f0134' AND position('spend_gate_of_' in v_def) = 0 THEN
    RAISE EXCEPTION 'spend_shadow_birth_trg đã đổi so với bản G2 đã rà — chụp lại rồi rà lại' USING ERRCODE = '55000';
  END IF;
END
$ghim_bong$;

CREATE OR REPLACE FUNCTION app_private.spend_shadow_birth_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_ie       record;
  v_route    text;
  v_writer   text;
  v_parent   boolean;
  v_facts    jsonb;
  v_dec      jsonb;
  v_enforced boolean;
  v_cap      jsonb;
BEGIN
  BEGIN
    SELECT e.* INTO v_ie FROM public.income_expenses e WHERE e.id = NEW.id;
    IF NOT FOUND OR v_ie.organization_id IS NULL THEN
      RETURN NULL;
    END IF;
    v_route := app_private.spend_route_v1(v_ie.organization_id);
    IF v_route = 'LEGACY' THEN
      RETURN NULL;
    END IF;

    -- kết quả cổng đã chốt cho phiếu này lúc sinh (writer đã nối)
    v_cap := NULLIF(current_setting('app.spend_gate_of_' || replace(v_ie.id::text, '-', ''), true), '')::jsonb;
    IF v_cap IS NOT NULL AND v_cap->>'status' IS NOT NULL AND jsonb_typeof(v_cap->'facts') = 'object' THEN
      v_writer   := app_private.spend_writer_of_v1(v_ie.system_source, v_ie.repeat_parent_id, v_cap->>'writer');
      v_facts    := v_cap->'facts';
      v_dec      := v_cap - 'facts' - 'enforce' - 'route' - 'writer';
      v_enforced := COALESCE((v_cap->>'enforce')::boolean, false);
      v_route    := COALESCE(v_cap->>'route', v_route);
    ELSE
      -- phiếu không qua cổng (compat, v2, writer hệ thống): tính tại COMMIT
      v_writer := app_private.spend_writer_of_v1(v_ie.system_source, v_ie.repeat_parent_id, v_cap->>'writer');
      IF v_ie.repeat_parent_id IS NOT NULL THEN
        SELECT p.repeat_auto_approve INTO v_parent
          FROM public.income_expenses p WHERE p.id = v_ie.repeat_parent_id;
      END IF;
      v_facts := app_private.ie_spend_facts_v1(
                   v_ie.organization_id, v_ie.building_id, v_ie.type, v_writer,
                   v_ie.system_source, v_ie.account_id, v_ie.voucher_date,
                   app_private.spend_lines_of_voucher_v1(v_ie.id), v_ie.id, false,
                   jsonb_build_object('recurring_auto_approve', COALESCE(v_parent, false)));
      v_dec := app_private.ie_spend_decide_v1(v_facts);
      v_enforced := false;
    END IF;

    INSERT INTO app_private.spend_decisions
      (organization_id, income_expense_id, building_id, direction, writer, route, enforced,
       birth_status, engine_status, engine_reason, match, amount, facts, decision, actor_id)
    VALUES
      (v_ie.organization_id, v_ie.id, v_ie.building_id, v_ie.type, v_writer, v_route, v_enforced,
       v_ie.approval_status, v_dec->>'status', v_dec->>'reason',
       v_ie.approval_status = v_dec->>'status', v_ie.total_amount, v_facts, v_dec, auth.uid())
    ON CONFLICT (income_expense_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO app_private.spend_engine_errors
      (context, organization_id, income_expense_id, sqlstate, message)
    VALUES ('shadow_birth', NEW.organization_id, NEW.id, SQLSTATE, SQLERRM);
  END;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.spend_shadow_birth_trg() FROM PUBLIC, anon, authenticated, service_role;

-- 3. resolve_fixed_expense_type — hạng mục đã ánh xạ trước.
${body('resolve')}
-- 4. create_income_expense_v1 — phiếu tay trang Thu chi.
${body('create')}
-- 5. pay_period_fee — trang Thanh toán, phí cố định.
${body('period')}
-- 6. pay_utility_bill — trang Thanh toán, điện nước.
${body('util')}
-- 7. generate_special_fees_v1 — sinh phí cố định hàng loạt.
${body('special')}
-- 8. generate_recurring_vouchers — cron phiếu định kỳ.
${body('recur')}
-- 9. Tự kiểm: 5 cửa đều gọi cổng; mẫu neo pay_utility_bill còn nguyên; ACL không nới.
DO $sau$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    '${HAM.create.sig}',
    '${HAM.period.sig}',
    '${HAM.util.sig}',
    '${HAM.special.sig}',
    '${HAM.recur.sig}'] LOOP
    IF position('app_private.ie_spend_gate_v1(' in pg_get_functiondef(to_regprocedure(v_sig))) = 0 THEN
      RAISE EXCEPTION '% chưa gọi cổng bộ máy chi', v_sig USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF position('fee_category = p_category_key' in pg_get_functiondef(to_regprocedure('${HAM.resolve.sig}'))) = 0 THEN
    RAISE EXCEPTION 'resolve_fixed_expense_type chưa ưu tiên hạng mục đã ánh xạ' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'z59_spend_capture_gate' AND NOT tgisinternal)
     OR to_regprocedure('app_private.ie_spend_gate_core_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu trigger z59_spend_capture_gate hoặc hàm lõi cổng' USING ERRCODE = '55000';
  END IF;
  IF position('HAI DÒNG DƯỚI LÀ MẪU NEO' in pg_get_functiondef(to_regprocedure('${HAM.util.sig}'))) = 0 THEN
    RAISE EXCEPTION 'pay_utility_bill mất mẫu neo 20260724120000' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', '${HAM.create.sig}', 'EXECUTE')
     OR has_function_privilege('anon', '${HAM.period.sig}', 'EXECUTE')
     OR has_function_privilege('anon', '${HAM.util.sig}', 'EXECUTE')
     OR has_function_privilege('anon', '${HAM.special.sig}', 'EXECUTE')
     OR has_function_privilege('authenticated', '${HAM.recur.sig}', 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL writer bị nới sau khi thay thân hàm' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;
`;
  fs.writeFileSync(OUT, sql, { encoding: 'utf8' });
  console.log('da ghi ' + OUT + ' (' + sql.length + ' ky tu)');
  for (const k of Object.keys(HAM)) console.log('  ' + k.padEnd(8) + ' md5 moi ' + md5(def[k]));
})().catch((e) => { console.error('THAT BAI:', e.message); process.exit(1); });
