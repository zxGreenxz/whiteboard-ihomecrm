-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — PHẦN NỀN (M1 của "Chi chia lợi nhuận theo sổ tổng").
--
-- VÌ SAO
--   Chi lợi nhuận cổ đông và lương điều hành sắp chuyển sang một sổ tổng cho mỗi
--   người: còn phải trả = lợi nhuận các tháng đã chốt − phiếu chi (chờ duyệt hoặc
--   đã duyệt) − phần lợi nhuận đã trả qua lương − những gì nằm trước mốc "đã trả
--   đủ đến hết tháng X". Migration này chỉ dựng nền để các lệnh ghi/đọc viết sau
--   dùng chung MỘT công thức số dư.
--
-- LÀM GÌ (chưa đổi hành vi nào của người dùng)
--   1. Ba khoá quyền mới: shareholder_profit.advance_own_cashbook (không gieo cho
--      vai nào), shareholder_profit.view_percent, shareholder_profit.view_building_totals
--      (gieo cho vai chủ công ty).
--   2. Công tắc shareholder_profit.ledger_payout.v1 ở trạng thái TẮT.
--   3. Sequence thứ tự sổ, sáu bảng app_private.profit_ledger_* (rỗng, RLS bật,
--      không cấp quyền cho vai nào), trigger chỉ-ghi-thêm / máy trạng thái.
--   4. Hàm lõi nội bộ: phiếu còn sống, mốc hiệu lực, số dư (một lõi theo mốc truyền
--      vào + bản theo mốc hiệu lực gọi lõi), khoá sổ, ước tính tháng chưa chốt.
--      Chưa RPC nào gọi các hàm này.
--
-- KHÔNG LÀM: không RPC public, không trigger trên income_expenses /
--   approval_requests / salary_monthly, không sửa hàm cũ, không policy RLS nào
--   của bảng lợi nhuận, không đổi hạng mục thu chi.
--
-- AN TOÀN CHẠY LẠI: mọi lệnh là IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT /
--   DROP TRIGGER IF EXISTS. Dòng công tắc dùng ON CONFLICT DO NOTHING nên lượt sau
--   KHÔNG đặt lại chế độ đã bật. Ba khoá quyền cũng chỉ được tạo (DO NOTHING): chạy lại
--   không ghi đè hình dạng / trạng thái và không gieo lại quyền chủ đã gỡ khỏi vai.
-- LÙI: bảng rỗng và hàm chưa ai gọi nên để nguyên là vô hại. Muốn gỡ quyền: viết
--   migration forward mới xoá ba khoá khỏi role_permissions rồi đặt
--   permission_definitions.is_active = false (nhãn ở web phải gỡ cùng lúc).
-- =============================================================================

BEGIN;

-- 0. Tiền kiểm: đối tượng nền phải có, đúng chữ ký. Thiếu ⇒ dừng 55000.
DO $truoc$
DECLARE
  v_thieu text;
BEGIN
  -- app_private.profit_viewer_can_v1 do migration 20261115024231 tạo; ở đây KHÔNG tạo lại.
  IF to_regprocedure('app_private.profit_viewer_can_v1(uuid,text)') IS NULL
     OR (SELECT p.prorettype FROM pg_catalog.pg_proc p
          WHERE p.oid = to_regprocedure('app_private.profit_viewer_can_v1(uuid,text)')) <> 'boolean'::regtype THEN
    RAISE EXCEPTION 'Thiếu app_private.profit_viewer_can_v1(uuid,text) RETURNS boolean (migration 20261115024231)'
      USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.org_today_v1(uuid)') IS NULL
     OR (SELECT p.prorettype FROM pg_catalog.pg_proc p
          WHERE p.oid = to_regprocedure('public.org_today_v1(uuid)')) <> 'date'::regtype THEN
    RAISE EXCEPTION 'Thiếu public.org_today_v1(uuid) RETURNS date' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('app_private.evaluate_feature_route(text,uuid)') IS NULL
     OR (SELECT p.prorettype FROM pg_catalog.pg_proc p
          WHERE p.oid = to_regprocedure('app_private.evaluate_feature_route(text,uuid)')) <> 'text'::regtype THEN
    RAISE EXCEPTION 'Thiếu app_private.evaluate_feature_route(text,uuid) RETURNS text' USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(x.rel || '.' || c.col, ', ' ORDER BY x.rel, c.col) INTO v_thieu
    FROM (VALUES
      ('public.organizations', ARRAY['id']),
      ('public.permission_definitions', ARRAY['key', 'resource', 'action', 'sensitivity', 'permission_domain',
         'scope_kinds', 'is_active', 'scope_match_mode', 'requires_cashbook_possession',
         'accepted_possession_kinds', 'required_dimensions']),
      ('public.organization_roles', ARRAY['id', 'organization_id', 'name', 'system_key']),
      ('public.role_permissions', ARRAY['organization_id', 'role_id', 'permission_key', 'effect']),
      ('app_private.server_feature_flags', ARRAY['feature_key', 'domain', 'risk_class', 'mode', 'reason']),
      ('public.shareholders', ARRAY['id', 'organization_id']),
      ('public.profit_managers', ARRAY['id', 'organization_id']),
      ('public.profit_monthly', ARRAY['id', 'organization_id', 'period_month', 'status', 'is_stale']),
      ('public.profit_allocations', ARRAY['profit_monthly_id', 'shareholder_id', 'amount']),
      ('public.profit_manager_allocations', ARRAY['profit_monthly_id', 'manager_id', 'amount']),
      ('public.income_expenses', ARRAY['id', 'organization_id', 'type', 'approval_status', 'deleted_at',
         'shareholder_id', 'profit_manager_id', 'total_amount', 'account_id', 'created_at']),
      ('public.approval_requests', ARRAY['id', 'organization_id', 'subject_type', 'subject_id', 'submission_no', 'state'])
    ) AS x(rel, cols)
    CROSS JOIN LATERAL unnest(x.cols) AS c(col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass(x.rel) AND a.attname = c.col AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu bảng/cột nền: %', v_thieu USING ERRCODE = '55000';
  END IF;

  -- Khoá ngoại kép của sổ cần unique (id, organization_id) trên shareholders (đã có từ trước).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
     WHERE i.indrelid = 'public.shareholders'::regclass
       AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
       AND pg_get_indexdef(i.indexrelid) LIKE '%(id, organization_id)') THEN
    RAISE EXCEPTION 'Thiếu unique (id, organization_id) trên public.shareholders' USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ── 1. Quyền ─────────────────────────────────────────────────────────────────
-- Cùng hình dạng với các khoá shareholder_profit.* hiện có (phạm vi ORGANIZATION,
-- không chiều toà/sổ, không đòi giữ sổ). Khoá phải có TRƯỚC role_permissions
-- (FK + trigger a00_guard_tenant_role_permission_domain).
-- Khoá chỉ được TẠO, không bao giờ ghi đè: chạy lại file (áp lại, kiểm idempotent, khôi phục) không được
-- đổi hình dạng / trạng thái mà migration sau hay chủ đã đổi, và không được gieo lại quyền chủ đã gỡ khỏi vai.
-- Khoá vừa tạo trong GIAO DỊCH NÀY ghi vào biến giao dịch ihomecrm.m1_khoa_moi (cộng dồn qua các lượt
-- trong cùng giao dịch): chỉ khoá đó được gieo cho vai chủ, và hậu kiểm chỉ khẳng định về vai cho khoá đó.
DO $quyen$
DECLARE
  v_moi    text[];
  v_truoc  text[];
BEGIN
  WITH moi AS (
    INSERT INTO public.permission_definitions (key, resource, action, sensitivity, permission_domain, scope_kinds, is_active,
      scope_match_mode, requires_cashbook_possession, accepted_possession_kinds, required_dimensions)
    VALUES
      ('shareholder_profit.advance_own_cashbook', 'shareholder_profit', 'advance_own_cashbook', 'ELEVATED', 'TENANT',
        ARRAY['ORGANIZATION']::text[], true, 'ANY_MATCH', false, ARRAY[]::text[], ARRAY[]::text[]),
      ('shareholder_profit.view_percent', 'shareholder_profit', 'view_percent', 'MANAGE', 'TENANT',
        ARRAY['ORGANIZATION']::text[], true, 'ANY_MATCH', false, ARRAY[]::text[], ARRAY[]::text[]),
      ('shareholder_profit.view_building_totals', 'shareholder_profit', 'view_building_totals', 'MANAGE', 'TENANT',
        ARRAY['ORGANIZATION']::text[], true, 'ANY_MATCH', false, ARRAY[]::text[], ARRAY[]::text[])
    ON CONFLICT (key) DO NOTHING
    RETURNING key)
  SELECT COALESCE(array_agg(moi.key), ARRAY[]::text[]) INTO v_moi FROM moi;

  -- Chỉ vai chủ công ty có sẵn hai quyền xem; "chủ công ty" theo đúng định nghĩa của
  -- app_private.ie_actor_is_company_owner_v1 (mẫu 20261021072938). advance_own_cashbook
  -- KHÔNG gieo cho vai nào: chủ cấp riêng từng người ở Thành viên → Ngoại lệ.
  INSERT INTO public.role_permissions (organization_id, role_id, permission_key, effect)
  SELECT r.organization_id, r.id, k.key, 'ALLOW'
    FROM public.organization_roles r
    CROSS JOIN unnest(v_moi) AS k(key)
   WHERE k.key IN ('shareholder_profit.view_percent', 'shareholder_profit.view_building_totals')
     AND (r.system_key = 'TENANT_OWNER' OR (r.system_key IS NULL AND r.name IN ('Chủ sở hữu tổ chức', 'Chủ công ty')))
  ON CONFLICT (organization_id, role_id, permission_key) DO NOTHING;

  v_truoc := COALESCE(string_to_array(NULLIF(current_setting('ihomecrm.m1_khoa_moi', true), ''), ','), ARRAY[]::text[]);
  PERFORM set_config('ihomecrm.m1_khoa_moi',
    array_to_string(ARRAY(SELECT DISTINCT x.k FROM unnest(v_truoc || v_moi) AS x(k) ORDER BY x.k), ','), true);
END
$quyen$;

-- ── 2. Công tắc (TẮT) ────────────────────────────────────────────────────────
-- DO NOTHING: lượt chạy lại không được đặt lại chế độ đã bật.
INSERT INTO app_private.server_feature_flags (feature_key, domain, risk_class, mode, reason)
VALUES ('shareholder_profit.ledger_payout.v1', 'profit', 'MONEY', 'OFF',
        'Sổ tổng lợi nhuận cổ đông: tắt cho tới khi có quyết định bật')
ON CONFLICT (feature_key) DO NOTHING;

-- ── 3. Sequence và index nền ─────────────────────────────────────────────────
-- Thứ tự THẬT trong sổ giữa mốc và phiếu chi: lấy nextval ngay sau khi giữ khoá sổ.
-- Không dùng income_expenses.created_at (DEFAULT now() là giờ bắt đầu giao dịch).
CREATE SEQUENCE IF NOT EXISTS app_private.profit_ledger_seq AS bigint;
REVOKE ALL ON SEQUENCE app_private.profit_ledger_seq FROM PUBLIC, anon, authenticated, service_role;

CREATE UNIQUE INDEX IF NOT EXISTS profit_managers_id_org_uq ON public.profit_managers (id, organization_id);

-- ── 4. Bảng ──────────────────────────────────────────────────────────────────
-- Không bảng nào có khoá ngoại sang profit_allocations / profit_monthly: mở chốt,
-- chốt lại hay xoá phân bổ không bao giờ bị sổ này chặn.

-- C1. Mốc "đã trả đủ đến hết tháng X". Chỉ ghi thêm; mốc hiệu lực là dòng có
--     ledger_seq lớn nhất của chủ thể; settled_through_month NULL = gỡ mốc.
CREATE TABLE IF NOT EXISTS app_private.profit_ledger_markers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  subject_kind          text NOT NULL CHECK (subject_kind IN ('SHAREHOLDER', 'MANAGER')),
  shareholder_id        uuid,
  manager_id            uuid,
  subject_id            uuid GENERATED ALWAYS AS (COALESCE(shareholder_id, manager_id)) STORED,
  settled_through_month date CHECK (settled_through_month IS NULL OR EXTRACT(DAY FROM settled_through_month) = 1),
  reason                text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 8 AND 1000),
  supersedes_id         uuid,
  advance_erased        numeric(15,2) NOT NULL DEFAULT 0 CHECK (advance_erased >= 0),
  ledger_seq            bigint NOT NULL,
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT profit_ledger_markers_subject_ck CHECK (
    (subject_kind = 'SHAREHOLDER' AND shareholder_id IS NOT NULL AND manager_id IS NULL)
    OR (subject_kind = 'MANAGER' AND manager_id IS NOT NULL AND shareholder_id IS NULL)),
  CONSTRAINT profit_ledger_markers_seq_uq UNIQUE (ledger_seq),
  CONSTRAINT profit_ledger_markers_chain_uq UNIQUE (id, organization_id, subject_kind, subject_id),
  CONSTRAINT profit_ledger_markers_shareholder_fk FOREIGN KEY (shareholder_id, organization_id)
    REFERENCES public.shareholders (id, organization_id),
  CONSTRAINT profit_ledger_markers_manager_fk FOREIGN KEY (manager_id, organization_id)
    REFERENCES public.profit_managers (id, organization_id),
  -- Mốc mới chỉ đè lên mốc của CHÍNH chủ thể đó.
  CONSTRAINT profit_ledger_markers_supersedes_fk FOREIGN KEY (supersedes_id, organization_id, subject_kind, subject_id)
    REFERENCES app_private.profit_ledger_markers (id, organization_id, subject_kind, subject_id)
);
-- Chuỗi mốc của một chủ thể là một đường thẳng: đúng một dòng đầu, mỗi dòng bị đè
-- nhiều nhất một lần ⇒ dòng mới luôn đè lên dòng cuối (CAS ở tầng dữ liệu).
CREATE UNIQUE INDEX IF NOT EXISTS profit_ledger_markers_first_uq
  ON app_private.profit_ledger_markers (organization_id, subject_kind, subject_id) WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS profit_ledger_markers_supersedes_uq
  ON app_private.profit_ledger_markers (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS profit_ledger_markers_subject_idx
  ON app_private.profit_ledger_markers (organization_id, subject_kind, subject_id, ledger_seq DESC);

-- C2. Thông tin từng phiếu chi theo sổ tổng (một dòng một phiếu). Sau khi chèn chỉ
--     được điền approval_request_id đúng một lần, trong ngữ cảnh lập phiếu.
CREATE TABLE IF NOT EXISTS app_private.profit_ledger_payouts (
  voucher_id          uuid PRIMARY KEY REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  subject_kind        text NOT NULL CHECK (subject_kind IN ('SHAREHOLDER', 'MANAGER')),
  shareholder_id      uuid,
  manager_id          uuid,
  account_id          uuid NOT NULL,
  amount              numeric(15,2) NOT NULL CHECK (amount > 0),
  balance_before      numeric(15,2) NOT NULL,
  within_amount       numeric(15,2) NOT NULL CHECK (within_amount >= 0),
  advance_amount      numeric(15,2) NOT NULL CHECK (advance_amount >= 0),
  open_estimate       numeric(15,2),
  warnings            jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  maker_user_id       uuid NOT NULL,
  maker_membership_id uuid NOT NULL,
  maker_kind          text NOT NULL CHECK (maker_kind IN ('OWNER', 'CUSTODIAN_ADVANCE')),
  payee_is_maker      boolean NOT NULL,
  -- auth_user_id của người nhận lúc lập (NULL = người nhận không có đăng nhập).
  payee_user_id       uuid,
  approval_request_id uuid,
  ledger_seq          bigint NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT profit_ledger_payouts_subject_ck CHECK (
    (subject_kind = 'SHAREHOLDER' AND shareholder_id IS NOT NULL AND manager_id IS NULL)
    OR (subject_kind = 'MANAGER' AND manager_id IS NOT NULL AND shareholder_id IS NULL)),
  CONSTRAINT profit_ledger_payouts_split_ck CHECK (within_amount + advance_amount = amount),
  -- Lương điều hành không có tạm ứng.
  CONSTRAINT profit_ledger_payouts_manager_no_advance_ck CHECK (subject_kind <> 'MANAGER' OR advance_amount = 0),
  CONSTRAINT profit_ledger_payouts_payee_ck CHECK (payee_is_maker = COALESCE(payee_user_id = maker_user_id, false)),
  -- Người giữ sổ tự tạm ứng chỉ chi cho chính mình, và chỉ là cổ đông.
  CONSTRAINT profit_ledger_payouts_custodian_ck CHECK (
    maker_kind <> 'CUSTODIAN_ADVANCE' OR (subject_kind = 'SHAREHOLDER' AND payee_is_maker)),
  CONSTRAINT profit_ledger_payouts_seq_uq UNIQUE (ledger_seq),
  CONSTRAINT profit_ledger_payouts_shareholder_fk FOREIGN KEY (shareholder_id, organization_id)
    REFERENCES public.shareholders (id, organization_id),
  CONSTRAINT profit_ledger_payouts_manager_fk FOREIGN KEY (manager_id, organization_id)
    REFERENCES public.profit_managers (id, organization_id)
);
CREATE INDEX IF NOT EXISTS profit_ledger_payouts_shareholder_idx
  ON app_private.profit_ledger_payouts (organization_id, shareholder_id) WHERE shareholder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS profit_ledger_payouts_manager_idx
  ON app_private.profit_ledger_payouts (organization_id, manager_id) WHERE manager_id IS NOT NULL;

-- C3. Phần lợi nhuận trong lương của MỘT THÁNG, đóng băng lúc chốt bảng lương.
--     Bất biến: chỉ chuyển FROZEN → VOID rồi tạo dòng mới.
CREATE TABLE IF NOT EXISTS app_private.profit_ledger_salary_settlements (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  shareholder_id           uuid NOT NULL,
  staff_id                 uuid NOT NULL,
  period_month             date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
  salary_monthly_id        uuid,
  -- Dòng "Lợi nhuận đầu tư" của lương tháng (tháng lỗ thì âm).
  investment_month         numeric(15,2) NOT NULL,
  -- Phần tạm ứng trừ qua lương tháng này (D_m): không âm, không vượt phần lợi nhuận của tháng —
  -- trừ khi các phiếu lương đã trả của tháng ĐÃ trừ nhiều hơn (xem applied_offset_at_freeze).
  advance_offset_month     numeric(15,2) NOT NULL DEFAULT 0,
  -- Tổng phần trừ tạm ứng (D_i) của các dòng phiếu lương LINKED còn sống của cùng cổ đông, cùng
  -- tháng, tại lúc đóng băng. Do trigger tính khi chèn; giá trị truyền vào bị bỏ qua.
  -- Vì sao: lương đã trả có trừ tạm ứng, sau đó tháng lợi nhuận bị mở chốt / chốt lại thấp hơn ⇒
  -- D_m phải bằng được phần đã trừ thật, nếu không việc đóng băng lại (và chốt lương) bị chặn.
  applied_offset_at_freeze numeric(15,2) NOT NULL DEFAULT 0 CHECK (applied_offset_at_freeze >= 0),
  expected_take_home       numeric(15,2),
  allocation_snapshot      jsonb NOT NULL DEFAULT '[]'::jsonb,
  override_snapshot        jsonb NOT NULL DEFAULT '[]'::jsonb,
  ledger_balance_at_freeze numeric(15,2),
  state                    text NOT NULL DEFAULT 'FROZEN' CHECK (state IN ('FROZEN', 'VOID')),
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  voided_at                timestamptz,
  void_reason              text CHECK (void_reason IS NULL OR btrim(void_reason) <> ''),
  CONSTRAINT profit_ledger_salary_settlements_offset_ck CHECK (
    advance_offset_month >= 0 AND advance_offset_month <= GREATEST(investment_month, 0, applied_offset_at_freeze)),
  CONSTRAINT profit_ledger_salary_settlements_void_ck CHECK (
    (state = 'VOID') = (voided_at IS NOT NULL) AND (state = 'VOID') = (void_reason IS NOT NULL)),
  CONSTRAINT profit_ledger_salary_settlements_line_uq UNIQUE (id, organization_id, shareholder_id, period_month),
  CONSTRAINT profit_ledger_salary_settlements_shareholder_fk FOREIGN KEY (shareholder_id, organization_id)
    REFERENCES public.shareholders (id, organization_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS profit_ledger_salary_settlements_frozen_uq
  ON app_private.profit_ledger_salary_settlements (organization_id, shareholder_id, period_month) WHERE state = 'FROZEN';

-- C4. Phần lợi nhuận trong TỪNG phiếu lương. Số dư chỉ trừ dòng LINKED có phiếu lương còn sống.
CREATE TABLE IF NOT EXISTS app_private.profit_ledger_salary_settlement_vouchers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  shareholder_id          uuid NOT NULL,
  staff_id                uuid NOT NULL,
  period_month            date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
  settlement_id           uuid,
  salary_voucher_id       uuid REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  payout_request_key      text,
  investment_selected     numeric(15,2),
  -- Phần lợi nhuận trả trong phiếu này (tháng lỗ thì âm).
  investment_amount       numeric(15,2) NOT NULL DEFAULT 0,
  -- Phần tạm ứng trừ trong phiếu này.
  advance_offset_amount   numeric(15,2) NOT NULL DEFAULT 0 CHECK (advance_offset_amount >= 0),
  suggested_investment    numeric(15,2),
  expected_voucher_amount numeric(15,2),
  sheet_status_at_quote   text NOT NULL CHECK (sheet_status_at_quote IN ('DRAFT', 'LOCKED', 'NONE')),
  source                  text NOT NULL CHECK (source IN ('UI_QUOTE', 'PAYOUT_FALLBACK', 'BACKFILL', 'OWNER_RESOLVE')),
  state                   text NOT NULL CHECK (state IN ('QUOTED', 'LINKED', 'NEEDS_REVIEW', 'VOID')),
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  linked_at               timestamptz,
  resolved_by             uuid,
  resolved_at             timestamptz,
  resolve_reason          text,
  voided_at               timestamptz,
  void_reason             text,
  CONSTRAINT profit_ledger_salary_lines_state_ck CHECK (
    (state = 'QUOTED' AND salary_voucher_id IS NULL AND payout_request_key IS NOT NULL
       AND source = 'UI_QUOTE' AND linked_at IS NULL AND voided_at IS NULL)
    OR (state = 'LINKED' AND salary_voucher_id IS NOT NULL AND linked_at IS NOT NULL AND voided_at IS NULL)
    OR (state = 'NEEDS_REVIEW' AND salary_voucher_id IS NOT NULL AND linked_at IS NULL AND voided_at IS NULL)
    OR (state = 'VOID' AND salary_voucher_id IS NULL AND voided_at IS NOT NULL
       AND void_reason IS NOT NULL AND btrim(void_reason) <> '')),
  CONSTRAINT profit_ledger_salary_lines_resolve_ck CHECK (
    (source = 'OWNER_RESOLVE' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
       AND resolve_reason IS NOT NULL AND char_length(btrim(resolve_reason)) BETWEEN 8 AND 1000)
    OR (source <> 'OWNER_RESOLVE' AND resolved_by IS NULL AND resolved_at IS NULL AND resolve_reason IS NULL)),
  CONSTRAINT profit_ledger_salary_lines_shareholder_fk FOREIGN KEY (shareholder_id, organization_id)
    REFERENCES public.shareholders (id, organization_id),
  -- Dòng phiếu chỉ gắn vào bản đóng băng của đúng công ty, cổ đông và tháng đó.
  CONSTRAINT profit_ledger_salary_lines_settlement_fk FOREIGN KEY (settlement_id, organization_id, shareholder_id, period_month)
    REFERENCES app_private.profit_ledger_salary_settlements (id, organization_id, shareholder_id, period_month)
);
CREATE UNIQUE INDEX IF NOT EXISTS profit_ledger_salary_lines_voucher_uq
  ON app_private.profit_ledger_salary_settlement_vouchers (salary_voucher_id) WHERE salary_voucher_id IS NOT NULL;
-- Mỗi (nhân viên, tháng) chỉ có một báo giá đang chờ: báo giá mới phải huỷ báo giá cũ trước.
CREATE UNIQUE INDEX IF NOT EXISTS profit_ledger_salary_lines_quote_uq
  ON app_private.profit_ledger_salary_settlement_vouchers (organization_id, staff_id, period_month) WHERE state = 'QUOTED';
CREATE INDEX IF NOT EXISTS profit_ledger_salary_lines_subject_idx
  ON app_private.profit_ledger_salary_settlement_vouchers (organization_id, shareholder_id, period_month);

-- C5. Nhật ký sổ tổng — chỉ ghi thêm.
CREATE TABLE IF NOT EXISTS app_private.profit_ledger_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  event_kind      text NOT NULL CHECK (event_kind IN (
                    'PAYOUT_CREATED', 'PAYOUT_APPROVED', 'PAYOUT_POSTED', 'PAYOUT_REJECTED', 'PAYOUT_CANCELLED',
                    'MARKER_SET',
                    'SALARY_FROZEN', 'SALARY_QUOTED', 'SALARY_LINKED', 'SALARY_NEEDS_REVIEW', 'SALARY_RESOLVED', 'SALARY_VOIDED')),
  subject_kind    text NOT NULL CHECK (subject_kind IN ('SHAREHOLDER', 'MANAGER')),
  shareholder_id  uuid,
  manager_id      uuid,
  voucher_id      uuid,
  settlement_id   uuid,
  line_id         uuid,
  marker_id       uuid,
  amount          numeric(15,2),
  balance_before  numeric(15,2),
  balance_after   numeric(15,2),
  actor_id        uuid,
  reason          text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT profit_ledger_events_subject_ck CHECK (
    (subject_kind = 'SHAREHOLDER' AND shareholder_id IS NOT NULL AND manager_id IS NULL)
    OR (subject_kind = 'MANAGER' AND manager_id IS NOT NULL AND shareholder_id IS NULL))
);
CREATE INDEX IF NOT EXISTS profit_ledger_events_subject_idx
  ON app_private.profit_ledger_events (organization_id, subject_kind, (COALESCE(shareholder_id, manager_id)), created_at);
CREATE INDEX IF NOT EXISTS profit_ledger_events_voucher_idx
  ON app_private.profit_ledger_events (voucher_id) WHERE voucher_id IS NOT NULL;

-- C6. Ngữ cảnh ghi theo giao dịch: lệnh lập / lệnh huỷ đánh dấu phiếu mình đang ghi,
--     trigger chốt chặn đọc lại. Dòng chỉ có nghĩa trong đúng giao dịch và phiên đã chèn nó;
--     writer xoá trước khi trả về.
CREATE TABLE IF NOT EXISTS app_private.profit_ledger_write_contexts (
  income_expense_id uuid NOT NULL,
  xid               xid8 NOT NULL DEFAULT pg_current_xact_id(),
  backend_pid       integer NOT NULL DEFAULT pg_backend_pid(),
  purpose           text NOT NULL CHECK (purpose IN ('CREATE', 'CANCEL')),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (income_expense_id, xid)
);

ALTER TABLE app_private.profit_ledger_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.profit_ledger_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.profit_ledger_salary_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.profit_ledger_salary_settlement_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.profit_ledger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.profit_ledger_write_contexts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON app_private.profit_ledger_markers,
              app_private.profit_ledger_payouts,
              app_private.profit_ledger_salary_settlements,
              app_private.profit_ledger_salary_settlement_vouchers,
              app_private.profit_ledger_events,
              app_private.profit_ledger_write_contexts
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.profit_ledger_markers IS
  'Mốc "đã trả đủ đến hết tháng X" của sổ tổng lợi nhuận (cổ đông / lương điều hành). Chỉ ghi thêm; mốc hiệu lực = dòng ledger_seq lớn nhất của chủ thể; settled_through_month NULL = gỡ mốc.';
COMMENT ON TABLE app_private.profit_ledger_payouts IS
  'Thông tin lúc lập của từng phiếu chi theo sổ tổng: số dư trước, phần trong số dư, phần tạm ứng, người lập, người nhận, thứ tự trong sổ. Chỉ ghi thêm (trừ điền approval_request_id một lần lúc lập).';
COMMENT ON TABLE app_private.profit_ledger_salary_settlements IS
  'Phần lợi nhuận trong lương của một tháng, đóng băng lúc chốt bảng lương. Bất biến: chỉ FROZEN → VOID.';
COMMENT ON TABLE app_private.profit_ledger_salary_settlement_vouchers IS
  'Phần lợi nhuận và phần trừ tạm ứng trong từng phiếu lương. Số dư sổ tổng chỉ trừ dòng LINKED có phiếu lương còn sống.';
COMMENT ON TABLE app_private.profit_ledger_events IS
  'Nhật ký sổ tổng lợi nhuận. Chỉ ghi thêm.';
COMMENT ON TABLE app_private.profit_ledger_write_contexts IS
  'Ngữ cảnh ghi theo giao dịch của lệnh lập / lệnh huỷ phiếu sổ tổng (CREATE | CANCEL). Chỉ có nghĩa trong giao dịch và phiên đã chèn.';

-- ── 5. Hàm lõi (nội bộ app_private; không cấp EXECUTE cho vai nào) ───────────

-- Ngữ cảnh ghi của phiếu trong GIAO DỊCH HIỆN TẠI: 'CREATE' | 'CANCEL' | NULL.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_write_context_v1(p_voucher_id uuid)
RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT c.purpose
    FROM app_private.profit_ledger_write_contexts c
   WHERE c.income_expense_id = p_voucher_id
     AND c.xid = pg_current_xact_id_if_assigned()
     AND c.backend_pid = pg_backend_pid()
$fn$;

-- Phiếu có còn "sống" với sổ tổng không: chưa xoá, là phiếu CHI, và hoặc đã duyệt,
-- hoặc chưa duyệt mà yêu cầu duyệt MỚI NHẤT chưa bị đóng theo hướng bỏ.
-- Không có yêu cầu duyệt, hoặc yêu cầu ở trạng thái khác danh sách bỏ (kể cả
-- CHANGES_REQUESTED / DISPUTED) ⇒ vẫn tính sống: nghi ngờ thì coi như tiền sẽ ra.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_voucher_live_v1(p_voucher_id uuid)
RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT COALESCE((
    SELECT ie.deleted_at IS NULL
       AND ie.type = 'EXPENSE'
       AND (ie.approval_status = 'APPROVED'
            OR (ie.approval_status = 'UNAPPROVED'
                AND COALESCE((
                      SELECT ar.state NOT IN ('DENIED', 'REJECTED', 'CANCELLED', 'WITHDRAWN', 'REVERSED')
                        FROM public.approval_requests ar
                       WHERE ar.organization_id = ie.organization_id
                         AND ar.subject_type = 'FINANCIAL_VOUCHER'
                         AND ar.subject_id = ie.id
                       ORDER BY ar.submission_no DESC
                       LIMIT 1), true)))
      FROM public.income_expenses ie
     WHERE ie.id = p_voucher_id), false)
$fn$;

-- Dòng mốc hiệu lực của chủ thể (ledger_seq lớn nhất); không có dòng nào ⇒ 0 dòng.
-- Dòng trả về có settled_through_month NULL nghĩa là mốc ĐÃ GỠ (coi như không có mốc).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_active_marker_v1(p_org uuid, p_kind text, p_subject uuid)
RETURNS TABLE(marker_id uuid, settled_through_month date, ledger_seq bigint, created_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT m.id, m.settled_through_month, m.ledger_seq, m.created_at
    FROM app_private.profit_ledger_markers m
   WHERE m.organization_id = p_org
     AND m.subject_kind = p_kind
     AND m.subject_id = p_subject
   ORDER BY m.ledger_seq DESC
   LIMIT 1
$fn$;

-- LÕI số dư sổ tổng của một chủ thể, theo MỘT MỐC TRUYỀN VÀO — công thức DUY NHẤT.
--   balance = phân bổ của các tháng đã chốt (kể cả dòng stale và dòng âm) sau mốc
--           − phiếu chi còn sống lập sau mốc (đã duyệt + chờ duyệt)
--           − (phần lợi nhuận − phần trừ tạm ứng) trong các phiếu lương LINKED còn sống sau mốc.
--   Dương = công ty còn nợ; âm = chủ thể đang tạm ứng.
-- Lương điều hành (MANAGER) dùng profit_manager_allocations và không có phần lương.
-- Mốc: p_marker_month NULL = không có mốc (bỏ qua p_marker_seq, p_marker_created_at).
--   Có tháng thì phiếu có dòng profit_ledger_payouts chỉ tính khi ledger_seq > p_marker_seq;
--   phiếu không có dòng đó chỉ tính khi created_at >= p_marker_created_at.
-- Mốc GIẢ ĐỊNH "đặt ngay bây giờ" (xem trước / đặt mốc): p_marker_seq = 9223372036854775807,
--   p_marker_created_at = 'infinity' ⇒ mọi phiếu hiện có đều nằm trước mốc.
-- profit_ledger_balance_v1 (số dư theo mốc hiệu lực) chỉ đọc mốc rồi gọi hàm này.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_balance_core_v1(
  p_org uuid,
  p_kind text,
  p_subject uuid,
  p_marker_month date,
  p_marker_seq bigint,
  p_marker_created_at timestamptz,
  p_exclude_voucher uuid DEFAULT NULL,
  p_exclude_salary_period date DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_has_marker   boolean := p_marker_month IS NOT NULL;
  v_shareholder  uuid;
  v_manager      uuid;
  v_alloc        numeric := 0;
  v_ex_alloc     numeric := 0;
  v_pay_approved numeric := 0;
  v_pay_pending  numeric := 0;
  v_ex_pay       numeric := 0;
  v_sal_invest   numeric := 0;
  v_sal_offset   numeric := 0;
  v_ex_sal       numeric := 0;
  v_nr_count     bigint := 0;
  v_nr_suggested numeric := 0;
BEGIN
  IF p_org IS NULL OR p_subject IS NULL OR p_kind IS NULL OR p_kind NOT IN ('SHAREHOLDER', 'MANAGER') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_SUBJECT: thiếu công ty/chủ thể hoặc loại chủ thể không hợp lệ'
      USING ERRCODE = '22023';
  END IF;
  IF p_exclude_salary_period IS NOT NULL AND EXTRACT(DAY FROM p_exclude_salary_period) <> 1 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_PERIOD: kỳ lương loại trừ phải là ngày đầu tháng' USING ERRCODE = '22023';
  END IF;
  -- Có tháng mốc thì phải có đủ thứ tự sổ và giờ: thiếu một trong hai thì phép so trả NULL và
  -- phiếu biến mất khỏi cả phần tính lẫn phần bị loại — số dư sai mà không báo.
  IF v_has_marker AND (EXTRACT(DAY FROM p_marker_month) IS DISTINCT FROM 1 OR p_marker_seq IS NULL OR p_marker_created_at IS NULL) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_MARKER: mốc phải là ngày đầu tháng và có đủ ledger_seq, created_at'
      USING ERRCODE = '22023';
  END IF;

  -- Chủ thể phải thuộc đúng công ty: cặp (công ty, chủ thể) lệch nhau không được trả "số dư 0".
  IF p_kind = 'SHAREHOLDER' THEN
    PERFORM 1 FROM public.shareholders s WHERE s.id = p_subject AND s.organization_id = p_org;
    v_shareholder := p_subject;
  ELSE
    PERFORM 1 FROM public.profit_managers m WHERE m.id = p_subject AND m.organization_id = p_org;
    v_manager := p_subject;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SUBJECT_NOT_FOUND: chủ thể không thuộc công ty này' USING ERRCODE = 'P0002';
  END IF;

  -- 1) Phân bổ của các tháng ĐÃ CHỐT. Lọc công ty bằng profit_monthly.organization_id
  --    (cột organization_id của hai bảng phân bổ cho phép NULL).
  IF p_kind = 'SHAREHOLDER' THEN
    SELECT COALESCE(sum(a.amount) FILTER (WHERE NOT v_has_marker OR pm.period_month > p_marker_month), 0),
           COALESCE(sum(a.amount) FILTER (WHERE v_has_marker AND pm.period_month <= p_marker_month), 0)
      INTO v_alloc, v_ex_alloc
      FROM public.profit_allocations a
      JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
     WHERE a.shareholder_id = v_shareholder
       AND pm.organization_id = p_org
       AND pm.status = 'LOCKED';
  ELSE
    SELECT COALESCE(sum(a.amount) FILTER (WHERE NOT v_has_marker OR pm.period_month > p_marker_month), 0),
           COALESCE(sum(a.amount) FILTER (WHERE v_has_marker AND pm.period_month <= p_marker_month), 0)
      INTO v_alloc, v_ex_alloc
      FROM public.profit_manager_allocations a
      JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
     WHERE a.manager_id = v_manager
       AND pm.organization_id = p_org
       AND pm.status = 'LOCKED';
  END IF;

  -- 2) Phiếu chi còn sống của chủ thể. Có mốc: chỉ tính phiếu vào sổ SAU mốc
  --    (so ledger_seq; phiếu cũ không có dòng profit_ledger_payouts thì so giờ tạo).
  SELECT COALESCE(sum(x.total_amount) FILTER (WHERE x.counted AND x.approval_status = 'APPROVED'), 0),
         COALESCE(sum(x.total_amount) FILTER (WHERE x.counted AND x.approval_status <> 'APPROVED'), 0),
         COALESCE(sum(x.total_amount) FILTER (WHERE NOT x.counted), 0)
    INTO v_pay_approved, v_pay_pending, v_ex_pay
    FROM (
      SELECT ie.total_amount, ie.approval_status,
             (NOT v_has_marker
              OR (c2.voucher_id IS NOT NULL AND c2.ledger_seq > p_marker_seq)
              OR (c2.voucher_id IS NULL AND ie.created_at >= p_marker_created_at)) AS counted
        FROM public.income_expenses ie
        LEFT JOIN app_private.profit_ledger_payouts c2 ON c2.voucher_id = ie.id
       WHERE ie.organization_id = p_org
         AND (ie.shareholder_id = v_shareholder OR ie.profit_manager_id = v_manager)
         AND ie.id IS DISTINCT FROM p_exclude_voucher
         AND app_private.profit_ledger_voucher_live_v1(ie.id)
    ) x;

  -- 3) Phần lợi nhuận đã trả qua lương (chỉ cổ đông).
  IF p_kind = 'SHAREHOLDER' THEN
    SELECT COALESCE(sum(x.investment_amount) FILTER (WHERE x.counted), 0),
           COALESCE(sum(x.advance_offset_amount) FILTER (WHERE x.counted), 0),
           COALESCE(sum(x.investment_amount - x.advance_offset_amount) FILTER (WHERE NOT x.counted), 0)
      INTO v_sal_invest, v_sal_offset, v_ex_sal
      FROM (
        SELECT l.investment_amount, l.advance_offset_amount,
               (NOT v_has_marker OR l.period_month > p_marker_month) AS counted
          FROM app_private.profit_ledger_salary_settlement_vouchers l
         WHERE l.organization_id = p_org
           AND l.shareholder_id = v_shareholder
           AND l.state = 'LINKED'
           AND l.period_month IS DISTINCT FROM p_exclude_salary_period
           AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id)
      ) x;

    -- Phiếu lương máy chưa đủ dữ kiện: không trừ vào số dư, chỉ báo ra (mọi kỳ, không xét mốc).
    SELECT count(*), COALESCE(sum(l.suggested_investment), 0)
      INTO v_nr_count, v_nr_suggested
      FROM app_private.profit_ledger_salary_settlement_vouchers l
     WHERE l.organization_id = p_org
       AND l.shareholder_id = v_shareholder
       AND l.state = 'NEEDS_REVIEW'
       AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id);
  END IF;

  RETURN jsonb_build_object(
    'allocated', v_alloc,
    'payouts_approved', v_pay_approved,
    'payouts_pending', v_pay_pending,
    'salary_investment', v_sal_invest,
    'salary_advance_offset', v_sal_offset,
    'balance', v_alloc - v_pay_approved - v_pay_pending - (v_sal_invest - v_sal_offset),
    -- Mốc ĐÃ ÁP cho phép tính này (id luôn null: lõi không biết dòng mốc nào). balance_v1 thay bằng dòng mốc hiệu lực.
    'marker', CASE WHEN v_has_marker THEN jsonb_build_object(
                'id', NULL::uuid,
                'settled_through_month', p_marker_month,
                'ledger_seq', p_marker_seq,
                'created_at', p_marker_created_at) END,
    'excluded_before_marker', jsonb_build_object('allocated', v_ex_alloc, 'payouts', v_ex_pay, 'salary', v_ex_sal),
    'needs_review', jsonb_build_object('count', v_nr_count, 'suggested', v_nr_suggested));
END
$fn$;

-- Số dư sổ tổng theo MỐC HIỆU LỰC của chủ thể. Không có công thức riêng: chỉ đọc mốc hiệu lực
-- (dòng gỡ mốc = tháng NULL = như chưa từng có mốc) rồi gọi lõi; trường marker là dòng mốc hiệu lực.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_balance_v1(
  p_org uuid,
  p_kind text,
  p_subject uuid,
  p_exclude_voucher uuid DEFAULT NULL,
  p_exclude_salary_period date DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_marker  record;
  v_has_row boolean;
BEGIN
  SELECT mk.marker_id, mk.settled_through_month, mk.ledger_seq, mk.created_at
    INTO v_marker
    FROM app_private.profit_ledger_active_marker_v1(p_org, p_kind, p_subject) mk;
  v_has_row := FOUND;

  RETURN app_private.profit_ledger_balance_core_v1(
           p_org, p_kind, p_subject,
           CASE WHEN v_has_row THEN v_marker.settled_through_month END,
           CASE WHEN v_has_row THEN v_marker.ledger_seq END,
           CASE WHEN v_has_row THEN v_marker.created_at END,
           p_exclude_voucher, p_exclude_salary_period)
         || jsonb_build_object('marker', CASE WHEN v_has_row THEN jsonb_build_object(
              'id', v_marker.marker_id,
              'settled_through_month', v_marker.settled_through_month,
              'ledger_seq', v_marker.ledger_seq,
              'created_at', v_marker.created_at) END);
END
$fn$;

-- Khoá của sổ một chủ thể (dùng chung cho hàm giữ khoá và hàm kiểm đang giữ).
-- Tham số thiếu ⇒ ném lỗi: khoá tư vấn với khoá NULL là không khoá gì.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_lock_key_v1(p_org uuid, p_kind text, p_subject uuid)
RETURNS bigint
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF p_org IS NULL OR p_subject IS NULL OR p_kind IS NULL OR p_kind NOT IN ('SHAREHOLDER', 'MANAGER') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_SUBJECT: thiếu công ty/chủ thể hoặc loại chủ thể không hợp lệ'
      USING ERRCODE = '22023';
  END IF;
  RETURN hashtextextended('profit-ledger:' || p_kind || ':' || p_org::text || ':' || p_subject::text, 0);
END
$fn$;

-- Giữ khoá tư vấn của sổ tới hết giao dịch. Writer gọi SAU khi đã giữ khoá tổ chức,
-- rồi mới nextval(profit_ledger_seq), đọc số dư và ghi.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_lock_v1(p_org uuid, p_kind text, p_subject uuid)
RETURNS void
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(app_private.profit_ledger_lock_key_v1(p_org, p_kind, p_subject));
END
$fn$;

-- Phiên hiện tại có đang giữ khoá sổ của chủ thể không (trigger của mốc và phiếu chi dùng).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_lock_held_v1(p_org uuid, p_kind text, p_subject uuid)
RETURNS boolean
 LANGUAGE sql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_locks l
     WHERE l.locktype = 'advisory'
       AND l.pid = pg_backend_pid()
       AND l.granted
       AND l.mode = 'ExclusiveLock'
       AND l.objsubid = 1
       AND ((l.classid::bigint << 32) | l.objid::bigint)
           = app_private.profit_ledger_lock_key_v1(p_org, p_kind, p_subject))
$fn$;

-- Ước tính lợi nhuận của các tháng CHƯA chốt (chỉ để cảnh báo, không chặn):
-- trung bình phần của cổ đông trong 3 tháng đã chốt gần nhất của công ty
-- × số tháng ĐÃ TRÔI QUA TRỌN VẸN mà chưa chốt (sau tháng chốt gần nhất, trước tháng hiện tại).
-- Tháng đang chạy không tính: chưa hết tháng thì chưa có lợi nhuận để ước.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_open_estimate_v1(p_org uuid, p_shareholder uuid)
RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_this_month date;
  v_last       date;
  v_avg        numeric;
  v_months     integer;
BEGIN
  IF p_org IS NULL OR p_shareholder IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_SUBJECT: thiếu công ty hoặc cổ đông' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.shareholders s WHERE s.id = p_shareholder AND s.organization_id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SUBJECT_NOT_FOUND: cổ đông không thuộc công ty này' USING ERRCODE = 'P0002';
  END IF;

  WITH thang AS (
    SELECT DISTINCT pm.period_month
      FROM public.profit_monthly pm
     WHERE pm.organization_id = p_org AND pm.status = 'LOCKED'
     ORDER BY pm.period_month DESC
     LIMIT 3
  )
  SELECT max(t.period_month),
         avg(COALESCE((
           SELECT sum(a.amount)
             FROM public.profit_allocations a
             JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
            WHERE a.shareholder_id = p_shareholder
              AND pm.organization_id = p_org
              AND pm.status = 'LOCKED'
              AND pm.period_month = t.period_month), 0))
    INTO v_last, v_avg
    FROM thang t;
  IF v_last IS NULL THEN
    RETURN 0;
  END IF;

  v_this_month := date_trunc('month', public.org_today_v1(p_org)::timestamp)::date;
  v_months := ((EXTRACT(YEAR FROM v_this_month) - EXTRACT(YEAR FROM v_last)) * 12
               + (EXTRACT(MONTH FROM v_this_month) - EXTRACT(MONTH FROM v_last)))::integer - 1;
  IF v_months <= 0 THEN
    RETURN 0;
  END IF;
  RETURN round(v_avg * v_months, 2);
END
$fn$;

-- ── 6. Trigger chốt chặn của các bảng sổ ─────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_append_only_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'PROFIT_LEDGER_APPEND_ONLY: % chỉ ghi thêm (thao tác %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END
$fn$;

-- C1: thứ tự sổ phải là số vừa lấy trong phiên, phiên phải đang giữ khoá sổ, và mốc mới
-- phải đứng sau mốc bị đè. created_at luôn do máy chủ đặt.
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_marker_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_prev_seq bigint;
BEGIN
  IF NEW.ledger_seq IS DISTINCT FROM currval('app_private.profit_ledger_seq'::regclass) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SEQ: ledger_seq phải là số vừa lấy từ profit_ledger_seq trong phiên này'
      USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.profit_ledger_lock_held_v1(
       NEW.organization_id, NEW.subject_kind, COALESCE(NEW.shareholder_id, NEW.manager_id)) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_NOT_SERIALIZED: phải giữ khoá sổ của chủ thể trước khi đặt mốc'
      USING ERRCODE = '55000';
  END IF;
  -- currval chỉ là "số lấy gần nhất của phiên": một số đã dùng cho dòng khác của cùng chủ thể vẫn khớp.
  -- Thứ tự sổ phải đứng SAU mọi dòng mốc và phiếu chi đã có của chủ thể (đang giữ khoá sổ nên tập này ổn định).
  IF NEW.ledger_seq <= COALESCE((
       SELECT max(x.seq) FROM (
         SELECT m.ledger_seq AS seq FROM app_private.profit_ledger_markers m
          WHERE m.organization_id = NEW.organization_id AND m.subject_kind = NEW.subject_kind
            AND m.subject_id = COALESCE(NEW.shareholder_id, NEW.manager_id)
         UNION ALL
         SELECT p.ledger_seq FROM app_private.profit_ledger_payouts p
          WHERE p.organization_id = NEW.organization_id AND p.subject_kind = NEW.subject_kind
            AND (p.shareholder_id = NEW.shareholder_id OR p.manager_id = NEW.manager_id)) x), 0) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SEQ: ledger_seq phải lớn hơn mọi thứ tự sổ đã có của chủ thể (không dùng lại số cũ)'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT m.ledger_seq INTO v_prev_seq
      FROM app_private.profit_ledger_markers m
     WHERE m.id = NEW.supersedes_id;
    IF v_prev_seq IS NULL OR NEW.ledger_seq <= v_prev_seq THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_MARKER_ORDER: mốc mới phải đứng sau mốc bị đè' USING ERRCODE = '55000';
    END IF;
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$fn$;

-- C2: chèn chỉ trong ngữ cảnh lập phiếu, khi đang giữ khoá sổ, với số thứ tự vừa lấy, và
-- phải khớp phiếu thật. Sau đó chỉ được điền approval_request_id một lần, cũng trong ngữ cảnh lập.
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_payout_row_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_ie record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ledger_seq IS DISTINCT FROM currval('app_private.profit_ledger_seq'::regclass) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_SEQ: ledger_seq phải là số vừa lấy từ profit_ledger_seq trong phiên này'
        USING ERRCODE = '55000';
    END IF;
    IF NOT app_private.profit_ledger_lock_held_v1(
         NEW.organization_id, NEW.subject_kind, COALESCE(NEW.shareholder_id, NEW.manager_id)) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_NOT_SERIALIZED: phải giữ khoá sổ của chủ thể trước khi ghi phiếu chi'
        USING ERRCODE = '55000';
    END IF;
    -- Như mốc: không dùng lại một số đã có của chủ thể (vd currval của mốc vừa đặt).
    IF NEW.ledger_seq <= COALESCE((
         SELECT max(x.seq) FROM (
           SELECT m.ledger_seq AS seq FROM app_private.profit_ledger_markers m
            WHERE m.organization_id = NEW.organization_id AND m.subject_kind = NEW.subject_kind
              AND m.subject_id = COALESCE(NEW.shareholder_id, NEW.manager_id)
           UNION ALL
           SELECT p.ledger_seq FROM app_private.profit_ledger_payouts p
            WHERE p.organization_id = NEW.organization_id AND p.subject_kind = NEW.subject_kind
              AND (p.shareholder_id = NEW.shareholder_id OR p.manager_id = NEW.manager_id)) x), 0) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_SEQ: ledger_seq phải lớn hơn mọi thứ tự sổ đã có của chủ thể (không dùng lại số cũ)'
        USING ERRCODE = '55000';
    END IF;
    IF COALESCE(app_private.profit_ledger_write_context_v1(NEW.voucher_id) <> 'CREATE', true) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_CONTEXT: chỉ lệnh lập phiếu sổ tổng mới được ghi dòng này'
        USING ERRCODE = '55000';
    END IF;
    SELECT ie.organization_id, ie.type, ie.deleted_at, ie.shareholder_id, ie.profit_manager_id,
           ie.total_amount, ie.account_id
      INTO v_ie
      FROM public.income_expenses ie
     WHERE ie.id = NEW.voucher_id;
    IF NOT FOUND
       OR v_ie.deleted_at IS NOT NULL
       OR v_ie.type IS DISTINCT FROM 'EXPENSE'
       OR v_ie.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_ie.shareholder_id IS DISTINCT FROM NEW.shareholder_id
       OR v_ie.profit_manager_id IS DISTINCT FROM NEW.manager_id
       OR v_ie.total_amount IS DISTINCT FROM NEW.amount
       OR v_ie.account_id IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_VOUCHER_MISMATCH: dòng sổ không khớp phiếu (công ty, người nhận, số tiền, sổ quỹ)'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.approval_request_id IS NULL
     AND NEW.approval_request_id IS NOT NULL
     AND (to_jsonb(NEW) - 'approval_request_id') = (to_jsonb(OLD) - 'approval_request_id')
     AND COALESCE(app_private.profit_ledger_write_context_v1(OLD.voucher_id) = 'CREATE', false)
     AND EXISTS (
       SELECT 1 FROM public.approval_requests ar
        WHERE ar.id = NEW.approval_request_id
          AND ar.organization_id = OLD.organization_id
          AND ar.subject_type = 'FINANCIAL_VOUCHER'
          AND ar.subject_id = OLD.voucher_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PROFIT_LEDGER_APPEND_ONLY: profit_ledger_payouts chỉ cho điền approval_request_id một lần lúc lập phiếu'
    USING ERRCODE = '55000';
END
$fn$;

-- C3: sinh ra ở FROZEN; chỉ chuyển FROZEN → VOID và chỉ đổi ba cột của việc huỷ.
-- Khi chèn, applied_offset_at_freeze do máy chủ tính (không tin giá trị truyền vào): nó nới trần
-- của advance_offset_month, nên người ghi không được tự khai.
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_salary_settlement_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'FROZEN' THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_STATE: bản đóng băng lương phải sinh ra ở FROZEN' USING ERRCODE = '55000';
    END IF;
    NEW.applied_offset_at_freeze := (
      SELECT COALESCE(sum(l.advance_offset_amount), 0)
        FROM app_private.profit_ledger_salary_settlement_vouchers l
       WHERE l.organization_id = NEW.organization_id
         AND l.shareholder_id = NEW.shareholder_id
         AND l.period_month = NEW.period_month
         AND l.state = 'LINKED'
         AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id));
    RETURN NEW;
  END IF;
  IF OLD.state = 'FROZEN' AND NEW.state = 'VOID'
     AND (to_jsonb(NEW) - ARRAY['state', 'voided_at', 'void_reason'])
       = (to_jsonb(OLD) - ARRAY['state', 'voided_at', 'void_reason']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PROFIT_LEDGER_STATE: bản đóng băng lương bất biến, chỉ chuyển FROZEN → VOID'
    USING ERRCODE = '55000';
END
$fn$;

-- C4: máy trạng thái của dòng phiếu lương.
--   QUOTED → LINKED        (gắn phiếu lương vừa lập)
--   QUOTED → VOID          (bị báo giá mới thay, hoặc quá hạn)
--   NEEDS_REVIEW → LINKED  (chủ xác nhận số; nguồn thành OWNER_RESOLVE)
-- LINKED và VOID không đổi nữa; phiếu lương bị huỷ thì hàm "phiếu còn sống" tự loại.
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_salary_line_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_changed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS NULL OR NEW.state NOT IN ('QUOTED', 'LINKED', 'NEEDS_REVIEW')
       OR NEW.source IS NOT DISTINCT FROM 'OWNER_RESOLVE' THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_STATE: dòng phiếu lương chỉ sinh ra ở QUOTED / LINKED / NEEDS_REVIEW và không sinh ra từ OWNER_RESOLVE'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(n.key), ARRAY[]::text[]) INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) n
   WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);

  IF OLD.state = 'QUOTED' AND NEW.state = 'LINKED'
     AND v_changed <@ ARRAY['state', 'salary_voucher_id', 'settlement_id', 'investment_amount',
                            'advance_offset_amount', 'linked_at']
     AND (OLD.settlement_id IS NULL OR NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id) THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'QUOTED' AND NEW.state = 'VOID'
     AND v_changed <@ ARRAY['state', 'voided_at', 'void_reason'] THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'NEEDS_REVIEW' AND NEW.state = 'LINKED' AND NEW.source = 'OWNER_RESOLVE'
     AND v_changed <@ ARRAY['state', 'source', 'settlement_id', 'investment_amount', 'advance_offset_amount',
                            'linked_at', 'resolved_by', 'resolved_at', 'resolve_reason']
     AND (OLD.settlement_id IS NULL OR NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PROFIT_LEDGER_STATE: chuyển trạng thái dòng phiếu lương không hợp lệ (% → %)', OLD.state, NEW.state
    USING ERRCODE = '55000';
END
$fn$;

-- C6: dòng ngữ cảnh luôn mang đúng giao dịch và phiên đang chèn (không tin giá trị truyền vào); không sửa.
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_write_context_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_CONTEXT: dòng ngữ cảnh không sửa được, chỉ chèn rồi xoá' USING ERRCODE = '55000';
  END IF;
  NEW.xid := pg_current_xact_id();
  NEW.backend_pid := pg_backend_pid();
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS a00_profit_ledger_markers_guard ON app_private.profit_ledger_markers;
CREATE TRIGGER a00_profit_ledger_markers_guard
  BEFORE INSERT ON app_private.profit_ledger_markers
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_marker_v1();
DROP TRIGGER IF EXISTS a00_profit_ledger_markers_append_only ON app_private.profit_ledger_markers;
CREATE TRIGGER a00_profit_ledger_markers_append_only
  BEFORE UPDATE OR DELETE ON app_private.profit_ledger_markers
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();
DROP TRIGGER IF EXISTS a00_profit_ledger_markers_no_truncate ON app_private.profit_ledger_markers;
CREATE TRIGGER a00_profit_ledger_markers_no_truncate
  BEFORE TRUNCATE ON app_private.profit_ledger_markers
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();

DROP TRIGGER IF EXISTS a00_profit_ledger_payouts_guard ON app_private.profit_ledger_payouts;
CREATE TRIGGER a00_profit_ledger_payouts_guard
  BEFORE INSERT OR UPDATE ON app_private.profit_ledger_payouts
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_payout_row_v1();
DROP TRIGGER IF EXISTS a00_profit_ledger_payouts_no_delete ON app_private.profit_ledger_payouts;
CREATE TRIGGER a00_profit_ledger_payouts_no_delete
  BEFORE DELETE ON app_private.profit_ledger_payouts
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();
DROP TRIGGER IF EXISTS a00_profit_ledger_payouts_no_truncate ON app_private.profit_ledger_payouts;
CREATE TRIGGER a00_profit_ledger_payouts_no_truncate
  BEFORE TRUNCATE ON app_private.profit_ledger_payouts
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();

DROP TRIGGER IF EXISTS a00_profit_ledger_salary_settlements_guard ON app_private.profit_ledger_salary_settlements;
CREATE TRIGGER a00_profit_ledger_salary_settlements_guard
  BEFORE INSERT OR UPDATE ON app_private.profit_ledger_salary_settlements
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_salary_settlement_v1();
DROP TRIGGER IF EXISTS a00_profit_ledger_salary_settlements_no_delete ON app_private.profit_ledger_salary_settlements;
CREATE TRIGGER a00_profit_ledger_salary_settlements_no_delete
  BEFORE DELETE ON app_private.profit_ledger_salary_settlements
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();
DROP TRIGGER IF EXISTS a00_profit_ledger_salary_settlements_no_truncate ON app_private.profit_ledger_salary_settlements;
CREATE TRIGGER a00_profit_ledger_salary_settlements_no_truncate
  BEFORE TRUNCATE ON app_private.profit_ledger_salary_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();

DROP TRIGGER IF EXISTS a00_profit_ledger_salary_lines_guard ON app_private.profit_ledger_salary_settlement_vouchers;
CREATE TRIGGER a00_profit_ledger_salary_lines_guard
  BEFORE INSERT OR UPDATE ON app_private.profit_ledger_salary_settlement_vouchers
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_salary_line_v1();
DROP TRIGGER IF EXISTS a00_profit_ledger_salary_lines_no_delete ON app_private.profit_ledger_salary_settlement_vouchers;
CREATE TRIGGER a00_profit_ledger_salary_lines_no_delete
  BEFORE DELETE ON app_private.profit_ledger_salary_settlement_vouchers
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();
DROP TRIGGER IF EXISTS a00_profit_ledger_salary_lines_no_truncate ON app_private.profit_ledger_salary_settlement_vouchers;
CREATE TRIGGER a00_profit_ledger_salary_lines_no_truncate
  BEFORE TRUNCATE ON app_private.profit_ledger_salary_settlement_vouchers
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();

DROP TRIGGER IF EXISTS a00_profit_ledger_events_append_only ON app_private.profit_ledger_events;
CREATE TRIGGER a00_profit_ledger_events_append_only
  BEFORE UPDATE OR DELETE ON app_private.profit_ledger_events
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();
DROP TRIGGER IF EXISTS a00_profit_ledger_events_no_truncate ON app_private.profit_ledger_events;
CREATE TRIGGER a00_profit_ledger_events_no_truncate
  BEFORE TRUNCATE ON app_private.profit_ledger_events
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();

DROP TRIGGER IF EXISTS a00_profit_ledger_write_contexts_guard ON app_private.profit_ledger_write_contexts;
CREATE TRIGGER a00_profit_ledger_write_contexts_guard
  BEFORE INSERT OR UPDATE ON app_private.profit_ledger_write_contexts
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_write_context_v1();

-- ── 7. ACL hàm: nội bộ, không vai nào được gọi thẳng ─────────────────────────
REVOKE ALL ON FUNCTION app_private.profit_ledger_write_context_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_voucher_live_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_active_marker_v1(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_balance_core_v1(uuid, text, uuid, date, bigint, timestamptz, uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_balance_v1(uuid, text, uuid, uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_lock_key_v1(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_lock_v1(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_lock_held_v1(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_open_estimate_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_append_only_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_marker_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_payout_row_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_salary_settlement_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_salary_line_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_write_context_v1() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.profit_ledger_voucher_live_v1(uuid) IS
  'Phiếu còn sống với sổ tổng lợi nhuận: chưa xoá, là phiếu CHI, đã duyệt hoặc chưa duyệt mà yêu cầu duyệt mới nhất chưa DENIED/REJECTED/CANCELLED/WITHDRAWN/REVERSED. Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_active_marker_v1(uuid, text, uuid) IS
  'Dòng mốc hiệu lực (ledger_seq lớn nhất) của một chủ thể sổ tổng; settled_through_month NULL = mốc đã gỡ. Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_balance_core_v1(uuid, text, uuid, date, bigint, timestamptz, uuid, date) IS
  'LÕI số dư sổ tổng lợi nhuận (công thức duy nhất) theo một mốc truyền vào: phân bổ tháng đã chốt − phiếu chi còn sống − phần lợi nhuận đã trả qua lương, sau mốc. p_marker_month NULL = không có mốc (p_marker_seq, p_marker_created_at bị bỏ qua). Có tháng thì bắt buộc có ledger_seq và created_at: phiếu có dòng profit_ledger_payouts tính khi ledger_seq > p_marker_seq, phiếu không có dòng đó tính khi created_at >= p_marker_created_at. Mốc GIẢ ĐỊNH "đặt ngay bây giờ" (xem trước / đặt mốc): p_marker_seq = 9223372036854775807, p_marker_created_at = ''infinity'' ⇒ mọi phiếu hiện có đều nằm trước mốc. Kết quả cùng hình dạng profit_ledger_balance_v1; trường marker = mốc đã áp (id null) hoặc null. Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_balance_v1(uuid, text, uuid, uuid, date) IS
  'Số dư sổ tổng lợi nhuận của một cổ đông / người nhận lương điều hành theo MỐC HIỆU LỰC: đọc mốc hiệu lực rồi gọi profit_ledger_balance_core_v1 (không có công thức riêng). Trường marker = dòng mốc hiệu lực (kể cả dòng gỡ mốc, tháng null). Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_lock_v1(uuid, text, uuid) IS
  'Giữ khoá tư vấn của sổ một chủ thể tới hết giao dịch. Gọi sau khi đã giữ khoá tổ chức; rồi mới nextval(app_private.profit_ledger_seq), đọc số dư và ghi.';
COMMENT ON FUNCTION app_private.profit_ledger_lock_held_v1(uuid, text, uuid) IS
  'Phiên hiện tại có đang giữ khoá tư vấn của sổ chủ thể không.';
COMMENT ON FUNCTION app_private.profit_ledger_open_estimate_v1(uuid, uuid) IS
  'Ước tính lợi nhuận các tháng chưa chốt của một cổ đông: trung bình 3 tháng đã chốt gần nhất × số tháng trọn vẹn chưa chốt. Chỉ để cảnh báo. Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_write_context_v1(uuid) IS
  'Ngữ cảnh ghi (CREATE | CANCEL | NULL) của một phiếu sổ tổng trong giao dịch hiện tại.';

-- Z. Hậu kiểm. Đúng ở cả lượt một lẫn lượt chạy lại.
DO $assert$
DECLARE
  v_n    integer;
  v_xau  text;
  v_moi  text[];
  c_tables constant text[] := ARRAY[
    'app_private.profit_ledger_markers', 'app_private.profit_ledger_payouts',
    'app_private.profit_ledger_salary_settlements', 'app_private.profit_ledger_salary_settlement_vouchers',
    'app_private.profit_ledger_events', 'app_private.profit_ledger_write_contexts'];
  c_fns constant text[] := ARRAY[
    'app_private.profit_ledger_write_context_v1(uuid)',
    'app_private.profit_ledger_voucher_live_v1(uuid)',
    'app_private.profit_ledger_active_marker_v1(uuid,text,uuid)',
    'app_private.profit_ledger_balance_core_v1(uuid,text,uuid,date,bigint,timestamptz,uuid,date)',
    'app_private.profit_ledger_balance_v1(uuid,text,uuid,uuid,date)',
    'app_private.profit_ledger_lock_key_v1(uuid,text,uuid)',
    'app_private.profit_ledger_lock_v1(uuid,text,uuid)',
    'app_private.profit_ledger_lock_held_v1(uuid,text,uuid)',
    'app_private.profit_ledger_open_estimate_v1(uuid,uuid)',
    'app_private.guard_profit_ledger_append_only_v1()',
    'app_private.guard_profit_ledger_marker_v1()',
    'app_private.guard_profit_ledger_payout_row_v1()',
    'app_private.guard_profit_ledger_salary_settlement_v1()',
    'app_private.guard_profit_ledger_salary_line_v1()',
    'app_private.guard_profit_ledger_write_context_v1()'];
BEGIN
  -- 1. Đủ ba khoá. Khoá VỪA tạo trong giao dịch này (biến ihomecrm.m1_khoa_moi, kể cả do lượt trước trong
  --    cùng giao dịch) phải đúng hình dạng; khoá đã có từ trước thì không khẳng định gì thêm — migration
  --    không sở hữu trạng thái mà migration sau hay chủ đã đổi.
  v_moi := COALESCE(string_to_array(NULLIF(current_setting('ihomecrm.m1_khoa_moi', true), ''), ','), ARRAY[]::text[]);
  IF (SELECT count(*) FROM public.permission_definitions d
       WHERE d.key IN ('shareholder_profit.advance_own_cashbook', 'shareholder_profit.view_percent',
                       'shareholder_profit.view_building_totals')) <> 3 THEN
    RAISE EXCEPTION 'Hậu kiểm: thiếu khoá quyền shareholder_profit.advance_own_cashbook / view_percent / view_building_totals'
      USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_n
    FROM public.permission_definitions d
   WHERE d.key = ANY (v_moi)
     AND (d.key, d.resource, d.action, d.sensitivity) IN (
           ('shareholder_profit.advance_own_cashbook', 'shareholder_profit', 'advance_own_cashbook', 'ELEVATED'),
           ('shareholder_profit.view_percent', 'shareholder_profit', 'view_percent', 'MANAGE'),
           ('shareholder_profit.view_building_totals', 'shareholder_profit', 'view_building_totals', 'MANAGE'))
     AND d.permission_domain = 'TENANT'
     AND d.is_active
     AND d.scope_kinds = ARRAY['ORGANIZATION']::text[]
     AND d.scope_match_mode = 'ANY_MATCH'
     AND NOT d.requires_cashbook_possession
     AND d.accepted_possession_kinds = ARRAY[]::text[]
     AND d.required_dimensions = ARRAY[]::text[];
  IF v_n <> cardinality(v_moi) THEN
    RAISE EXCEPTION 'Hậu kiểm: khoá vừa tạo sai hình dạng (đúng % / vừa tạo %)', v_n, cardinality(v_moi) USING ERRCODE = '55000';
  END IF;

  -- 2. Quyền tạm ứng vừa tạo: không vai nào có.
  IF 'shareholder_profit.advance_own_cashbook' = ANY (v_moi)
     AND EXISTS (SELECT 1 FROM public.role_permissions rp
                  WHERE rp.permission_key = 'shareholder_profit.advance_own_cashbook') THEN
    RAISE EXCEPTION 'Hậu kiểm: có vai mang shareholder_profit.advance_own_cashbook' USING ERRCODE = '55000';
  END IF;

  -- 3. Quyền xem vừa tạo: chỉ vai chủ công ty có, chỉ ALLOW, và mọi vai chủ đều có.
  IF EXISTS (
    SELECT 1
      FROM public.role_permissions rp
      LEFT JOIN public.organization_roles r ON r.id = rp.role_id AND r.organization_id = rp.organization_id
     WHERE rp.permission_key IN ('shareholder_profit.view_percent', 'shareholder_profit.view_building_totals')
       AND rp.permission_key = ANY (v_moi)
       AND (rp.effect IS DISTINCT FROM 'ALLOW'
            OR NOT COALESCE(r.system_key = 'TENANT_OWNER'
                            OR (r.system_key IS NULL AND r.name IN ('Chủ sở hữu tổ chức', 'Chủ công ty')), false))) THEN
    RAISE EXCEPTION 'Hậu kiểm: quyền xem tỷ lệ / số toà nằm ở vai không phải chủ công ty' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.organization_roles r
      CROSS JOIN unnest(v_moi) AS k(key)
     WHERE k.key IN ('shareholder_profit.view_percent', 'shareholder_profit.view_building_totals')
       AND (r.system_key = 'TENANT_OWNER' OR (r.system_key IS NULL AND r.name IN ('Chủ sở hữu tổ chức', 'Chủ công ty')))
       AND NOT EXISTS (
         SELECT 1 FROM public.role_permissions rp
          WHERE rp.organization_id = r.organization_id AND rp.role_id = r.id
            AND rp.permission_key = k.key AND rp.effect = 'ALLOW')) THEN
    RAISE EXCEPTION 'Hậu kiểm: có vai chủ công ty chưa được gieo quyền xem' USING ERRCODE = '55000';
  END IF;

  -- 4. Công tắc tồn tại (không khẳng định chế độ: lượt chạy lại không đặt lại).
  IF NOT EXISTS (SELECT 1 FROM app_private.server_feature_flags f
                  WHERE f.feature_key = 'shareholder_profit.ledger_payout.v1' AND f.risk_class = 'MONEY') THEN
    RAISE EXCEPTION 'Hậu kiểm: thiếu công tắc shareholder_profit.ledger_payout.v1' USING ERRCODE = '55000';
  END IF;

  -- 5. Bảng: đủ sáu, RLS bật, không ai ngoài chủ bảng có quyền.
  SELECT string_agg(t.ten, ', ') INTO v_xau
    FROM unnest(c_tables) AS t(ten)
    LEFT JOIN pg_catalog.pg_class c ON c.oid = to_regclass(t.ten)
   WHERE c.oid IS NULL
      OR NOT c.relrowsecurity
      OR EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner)
      OR has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR has_table_privilege('service_role', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: bảng thiếu, chưa bật RLS hoặc còn ACL cho vai khác: %', v_xau USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
              WHERE c.oid = 'app_private.profit_ledger_seq'::regclass AND a.grantee <> c.relowner)
     OR has_sequence_privilege('authenticated', 'app_private.profit_ledger_seq', 'USAGE, SELECT, UPDATE')
     OR has_sequence_privilege('anon', 'app_private.profit_ledger_seq', 'USAGE, SELECT, UPDATE')
     OR has_sequence_privilege('service_role', 'app_private.profit_ledger_seq', 'USAGE, SELECT, UPDATE') THEN
    RAISE EXCEPTION 'Hậu kiểm: sequence profit_ledger_seq còn ACL cho vai khác' USING ERRCODE = '55000';
  END IF;

  -- 6. Hàm: đủ, ghim search_path, không ai ngoài chủ hàm có EXECUTE (kể cả PUBLIC).
  SELECT string_agg(f.ten, ', ') INTO v_xau
    FROM unnest(c_fns) AS f(ten)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(f.ten)
   WHERE p.oid IS NULL
      OR p.proacl IS NULL
      OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner)
      OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%');
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: hàm thiếu, chưa ghim search_path hoặc còn EXECUTE cho vai khác: %', v_xau
      USING ERRCODE = '55000';
  END IF;

  -- Hàm đọc phải STABLE (RPC đọc sẽ gọi trong giao dịch chỉ đọc); hàm giữ khoá phải VOLATILE.
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.oid IN (to_regprocedure('app_private.profit_ledger_write_context_v1(uuid)'),
                       to_regprocedure('app_private.profit_ledger_voucher_live_v1(uuid)'),
                       to_regprocedure('app_private.profit_ledger_active_marker_v1(uuid,text,uuid)'),
                       to_regprocedure('app_private.profit_ledger_balance_core_v1(uuid,text,uuid,date,bigint,timestamptz,uuid,date)'),
                       to_regprocedure('app_private.profit_ledger_balance_v1(uuid,text,uuid,uuid,date)'),
                       to_regprocedure('app_private.profit_ledger_open_estimate_v1(uuid,uuid)'))
         AND p.provolatile = 's' AND p.prosecdef) <> 6
     OR (SELECT p.provolatile FROM pg_catalog.pg_proc p
          WHERE p.oid = to_regprocedure('app_private.profit_ledger_lock_v1(uuid,text,uuid)')) <> 'v' THEN
    RAISE EXCEPTION 'Hậu kiểm: volatility / SECURITY DEFINER của hàm lõi không đúng' USING ERRCODE = '55000';
  END IF;

  -- 7. Unique (id, organization_id) trên profit_managers cho khoá ngoại kép.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
     WHERE i.indexrelid = to_regclass('public.profit_managers_id_org_uq')
       AND i.indrelid = 'public.profit_managers'::regclass
       AND i.indisunique AND i.indisvalid AND i.indpred IS NULL) THEN
    RAISE EXCEPTION 'Hậu kiểm: thiếu unique index profit_managers_id_org_uq' USING ERRCODE = '55000';
  END IF;

  -- 8. C3 đúng hình dạng mới: CREATE TABLE IF NOT EXISTS sẽ giữ nguyên một bảng dựng từ bản nháp cũ của
  --    chính file này (thiếu cột phần đã trừ, CHECK trần cũ) — khi đó dừng thay vì để trigger hỏng lúc chạy.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = 'app_private.profit_ledger_salary_settlements'::regclass
                    AND a.attname = 'applied_offset_at_freeze' AND a.attnotnull AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                     WHERE c.conrelid = 'app_private.profit_ledger_salary_settlements'::regclass
                       AND c.conname = 'profit_ledger_salary_settlements_offset_ck'
                       AND pg_get_constraintdef(c.oid) LIKE '%applied_offset_at_freeze%') THEN
    RAISE EXCEPTION 'Hậu kiểm: profit_ledger_salary_settlements thiếu cột applied_offset_at_freeze hoặc còn CHECK trần cũ'
      USING ERRCODE = '55000';
  END IF;
END
$assert$;

COMMIT;
