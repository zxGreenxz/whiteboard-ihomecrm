-- =====================================================================
-- PA4 (D/5) — TRẠNG THÁI CHỐT PHẢI NÓI THEO NGƯỜI ĐANG XEM, không chỉ theo hệ
--
-- Đo trực tiếp trên trình duyệt (chủ NG TÂM, sổ "Hiệp Thu"): panel PA4 nói
-- "chốt được ngay" và mời bấm, nhưng mở hộp thoại ra thì blocker NO_CONFIRMER
-- chặn ngay — vì `cashbook_close_confirmers_v1` LOẠI CHÍNH NGƯỜI GỌI, và trên
-- sổ đó chủ là người ký duy nhất. Sổ ấy chốt được, nhưng phải do NATHAN đề
-- nghị, không phải chủ.
--
-- `can_be_closed` (v1) trả lời câu hỏi của HỆ THỐNG: "tồn tại một cặp hai người
-- khác nhau?" — đúng, và vẫn cần để phân biệt "chưa gán vai trò Kế toán" với
-- "chờ người khác". Nhưng panel là màn của MỘT người, nên phải thêm câu trả lời
-- cho người đó: tôi đề nghị được không, tôi ký được không.
--
-- `i_can_propose` cũng đòi ĐANG GIỮ SỔ (CUSTODIAN): propose_cashbook_closing_v1
-- gọi assert_cashbook_access_v2(..., 'CUSTODIAN', ...) — người không giữ sổ dù
-- có quyền cashbooks.close vẫn bị chặn. Không mời người ta vào cửa đóng.
-- Đây là GỢI Ý cho giao diện; hộp thoại vẫn chạy blockers thật làm trọng tài.
--
-- Phải DROP rồi CREATE: thêm cột vào RETURNS TABLE là 42P13. Kèm REVOKE/GRANT
-- lại vì DROP+CREATE hứng default privileges (EXECUTE cho PUBLIC).
-- =====================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.cashbook_closing_monthly_status_v1(uuid, date);

CREATE FUNCTION public.cashbook_closing_monthly_status_v1(
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
  confirmer_count      int,
  i_can_propose        boolean,
  i_can_confirm        boolean
)
LANGUAGE plpgsql
VOLATILE                 -- gọi authorize_tenant_action_v3 (FOR SHARE) ⇒ 25006 nếu STABLE
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

  -- my_org_ids() suy từ MEMBERSHIP, không đọc profiles.organization_id
  -- (6/10 profile trên prod trỏ SAI org).
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
  ), grid AS (
    -- Một lượt quét (sổ × thành viên ACTIVE), hỏi cả hai khoá. Dùng lại cho cả
    -- phép đếm của hệ thống lẫn phép hỏi của người đang xem.
    SELECT
      b.id AS book_id,
      m.user_id,
      COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
        m.user_id, p_organization_id, 'cashbooks.close', NULL, b.id)), false) AS p_ok,
      COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
        m.user_id, p_organization_id, 'cashbooks.close_confirm', NULL, b.id)), false) AS c_ok
    FROM books b
    CROSS JOIN public.organization_memberships m
    WHERE m.organization_id = p_organization_id AND m.status = 'ACTIVE'
  ), two_party AS (
    SELECT
      g.book_id,
      count(*) FILTER (WHERE g.p_ok)                                  AS n_prop,
      count(*) FILTER (WHERE g.c_ok)                                  AS n_conf,
      count(*) FILTER (WHERE g.p_ok AND g.c_ok)                       AS n_both,
      -- có người KHÁC TÔI ký được / đề nghị được
      bool_or(g.c_ok AND g.user_id IS DISTINCT FROM v_uid)            AS other_conf,
      bool_or(g.p_ok AND g.user_id IS DISTINCT FROM v_uid)            AS other_prop,
      bool_or(g.p_ok AND g.user_id = v_uid)                           AS me_prop,
      bool_or(g.c_ok AND g.user_id = v_uid)                           AS me_conf
    FROM grid g
    GROUP BY g.book_id
  ), custody AS (
    -- Đang giữ sổ = điều kiện propose_cashbook_closing_v1 kiểm bằng
    -- assert_cashbook_access_v2(..., 'CUSTODIAN', ...). Hàm đó RAISE nên không
    -- gọi trực tiếp trong truy vấn được; soi thẳng binding (đủ cho gợi ý UI).
    SELECT DISTINCT pb.cashbook_id AS book_id
    FROM public.cashbook_possession_bindings pb
    JOIN public.organization_memberships m
      ON m.id = pb.membership_id AND m.status = 'ACTIVE' AND m.user_id = v_uid
    WHERE pb.organization_id = p_organization_id
      AND pb.possession_kind = 'CUSTODIAN'
      AND pb.valid_from <= now()
      AND (pb.valid_to IS NULL OR pb.valid_to > now())
  ), enriched AS (
    SELECT
      b.id, b.name, b.bank_name,
      app_private.cashbook_closed_through_v1(b.id) AS ct,
      EXISTS (
        SELECT 1 FROM app_private.cashbook_closure_requests r
        WHERE r.cashbook_id = b.id AND r.status = 'PENDING'
      ) AS pending,
      -- Phát sinh trong tháng: đếm theo DÒNG bút toán, không theo phiếu — tồn
      -- quỹ cộng theo account của DÒNG, mà dòng Thối/Làm tròn rơi vào sổ khác.
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
      COALESCE(tp.n_prop, 0)      AS n_prop,
      COALESCE(tp.n_conf, 0)      AS n_conf,
      COALESCE(tp.n_both, 0)      AS n_both,
      COALESCE(tp.me_prop, false) AS me_prop,
      COALESCE(tp.me_conf, false) AS me_conf,
      COALESCE(tp.other_prop, false) AS other_prop,
      COALESCE(tp.other_conf, false) AS other_conf,
      EXISTS (SELECT 1 FROM custody c WHERE c.book_id = b.id) AS mine_to_hold
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
    -- Câu hỏi của HỆ THỐNG: có tồn tại cặp hai người khác nhau?
    (e.n_prop >= 1 AND e.n_conf >= 1
       AND NOT (e.n_prop = 1 AND e.n_conf = 1 AND e.n_both = 1)) AS can_be_closed,
    e.n_conf::int                                    AS confirmer_count,
    -- Câu hỏi của TÔI: tôi giữ sổ, tôi đề nghị được, và có người KHÁC ký được.
    (e.mine_to_hold AND e.me_prop AND e.other_conf)  AS i_can_propose,
    (e.me_conf AND e.other_prop)                     AS i_can_confirm
  FROM enriched e
  ORDER BY (e.ct IS NOT NULL AND e.ct >= v_month_end), e.name;
END
$fn$;

REVOKE ALL ON FUNCTION public.cashbook_closing_monthly_status_v1(uuid, date)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cashbook_closing_monthly_status_v1(uuid, date)
  TO authenticated;

COMMENT ON FUNCTION public.cashbook_closing_monthly_status_v1(uuid, date) IS
  'PA4: mỗi sổ quỹ không-ảo NHÌN ĐƯỢC của tổ chức đã chốt tới đâu so với tháng p_month. covered=đã phủ hết tháng; needs_closing=có phát sinh hoặc còn dư; can_be_closed=HỆ có đủ hai người; i_can_propose/i_can_confirm=NGƯỜI ĐANG XEM làm được gì (propose còn đòi đang giữ sổ). VOLATILE vì gọi authorize_tenant_action_v3 (FOR SHARE).';

COMMIT;

NOTIFY pgrst, 'reload schema';
