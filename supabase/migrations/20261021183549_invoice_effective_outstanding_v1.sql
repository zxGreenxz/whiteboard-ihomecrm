-- =============================================================================
-- "Nợ thực" khi cộng công nợ: không đếm hai lần phần nợ cũ đã KÉO SANG hoá đơn sau (22/10/2026).
--
-- LỖI
--   Hoá đơn mới cộng nợ cũ vào previous_debt; previous_debt_sources ghi ẢNH CHỤP dư nợ của
--   từng hoá đơn nguồn lúc phát hành. Hoá đơn nguồn VẪN MỞ (OVERDUE/PARTIAL_PAID, còn
--   remaining_amount) cho tới khi hoá đơn gánh được trả đủ — lúc đó recompute_invoice_for_id
--   mới suy ra nguồn đã trả (20260728160000 B1; 20260915074716 H1: invoice_carried_debt_v1).
--   Cộng thẳng remaining_amount của mọi hoá đơn mở vì thế đếm phần nợ kéo HAI lần (một lần ở
--   nguồn, một lần trong tổng của hoá đơn gánh); chuỗi kéo nhiều tầng nhân số lần đếm theo số
--   tầng. Đo 22/10 (chỉ đọc): 22 hoá đơn nguồn đang được một hoá đơn mở khác gánh, phần cộng
--   trùng ≈ 23 % tổng "còn lại" cộng thẳng, nằm ở 3 toà.
--
-- ĐỊNH NGHĨA (một hàm, mọi nơi cộng công nợ gọi chung) — cho TẬP hoá đơn S đang được cộng:
--   Cạnh gánh X → C: phần tử {type:'invoice', id: X, amount: a} trong previous_debt_sources của hoá
--     đơn gánh C chưa trả xong, chưa huỷ (DRAFT/PENDING_APPROVAL/APPROVED/PARTIAL_PAID/OVERDUE,
--     deleted_at IS NULL), cùng công ty với X, C tạo SAU X (created_at — mọi cạnh thật đều vậy, đo
--     22/10: 33/33; chặn luôn chu trình), a là số dương (cặp lặp lại: cộng a).
--   Cạnh được đếm khi C ∈ S hoặc C bị gánh tiếp (bắc cầu) vào hoá đơn có cạnh được đếm — nợ của C
--     khi đó đã nằm trong S.
--   Mỗi đồng nợ tính MỘT lần trong S, ở hoá đơn PHÁT SINH GỐC (hoá đơn cũ nhất của S trên đường kéo)
--   ⇒ tuổi nợ theo hạn của kỳ phát sinh gốc (mặc định phiên chính chọn 22/10, chờ chủ chốt):
--   1. t(X→C): dư nợ còn lại của X (≥ 0) chia cho các hoá đơn gánh theo thứ tự tạo, mỗi cạnh tối đa a
--      (ảnh chụp lớn hơn dư nợ khi khách trả thẳng vào nguồn sau khi kéo).
--   2. Đi từ hoá đơn mới nhất về cũ nhất, hoá đơn gánh trả phần kéo về nguồn, tối đa phần nó còn giữ:
--      tiền thu vào hoá đơn gánh trả phần phát sinh MỚI trước, nợ kéo trả SAU CÙNG — khớp
--      recompute_invoice_for_id (nguồn chỉ được coi là đã trả khi hoá đơn gánh PAID). Nhiều nguồn:
--      nguồn cũ nhất nhận trước. Nguồn NGOÀI S chỉ chuyển tiếp phần thuộc hoá đơn của S phía trước nó;
--      phần riêng của nó ở lại hoá đơn gánh trong S.
--   ⇒ Tổng trên S bằng đúng cách "dồn về hoá đơn gánh" (mỗi đồng chỉ chuyển giữa hai hoá đơn của S).
--   Cột trả về (kiểu trả về đóng băng sau lần áp đầu — đủ suy CẢ hai cách tính tuổi nợ):
--     carried_out_amount               = Σ t ra: dư nợ của hoá đơn này đã kéo sang hoá đơn gánh được đếm;
--     carried_in_amount                = phần dư nợ của hoá đơn này đang tính ở các nguồn trong S;
--     effective_outstanding            = nợ thực theo kỳ phát sinh gốc — MẶC ĐỊNH, mọi nơi gọi dùng cột này;
--     effective_outstanding_at_carrier = remaining − carried_out_amount: nợ dồn về hoá đơn gánh (tuổi theo
--                                        hạn hoá đơn gánh) — dùng nếu chủ chọn cách này, không đổi kiểu trả về.
--   • S = mọi hoá đơn mở (tổng, theo toà, tuổi nợ): nợ thực từng hoá đơn theo kỳ phát sinh.
--   • S là tập lọc (kỳ, trạng thái, khoảng hạn): chỉ khử phần trùng NẰM TRONG tập; hoá đơn gánh ngoài
--     tập thì nợ cũ vẫn thuộc tập, ở hoá đơn của tập.
--   • Gánh PAID: không phải cạnh — recompute đã cộng phần đó vào paid_amount của nguồn.
--   • Gánh CANCELLED / xoá mềm: không gánh ⇒ nợ ở lại nguồn.
--   • Gánh DRAFT/PENDING_APPROVAL: là cạnh (thẻ /invoices cộng cả hoá đơn nháp); chỉ có tác dụng khi
--     hoá đơn nháp nằm trong S, nên đường đọc chỉ gồm hoá đơn mở không đổi.
--   • remaining ≤ 0: không kéo gì từ hoá đơn đó; hoá đơn gánh âm không trả gì về nguồn.
--   • Công ty: như invoice_carried_debt_v1 (H1.2) — chỉ hoá đơn gánh CÙNG công ty.
--
-- CỐ Ý KHÔNG LÀM (ca biên chờ chủ quyết — ghi trong PR):
--   • previous_debt > 0 mà KHÔNG khai nguồn (nhập tay/legacy): không suy ra nguồn, phần đó là của hoá
--     đơn gánh. Màn lập hoá đơn (computePreviousDebt) dùng heuristic — không đưa heuristic vào số tiền.
--   • Ảnh chụp lệch dư nợ nguồn (khách trả thẳng vào nguồn SAU khi kéo): hoá đơn gánh vẫn đòi đủ ảnh
--     chụp; phần chênh tính ở hoá đơn gánh như số hệ thống sẽ đòi.
--   • Bên ghi không ép Σ amount của nguồn = previous_debt — chưa chặn ở writer.
--
-- QUYỀN (ngoại lệ có chủ ý so với "hàm chung tự chặn current_user <> authenticated")
--   SECURITY INVOKER, search_path ''. Gọi bằng JWT (authenticated): đọc invoices qua RLS của người
--   gọi — không thấy hoá đơn thì không có dòng; hoá đơn gánh không thấy thì không có cạnh (người đó
--   thấy nợ một lần ở nguồn). Đường đọc Hermes là SECURITY DEFINER (owner postgres) và gọi hàm này
--   cho TẬP ID NÓ ĐÃ CẤP QUYỀN — hàm chỉ trả số của đúng các id được truyền. EXECUTE: authenticated và
--   service_role (get_dashboard_summary cấp cả service_role và gọi hàm này).
--   Một câu SQL đọc cạnh cho cả tập (cạnh tách TRƯỚC từ hoá đơn gánh, rồi nối hoá đơn nguồn theo khoá
--   chính); phần chia nợ chạy trên mảng các hoá đơn dính cạnh (O(nút + cạnh)).
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
RETURNS TABLE(invoice_id uuid, remaining_amount numeric, carried_out_amount numeric, carried_in_amount numeric,
              effective_outstanding numeric, effective_outstanding_at_carrier numeric)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_ids uuid[] := COALESCE(p_invoice_ids, '{}'::uuid[]);
  -- Nút: hoá đơn dính cạnh được đếm, xếp (created_at, id) tăng dần — nguồn luôn đứng trước gánh.
  n_id uuid[]; n_rem numeric[]; n_set boolean[];
  -- Cạnh (chỉ số nút) xếp (nguồn, gánh) tăng dần; e_by_car: chỉ số cạnh xếp (gánh, nguồn) tăng dần.
  e_src int[]; e_car int[]; e_amt numeric[]; e_by_car int[];
  e_t numeric[]; e_cap numeric[]; e_k numeric[];
  n_out numeric[]; n_pool numeric[]; n_back numeric[]; n_in numeric[]; n_eff numeric[]; n_first int[]; n_last int[];
  v_n int; v_m int; v_left numeric; v_budget numeric; v_h numeric; v_i int; v_j int; v_p int;
BEGIN
  WITH RECURSIVE src AS MATERIALIZED (
    SELECT inv.id, inv.organization_id FROM public.invoices inv WHERE inv.id = ANY (v_ids)
  ),
  raw AS MATERIALIZED (
    -- Cạnh tách từ hoá đơn gánh hợp lệ của (các) công ty trong tập, CHƯA nối hoá đơn nguồn.
    SELECT c.id AS carrier_id, c.organization_id, c.created_at, ref.id AS source_id, amt.amount
      FROM public.invoices c
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(c.previous_debt_sources) = 'array' THEN c.previous_debt_sources ELSE '[]'::jsonb END) e
     CROSS JOIN LATERAL (SELECT CASE
       WHEN jsonb_typeof(e.value) = 'object' AND e.value->>'type' = 'invoice'
        AND e.value->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN (e.value->>'id')::uuid END AS id) ref
     CROSS JOIN LATERAL (SELECT GREATEST(CASE
       WHEN jsonb_typeof(e.value->'amount') = 'number' THEN (e.value->>'amount')::numeric
       WHEN e.value->>'amount' ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN btrim(e.value->>'amount')::numeric
       ELSE 0 END, 0) AS amount) amt
     WHERE c.deleted_at IS NULL
       AND c.status::text IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIAL_PAID', 'OVERDUE')
       AND c.organization_id IN (SELECT s.organization_id FROM src s)
       AND ref.id IS NOT NULL AND amt.amount > 0
  ),
  edge AS MATERIALIZED (
    -- Nối hoá đơn nguồn theo khoá chính, rồi lọc cùng công ty và tạo trước hoá đơn gánh.
    SELECT r.source_id, r.carrier_id, sum(r.amount) AS amount
      FROM raw r JOIN public.invoices x ON x.id = r.source_id
     WHERE x.organization_id = r.organization_id AND x.created_at < r.created_at
     GROUP BY r.source_id, r.carrier_id
  ),
  covered(id) AS (
    SELECT s.id FROM src s
    UNION
    SELECT e.source_id FROM edge e JOIN covered cv ON cv.id = e.carrier_id
  ),
  counted AS MATERIALIZED (
    SELECT e.source_id, e.carrier_id, e.amount FROM edge e WHERE e.carrier_id IN (SELECT cv.id FROM covered cv)
  ),
  node AS MATERIALIZED (
    SELECT inv.id, COALESCE(inv.remaining_amount, 0)::numeric AS remaining, inv.id = ANY (v_ids) AS in_set,
           row_number() OVER (ORDER BY inv.created_at, inv.id)::int AS idx
      FROM public.invoices inv
     WHERE inv.id IN (SELECT k.source_id FROM counted k UNION SELECT k.carrier_id FROM counted k)
  ),
  numbered AS MATERIALIZED (
    SELECT s.idx AS s_idx, c.idx AS c_idx, k.amount, row_number() OVER (ORDER BY s.idx, c.idx)::int AS pos
      FROM counted k JOIN node s ON s.id = k.source_id JOIN node c ON c.id = k.carrier_id
  )
  SELECT (SELECT array_agg(n.id ORDER BY n.idx) FROM node n),
         (SELECT array_agg(n.remaining ORDER BY n.idx) FROM node n),
         (SELECT array_agg(n.in_set ORDER BY n.idx) FROM node n),
         (SELECT array_agg(b.s_idx ORDER BY b.pos) FROM numbered b),
         (SELECT array_agg(b.c_idx ORDER BY b.pos) FROM numbered b),
         (SELECT array_agg(b.amount ORDER BY b.pos) FROM numbered b),
         (SELECT array_agg(b.pos ORDER BY b.c_idx, b.s_idx) FROM numbered b)
    INTO n_id, n_rem, n_set, e_src, e_car, e_amt, e_by_car;

  v_n := COALESCE(cardinality(n_id), 0);
  v_m := COALESCE(cardinality(e_src), 0);
  IF v_m > 0 THEN
    e_t := array_fill(0::numeric, ARRAY[v_m]); e_cap := e_t; e_k := e_t;
    n_out := array_fill(0::numeric, ARRAY[v_n]); n_pool := n_out; n_back := n_out; n_in := n_out; n_eff := n_out;
    n_first := array_fill(NULL::int, ARRAY[v_n]); n_last := n_first;
    -- (1) t: dư nợ của nguồn chia cho các hoá đơn gánh theo thứ tự tạo, mỗi cạnh tối đa ảnh chụp.
    FOR v_j IN 1..v_m LOOP
      IF v_j = 1 OR e_src[v_j] <> e_src[v_j - 1] THEN v_left := GREATEST(n_rem[e_src[v_j]], 0); END IF;
      e_t[v_j] := LEAST(e_amt[v_j], v_left);
      v_left := v_left - e_t[v_j];
      n_out[e_src[v_j]] := n_out[e_src[v_j]] + e_t[v_j];
    END LOOP;
    -- (2) Sức chuyển ngược của từng cạnh tới hoá đơn trong S: nguồn trong S nhận đủ t; nguồn ngoài S chỉ
    --     chuyển tiếp tới mức các cạnh vào nó chuyển được (dùng chung cho các hoá đơn gánh của nó).
    FOR v_j IN 1..v_m LOOP
      IF n_set[e_src[v_j]] THEN
        e_cap[v_j] := e_t[v_j];
      ELSE
        e_cap[v_j] := LEAST(e_t[v_j], n_pool[e_src[v_j]]);
        n_pool[e_src[v_j]] := n_pool[e_src[v_j]] - e_cap[v_j];
      END IF;
      n_pool[e_car[v_j]] := n_pool[e_car[v_j]] + e_cap[v_j];
    END LOOP;
    FOR v_p IN 1..v_m LOOP
      v_j := e_by_car[v_p];
      IF n_first[e_car[v_j]] IS NULL THEN n_first[e_car[v_j]] := v_p; END IF;
      n_last[e_car[v_j]] := v_p;
    END LOOP;
    -- (3) Từ hoá đơn mới nhất về cũ nhất: hoá đơn gánh trả phần kéo về nguồn (nguồn cũ nhất trước), tối đa
    --     phần còn giữ; hoá đơn ngoài S chỉ chuyển tiếp đúng phần nhận về.
    FOR v_i IN REVERSE v_n..1 LOOP
      v_h := n_rem[v_i] - n_out[v_i] + n_back[v_i];
      v_budget := CASE WHEN n_set[v_i] THEN GREATEST(v_h, 0) ELSE n_back[v_i] END;
      IF n_first[v_i] IS NOT NULL THEN
        FOR v_p IN n_first[v_i]..n_last[v_i] LOOP
          v_j := e_by_car[v_p];
          e_k[v_j] := LEAST(e_cap[v_j], v_budget);
          v_budget := v_budget - e_k[v_j];
          n_in[v_i] := n_in[v_i] + e_k[v_j];
          n_back[e_src[v_j]] := n_back[e_src[v_j]] + e_k[v_j];
        END LOOP;
      END IF;
      n_eff[v_i] := v_h - n_in[v_i];
    END LOOP;
  END IF;

  RETURN QUERY
  SELECT inv.id,
         COALESCE(inv.remaining_amount, 0)::numeric,
         COALESCE(n_out[u.idx::int], 0::numeric),
         COALESCE(n_in[u.idx::int], 0::numeric),
         COALESCE(n_eff[u.idx::int], COALESCE(inv.remaining_amount, 0)::numeric),
         COALESCE(inv.remaining_amount, 0)::numeric - COALESCE(n_out[u.idx::int], 0::numeric)
    FROM public.invoices inv
    LEFT JOIN unnest(n_id) WITH ORDINALITY AS u(id, idx) ON u.id = inv.id
   WHERE inv.id = ANY (v_ids);
END
$fn$;

COMMENT ON FUNCTION public.invoice_effective_outstanding_v1(uuid[]) IS
  'Nợ thực khi cộng tập hoá đơn p_invoice_ids: phần nợ đã kéo (previous_debt_sources) sang hoá đơn gánh chưa trả '
  'xong/chưa huỷ, cùng công ty, tạo sau, mà nợ của nó cũng nằm trong tập (trực tiếp hoặc bắc cầu) chỉ tính MỘT lần, '
  'ở hoá đơn phát sinh gốc (effective_outstanding — tuổi nợ theo kỳ gốc; tiền thu vào hoá đơn gánh trả phần mới '
  'trước). effective_outstanding_at_carrier = remaining − carried_out_amount: cùng tổng, dồn về hoá đơn gánh. '
  'Gánh PAID không là cạnh (recompute đã suy vào paid_amount). INVOKER: RLS người gọi; hàm DEFINER gọi cho tập id '
  'đã cấp quyền.';

ALTER FUNCTION public.invoice_effective_outstanding_v1(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoice_effective_outstanding_v1(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_effective_outstanding_v1(uuid[]) TO authenticated, service_role;

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
  'Thẻ thống kê hoá đơn dùng chung — công thức get_invoice_statistics_v2 trên cùng tập hoá đơn với invoice_list_v1 (INVOKER + RLS + invoices.view thật, không theo staff_assignments). total_remaining = Σ nợ thực của tập (invoice_effective_outstanding_v1: không đếm hai lần phần đã kéo sang hoá đơn gánh cùng tập). p_building_ids chỉ thu hẹp: NULL = toàn phạm vi, ''{}'' = rỗng.';

ALTER FUNCTION public.invoice_statistics_v3(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invoice_statistics_v3(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_statistics_v3(text, public.invoice_status, text, uuid[], uuid[], date, date, uuid[])
  TO authenticated;

NOTIFY pgrst, 'reload schema';
