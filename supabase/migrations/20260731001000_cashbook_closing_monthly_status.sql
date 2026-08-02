-- =====================================================================
-- PA4 (B/5) — TRẠNG THÁI CHỐT SỔ THEO THÁNG (một RPC ĐỌC, không writer)
--
-- Vì sao cần: nghi thức chốt Đợt 6 đã đủ nhưng prod 0 closure. Người dùng
-- không có một chỗ nào trả lời được câu "tháng này sổ nào chưa chốt". Panel ở
-- tab "Chốt LN tháng" (lưới an toàn của PA4) và badge ở trang Sổ quỹ đều đọc
-- hàm này.
--
-- BỐN ĐIỀU KHÔNG ĐƯỢC LÀM KHÁC:
--
-- 1. VOLATILE, không STABLE. Hàm gọi authorize_tenant_action_v3 (bên trong có
--    SELECT … FOR SHARE). PostgREST chạy hàm STABLE/IMMUTABLE trong transaction
--    READ ONLY ⇒ 25006. Gọi bằng SQL thì xanh, gọi từ trình duyệt thì hỏng câm.
--    Chính lỗi này giết tab "Chốt LN tháng" 10 ngày (profit_close_state_v2).
--    Xem scripts/check-stable-fn-locks.mjs.
--
-- 2. Phạm vi sổ = GIAO với app_private.ie_visible_cashbook_ids_v1(). Hàm này
--    SECURITY DEFINER nên đi vòng qua RLS; lọc theo my_org_ids() là KHÔNG ĐỦ —
--    đúng lỗ hổng C của Đợt 0 (KNOWER/Viewer đọc được tồn quỹ mọi sổ).
--
-- 3. Số dư lấy từ app_private.cashbook_balance_as_of_v1 — CÙNG một cơ sở với
--    con số sẽ bị đóng băng vào biên bản (basis POSTING_TRUTH_BY_POSTED_ON).
--    Repo này từng có BỐN định nghĩa số dư trên cùng một màn hình và lệch thật
--    2.530.000đ ở sổ ATam. Không tự viết lại công thức ở đây.
--
-- 4. Ngày đã chốt lấy từ app_private.cashbook_closed_through_v1 =
--    GREATEST(max(closures.closed_through), accounts.lock_date). accounts.lock_date
--    chỉ là cache đọc nhanh, KHÔNG phải nguồn sự thật.
--
-- `can_be_closed` là cột quan trọng nhất về mặt sản phẩm: nó phân biệt "chưa
-- chốt" (nhắc được) với "KHÔNG chốt được vì thiếu người ký" (nhắc là vô nghĩa,
-- phải đi gán vai trò Kế toán — xem 20260731000000). Đo 30/07: org thật có
-- 10/16 sổ thuộc loại thứ hai.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.cashbook_closing_monthly_status_v1(
  p_organization_id uuid,
  p_month           date
)
RETURNS TABLE (
  cashbook_id          uuid,
  cashbook_name        text,
  bank_name            text,
  is_bank              boolean,
  closed_through       date,
  covered              boolean,
  has_pending_request  boolean,
  activity_count       bigint,
  balance_at_month_end numeric,
  needs_closing        boolean,
  can_be_closed        boolean,
  confirmer_count      int
)
LANGUAGE plpgsql
VOLATILE                 -- BẮT BUỘC: xem ghi chú 1 ở đầu file
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_month     date;
  v_month_end date;
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL THEN
    RETURN;
  END IF;

  -- Chỉ trả lời cho tổ chức người gọi thuộc về. my_org_ids() suy từ MEMBERSHIP,
  -- không đọc profiles.organization_id (6/10 profile trên prod trỏ SAI org).
  IF NOT (p_organization_id = ANY (public.my_org_ids())) THEN
    RETURN;
  END IF;

  v_month     := date_trunc('month', COALESCE(p_month, CURRENT_DATE))::date;
  v_month_end := (v_month + interval '1 month' - interval '1 day')::date;

  RETURN QUERY
  WITH visible AS (
    SELECT v.cashbook_id AS id FROM app_private.ie_visible_cashbook_ids_v1() v
  ), books AS (
    SELECT a.id, a.name, a.bank_name
    FROM public.accounts a
    JOIN visible vi ON vi.id = a.id
    WHERE a.organization_id = p_organization_id
      AND a.deleted_at IS NULL
      AND NOT COALESCE(a.is_virtual, false)   -- sổ ảo (Thối/Làm tròn) không có két
  ), two_party AS (
    -- Nghi thức đòi người ký ≠ người đề nghị (CHECK closure_request_two_party_chk
    -- ở TẦNG BẢNG, không writer nào lách được). Nên "chốt được" không phải
    -- "có người ký" mà là "có MỘT CẶP hai người khác nhau".
    -- Công thức y hệt assert của 20260730160000:193:
    --   proposers>=1 AND confirmers>=1 AND KHÔNG PHẢI (đúng 1 người, và là cùng người).
    SELECT
      x.book_id,
      count(*) FILTER (WHERE x.p_ok)              AS n_prop,
      count(*) FILTER (WHERE x.c_ok)              AS n_conf,
      count(*) FILTER (WHERE x.p_ok AND x.c_ok)   AS n_both
    FROM (
      SELECT
        b.id AS book_id,
        COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
          m.user_id, p_organization_id, 'cashbooks.close', NULL, b.id)), false) AS p_ok,
        COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
          m.user_id, p_organization_id, 'cashbooks.close_confirm', NULL, b.id)), false) AS c_ok
      FROM books b
      CROSS JOIN public.organization_memberships m
      WHERE m.organization_id = p_organization_id AND m.status = 'ACTIVE'
    ) x
    GROUP BY x.book_id
  ), enriched AS (
    SELECT
      b.id, b.name, b.bank_name,
      app_private.cashbook_closed_through_v1(b.id) AS ct,
      EXISTS (
        SELECT 1 FROM app_private.cashbook_closure_requests r
        WHERE r.cashbook_id = b.id AND r.status = 'PENDING'
      ) AS pending,
      -- Phát sinh trong tháng: đếm theo DÒNG bút toán, không theo phiếu. Tồn quỹ
      -- cộng theo account của DÒNG, mà dòng Thối/Làm tròn rơi vào sổ khác.
      -- Index sẵn: ix_ie_postings_org_account_posted_on, ix_ie_posting_lines_org_account.
      (
        SELECT count(*)
        FROM public.income_expense_posting_lines l
        JOIN public.income_expense_postings p ON p.id = l.posting_id
        WHERE l.account_id = b.id
          AND l.organization_id = p_organization_id
          AND p.event_kind IN ('POSTING', 'REVERSAL')
          AND p.posted_on BETWEEN v_month AND v_month_end
      ) AS act,
      app_private.cashbook_balance_as_of_v1(b.id, v_month_end) AS bal,
      COALESCE(tp.n_prop, 0) AS n_prop,
      COALESCE(tp.n_conf, 0) AS n_conf,
      COALESCE(tp.n_both, 0) AS n_both
    FROM books b
    LEFT JOIN two_party tp ON tp.book_id = b.id
  )
  SELECT
    e.id,
    e.name,
    e.bank_name,
    (e.bank_name IS NOT NULL)                        AS is_bank,
    e.ct,
    (e.ct IS NOT NULL AND e.ct >= v_month_end)       AS covered,
    e.pending,
    e.act,
    e.bal,
    -- Sổ "phải chốt" tháng này: có phát sinh HOẶC còn dư cuối tháng. Sổ chết
    -- (0 phát sinh, dư 0) thì nhắc là ồn vô ích.
    (e.act > 0 OR COALESCE(e.bal, 0) <> 0)           AS needs_closing,
    (e.n_prop >= 1 AND e.n_conf >= 1
       AND NOT (e.n_prop = 1 AND e.n_conf = 1 AND e.n_both = 1)) AS can_be_closed,
    e.n_conf::int                                    AS confirmer_count
  FROM enriched e
  ORDER BY (e.ct IS NOT NULL AND e.ct >= v_month_end), e.name;
END
$fn$;

-- DROP+CREATE / CREATE OR REPLACE hàm mới hứng DEFAULT PRIVILEGES (EXECUTE cho
-- PUBLIC), nên REVOKE tường minh trước khi GRANT. `revoke from public` KHÔNG
-- dọn được grant đã cấp đích danh cho anon/service_role — phải kể tên.
REVOKE ALL ON FUNCTION public.cashbook_closing_monthly_status_v1(uuid, date)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cashbook_closing_monthly_status_v1(uuid, date)
  TO authenticated;

COMMENT ON FUNCTION public.cashbook_closing_monthly_status_v1(uuid, date) IS
  'PA4: mỗi sổ quỹ không-ảo NHÌN ĐƯỢC của tổ chức đã chốt tới đâu so với tháng p_month. covered=đã phủ hết tháng; needs_closing=có phát sinh hoặc còn dư; can_be_closed=có người ký thứ hai. VOLATILE vì gọi authorize_tenant_action_v3 (FOR SHARE).';

COMMIT;

NOTIFY pgrst, 'reload schema';
