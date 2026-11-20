-- Quỹ chung đã đối chiếu. Chỉ ghi phần thuộc quỹ, đã tách khỏi lợi nhuận cá nhân;
-- không nhập lại lợi nhuận gộp của tòa hoặc phiếu tiền đã được tính vào số mở sổ.
-- Nhật ký quản trị này không tạo phiếu thu chi, posting hoặc thay đổi kỳ lợi nhuận.
BEGIN;

CREATE TABLE IF NOT EXISTS app_private.shared_fund_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  entry_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  kind text NOT NULL CHECK (kind IN ('OPENING', 'CREDIT', 'DEBIT', 'DISTRIBUTION')),
  effective_date date NOT NULL CHECK (isfinite(effective_date)),
  amount bigint NOT NULL CHECK (amount BETWEEN 0 AND 9999999999999 AND (kind = 'OPENING' OR amount > 0)),
  advance_offset_amount bigint NOT NULL DEFAULT 0
    CHECK (advance_offset_amount BETWEEN 0 AND amount AND (kind = 'DISTRIBUTION' OR advance_offset_amount = 0)),
  available_after bigint NOT NULL CHECK (available_after BETWEEN 0 AND 9999999999999),
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 160),
  evidence text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 1 AND 2000),
  actor_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL REFERENCES public.organization_memberships(id),
  request_key text NOT NULL,
  request_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, actor_id, request_key),
  UNIQUE (id, organization_id, kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS shared_fund_one_opening
  ON app_private.shared_fund_entries (organization_id) WHERE kind = 'OPENING';
CREATE UNIQUE INDEX IF NOT EXISTS shared_fund_document_reference
  ON app_private.shared_fund_entries (organization_id, lower(btrim(reference)));
CREATE INDEX IF NOT EXISTS shared_fund_entries_by_org
  ON app_private.shared_fund_entries (organization_id, entry_seq DESC);

CREATE TABLE IF NOT EXISTS app_private.shared_fund_distribution_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  distribution_id uuid NOT NULL,
  entry_kind text NOT NULL DEFAULT 'DISTRIBUTION' CHECK (entry_kind = 'DISTRIBUTION'),
  shareholder_id uuid NOT NULL,
  shareholder_name text NOT NULL,
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 9999999999999),
  advance_offset_amount bigint NOT NULL CHECK (advance_offset_amount BETWEEN 0 AND amount),
  payable_amount bigint GENERATED ALWAYS AS (amount - advance_offset_amount) STORED,
  ledger_seq bigint NOT NULL DEFAULT nextval('app_private.profit_ledger_seq') UNIQUE,
  UNIQUE (distribution_id, shareholder_id),
  FOREIGN KEY (distribution_id, organization_id, entry_kind)
    REFERENCES app_private.shared_fund_entries (id, organization_id, kind),
  FOREIGN KEY (shareholder_id, organization_id)
    REFERENCES public.shareholders (id, organization_id)
);
CREATE INDEX IF NOT EXISTS shared_fund_lines_by_shareholder
  ON app_private.shared_fund_distribution_lines (organization_id, shareholder_id, ledger_seq);

ALTER TABLE app_private.shared_fund_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.shared_fund_distribution_lines ENABLE ROW LEVEL SECURITY;

-- Gồm các quyết định đã ghi; không có trạng thái nháp hoặc phiếu tiền ngầm.
CREATE OR REPLACE VIEW app_private.shared_fund_distributions WITH (security_invoker = true) AS
  SELECT id, organization_id, effective_date, date_trunc('month', effective_date::timestamp)::date AS period_month,
         'POSTED'::text AS status, amount, advance_offset_amount, amount - advance_offset_amount AS payable_amount,
         reference, evidence, actor_id, actor_membership_id, created_at, request_key
    FROM app_private.shared_fund_entries
   WHERE kind = 'DISTRIBUTION';

REVOKE ALL ON app_private.shared_fund_entries, app_private.shared_fund_distribution_lines,
  app_private.shared_fund_distributions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app_private.shared_fund_entries_entry_seq_seq FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS shared_fund_entries_immutable ON app_private.shared_fund_entries;
CREATE TRIGGER shared_fund_entries_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.shared_fund_entries
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();
DROP TRIGGER IF EXISTS shared_fund_lines_immutable ON app_private.shared_fund_distribution_lines;
CREATE TRIGGER shared_fund_lines_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.shared_fund_distribution_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();

CREATE OR REPLACE FUNCTION app_private.shared_fund_owner_v1(p_org uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
  SELECT m.id FROM public.organization_memberships m
    JOIN public.organizations org ON org.id = m.organization_id AND org.status = 'ACTIVE'
   WHERE m.organization_id = p_org AND m.user_id = auth.uid()
     AND m.member_type = 'OWNER' AND m.status = 'ACTIVE' AND m.revoked_at IS NULL
     AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
     AND (m.valid_to IS NULL OR m.valid_to > statement_timestamp())
     AND app_private.profit_ledger_doc_can_v1(p_org, ARRAY['shareholder_profit.distribute'])
   ORDER BY m.id LIMIT 1
$fn$;

CREATE OR REPLACE FUNCTION app_private.shared_fund_receipt_v1(p_entry app_private.shared_fund_entries)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path TO pg_catalog AS $fn$
  SELECT jsonb_build_object('id', p_entry.id, 'organization_id', p_entry.organization_id,
                            'kind', p_entry.kind, 'amount', p_entry.amount, 'available_amount', p_entry.available_after)
    || CASE WHEN p_entry.kind = 'DISTRIBUTION' THEN jsonb_build_object(
         'status', 'POSTED', 'advance_offset_amount', p_entry.advance_offset_amount,
         'payable_amount', p_entry.amount - p_entry.advance_offset_amount) ELSE '{}'::jsonb END
$fn$;

CREATE OR REPLACE FUNCTION public.shared_fund_state_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
DECLARE
  latest app_private.shared_fund_entries;
  sources jsonb;
  distributions jsonb;
  holders jsonb;
  openings jsonb := '[]'::jsonb;
BEGIN
  IF app_private.shared_fund_owner_v1(p_organization_id) IS NULL THEN
    RAISE EXCEPTION 'Chỉ chủ công ty có quyền chia lợi nhuận mới được xem quỹ chung' USING ERRCODE = '42501';
  END IF;
  SELECT e.* INTO latest FROM app_private.shared_fund_entries e
   WHERE e.organization_id = p_organization_id ORDER BY e.entry_seq DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'kind', e.kind, 'effective_date', e.effective_date, 'amount', e.amount,
           'reference', e.reference, 'evidence', e.evidence, 'created_at', e.created_at,
           'created_by', e.actor_id, 'request_key', e.request_key)
           ORDER BY e.entry_seq DESC), '[]'::jsonb)
    INTO sources FROM app_private.shared_fund_entries e
   WHERE e.organization_id = p_organization_id AND e.kind <> 'DISTRIBUTION';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'effective_date', d.effective_date, 'period_month', d.period_month, 'status', d.status,
           'amount', d.amount, 'advance_offset_amount', d.advance_offset_amount, 'payable_amount', d.payable_amount,
           'reference', d.reference, 'evidence', d.evidence, 'created_at', d.created_at,
           'created_by', d.actor_id, 'request_key', d.request_key,
           'lines', (SELECT jsonb_agg(jsonb_build_object(
               'shareholder_id', l.shareholder_id, 'name', l.shareholder_name, 'amount', l.amount,
               'advance_offset_amount', l.advance_offset_amount, 'payable_amount', l.payable_amount)
               ORDER BY l.ledger_seq) FROM app_private.shared_fund_distribution_lines l
               WHERE l.distribution_id = d.id AND l.organization_id = d.organization_id))
           ORDER BY d.effective_date DESC, d.created_at DESC, d.id), '[]'::jsonb)
    INTO distributions FROM app_private.shared_fund_distributions d WHERE d.organization_id = p_organization_id;
  WITH subjects AS MATERIALIZED (
    SELECT s.id, s.name, app_private.profit_ledger_position_v1(s.organization_id, s.id) AS position
      FROM public.shareholders s WHERE s.organization_id = p_organization_id AND s.is_active AND s.deleted_at IS NULL
  ) SELECT coalesce(jsonb_agg(jsonb_build_object(
           'shareholder_id', id, 'name', name, 'advance_outstanding', position->'advance_outstanding',
           'unpaid_profit', position->'unpaid_profit') ORDER BY name, id), '[]'::jsonb) INTO holders FROM subjects;
  IF to_regclass('app_private.shareholder_profit_openings') IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'opening_id', o.id, 'shareholder_id', o.shareholder_id, 'through_month', o.through_month,
             'as_of_date', o.as_of_date, 'advance_amount', o.advance_amount, 'evidence', o.evidence,
             'reconciled_approved', o.reconciled_approved, 'reconciled_count', jsonb_array_length(o.reconciled_vouchers),
             'created_by', o.created_by, 'request_key', o.request_key)
             ORDER BY o.created_at DESC, o.id), '[]'::jsonb) INTO openings
      FROM app_private.shareholder_profit_openings o WHERE o.organization_id = p_organization_id;
  END IF;
  RETURN jsonb_build_object('organization_id', p_organization_id,
      'route', app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', p_organization_id),
      'has_opening', latest.id IS NOT NULL, 'available_amount', coalesce(latest.available_after, 0),
      'last_effective_date', latest.effective_date, 'sources', sources, 'distributions', distributions,
      'shareholders', holders, 'openings', openings);
END
$fn$;

-- Các lệnh ghi cùng công ty lấy chung khóa quyết định với luồng chốt và bù tạm ứng.
-- Sau khi chờ khóa phải đọc lại tư cách chủ, quyền và số nguồn còn phân bổ.
CREATE OR REPLACE FUNCTION app_private.shared_fund_write_v1(
  p_org uuid, p_kind text, p_effective_date date, p_amount numeric, p_reference text, p_evidence text,
  p_lines jsonb, p_expected_available numeric, p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
DECLARE
  actor uuid := auth.uid();
  membership uuid;
  document_ref text := btrim(p_reference);
  evidence_text text := btrim(p_evidence);
  operation_key text := btrim(p_idempotency_key);
  canonical_lines jsonb;
  payload jsonb;
  entry app_private.shared_fund_entries;
  latest app_private.shared_fund_entries;
  gross numeric := p_amount;
  offset_total numeric := 0;
  available bigint;
  after_amount numeric;
  period date := date_trunc('month', p_effective_date::timestamp)::date;
  holder record;
  holder_name text;
  position jsonb;
  later_advances numeric;
BEGIN
  IF app_private.shared_fund_owner_v1(p_org) IS NULL THEN
    RAISE EXCEPTION 'Không có quyền quản lý quỹ chung của công ty' USING ERRCODE = '42501';
  END IF;
  IF app_private.lock_org_for_decision_v1(p_org) IS NULL THEN
    RAISE EXCEPTION 'Công ty không hoạt động' USING ERRCODE = '42501';
  END IF;
  membership := app_private.shared_fund_owner_v1(p_org);
  IF membership IS NULL OR NOT coalesce((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(
      actor, p_org, 'shareholder_profit.distribute', NULL, NULL) a), false) THEN
    RAISE EXCEPTION 'Không còn quyền quản lý quỹ chung của công ty' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('OPENING','CREDIT','DEBIT','DISTRIBUTION')
     OR p_effective_date IS NULL OR NOT isfinite(p_effective_date) OR p_effective_date > public.org_today_v1(p_org)
     OR coalesce(length(document_ref),0) NOT BETWEEN 1 AND 160
     OR coalesce(length(evidence_text),0) NOT BETWEEN 1 AND 2000
     OR coalesce(operation_key,'') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
     OR p_expected_available IS NULL OR NOT (p_expected_available BETWEEN 0 AND 9999999999999)
     OR trunc(p_expected_available) <> p_expected_available THEN
    RAISE EXCEPTION 'Ngày, chứng từ, căn cứ, số dư dự kiến hoặc mã yêu cầu không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'DISTRIBUTION' THEN
    IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Thiếu danh sách cổ đông nhận phân bổ' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_lines) = 0 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_lines) j(val)
       WHERE jsonb_typeof(val) IS DISTINCT FROM 'object'
          OR jsonb_typeof(val->'shareholder_id') IS DISTINCT FROM 'string'
          OR jsonb_typeof(val->'amount') IS DISTINCT FROM 'number'
          OR jsonb_typeof(val->'advance_offset_amount') IS DISTINCT FROM 'number'
          OR (val - ARRAY['shareholder_id','amount','advance_offset_amount']) <> '{}'::jsonb
    ) THEN
      RAISE EXCEPTION 'Mỗi dòng phải có cổ đông, số được chia và số bù ứng' USING ERRCODE = '22023';
    END IF;
    BEGIN
      SELECT jsonb_agg(jsonb_build_object('shareholder_id', l.shareholder_id, 'amount', trunc(l.amount),
                    'advance_offset_amount', trunc(l.advance_offset_amount)) ORDER BY l.shareholder_id),
             sum(l.amount), sum(l.advance_offset_amount)
        INTO canonical_lines, gross, offset_total
        FROM jsonb_to_recordset(p_lines) l(shareholder_id uuid, amount numeric, advance_offset_amount numeric)
       HAVING count(DISTINCT l.shareholder_id) = count(*) AND bool_and(
         l.amount BETWEEN 1 AND 9999999999999 AND l.amount = trunc(l.amount)
         AND l.advance_offset_amount BETWEEN 0 AND l.amount AND l.advance_offset_amount = trunc(l.advance_offset_amount));
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Mã cổ đông không hợp lệ' USING ERRCODE = '22023';
    END;
    IF canonical_lines IS NULL THEN
      RAISE EXCEPTION 'Cổ đông trùng hoặc số tiền từng dòng không hợp lệ' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF gross IS NULL OR NOT (gross BETWEEN 0 AND 9999999999999) OR gross <> trunc(gross)
     OR (gross = 0 AND p_kind <> 'OPENING') THEN
    RAISE EXCEPTION 'Số tiền quỹ phải là đồng nguyên hợp lệ' USING ERRCODE = '22023';
  END IF;
  payload := jsonb_build_object('kind', p_kind, 'effective_date', p_effective_date, 'amount', gross,
                                'reference', document_ref, 'evidence', evidence_text, 'lines', canonical_lines);
  SELECT e.* INTO entry FROM app_private.shared_fund_entries e
   WHERE e.organization_id = p_org AND e.actor_id = actor AND e.request_key = operation_key;
  IF FOUND THEN
    IF entry.request_payload IS DISTINCT FROM payload THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng cho nội dung khác' USING ERRCODE = 'PT409';
    END IF;
    RETURN app_private.shared_fund_receipt_v1(entry);
  END IF;

  PERFORM app_private.profit_ledger_tao_assert_route_v1(p_org, ARRAY['CANONICAL']);
  IF to_regprocedure('app_private.profit_ledger_shared_fund_components_v1(uuid,uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'Chưa bật liên kết quỹ chung với sổ cổ đông' USING ERRCODE = '55000';
  END IF;
  SELECT e.* INTO latest FROM app_private.shared_fund_entries e
   WHERE e.organization_id = p_org ORDER BY e.entry_seq DESC LIMIT 1;
  available := coalesce(latest.available_after, 0);
  IF (p_kind = 'OPENING') <> (latest.id IS NULL) THEN
    RAISE EXCEPTION 'Quỹ cần đúng một lần xác nhận số mở sổ trước các phát sinh' USING ERRCODE = 'PT409';
  END IF;
  IF p_effective_date < latest.effective_date THEN
    RAISE EXCEPTION 'Ngày hiệu lực trước nghiệp vụ quỹ gần nhất' USING ERRCODE = 'PT409';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.shared_fund_entries e
              WHERE e.organization_id = p_org AND lower(btrim(e.reference)) = lower(document_ref)) THEN
    RAISE EXCEPTION 'Mã chứng từ quỹ đã sử dụng' USING ERRCODE = 'PT409';
  END IF;
  after_amount := available + CASE WHEN p_kind IN ('OPENING','CREDIT') THEN gross ELSE -gross END;
  IF p_expected_available <> available OR after_amount NOT BETWEEN 0 AND 9999999999999 THEN
    RAISE EXCEPTION 'Số dư quỹ đã đổi hoặc nguồn quỹ không đủ; cần tải lại' USING ERRCODE = 'PT409';
  END IF;
  PERFORM app_private.claim_feature_operation_v1('shareholder_profit.ledger_payout.v1', p_org,
    'shared_fund.' || lower(p_kind) || '.v1', actor, operation_key, gross);
  INSERT INTO app_private.shared_fund_entries (
    organization_id, kind, effective_date, amount, advance_offset_amount, available_after, reference, evidence,
    actor_id, actor_membership_id, request_key, request_payload)
  VALUES (p_org, p_kind, p_effective_date, gross, offset_total, after_amount, document_ref, evidence_text,
          actor, membership, operation_key, payload)
  RETURNING * INTO entry;

  FOR holder IN SELECT * FROM jsonb_to_recordset(coalesce(canonical_lines, '[]'::jsonb))
      AS l(shareholder_id uuid, amount bigint, advance_offset_amount bigint) ORDER BY l.shareholder_id
  LOOP
    SELECT s.name INTO holder_name FROM public.shareholders s
     WHERE s.organization_id = p_org AND s.id = holder.shareholder_id AND s.deleted_at IS NULL AND s.is_active
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cổ đông không hoạt động hoặc không thuộc công ty' USING ERRCODE = '42501';
    END IF;
    PERFORM app_private.profit_ledger_lock_v1(p_org, 'SHAREHOLDER', holder.shareholder_id);
    position := app_private.profit_ledger_position_v1(p_org, holder.shareholder_id);
    IF jsonb_typeof(position->'advance_outstanding') IS DISTINCT FROM 'number'
       OR jsonb_typeof(position->'unpaid_profit') IS DISTINCT FROM 'number'
       OR jsonb_typeof(position->'needs_review'->'count') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Chưa xác định được số ứng và các phiếu lương cần đối chiếu của cổ đông' USING ERRCODE = '55000';
    END IF;
    IF period <= (position->>'marker_month')::date OR period < (position->>'last_settled_through_month')::date
       OR EXISTS (SELECT 1 FROM app_private.shareholder_profit_openings o
                   WHERE o.organization_id = p_org AND o.shareholder_id = holder.shareholder_id
                     AND o.as_of_date > p_effective_date) THEN
      RAISE EXCEPTION 'Ngày phân bổ thuộc kỳ trước mốc đối chiếu hoặc kỳ đã chốt cho cổ đông' USING ERRCODE = 'PT409';
    END IF;
    IF holder.advance_offset_amount > (position->>'advance_outstanding')::numeric
       OR (holder.advance_offset_amount > 0 AND (position->'needs_review'->>'count')::int > 0) THEN
      RAISE EXCEPTION 'Số tạm ứng có thể bù đã đổi hoặc còn phiếu lương cần đối chiếu' USING ERRCODE = 'PT409';
    END IF;
    IF holder.advance_offset_amount > 0 THEN
      -- Tính trên số ứng còn lại hiện tại để giữ nguyên các lần đã cấn. Loại phần ứng
      -- được duyệt nhưng phát sinh sau ngày phân bổ. Các phiếu chi tiền của W2 đã
      -- được trừ khỏi số ứng trong position_v1, phiếu đã đối soát nằm trước mốc.
      SELECT coalesce(sum(ie.total_amount), 0) INTO later_advances
        FROM public.income_expenses ie
        LEFT JOIN app_private.profit_ledger_payouts lp ON lp.voucher_id = ie.id
        LEFT JOIN app_private.profit_ledger_active_marker_v1(p_org, 'SHAREHOLDER', holder.shareholder_id) mk ON true
        LEFT JOIN public.income_expense_postings p ON p.id = ie.active_posting_id_v2
          AND p.organization_id = p_org AND p.posting_subject_kind = 'VOUCHER'
          AND p.posting_subject_id = ie.id AND p.event_kind = 'POSTING' AND p.direction = 'EXPENSE'
       WHERE ie.organization_id = p_org AND ie.shareholder_id = holder.shareholder_id
         AND ie.approval_status = 'APPROVED' AND app_private.profit_ledger_voucher_live_v1(ie.id)
         AND (ie.voucher_date IS NULL OR ie.voucher_date > p_effective_date
              OR (ie.posting_status = 'POSTED' AND (p.posted_on IS NULL OR p.posted_on > p_effective_date)))
         AND (mk.settled_through_month IS NULL OR lp.ledger_seq > mk.ledger_seq
              OR (lp.voucher_id IS NULL AND ie.created_at >= mk.created_at))
         AND NOT EXISTS (SELECT 1 FROM app_private.profit_ledger_payout_settlements s
                         WHERE s.cash_voucher_id = ie.id AND s.organization_id = p_org
                           AND s.shareholder_id = holder.shareholder_id
                           AND (mk.settled_through_month IS NULL OR s.ledger_seq > mk.ledger_seq)
                           AND app_private.profit_ledger_settlement_live_v1(s.id));
      IF holder.advance_offset_amount > (position->>'advance_outstanding')::numeric - later_advances THEN
        RAISE EXCEPTION 'Số ứng còn lại tại ngày phân bổ không đủ để cấn' USING ERRCODE = 'PT409';
      END IF;
    END IF;
    -- W2 lưu unpaid_before vào numeric(15,2). Không để nhiều lần phân phối hợp lệ riêng lẻ
    -- cộng dồn thành một khoản phải trả vượt sức chứa của luồng chi chính thức.
    IF (position->>'unpaid_profit')::numeric + holder.amount - holder.advance_offset_amount >= 10000000000000 THEN
      RAISE EXCEPTION 'Tổng lợi nhuận chưa chi của cổ đông vượt giới hạn của sổ lợi nhuận' USING ERRCODE = 'PT409';
    END IF;
    INSERT INTO app_private.shared_fund_distribution_lines (
      organization_id, distribution_id, shareholder_id, shareholder_name, amount, advance_offset_amount)
    VALUES (p_org, entry.id, holder.shareholder_id, holder_name, holder.amount, holder.advance_offset_amount);
  END LOOP;
  RETURN app_private.shared_fund_receipt_v1(entry);
END
$fn$;

CREATE OR REPLACE FUNCTION public.shared_fund_record_source_v1(
  p_organization_id uuid, p_kind text, p_effective_date date, p_amount numeric, p_reference text,
  p_evidence text, p_expected_available numeric, p_idempotency_key text
) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
  SELECT app_private.shared_fund_write_v1(p_organization_id, p_kind, p_effective_date, p_amount,
    p_reference, p_evidence, NULL, p_expected_available, p_idempotency_key)
$fn$;
CREATE OR REPLACE FUNCTION public.shared_fund_distribute_v1(
  p_organization_id uuid, p_effective_date date, p_reference text, p_evidence text,
  p_lines jsonb, p_expected_available numeric, p_idempotency_key text
) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
  SELECT app_private.shared_fund_write_v1(p_organization_id, 'DISTRIBUTION', p_effective_date, NULL,
    p_reference, p_evidence, p_lines, p_expected_available, p_idempotency_key)
$fn$;

REVOKE ALL ON FUNCTION app_private.shared_fund_owner_v1(uuid),
  app_private.shared_fund_receipt_v1(app_private.shared_fund_entries),
  app_private.shared_fund_write_v1(uuid,text,date,numeric,text,text,jsonb,numeric,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shared_fund_state_v1(uuid),
  public.shared_fund_record_source_v1(uuid,text,date,numeric,text,text,numeric,text),
  public.shared_fund_distribute_v1(uuid,date,text,text,jsonb,numeric,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shared_fund_state_v1(uuid),
  public.shared_fund_record_source_v1(uuid,text,date,numeric,text,text,numeric,text),
  public.shared_fund_distribute_v1(uuid,date,text,text,jsonb,numeric,text) TO authenticated;
COMMENT ON TABLE app_private.shared_fund_entries IS
  'Quỹ phân bổ phi tiền đã đối chiếu riêng với quyền lợi cổ đông. OPENING ghi một lần. CREDIT/DEBIT chỉ ghi nguồn/chi phí mới ngoài số mở sổ. Mỗi nguồn hoặc quyết định có mã chứng từ duy nhất trong công ty.';
COMMENT ON FUNCTION public.shared_fund_record_source_v1(uuid,text,date,numeric,text,text,numeric,text) IS
  'Chủ xác nhận nguồn quỹ có chứng từ. Khoản ghi có chỉ là phần khả dụng đã tách khỏi quyền lợi cổ đông. Không chuyển lợi nhuận gộp của tòa hoặc phiếu chi đã tính trong số mở sổ thành nguồn mới.';
COMMENT ON FUNCTION public.shared_fund_distribute_v1(uuid,date,text,text,jsonb,numeric,text) IS
  'Phân phối quỹ khả dụng đã đối chiếu, bù tối đa số tạm ứng đã ghi nhận của từng cổ đông. Phần còn lại trở thành khoản phải trả qua sổ lợi nhuận, không tạo phiếu tiền.';
COMMIT;
