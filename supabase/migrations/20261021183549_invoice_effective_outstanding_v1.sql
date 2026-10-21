-- =============================================================================
-- "Nợ thực" khi cộng công nợ: không đếm hai lần phần nợ cũ đã KÉO SANG hoá đơn sau (22/10/2026).
--
-- LỖI
--   Hoá đơn mới cộng nợ cũ vào previous_debt; previous_debt_sources ghi ẢNH CHỤP dư nợ của
--   từng hoá đơn nguồn lúc phát hành. Hoá đơn nguồn VẪN MỞ (OVERDUE/PARTIAL_PAID, còn
--   remaining_amount) cho tới khi hoá đơn gánh được trả đủ — lúc đó recompute_invoice_for_id
--   mới suy ra nguồn đã trả (20260728160000 B1; 20260915074716 H1: invoice_carried_debt_v1).
--   Cộng thẳng remaining_amount của mọi hoá đơn mở vì thế đếm phần nợ kéo HAI lần (một lần ở
--   nguồn, một lần trong tổng của hoá đơn gánh); chuỗi kéo nhiều tầng (T5→T7→T6→T8→T9→T10)
--   nhân số lần đếm theo số tầng. Đo 22/10 (chỉ đọc): 22 hoá đơn nguồn đang được một hoá đơn
--   mở khác gánh, phần cộng trùng ≈ 23 % tổng "còn lại" cộng thẳng, nằm ở 3 toà.
--
-- ĐỊNH NGHĨA (một hàm, mọi nơi cộng công nợ gọi chung) — cho TẬP hoá đơn S đang được cộng:
--   cạnh gánh X → C: phần tử {type:'invoice', id: X, amount: a} trong previous_debt_sources của
--     hoá đơn gánh C còn mở (APPROVED/PARTIAL_PAID/OVERDUE, deleted_at IS NULL), cùng công ty
--     với X, C tạo SAU X (created_at — mọi cạnh thật đều vậy, đo 22/10: 33/33; chặn luôn chu
--     trình), a là số dương (không phải số ⇒ 0).
--   C "nằm trong S" khi C ∈ S hoặc C bị gánh tiếp (bắc cầu) vào một hoá đơn nằm trong S — nợ
--     của C khi đó đã được đếm trong S.
--   carried_forward(X | S) = Σ a của các cạnh X → C với C nằm trong S.
--   effective_outstanding(X | S) = remaining(X) − LEAST(carried_forward, GREATEST(remaining(X), 0))
--     • chặn trên: không trừ quá dư nợ còn lại (ảnh chụp lớn hơn khi khách trả thẳng vào nguồn
--       sau khi kéo) ⇒ không âm vì phần kéo; remaining ≤ 0 ⇒ không trừ gì.
--   Σ effective_outstanding trên S = nợ của S, mỗi đồng chỉ một lần dù kéo bao nhiêu tầng.
--   • S = mọi hoá đơn mở (tổng công nợ, theo toà, theo phòng): nợ kéo tính ở hoá đơn gánh —
--     nơi sẽ thu; đây là "nợ thực" của từng hoá đơn.
--   • S là tập lọc (một kỳ, một trạng thái, một khoảng hạn): chỉ khử phần trùng NẰM TRONG tập;
--     hoá đơn gánh ngoài tập thì nợ cũ vẫn thuộc tập (nợ quá hạn vẫn là quá hạn khi hoá đơn
--     gánh chưa tới hạn; thẻ một kỳ vẫn khớp các dòng của kỳ đó).
--   • Hoá đơn gánh PAID: KHÔNG trừ lại — recompute đã cộng phần đó vào paid_amount của nguồn.
--   • Gánh CANCELLED / xoá mềm / DRAFT / PENDING_APPROVAL: không gánh ⇒ nợ ở lại nguồn.
--   • Gánh PARTIAL_PAID: nguồn = 0 (nếu gánh trong tập), gánh giữ phần chưa thu (đúng số đòi khách).
--   • Công ty: như invoice_carried_debt_v1 (H1.2) — chỉ hoá đơn gánh CÙNG công ty.
--
-- CỐ Ý KHÔNG LÀM (ca biên chờ chủ quyết — ghi trong PR):
--   • previous_debt > 0 mà KHÔNG khai nguồn (nhập tay/legacy; 1 hoá đơn mở 22/10): không suy ra
--     nguồn, nợ ở lại hoá đơn cũ. Màn lập hoá đơn (computePreviousDebt) dùng heuristic "mọi hoá
--     đơn mở cũ hơn cùng hợp đồng" — không đưa heuristic vào số tiền.
--   • Ảnh chụp lệch dư nợ nguồn (khách trả thẳng vào nguồn SAU khi kéo): hoá đơn gánh vẫn đòi đủ
--     ảnh chụp; hàm báo đúng số hệ thống sẽ đòi, không sửa tổng hoá đơn gánh.
--   • Tách tuổi nợ/kỳ phát sinh của phần kéo (phân bổ FIFO) — cần chủ chốt cách phân bổ.
--
-- QUYỀN (ngoại lệ có chủ ý so với "hàm chung tự chặn current_user <> authenticated")
--   SECURITY INVOKER, search_path ''. Gọi bằng JWT (authenticated): đọc invoices qua RLS của
--   người gọi — không thấy hoá đơn thì không có dòng; hoá đơn gánh không thấy thì không trừ
--   (người đó chỉ thấy nợ một lần ở nguồn). Đường đọc Hermes đang chạy là SECURITY DEFINER
--   (owner postgres) và gọi hàm này cho TẬP ID NÓ ĐÃ CẤP QUYỀN — hàm chỉ trả số của đúng các id
--   được truyền. EXECUTE chỉ authenticated (như invoice_statistics_v3).
--   Một câu; RLS tính theo tập (InitPlan), không gọi theo từng dòng; nơi gọi truyền MẢNG id.
--
-- invoice_statistics_v3 (thẻ "Phải thu" ở /invoices; Hermes chép công thức ở báo cáo hoá đơn):
--   total_remaining = Σ GREATEST(effective_outstanding(· | tập của thẻ), 0) thay vì
--   Σ GREATEST(remaining, 0). Mọi cột khác, chữ ký, kiểu trả về, ACL giữ nguyên.
--
-- KHÔNG đổi cách lập/thu hoá đơn, không đổi previous_debt, không ghi dữ liệu.
-- Idempotent: CREATE OR REPLACE, chạy hai lần cùng kết quả.
-- LÙI: áp lại thân invoice_statistics_v3 của 20261017115809 (CREATE OR REPLACE) rồi
--   DROP FUNCTION public.invoice_effective_outstanding_v1(uuid[]) — chỉ sau khi mọi hàm gọi
--   nó đã lùi về bản trước. Không có dữ liệu nào phải khôi phục.
-- Không tự mở BEGIN/COMMIT: lane (và test-env:thu-sql) bọc cả file trong MỘT transaction có lock/statement timeout.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.invoice_effective_outstanding_v1(p_invoice_ids uuid[])
RETURNS TABLE(invoice_id uuid, remaining_amount numeric, carried_forward_amount numeric, effective_outstanding numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH RECURSIVE src AS MATERIALIZED (
    SELECT i.id, i.organization_id, COALESCE(i.remaining_amount, 0)::numeric AS remaining
      FROM public.invoices i
     WHERE i.id = ANY (COALESCE(p_invoice_ids, '{}'::uuid[]))
  ),
  links AS MATERIALIZED (
    -- Cạnh nguồn → hoá đơn gánh còn mở, của (các) công ty có mặt trong tập.
    SELECT x.id AS source_id, c.id AS carrier_id,
           GREATEST(CASE
             WHEN jsonb_typeof(e.value->'amount') = 'number' THEN (e.value->>'amount')::numeric
             WHEN e.value->>'amount' ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN btrim(e.value->>'amount')::numeric
             ELSE 0 END, 0) AS amount
      FROM public.invoices c
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(c.previous_debt_sources) = 'array' THEN c.previous_debt_sources ELSE '[]'::jsonb END) e
     CROSS JOIN LATERAL (SELECT CASE
       WHEN jsonb_typeof(e.value) = 'object' AND e.value->>'type' = 'invoice'
        AND e.value->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN (e.value->>'id')::uuid END AS id) ref
      JOIN public.invoices x
        ON x.id = ref.id
       AND x.organization_id = c.organization_id
       AND x.created_at < c.created_at
     WHERE c.deleted_at IS NULL
       AND c.status::text IN ('APPROVED', 'PARTIAL_PAID', 'OVERDUE')
       AND c.organization_id IN (SELECT s.organization_id FROM src s)
  ),
  covered(id) AS (
    -- Hoá đơn mà nợ của nó đã được đếm trong tập: chính tập, rồi lùi dần theo cạnh gánh.
    SELECT s.id FROM src s
    UNION
    SELECT l.source_id FROM links l JOIN covered cv ON cv.id = l.carrier_id
  ),
  carried AS (
    SELECT l.source_id, sum(l.amount) AS amount
      FROM links l
     WHERE l.carrier_id IN (SELECT cv.id FROM covered cv)
     GROUP BY l.source_id
  )
  SELECT s.id,
         s.remaining,
         COALESCE(k.amount, 0),
         s.remaining - LEAST(COALESCE(k.amount, 0), GREATEST(s.remaining, 0))
    FROM src s
    LEFT JOIN carried k ON k.source_id = s.id
$fn$;

COMMENT ON FUNCTION public.invoice_effective_outstanding_v1(uuid[]) IS
  'Nợ thực khi cộng tập hoá đơn p_invoice_ids: remaining_amount trừ phần đã kéo (previous_debt_sources) '
  'sang hoá đơn gánh CÒN MỞ cùng công ty, tạo sau, mà nợ của nó cũng nằm trong tập (trực tiếp hoặc '
  'bắc cầu); chặn trên ở dư nợ còn lại. Tập = mọi hoá đơn mở ⇒ nợ thực từng hoá đơn. Gánh PAID không '
  'trừ (recompute đã suy vào paid_amount). INVOKER: RLS người gọi; hàm DEFINER gọi cho tập id đã cấp quyền.';

ALTER FUNCTION public.invoice_effective_outstanding_v1(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoice_effective_outstanding_v1(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_effective_outstanding_v1(uuid[]) TO authenticated;

-- Chống đè bản khác của thẻ thống kê: chỉ thay đúng thân 20261017115809 (md5 prosrc production 22/10) hoặc chính bản
-- này (chạy lại); hàm chưa có (CSDL dựng mới) thì tạo mới.
DO $requires$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.invoice_statistics_v3(text,public.invoice_status,text,uuid[],uuid[],date,date,uuid[])');
  IF v_md5 IS NOT NULL AND v_md5 NOT IN ('2805efd89016269cf1356d16e176a508', 'ec0cd361add3e15111ac4a40dd4be500') THEN
    RAISE EXCEPTION 'invoice_statistics_v3_live_body_changed: %', v_md5;
  END IF;
END $requires$;

-- Thân = 20261017115809 với MỘT chỗ đổi: total_remaining đọc nợ thực của tập (đánh dấu [NỢ KÉO]).
CREATE OR REPLACE FUNCTION public.invoice_statistics_v3(
  p_billing_month text DEFAULT NULL,
  p_status public.invoice_status DEFAULT NULL,
  p_payment_status text DEFAULT NULL,
  p_filter_building_ids uuid[] DEFAULT NULL,
  p_room_ids uuid[] DEFAULT NULL,
  p_issue_date_from date DEFAULT NULL,
  p_issue_date_to date DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  total_amount numeric,
  total_paid numeric,
  total_remaining numeric,
  total_refunded numeric,
  total_count bigint,
  rent_amount numeric,
  electric_amount numeric,
  water_amount numeric,
  pdv_amount numeric,
  total_collected numeric,
  payment_tm numeric,
  payment_tk numeric,
  payment_tt numeric,
  payment_ct numeric,
  change_amount numeric,
  deposit_collected numeric)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_scope uuid[];
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'invoice_statistics_v3 chỉ chạy bằng JWT người dùng' USING ERRCODE = '42501';
  END IF;
  IF p_payment_status IS NOT NULL AND p_payment_status NOT IN ('paid', 'partial', 'unpaid') THEN
    RAISE EXCEPTION 'Tham số thống kê hoá đơn không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_scope := public.invoice_scope_building_ids_v1();

  RETURN QUERY
  -- Cùng tập hoá đơn với invoice_list_v1: RLS + phạm vi invoices.view + cùng bộ lọc kỳ/ngày lập.
  WITH inv AS MATERIALIZED (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount
      FROM public.invoices i
     WHERE i.deleted_at IS NULL
       AND i.building_id = ANY (v_scope)
       AND (p_building_ids IS NULL OR i.building_id = ANY (p_building_ids))
       AND (p_filter_building_ids IS NULL OR i.building_id = ANY (p_filter_building_ids))
       AND (p_room_ids IS NULL OR i.room_id = ANY (p_room_ids))
       AND (p_status IS NULL OR i.status = p_status)
       -- [A1] Hoá đơn đã HUỶ không còn là công nợ: loại khỏi mọi tổng, TRỪ khi hỏi đích danh.
       AND (p_status IS NOT DISTINCT FROM 'CANCELLED'::public.invoice_status OR i.status <> 'CANCELLED')
       AND (p_issue_date_from IS NULL OR i.issue_date >= p_issue_date_from)
       AND (p_issue_date_to IS NULL OR i.issue_date <= p_issue_date_to)
       AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
       AND (p_payment_status IS NULL
            OR (p_payment_status = 'paid' AND i.status = 'PAID')
            OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
            OR (p_payment_status = 'unpaid' AND i.status NOT IN ('PAID', 'PARTIAL_PAID')))
  ),
  -- [NỢ KÉO] Nợ thực của từng hoá đơn trong ĐÚNG tập của thẻ (một lời gọi cho cả tập).
  owed AS MATERIALIZED (
    SELECT o.invoice_id, o.effective_outstanding
      FROM public.invoice_effective_outstanding_v1(ARRAY(SELECT inv.id FROM inv)) o
  ),
  totals AS (
    SELECT coalesce(sum(inv.total_amount), 0) AS total_amount,
           coalesce(sum(inv.paid_amount), 0) AS total_paid,
           -- [NỢ KÉO] trước: sum(greatest(inv.remaining_amount, 0)) — đếm phần kéo hai lần.
           coalesce(sum(greatest(coalesce(owed.effective_outstanding, inv.remaining_amount), 0)), 0) AS total_remaining,
           coalesce(sum(greatest(-inv.remaining_amount, 0)), 0) AS total_refunded,
           count(*) AS total_count,
           coalesce(array_agg(inv.id), '{}'::uuid[]) AS ids
      FROM inv LEFT JOIN owed ON owed.invoice_id = inv.id
  ),
  items AS (
    SELECT coalesce(sum(CASE WHEN ii.type = 'RENT' THEN ii.amount ELSE 0 END), 0) AS rent_amount,
           coalesce(sum(CASE WHEN ii.type NOT IN ('RENT', 'DISCOUNT')
                              AND lower(coalesce(ii.description, '')) LIKE '%điện%'
                             THEN ii.amount ELSE 0 END), 0) AS electric_amount,
           coalesce(sum(CASE WHEN ii.type NOT IN ('RENT', 'DISCOUNT')
                              AND lower(coalesce(ii.description, '')) LIKE '%nước%'
                             THEN ii.amount ELSE 0 END), 0) AS water_amount,
           coalesce(sum(CASE WHEN ii.type NOT IN ('RENT', 'DISCOUNT')
                              AND lower(coalesce(ii.description, '')) NOT LIKE '%điện%'
                              AND lower(coalesce(ii.description, '')) NOT LIKE '%nước%'
                             THEN ii.amount ELSE 0 END), 0) AS pdv_amount
      FROM inv JOIN public.invoice_items ii ON ii.invoice_id = inv.id
  ),
  money AS (
    SELECT m.*
      FROM totals
     CROSS JOIN LATERAL public.invoice_statistics_money_v1(totals.ids, p_billing_month, p_filter_building_ids,
       p_room_ids, p_issue_date_from, p_issue_date_to, p_building_ids) m
  )
  -- numeric(15,2) như các biến DECIMAL(15,2) của v2.
  SELECT totals.total_amount::numeric(15,2), totals.total_paid::numeric(15,2),
         totals.total_remaining::numeric(15,2), totals.total_refunded::numeric(15,2), totals.total_count,
         items.rent_amount::numeric(15,2), items.electric_amount::numeric(15,2),
         items.water_amount::numeric(15,2), items.pdv_amount::numeric(15,2),
         money.total_collected::numeric(15,2), money.payment_tm::numeric(15,2),
         money.payment_tk::numeric(15,2), money.payment_tt::numeric(15,2),
         money.payment_ct::numeric(15,2), money.change_amount::numeric(15,2),
         money.deposit_collected::numeric(15,2)
    FROM totals, items, money;
END
$fn$;

COMMENT ON FUNCTION public.invoice_statistics_v3(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) IS
  'Thẻ thống kê hoá đơn dùng chung — công thức get_invoice_statistics_v2 trên cùng tập hoá đơn với invoice_list_v1 (INVOKER + RLS + invoices.view thật, không theo staff_assignments). total_remaining = Σ nợ thực của tập (invoice_effective_outstanding_v1: không đếm hai lần phần đã kéo sang hoá đơn gánh còn mở cùng tập). p_building_ids chỉ thu hẹp: NULL = toàn phạm vi, ''{}'' = rỗng.';

ALTER FUNCTION public.invoice_statistics_v3(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoice_statistics_v3(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_statistics_v3(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[])
  TO authenticated;

NOTIFY pgrst, 'reload schema';
