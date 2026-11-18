-- =============================================================================
-- Tạm ứng cổ đông + Chi lợi nhuận chốt theo tháng (phần MÁY CHỦ).
--
-- VÌ SAO
--   Chủ tách hai nghiệp vụ trên cùng sổ tổng lợi nhuận (Đợt 1, 20261115063149…084108):
--     A = lợi nhuận được chia, CHƯA CHI — tăng khi chốt lợi nhuận tháng, chỉ giảm khi chủ CHỐT
--         (chi lợi nhuận đến hết tháng N) hoặc khi lương trả phần lợi nhuận của tháng;
--     B = tạm ứng ĐANG CÓ — mỗi phiếu tạm ứng cộng thêm, chỉ giảm khi được khấu trừ lúc chủ chốt
--         (hoặc lương bù tạm ứng — cơ chế sẵn có).
--   Chốt đến hết tháng N: X = lợi nhuận chưa chi của các tháng ≤ N; K = min(X, tạm ứng ĐÃ DUYỆT
--   đang có); tiền thực chi = X − K. Tiền > 0 ⇒ MỘT phiếu chi chờ duyệt; tiền = 0 ⇒ không phiếu,
--   bản ghi chốt có hiệu lực ngay.
--
-- NGUYÊN TẮC
--   - Số dư ròng KHÔNG đổi: app_private.profit_ledger_balance_core_v1 / balance_v1 giữ nguyên. A, B là
--     lớp PHÂN LOẠI trên số dư ròng, bất biến A − B_đã_duyệt − B_chờ_duyệt = balance (tự kiểm, lệch ⇒ XX000).
--   - CHỈ THÊM: không CREATE OR REPLACE hàm nào đã phát hành. Hai ngoại lệ, đều là THÊM chốt lên bảng cũ:
--     (1) nới CHECK maker_kind của app_private.profit_ledger_payouts (thêm 'CUSTODIAN_FOR_PAYEE');
--     (2) thêm MỘT trigger mới lên app_private.profit_ledger_markers (a10_profit_ledger_markers_settlement_guard):
--         lệnh đặt mốc của Đợt 1 (không biết bản ghi chốt) từ nay từ chối thêm đúng một trường hợp — mốc "đã trả
--         đủ" của cổ đông đặt SỚM hơn tháng đã chốt chi còn hiệu lực (xem mục 2b).
--     Lệnh cũ public.shareholder_profit_ledger_payout_v1 (E5) để nguyên, vẫn chạy.
--   - Mọi phiếu vẫn mang system_source 'profit.ledger_payout' ⇒ các chốt F1 / F1b / F2 / F4 / F5, lệnh
--     huỷ E6 và báo cáo dòng tiền áp nguyên như cũ. Phân biệt: (a) bản ghi chốt trỏ tới phiếu tiền,
--     (b) hạng mục của dòng phiếu, (c) dòng sổ: tạm ứng within_amount = 0, advance_amount = amount;
--     phiếu tiền của lần chốt within_amount = amount, advance_amount = 0.
--   - Phần "đến hết tháng N" lấy bằng mốc GIẢ ĐỊNH của lõi số dư (không có câu cộng phân bổ thứ hai
--     để ra số tiền; liệt kê từng tháng chỉ để hiển thị và được đối chiếu với lõi).
--   - Không lệnh nào tự ném mã lớp 40; so-rồi-ghi dùng PT409.
--
-- LÀM GÌ
--   1. app_private.profit_ledger_payouts.maker_kind nhận thêm 'CUSTODIAN_FOR_PAYEE' (người giữ sổ lập
--      phiếu tạm ứng cho NGƯỜI KHÁC) + CHECK hình dạng của giá trị đó.
--   2. Bảng app_private.profit_ledger_payout_settlements — bản ghi chốt chi lợi nhuận (chỉ ghi thêm;
--      chỉ ACTIVE → VOID khi không có phiếu tiền). "Còn hiệu lực" = ACTIVE và (không có phiếu tiền
--      hoặc phiếu tiền còn sống) ⇒ phiếu tiền bị huỷ / từ chối thì bản ghi tự hết hiệu lực.
--   2b. Trigger a10_profit_ledger_markers_settlement_guard trên app_private.profit_ledger_markers: mốc "đã trả đủ
--      đến hết tháng X" của một cổ đông không được đặt ở tháng SỚM hơn tháng của một bản ghi chốt còn hiệu lực
--      (55000 PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT). Không chặn thì bản ghi chốt và phiếu tạm ứng rơi về trước
--      mốc, các tháng đã chốt chi hiện lại "chưa chi" và bị chi lần hai. Gỡ mốc, mốc từ tháng chốt trở đi và mốc
--      của lương điều hành: không đổi.
--   3. Hạng mục chi "Tạm Ứng" (rule_key tam_ung_co_dong) cho mọi công ty đang có hạng mục chia_loi_nhuan.
--   4. Hàm nội bộ: vị thế A / B (profit_ledger_position_v1), lợi nhuận chưa chi đến hết tháng N
--      (profit_ledger_unpaid_through_v1), và các trợ giúp profit_ledger_chot_*.
--   5. RPC: xem vị thế (chủ / cổ đông tự xem), lựa chọn + xem trước + lập phiếu tạm ứng ở Thu chi,
--      xem trước + chốt chi lợi nhuận, huỷ bản ghi chốt không có phiếu tiền.
--
-- KHÔNG LÀM: không đổi công tắc shareholder_profit.ledger_payout.v1; không thu quyền lệnh cũ E5
--   (migration sau, khi web mới đã lên production); không sửa F1 / F4 / E6 / dòng tiền; không đụng lương.
--   Lệnh lập tạm ứng dựng từ thân E5 của 20261115084108 (md5 thân ghi trong test để biết khi E5 đổi).
--
-- AN TOÀN CHẠY LẠI: CREATE TABLE / INDEX IF NOT EXISTS, CREATE OR REPLACE cho hàm của chính file này,
--   DROP TRIGGER IF EXISTS + CREATE TRIGGER, CHECK chỉ thêm khi chưa có, hạng mục chỉ chèn khi thiếu.
--   Hậu kiểm chỉ khẳng định cờ của hạng mục VỪA chèn (chủ đổi cờ về sau không làm lượt chạy lại dừng).
-- LÙI (migration forward mới): DROP tám RPC public của file này (web mới phải gỡ trước); các hàm nội bộ
--   và bảng bản ghi chốt để nguyên là vô hại (không ai gọi). KHÔNG thu hẹp lại CHECK maker_kind khi đã
--   có dòng 'CUSTODIAN_FOR_PAYEE'. Hạng mục "Tạm Ứng" đã có phiếu thì giữ; chưa có phiếu thì xoá được.
--   Lệnh đặt mốc cũ muốn về đúng hành vi Đợt 1: DROP TRIGGER a10_profit_ledger_markers_settlement_guard
--   ON app_private.profit_ledger_markers (chỉ làm khi không còn bản ghi chốt nào còn hiệu lực, hoặc chấp nhận
--   lại rủi ro chi hai lần nêu ở mục 2b).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Tiền kiểm: nền Đợt 1 phải có đủ. Thiếu ⇒ dừng 55000.
DO $truoc$
DECLARE
  v_thieu text;
BEGIN
  SELECT string_agg(x.sig, ', ' ORDER BY x.sig) INTO v_thieu
    FROM (VALUES
      ('app_private.profit_ledger_balance_v1(uuid,text,uuid,uuid,date)', 'jsonb'),
      ('app_private.profit_ledger_balance_core_v1(uuid,text,uuid,date,bigint,timestamptz,uuid,date)', 'jsonb'),
      ('app_private.profit_ledger_active_marker_v1(uuid,text,uuid)', 'record'),
      ('app_private.profit_ledger_voucher_live_v1(uuid)', 'boolean'),
      ('app_private.profit_ledger_lock_v1(uuid,text,uuid)', 'void'),
      ('app_private.profit_ledger_lock_held_v1(uuid,text,uuid)', 'boolean'),
      ('app_private.profit_ledger_open_estimate_v1(uuid,uuid)', 'numeric'),
      ('app_private.profit_ledger_write_context_v1(uuid)', 'text'),
      ('app_private.guard_profit_ledger_append_only_v1()', 'trigger'),
      ('app_private.profit_viewer_can_v1(uuid,text)', 'boolean'),
      ('app_private.profit_ledger_doc_can_v1(uuid,text[])', 'boolean'),
      ('app_private.profit_ledger_tao_assert_route_v1(uuid,text[])', 'text'),
      ('app_private.profit_ledger_tao_warnings_v1(numeric,numeric,numeric)', 'jsonb'),
      ('app_private.guard_profit_ledger_payout_v1()', 'trigger'),
      ('app_private.guard_profit_payout_scope_compat_v1()', 'trigger'),
      ('public.shareholder_profit_ledger_payout_v1(uuid,numeric,uuid,date,text,boolean,text)', 'jsonb'),
      ('public.profit_ledger_payout_cancel_v1(uuid,text,text,text)', 'jsonb'),
      ('app_private.evaluate_feature_route(text,uuid)', 'text'),
      ('app_private.lock_org_for_decision_v1(uuid)', 'bigint'),
      ('app_private.claim_feature_operation_v1(text,uuid,text,uuid,text,numeric)', 'void'),
      ('app_private.assert_cashbook_access_v2(uuid,uuid,text,uuid)', 'void'),
      ('app_private.submit_financial_request_v1(uuid,uuid,uuid,text)', 'uuid'),
      ('app_private.begin_accounting_chain_write_v1()', NULL),
      ('app_private.end_accounting_chain_write_v1()', NULL),
      ('app_private.profit_month_locked_v1(uuid,date)', 'boolean'),
      ('app_private.cashbook_closed_through_v1(uuid)', 'date'),
      ('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)', NULL),
      ('public.normalize_income_expense_type_name(text)', 'text')
    ) AS x(sig, ret)
   WHERE to_regprocedure(x.sig) IS NULL
      OR (x.ret IS NOT NULL
          AND (SELECT p.prorettype FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.sig)) <> x.ret::regtype);
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu hàm nền của sổ tổng lợi nhuận (Đợt 1 phải áp trước): %', v_thieu USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(x.rel || '.' || c.col, ', ' ORDER BY x.rel, c.col) INTO v_thieu
    FROM (VALUES
      ('app_private.profit_ledger_payouts', ARRAY['voucher_id', 'organization_id', 'subject_kind', 'shareholder_id', 'account_id',
         'amount', 'balance_before', 'within_amount', 'advance_amount', 'open_estimate', 'warnings', 'maker_user_id',
         'maker_membership_id', 'maker_kind', 'payee_is_maker', 'payee_user_id', 'approval_request_id', 'ledger_seq']),
      ('app_private.profit_ledger_markers', ARRAY['organization_id', 'subject_kind', 'subject_id', 'shareholder_id',
         'settled_through_month', 'ledger_seq']),
      ('app_private.profit_ledger_events', ARRAY['organization_id', 'event_kind', 'subject_kind', 'shareholder_id', 'voucher_id',
         'amount', 'balance_before', 'balance_after', 'actor_id', 'payload']),
      ('app_private.profit_ledger_write_contexts', ARRAY['income_expense_id', 'purpose']),
      ('app_private.canonical_write_operations', ARRAY['organization_id', 'operation', 'subject_scope', 'actor_id',
         'idempotency_key', 'payload_hash', 'subject_id', 'response_payload', 'completed_at', 'actor_membership_id']),
      ('public.income_expense_types', ARRAY['id', 'organization_id', 'name', 'type', 'category', 'description', 'rule_key',
         'is_default', 'is_deposit', 'is_restricted', 'force_approval', 'system_only', 'manual_hidden', 'quick_entry_hidden',
         'internal_transfer', 'user_id', 'created_at']),
      ('public.income_expenses', ARRAY['id', 'user_id', 'organization_id', 'creator_name', 'type', 'name', 'code', 'building_id',
         'account_id', 'shareholder_id', 'total_amount', 'business_result_accounting', 'approval_status', 'posting_status',
         'voucher_date', 'attachments', 'repeat_cycle', 'repeat_infinity', 'repeat_count', 'repeat_remaining',
         'source_payload_hash', 'system_source', 'idempotency_key', 'maker_user_id', 'maker_membership_id']),
      ('public.income_expense_items', ARRAY['income_expense_id', 'organization_id', 'income_expense_type_id', 'description',
         'quantity', 'unit_price', 'amount', 'start_date', 'end_date', 'accounting_class']),
      ('public.approval_requests', ARRAY['id', 'state']),
      ('public.shareholders', ARRAY['id', 'organization_id', 'auth_user_id', 'name', 'is_active', 'deleted_at']),
      ('public.buildings', ARRAY['id', 'organization_id', 'user_id', 'is_virtual', 'deleted_at', 'created_at']),
      ('public.accounts', ARRAY['id', 'organization_id', 'name', 'is_virtual', 'deleted_at']),
      ('public.organization_memberships', ARRAY['id', 'user_id', 'organization_id', 'status', 'valid_from', 'valid_to']),
      ('public.profit_monthly', ARRAY['id', 'organization_id', 'period_month', 'status']),
      ('public.profit_allocations', ARRAY['profit_monthly_id', 'shareholder_id', 'amount']),
      ('public.profiles', ARRAY['id', 'full_name', 'email'])
    ) AS x(rel, cols)
    CROSS JOIN LATERAL unnest(x.cols) AS c(col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass(x.rel) AND a.attname = c.col AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu bảng/cột nền: %', v_thieu USING ERRCODE = '55000';
  END IF;

  -- Chỉ khẳng định thứ Đợt 1 tự gieo (sequence, công tắc, khoá quyền tạm ứng). Khoá shareholder_profit.distribute gieo
  -- từ trước mốc baseline: bản dựng lại schema-only của diễn tập khôi phục không mang dòng đó, và thiếu khoá thì
  -- authorize_tenant_action_v3 tự từ chối (fail-closed) — không khẳng định ở đây.
  IF to_regclass('app_private.profit_ledger_seq') IS NULL
     OR NOT EXISTS (SELECT 1 FROM app_private.server_feature_flags f WHERE f.feature_key = 'shareholder_profit.ledger_payout.v1')
     OR NOT EXISTS (SELECT 1 FROM public.permission_definitions d WHERE d.key = 'shareholder_profit.advance_own_cashbook') THEN
    RAISE EXCEPTION 'Thiếu nền sổ tổng (sequence profit_ledger_seq, công tắc shareholder_profit.ledger_payout.v1 hoặc khoá quyền shareholder_profit.advance_own_cashbook)'
      USING ERRCODE = '55000';
  END IF;

  -- Phiếu của file này dựa vào các chốt của Đợt 1: thiếu chốt thì không được mở thêm đường lập phiếu.
  -- (Chốt của bảng mốc: trigger mới của file này chạy SAU nó và dựa vào việc nó đã bắt giữ khoá sổ.)
  SELECT string_agg(x.ten, ', ' ORDER BY x.ten) INTO v_thieu
    FROM (VALUES
      ('a06_profit_ledger_payout_guard', 'public.income_expenses', 'app_private.guard_profit_ledger_payout_v1()'),
      ('a00_00_profit_payout_account_guard', 'public.income_expenses', 'app_private.guard_profit_payout_scope_compat_v1()'),
      ('a00_profit_ledger_payouts_guard', 'app_private.profit_ledger_payouts', 'app_private.guard_profit_ledger_payout_row_v1()'),
      ('a00_profit_ledger_markers_guard', 'app_private.profit_ledger_markers', 'app_private.guard_profit_ledger_marker_v1()')
    ) AS x(ten, bang, ham)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgname = x.ten AND t.tgrelid = to_regclass(x.bang) AND t.tgfoid = to_regprocedure(x.ham)
        AND t.tgenabled = 'O' AND NOT t.tgisinternal);
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu chốt chặn của sổ tổng (Đợt 1): %', v_thieu USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ── 1. Dòng sổ phiếu chi: thêm cách lập "người giữ sổ lập hộ" ────────────────────────────
-- CHECK cũ của cột (tên trên catalog: profit_ledger_payouts_maker_kind_check) chỉ nhận hai giá trị.
-- Bỏ mọi CHECK một-cột trên maker_kind chưa nhận giá trị mới rồi thêm lại; chạy lại không đụng gì.
DO $maker_kind$
DECLARE
  c_bang constant regclass := 'app_private.profit_ledger_payouts'::regclass;
  v_cot  smallint;
  v_ten  text;
BEGIN
  SELECT a.attnum INTO v_cot FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = c_bang AND a.attname = 'maker_kind' AND NOT a.attisdropped;

  FOR v_ten IN
    SELECT c.conname FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = c_bang AND c.contype = 'c' AND c.conkey = ARRAY[v_cot]
       AND pg_get_constraintdef(c.oid) NOT LIKE '%CUSTODIAN_FOR_PAYEE%'
  LOOP
    EXECUTE format('ALTER TABLE app_private.profit_ledger_payouts DROP CONSTRAINT %I', v_ten);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = c_bang AND c.contype = 'c' AND c.conkey = ARRAY[v_cot]
       AND pg_get_constraintdef(c.oid) LIKE '%CUSTODIAN_FOR_PAYEE%') THEN
    ALTER TABLE app_private.profit_ledger_payouts
      ADD CONSTRAINT profit_ledger_payouts_maker_kind_check
      CHECK (maker_kind IN ('OWNER', 'CUSTODIAN_ADVANCE', 'CUSTODIAN_FOR_PAYEE'));
  END IF;

  -- Lập hộ: chỉ cho cổ đông, người nhận có đăng nhập và KHÁC người lập.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = c_bang AND c.conname = 'profit_ledger_payouts_custodian_for_payee_ck') THEN
    ALTER TABLE app_private.profit_ledger_payouts
      ADD CONSTRAINT profit_ledger_payouts_custodian_for_payee_ck
      CHECK (maker_kind <> 'CUSTODIAN_FOR_PAYEE'
             OR (subject_kind = 'SHAREHOLDER' AND NOT payee_is_maker AND payee_user_id IS NOT NULL));
  END IF;
END
$maker_kind$;

-- ── 2. Bản ghi chốt chi lợi nhuận ───────────────────────────────────────────────────────
-- Một dòng cho mỗi lần chủ chốt "đến hết tháng N" của một cổ đông:
--   recognized_amount (X) = advance_offset_amount (K, khấu trừ tạm ứng) + cash_amount (tiền thực chi).
-- Có tiền thì trỏ tới đúng MỘT phiếu chi (cash_voucher_id); sống / chết theo phiếu đó.
CREATE TABLE IF NOT EXISTS app_private.profit_ledger_payout_settlements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  shareholder_id        uuid NOT NULL,
  through_month         date NOT NULL CHECK (EXTRACT(DAY FROM through_month) = 1),
  recognized_amount     numeric(15,2) NOT NULL CHECK (recognized_amount > 0),
  advance_offset_amount numeric(15,2) NOT NULL CHECK (advance_offset_amount >= 0),
  cash_amount           numeric(15,2) NOT NULL CHECK (cash_amount >= 0),
  cash_voucher_id       uuid REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  -- Hai con số ngay trước khi chốt (dưới khoá sổ): lợi nhuận chưa chi (mọi tháng) và tạm ứng đã duyệt đang có —
  -- đúng số profit_ledger_position_v1 trả ra (tạm ứng không âm).
  unpaid_before         numeric(15,2) NOT NULL,
  advance_before        numeric(15,2) NOT NULL,
  note                  text,
  ledger_seq            bigint NOT NULL,
  state                 text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'VOID')),
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  voided_by             uuid,
  voided_at             timestamptz,
  void_reason           text,
  CONSTRAINT profit_ledger_payout_settlements_split_ck CHECK (advance_offset_amount + cash_amount = recognized_amount),
  CONSTRAINT profit_ledger_payout_settlements_cash_voucher_ck CHECK ((cash_amount > 0) = (cash_voucher_id IS NOT NULL)),
  -- Chỉ khấu trừ trong phạm vi tạm ứng ĐÃ DUYỆT đang có lúc chốt.
  CONSTRAINT profit_ledger_payout_settlements_offset_ck CHECK (advance_offset_amount <= GREATEST(advance_before, 0)),
  CONSTRAINT profit_ledger_payout_settlements_void_ck CHECK (
    (state = 'ACTIVE' AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL)
    OR (state = 'VOID' AND voided_by IS NOT NULL AND voided_at IS NOT NULL
        AND void_reason IS NOT NULL AND char_length(btrim(void_reason)) BETWEEN 8 AND 1000)),
  CONSTRAINT profit_ledger_payout_settlements_seq_uq UNIQUE (ledger_seq),
  CONSTRAINT profit_ledger_payout_settlements_shareholder_fk FOREIGN KEY (shareholder_id, organization_id)
    REFERENCES public.shareholders (id, organization_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS profit_ledger_payout_settlements_cash_voucher_uq
  ON app_private.profit_ledger_payout_settlements (cash_voucher_id) WHERE cash_voucher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS profit_ledger_payout_settlements_shareholder_idx
  ON app_private.profit_ledger_payout_settlements (organization_id, shareholder_id, ledger_seq DESC);

ALTER TABLE app_private.profit_ledger_payout_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.profit_ledger_payout_settlements FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.profit_ledger_payout_settlements IS
  'Bản ghi chốt chi lợi nhuận cổ đông "đến hết tháng N": recognized_amount (ghi nhận) = advance_offset_amount (khấu trừ tạm ứng đã duyệt) + cash_amount (tiền thực chi, có thì trỏ một phiếu chi theo sổ tổng). Còn hiệu lực = ACTIVE và (không có phiếu tiền hoặc phiếu tiền còn sống). Chỉ ghi thêm; chỉ ACTIVE → VOID khi không có phiếu tiền.';

-- Chốt của bảng: sinh ra ở ACTIVE, dưới khoá sổ của cổ đông, với số thứ tự sổ vừa lấy và đứng sau mọi
-- mốc / phiếu chi / bản ghi chốt đã có của cổ đông; có phiếu tiền thì phải khớp dòng sổ của phiếu đó.
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_payout_settlement_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_STATE: bản ghi chốt chi lợi nhuận phải sinh ra ở ACTIVE' USING ERRCODE = '55000';
    END IF;
    IF NEW.ledger_seq IS DISTINCT FROM currval('app_private.profit_ledger_seq'::regclass) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_SEQ: ledger_seq phải là số vừa lấy từ profit_ledger_seq trong phiên này'
        USING ERRCODE = '55000';
    END IF;
    IF NOT app_private.profit_ledger_lock_held_v1(NEW.organization_id, 'SHAREHOLDER', NEW.shareholder_id) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_NOT_SERIALIZED: phải giữ khoá sổ của cổ đông trước khi ghi bản ghi chốt'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.ledger_seq <= COALESCE((
         SELECT max(x.seq) FROM (
           SELECT m.ledger_seq AS seq FROM app_private.profit_ledger_markers m
            WHERE m.organization_id = NEW.organization_id AND m.subject_kind = 'SHAREHOLDER'
              AND m.subject_id = NEW.shareholder_id
           UNION ALL
           SELECT p.ledger_seq FROM app_private.profit_ledger_payouts p
            WHERE p.organization_id = NEW.organization_id AND p.subject_kind = 'SHAREHOLDER'
              AND p.shareholder_id = NEW.shareholder_id
           UNION ALL
           SELECT s.ledger_seq FROM app_private.profit_ledger_payout_settlements s
            WHERE s.organization_id = NEW.organization_id AND s.shareholder_id = NEW.shareholder_id) x), 0) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_SEQ: ledger_seq phải lớn hơn mọi thứ tự sổ đã có của cổ đông (không dùng lại số cũ)'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.cash_voucher_id IS NOT NULL
       AND (NOT EXISTS (
              SELECT 1 FROM app_private.profit_ledger_payouts p
               WHERE p.voucher_id = NEW.cash_voucher_id
                 AND p.organization_id = NEW.organization_id
                 AND p.subject_kind = 'SHAREHOLDER'
                 AND p.shareholder_id = NEW.shareholder_id
                 AND p.amount = NEW.cash_amount
                 AND p.advance_amount = 0)
            OR NOT app_private.profit_ledger_voucher_live_v1(NEW.cash_voucher_id)) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_SETTLEMENT_VOUCHER: phiếu tiền của bản ghi chốt phải là phiếu chi theo sổ tổng còn sống của đúng cổ đông, đúng số tiền thực chi'
        USING ERRCODE = '55000';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF OLD.state = 'ACTIVE' AND NEW.state = 'VOID'
     AND OLD.cash_voucher_id IS NULL
     AND (to_jsonb(NEW) - ARRAY['state', 'voided_by', 'voided_at', 'void_reason'])
       = (to_jsonb(OLD) - ARRAY['state', 'voided_by', 'voided_at', 'void_reason'])
     AND app_private.profit_ledger_lock_held_v1(OLD.organization_id, 'SHAREHOLDER', OLD.shareholder_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PROFIT_LEDGER_STATE: bản ghi chốt chỉ chuyển ACTIVE → VOID, khi không có phiếu tiền và đang giữ khoá sổ của cổ đông'
    USING ERRCODE = '55000';
END
$fn$;

DROP TRIGGER IF EXISTS a00_profit_ledger_payout_settlements_guard ON app_private.profit_ledger_payout_settlements;
CREATE TRIGGER a00_profit_ledger_payout_settlements_guard
  BEFORE INSERT OR UPDATE ON app_private.profit_ledger_payout_settlements
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_payout_settlement_v1();
DROP TRIGGER IF EXISTS a00_profit_ledger_payout_settlements_no_delete ON app_private.profit_ledger_payout_settlements;
CREATE TRIGGER a00_profit_ledger_payout_settlements_no_delete
  BEFORE DELETE ON app_private.profit_ledger_payout_settlements
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();
DROP TRIGGER IF EXISTS a00_profit_ledger_payout_settlements_no_truncate ON app_private.profit_ledger_payout_settlements;
CREATE TRIGGER a00_profit_ledger_payout_settlements_no_truncate
  BEFORE TRUNCATE ON app_private.profit_ledger_payout_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();

-- Bản ghi chốt còn hiệu lực: ACTIVE và (không có phiếu tiền hoặc phiếu tiền còn sống). Không khoá dòng.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_settlement_live_v1(p_settlement_id uuid)
RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT COALESCE((
    SELECT s.state = 'ACTIVE'
       AND (s.cash_voucher_id IS NULL OR app_private.profit_ledger_voucher_live_v1(s.cash_voucher_id))
      FROM app_private.profit_ledger_payout_settlements s
     WHERE s.id = p_settlement_id), false)
$fn$;

-- ── 2b. Mốc "đã trả đủ" không được đặt SỚM hơn một tháng đã chốt chi ────────────────────────
-- Lệnh đặt mốc của Đợt 1 (profit_ledger_set_marker_v1) không biết bản ghi chốt. Mốc ở tháng X làm mọi phiếu và bản
-- ghi chốt lập trước nó bị bỏ qua, còn phân bổ của các tháng > X vẫn tính: đã chốt chi đến hết tháng N > X thì các
-- tháng trong (X, N] hiện lại "chưa chi" và bị chi lần hai, không tự thu lại. Chặn ngay ở bảng mốc (mọi đường ghi):
--   dòng mốc của CỔ ĐÔNG có tháng (không phải dòng gỡ mốc) mà cổ đông đang có bản ghi chốt CÒN HIỆU LỰC với
--   through_month > tháng mốc ⇒ 55000 PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT.
-- Xét MỌI bản ghi còn hiệu lực, kể cả bản đang bị một mốc cũ loại (mốc mới đè mốc cũ; bản ghi đó vẫn nằm trước mốc
-- mới). Mốc từ tháng chốt lớn nhất trở đi, dòng gỡ mốc và mốc của lương điều hành: không đụng.
-- Tên trigger xếp SAU a00_profit_ledger_markers_guard: chốt đó đã bắt phiên giữ khoá sổ của cổ đông, nên tập bản
-- ghi chốt đọc ở đây không đổi dưới chân (lệnh chốt và lệnh huỷ bản ghi chốt cũng giữ khoá đó).
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_marker_settlement_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_last date;
BEGIN
  IF NEW.subject_kind = 'SHAREHOLDER' AND NEW.settled_through_month IS NOT NULL THEN
    SELECT max(s.through_month) INTO v_last
      FROM app_private.profit_ledger_payout_settlements s
     WHERE s.organization_id = NEW.organization_id
       AND s.shareholder_id = NEW.shareholder_id
       AND app_private.profit_ledger_settlement_live_v1(s.id);
    IF v_last > NEW.settled_through_month THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT: đã chốt chi lợi nhuận đến hết tháng % — mốc "đã trả đủ" phải từ tháng đó trở đi, hoặc huỷ lần chốt đó trước',
        to_char(v_last, 'MM/YYYY')
        USING ERRCODE = '55000',
              DETAIL = jsonb_build_object('settled_through_month', NEW.settled_through_month,
                                          'last_settled_through_month', v_last)::text;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS a10_profit_ledger_markers_settlement_guard ON app_private.profit_ledger_markers;
CREATE TRIGGER a10_profit_ledger_markers_settlement_guard
  BEFORE INSERT ON app_private.profit_ledger_markers
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_marker_settlement_v1();

-- ── 3. Hạng mục "Tạm Ứng" ─────────────────────────────────────────────────────────────
-- Chỉ lệnh lập tạm ứng dùng (system_only ⇒ create_income_expense_v1 và ie_compat_insert_v2 từ chối lập tay);
-- manual_hidden = false để danh mục vẫn hiện hạng mục này. Gieo cho mọi công ty đang có hạng mục chia_loi_nhuan
-- (chủ hạng mục = chủ của dòng đó). Công ty đã có hạng mục CHI trùng tên chuẩn hoá mà không mang rule_key này
-- ⇒ dừng (không tự chiếm hạng mục người dùng đang dùng cho việc khác).
DO $hang_muc$
DECLARE
  v_trung text;
  v_moi   text[];
  v_truoc text[];
BEGIN
  SELECT string_agg(DISTINCT t.organization_id::text, ', ') INTO v_trung
    FROM public.income_expense_types t
   WHERE lower(btrim(t.type)) = 'expense'
     AND t.rule_key IS DISTINCT FROM 'tam_ung_co_dong'
     AND public.normalize_income_expense_type_name(t.name) = public.normalize_income_expense_type_name('Tạm Ứng')
     AND EXISTS (SELECT 1 FROM public.income_expense_types c
                  WHERE c.organization_id = t.organization_id AND c.rule_key = 'chia_loi_nhuan'
                    AND lower(btrim(c.type)) = 'expense')
     AND NOT EXISTS (SELECT 1 FROM public.income_expense_types d
                      WHERE d.organization_id = t.organization_id AND d.rule_key = 'tam_ung_co_dong');
  IF v_trung IS NOT NULL THEN
    RAISE EXCEPTION 'Công ty đã có hạng mục chi trùng tên "Tạm Ứng" nhưng không mang rule_key tam_ung_co_dong — đổi tên hoặc gộp hạng mục đó rồi chạy lại: %', v_trung
      USING ERRCODE = '55000';
  END IF;

  WITH moi AS (
    INSERT INTO public.income_expense_types (
      user_id, organization_id, name, type, category, description,
      is_default, is_deposit, is_restricted, force_approval,
      system_only, manual_hidden, quick_entry_hidden, internal_transfer, rule_key)
    SELECT DISTINCT ON (c.organization_id)
           c.user_id, c.organization_id, 'Tạm Ứng', 'expense', 'Chia lợi nhuận',
           'Tạm ứng lợi nhuận của cổ đông; khấu trừ khi chủ chốt chi lợi nhuận. Tiền nội bộ, không tính KQKD',
           false, false, true, true,
           true, false, true, true, 'tam_ung_co_dong'
      FROM public.income_expense_types c
     WHERE c.rule_key = 'chia_loi_nhuan'
       AND lower(btrim(c.type)) = 'expense'
       AND NOT EXISTS (SELECT 1 FROM public.income_expense_types d
                        WHERE d.organization_id = c.organization_id AND d.rule_key = 'tam_ung_co_dong')
     ORDER BY c.organization_id, c.created_at, c.id
    RETURNING id)
  SELECT COALESCE(array_agg(moi.id::text), ARRAY[]::text[]) INTO v_moi FROM moi;

  -- Dòng vừa chèn trong GIAO DỊCH NÀY (cộng dồn qua các lượt cùng giao dịch): hậu kiểm chỉ khẳng định cờ cho các dòng đó.
  v_truoc := COALESCE(string_to_array(NULLIF(current_setting('ihomecrm.tam_ung_loai_moi', true), ''), ','), ARRAY[]::text[]);
  PERFORM set_config('ihomecrm.tam_ung_loai_moi',
    array_to_string(ARRAY(SELECT DISTINCT x.k FROM unnest(v_truoc || v_moi) AS x(k) ORDER BY x.k), ','), true);
END
$hang_muc$;

-- ── 4. Hàm nội bộ (app_private; không cấp EXECUTE cho vai nào) ───────────────────────────

-- Vị thế của một cổ đông: hai con số A / B đặt trên số dư ròng (profit_ledger_balance_v1), cùng mốc hiệu lực.
--   sx, sk     = Σ ghi nhận, Σ khấu trừ của các bản ghi chốt CÒN HIỆU LỰC sau mốc;
--   cash_ok    = Σ tiền của bản ghi chốt có phiếu ĐÃ DUYỆT; cash_wait = … phiếu còn chờ duyệt.
--   Số THÔ:
--   unpaid_profit_raw       = allocated − salary_investment − sx
--   advance_outstanding_raw = (payouts_approved − cash_ok) − salary_advance_offset − sk     (tạm ứng ĐÃ DUYỆT)
--   advance_pending         = payouts_pending − cash_wait                                    (tạm ứng chờ duyệt)
-- Tự kiểm TRÊN SỐ THÔ: unpaid_profit_raw − advance_outstanding_raw − advance_pending = balance và phiếu tiền của
-- bản ghi chốt phải nằm trong phần phiếu chi mà lõi đang tính; lệch ⇒ XX000 (dừng, không trả số sai).
--   Số TRẢ RA — tạm ứng không bao giờ âm:
--   advance_overoffset  = greatest(−advance_outstanding_raw, 0)   phần tạm ứng bị khấu trừ / trừ qua lương NHIỀU hơn
--                         tạm ứng đã duyệt đang có: đó là lợi nhuận công ty còn nợ cổ đông, gấp vào "chưa chi";
--   advance_outstanding = advance_outstanding_raw + advance_overoffset   (= greatest(…, 0))
--   unpaid_profit       = unpaid_profit_raw + advance_overoffset
-- Hai vế cùng cộng một lượng nên bất biến unpaid_profit − advance_outstanding − advance_pending = balance giữ nguyên.
-- KHÔNG gấp chiều ngược lại: unpaid_profit âm (mở chốt tháng đã chốt chi, mốc) vẫn để âm.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_position_v1(p_org uuid, p_shareholder uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_bal          jsonb;
  v_marker_month date;
  v_marker_seq   bigint;
  v_alloc        numeric;
  v_sal_invest   numeric;
  v_sal_offset   numeric;
  v_pay_approved numeric;
  v_pay_pending  numeric;
  v_balance      numeric;
  v_sx           numeric;
  v_sk           numeric;
  v_cash_ok      numeric;
  v_cash_wait    numeric;
  v_last         date;
  v_unpaid       numeric;
  v_adv          numeric;
  v_adv_pending  numeric;
  v_fold         numeric;
BEGIN
  v_bal := app_private.profit_ledger_balance_v1(p_org, 'SHAREHOLDER', p_shareholder);
  -- "Có mốc" = dòng mốc hiệu lực có tháng. Dòng gỡ mốc (tháng null) ⇒ như chưa có mốc: không lọc gì, như lõi số dư.
  v_marker_month := (v_bal -> 'marker' ->> 'settled_through_month')::date;
  IF v_marker_month IS NOT NULL THEN
    v_marker_seq := (v_bal -> 'marker' ->> 'ledger_seq')::bigint;
  END IF;
  v_alloc        := (v_bal ->> 'allocated')::numeric;
  v_sal_invest   := (v_bal ->> 'salary_investment')::numeric;
  v_sal_offset   := (v_bal ->> 'salary_advance_offset')::numeric;
  v_pay_approved := (v_bal ->> 'payouts_approved')::numeric;
  v_pay_pending  := (v_bal ->> 'payouts_pending')::numeric;
  v_balance      := (v_bal ->> 'balance')::numeric;

  SELECT COALESCE(sum(s.recognized_amount), 0),
         COALESCE(sum(s.advance_offset_amount), 0),
         COALESCE(sum(s.cash_amount) FILTER (WHERE s.cash_voucher_id IS NOT NULL AND ie.approval_status = 'APPROVED'), 0),
         COALESCE(sum(s.cash_amount) FILTER (WHERE s.cash_voucher_id IS NOT NULL AND ie.approval_status IS DISTINCT FROM 'APPROVED'), 0),
         max(s.through_month)
    INTO v_sx, v_sk, v_cash_ok, v_cash_wait, v_last
    FROM app_private.profit_ledger_payout_settlements s
    LEFT JOIN public.income_expenses ie ON ie.id = s.cash_voucher_id
   WHERE s.organization_id = p_org
     AND s.shareholder_id = p_shareholder
     AND app_private.profit_ledger_settlement_live_v1(s.id)
     AND (v_marker_seq IS NULL OR s.ledger_seq > v_marker_seq);

  v_unpaid      := v_alloc - v_sal_invest - v_sx;
  v_adv         := (v_pay_approved - v_cash_ok) - v_sal_offset - v_sk;
  v_adv_pending := v_pay_pending - v_cash_wait;

  IF (v_unpaid - v_adv - v_adv_pending) IS DISTINCT FROM v_balance
     OR v_cash_ok > v_pay_approved
     OR v_cash_wait > v_pay_pending THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_POSITION_DRIFT: lợi nhuận chưa chi và tạm ứng không cộng ra đúng số dư sổ tổng — báo bộ phận kỹ thuật'
      USING ERRCODE = 'XX000',
            DETAIL = jsonb_build_object(
              'balance', v_balance, 'unpaid_profit', v_unpaid, 'advance_outstanding', v_adv,
              'advance_pending', v_adv_pending, 'payouts_approved', v_pay_approved, 'payouts_pending', v_pay_pending,
              'cash_approved', v_cash_ok, 'cash_pending', v_cash_wait, 'recognized', v_sx, 'offset', v_sk)::text;
  END IF;

  -- Tạm ứng không bao giờ âm: phần âm là lợi nhuận công ty còn nợ, gấp vào "lợi nhuận chưa chi" (một chiều).
  v_fold := GREATEST(-v_adv, 0);

  RETURN jsonb_build_object(
    'unpaid_profit', v_unpaid + v_fold,
    'advance_outstanding', v_adv + v_fold,
    'advance_pending', v_adv_pending,
    'settlement_cash_pending', v_cash_wait,
    'settled', jsonb_build_object('recognized', v_sx, 'offset', v_sk, 'cash', v_cash_ok + v_cash_wait),
    'last_settled_through_month', v_last,
    'balance', v_balance,
    'marker_month', v_marker_month,
    'needs_review', v_bal -> 'needs_review',
    -- Các phần của số dư ròng mà hai con số trên dựng từ đó (cùng một lần đọc), hai số thô và phần đã gấp (chẩn đoán).
    'components', jsonb_build_object(
      'allocated', v_alloc, 'salary_investment', v_sal_invest, 'salary_advance_offset', v_sal_offset,
      'payouts_approved', v_pay_approved, 'payouts_pending', v_pay_pending,
      'unpaid_profit_raw', v_unpaid, 'advance_outstanding_raw', v_adv, 'advance_overoffset', v_fold));
END
$fn$;

-- Lợi nhuận chưa chi của các tháng ≤ N (X của một lần chốt đến hết tháng N):
--   X(N) = (allocated − allocated_sau_N) − (salary_investment − salary_investment_sau_N) − Σ ghi nhận còn hiệu lực
--          + advance_overoffset
-- "_sau_N" lấy từ lõi số dư với mốc GIẢ ĐỊNH tháng N (chỉ đọc hai phần lọc theo kỳ) — không có câu cộng phân bổ riêng.
-- advance_overoffset (phần tạm ứng bị khấu trừ / trừ lương quá tay, xem profit_ledger_position_v1) không thuộc tháng
-- nào: công ty nợ ở MỌI N. N phải là ngày 1 và sau tháng của mốc hiệu lực. Có thể ≤ 0 (không kẹp).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_unpaid_through_v1(p_org uuid, p_shareholder uuid, p_through_month date)
RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_pos    jsonb;
  v_marker date;
  v_after  jsonb;
BEGIN
  IF p_through_month IS NULL OR NOT isfinite(p_through_month) OR EXTRACT(DAY FROM p_through_month) <> 1 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải là ngày đầu tháng' USING ERRCODE = '22023';
  END IF;
  v_pos := app_private.profit_ledger_position_v1(p_org, p_shareholder);
  v_marker := (v_pos ->> 'marker_month')::date;
  IF v_marker IS NOT NULL AND p_through_month <= v_marker THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải sau tháng của mốc "đã trả đủ"'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('through_month', p_through_month, 'marker_month', v_marker)::text;
  END IF;
  v_after := app_private.profit_ledger_balance_core_v1(p_org, 'SHAREHOLDER', p_shareholder,
               p_through_month, 9223372036854775807, 'infinity');
  RETURN ((v_pos -> 'components' ->> 'allocated')::numeric - (v_after ->> 'allocated')::numeric)
       - ((v_pos -> 'components' ->> 'salary_investment')::numeric - (v_after ->> 'salary_investment')::numeric)
       - (v_pos -> 'settled' ->> 'recognized')::numeric
       + (v_pos -> 'components' ->> 'advance_overoffset')::numeric;
END
$fn$;

-- Các tháng chốt được của một cổ đông + vị thế, trong CÙNG một lần đọc (xem trước và lệnh chốt dùng chung):
--   months[]: {month, allocated (phân bổ của tháng — chỉ để hiển thị), unpaid_through (X nếu chốt đến tháng đó),
--              eligible (có phân bổ đã chốt, sau mốc, không trước lần chốt gần nhất), selectable (eligible và X > 0)}.
-- Tổng phân bổ liệt kê phải bằng đúng phần "allocated" của lõi số dư, lệch ⇒ XX000.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_chot_months_v1(p_org uuid, p_shareholder uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_pos      jsonb;
  v_marker   date;
  v_last     date;
  v_rows     jsonb := '[]'::jsonb;
  v_sum      numeric := 0;
  v_x        numeric;
  v_eligible boolean;
  v_min      date;
  v_max      date;
  v_min_sel  date;
  v_max_sel  date;
  r          record;
BEGIN
  v_pos := app_private.profit_ledger_position_v1(p_org, p_shareholder);
  v_marker := (v_pos ->> 'marker_month')::date;
  v_last := (v_pos ->> 'last_settled_through_month')::date;

  FOR r IN
    SELECT pm.period_month AS thang, sum(a.amount) AS phan_bo
      FROM public.profit_allocations a
      JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
     WHERE a.shareholder_id = p_shareholder
       AND pm.organization_id = p_org
       AND pm.status = 'LOCKED'
       AND (v_marker IS NULL OR pm.period_month > v_marker)
     GROUP BY pm.period_month
     ORDER BY pm.period_month
  LOOP
    v_sum := v_sum + r.phan_bo;
    v_x := app_private.profit_ledger_unpaid_through_v1(p_org, p_shareholder, r.thang);
    v_eligible := v_last IS NULL OR r.thang >= v_last;
    v_rows := v_rows || jsonb_build_object(
      'month', r.thang, 'allocated', r.phan_bo, 'unpaid_through', v_x,
      'eligible', v_eligible, 'selectable', v_eligible AND v_x > 0);
    IF v_eligible THEN
      v_min := COALESCE(v_min, r.thang);
      v_max := r.thang;
      IF v_x > 0 THEN
        v_min_sel := COALESCE(v_min_sel, r.thang);
        v_max_sel := r.thang;
      END IF;
    END IF;
  END LOOP;

  IF v_sum IS DISTINCT FROM (v_pos -> 'components' ->> 'allocated')::numeric THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_POSITION_DRIFT: các tháng liệt kê không cộng ra đúng phần phân bổ của sổ tổng — báo bộ phận kỹ thuật'
      USING ERRCODE = 'XX000',
            DETAIL = jsonb_build_object('listed', v_sum, 'allocated', v_pos -> 'components' -> 'allocated')::text;
  END IF;

  RETURN jsonb_build_object(
    'months', v_rows,
    'min_eligible', v_min, 'max_eligible', v_max,
    'min_selectable', v_min_sel, 'max_selectable', v_max_sel,
    'position', v_pos);
END
$fn$;

-- Danh sách bản ghi chốt CÒN HIỆU LỰC của một cổ đông, mới nhất trước (cổ đông tự xem + xem trước chốt).
-- excluded_by_marker: bản ghi nằm trước mốc "đã trả đủ" hiệu lực (không còn tính vào hai con số).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_chot_rows_v1(p_org uuid, p_shareholder uuid)
RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'through_month', s.through_month,
           'recognized_amount', s.recognized_amount,
           'advance_offset_amount', s.advance_offset_amount,
           'cash_amount', s.cash_amount,
           'cash_voucher_id', s.cash_voucher_id,
           'cash_voucher_code', ie.code,
           'cash_voucher_status', ie.approval_status,
           'cash_voucher_posting_status', ie.posting_status,
           'created_at', s.created_at,
           'excluded_by_marker', COALESCE((
             SELECT mk.settled_through_month IS NOT NULL AND s.ledger_seq <= mk.ledger_seq
               FROM app_private.profit_ledger_active_marker_v1(p_org, 'SHAREHOLDER', p_shareholder) mk), false))
           ORDER BY s.ledger_seq DESC), '[]'::jsonb)
    FROM app_private.profit_ledger_payout_settlements s
    LEFT JOIN public.income_expenses ie ON ie.id = s.cash_voucher_id
   WHERE s.organization_id = p_org
     AND s.shareholder_id = p_shareholder
     AND app_private.profit_ledger_settlement_live_v1(s.id)
$fn$;

-- Người nhận (theo đăng nhập) có quyền tạm ứng trên công ty không. Không có hàm kiểm quyền KHÔNG khoá dòng cho
-- một người bất kỳ (app_private.authorized_scope_v3 chỉ xét người đang gọi) ⇒ dùng authorize_tenant_action_v3,
-- hàm này FOR SHARE dòng công ty ⇒ VOLATILE; lệnh đọc nào gọi nó cũng phải VOLATILE (PostgREST chạy hàm STABLE
-- trong giao dịch chỉ đọc). Ngoại lệ hỏng (không có cạnh phạm vi, 23514) ⇒ coi như không có quyền, như bản đọc.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_chot_advance_right_v1(p_org uuid, p_user uuid)
RETURNS boolean
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_ok boolean;
BEGIN
  IF p_org IS NULL OR p_user IS NULL THEN
    RETURN false;
  END IF;
  BEGIN
    SELECT a.allowed INTO v_ok
      FROM app_private.authorize_tenant_action_v3(p_user, p_org, 'shareholder_profit.advance_own_cashbook', NULL, NULL) a;
  EXCEPTION WHEN check_violation THEN
    RETURN false;
  END;
  RETURN COALESCE(v_ok, false);
END
$fn$;

-- Thành viên có đang GIỮ (CUSTODIAN) sổ quỹ không — đúng luật của assert_cashbook_access_v2 (mọi từ chối là 42501).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_chot_holds_cashbook_v1(p_org uuid, p_account uuid, p_membership uuid)
RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF p_org IS NULL OR p_account IS NULL OR p_membership IS NULL THEN
    RETURN false;
  END IF;
  BEGIN
    PERFORM app_private.assert_cashbook_access_v2(p_org, p_account, 'CUSTODIAN', p_membership);
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN false;
  END;
  RETURN true;
END
$fn$;

-- Hạng mục của phiếu sổ tổng theo rule_key; phải bắt buộc duyệt; thiếu thì tự tạo.
--   tam_ung_co_dong ⇒ "Tạm Ứng" (không ẩn khỏi danh mục). KHÔNG dự phòng theo tên: hạng mục chi trùng tên chuẩn hoá mà
--     không mang rule_key là hạng mục người dùng đang dùng cho việc khác ⇒ dừng 55000 PROFIT_LEDGER_TYPE_NAME_TAKEN
--     (không chiếm, và cũng không tạo trùng được vì chỉ mục duy nhất theo tên chuẩn hoá);
--   chia_loi_nhuan  ⇒ "Chia lợi nhuận cổ đông", dự phòng theo tên chuẩn hoá như lệnh chi cũ (E5).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_chot_hang_muc_v1(p_org uuid, p_owner uuid, p_rule_key text)
RETURNS uuid
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_name   text;
  v_type   uuid;
  v_forced boolean;
BEGIN
  v_name := CASE p_rule_key WHEN 'tam_ung_co_dong' THEN 'Tạm Ứng' WHEN 'chia_loi_nhuan' THEN 'Chia lợi nhuận cổ đông' END;
  IF p_org IS NULL OR v_name IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: hạng mục sổ tổng không hợp lệ' USING ERRCODE = '22023';
  END IF;

  SELECT t.id, t.force_approval INTO v_type, v_forced
    FROM public.income_expense_types t
   WHERE t.organization_id = p_org
     AND t.rule_key = p_rule_key
     AND lower(btrim(t.type)) = 'expense'
   ORDER BY t.created_at
   LIMIT 1;
  IF v_type IS NULL THEN
    SELECT t.id, t.force_approval INTO v_type, v_forced
      FROM public.income_expense_types t
     WHERE t.organization_id = p_org
       AND public.normalize_income_expense_type_name(t.name) = public.normalize_income_expense_type_name(v_name)
       AND lower(btrim(t.type)) = 'expense'
     ORDER BY t.created_at
     LIMIT 1;
    IF v_type IS NOT NULL AND p_rule_key = 'tam_ung_co_dong' THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_TYPE_NAME_TAKEN: công ty đã có hạng mục chi tên "Tạm Ứng" dùng cho việc khác — đổi tên hạng mục đó rồi lập lại'
        USING ERRCODE = '55000', DETAIL = jsonb_build_object('income_expense_type_id', v_type)::text;
    END IF;
  END IF;
  IF v_type IS NULL THEN
    INSERT INTO public.income_expense_types (
      user_id, organization_id, name, type, category, description,
      is_default, is_deposit, is_restricted, force_approval,
      system_only, manual_hidden, quick_entry_hidden, internal_transfer, rule_key
    ) VALUES (
      p_owner, p_org, v_name, 'expense', 'Chia lợi nhuận',
      CASE p_rule_key
        WHEN 'tam_ung_co_dong' THEN 'Tạm ứng lợi nhuận của cổ đông; khấu trừ khi chủ chốt chi lợi nhuận. Tiền nội bộ, không tính KQKD'
        ELSE 'Chi lợi nhuận cổ đông theo sổ tổng; tiền nội bộ, không tính KQKD' END,
      false, false, true, true,
      true, p_rule_key <> 'tam_ung_co_dong', true, true, p_rule_key
    ) RETURNING id INTO v_type;
  ELSIF NOT COALESCE(v_forced, false) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_TYPE_NOT_FORCED: hạng mục "%" phải bật "Bắt buộc duyệt" mới lập được phiếu', v_name
      USING ERRCODE = '55000', DETAIL = jsonb_build_object('income_expense_type_id', v_type)::text;
  END IF;
  RETURN v_type;
END
$fn$;

-- Hai khoá ngày của phiếu sổ tổng (báo trước, dễ hiểu; trigger vẫn là chốt cuối) — cùng câu, cùng mã với E5.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_chot_assert_ngay_v1(p_building uuid, p_account uuid, p_voucher_date date)
RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_closed date;
BEGIN
  IF app_private.profit_month_locked_v1(p_building, p_voucher_date) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_PROFIT_MONTH_LOCKED: tháng % của toà ảo đã chốt lợi nhuận — chọn ngày chi khác hoặc mở chốt tháng đó',
      to_char(p_voucher_date, 'MM/YYYY')
      USING ERRCODE = '55000',
            DETAIL = jsonb_build_object('voucher_date', p_voucher_date, 'building_id', p_building)::text;
  END IF;
  v_closed := app_private.cashbook_closed_through_v1(p_account);
  IF v_closed IS NOT NULL AND p_voucher_date <= v_closed THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_CASHBOOK_CLOSED: sổ quỹ đã chốt tới ngày % — chọn ngày chi sau ngày đó', v_closed
      USING ERRCODE = '55000',
            DETAIL = jsonb_build_object('closed_through', v_closed, 'voucher_date', p_voucher_date)::text;
  END IF;
END
$fn$;

-- Nghi thức lập MỘT phiếu chi theo sổ tổng cho cổ đông — đúng các bước 8–10 của E5 (20261115084108):
--   ngữ cảnh CREATE → quyền ghi chuỗi kế toán → phiếu UNAPPROVED (id sinh trước) + dòng hạng mục INTERNAL → dòng sổ →
--   gửi duyệt, yêu cầu phải PENDING_APPROVAL (luật DENY / AUTO_POST ⇒ huỷ cả lệnh) → điền yêu cầu vào dòng sổ →
--   nhật ký PAYOUT_CREATED → dọn ngữ cảnh. Người gọi (lệnh tạm ứng / lệnh chốt) ĐÃ kiểm quyền, ĐANG giữ khoá sổ của
--   cổ đông và truyền p_seq = số vừa lấy từ profit_ledger_seq. Không cấp cho vai nào.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_chot_lap_phieu_v1(
  p_voucher uuid,
  p_org uuid,
  p_shareholder uuid,
  p_building uuid,
  p_owner uuid,
  p_account uuid,
  p_amount numeric,
  p_voucher_date date,
  p_name text,
  p_note text,
  p_type uuid,
  p_hash text,
  p_key text,
  p_actor uuid,
  p_membership uuid,
  p_maker_kind text,
  p_payee_user uuid,
  p_seq bigint,
  p_balance numeric,
  p_within numeric,
  p_advance numeric,
  p_estimate numeric,
  p_warnings jsonb,
  p_event_extra jsonb
) RETURNS uuid
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor_name text;
  v_request    uuid;
  v_state      text;
BEGIN
  SELECT COALESCE(NULLIF(btrim(pr.full_name), ''), NULLIF(btrim(pr.email), ''), 'Người dùng')
    INTO v_actor_name
    FROM public.profiles pr
   WHERE pr.id = p_actor;

  -- KHÔNG chèn income_expense_flow_ownership (phiếu flow-owned kiểu khác bị mọi RPC duyệt V2 từ chối).
  INSERT INTO app_private.profit_ledger_write_contexts (income_expense_id, purpose) VALUES (p_voucher, 'CREATE');
  PERFORM app_private.begin_accounting_chain_write_v1();

  INSERT INTO public.income_expenses (
    id, user_id, organization_id, creator_name, type, name,
    building_id, account_id, shareholder_id, total_amount,
    business_result_accounting, approval_status, voucher_date,
    attachments, repeat_cycle, repeat_infinity, repeat_count, repeat_remaining,
    source_payload_hash, system_source, idempotency_key, maker_user_id, maker_membership_id
  ) VALUES (
    p_voucher, p_owner, p_org, COALESCE(v_actor_name, 'Người dùng'), 'EXPENSE', p_name,
    p_building, p_account, p_shareholder, p_amount,
    false, 'UNAPPROVED', p_voucher_date,
    '[]'::jsonb, 'NONE', false, 0, 0,
    p_hash, 'profit.ledger_payout', p_key, p_actor, p_membership
  );

  INSERT INTO public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, amount, start_date, end_date, accounting_class
  ) VALUES (
    p_voucher, p_org, p_type,
    p_note, 1, p_amount, p_amount, p_voucher_date, p_voucher_date, 'INTERNAL'
  );

  INSERT INTO app_private.profit_ledger_payouts (
    voucher_id, organization_id, subject_kind, shareholder_id, account_id, amount,
    balance_before, within_amount, advance_amount, open_estimate, warnings,
    maker_user_id, maker_membership_id, maker_kind, payee_is_maker, payee_user_id, ledger_seq
  ) VALUES (
    p_voucher, p_org, 'SHAREHOLDER', p_shareholder, p_account, p_amount,
    p_balance, p_within, p_advance, p_estimate, p_warnings,
    p_actor, p_membership, p_maker_kind, COALESCE(p_payee_user = p_actor, false), p_payee_user, p_seq
  );

  -- Gửi duyệt rồi ĐỌC LẠI: khác PENDING_APPROVAL (luật DENY, AUTO_POST…) ⇒ huỷ cả lệnh.
  v_request := app_private.submit_financial_request_v1(p_voucher, p_membership, p_actor, p_key || '-sub');
  SELECT ar.state INTO v_state FROM public.approval_requests ar WHERE ar.id = v_request;
  IF v_state IS DISTINCT FROM 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_REQUEST_NOT_PENDING: luật duyệt không đưa phiếu chi lợi nhuận vào hàng chờ duyệt — không lập phiếu'
      USING ERRCODE = '55000',
            DETAIL = jsonb_build_object('approval_request_id', v_request, 'state', v_state)::text;
  END IF;
  UPDATE app_private.profit_ledger_payouts SET approval_request_id = v_request WHERE voucher_id = p_voucher;

  INSERT INTO app_private.profit_ledger_events (
    organization_id, event_kind, subject_kind, shareholder_id, voucher_id,
    amount, balance_before, balance_after, actor_id, payload
  ) VALUES (
    p_org, 'PAYOUT_CREATED', 'SHAREHOLDER', p_shareholder, p_voucher,
    p_amount, p_balance, p_balance - p_amount, p_actor,
    jsonb_build_object(
      'within_amount', p_within, 'advance_amount', p_advance, 'maker_kind', p_maker_kind,
      'open_estimate', p_estimate, 'warnings', p_warnings, 'approval_request_id', v_request,
      'ledger_seq', p_seq, 'account_id', p_account, 'voucher_date', p_voucher_date)
    || COALESCE(p_event_extra, '{}'::jsonb)
  );
  DELETE FROM app_private.profit_ledger_write_contexts WHERE income_expense_id = p_voucher;
  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_request;
END
$fn$;

-- ── 5. RPC đọc vị thế ─────────────────────────────────────────────────────────────────

-- R1. Chủ xem vị thế của mọi cổ đông. Quyền và danh sách như shareholder_profit_ledger_v1.
-- VOLATILE: has_advance_right phải kiểm quyền của NGƯỜI KHÁC (xem profit_ledger_chot_advance_right_v1).
CREATE OR REPLACE FUNCTION public.shareholder_profit_positions_v1(p_organization_id uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ tổng lợi nhuận của công ty này'
      USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: thiếu mã công ty' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id)
     OR NOT app_private.profit_ledger_doc_can_v1(p_organization_id, ARRAY[
          'shareholder_profit.distribute', 'shareholder_profit.lock',
          'shareholder_profit.unlock', 'shareholder_profit.manage_shareholders']) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ tổng lợi nhuận của công ty này'
      USING ERRCODE = '42501';
  END IF;

  WITH x AS MATERIALIZED (
    SELECT s.id, s.name, s.is_active,
           (s.deleted_at IS NOT NULL) AS is_deleted,
           s.auth_user_id,
           app_private.profit_ledger_position_v1(p_organization_id, s.id) AS pos
      FROM public.shareholders s
     WHERE s.organization_id = p_organization_id
  ), y AS MATERIALIZED (
    SELECT x.*
      FROM x
     WHERE NOT x.is_deleted
        OR (x.pos ->> 'unpaid_profit')::numeric <> 0
        OR (x.pos ->> 'advance_outstanding')::numeric <> 0
        OR (x.pos ->> 'advance_pending')::numeric <> 0
        OR (x.pos ->> 'settlement_cash_pending')::numeric <> 0
        OR (x.pos -> 'needs_review' ->> 'count')::bigint > 0
  )
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'shareholder_id', y.id,
             'name', y.name,
             'is_active', y.is_active,
             'is_deleted', y.is_deleted,
             'has_login', y.auth_user_id IS NOT NULL,
             'has_advance_right', app_private.profit_ledger_chot_advance_right_v1(p_organization_id, y.auth_user_id))
           || y.pos
           ORDER BY y.is_deleted, y.name, y.id), '[]'::jsonb)
    INTO v_rows
    FROM y;

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'route', app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', p_organization_id),
    'as_of', now(),
    'shareholders', v_rows);
END
$fn$;

-- R2. Cổ đông tự xem vị thế của mình. Quyền như shareholder_profit_my_ledger_v1. STABLE, không khoá dòng.
CREATE OR REPLACE FUNCTION public.shareholder_profit_my_position_v1(p_organization_id uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_n   integer;
  v_sh  record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn chưa xem được lợi nhuận của mình ở công ty này (cần là cổ đông của công ty và có quyền xem phân chia lợi nhuận hoặc quyền tạm ứng lợi nhuận)'
      USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: thiếu mã công ty' USING ERRCODE = '22023';
  END IF;
  IF NOT app_private.profit_ledger_doc_can_v1(p_organization_id, ARRAY[
       'reports_finance.profit_distribution', 'shareholder_profit.advance_own_cashbook']) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn chưa xem được lợi nhuận của mình ở công ty này (cần là cổ đông của công ty và có quyền xem phân chia lợi nhuận hoặc quyền tạm ứng lợi nhuận)'
      USING ERRCODE = '42501';
  END IF;

  -- Chỉ CHÍNH người gọi: cổ đông chưa xoá của công ty có auth_user_id = người gọi.
  SELECT count(*) INTO v_n
    FROM public.shareholders s
   WHERE s.organization_id = p_organization_id AND s.auth_user_id = v_uid AND s.deleted_at IS NULL;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn chưa xem được lợi nhuận của mình ở công ty này (cần là cổ đông của công ty và có quyền xem phân chia lợi nhuận hoặc quyền tạm ứng lợi nhuận)'
      USING ERRCODE = '42501';
  END IF;
  IF v_n > 1 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SHAREHOLDER_AMBIGUOUS: tài khoản của bạn đang gắn với nhiều cổ đông trong công ty này — nhờ chủ công ty gộp lại trước khi xem'
      USING ERRCODE = '55000';
  END IF;
  SELECT s.id, s.name INTO v_sh
    FROM public.shareholders s
   WHERE s.organization_id = p_organization_id AND s.auth_user_id = v_uid AND s.deleted_at IS NULL;

  RETURN jsonb_build_object(
           'organization_id', p_organization_id,
           'route', app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', p_organization_id),
           'shareholder', jsonb_build_object('id', v_sh.id, 'name', v_sh.name))
         || app_private.profit_ledger_position_v1(p_organization_id, v_sh.id)
         || jsonb_build_object('settlements', app_private.profit_ledger_chot_rows_v1(p_organization_id, v_sh.id));
END
$fn$;

-- ── 6. Tạm ứng ở Thu chi ───────────────────────────────────────────────────────────────

-- R3. Lựa chọn cho form Thu chi: sổ quỹ THẬT người gọi đang giữ, và người nhận được cấp quyền tạm ứng.
-- Chỉ trả tên, không số tiền. Người gọi không giữ sổ nào ⇒ không trả danh sách người nhận.
-- VOLATILE: kiểm quyền của NGƯỜI KHÁC (xem profit_ledger_chot_advance_right_v1).
CREATE OR REPLACE FUNCTION public.shareholder_profit_advance_options_v1(p_organization_id uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor      uuid := auth.uid();
  v_membership uuid;
  v_route      text;
  v_accounts   jsonb;
  v_payees     jsonb := '[]'::jsonb;
  v_type       jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: thiếu mã công ty' USING ERRCODE = '22023';
  END IF;
  SELECT m.id INTO v_membership
    FROM public.organization_memberships m
   WHERE m.user_id = v_actor
     AND m.organization_id = p_organization_id
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= clock_timestamp()
     AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())
   ORDER BY m.id
   LIMIT 1;
  IF v_membership IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn không thuộc công ty này' USING ERRCODE = '42501';
  END IF;

  v_route := app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', p_organization_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id', a.id, 'name', a.name) ORDER BY a.name, a.id), '[]'::jsonb)
    INTO v_accounts
    FROM public.accounts a
   WHERE a.organization_id = p_organization_id
     AND a.deleted_at IS NULL
     AND NOT a.is_virtual
     AND app_private.profit_ledger_chot_holds_cashbook_v1(p_organization_id, a.id, v_membership);

  IF jsonb_array_length(v_accounts) > 0 THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'shareholder_id', s.id, 'name', s.name, 'is_self', s.auth_user_id = v_actor)
             ORDER BY s.name, s.id), '[]'::jsonb)
      INTO v_payees
      FROM public.shareholders s
     WHERE s.organization_id = p_organization_id
       AND s.deleted_at IS NULL
       AND s.is_active
       AND s.auth_user_id IS NOT NULL
       AND app_private.profit_ledger_chot_advance_right_v1(p_organization_id, s.auth_user_id);
  END IF;

  -- Hạng mục "Tạm Ứng" của công ty (form hiện ô hạng mục từ đây: hạng mục hạn chế có thể không đọc được qua RLS).
  SELECT jsonb_build_object('id', t.id, 'name', t.name) INTO v_type
    FROM public.income_expense_types t
   WHERE t.organization_id = p_organization_id
     AND t.rule_key = 'tam_ung_co_dong'
     AND lower(btrim(t.type)) = 'expense'
   ORDER BY t.created_at
   LIMIT 1;

  RETURN jsonb_build_object(
    'route', v_route,
    'accounts', v_accounts,
    'payees', v_payees,
    'advance_type', v_type,
    'can_create', COALESCE(v_route = 'CANONICAL', false)
                  AND jsonb_array_length(v_accounts) > 0
                  AND jsonb_array_length(v_payees) > 0);
END
$fn$;

-- R4. Xem trước một phiếu tạm ứng. Người giữ sổ lập hộ KHÔNG thấy số của cổ đông: position và cảnh báo có số chỉ
-- trả cho chính người nhận (đang có quyền tạm ứng) hoặc người có quyền chi lợi nhuận.
-- VOLATILE: kiểm quyền của NGƯỜI KHÁC (xem profit_ledger_chot_advance_right_v1).
CREATE OR REPLACE FUNCTION public.shareholder_profit_advance_preview_v1(
  p_shareholder_id uuid,
  p_amount numeric,
  p_account_id uuid
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor       uuid := auth.uid();
  v_sh          record;
  v_membership  uuid;
  v_route       text;
  v_self        boolean;
  v_holds       boolean;
  v_right       boolean := false;
  v_see_numbers boolean := false;
  v_blocked     text;
  v_pos         jsonb;
  v_balance     numeric;
  v_warnings    jsonb := '[]'::jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NOT NULL
     AND (p_amount::text IN ('NaN', 'Infinity', '-Infinity') OR p_amount <= 0
          OR round(p_amount, 2) <> p_amount OR p_amount >= 10000000000000) THEN
    RAISE EXCEPTION 'Số tiền tạm ứng không hợp lệ' USING ERRCODE = '22023';
  END IF;

  SELECT s.organization_id, s.auth_user_id, s.is_active, s.deleted_at
    INTO v_sh
    FROM public.shareholders s
   WHERE s.id = p_shareholder_id;
  IF NOT FOUND OR v_sh.organization_id IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy cổ đông trong tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;
  SELECT m.id INTO v_membership
    FROM public.organization_memberships m
   WHERE m.user_id = v_actor
     AND m.organization_id = v_sh.organization_id
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= clock_timestamp()
     AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())
   ORDER BY m.id
   LIMIT 1;
  IF v_membership IS NULL OR v_sh.deleted_at IS NOT NULL OR NOT v_sh.is_active THEN
    RAISE EXCEPTION 'Không tìm thấy cổ đông trong tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;
  IF p_account_id IS NOT NULL THEN
    PERFORM 1
      FROM public.accounts a
     WHERE a.id = p_account_id
       AND a.organization_id = v_sh.organization_id
       AND a.deleted_at IS NULL
       AND NOT a.is_virtual;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_route := app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', v_sh.organization_id);
  v_self := COALESCE(v_sh.auth_user_id = v_actor, false);

  -- Người gọi phải giữ sổ: sổ đã chọn, hoặc (chưa chọn sổ) ít nhất một sổ quỹ thật của công ty.
  IF p_account_id IS NOT NULL THEN
    v_holds := app_private.profit_ledger_chot_holds_cashbook_v1(v_sh.organization_id, p_account_id, v_membership);
  ELSE
    v_holds := EXISTS (
      SELECT 1 FROM public.accounts a
       WHERE a.organization_id = v_sh.organization_id AND a.deleted_at IS NULL AND NOT a.is_virtual
         AND app_private.profit_ledger_chot_holds_cashbook_v1(v_sh.organization_id, a.id, v_membership));
  END IF;
  -- Quyền của người nhận chỉ xét (và chỉ lộ ra) khi người gọi giữ sổ, là chính người nhận, hoặc có quyền chi lợi nhuận.
  v_see_numbers := app_private.profit_viewer_can_v1(v_sh.organization_id, 'shareholder_profit.distribute');
  IF v_holds OR v_self OR v_see_numbers THEN
    v_right := app_private.profit_ledger_chot_advance_right_v1(v_sh.organization_id, v_sh.auth_user_id);
  END IF;
  v_see_numbers := v_see_numbers OR (v_self AND v_right);

  v_pos := app_private.profit_ledger_position_v1(v_sh.organization_id, p_shareholder_id);
  v_balance := (v_pos ->> 'balance')::numeric;

  v_blocked := CASE
    WHEN v_route IS DISTINCT FROM 'CANONICAL' THEN 'ROUTE'
    WHEN NOT v_holds THEN 'NOT_CUSTODIAN'
    WHEN NOT v_right THEN 'PAYEE_NO_RIGHT'
    WHEN COALESCE((v_pos -> 'needs_review' ->> 'count')::integer, 0) > 0 THEN 'SALARY_REVIEW_PENDING' END;

  IF p_amount IS NOT NULL THEN
    v_warnings := app_private.profit_ledger_tao_warnings_v1(p_amount, GREATEST(p_amount - v_balance, 0),
                    app_private.profit_ledger_open_estimate_v1(v_sh.organization_id, p_shareholder_id));
    IF NOT v_see_numbers THEN
      -- Cảnh báo "vượt ước tính" mang số dư và ước tính của cổ đông: không trả cho người lập hộ.
      SELECT COALESCE(jsonb_agg(w.value ORDER BY w.ordinality), '[]'::jsonb) INTO v_warnings
        FROM jsonb_array_elements(v_warnings) WITH ORDINALITY AS w(value, ordinality)
       WHERE w.value ->> 'code' IS DISTINCT FROM 'ADVANCE_EXCEEDS_ESTIMATE';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'route', v_route,
    'shareholder_id', p_shareholder_id,
    'maker_kind', CASE WHEN v_self THEN 'CUSTODIAN_ADVANCE' ELSE 'CUSTODIAN_FOR_PAYEE' END,
    'payee_is_maker', v_self,
    'can_submit', v_blocked IS NULL AND p_amount IS NOT NULL AND p_account_id IS NOT NULL,
    'blocked_reason', v_blocked,
    'warnings', v_warnings,
    'position', CASE WHEN v_see_numbers THEN
      v_pos || jsonb_build_object('after_advance', CASE WHEN p_amount IS NOT NULL THEN jsonb_build_object(
        'advance_pending', (v_pos ->> 'advance_pending')::numeric + p_amount,
        'balance', v_balance - p_amount) END) END);
END
$fn$;

-- W1. Lập phiếu tạm ứng cho cổ đông từ sổ quỹ người gọi đang giữ. Dựng từ thân E5 (shareholder_profit_ledger_payout_v1,
-- 20261115084108), đổi: quyền (giữ sổ + người nhận có quyền tạm ứng; không xét quyền chi lợi nhuận), cách lập
-- (chính mình ⇒ CUSTODIAN_ADVANCE, lập hộ ⇒ CUSTODIAN_FOR_PAYEE), không có bước xác nhận tạm ứng (toàn bộ số tiền là
-- tạm ứng: within_amount = 0), hạng mục "Tạm Ứng", tên phiếu, operation riêng. Mọi phiếu vẫn chờ chủ duyệt (F1).
-- Thứ tự: đầu vào → thành viên → khoá công ty → FOR SHARE cổ đông / toà ảo / sổ quỹ / thành viên → quyền →
-- operation → công tắc + nhận lượt → hai khoá ngày → hạng mục → khoá sổ → nextval → số dư → ghi.
CREATE OR REPLACE FUNCTION public.shareholder_profit_advance_v1(
  p_shareholder_id uuid,
  p_amount numeric,
  p_account_id uuid,
  p_voucher_date date,
  p_note text,
  p_idempotency_key text
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_operation    constant text := 'shareholder_profit.ledger_advance.v1';
  c_flag         constant text := 'shareholder_profit.ledger_payout.v1';
  v_actor        uuid := auth.uid();
  v_key          text := btrim(COALESCE(p_idempotency_key, ''));
  v_note         text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_amount       numeric(15,2);
  v_org          uuid;
  v_scope        text;
  v_subject_name text;
  v_payee_user   uuid;
  v_building     uuid;
  v_owner        uuid;
  v_membership   uuid;
  v_maker_kind   text;
  v_self         boolean;
  v_hash         text;
  v_operation    app_private.canonical_write_operations%ROWTYPE;
  v_type         uuid;
  v_seq          bigint;
  v_bal          jsonb;
  v_balance      numeric;
  v_estimate     numeric;
  v_warnings     jsonb;
  v_shown        jsonb;
  v_voucher      uuid := gen_random_uuid();
  v_request      uuid;
  v_response     jsonb;
BEGIN
  -- 1. Đầu vào.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <= 0 OR round(p_amount, 2) <> p_amount OR p_amount >= 10000000000000 THEN
    RAISE EXCEPTION 'Số tiền tạm ứng không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_amount := p_amount;
  IF p_account_id IS NULL OR p_voucher_date IS NULL THEN
    RAISE EXCEPTION 'Thiếu sổ quỹ hoặc ngày chi' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Ghi chú dài quá 500 ký tự' USING ERRCODE = '22023';
  END IF;

  -- Công ty của cổ đông: đọc thường (chưa khoá). Người không phải thành viên công ty đó dừng ở đây,
  -- trước khi kịp khoá dòng công ty của người khác. "Không có cổ đông đó" và "không thuộc công ty của cổ đông"
  -- trả CÙNG một câu: người ngoài không dò được một mã cổ đông có tồn tại hay không.
  SELECT s.organization_id INTO v_org FROM public.shareholders s WHERE s.id = p_shareholder_id;
  IF v_org IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.organization_memberships m
        WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'Không có quyền lập phiếu tạm ứng cổ đông, hoặc không tìm thấy cổ đông trong tổ chức hợp lệ'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Khoá công ty TRƯỚC, rồi mới FOR SHARE (không khoá dòng organizations lần nữa).
  IF app_private.lock_org_for_decision_v1(v_org) IS NULL THEN
    RAISE EXCEPTION 'Tổ chức không còn hoạt động' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(NULLIF(btrim(s.name), ''), 'Cổ đông'), s.auth_user_id
    INTO v_subject_name, v_payee_user
    FROM public.shareholders s
   WHERE s.id = p_shareholder_id
     AND s.organization_id = v_org
     AND s.deleted_at IS NULL
     AND s.is_active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy cổ đông trong tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  SELECT b.id, b.user_id INTO v_building, v_owner
    FROM public.buildings b
   WHERE b.organization_id = v_org
     AND b.is_virtual
     AND b.deleted_at IS NULL
   ORDER BY b.created_at
   LIMIT 1
   FOR SHARE OF b;
  IF v_building IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có toà ảo để hạch toán chia lợi nhuận' USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.accounts a
   WHERE a.id = p_account_id
     AND a.organization_id = v_org
     AND a.deleted_at IS NULL
     AND NOT a.is_virtual
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức' USING ERRCODE = '42501';
  END IF;

  SELECT m.id INTO v_membership
    FROM public.organization_memberships m
   WHERE m.user_id = v_actor
     AND m.organization_id = v_org
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= clock_timestamp()
     AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())
   ORDER BY m.id
   LIMIT 1
   FOR SHARE;
  IF v_membership IS NULL THEN
    RAISE EXCEPTION 'Không còn là thành viên tổ chức' USING ERRCODE = '42501';
  END IF;

  -- 3. Quyền: (a) người gọi đang GIỮ sổ quỹ chi; (b) cổ đông có đăng nhập và người nhận được cấp quyền tạm ứng.
  --    Không xét quyền chi lợi nhuận: chủ tự ứng cũng đi cách "người giữ sổ tự tạm ứng" để tự ghi sổ được sau khi
  --    chủ khác duyệt.
  IF NOT app_private.profit_ledger_chot_holds_cashbook_v1(v_org, p_account_id, v_membership) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_ADVANCE_CASHBOOK: chỉ lập phiếu tạm ứng từ sổ quỹ bạn đang giữ'
      USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.profit_ledger_chot_advance_right_v1(v_org, v_payee_user) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_ADVANCE_PAYEE_NO_RIGHT: người nhận chưa được cấp quyền tạm ứng'
      USING ERRCODE = '42501';
  END IF;
  v_self := COALESCE(v_payee_user = v_actor, false);
  v_maker_kind := CASE WHEN v_self THEN 'CUSTODIAN_ADVANCE' ELSE 'CUSTODIAN_FOR_PAYEE' END;

  -- 4. Idempotency (khoá dùng lại với nội dung khác ⇒ 23505; đã xong ⇒ trả kết quả cũ).
  v_scope := 'SHAREHOLDER:' || p_shareholder_id::text;
  v_hash := md5(jsonb_build_object(
    'shareholder_id', p_shareholder_id,
    'amount', round(p_amount, 2),
    'account_id', p_account_id,
    'voucher_date', p_voucher_date,
    'note', v_note,
    'organization_id', v_org
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash, actor_membership_id
  ) VALUES (
    v_org, c_operation, v_scope, v_actor, v_key, v_hash, v_membership
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key) DO NOTHING;

  SELECT * INTO v_operation
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_org
     AND o.operation = c_operation
     AND o.subject_scope = v_scope
     AND o.actor_id = v_actor
     AND o.idempotency_key = v_key
   FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  -- 5. Công tắc sổ tổng phải BẬT (CANONICAL); nhận lượt (CANARY đếm trần; ON chỉ giữ dòng cờ tới commit).
  PERFORM app_private.profit_ledger_tao_assert_route_v1(v_org, ARRAY['CANONICAL']);
  PERFORM app_private.claim_feature_operation_v1(c_flag, v_org, c_operation || '|' || v_scope, v_actor, v_key, v_amount);

  -- 6. Hai khoá ngày, hạng mục "Tạm Ứng".
  PERFORM app_private.profit_ledger_chot_assert_ngay_v1(v_building, p_account_id, p_voucher_date);
  v_type := app_private.profit_ledger_chot_hang_muc_v1(v_org, v_owner, 'tam_ung_co_dong');

  -- 7. Khoá sổ của cổ đông → thứ tự sổ → số dư ròng. Toàn bộ số tiền là tạm ứng.
  PERFORM app_private.profit_ledger_lock_v1(v_org, 'SHAREHOLDER', p_shareholder_id);
  v_seq := nextval('app_private.profit_ledger_seq');
  v_bal := app_private.profit_ledger_balance_v1(v_org, 'SHAREHOLDER', p_shareholder_id);
  IF COALESCE((v_bal -> 'needs_review' ->> 'count')::integer, 0) > 0 THEN
    IF NOT v_self THEN
      -- Lập hộ: chỉ mã + câu, KHÔNG kèm DETAIL — needs_review.suggested là tiền của cổ đông, người lập hộ không được thấy.
      RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: cổ đông còn phiếu lương cần chủ xem lại — xác nhận số trước khi tạm ứng lợi nhuận'
        USING ERRCODE = '55000';
    END IF;
    RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: cổ đông còn phiếu lương cần chủ xem lại — xác nhận số trước khi tạm ứng lợi nhuận'
      USING ERRCODE = '55000', DETAIL = (v_bal -> 'needs_review')::text;
  END IF;
  v_balance := (v_bal ->> 'balance')::numeric;
  v_estimate := app_private.profit_ledger_open_estimate_v1(v_org, p_shareholder_id);
  v_warnings := app_private.profit_ledger_tao_warnings_v1(v_amount, GREATEST(v_amount - v_balance, 0), v_estimate);

  -- 8. Phiếu + dòng + dòng sổ + gửi duyệt + nhật ký (nghi thức chung của sổ tổng).
  v_request := app_private.profit_ledger_chot_lap_phieu_v1(
    v_voucher, v_org, p_shareholder_id, v_building, v_owner, p_account_id, v_amount, p_voucher_date,
    COALESCE(v_note, 'Tạm ứng: ' || v_subject_name), v_note, v_type, v_hash, v_key, v_actor, v_membership,
    v_maker_kind, v_payee_user, v_seq, v_balance, 0, v_amount, v_estimate, v_warnings,
    jsonb_build_object('payout_kind', 'ADVANCE'));

  -- 9. Kết quả. Người lập hộ không nhận số dư và cảnh báo mang số của cổ đông.
  IF v_self THEN
    v_shown := v_warnings;
  ELSE
    SELECT COALESCE(jsonb_agg(w.value ORDER BY w.ordinality), '[]'::jsonb) INTO v_shown
      FROM jsonb_array_elements(v_warnings) WITH ORDINALITY AS w(value, ordinality)
     WHERE w.value ->> 'code' IS DISTINCT FROM 'ADVANCE_EXCEEDS_ESTIMATE';
  END IF;
  v_response := jsonb_build_object(
    'voucher_id', v_voucher,
    'approval_request_id', v_request,
    'shareholder_id', p_shareholder_id,
    'amount', v_amount,
    'within_amount', 0,
    'advance_amount', v_amount,
    'balance_before', CASE WHEN v_self THEN v_balance END,
    'warnings', v_shown,
    'maker_kind', v_maker_kind,
    'payout_kind', 'ADVANCE',
    'state', 'PENDING_APPROVAL'
  );
  UPDATE app_private.canonical_write_operations
     SET subject_id = v_voucher,
         response_payload = v_response,
         completed_at = clock_timestamp()
   WHERE organization_id = v_org
     AND operation = c_operation
     AND subject_scope = v_scope
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END
$fn$;

-- ── 7. Chốt chi lợi nhuận ──────────────────────────────────────────────────────────────

-- R5. Xem trước một lần chốt đến hết tháng N. STABLE, không khoá dòng.
-- N NULL ⇒ tháng ĐỦ ĐIỀU KIỆN lớn nhất (có phân bổ đã chốt, sau mốc, không trước lần chốt gần nhất) — KHÔNG phải tháng
-- lớn nhất còn tiền để chốt: tháng cuối lỗ làm luỹ kế ≤ 0 thì mặc định vẫn là tháng cuối và báo NOTHING_TO_SETTLE; chủ
-- muốn chốt đến một tháng sớm hơn (bỏ tháng lỗ lại) thì phải tự chọn tháng đó.
CREATE OR REPLACE FUNCTION public.shareholder_profit_settlement_preview_v1(
  p_shareholder_id uuid,
  p_through_month date,
  p_account_id uuid
) RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_sh      record;
  v_route   text;
  v_months  jsonb;
  v_pos     jsonb;
  v_n       date;
  v_month   jsonb;
  v_x       numeric;
  v_adv     numeric;
  v_k       numeric;
  v_cash    numeric;
  v_blocked text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_shareholder_id IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: thiếu mã cổ đông' USING ERRCODE = '22023';
  END IF;
  SELECT s.organization_id, s.is_active, s.deleted_at
    INTO v_sh
    FROM public.shareholders s
   WHERE s.id = p_shareholder_id;
  -- "Không có" và "không được chốt" trả cùng một lỗi (không lộ cổ đông của công ty khác).
  IF NOT FOUND OR v_sh.organization_id IS NULL
     OR NOT app_private.profit_viewer_can_v1(v_sh.organization_id, 'shareholder_profit.distribute')
     OR v_sh.deleted_at IS NOT NULL OR NOT v_sh.is_active THEN
    RAISE EXCEPTION 'Không có quyền chi lợi nhuận cổ đông, hoặc không tìm thấy cổ đông trong tổ chức hợp lệ'
      USING ERRCODE = '42501';
  END IF;
  IF p_account_id IS NOT NULL THEN
    PERFORM 1
      FROM public.accounts a
     WHERE a.id = p_account_id
       AND a.organization_id = v_sh.organization_id
       AND a.deleted_at IS NULL
       AND NOT a.is_virtual;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_through_month IS NOT NULL AND (NOT isfinite(p_through_month) OR EXTRACT(DAY FROM p_through_month) <> 1) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải là ngày đầu tháng' USING ERRCODE = '22023';
  END IF;

  v_route := app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', v_sh.organization_id);
  v_months := app_private.profit_ledger_chot_months_v1(v_sh.organization_id, p_shareholder_id);
  v_pos := v_months -> 'position';
  v_adv := (v_pos ->> 'advance_outstanding')::numeric;

  v_n := COALESCE(p_through_month, (v_months ->> 'max_eligible')::date);
  IF v_n IS NOT NULL THEN
    SELECT m.value INTO v_month
      FROM jsonb_array_elements(v_months -> 'months') AS m(value)
     WHERE (m.value ->> 'month')::date = v_n;
    IF v_month IS NULL OR NOT (v_month ->> 'eligible')::boolean THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải là tháng đã chốt lợi nhuận của cổ đông, sau mốc "đã trả đủ" và không trước lần chốt chi gần nhất'
        USING ERRCODE = '22023',
              DETAIL = jsonb_build_object('through_month', v_n, 'min', v_months -> 'min_eligible',
                                          'max', v_months -> 'max_eligible')::text;
    END IF;
    v_x := (v_month ->> 'unpaid_through')::numeric;
    v_k := LEAST(v_x, GREATEST(v_adv, 0));
    v_cash := v_x - v_k;
  END IF;

  v_blocked := CASE
    WHEN v_route IS DISTINCT FROM 'CANONICAL' THEN 'ROUTE'
    WHEN COALESCE((v_pos -> 'needs_review' ->> 'count')::integer, 0) > 0 THEN 'SALARY_REVIEW_PENDING'
    WHEN v_n IS NULL OR v_x <= 0 THEN 'NOTHING_TO_SETTLE'
    WHEN v_cash > 0 AND p_account_id IS NULL THEN 'ACCOUNT_REQUIRED' END;
  IF v_x <= 0 THEN
    -- Không có gì để chốt ở tháng này: không trả con số khấu trừ / tiền (K, tiền chỉ có nghĩa khi X > 0).
    v_k := NULL;
    v_cash := NULL;
  END IF;

  RETURN jsonb_build_object(
    'route', v_route,
    'shareholder_id', p_shareholder_id,
    'months', (SELECT COALESCE(jsonb_agg(m.value - 'eligible' ORDER BY m.ordinality), '[]'::jsonb)
                 FROM jsonb_array_elements(v_months -> 'months') WITH ORDINALITY AS m(value, ordinality)),
    'min_through_month', v_months -> 'min_selectable',
    'through_month', v_n,
    'position', v_pos,
    'recognized_amount', v_x,
    'advance_offset_amount', v_k,
    'cash_amount', v_cash,
    'advance_left', v_adv - v_k,
    'advance_pending', v_pos -> 'advance_pending',
    'settlements', app_private.profit_ledger_chot_rows_v1(v_sh.organization_id, p_shareholder_id),
    'can_submit', v_blocked IS NULL,
    'blocked_reason', v_blocked);
END
$fn$;

-- W2. Chủ chốt chi lợi nhuận đến hết tháng N. Dưới khoá sổ: X = lợi nhuận chưa chi của các tháng ≤ N,
-- K = least(X, greatest(tạm ứng ĐÃ DUYỆT đang có, 0)), tiền = X − K. Lệnh chốt là điểm CHỐT SỐ LIỆU: số lưu phải đúng
-- số chủ vừa xem ⇒ so-rồi-ghi trên CẢ phần ghi nhận lẫn tiền: X khác p_expected_recognized HOẶC tiền khác
-- p_expected_cash ⇒ PT409, không ghi gì (X và K cùng đổi một lượng thì tiền không đổi — chỉ so tiền là chưa đủ).
-- Tiền > 0 ⇒ một phiếu chi chờ duyệt (hạng mục chia_loi_nhuan) rồi bản ghi chốt trỏ phiếu; tiền = 0 ⇒ chỉ bản ghi
-- chốt, có hiệu lực ngay.
-- Thứ tự: đầu vào → thành viên → khoá công ty → FOR SHARE cổ đông / toà ảo / sổ quỹ / thành viên → quyền →
-- operation → công tắc + nhận lượt → khoá sổ → nextval → vị thế → kiểm → ghi.
CREATE OR REPLACE FUNCTION public.shareholder_profit_settle_v1(
  p_shareholder_id uuid,
  p_through_month date,
  p_account_id uuid,
  p_voucher_date date,
  p_note text,
  p_expected_recognized numeric,
  p_expected_cash numeric,
  p_idempotency_key text
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_operation    constant text := 'shareholder_profit.ledger_settle.v1';
  c_flag         constant text := 'shareholder_profit.ledger_payout.v1';
  v_actor        uuid := auth.uid();
  v_key          text := btrim(COALESCE(p_idempotency_key, ''));
  v_note         text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_org          uuid;
  v_scope        text;
  v_subject_name text;
  v_payee_user   uuid;
  v_building     uuid;
  v_owner        uuid;
  v_membership   uuid;
  v_authz        boolean;
  v_hash         text;
  v_operation    app_private.canonical_write_operations%ROWTYPE;
  v_seq          bigint;
  v_months       jsonb;
  v_pos          jsonb;
  v_month        jsonb;
  v_unpaid       numeric;
  v_adv          numeric;
  v_balance      numeric;
  v_x            numeric(15,2);
  v_k            numeric(15,2);
  v_cash         numeric(15,2);
  v_type         uuid;
  v_estimate     numeric;
  v_warnings     jsonb;
  v_voucher      uuid;
  v_request      uuid;
  v_settlement   uuid := gen_random_uuid();
  v_after        jsonb;
  v_response     jsonb;
BEGIN
  -- 1. Đầu vào.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE = '22023';
  END IF;
  IF p_through_month IS NULL OR NOT isfinite(p_through_month) OR EXTRACT(DAY FROM p_through_month) <> 1 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải là ngày đầu tháng' USING ERRCODE = '22023';
  END IF;
  -- Hai số chủ đã xem trước: phần ghi nhận (> 0 — không có gì để ghi nhận thì không có lần chốt) và tiền thực chi (≥ 0).
  IF p_expected_recognized IS NULL OR p_expected_recognized::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_expected_recognized <= 0 OR round(p_expected_recognized, 2) <> p_expected_recognized
     OR p_expected_recognized >= 10000000000000 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_EXPECTED: thiếu hoặc sai phần lợi nhuận ghi nhận đã xem trước' USING ERRCODE = '22023';
  END IF;
  IF p_expected_cash IS NULL OR p_expected_cash::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_expected_cash < 0 OR round(p_expected_cash, 2) <> p_expected_cash OR p_expected_cash >= 10000000000000 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_EXPECTED: thiếu hoặc sai số tiền thực chi đã xem trước' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Ghi chú dài quá 500 ký tự' USING ERRCODE = '22023';
  END IF;

  -- Công ty của cổ đông: đọc thường (chưa khoá). Người ngoài công ty dừng trước khi kịp khoá dòng công ty.
  -- "Không có cổ đông đó" và "không thuộc công ty của cổ đông" trả CÙNG một câu: người ngoài không dò được một mã
  -- cổ đông có tồn tại hay không.
  SELECT s.organization_id INTO v_org FROM public.shareholders s WHERE s.id = p_shareholder_id;
  IF v_org IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.organization_memberships m
        WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'Không có quyền chi lợi nhuận cổ đông, hoặc không tìm thấy cổ đông trong tổ chức hợp lệ'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Khoá công ty TRƯỚC, rồi mới FOR SHARE. Sổ quỹ / toà ảo chỉ bắt buộc khi có tiền thực chi (kiểm ở bước 7).
  IF app_private.lock_org_for_decision_v1(v_org) IS NULL THEN
    RAISE EXCEPTION 'Tổ chức không còn hoạt động' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(NULLIF(btrim(s.name), ''), 'Cổ đông'), s.auth_user_id
    INTO v_subject_name, v_payee_user
    FROM public.shareholders s
   WHERE s.id = p_shareholder_id
     AND s.organization_id = v_org
     AND s.deleted_at IS NULL
     AND s.is_active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy cổ đông trong tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  SELECT b.id, b.user_id INTO v_building, v_owner
    FROM public.buildings b
   WHERE b.organization_id = v_org
     AND b.is_virtual
     AND b.deleted_at IS NULL
   ORDER BY b.created_at
   LIMIT 1
   FOR SHARE OF b;

  IF p_account_id IS NOT NULL THEN
    PERFORM 1 FROM public.accounts a
     WHERE a.id = p_account_id
       AND a.organization_id = v_org
       AND a.deleted_at IS NULL
       AND NOT a.is_virtual
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT m.id INTO v_membership
    FROM public.organization_memberships m
   WHERE m.user_id = v_actor
     AND m.organization_id = v_org
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= clock_timestamp()
     AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())
   ORDER BY m.id
   LIMIT 1
   FOR SHARE;
  IF v_membership IS NULL THEN
    RAISE EXCEPTION 'Không còn là thành viên tổ chức' USING ERRCODE = '42501';
  END IF;

  -- 3. Quyền: chỉ người có quyền chi lợi nhuận (chủ) chốt.
  SELECT a.allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(v_actor, v_org, 'shareholder_profit.distribute', v_building, p_account_id) a;
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền chi lợi nhuận cổ đông' USING ERRCODE = '42501';
  END IF;

  -- 4. Idempotency: nội dung = (cổ đông, tháng, sổ, ngày, ghi chú, công ty). Hai số kỳ vọng (ghi nhận, tiền) là điều kiện,
  --    không phải nội dung.
  v_scope := 'SHAREHOLDER:' || p_shareholder_id::text;
  v_hash := md5(jsonb_build_object(
    'shareholder_id', p_shareholder_id,
    'through_month', p_through_month,
    'account_id', p_account_id,
    'voucher_date', p_voucher_date,
    'note', v_note,
    'organization_id', v_org
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash, actor_membership_id
  ) VALUES (
    v_org, c_operation, v_scope, v_actor, v_key, v_hash, v_membership
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key) DO NOTHING;

  SELECT * INTO v_operation
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_org
     AND o.operation = c_operation
     AND o.subject_scope = v_scope
     AND o.actor_id = v_actor
     AND o.idempotency_key = v_key
   FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  -- 5. Công tắc sổ tổng phải BẬT (CANONICAL); nhận lượt với số tiền chủ đã xem (khác số thật thì bước 6 huỷ cả lệnh).
  PERFORM app_private.profit_ledger_tao_assert_route_v1(v_org, ARRAY['CANONICAL']);
  PERFORM app_private.claim_feature_operation_v1(c_flag, v_org, c_operation || '|' || v_scope, v_actor, v_key, p_expected_cash);

  -- 6. Khoá sổ của cổ đông → thứ tự sổ → vị thế + các tháng (một lần đọc) → X, K, tiền.
  PERFORM app_private.profit_ledger_lock_v1(v_org, 'SHAREHOLDER', p_shareholder_id);
  v_seq := nextval('app_private.profit_ledger_seq');
  v_months := app_private.profit_ledger_chot_months_v1(v_org, p_shareholder_id);
  v_pos := v_months -> 'position';
  IF COALESCE((v_pos -> 'needs_review' ->> 'count')::integer, 0) > 0 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: cổ đông còn phiếu lương cần chủ xem lại — xác nhận số trước khi chốt chi lợi nhuận'
      USING ERRCODE = '55000', DETAIL = (v_pos -> 'needs_review')::text;
  END IF;
  SELECT m.value INTO v_month
    FROM jsonb_array_elements(v_months -> 'months') AS m(value)
   WHERE (m.value ->> 'month')::date = p_through_month;
  IF v_month IS NULL OR NOT (v_month ->> 'eligible')::boolean THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải là tháng đã chốt lợi nhuận của cổ đông, sau mốc "đã trả đủ" và không trước lần chốt chi gần nhất'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('through_month', p_through_month, 'min', v_months -> 'min_eligible',
                                        'max', v_months -> 'max_eligible')::text;
  END IF;
  v_unpaid := (v_pos ->> 'unpaid_profit')::numeric;
  v_adv := (v_pos ->> 'advance_outstanding')::numeric;
  v_balance := (v_pos ->> 'balance')::numeric;
  v_x := (v_month ->> 'unpaid_through')::numeric;
  IF v_x <= 0 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_NOTHING: không còn lợi nhuận chưa chi đến hết tháng % để chốt', to_char(p_through_month, 'MM/YYYY')
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('through_month', p_through_month, 'unpaid_through', v_x)::text;
  END IF;
  -- Chỉ khấu trừ tạm ứng ĐÃ DUYỆT, và không quá phần ghi nhận.
  v_k := LEAST(v_x, GREATEST(v_adv, 0));
  v_cash := v_x - v_k;
  -- So-rồi-ghi. PT409 (HTTP 409), KHÔNG dùng mã lớp 40: PostgREST tự chạy lại giao dịch khi gặp 40001.
  -- So cả phần GHI NHẬN lẫn tiền: X và K cùng đổi một lượng (toà chốt muộn + một phiếu tạm ứng vừa được duyệt) thì
  -- tiền không đổi, nhưng bản ghi chốt sẽ lưu số khác số chủ đã xem.
  IF v_x IS DISTINCT FROM p_expected_recognized
     OR v_cash IS DISTINCT FROM p_expected_cash THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_CHANGED: số liệu vừa đổi so với lúc xem trước — tải lại rồi xem trước lần nữa'
      USING ERRCODE = 'PT409',
            DETAIL = jsonb_build_object('expected_recognized', p_expected_recognized, 'expected_cash', p_expected_cash, 'cash_amount', v_cash,
                                        'recognized_amount', v_x, 'advance_offset_amount', v_k,
                                        'through_month', p_through_month)::text;
  END IF;

  -- 7. Có tiền thực chi ⇒ lập phiếu chi chờ duyệt (within = toàn bộ số tiền, không có phần tạm ứng).
  IF v_cash > 0 THEN
    IF p_account_id IS NULL OR p_voucher_date IS NULL THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_ACCOUNT: lần chốt này có tiền thực chi — cần sổ quỹ và ngày chi'
        USING ERRCODE = '22023', DETAIL = jsonb_build_object('cash_amount', v_cash)::text;
    END IF;
    IF v_building IS NULL THEN
      RAISE EXCEPTION 'Tổ chức chưa có toà ảo để hạch toán chia lợi nhuận' USING ERRCODE = '55000';
    END IF;
    PERFORM app_private.profit_ledger_chot_assert_ngay_v1(v_building, p_account_id, p_voucher_date);
    v_type := app_private.profit_ledger_chot_hang_muc_v1(v_org, v_owner, 'chia_loi_nhuan');
    v_estimate := app_private.profit_ledger_open_estimate_v1(v_org, p_shareholder_id);
    v_warnings := app_private.profit_ledger_tao_warnings_v1(0, 0, v_estimate);
    v_voucher := gen_random_uuid();
    v_request := app_private.profit_ledger_chot_lap_phieu_v1(
      v_voucher, v_org, p_shareholder_id, v_building, v_owner, p_account_id, v_cash, p_voucher_date,
      COALESCE(v_note, 'Chi lợi nhuận đến hết ' || to_char(p_through_month, 'MM/YYYY') || ': ' || v_subject_name),
      v_note, v_type, v_hash, v_key, v_actor, v_membership,
      'OWNER', v_payee_user, v_seq, v_balance, v_cash, 0, v_estimate, v_warnings,
      jsonb_build_object('payout_kind', 'SETTLEMENT', 'settlement_id', v_settlement, 'through_month', p_through_month,
                         'recognized_amount', v_x, 'advance_offset_amount', v_k));
    -- Bản ghi chốt là một dòng sổ riêng: thứ tự sổ mới, đứng sau dòng sổ của phiếu tiền.
    v_seq := nextval('app_private.profit_ledger_seq');
  END IF;

  -- 8. Bản ghi chốt.
  INSERT INTO app_private.profit_ledger_payout_settlements (
    id, organization_id, shareholder_id, through_month, recognized_amount, advance_offset_amount, cash_amount,
    cash_voucher_id, unpaid_before, advance_before, note, ledger_seq, created_by
  ) VALUES (
    v_settlement, v_org, p_shareholder_id, p_through_month, v_x, v_k, v_cash,
    v_voucher, v_unpaid, v_adv, v_note, v_seq, v_actor
  );

  -- Bất biến: ngay sau khi ghi (đang giữ khoá sổ), hai con số phải giảm đúng X và K, tiền chờ chi tăng đúng phần tiền.
  v_after := app_private.profit_ledger_position_v1(v_org, p_shareholder_id);
  IF (v_after ->> 'unpaid_profit')::numeric IS DISTINCT FROM v_unpaid - v_x
     OR (v_after ->> 'advance_outstanding')::numeric IS DISTINCT FROM v_adv - v_k
     OR (v_after ->> 'settlement_cash_pending')::numeric
        IS DISTINCT FROM (v_pos ->> 'settlement_cash_pending')::numeric + v_cash THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_MISMATCH: vị thế sau khi chốt khác số đã tính — dừng'
      USING ERRCODE = '55000',
            DETAIL = jsonb_build_object('before', v_pos - 'components', 'after', v_after - 'components',
                                        'recognized_amount', v_x, 'advance_offset_amount', v_k, 'cash_amount', v_cash)::text;
  END IF;

  v_response := jsonb_build_object(
    'settlement_id', v_settlement,
    'through_month', p_through_month,
    'recognized_amount', v_x,
    'advance_offset_amount', v_k,
    'cash_amount', v_cash,
    'voucher_id', v_voucher,
    'approval_request_id', v_request,
    'state', CASE WHEN v_cash > 0 THEN 'PENDING_APPROVAL' ELSE 'SETTLED' END
  );
  UPDATE app_private.canonical_write_operations
     SET subject_id = v_settlement,
         response_payload = v_response,
         completed_at = clock_timestamp()
   WHERE organization_id = v_org
     AND operation = c_operation
     AND subject_scope = v_scope
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END
$fn$;

-- W3. Huỷ một bản ghi chốt KHÔNG có phiếu tiền (bản có phiếu tiền: huỷ phiếu bằng profit_ledger_payout_cancel_v1,
-- bản ghi tự hết hiệu lực). Bắt buộc lý do 8..1000. Như lệnh huỷ phiếu: chạy ở mọi trạng thái của công tắc.
CREATE OR REPLACE FUNCTION public.shareholder_profit_settlement_void_v1(
  p_settlement_id uuid,
  p_reason text,
  p_idempotency_key text
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_operation constant text := 'shareholder_profit.ledger_settle_void.v1';
  v_actor     uuid := auth.uid();
  v_key       text := btrim(COALESCE(p_idempotency_key, ''));
  v_reason    text := btrim(COALESCE(p_reason, ''));
  v_org       uuid;
  v_sh        uuid;
  v_authz     boolean;
  v_hash      text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_row       app_private.profit_ledger_payout_settlements%ROWTYPE;
  v_response  jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_settlement_id IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: thiếu bản ghi chốt cần huỷ' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_REASON: lý do huỷ bản ghi chốt phải dài 8–1000 ký tự' USING ERRCODE = '22023';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE = '22023';
  END IF;

  -- Đọc thường để biết công ty; "không có" và "không thuộc công ty của bạn" trả cùng một lỗi.
  SELECT s.organization_id, s.shareholder_id INTO v_org, v_sh
    FROM app_private.profit_ledger_payout_settlements s
   WHERE s.id = p_settlement_id;
  IF v_org IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.organization_memberships m
        WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'Không có quyền chi lợi nhuận cổ đông, hoặc không tìm thấy bản ghi chốt' USING ERRCODE = '42501';
  END IF;

  IF app_private.lock_org_for_decision_v1(v_org) IS NULL THEN
    RAISE EXCEPTION 'Tổ chức không còn hoạt động' USING ERRCODE = '42501';
  END IF;
  SELECT a.allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(v_actor, v_org, 'shareholder_profit.distribute', NULL, NULL) a;
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền chi lợi nhuận cổ đông, hoặc không tìm thấy bản ghi chốt' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object('settlement_id', p_settlement_id, 'reason', v_reason)::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    v_org, c_operation, p_settlement_id::text, v_actor, v_key, v_hash
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key) DO NOTHING;
  SELECT * INTO v_operation
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_org
     AND o.operation = c_operation
     AND o.subject_scope = p_settlement_id::text
     AND o.actor_id = v_actor
     AND o.idempotency_key = v_key
   FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  -- Khoá sổ của cổ đông rồi mới đọc lại bản ghi (đọc dưới khoá).
  PERFORM app_private.profit_ledger_lock_v1(v_org, 'SHAREHOLDER', v_sh);
  SELECT * INTO v_row
    FROM app_private.profit_ledger_payout_settlements s
   WHERE s.id = p_settlement_id
   FOR UPDATE;
  IF v_row.cash_voucher_id IS NOT NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_HAS_VOUCHER: bản ghi chốt này có phiếu tiền — huỷ phiếu tiền bằng lệnh huỷ phiếu chi theo sổ tổng, bản ghi chốt tự hết hiệu lực'
      USING ERRCODE = '22023', DETAIL = jsonb_build_object('cash_voucher_id', v_row.cash_voucher_id)::text;
  END IF;
  IF v_row.state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_NOT_ACTIVE: bản ghi chốt này đã huỷ từ trước'
      USING ERRCODE = '55000', DETAIL = jsonb_build_object('state', v_row.state)::text;
  END IF;

  UPDATE app_private.profit_ledger_payout_settlements
     SET state = 'VOID',
         voided_by = v_actor,
         voided_at = clock_timestamp(),
         void_reason = v_reason
   WHERE id = p_settlement_id;

  v_response := jsonb_build_object('settlement_id', p_settlement_id, 'state', 'VOID');
  UPDATE app_private.canonical_write_operations
     SET subject_id = p_settlement_id,
         response_payload = v_response,
         completed_at = clock_timestamp()
   WHERE organization_id = v_org
     AND operation = c_operation
     AND subject_scope = p_settlement_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END
$fn$;

-- ── 8. Quyền gọi ──────────────────────────────────────────────────────────────────────
-- Hàm nội bộ và hàm trigger: không vai nào.
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_payout_settlement_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_marker_settlement_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_settlement_live_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_position_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_unpaid_through_v1(uuid, uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_chot_months_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_chot_rows_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_chot_advance_right_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_chot_holds_cashbook_v1(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_chot_hang_muc_v1(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_chot_assert_ngay_v1(uuid, uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_chot_lap_phieu_v1(uuid, uuid, uuid, uuid, uuid, uuid, numeric, date, text, text, uuid, text, text, uuid, uuid, text, uuid, bigint, numeric, numeric, numeric, numeric, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- RPC: chỉ authenticated (không PUBLIC, anon, service_role).
REVOKE ALL ON FUNCTION public.shareholder_profit_positions_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shareholder_profit_my_position_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shareholder_profit_advance_options_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shareholder_profit_advance_preview_v1(uuid, numeric, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shareholder_profit_advance_v1(uuid, numeric, uuid, date, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shareholder_profit_settlement_preview_v1(uuid, date, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shareholder_profit_settle_v1(uuid, date, uuid, date, text, numeric, numeric, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shareholder_profit_settlement_void_v1(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_positions_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_my_position_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_advance_options_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_advance_preview_v1(uuid, numeric, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_advance_v1(uuid, numeric, uuid, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_settlement_preview_v1(uuid, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_settle_v1(uuid, date, uuid, date, text, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_settlement_void_v1(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION app_private.profit_ledger_settlement_live_v1(uuid) IS
  'Bản ghi chốt chi lợi nhuận còn hiệu lực: ACTIVE và (không có phiếu tiền hoặc phiếu tiền còn sống theo profit_ledger_voucher_live_v1). Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_position_v1(uuid, uuid) IS
  'Vị thế của một cổ đông trên sổ tổng lợi nhuận: unpaid_profit (lợi nhuận được chia chưa chi), advance_outstanding (tạm ứng đã duyệt đang có), advance_pending (tạm ứng chờ duyệt), tiền chốt chờ duyệt, tổng đã chốt còn hiệu lực sau mốc. Dựng trên profit_ledger_balance_v1; tự kiểm trên số thô unpaid_profit − advance_outstanding − advance_pending = balance (lệch ⇒ XX000 PROFIT_LEDGER_POSITION_DRIFT). Tạm ứng không bao giờ âm: phần âm (components.advance_overoffset) là lợi nhuận công ty còn nợ, gấp vào unpaid_profit; unpaid_profit âm thì để âm. Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_unpaid_through_v1(uuid, uuid, date) IS
  'Lợi nhuận chưa chi của các tháng ≤ N của một cổ đông (X của một lần chốt đến hết tháng N): phần phân bổ và phần trả qua lương của các tháng ≤ N lấy bằng mốc giả định của profit_ledger_balance_core_v1, trừ tổng ghi nhận của các bản ghi chốt còn hiệu lực, cộng phần tạm ứng bị khấu trừ quá tay (advance_overoffset — nợ ở mọi N). N là ngày 1, sau tháng mốc. Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_chot_months_v1(uuid, uuid) IS
  'Các tháng chốt chi lợi nhuận được của một cổ đông (phân bổ của tháng, X nếu chốt đến tháng đó, chốt được không) kèm vị thế, trong cùng một lần đọc. Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_chot_rows_v1(uuid, uuid) IS
  'Danh sách bản ghi chốt chi lợi nhuận còn hiệu lực của một cổ đông, mới nhất trước. Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_chot_advance_right_v1(uuid, uuid) IS
  'Một người (theo đăng nhập) có quyền shareholder_profit.advance_own_cashbook trên công ty không — qua authorize_tenant_action_v3 (FOR SHARE dòng công ty ⇒ VOLATILE; hàm đọc gọi nó phải VOLATILE). Ngoại lệ hỏng ⇒ false.';
COMMENT ON FUNCTION app_private.profit_ledger_chot_holds_cashbook_v1(uuid, uuid, uuid) IS
  'Thành viên có đang giữ (CUSTODIAN) sổ quỹ không, theo assert_cashbook_access_v2. Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_chot_hang_muc_v1(uuid, uuid, text) IS
  'Hạng mục của phiếu sổ tổng theo rule_key (tam_ung_co_dong | chia_loi_nhuan): tìm, thiếu thì tạo; chưa bắt buộc duyệt ⇒ 55000 PROFIT_LEDGER_TYPE_NOT_FORCED. chia_loi_nhuan có dự phòng theo tên chuẩn hoá (như lệnh chi cũ); tam_ung_co_dong thì KHÔNG — hạng mục chi trùng tên "Tạm Ứng" không mang rule_key ⇒ 55000 PROFIT_LEDGER_TYPE_NAME_TAKEN.';
COMMENT ON FUNCTION app_private.profit_ledger_chot_assert_ngay_v1(uuid, uuid, date) IS
  'Hai khoá ngày của phiếu sổ tổng: tháng của toà ảo đã chốt lợi nhuận (55000 PROFIT_LEDGER_PROFIT_MONTH_LOCKED), sổ quỹ đã chốt tới ngày đó (55000 PROFIT_LEDGER_CASHBOOK_CLOSED).';
COMMENT ON FUNCTION app_private.profit_ledger_chot_lap_phieu_v1(uuid, uuid, uuid, uuid, uuid, uuid, numeric, date, text, text, uuid, text, text, uuid, uuid, text, uuid, bigint, numeric, numeric, numeric, numeric, jsonb, jsonb) IS
  'Nghi thức lập một phiếu chi theo sổ tổng cho cổ đông (ngữ cảnh CREATE → phiếu UNAPPROVED + dòng → dòng sổ → gửi duyệt phải PENDING_APPROVAL → nhật ký). Người gọi đã kiểm quyền và đang giữ khoá sổ. Không cấp cho vai nào.';
COMMENT ON FUNCTION public.shareholder_profit_positions_v1(uuid) IS
  'Sổ tổng lợi nhuận: vị thế của mọi cổ đông (lợi nhuận chưa chi, tạm ứng đã duyệt / chờ duyệt, đã chốt) kèm has_advance_right. Quyền: shareholder_profit.distribute|lock|unlock|manage_shareholders. Chỉ đọc; VOLATILE vì kiểm quyền tạm ứng của người khác cần khoá chia sẻ dòng công ty (gọi bằng POST).';
COMMENT ON FUNCTION public.shareholder_profit_my_position_v1(uuid) IS
  'Cổ đông tự xem vị thế của mình (lợi nhuận chưa chi, tạm ứng, các lần chốt còn hiệu lực). Quyền như shareholder_profit_my_ledger_v1. STABLE, không khoá dòng.';
COMMENT ON FUNCTION public.shareholder_profit_advance_options_v1(uuid) IS
  'Lựa chọn cho phiếu tạm ứng ở Thu chi: sổ quỹ thật người gọi đang giữ và cổ đông được cấp quyền tạm ứng (chỉ tên). Người gọi không giữ sổ nào ⇒ không có danh sách người nhận. Chỉ đọc; VOLATILE (gọi bằng POST).';
COMMENT ON FUNCTION public.shareholder_profit_advance_preview_v1(uuid, numeric, uuid) IS
  'Xem trước một phiếu tạm ứng cổ đông: cách lập, có lập được không, lý do chặn. Số của cổ đông (position, cảnh báo vượt ước tính) chỉ trả cho chính người nhận hoặc người có quyền chi lợi nhuận. Chỉ đọc; VOLATILE (gọi bằng POST).';
COMMENT ON FUNCTION public.shareholder_profit_advance_v1(uuid, numeric, uuid, date, text, text) IS
  'Lập phiếu tạm ứng lợi nhuận cho cổ đông (UNAPPROVED, chờ chủ duyệt) từ sổ quỹ người gọi đang giữ; người nhận phải được cấp quyền tạm ứng. Tự ứng ⇒ CUSTODIAN_ADVANCE, lập hộ ⇒ CUSTODIAN_FOR_PAYEE. Toàn bộ số tiền là tạm ứng. Chỉ chạy khi công tắc shareholder_profit.ledger_payout.v1 ở CANONICAL.';
COMMENT ON FUNCTION public.shareholder_profit_settlement_preview_v1(uuid, date, uuid) IS
  'Xem trước chốt chi lợi nhuận đến hết tháng N: các tháng chốt được, phần ghi nhận, phần khấu trừ tạm ứng đã duyệt, tiền thực chi. Không truyền tháng ⇒ tháng đủ điều kiện lớn nhất (kể cả khi luỹ kế đến tháng đó ≤ 0 — khi đó báo NOTHING_TO_SETTLE). Quyền shareholder_profit.distribute. STABLE, không khoá dòng.';
COMMENT ON FUNCTION public.shareholder_profit_settle_v1(uuid, date, uuid, date, text, numeric, numeric, text) IS
  'Chủ chốt chi lợi nhuận đến hết tháng N: ghi nhận lợi nhuận chưa chi của các tháng ≤ N, khấu trừ tạm ứng đã duyệt, phần còn lại thành một phiếu chi chờ duyệt (không còn tiền ⇒ chỉ bản ghi chốt). So-rồi-ghi trên hai số chủ đã xem: phần ghi nhận khác p_expected_recognized hoặc tiền khác p_expected_cash ⇒ PT409 PROFIT_LEDGER_SETTLE_CHANGED, không ghi gì. Chỉ chạy khi công tắc ở CANONICAL.';
COMMENT ON FUNCTION public.shareholder_profit_settlement_void_v1(uuid, text, text) IS
  'Huỷ một bản ghi chốt chi lợi nhuận KHÔNG có phiếu tiền (lý do 8..1000). Bản có phiếu tiền thì huỷ phiếu bằng profit_ledger_payout_cancel_v1. Quyền shareholder_profit.distribute.';

-- Z. Hậu kiểm. Đúng ở cả lượt một lẫn lượt chạy lại.
DO $sau$
DECLARE
  v_xau text;
  v_moi text[];
  r     record;
BEGIN
  -- 1. RPC: đủ, DEFINER, ghim search_path, đúng volatility, trả jsonb; chỉ authenticated gọi được.
  FOR r IN
    SELECT * FROM (VALUES
      ('public.shareholder_profit_positions_v1(uuid)', 'v'),
      ('public.shareholder_profit_my_position_v1(uuid)', 's'),
      ('public.shareholder_profit_advance_options_v1(uuid)', 'v'),
      ('public.shareholder_profit_advance_preview_v1(uuid,numeric,uuid)', 'v'),
      ('public.shareholder_profit_advance_v1(uuid,numeric,uuid,date,text,text)', 'v'),
      ('public.shareholder_profit_settlement_preview_v1(uuid,date,uuid)', 's'),
      ('public.shareholder_profit_settle_v1(uuid,date,uuid,date,text,numeric,numeric,text)', 'v'),
      ('public.shareholder_profit_settlement_void_v1(uuid,text,text)', 'v')
    ) AS x(ten, vol)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure(r.ten)
         AND p.prosecdef
         AND p.provolatile = r.vol
         AND p.prorettype = 'jsonb'::regtype
         AND p.pronargdefaults = 0
         AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
         AND p.proacl IS NOT NULL
         AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) THEN
      RAISE EXCEPTION 'Hậu kiểm: % sai hình dạng / volatility / quyền gọi', r.ten USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- 2. Hàm nội bộ: đủ, ghim search_path, không ai ngoài chủ hàm có EXECUTE; đúng volatility
  --    (hàm đọc không VOLATILE; hàm kiểm quyền của người khác và hàm ghi phải VOLATILE).
  SELECT string_agg(f.ten, ', ') INTO v_xau
    FROM (VALUES
      ('app_private.guard_profit_ledger_payout_settlement_v1()', 'v'),
      ('app_private.guard_profit_ledger_marker_settlement_v1()', 'v'),
      ('app_private.profit_ledger_settlement_live_v1(uuid)', 's'),
      ('app_private.profit_ledger_position_v1(uuid,uuid)', 's'),
      ('app_private.profit_ledger_unpaid_through_v1(uuid,uuid,date)', 's'),
      ('app_private.profit_ledger_chot_months_v1(uuid,uuid)', 's'),
      ('app_private.profit_ledger_chot_rows_v1(uuid,uuid)', 's'),
      ('app_private.profit_ledger_chot_advance_right_v1(uuid,uuid)', 'v'),
      ('app_private.profit_ledger_chot_holds_cashbook_v1(uuid,uuid,uuid)', 's'),
      ('app_private.profit_ledger_chot_hang_muc_v1(uuid,uuid,text)', 'v'),
      ('app_private.profit_ledger_chot_assert_ngay_v1(uuid,uuid,date)', 's'),
      ('app_private.profit_ledger_chot_lap_phieu_v1(uuid,uuid,uuid,uuid,uuid,uuid,numeric,date,text,text,uuid,text,text,uuid,uuid,text,uuid,bigint,numeric,numeric,numeric,numeric,jsonb,jsonb)', 'v')
    ) AS f(ten, vol)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(f.ten)
   WHERE p.oid IS NULL
      OR p.provolatile <> f.vol
      OR p.proacl IS NULL
      OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner)
      OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%');
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: hàm nội bộ thiếu, sai volatility, chưa ghim search_path hoặc còn EXECUTE cho vai khác: %', v_xau
      USING ERRCODE = '55000';
  END IF;

  -- 3. Bảng bản ghi chốt: RLS bật, không ai ngoài chủ bảng có quyền, đủ ba trigger và các ràng buộc.
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid = 'app_private.profit_ledger_payout_settlements'::regclass
          AND c.relrowsecurity
          AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner))
     OR has_table_privilege('authenticated', 'app_private.profit_ledger_payout_settlements', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_table_privilege('anon', 'app_private.profit_ledger_payout_settlements', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_table_privilege('service_role', 'app_private.profit_ledger_payout_settlements', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol WHERE pol.polrelid = 'app_private.profit_ledger_payout_settlements'::regclass) THEN
    RAISE EXCEPTION 'Hậu kiểm: profit_ledger_payout_settlements chưa bật RLS, có policy hoặc còn quyền cho vai khác' USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(x.ten, ', ') INTO v_xau
    FROM (VALUES
      ('a00_profit_ledger_payout_settlements_guard', 'app_private.guard_profit_ledger_payout_settlement_v1()'),
      ('a00_profit_ledger_payout_settlements_no_delete', 'app_private.guard_profit_ledger_append_only_v1()'),
      ('a00_profit_ledger_payout_settlements_no_truncate', 'app_private.guard_profit_ledger_append_only_v1()')
    ) AS x(ten, ham)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgname = x.ten
        AND t.tgrelid = 'app_private.profit_ledger_payout_settlements'::regclass
        AND t.tgfoid = to_regprocedure(x.ham)
        AND t.tgenabled = 'O' AND NOT t.tgisinternal);
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: bảng bản ghi chốt thiếu trigger: %', v_xau USING ERRCODE = '55000';
  END IF;

  -- 3b. Bảng mốc: trigger chặn mốc sớm hơn tháng đã chốt chi — có, đúng hàm, đang bật, BEFORE INSERT từng dòng
  --     (tgtype 7 = ROW + BEFORE + INSERT), và tên xếp SAU chốt sẵn có của bảng (chốt đó phải còn và đang bật).
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgname = 'a10_profit_ledger_markers_settlement_guard'
          AND t.tgrelid = 'app_private.profit_ledger_markers'::regclass
          AND t.tgfoid = to_regprocedure('app_private.guard_profit_ledger_marker_settlement_v1()')
          AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 7)
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgname = 'a00_profit_ledger_markers_guard'
          AND t.tgrelid = 'app_private.profit_ledger_markers'::regclass
          AND t.tgenabled = 'O' AND NOT t.tgisinternal
          AND t.tgname < 'a10_profit_ledger_markers_settlement_guard') THEN
    RAISE EXCEPTION 'Hậu kiểm: bảng mốc thiếu trigger a10_profit_ledger_markers_settlement_guard (đúng hàm, đang bật, BEFORE INSERT, chạy sau a00_profit_ledger_markers_guard)'
      USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(x.ten, ', ') INTO v_xau
    FROM unnest(ARRAY[
      'profit_ledger_payout_settlements_split_ck', 'profit_ledger_payout_settlements_cash_voucher_ck',
      'profit_ledger_payout_settlements_offset_ck', 'profit_ledger_payout_settlements_void_ck',
      'profit_ledger_payout_settlements_seq_uq', 'profit_ledger_payout_settlements_shareholder_fk']) AS x(ten)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid = 'app_private.profit_ledger_payout_settlements'::regclass AND c.conname = x.ten AND c.convalidated);
  IF v_xau IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_index i
        WHERE i.indexrelid = to_regclass('app_private.profit_ledger_payout_settlements_cash_voucher_uq')
          AND i.indrelid = 'app_private.profit_ledger_payout_settlements'::regclass
          AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL) THEN
    RAISE EXCEPTION 'Hậu kiểm: bảng bản ghi chốt thiếu ràng buộc / index duy nhất phiếu tiền: %', COALESCE(v_xau, 'cash_voucher_uq')
      USING ERRCODE = '55000';
  END IF;

  -- 4. Dòng sổ phiếu chi: maker_kind nhận đủ ba giá trị (đúng MỘT CHECK một-cột), có CHECK hình dạng lập hộ.
  IF (SELECT count(*) FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = 'app_private.profit_ledger_payouts'::regclass AND c.contype = 'c' AND c.convalidated
         AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
                                WHERE a.attrelid = c.conrelid AND a.attname = 'maker_kind' AND NOT a.attisdropped)]
         AND pg_get_constraintdef(c.oid) LIKE '%''OWNER''%'
         AND pg_get_constraintdef(c.oid) LIKE '%''CUSTODIAN_ADVANCE''%'
         AND pg_get_constraintdef(c.oid) LIKE '%''CUSTODIAN_FOR_PAYEE''%') <> 1
     OR (SELECT count(*) FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = 'app_private.profit_ledger_payouts'::regclass AND c.contype = 'c'
            AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
                                   WHERE a.attrelid = c.conrelid AND a.attname = 'maker_kind' AND NOT a.attisdropped)]) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'app_private.profit_ledger_payouts'::regclass
          AND c.conname = 'profit_ledger_payouts_custodian_for_payee_ck' AND c.convalidated
          AND pg_get_constraintdef(c.oid) LIKE '%payee_user_id IS NOT NULL%')
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'app_private.profit_ledger_payouts'::regclass
          AND c.conname = 'profit_ledger_payouts_custodian_ck') THEN
    RAISE EXCEPTION 'Hậu kiểm: CHECK maker_kind của profit_ledger_payouts chưa đúng (ba giá trị, một CHECK một-cột, CHECK lập hộ, CHECK tự tạm ứng)'
      USING ERRCODE = '55000';
  END IF;

  -- 5. Hạng mục "Tạm Ứng": công ty nào có hạng mục chia_loi_nhuan cũng có; dòng VỪA chèn trong giao dịch này đúng cờ
  --    (dòng có từ trước: không khẳng định cờ — chủ có thể đã đổi).
  IF EXISTS (
    SELECT 1 FROM public.income_expense_types c
     WHERE c.rule_key = 'chia_loi_nhuan' AND lower(btrim(c.type)) = 'expense'
       AND NOT EXISTS (SELECT 1 FROM public.income_expense_types d
                        WHERE d.organization_id = c.organization_id AND d.rule_key = 'tam_ung_co_dong')) THEN
    RAISE EXCEPTION 'Hậu kiểm: có công ty có hạng mục chia_loi_nhuan mà chưa có hạng mục tam_ung_co_dong' USING ERRCODE = '55000';
  END IF;
  v_moi := COALESCE(string_to_array(NULLIF(current_setting('ihomecrm.tam_ung_loai_moi', true), ''), ','), ARRAY[]::text[]);
  IF (SELECT count(*) FROM public.income_expense_types t
       WHERE t.id::text = ANY (v_moi)
         AND t.rule_key = 'tam_ung_co_dong' AND t.name = 'Tạm Ứng' AND t.type = 'expense'
         AND t.category = 'Chia lợi nhuận'
         AND t.system_only AND NOT t.manual_hidden AND t.quick_entry_hidden AND t.internal_transfer
         AND t.force_approval AND t.is_restricted) <> cardinality(v_moi) THEN
    RAISE EXCEPTION 'Hậu kiểm: hạng mục "Tạm Ứng" vừa chèn sai cờ' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;

NOTIFY pgrst, 'reload schema';
