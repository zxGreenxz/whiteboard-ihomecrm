-- =============================================================================
-- bo_may_chi_so_tieu_va_quyet_dinh_bong — G2 + G4 của plan "cỗ máy chi theo cam kết"
-- Ngày 26/09/2026 · chủ uỷ quyền "thực hiện tiếp toàn bộ rồi đưa lên production".
-- =============================================================================
-- MỘT BỘ MÁY
--   ie_spend_decide_v1(facts)  hàm THUẦN (IMMUTABLE) — luật duy nhất quyết phiếu chi
--                              sinh ra đã duyệt hay chờ, đọc luật khai TRÊN HẠNG MỤC
--                              (spend_mode của income_expense_types, G3).
--   ie_spend_facts_v1(...)     gom sự thật theo TỪNG DÒNG (§4.4): hạng mục → kiểu chi,
--                              kỳ áp dụng → tháng (câu 08c), cam kết + phần đã tiêu,
--                              trần điện nước, sổ quỹ, quyền người lập. Lấy khoá bucket
--                              TRƯỚC khi đọc số đã tiêu (§4.7).
--   ie_spend_gate_v1(...)      cổng cho writer (G5 sẽ nối). Chỉ ÁP quyết định khi cờ
--                              spend.engine.v1 = ON và MỌI bucket của phiếu đã bật
--                              trong spend_policy_switches. Chưa bật ⇒ writer giữ luật cũ.
--
-- SỔ TIÊU (G4) — áp cho MỌI writer, không sửa writer nào
--   Trigger trên income_expense_items (INSERT/UPDATE/DELETE) và income_expenses (đổi
--   trạng thái, xoá, toà, kỳ) gọi spend_ledger_sync_v1(phiếu): tính tập dòng tiêu MONG
--   MUỐN từ trạng thái hiện tại rồi đưa sổ về đúng tập đó — CHỜ ⇒ HOLD, ĐÃ DUYỆT ⇒ DRAW,
--   HUỶ/XOÁ/đổi bucket ⇒ RELEASE. Vì là "đồng bộ theo trạng thái" nên phủ luôn duyệt,
--   huỷ, khôi phục, sửa phiếu, cron định kỳ, compat — mọi đường ghi (C2 của audit).
--   Khoá advisory theo bucket (org:toà:hạng mục:tháng), thứ tự cố định.
--
-- BÓNG TẠI THỜI ĐIỂM SINH (G2, P4 của audit)
--   Constraint trigger DEFERRED trên income_expenses chạy lúc COMMIT của chính
--   transaction sinh phiếu: đủ dòng, đủ trạng thái cuối, sự thật đọc trong cùng
--   transaction ⇒ ghi spend_decisions (quyết định máy vs trạng thái thật + facts).
--   Không phải job đêm.
--
-- CÔNG TẮC
--   Cờ app_private.server_feature_flags 'spend.engine.v1' (MỚI, không dùng lại
--   posting.v2/workflow.v2): OFF ⇒ tắt hết · SHADOW ⇒ sổ tiêu + bóng, KHÔNG áp ·
--   ON ⇒ cổng áp ở bucket đã bật. Khởi tạo SHADOW.
--   Cờ 'spend.cashbook_chi.v1' (G6): SHADOW ⇒ chỉ ghi ca "người lập không giữ sổ để
--   chi"; ON ⇒ phiếu của 3 cửa Thanh toán rơi về CHỜ ở ca đó. Khởi tạo SHADOW.
--   Bảng spend_policy_switches: bật theo (org, hạng mục, toà|mọi toà, từ tháng→tới tháng).
--
-- LUẬT (§4.3 + 12 câu chủ chốt)
--   THU ⇒ ĐÃ DUYỆT (câu 07: không đụng phiếu thu) · B0 18 nguồn (câu 06) ⇒ ĐÃ DUYỆT ·
--   CHI không sổ thật ⇒ CHỜ · CAM_KET: mọi dòng trong phần còn lại ⇒ ĐÃ DUYỆT, vượt ⇒ CHỜ
--   (câu 10, kể cả người có quyền duyệt — cùng án lệ trần 28/08) · TRAN: dưới trần ⇒ ĐÃ
--   DUYỆT, vượt/không trần ⇒ CHỜ · TUNG_PHIEU: người lập có quyền duyệt ⇒ ĐÃ DUYỆT, ghi
--   dấu "SELF_APPROVER" (câu 05) · force_approval ⇒ CHỜ · ≥ ngưỡng (600k, câu 04) ⇒ CHỜ.
--   Phiếu chờ duyệt giữ chỗ (HOLD) — câu 09. Cam kết không tự nới — câu 10.
--
-- KHÔNG ĐỤNG
--   Không sửa writer, không đổi trạng thái phiếu nào, không đụng phiếu THU, sổ quỹ,
--   posting, hoá đơn, vùng thanh lý. Hành vi hệ thống KHÔNG ĐỔI cho tới khi bật cờ ON.
--
-- ĐƯỜNG LÙI
--   UPDATE app_private.server_feature_flags SET mode='OFF' WHERE feature_key='spend.engine.v1'
--   ⇒ trigger thành no-op ngay. Dọn sổ: DELETE FROM app_private.spend_commitment_draws;
--   (chỉ khi không bucket nào đang áp). Không xoá hàm (pg_cron job ma).
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Nền phải có + ghim md5 hàm sẽ thay.
DO $truoc$
DECLARE
  v_def text;
BEGIN
  IF to_regclass('app_private.spend_commitments') IS NULL
     OR to_regclass('app_private.spend_commitment_draws') IS NULL THEN
    RAISE EXCEPTION 'Thiếu sổ cam kết — chạy bang_cam_ket_chi trước' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'income_expense_types'
                    AND column_name = 'spend_mode') THEN
    RAISE EXCEPTION 'Thiếu cột spend_mode — chạy anh_xa_hang_muc_va_khoa_cot_luat trước'
      USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('app_private.utility_ceiling_check_v1(uuid,uuid,text,date,numeric,numeric)') IS NULL
     OR to_regprocedure('app_private.ie_maker_can_approve_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.evaluate_feature_route(text,uuid)') IS NULL
     OR to_regprocedure('app_private.ie_actor_is_company_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu hàm nền (utility_ceiling_check_v1 / ie_maker_can_approve_v1 / evaluate_feature_route / ie_actor_is_company_owner_v1)'
      USING ERRCODE = '55000';
  END IF;
  -- set_spend_commitment_v1 sẽ được thay (thêm khoá bucket + đồng bộ sổ tiêu). Ghim
  -- md5 bản G1 đã rà; lượt hai thân đã là bản mới (có spend_ledger_resync_bucket_v1).
  v_def := pg_get_functiondef(to_regprocedure(
             'public.set_spend_commitment_v1(uuid,text,date,numeric,text)'));
  IF v_def IS NOT NULL
     AND md5(v_def) <> ALL (ARRAY['c54b5592ca87d24a6cba39835aa7dbcf'])
     AND position('spend_ledger_resync_bucket_v1' in v_def) = 0 THEN
    RAISE EXCEPTION 'set_spend_commitment_v1 đã đổi so với bản G1 đã rà — chụp lại pg_get_functiondef rồi rà lại'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Hai cờ tuyến MỚI (không dùng lại cờ posting.v2 / workflow.v2).
INSERT INTO app_private.server_feature_flags
  (feature_key, domain, risk_class, mode, force_freeze, reason, approval_reference)
VALUES
  ('spend.engine.v1', 'thu_chi', 'MONEY', 'SHADOW', false,
   'Bộ máy chi theo cam kết: sổ tiêu + quyết định bóng lúc sinh; ON mới cho cổng áp quyết định ở bucket đã bật',
   'Chủ chốt 26/09/2026 — PLAN-CO-MAY-CHI-THEO-CAM-KET-2026-09-26 §10'),
  ('spend.cashbook_chi.v1', 'thu_chi', 'MONEY', 'SHADOW', false,
   'G6: quyền CHI trên sổ (chủ sổ / CUSTODIAN / OPERATOR) cho 3 cửa Thanh toán; SHADOW chỉ ghi ca lẽ ra bị chặn',
   'Chủ chốt 26/09/2026 — PLAN-CO-MAY-CHI-THEO-CAM-KET-2026-09-26 §6 G6')
ON CONFLICT (feature_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Sổ tiêu: xoá cứng phiếu/dòng phải kéo theo dòng tiêu (trước là RESTRICT ⇒ sửa
--    phiếu chờ duyệt xoá-dựng-lại dòng hạng mục sẽ bị chặn khi đã có dòng tiêu).
DO $fk$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname, a.attname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.conrelid = 'app_private.spend_commitment_draws'::regclass
       AND c.contype = 'f'
       AND c.confrelid IN ('public.income_expenses'::regclass, 'public.income_expense_items'::regclass)
       AND c.confdeltype <> 'c'
  LOOP
    EXECUTE format('ALTER TABLE app_private.spend_commitment_draws DROP CONSTRAINT %I', r.conname);
    IF r.attname = 'income_expense_id' THEN
      ALTER TABLE app_private.spend_commitment_draws
        ADD CONSTRAINT spend_commitment_draws_income_expense_id_fkey
        FOREIGN KEY (income_expense_id) REFERENCES public.income_expenses(id) ON DELETE CASCADE;
    ELSE
      ALTER TABLE app_private.spend_commitment_draws
        ADD CONSTRAINT spend_commitment_draws_income_expense_item_id_fkey
        FOREIGN KEY (income_expense_item_id) REFERENCES public.income_expense_items(id) ON DELETE CASCADE;
    END IF;
  END LOOP;
END
$fk$;

-- ---------------------------------------------------------------------------
-- 3. Bảng mới.
CREATE TABLE IF NOT EXISTS app_private.spend_policy_switches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  fee_category    text NOT NULL CHECK (fee_category IN
                    ('tien_nha','dien','nuoc','internet','quan_ly',
                     've_sinh','cong_an','rac','thang_may')),
  building_id     uuid REFERENCES public.buildings(id) ON DELETE RESTRICT,
  period_from     date NOT NULL CHECK (EXTRACT(DAY FROM period_from) = 1),
  period_to       date CHECK (period_to IS NULL OR (EXTRACT(DAY FROM period_to) = 1 AND period_to >= period_from)),
  note            text,
  enabled_by      uuid,
  enabled_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_by      uuid,
  retired_at      timestamptz
);
CREATE INDEX IF NOT EXISTS spend_policy_switches_tra
  ON app_private.spend_policy_switches (organization_id, fee_category)
  WHERE retired_at IS NULL;

COMMENT ON TABLE app_private.spend_policy_switches IS
  'Công tắc áp bộ máy chi theo bucket (org × hạng mục × toà|mọi toà × tháng). Chỉ có hiệu lực khi cờ spend.engine.v1 = ON. Chủ công ty / super admin bật qua set_spend_policy_switch_v1.';

CREATE TABLE IF NOT EXISTS app_private.spend_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  income_expense_id uuid NOT NULL,
  building_id       uuid,
  direction         text,
  writer            text NOT NULL,
  route             text NOT NULL,
  enforced          boolean NOT NULL DEFAULT false,
  birth_status      text NOT NULL,
  engine_status     text NOT NULL,
  engine_reason     text NOT NULL,
  match             boolean NOT NULL,
  amount            numeric(14,2),
  rule_version      integer NOT NULL DEFAULT 1,
  facts             jsonb NOT NULL,
  decision          jsonb NOT NULL,
  actor_id          uuid,
  decided_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS spend_decisions_mot_phieu
  ON app_private.spend_decisions (income_expense_id);
CREATE INDEX IF NOT EXISTS spend_decisions_org_luc
  ON app_private.spend_decisions (organization_id, decided_at);

COMMENT ON TABLE app_private.spend_decisions IS
  'Quyết định của bộ máy chi lúc SINH phiếu (chạy ở COMMIT của chính transaction sinh). birth_status = trạng thái thật cuối transaction; engine_status = máy quyết; enforced = máy có được áp không. Không FK tới phiếu để giữ vết khi phiếu bị xoá cứng.';

CREATE TABLE IF NOT EXISTS app_private.spend_engine_errors (
  id                bigserial PRIMARY KEY,
  at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  context           text NOT NULL,
  organization_id   uuid,
  income_expense_id uuid,
  sqlstate          text,
  message           text,
  detail            jsonb
);

REVOKE ALL ON app_private.spend_policy_switches, app_private.spend_decisions,
              app_private.spend_engine_errors
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app_private.spend_engine_errors_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Hàm nền.

-- 4.1 Tháng đầu của một ngày (IMMUTABLE, không qua timestamptz).
CREATE OR REPLACE FUNCTION app_private.spend_month_v1(p_day date)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE WHEN p_day IS NULL THEN NULL
              ELSE make_date(EXTRACT(YEAR FROM p_day)::int, EXTRACT(MONTH FROM p_day)::int, 1) END;
$fn$;

-- 4.2 Chia số tiền của một dòng theo tháng của kỳ áp dụng (câu 08c): chia đều theo
--     số tháng, phần lẻ dồn tháng cuối. Không có ngày bắt đầu ⇒ lấy ngày phiếu. Khoảng
--     > 24 tháng (bất thường) ⇒ không chia, ghi cả vào tháng đầu.
CREATE OR REPLACE FUNCTION app_private.spend_line_months_v1(
  p_start date, p_end date, p_fallback date, p_amount numeric)
RETURNS TABLE (period_month date, amount numeric)
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog', 'app_private'
AS $fn$
DECLARE
  v_from date;
  v_to   date;
  v_n    int;
  v_each numeric;
  i      int;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN;
  END IF;
  v_from := app_private.spend_month_v1(COALESCE(p_start, p_fallback));
  IF v_from IS NULL THEN
    RETURN;
  END IF;
  v_to := app_private.spend_month_v1(COALESCE(p_end, p_start, p_fallback));
  IF v_to IS NULL OR v_to < v_from THEN
    v_to := v_from;
  END IF;
  v_n := ((EXTRACT(YEAR FROM v_to) - EXTRACT(YEAR FROM v_from)) * 12
          + (EXTRACT(MONTH FROM v_to) - EXTRACT(MONTH FROM v_from)))::int + 1;
  IF v_n > 24 THEN
    period_month := v_from; amount := p_amount; RETURN NEXT;
    RETURN;
  END IF;
  v_each := floor(p_amount / v_n);
  FOR i IN 0 .. v_n - 1 LOOP
    period_month := (v_from + make_interval(months => i))::date;
    amount := CASE WHEN i = v_n - 1 THEN p_amount - v_each * (v_n - 1) ELSE v_each END;
    IF amount > 0 THEN
      RETURN NEXT;
    END IF;
  END LOOP;
END
$fn$;

-- 4.3 Khoá bucket theo thứ tự cố định (tránh deadlock) — §4.7.
CREATE OR REPLACE FUNCTION app_private.spend_lock_keys_v1(p_keys text[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  k text;
BEGIN
  FOR k IN SELECT DISTINCT x FROM unnest(p_keys) AS x WHERE x IS NOT NULL ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('spend:' || k, 0));
  END LOOP;
END
$fn$;

-- 4.4 Tuyến của bộ máy cho một org: LEGACY (tắt) · SHADOW · CANONICAL (ON) · FROZEN.
CREATE OR REPLACE FUNCTION app_private.spend_route_v1(p_org uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT app_private.evaluate_feature_route('spend.engine.v1', p_org);
$fn$;

-- 4.5 Ma trận B0 — 18 nguồn chủ đã duyệt (câu 06), theo (nguồn, chiều).
CREATE OR REPLACE FUNCTION app_private.spend_b0_source_v1(p_source text, p_direction text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT (p_source, p_direction) IN (
    -- A · thu tiền thật, có người bấm + chứng từ
    ('invoice.collection.v5',          'INCOME'),
    ('invoice.collection.reverse.v5',  'EXPENSE'),
    ('invoice.payment',                'INCOME'),
    ('contract.deposit',               'INCOME'),
    ('contract.create.v2',             'INCOME'),
    ('deposit.reservation',            'INCOME'),
    ('termination.extra_receipt',      'INCOME'),
    -- B · hai người đã xác nhận với nhau
    ('handover.transfer',              'EXPENSE'),
    ('handover.transfer',              'INCOME'),
    -- C · bút toán sổ theo dõi, không có tiền thật
    ('termination.offset',             'EXPENSE'),
    ('termination.revenue',            'INCOME'),
    ('termination.forfeit_offset',     'EXPENSE'),
    ('termination.forfeit_revenue',    'INCOME'),
    ('termination.rent_refund_offset', 'EXPENSE'),
    ('termination.rent_refund_revenue','INCOME'),
    ('adjustment.close_coc',           'EXPENSE'),
    ('adjustment.close_coc',           'INCOME'),
    -- D · đã qua một bước chốt riêng
    ('salary.staff',                   'EXPENSE'),
    ('reservation.refund',             'EXPENSE'),
    ('backfill.initial_deposit',       'INCOME'));
$fn$;

-- 4.6 Quyền CHI trên sổ (G6) — đúng luật lập phiếu chi của 25/09: chủ sổ, người giữ
--     (CUSTODIAN) hoặc vận hành (OPERATOR). Người chỉ BIẾT sổ (KNOWER) không chi.
CREATE OR REPLACE FUNCTION app_private.ie_spend_cashbook_ok_v1(p_org uuid, p_account uuid, p_actor uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  SELECT p_account IS NOT NULL AND p_actor IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.accounts a
             WHERE a.id = p_account AND a.user_id = p_actor AND a.deleted_at IS NULL)
    OR EXISTS (
      SELECT 1
        FROM public.cashbook_possession_bindings b
        JOIN public.organization_memberships m ON m.id = b.membership_id
       WHERE b.cashbook_id = p_account
         AND b.organization_id = p_org
         AND m.user_id = p_actor
         AND m.status = 'ACTIVE'
         AND b.valid_to IS NULL
         AND b.possession_kind IN ('CUSTODIAN', 'OPERATOR')));
$fn$;

-- 4.7 Bucket đã bật chưa.
CREATE OR REPLACE FUNCTION app_private.spend_switch_on_v1(
  p_org uuid, p_building uuid, p_fee_category text, p_month date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM app_private.spend_policy_switches s
     WHERE s.organization_id = p_org
       AND s.fee_category = p_fee_category
       AND s.retired_at IS NULL
       AND (s.building_id IS NULL OR s.building_id = p_building)
       AND s.period_from <= p_month
       AND (s.period_to IS NULL OR s.period_to >= p_month));
$fn$;

-- 4.8 Dòng hạng mục của một phiếu đã lưu, ở dạng facts nhận.
CREATE OR REPLACE FUNCTION app_private.spend_lines_of_voucher_v1(p_voucher uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'item_id', i.id,
           'type_id', i.income_expense_type_id,
           'amount', COALESCE(i.amount, i.quantity * i.unit_price),
           'start_date', i.start_date,
           'end_date', i.end_date) ORDER BY i.created_at, i.id), '[]'::jsonb)
    FROM public.income_expense_items i
   WHERE i.income_expense_id = p_voucher;
$fn$;

-- 4.9 Writer sinh ra phiếu (cho sổ bóng).
CREATE OR REPLACE FUNCTION app_private.spend_writer_of_v1(
  p_system_source text, p_repeat_parent uuid, p_declared text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE
    WHEN p_system_source = 'fixed_fee'      THEN 'pay_period_fee'
    WHEN p_system_source = 'utility.bill'   THEN 'pay_utility_bill'
    WHEN p_system_source = 'special_fee.v1' THEN 'generate_special_fees_v1'
    WHEN p_repeat_parent IS NOT NULL         THEN 'generate_recurring_vouchers'
    WHEN NULLIF(p_declared, '') IS NOT NULL  THEN p_declared
    WHEN p_system_source IS NOT NULL         THEN 'system:' || p_system_source
    ELSE 'manual'
  END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Sự thật theo dòng (§4.4) — lấy khoá bucket TRƯỚC khi đọc số đã tiêu (§4.7).
CREATE OR REPLACE FUNCTION app_private.ie_spend_facts_v1(
  p_org             uuid,
  p_building        uuid,
  p_direction       text,
  p_writer          text,
  p_system_source   text,
  p_account         uuid,
  p_voucher_date    date,
  p_lines           jsonb,
  p_exclude_voucher uuid    DEFAULT NULL,
  p_lock            boolean DEFAULT false,
  p_context         jsonb   DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor    uuid := auth.uid();
  v_ref      date := COALESCE(p_voucher_date, public.org_today_v1(p_org));
  v_line     jsonb;
  v_pass1    jsonb := '[]'::jsonb;
  v_lines    jsonb := '[]'::jsonb;
  v_keys     text[] := '{}';
  v_buckets  jsonb := '{}'::jsonb;
  v_tran_sum jsonb := '{}'::jsonb;
  v_tran_res jsonb := '{}'::jsonb;
  v_months   jsonb;
  v_m        jsonb;
  v_mo       jsonb;
  v_t        record;
  v_known    boolean;
  v_co_ck    boolean;
  v_c        record;
  v_used     numeric;
  v_amt      numeric;
  v_total    numeric := 0;
  v_i        int := 0;
  v_key      text;
  v_tkey     text;
  v_util     text;
  v_mon      date;
  r          record;
BEGIN
  -- lượt 1: hạng mục → kiểu chi, tháng, khoá bucket (chưa đọc số đã tiêu)
  FOR v_line IN SELECT value FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) LOOP
    v_i := v_i + 1;
    v_amt := COALESCE(NULLIF(v_line->>'amount', '')::numeric, 0);
    v_total := v_total + v_amt;
    SELECT t.id, t.fee_category, t.spend_mode, t.force_approval, t.is_deposit
      INTO v_t
      FROM public.income_expense_types t
     WHERE t.id = NULLIF(v_line->>'type_id', '')::uuid
       AND t.organization_id = p_org;
    v_known := FOUND;
    v_months := '[]'::jsonb;
    v_tkey := NULL;
    IF v_known AND v_t.spend_mode = 'CAM_KET' AND v_t.fee_category IS NOT NULL
       AND p_building IS NOT NULL THEN
      FOR r IN SELECT * FROM app_private.spend_line_months_v1(
                 NULLIF(v_line->>'start_date', '')::date,
                 NULLIF(v_line->>'end_date', '')::date, v_ref, v_amt) LOOP
        v_key := p_org || ':' || p_building || ':' || v_t.fee_category || ':'
                 || to_char(r.period_month, 'YYYY-MM');
        v_keys := v_keys || v_key;
        v_months := v_months || jsonb_build_array(jsonb_build_object(
          'month', r.period_month, 'amount', r.amount, 'bucket_key', v_key));
      END LOOP;
    ELSIF v_known AND v_t.spend_mode = 'TRAN' AND v_t.fee_category IN ('dien', 'nuoc')
          AND p_building IS NOT NULL THEN
      v_mon := app_private.spend_month_v1(COALESCE(NULLIF(v_line->>'start_date', '')::date, v_ref));
      v_tkey := v_t.fee_category || ':' || to_char(v_mon, 'YYYY-MM');
      v_tran_sum := v_tran_sum || jsonb_build_object(v_tkey,
        COALESCE((v_tran_sum->>v_tkey)::numeric, 0) + v_amt);
    END IF;
    v_pass1 := v_pass1 || jsonb_build_array(jsonb_build_object(
      'i', v_i,
      'item_id', v_line->'item_id',
      'type_id', v_line->'type_id',
      'type_known', v_known,
      'fee_category', CASE WHEN v_known THEN v_t.fee_category END,
      'spend_mode', CASE WHEN v_known THEN v_t.spend_mode ELSE 'TUNG_PHIEU' END,
      'force_approval', CASE WHEN v_known THEN COALESCE(v_t.force_approval, false) ELSE false END,
      'is_deposit', CASE WHEN v_known THEN COALESCE(v_t.is_deposit, false) ELSE false END,
      'amount', v_amt,
      'start_date', v_line->'start_date',
      'end_date', v_line->'end_date',
      'months', v_months,
      'tran_key', v_tkey));
  END LOOP;

  IF p_lock AND array_length(v_keys, 1) IS NOT NULL THEN
    PERFORM app_private.spend_lock_keys_v1(v_keys);
  END IF;

  -- trần điện nước: theo (hạng mục, tháng), tổng các dòng trong phiếu (trần mỗi phiếu — câu phụ)
  FOR v_tkey IN SELECT jsonb_object_keys(v_tran_sum) LOOP
    v_util := CASE split_part(v_tkey, ':', 1) WHEN 'dien' THEN 'ELECTRIC' ELSE 'WATER' END;
    v_mon := to_date(split_part(v_tkey, ':', 2) || '-01', 'YYYY-MM-DD');
    v_tran_res := v_tran_res || jsonb_build_object(v_tkey,
      app_private.utility_ceiling_check_v1(p_org, p_building, v_util, v_mon,
                                           (v_tran_sum->>v_tkey)::numeric)
      || jsonb_build_object(
           'utility', v_util, 'month', v_mon,
           'switch_on', app_private.spend_switch_on_v1(p_org, p_building, split_part(v_tkey, ':', 1), v_mon)));
  END LOOP;

  -- lượt 2: đọc cam kết + phần đã tiêu SAU khi có khoá
  FOR v_line IN SELECT value FROM jsonb_array_elements(v_pass1) LOOP
    v_months := '[]'::jsonb;
    FOR v_m IN SELECT value FROM jsonb_array_elements(v_line->'months') LOOP
      v_mon := (v_m->>'month')::date;
      SELECT c.id, c.amount INTO v_c
        FROM app_private.spend_commitments c
       WHERE c.organization_id = p_org AND c.building_id = p_building
         AND c.fee_category = v_line->>'fee_category'
         AND c.period_month = v_mon AND c.status = 'PUBLISHED';
      v_co_ck := FOUND;
      IF v_co_ck THEN
        SELECT COALESCE(sum(d.amount), 0) INTO v_used
          FROM app_private.spend_commitment_draws d
         WHERE d.commitment_id = v_c.id
           AND d.kind IN ('HOLD', 'DRAW')
           AND d.income_expense_id IS DISTINCT FROM p_exclude_voucher;
        v_buckets := v_buckets || jsonb_build_object(v_c.id::text, jsonb_build_object(
          'amount', v_c.amount, 'used_by_others', v_used, 'month', v_mon,
          'fee_category', v_line->>'fee_category', 'bucket_key', v_m->>'bucket_key'));
      END IF;
      v_mo := v_m || jsonb_build_object(
        'commitment_id', CASE WHEN v_co_ck THEN v_c.id END,
        'switch_on', app_private.spend_switch_on_v1(p_org, p_building, v_line->>'fee_category', v_mon));
      v_months := v_months || jsonb_build_array(v_mo);
    END LOOP;
    v_lines := v_lines || jsonb_build_array(
      (v_line - 'tran_key') || jsonb_build_object(
        'months', v_months,
        'tran', CASE WHEN v_line->>'tran_key' IS NOT NULL THEN v_tran_res->(v_line->>'tran_key') END));
  END LOOP;

  RETURN jsonb_build_object(
    'version', 1,
    'route', app_private.spend_route_v1(p_org),
    'organization_id', p_org,
    'building_id', p_building,
    'direction', p_direction,
    'writer', p_writer,
    'system_source', p_system_source,
    'b0', COALESCE(app_private.spend_b0_source_v1(p_system_source, p_direction), false),
    'account_id', p_account,
    'account_real', EXISTS (SELECT 1 FROM public.accounts a
                             WHERE a.id = p_account AND a.organization_id = p_org
                               AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual, false)),
    'actor', v_actor,
    'actor_can_approve', CASE WHEN v_actor IS NULL THEN false
                              ELSE COALESCE(app_private.ie_maker_can_approve_v1(p_building), false) END,
    'actor_cashbook_ok', CASE WHEN p_account IS NULL OR v_actor IS NULL THEN NULL
                              ELSE app_private.ie_spend_cashbook_ok_v1(p_org, p_account, v_actor) END,
    'cashbook_rule_on', app_private.evaluate_feature_route('spend.cashbook_chi.v1', p_org) = 'CANONICAL'
                        AND p_writer IN ('pay_period_fee', 'pay_utility_bill', 'generate_special_fees_v1'),
    'threshold', (SELECT c.threshold FROM app_private.ie_auto_approve_config c
                   WHERE c.organization_id = p_org),
    'total', v_total,
    'voucher_date', v_ref,
    'recurring_preapproved', COALESCE((p_context->>'recurring_auto_approve')::boolean, false),
    'lines', v_lines,
    'buckets', v_buckets);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Bộ máy quyết định — hàm THUẦN. Mọi luật chi nằm ở đây, một chỗ.
CREATE OR REPLACE FUNCTION app_private.ie_spend_decide_v1(p_facts jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_line      jsonb;
  v_m         jsonb;
  v_b         jsonb;
  v_used      jsonb := '{}'::jsonb;
  v_reasons   jsonb := '[]'::jsonb;
  v_hold      text;
  v_best      int := 99;
  v_rank      int;
  v_lr        text;
  v_amt       numeric;
  v_prev      numeric;
  v_avail     numeric;
  v_rule      boolean := false;
  v_tp        boolean := false;
  v_force     boolean := false;
  v_all_on    boolean := true;
  v_has_cam   boolean := false;
  v_status    text;
  v_reason    text;
BEGIN
  -- B3 / B0 — THU giữ nguyên hôm nay (câu 07); nguồn hệ thống tự cân đối (câu 06)
  IF p_facts->>'direction' = 'INCOME' THEN
    RETURN jsonb_build_object('status', 'APPROVED',
      'reason', CASE WHEN COALESCE((p_facts->>'b0')::boolean, false) THEN 'SYSTEM_BALANCED' ELSE 'INCOME_POLICY' END,
      'lines', '[]'::jsonb, 'rule_lines', false, 'all_switched', false, 'version', 1);
  END IF;
  IF COALESCE((p_facts->>'b0')::boolean, false) THEN
    RETURN jsonb_build_object('status', 'APPROVED', 'reason', 'SYSTEM_BALANCED',
      'lines', '[]'::jsonb, 'rule_lines', false, 'all_switched', false, 'version', 1);
  END IF;

  -- B1 — CHI không có sổ thật; hoặc (khi G6 bật) người lập không giữ sổ để chi
  IF NOT COALESCE((p_facts->>'account_real')::boolean, false) THEN
    v_hold := 'NO_CASHBOOK'; v_best := 1;
  ELSIF COALESCE((p_facts->>'cashbook_rule_on')::boolean, false)
        AND (p_facts->>'actor_cashbook_ok') = 'false' THEN
    v_hold := 'NO_CASHBOOK_RIGHT'; v_best := 1;
  END IF;

  -- từng dòng
  FOR v_line IN SELECT value FROM jsonb_array_elements(COALESCE(p_facts->'lines', '[]'::jsonb)) LOOP
    v_lr := NULL;
    IF v_line->>'spend_mode' = 'CAM_KET' AND jsonb_array_length(COALESCE(v_line->'months', '[]'::jsonb)) > 0 THEN
      v_rule := true; v_has_cam := true;
      v_lr := 'WITHIN_COMMITMENT';
      FOR v_m IN SELECT value FROM jsonb_array_elements(v_line->'months') LOOP
        IF NOT COALESCE((v_m->>'switch_on')::boolean, false) THEN
          v_all_on := false;
        END IF;
        IF v_m->>'commitment_id' IS NULL THEN
          IF v_lr = 'WITHIN_COMMITMENT' THEN v_lr := 'NO_COMMITMENT'; END IF;
        ELSE
          v_b := p_facts->'buckets'->(v_m->>'commitment_id');
          v_amt := (v_m->>'amount')::numeric;
          v_prev := COALESCE((v_used->>(v_m->>'commitment_id'))::numeric, 0);
          v_avail := (v_b->>'amount')::numeric - (v_b->>'used_by_others')::numeric - v_prev;
          v_used := v_used || jsonb_build_object(v_m->>'commitment_id', v_prev + v_amt);
          IF v_amt > v_avail THEN v_lr := 'OVER_COMMITMENT'; END IF;
        END IF;
      END LOOP;
    ELSIF v_line->>'spend_mode' = 'TRAN' AND v_line->'tran' IS NOT NULL
          AND jsonb_typeof(v_line->'tran') = 'object' THEN
      v_rule := true;
      IF NOT COALESCE((v_line->'tran'->>'switch_on')::boolean, false) THEN
        v_all_on := false;
      END IF;
      v_lr := CASE v_line->'tran'->>'verdict'
                WHEN 'WITHIN_LIMIT'   THEN 'UNDER_CEILING'
                WHEN 'WARN_NO_BILLED' THEN 'UNDER_CEILING'
                WHEN 'NO_RULE'        THEN 'NO_CEILING'
                ELSE 'OVER_CEILING' END;
    ELSE
      v_tp := true;
      IF COALESCE((v_line->>'force_approval')::boolean, false) THEN
        v_force := true;
      END IF;
      v_lr := 'TUNG_PHIEU';
    END IF;
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object('i', v_line->'i', 'reason', v_lr));
    v_rank := CASE v_lr WHEN 'OVER_COMMITMENT' THEN 2 WHEN 'NO_COMMITMENT' THEN 3
                        WHEN 'OVER_CEILING' THEN 4 WHEN 'NO_CEILING' THEN 5 ELSE 99 END;
    IF v_rank < v_best THEN
      v_best := v_rank; v_hold := v_lr;
    END IF;
  END LOOP;

  -- tổng hợp: một dòng CHỜ ⇒ cả phiếu CHỜ (§4.4)
  IF v_hold IS NOT NULL THEN
    v_status := 'UNAPPROVED'; v_reason := v_hold;
  ELSIF v_tp THEN
    IF COALESCE((p_facts->>'recurring_preapproved')::boolean, false) THEN
      v_status := 'APPROVED'; v_reason := 'RECURRING_PREAPPROVED';
    ELSIF COALESCE((p_facts->>'actor_can_approve')::boolean, false) THEN
      v_status := 'APPROVED'; v_reason := 'SELF_APPROVER';
    ELSIF v_force THEN
      v_status := 'UNAPPROVED'; v_reason := 'FORCE_APPROVAL';
    ELSIF p_facts->>'threshold' IS NOT NULL
          AND COALESCE((p_facts->>'total')::numeric, 0) >= (p_facts->>'threshold')::numeric THEN
      v_status := 'UNAPPROVED'; v_reason := 'OVER_THRESHOLD';
    ELSE
      v_status := 'APPROVED'; v_reason := 'UNDER_THRESHOLD';
    END IF;
  ELSIF v_rule THEN
    v_status := 'APPROVED';
    v_reason := CASE WHEN v_has_cam THEN 'WITHIN_COMMITMENT' ELSE 'UNDER_CEILING' END;
  ELSE
    v_status := 'UNAPPROVED'; v_reason := 'NO_LINES';
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'reason', v_reason,
    'lines', v_reasons,
    'rule_lines', v_rule,
    'all_switched', v_rule AND v_all_on,
    'version', 1);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Cổng cho writer (G5 sẽ nối). Luôn trả về; chỉ áp khi enforce = true.
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
  v_route   text;
  v_facts   jsonb;
  v_dec     jsonb;
  v_enforce boolean := false;
  v_co_luat boolean := false;
BEGIN
  v_route := app_private.spend_route_v1(p_org);
  IF v_route = 'LEGACY' THEN
    RETURN jsonb_build_object('enforce', false, 'route', v_route);
  END IF;
  PERFORM set_config('app.spend_writer', COALESCE(p_writer, ''), true);
  BEGIN
    v_facts := app_private.ie_spend_facts_v1(p_org, p_building, p_direction, p_writer,
                 p_system_source, p_account, p_voucher_date, p_lines, p_exclude_voucher,
                 true, p_context);
    v_dec := app_private.ie_spend_decide_v1(v_facts);
    v_enforce := v_route = 'CANONICAL' AND COALESCE((v_dec->>'all_switched')::boolean, false);
    IF COALESCE((v_facts->>'cashbook_rule_on')::boolean, false)
       AND (v_facts->>'actor_cashbook_ok') = 'false' THEN
      v_enforce := true;   -- G6: chỉ có thể làm CHẶT hơn (về CHỜ)
    END IF;
    RETURN v_dec || jsonb_build_object('enforce', v_enforce, 'route', v_route, 'facts', v_facts);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO app_private.spend_engine_errors
      (context, organization_id, sqlstate, message, detail)
    VALUES ('gate:' || COALESCE(p_writer, '?'), p_org, SQLSTATE, SQLERRM,
            jsonb_build_object('lines', p_lines));
    -- Đang áp (ON) mà máy lỗi: phiếu có dòng CAM_KET/TRAN thì về CHỜ — không bao giờ
    -- tự duyệt vì lỗi. Đang bóng: writer giữ luật cũ.
    IF v_route = 'CANONICAL' THEN
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) l
            JOIN public.income_expense_types t ON t.id = NULLIF(l->>'type_id', '')::uuid
           WHERE t.spend_mode IN ('CAM_KET', 'TRAN')) INTO v_co_luat;
      EXCEPTION WHEN OTHERS THEN
        v_co_luat := true;
      END;
      IF v_co_luat THEN
        RETURN jsonb_build_object('enforce', true, 'status', 'UNAPPROVED',
                                  'reason', 'ENGINE_ERROR', 'route', v_route);
      END IF;
    END IF;
    RETURN jsonb_build_object('enforce', false, 'route', v_route, 'error', SQLERRM);
  END;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 8. Sổ tiêu — đồng bộ theo TRẠNG THÁI (G4).

-- 8.1 Tập dòng tiêu mong muốn của một phiếu, từ trạng thái hiện tại.
CREATE OR REPLACE FUNCTION app_private.spend_ledger_desired_v1(p_voucher uuid)
RETURNS TABLE (commitment_id uuid, item_id uuid, amount numeric, bucket_key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  SELECT c.id, i.id, m.amount,
         e.organization_id || ':' || e.building_id || ':' || t.fee_category || ':'
           || to_char(m.period_month, 'YYYY-MM')
    FROM public.income_expenses e
    JOIN public.income_expense_items i ON i.income_expense_id = e.id
    JOIN public.income_expense_types t
      ON t.id = i.income_expense_type_id AND t.organization_id = e.organization_id
   CROSS JOIN LATERAL app_private.spend_line_months_v1(
           i.start_date, i.end_date, e.voucher_date,
           COALESCE(i.amount, i.quantity * i.unit_price)) m
    JOIN app_private.spend_commitments c
      ON c.organization_id = e.organization_id
     AND c.building_id = e.building_id
     AND c.fee_category = t.fee_category
     AND c.period_month = m.period_month
     AND c.status = 'PUBLISHED'
   WHERE e.id = p_voucher
     AND e.type = 'EXPENSE'
     AND e.deleted_at IS NULL
     AND e.approval_status <> 'CANCELLED'
     AND e.building_id IS NOT NULL
     AND t.fee_category IS NOT NULL
     AND t.spend_mode = 'CAM_KET';
$fn$;

-- 8.2 Đưa sổ tiêu của một phiếu về đúng tập mong muốn.
CREATE OR REPLACE FUNCTION app_private.spend_ledger_sync_v1(p_voucher uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_ie    record;
  v_kind  text;
  v_now   timestamptz := clock_timestamp();
  v_actor uuid := auth.uid();
  v_keys  text[];
  r       record;
  v_old   record;
  v_used  numeric;
  v_cap   numeric;
  v_over  boolean;
  v_co_dong boolean;
  v_n     int := 0;
  v_k     int;
BEGIN
  SELECT e.id, e.organization_id, e.approval_status
    INTO v_ie
    FROM public.income_expenses e
   WHERE e.id = p_voucher;
  IF NOT FOUND OR v_ie.organization_id IS NULL THEN
    RETURN 0;
  END IF;
  IF app_private.spend_route_v1(v_ie.organization_id) = 'LEGACY' THEN
    RETURN 0;
  END IF;

  v_kind := CASE WHEN v_ie.approval_status = 'APPROVED' THEN 'DRAW' ELSE 'HOLD' END;

  -- khoá: bucket mong muốn ∪ bucket đang giữ, thứ tự cố định
  SELECT array_agg(DISTINCT s.k ORDER BY s.k) INTO v_keys
    FROM (
      SELECT d.bucket_key AS k FROM app_private.spend_ledger_desired_v1(p_voucher) d
      UNION
      SELECT c.organization_id || ':' || c.building_id || ':' || c.fee_category || ':'
             || to_char(c.period_month, 'YYYY-MM')
        FROM app_private.spend_commitment_draws x
        JOIN app_private.spend_commitments c ON c.id = x.commitment_id
       WHERE x.income_expense_id = p_voucher
    ) s;
  IF v_keys IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM app_private.spend_lock_keys_v1(v_keys);

  -- áp tập mong muốn (đọc lại sau khoá)
  FOR r IN SELECT * FROM app_private.spend_ledger_desired_v1(p_voucher) LOOP
    SELECT x.* INTO v_old
      FROM app_private.spend_commitment_draws x
     WHERE x.commitment_id = r.commitment_id AND x.income_expense_item_id = r.item_id
       FOR UPDATE;
    v_co_dong := FOUND;
    IF v_co_dong AND v_old.kind = v_kind AND v_old.amount = r.amount THEN
      CONTINUE;
    END IF;
    SELECT COALESCE(sum(x.amount), 0) INTO v_used
      FROM app_private.spend_commitment_draws x
     WHERE x.commitment_id = r.commitment_id
       AND x.kind IN ('HOLD', 'DRAW')
       AND x.income_expense_item_id <> r.item_id;
    SELECT c.amount INTO v_cap FROM app_private.spend_commitments c WHERE c.id = r.commitment_id;
    v_over := (v_cap - v_used) < r.amount;
    IF v_co_dong THEN
      UPDATE app_private.spend_commitment_draws
         SET kind = v_kind,
             amount = r.amount,
             over_commitment = v_over,
             reason = CASE WHEN v_over AND v_kind = 'DRAW' THEN 'Đã duyệt vượt cam kết — cam kết không tự nới'
                           WHEN v_over THEN 'Chờ duyệt — vượt phần cam kết còn lại'
                           ELSE NULL END,
             held_at = CASE WHEN v_kind = 'HOLD' THEN COALESCE(held_at, v_now) ELSE held_at END,
             drawn_at = CASE WHEN v_kind = 'DRAW' THEN COALESCE(drawn_at, v_now) ELSE NULL END,
             released_at = NULL,
             actor_id = COALESCE(v_actor, actor_id),
             updated_at = v_now
       WHERE id = v_old.id;
    ELSE
      INSERT INTO app_private.spend_commitment_draws
        (organization_id, commitment_id, income_expense_id, income_expense_item_id,
         amount, kind, over_commitment, reason, held_at, drawn_at, actor_id)
      VALUES
        (v_ie.organization_id, r.commitment_id, p_voucher, r.item_id,
         r.amount, v_kind, v_over,
         CASE WHEN v_over AND v_kind = 'DRAW' THEN 'Đã duyệt vượt cam kết — cam kết không tự nới'
              WHEN v_over THEN 'Chờ duyệt — vượt phần cam kết còn lại' END,
         CASE WHEN v_kind = 'HOLD' THEN v_now END,
         CASE WHEN v_kind = 'DRAW' THEN v_now END,
         v_actor);
    END IF;
    v_n := v_n + 1;
  END LOOP;

  -- nhả dòng không còn trong tập mong muốn (huỷ, xoá, đổi kỳ/hạng mục/toà)
  UPDATE app_private.spend_commitment_draws x
     SET kind = 'RELEASE',
         released_at = v_now,
         reason = 'Nhả: phiếu huỷ/xoá hoặc dòng đổi kỳ, hạng mục, toà',
         actor_id = COALESCE(v_actor, x.actor_id),
         updated_at = v_now
   WHERE x.income_expense_id = p_voucher
     AND x.kind <> 'RELEASE'
     AND NOT EXISTS (
       SELECT 1 FROM app_private.spend_ledger_desired_v1(p_voucher) d
        WHERE d.commitment_id = x.commitment_id AND d.item_id = x.income_expense_item_id);
  GET DIAGNOSTICS v_k = ROW_COUNT;
  RETURN v_n + v_k;
END
$fn$;

-- 8.3 Bọc an toàn cho trigger: đang bóng ⇒ lỗi chỉ ghi lại, không chặn nghiệp vụ;
--     đang áp (ON) ⇒ ném lỗi (thà chặn còn hơn sổ tiêu sai).
CREATE OR REPLACE FUNCTION app_private.spend_ledger_sync_guarded_v1(p_voucher uuid, p_context text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_org   uuid;
  v_route text := 'LEGACY';
BEGIN
  BEGIN
    PERFORM app_private.spend_ledger_sync_v1(p_voucher);
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      SELECT e.organization_id INTO v_org FROM public.income_expenses e WHERE e.id = p_voucher;
      v_route := app_private.spend_route_v1(v_org);
    EXCEPTION WHEN OTHERS THEN
      v_route := 'LEGACY';
    END;
    IF v_route = 'CANONICAL' THEN
      RAISE;
    END IF;
    INSERT INTO app_private.spend_engine_errors
      (context, organization_id, income_expense_id, sqlstate, message)
    VALUES ('ledger:' || p_context, v_org, p_voucher, SQLSTATE, SQLERRM);
  END;
END
$fn$;

-- 8.4 Đồng bộ lại mọi phiếu chạm một bucket (sau khi chủ ký/sửa cam kết).
CREATE OR REPLACE FUNCTION app_private.spend_ledger_resync_bucket_v1(
  p_org uuid, p_building uuid, p_fee_category text, p_month date)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_id uuid;
  v_n  int := 0;
BEGIN
  FOR v_id IN
    SELECT DISTINCT e.id
      FROM public.income_expenses e
      JOIN public.income_expense_items i ON i.income_expense_id = e.id
      JOIN public.income_expense_types t
        ON t.id = i.income_expense_type_id AND t.organization_id = e.organization_id
     WHERE e.organization_id = p_org
       AND e.building_id = p_building
       AND e.type = 'EXPENSE'
       AND t.fee_category = p_fee_category
       AND EXISTS (SELECT 1 FROM app_private.spend_line_months_v1(
                     i.start_date, i.end_date, e.voucher_date,
                     COALESCE(i.amount, i.quantity * i.unit_price)) m
                    WHERE m.period_month = app_private.spend_month_v1(p_month))
    UNION
    SELECT x.income_expense_id
      FROM app_private.spend_commitment_draws x
      JOIN app_private.spend_commitments c ON c.id = x.commitment_id
     WHERE c.organization_id = p_org AND c.building_id = p_building
       AND c.fee_category = p_fee_category
       AND c.period_month = app_private.spend_month_v1(p_month)
     ORDER BY 1
  LOOP
    v_n := v_n + app_private.spend_ledger_sync_v1(v_id);
  END LOOP;
  RETURN v_n;
END
$fn$;

-- 8.5 Hậu kiểm: sổ tiêu lệch trạng thái + bucket tiêu vượt không có lý do (INV-7).
CREATE OR REPLACE FUNCTION app_private.spend_ledger_audit_v1(p_org uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_thieu int;
  v_thua  int;
  v_vuot  jsonb;
BEGIN
  WITH phieu AS (
    SELECT DISTINCT e.id, e.approval_status
      FROM public.income_expenses e
      JOIN public.income_expense_items i ON i.income_expense_id = e.id
      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
     WHERE (p_org IS NULL OR e.organization_id = p_org)
       AND t.fee_category IS NOT NULL AND t.spend_mode = 'CAM_KET'
       AND e.type = 'EXPENSE'
       AND COALESCE(i.end_date, i.start_date, e.voucher_date)
           >= (SELECT min(c.period_month) FROM app_private.spend_commitments c)
    UNION
    SELECT DISTINCT e.id, e.approval_status
      FROM app_private.spend_commitment_draws x
      JOIN public.income_expenses e ON e.id = x.income_expense_id
     WHERE (p_org IS NULL OR x.organization_id = p_org)
  ), mong AS (
    SELECT d.commitment_id, d.item_id, d.amount,
           CASE WHEN p.approval_status = 'APPROVED' THEN 'DRAW' ELSE 'HOLD' END AS kind
      FROM phieu p CROSS JOIN LATERAL app_private.spend_ledger_desired_v1(p.id) d
  ), co AS (
    SELECT x.commitment_id, x.income_expense_item_id AS item_id, x.amount, x.kind
      FROM app_private.spend_commitment_draws x
     WHERE (p_org IS NULL OR x.organization_id = p_org) AND x.kind <> 'RELEASE'
  )
  SELECT (SELECT count(*) FROM mong m WHERE NOT EXISTS (
            SELECT 1 FROM co WHERE co.commitment_id = m.commitment_id AND co.item_id = m.item_id
                               AND co.amount = m.amount AND co.kind = m.kind)),
         (SELECT count(*) FROM co WHERE NOT EXISTS (
            SELECT 1 FROM mong m WHERE m.commitment_id = co.commitment_id AND m.item_id = co.item_id))
    INTO v_thieu, v_thua;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'commitment_id', c.id, 'building_id', c.building_id, 'fee_category', c.fee_category,
           'month', c.period_month, 'amount', c.amount, 'used', s.used)), '[]'::jsonb)
    INTO v_vuot
    FROM app_private.spend_commitments c
    JOIN LATERAL (
      SELECT sum(x.amount) AS used,
             bool_or(x.over_commitment AND x.kind = 'DRAW' AND x.reason IS NOT NULL) AS co_ly_do
        FROM app_private.spend_commitment_draws x
       WHERE x.commitment_id = c.id AND x.kind = 'DRAW') s ON true
   WHERE (p_org IS NULL OR c.organization_id = p_org)
     AND s.used > c.amount
     AND NOT COALESCE(s.co_ly_do, false);

  RETURN jsonb_build_object('lech_thieu', v_thieu, 'lech_thua', v_thua,
                            'bucket_vuot_khong_ly_do', v_vuot);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 9. Trigger sổ tiêu.
CREATE OR REPLACE FUNCTION app_private.spend_ledger_items_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_ids uuid[];
  v_id  uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT m.income_expense_id ORDER BY m.income_expense_id) INTO v_ids FROM moi m;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT c.income_expense_id ORDER BY c.income_expense_id) INTO v_ids FROM cu c;
  ELSE
    SELECT array_agg(DISTINCT s.x ORDER BY s.x) INTO v_ids
      FROM (SELECT m.income_expense_id AS x FROM moi m
            UNION SELECT c.income_expense_id FROM cu c) s;
  END IF;
  IF v_ids IS NULL THEN
    RETURN NULL;
  END IF;
  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM app_private.spend_ledger_sync_guarded_v1(v_id, 'items:' || TG_OP);
  END LOOP;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.spend_ledger_header_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  PERFORM app_private.spend_ledger_sync_guarded_v1(NEW.id, 'header:' || TG_OP);
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.spend_ledger_type_rule_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_id  uuid;
  v_tu  date;
BEGIN
  SELECT min(c.period_month) INTO v_tu
    FROM app_private.spend_commitments c WHERE c.organization_id = NEW.organization_id;
  FOR v_id IN
    SELECT DISTINCT i.income_expense_id
      FROM public.income_expense_items i
      JOIN public.income_expenses e ON e.id = i.income_expense_id
     WHERE i.income_expense_type_id = NEW.id
       AND e.type = 'EXPENSE'
       AND v_tu IS NOT NULL
       AND COALESCE(i.end_date, i.start_date, e.voucher_date) >= v_tu
    UNION
    SELECT x.income_expense_id
      FROM app_private.spend_commitment_draws x
      JOIN public.income_expense_items i ON i.id = x.income_expense_item_id
     WHERE i.income_expense_type_id = NEW.id
     ORDER BY 1
  LOOP
    PERFORM app_private.spend_ledger_sync_guarded_v1(v_id, 'type_rule');
  END LOOP;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS z60_spend_ledger_items_ins ON public.income_expense_items;
DROP TRIGGER IF EXISTS z60_spend_ledger_items_upd ON public.income_expense_items;
DROP TRIGGER IF EXISTS z60_spend_ledger_items_del ON public.income_expense_items;
CREATE TRIGGER z60_spend_ledger_items_ins
  AFTER INSERT ON public.income_expense_items
  REFERENCING NEW TABLE AS moi
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.spend_ledger_items_trg();
CREATE TRIGGER z60_spend_ledger_items_upd
  AFTER UPDATE ON public.income_expense_items
  REFERENCING OLD TABLE AS cu NEW TABLE AS moi
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.spend_ledger_items_trg();
CREATE TRIGGER z60_spend_ledger_items_del
  AFTER DELETE ON public.income_expense_items
  REFERENCING OLD TABLE AS cu
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.spend_ledger_items_trg();

DROP TRIGGER IF EXISTS z60_spend_ledger_header ON public.income_expenses;
CREATE TRIGGER z60_spend_ledger_header
  AFTER UPDATE OF approval_status, deleted_at, building_id, organization_id, type, voucher_date
  ON public.income_expenses
  FOR EACH ROW
  WHEN (OLD.approval_status IS DISTINCT FROM NEW.approval_status
     OR OLD.deleted_at      IS DISTINCT FROM NEW.deleted_at
     OR OLD.building_id     IS DISTINCT FROM NEW.building_id
     OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
     OR OLD.type            IS DISTINCT FROM NEW.type
     OR OLD.voucher_date    IS DISTINCT FROM NEW.voucher_date)
  EXECUTE FUNCTION app_private.spend_ledger_header_trg();

DROP TRIGGER IF EXISTS z60_spend_ledger_type_rule ON public.income_expense_types;
CREATE TRIGGER z60_spend_ledger_type_rule
  AFTER UPDATE OF fee_category, spend_mode ON public.income_expense_types
  FOR EACH ROW
  WHEN (OLD.fee_category IS DISTINCT FROM NEW.fee_category
     OR OLD.spend_mode   IS DISTINCT FROM NEW.spend_mode)
  EXECUTE FUNCTION app_private.spend_ledger_type_rule_trg();

-- ---------------------------------------------------------------------------
-- 10. Bóng tại thời điểm sinh — chạy ở COMMIT của transaction sinh phiếu.
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
    v_writer := app_private.spend_writer_of_v1(
                  v_ie.system_source, v_ie.repeat_parent_id,
                  current_setting('app.spend_writer', true));
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
    v_enforced := v_route = 'CANONICAL'
                  AND COALESCE((v_dec->>'all_switched')::boolean, false)
                  AND v_writer IN ('create_income_expense_v1', 'pay_period_fee', 'pay_utility_bill',
                                   'generate_special_fees_v1', 'generate_recurring_vouchers');
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

DROP TRIGGER IF EXISTS zz_spend_shadow_birth ON public.income_expenses;
CREATE CONSTRAINT TRIGGER zz_spend_shadow_birth
  AFTER INSERT ON public.income_expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_private.spend_shadow_birth_trg();

-- ---------------------------------------------------------------------------
-- 11. Cam kết: ký/sửa phải khoá bucket và kéo sổ tiêu theo (thay bản G1).
CREATE OR REPLACE FUNCTION public.set_spend_commitment_v1(
  p_building_id  uuid,
  p_fee_category text,
  p_period_month date,
  p_amount       numeric,
  p_note         text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_thang date;
  v_cu    app_private.spend_commitments%ROWTYPE;
  v_co_cu boolean;
  v_moi   uuid;
  v_dong  int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT b.organization_id INTO v_org
    FROM public.buildings b
   WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.is_super_admin()
          OR app_private.ie_actor_is_company_owner_v1(v_org, v_actor)) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được sửa cam kết chi'
      USING ERRCODE = '42501';
  END IF;
  IF p_fee_category NOT IN ('tien_nha','dien','nuoc','internet','quan_ly',
                            've_sinh','cong_an','rac','thang_may') THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_fee_category USING ERRCODE = '22023';
  END IF;
  IF p_period_month IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng cam kết' USING ERRCODE = '22023';
  END IF;
  v_thang := app_private.spend_month_v1(p_period_month);

  -- cùng khoá bucket với writer: không ai đang tiêu dở khi cam kết đổi
  PERFORM app_private.spend_lock_keys_v1(ARRAY[
    v_org || ':' || p_building_id || ':' || p_fee_category || ':' || to_char(v_thang, 'YYYY-MM')]);

  SELECT * INTO v_cu
    FROM app_private.spend_commitments c
   WHERE c.building_id = p_building_id
     AND c.fee_category = p_fee_category
     AND c.period_month = v_thang
     AND c.status = 'PUBLISHED';
  v_co_cu := FOUND;

  IF v_co_cu AND EXISTS (SELECT 1 FROM app_private.spend_commitment_draws d
                          WHERE d.commitment_id = v_cu.id AND d.kind IN ('HOLD','DRAW')) THEN
    RAISE EXCEPTION
      'Tháng % của khe này đã có khoản chi hoặc phiếu đang chờ — không sửa cam kết được. Muốn điều chỉnh thì lập phiếu riêng.',
      to_char(v_thang, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  IF v_co_cu THEN
    UPDATE app_private.spend_commitments
       SET status = 'RETIRED', retired_at = clock_timestamp(), retired_by = v_actor
     WHERE id = v_cu.id;
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    v_dong := app_private.spend_ledger_resync_bucket_v1(v_org, p_building_id, p_fee_category, v_thang);
    RETURN jsonb_build_object('da_thu_hoi', v_co_cu, 'commitment_id', NULL, 'so_tieu_dong_bo', v_dong);
  END IF;

  INSERT INTO app_private.spend_commitments
    (organization_id, building_id, fee_category, period_month, amount,
     status, source, note, created_by)
  VALUES
    (v_org, p_building_id, p_fee_category, v_thang, p_amount,
     'PUBLISHED', 'MANUAL', NULLIF(btrim(p_note), ''), v_actor)
  RETURNING id INTO v_moi;

  -- phiếu đã có trong tháng này (vd phiếu lập trước khi ký) phải được tính vào sổ tiêu
  v_dong := app_private.spend_ledger_resync_bucket_v1(v_org, p_building_id, p_fee_category, v_thang);

  RETURN jsonb_build_object('commitment_id', v_moi, 'thang', v_thang,
                            'so_tien', p_amount, 'da_thu_hoi_ban_cu', v_co_cu,
                            'so_tieu_dong_bo', v_dong,
                            'con_lai', app_private.commitment_remaining_v1(v_moi));
END
$fn$;

-- ---------------------------------------------------------------------------
-- 12. RPC cho chủ: công tắc bucket, báo cáo bóng, luật hạng mục, dấu vết tự duyệt.

CREATE OR REPLACE FUNCTION public.set_spend_policy_switch_v1(
  p_organization_id uuid,
  p_fee_category    text,
  p_from_month      date,
  p_to_month        date    DEFAULT NULL,
  p_building_id     uuid    DEFAULT NULL,
  p_on              boolean DEFAULT true,
  p_note            text    DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor  uuid := auth.uid();
  v_from   date := app_private.spend_month_v1(p_from_month);
  v_to     date := app_private.spend_month_v1(p_to_month);
  v_mode   text;
  v_thieu  jsonb := '[]'::jsonb;
  v_id     uuid;
  v_n      int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.is_super_admin()
          OR app_private.ie_actor_is_company_owner_v1(p_organization_id, v_actor)) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được bật/tắt bộ máy chi'
      USING ERRCODE = '42501';
  END IF;
  IF p_fee_category NOT IN ('tien_nha','dien','nuoc','internet','quan_ly',
                            've_sinh','cong_an','rac','thang_may') THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_fee_category USING ERRCODE = '22023';
  END IF;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng bắt đầu' USING ERRCODE = '22023';
  END IF;
  IF p_building_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.buildings b
        WHERE b.id = p_building_id AND b.organization_id = p_organization_id AND b.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Toà không thuộc tổ chức' USING ERRCODE = '42501';
  END IF;

  IF NOT p_on THEN
    UPDATE app_private.spend_policy_switches s
       SET retired_at = clock_timestamp(), retired_by = v_actor
     WHERE s.organization_id = p_organization_id
       AND s.fee_category = p_fee_category
       AND s.retired_at IS NULL
       AND s.building_id IS NOT DISTINCT FROM p_building_id
       AND s.period_from = v_from;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('da_tat', v_n);
  END IF;

  SELECT t.spend_mode INTO v_mode
    FROM public.income_expense_types t
   WHERE t.organization_id = p_organization_id AND t.fee_category = p_fee_category;
  IF v_mode IS NULL OR v_mode NOT IN ('CAM_KET', 'TRAN') THEN
    RAISE EXCEPTION 'Hạng mục % chưa khai kiểu CAM_KET/TRAN trong tổ chức — không có gì để áp', p_fee_category
      USING ERRCODE = '55000';
  END IF;

  IF v_mode = 'TRAN' THEN
    -- câu 03: khai đủ trần trước khi bật
    SELECT COALESCE(jsonb_agg(b.name ORDER BY b.name), '[]'::jsonb) INTO v_thieu
      FROM public.buildings b
     WHERE b.organization_id = p_organization_id AND b.deleted_at IS NULL
       AND (p_building_id IS NULL OR b.id = p_building_id)
       AND (app_private.utility_ceiling_check_v1(
              p_organization_id, b.id,
              CASE p_fee_category WHEN 'dien' THEN 'ELECTRIC' ELSE 'WATER' END,
              v_from, 0)->>'verdict') = 'NO_RULE';
    IF jsonb_array_length(v_thieu) > 0 THEN
      RAISE EXCEPTION 'Chưa khai trần % cho: % — khai trần trước rồi mới bật (câu 03)',
        p_fee_category, v_thieu USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT COALESCE(jsonb_agg(DISTINCT b.name), '[]'::jsonb) INTO v_thieu
      FROM public.buildings b
      CROSS JOIN generate_series(v_from, COALESCE(v_to, v_from), interval '1 month') g
     WHERE b.organization_id = p_organization_id AND b.deleted_at IS NULL
       AND (p_building_id IS NULL OR b.id = p_building_id)
       AND NOT EXISTS (SELECT 1 FROM app_private.spend_commitments c
                        WHERE c.building_id = b.id AND c.fee_category = p_fee_category
                          AND c.period_month = g::date AND c.status = 'PUBLISHED');
  END IF;

  INSERT INTO app_private.spend_policy_switches
    (organization_id, fee_category, building_id, period_from, period_to, note, enabled_by)
  VALUES
    (p_organization_id, p_fee_category, p_building_id, v_from, v_to, NULLIF(btrim(p_note), ''), v_actor)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'switch_id', v_id,
    'co_hieu_luc_khi', 'cờ spend.engine.v1 = ON',
    'co_hien_tai', app_private.spend_route_v1(p_organization_id),
    'toa_chua_co_cam_ket', v_thieu,
    'ghi_chu', CASE WHEN jsonb_array_length(v_thieu) > 0
                    THEN 'Toà chưa ký cam kết mà bật: mọi phiếu hạng mục này ở toà đó sẽ CHỜ DUYỆT (không có cam kết).'
               END);
END
$fn$;

CREATE OR REPLACE FUNCTION public.list_spend_policy_switches_v1(p_organization_id uuid)
RETURNS TABLE (switch_id uuid, fee_category text, building_id uuid, building_name text,
               period_from date, period_to date, note text, enabled_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_super_admin()
     OR app_private.ie_actor_is_company_owner_v1(p_organization_id, auth.uid())) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT s.id, s.fee_category, s.building_id, b.name, s.period_from, s.period_to, s.note, s.enabled_at
    FROM app_private.spend_policy_switches s
    LEFT JOIN public.buildings b ON b.id = s.building_id
   WHERE s.organization_id = p_organization_id AND s.retired_at IS NULL
   ORDER BY s.fee_category, b.name NULLS FIRST, s.period_from;
END
$fn$;

CREATE OR REPLACE FUNCTION public.spend_shadow_report_v1(
  p_organization_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (voucher_id uuid, code text, voucher_date date, building_name text, writer text,
               amount numeric, birth_status text, engine_status text, engine_reason text,
               match boolean, enforced boolean, route text, decided_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_super_admin()
     OR app_private.ie_actor_is_company_owner_v1(p_organization_id, auth.uid())) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT d.income_expense_id, e.code, e.voucher_date, b.name, d.writer, d.amount,
         d.birth_status, d.engine_status, d.engine_reason, d.match, d.enforced, d.route, d.decided_at
    FROM app_private.spend_decisions d
    LEFT JOIN public.income_expenses e ON e.id = d.income_expense_id
    LEFT JOIN public.buildings b ON b.id = d.building_id
   WHERE d.organization_id = p_organization_id
     AND (p_from IS NULL OR d.decided_at >= p_from)
     AND (p_to IS NULL OR d.decided_at < p_to + 1)
   ORDER BY d.decided_at DESC
   LIMIT 2000;
END
$fn$;

CREATE OR REPLACE FUNCTION public.set_income_expense_type_spend_rule_v1(
  p_type_id      uuid,
  p_spend_mode   text,
  p_fee_category text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_t     record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT t.id, t.organization_id, t.type, t.spend_mode, t.fee_category INTO v_t
    FROM public.income_expense_types t WHERE t.id = p_type_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hạng mục' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.is_super_admin()
          OR app_private.ie_actor_is_company_owner_v1(v_t.organization_id, v_actor)) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được đổi luật chi của hạng mục'
      USING ERRCODE = '42501';
  END IF;
  IF p_spend_mode NOT IN ('CAM_KET', 'TRAN', 'TUNG_PHIEU') THEN
    RAISE EXCEPTION 'Kiểu chi không hợp lệ: %', p_spend_mode USING ERRCODE = '22023';
  END IF;
  IF lower(btrim(v_t.type)) <> 'expense' AND p_spend_mode <> 'TUNG_PHIEU' THEN
    RAISE EXCEPTION 'Hạng mục THU không mang luật chi' USING ERRCODE = '22023';
  END IF;
  IF p_spend_mode = 'CAM_KET' AND COALESCE(p_fee_category, v_t.fee_category) IS NULL THEN
    RAISE EXCEPTION 'Kiểu CAM_KET cần khoá phí (tien_nha, internet, …) để gắn cam kết' USING ERRCODE = '22023';
  END IF;
  IF p_spend_mode = 'TRAN' AND COALESCE(p_fee_category, v_t.fee_category) NOT IN ('dien', 'nuoc') THEN
    RAISE EXCEPTION 'Kiểu TRAN chỉ dùng cho điện, nước' USING ERRCODE = '22023';
  END IF;
  UPDATE public.income_expense_types
     SET spend_mode = p_spend_mode,
         fee_category = COALESCE(p_fee_category, fee_category),
         updated_at = clock_timestamp()
   WHERE id = p_type_id;
  RETURN jsonb_build_object('type_id', p_type_id, 'spend_mode', p_spend_mode,
                            'fee_category', COALESCE(p_fee_category, v_t.fee_category),
                            'truoc', jsonb_build_object('spend_mode', v_t.spend_mode, 'fee_category', v_t.fee_category));
END
$fn$;

-- dấu vết "Tự duyệt — người lập có quyền duyệt" (câu 05): lọc và đếm được
CREATE OR REPLACE FUNCTION public.list_self_approved_vouchers_v1(
  p_organization_id uuid, p_from date, p_to date)
RETURNS TABLE (voucher_id uuid, code text, voucher_date date, building_name text, type text,
               amount numeric, maker_id uuid, maker_name text, kind text, approved_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_super_admin()
     OR app_private.ie_actor_is_company_owner_v1(p_organization_id, auth.uid())) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.id, e.code, e.voucher_date, b.name, e.type, e.total_amount, e.user_id, e.creator_name,
         CASE WHEN d.engine_reason = 'SELF_APPROVER' AND d.birth_status = 'APPROVED'
              THEN 'Tự duyệt lúc lập — người lập có quyền duyệt'
              ELSE 'Người lập tự bấm duyệt phiếu của mình' END,
         e.approved_at
    FROM public.income_expenses e
    LEFT JOIN public.buildings b ON b.id = e.building_id
    LEFT JOIN app_private.spend_decisions d ON d.income_expense_id = e.id
   WHERE e.organization_id = p_organization_id
     AND e.deleted_at IS NULL
     AND e.approval_status = 'APPROVED'
     AND e.voucher_date BETWEEN p_from AND p_to
     AND ((d.engine_reason = 'SELF_APPROVER' AND d.birth_status = 'APPROVED')
          OR (e.approved_by = e.user_id AND e.approved_at > e.created_at + interval '5 seconds'))
   ORDER BY e.voucher_date DESC, e.code
   LIMIT 5000;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 13. Quyền.
REVOKE ALL ON FUNCTION app_private.spend_month_v1(date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_line_months_v1(date, date, date, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_lock_keys_v1(text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_route_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_b0_source_v1(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.ie_spend_cashbook_ok_v1(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_switch_on_v1(uuid, uuid, text, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_lines_of_voucher_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_writer_of_v1(text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.ie_spend_facts_v1(uuid, uuid, text, text, text, uuid, date, jsonb, uuid, boolean, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.ie_spend_decide_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.ie_spend_gate_v1(uuid, uuid, text, text, text, uuid, date, jsonb, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_ledger_desired_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_ledger_sync_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_ledger_sync_guarded_v1(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_ledger_resync_bucket_v1(uuid, uuid, text, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_ledger_audit_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_ledger_items_trg() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_ledger_header_trg() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_ledger_type_rule_trg() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.spend_shadow_birth_trg() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.set_spend_commitment_v1(uuid, text, date, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_spend_commitment_v1(uuid, text, date, numeric, text) TO authenticated;
REVOKE ALL ON FUNCTION public.set_spend_policy_switch_v1(uuid, text, date, date, uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_spend_policy_switch_v1(uuid, text, date, date, uuid, boolean, text) TO authenticated;
REVOKE ALL ON FUNCTION public.list_spend_policy_switches_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_spend_policy_switches_v1(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.spend_shadow_report_v1(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.spend_shadow_report_v1(uuid, date, date) TO authenticated;
REVOKE ALL ON FUNCTION public.set_income_expense_type_spend_rule_v1(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_income_expense_type_spend_rule_v1(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.list_self_approved_vouchers_v1(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_self_approved_vouchers_v1(uuid, date, date) TO authenticated;

COMMENT ON FUNCTION app_private.ie_spend_decide_v1(jsonb) IS
  'Bộ máy quyết định chi DUY NHẤT (hàm thuần). THU/B0 ⇒ duyệt; CHI không sổ thật ⇒ chờ; CAM_KET trong phần còn lại ⇒ duyệt, vượt ⇒ chờ; TRAN dưới trần ⇒ duyệt, vượt/không trần ⇒ chờ; TUNG_PHIEU: người lập có quyền duyệt ⇒ duyệt (SELF_APPROVER), bắt buộc duyệt / ≥ ngưỡng ⇒ chờ. Một dòng chờ ⇒ cả phiếu chờ. Chủ chốt 26/09/2026.';
COMMENT ON FUNCTION app_private.ie_spend_gate_v1(uuid, uuid, text, text, text, uuid, date, jsonb, uuid, jsonb) IS
  'Cổng của writer: khoá bucket → đọc sự thật → hỏi bộ máy. enforce=true chỉ khi cờ spend.engine.v1 = ON và mọi bucket của phiếu đã bật (hoặc G6 bật và người lập không giữ sổ để chi). enforce=false ⇒ writer giữ luật cũ.';

-- ---------------------------------------------------------------------------
-- 14. Khởi tạo sổ tiêu cho phiếu đã có trong các tháng có cam kết.
DO $khoi_tao$
DECLARE
  v_id uuid;
  v_tu date;
  v_n  int := 0;
BEGIN
  SELECT min(period_month) INTO v_tu FROM app_private.spend_commitments;
  IF v_tu IS NULL THEN
    RETURN;
  END IF;
  FOR v_id IN
    SELECT DISTINCT e.id
      FROM public.income_expenses e
      JOIN public.income_expense_items i ON i.income_expense_id = e.id
      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
     WHERE e.type = 'EXPENSE'
       AND t.fee_category IS NOT NULL AND t.spend_mode = 'CAM_KET'
       AND COALESCE(i.end_date, i.start_date, e.voucher_date) >= v_tu
     ORDER BY 1
  LOOP
    PERFORM app_private.spend_ledger_sync_v1(v_id);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'Sổ tiêu khởi tạo: % phiếu', v_n;
END
$khoi_tao$;

-- ---------------------------------------------------------------------------
-- 15. Tự kiểm.
DO $sau$
DECLARE
  v_audit jsonb;
  v_n     int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_private.server_feature_flags WHERE feature_key = 'spend.engine.v1') THEN
    RAISE EXCEPTION 'Thiếu cờ spend.engine.v1' USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgname IN ('z60_spend_ledger_items_ins', 'z60_spend_ledger_items_upd',
         'z60_spend_ledger_items_del', 'z60_spend_ledger_header', 'z60_spend_ledger_type_rule',
         'zz_spend_shadow_birth');
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'Thiếu trigger bộ máy chi (% / 6)', v_n USING ERRCODE = '55000';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'app_private.ie_spend_decide_v1(jsonb)'::regprocedure) <> 'i' THEN
    RAISE EXCEPTION 'ie_spend_decide_v1 phải IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', 'public.set_spend_policy_switch_v1(uuid,text,date,date,uuid,boolean,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.spend_shadow_report_v1(uuid,date,date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_income_expense_type_spend_rule_v1(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.list_self_approved_vouchers_v1(uuid,date,date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.list_spend_policy_switches_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon còn EXECUTE trên RPC bộ máy chi' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c
              WHERE c.conrelid = 'app_private.spend_commitment_draws'::regclass AND c.contype = 'f'
                AND c.confrelid IN ('public.income_expenses'::regclass, 'public.income_expense_items'::regclass)
                AND c.confdeltype <> 'c') THEN
    RAISE EXCEPTION 'FK sổ tiêu → phiếu/dòng chưa CASCADE' USING ERRCODE = '55000';
  END IF;
  -- khởi tạo xong thì sổ tiêu phải khớp trạng thái (chỉ khi bộ máy không tắt)
  IF (SELECT mode FROM app_private.server_feature_flags WHERE feature_key = 'spend.engine.v1') <> 'OFF' THEN
    v_audit := app_private.spend_ledger_audit_v1(NULL);
    IF (v_audit->>'lech_thieu')::int <> 0 OR (v_audit->>'lech_thua')::int <> 0 THEN
      RAISE EXCEPTION 'Sổ tiêu lệch trạng thái sau khởi tạo: %', v_audit USING ERRCODE = '55000';
    END IF;
  END IF;
  -- hàm thuần: vài ca biên
  IF app_private.ie_spend_decide_v1(jsonb_build_object('direction','INCOME'))->>'status' <> 'APPROVED'
     OR app_private.ie_spend_decide_v1(jsonb_build_object('direction','EXPENSE','account_real',false,
          'lines', jsonb_build_array(jsonb_build_object('i',1,'spend_mode','TUNG_PHIEU'))))->>'reason' <> 'NO_CASHBOOK'
     OR app_private.ie_spend_decide_v1(jsonb_build_object('direction','EXPENSE','account_real',true,
          'actor_can_approve',true,'threshold',600000,'total',1000000,
          'lines', jsonb_build_array(jsonb_build_object('i',1,'spend_mode','TUNG_PHIEU','force_approval',true))))->>'reason' <> 'SELF_APPROVER'
     OR app_private.ie_spend_decide_v1(jsonb_build_object('direction','EXPENSE','account_real',true,
          'actor_can_approve',false,'threshold',600000,'total',600000,
          'lines', jsonb_build_array(jsonb_build_object('i',1,'spend_mode','TUNG_PHIEU'))))->>'reason' <> 'OVER_THRESHOLD'
     OR app_private.ie_spend_decide_v1(jsonb_build_object('direction','EXPENSE','account_real',true,
          'actor_can_approve',true,
          'buckets', jsonb_build_object('c1', jsonb_build_object('amount',100,'used_by_others',80)),
          'lines', jsonb_build_array(jsonb_build_object('i',1,'spend_mode','CAM_KET',
             'months', jsonb_build_array(jsonb_build_object('commitment_id','c1','amount',30,'switch_on',true))))))->>'reason' <> 'OVER_COMMITMENT'
     OR app_private.ie_spend_decide_v1(jsonb_build_object('direction','EXPENSE','account_real',true,
          'actor_can_approve',false,
          'buckets', jsonb_build_object('c1', jsonb_build_object('amount',100,'used_by_others',70)),
          'lines', jsonb_build_array(jsonb_build_object('i',1,'spend_mode','CAM_KET',
             'months', jsonb_build_array(jsonb_build_object('commitment_id','c1','amount',30,'switch_on',true))))))->>'status' <> 'APPROVED'
  THEN
    RAISE EXCEPTION 'Bộ máy quyết định sai ở ca biên tự kiểm' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;
