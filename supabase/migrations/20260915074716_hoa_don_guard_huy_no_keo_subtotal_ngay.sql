-- =============================================================================
-- Rà soát toàn hệ thống 15/09/2026 — plan con H1 (hoá đơn).
-- docs/plans/ra-soat-2026-09-15/H1.md, mục 1-7.
--
-- BẢY LỖ ĐƯỢC VÁ (mỗi mục có chú thích "H1.x" ngay tại chỗ sửa trong thân hàm)
--   H1.1  cancel_invoice_v1 / cancel_invoice_with_credit_v1 không kiểm
--         status/paid_amount ở DB — client là hàng rào duy nhất.
--   H1.2  previous_debt_sources không kiểm org/hợp đồng: một hoá đơn ở TỔ CHỨC
--         KHÁC có thể khai "trả hộ" hoá đơn của mình rồi đẩy nó thành PAID.
--   H1.3  create/update_invoice_v1 tin p_subtotal client thay vì cộng lại p_items.
--   H1.4  record_invoice_collection_v5 nhận ngày thu ở tương lai.
--   H1.5  PARTIAL_PAID không bao giờ tới được khi đã quá hạn (nhánh OVERDUE
--         đứng trước) — đổi thứ tự, thêm cột suy public.is_overdue cho báo cáo.
--   H1.6  guard LIFO của reverse_invoice_collection_v5 so nhầm paid_amount (đã
--         gồm nợ kéo suy ra) với ảnh chụp lúc thu.
--   H1.7  nhánh xoá nợ lẻ <10.000đ không ghi rounding_amount (khoanh theo mốc
--         ngày); generate_invoice_number_v2 lấy năm theo NOW() UTC;
--         recompute gọi org_today_v1(NULL); record_invoice_payment_v3 còn
--         quyền authenticated.
--
-- NGUỒN: mọi hàm thay thế đều chép từ pg_get_functiondef của PRODUCTION lấy
-- ngày 15/09/2026, rồi vá đúng những dòng ghi ở trên. md5 bản gốc:
--   cancel_invoice_v1              088563b6ba4d8e06c879a0c070a0dffc
--   cancel_invoice_with_credit_v1  6507cd79c9b0135f9789d63b4fdbd3bf
--   create_invoice_v1              6545b33eae9919b5249dbd505e60be2a
--   update_invoice_v1              9ddc3b16ca488c1c1bad8210a95ae851
--   recompute_invoice_for_id       337a22cbb75a13f3f69e92b07811d0ba
--   record_invoice_collection_v5   8aecfbec6195d8813cf6b359d888e6a1
--   reverse_invoice_collection_v5  105bc40a21b003fd96e711e55857221f
--   generate_invoice_number_v2     ed1e97c22bc766e26131c3d4bc755756
--
-- KHÔNG ĐỔI CHỮ KÝ hàm nào ⇒ CREATE OR REPLACE là đủ, không DROP, không đẻ
-- overload. ACL được giữ khi REPLACE nhưng vẫn khẳng định lại để không phụ
-- thuộc trạng thái trước.
--
-- BACKFILL: KHÔNG CẦN. Đọc production 15/09 trước khi viết file này:
--   24 dòng previous_debt_sources kiểu 'invoice' trên toàn hệ thống,
--   0 dòng trỏ sang tổ chức khác, 0 dòng trỏ sang hợp đồng khác,
--   0 dòng trỏ vào hoá đơn không tồn tại.
--   7 dòng có amount lớn hơn nợ CÒN LẠI HIỆN NAY của hoá đơn nguồn — đó là
--   hành vi ĐÚNG (amount là ảnh chụp lúc phát hành, nguồn được trả bớt sau đó)
--   và recompute vẫn cap lại; luật mới chỉ chặn lúc GHI, không truy ngược.
--
-- IDEMPOTENT: chạy hai lần cho cùng kết quả (CREATE OR REPLACE + DO ... IF).
--
-- HỆ QUẢ CẦN BIẾT — 20260912091403_invoice_domain_conflicts_http409.sql có một
-- tiền điều kiện md5 trên `record_invoice_collection_v5`. File này thay thân hàm
-- đó, nên md5 đổi và việc ÁP LẠI 20260912091403 SAU file này sẽ bị từ chối với
-- 55000 'Invoice conflict function changed'. Đó là thiết kế của cái bẫy ấy
-- (không cho một migration cũ đè lên writer mới hơn) và không ảnh hưởng gì khi
-- migration chạy đúng thứ tự thời gian — dry-run trên production 15/09 xanh.
-- Ai cần diễn lại cặp này trong test thì dựng lại bản đã capture trước, xem
-- src/lib/__tests__/invoiceAdjustmentV2.test.ts.
-- =============================================================================


-- ═══ 1. HAI BỘ DẪN XUẤT DÙNG CHUNG ═══════════════════════════════════════════
--
-- Cả recompute_invoice_for_id lẫn guard LIFO của reverse_invoice_collection_v5
-- đều cần trả lời "hoá đơn này đã thu THỰC SỰ bao nhiêu". Trước bản này chỉ có
-- một chỗ biết công thức (recompute), còn reverse thì đọc invoices.paid_amount —
-- một con số ĐÃ CỘNG phần nợ kéo suy ra. Tách ra hai hàm để hai nơi không thể
-- lệch nhau nữa.
--
-- STABLE và KHÔNG khoá dòng: cả hai được gọi từ trong hàm VOLATILE đã khoá sẵn
-- hoá đơn, và chúng chỉ đọc. (Án lệ 25006: hàm STABLE có SELECT ... FOR SHARE
-- nổ khi PostgREST chạy nó trong transaction READ ONLY — xem
-- scripts/check-stable-fn-locks.mjs.)

CREATE OR REPLACE FUNCTION app_private.invoice_direct_paid_v1(p_invoice_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  -- Chép NGUYÊN ba khoản của recompute_invoice_for_id, theo đúng thứ tự:
  --   + payments chưa bị đảo
  --   − "tiền thối" của writer legacy (V5 chỉ lưu phần đã áp, nên chỉ trừ
  --     phiếu KHÔNG gắn payment_collection_id)
  --   − phần hoàn trả thanh lý
  SELECT COALESCE((
           SELECT sum(payment_row.amount) FROM public.payments payment_row
            WHERE payment_row.invoice_id = p_invoice_id
              AND payment_row.reversed_at IS NULL), 0)
       - COALESCE((
           SELECT sum(COALESCE(item.amount, item.unit_price * item.quantity))
             FROM public.income_expenses voucher
             JOIN public.income_expense_items item
               ON item.income_expense_id = voucher.id
             JOIN public.income_expense_types type_row
               ON type_row.id = item.income_expense_type_id
            WHERE voucher.invoice_id = p_invoice_id
              AND voucher.payment_collection_id IS NULL
              AND voucher.type = 'EXPENSE'
              AND voucher.approval_status = 'APPROVED'
              AND voucher.deleted_at IS NULL
              AND lower(btrim(type_row.name)) = 'tiền thối'), 0)
       - COALESCE((
           SELECT sum(voucher.total_amount) FROM public.income_expenses voucher
            WHERE voucher.invoice_id = p_invoice_id
              AND voucher.type = 'EXPENSE'
              AND voucher.approval_status = 'APPROVED'
              AND voucher.deleted_at IS NULL
              AND voucher.notes LIKE '[Hoàn trả thanh lý]%'), 0);
$function$;

REVOKE ALL ON FUNCTION app_private.invoice_direct_paid_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.invoice_direct_paid_v1(uuid) IS
  'Số tiền hoá đơn đã thu TRỰC TIẾP (payments − tiền thối legacy − hoàn trả '
  'thanh lý). KHÔNG gồm phần nợ được hoá đơn sau gánh hộ — phần đó ở '
  'invoice_carried_debt_v1. invoices.paid_amount là TỔNG của hai phần.';

CREATE OR REPLACE FUNCTION app_private.invoice_carried_debt_v1(p_invoice_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT CASE
    -- Hoá đơn đã huỷ không được cộng nợ (recompute cũng return sớm trước nhánh
    -- này): cộng vào sẽ đẩy paid_amount vượt total và đẻ ra "thu thừa" ảo.
    WHEN inv.status = 'CANCELLED'::public.invoice_status THEN 0::numeric
    ELSE LEAST(
      COALESCE((
        SELECT sum((src->>'amount')::numeric)
          FROM public.invoices carrier
          CROSS JOIN LATERAL jsonb_array_elements(carrier.previous_debt_sources) AS src
         WHERE carrier.deleted_at IS NULL
           AND carrier.status = 'PAID'
           AND carrier.id <> inv.id
           -- H1.2: PREDICATE BIÊN GIỚI. Không có dòng này thì một hoá đơn ở tổ
           -- chức KHÁC chỉ cần khai previous_debt_sources trỏ vào hoá đơn của
           -- mình rồi tự trả nó là đủ đẩy hoá đơn nạn nhân thành PAID — không
           -- cần quyền gì trên tổ chức nạn nhân. Đã đọc production 15/09:
           -- chưa dòng nào lệch, nên đây là rào chắn, không phải dọn dẹp.
           AND carrier.organization_id = inv.organization_id
           AND jsonb_typeof(carrier.previous_debt_sources) = 'array'
           AND src->>'type' = 'invoice'
           AND NULLIF(src->>'id', '') IS NOT NULL
           AND (src->>'id')::uuid = inv.id
      ), 0),
      -- CHẶN TRÊN bắt buộc: amount là ảnh chụp dư nợ lúc phát hành hoá đơn
      -- gánh. Khách trả thêm trực tiếp vào hoá đơn nguồn sau đó thì cộng thẳng
      -- sẽ vượt total và tạo hoàn tiền ảo. Phần suy ra chỉ được LẤP ĐẦY khoảng
      -- thiếu. COALESCE là load-bearing: LEAST(NULL, gap) trong Postgres trả gap.
      GREATEST(inv.total_amount - app_private.invoice_direct_paid_v1(inv.id), 0)
    )
  END
  FROM public.invoices inv
 WHERE inv.id = p_invoice_id;
$function$;

REVOKE ALL ON FUNCTION app_private.invoice_carried_debt_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.invoice_carried_debt_v1(uuid) IS
  'Phần nợ của hoá đơn này đã được một hoá đơn SAU (cùng tổ chức) gánh hộ và '
  'trả xong, cap theo dư nợ còn lại. Nguồn sự thật dùng chung cho '
  'recompute_invoice_for_id và guard LIFO của reverse_invoice_collection_v5.';

-- ═══ 2. NGUỒN NỢ CŨ PHẢI CÙNG TỔ CHỨC VÀ CÙNG HỢP ĐỒNG (H1.2) ════════════════

CREATE OR REPLACE FUNCTION app_private.assert_previous_debt_sources_v1(
  p_organization_id uuid,
  p_contract_id uuid,
  p_carrier_invoice_id uuid,
  p_sources jsonb
)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_src record;
  v_nguon public.invoices%ROWTYPE;
  v_con_lai numeric(15,2);
BEGIN
  IF p_sources IS NULL THEN
    RETURN;
  END IF;
  IF jsonb_typeof(p_sources) <> 'array' THEN
    RAISE EXCEPTION 'previous_debt_sources phải là JSON array' USING ERRCODE = '22023';
  END IF;

  FOR v_src IN
    SELECT element->>'type' AS kind,
           NULLIF(element->>'id', '') AS raw_id,
           element->>'amount' AS raw_amount
      FROM jsonb_array_elements(p_sources) AS element
  LOOP
    -- Chỉ nguồn kiểu 'invoice' mới truy được sang bảng hoá đơn; các kiểu khác
    -- (nếu sau này có) do writer của chúng tự kiểm.
    CONTINUE WHEN v_src.kind IS DISTINCT FROM 'invoice';

    IF v_src.raw_id IS NULL THEN
      RAISE EXCEPTION 'Nguồn nợ cũ thiếu id hoá đơn' USING ERRCODE = '22023';
    END IF;
    IF p_carrier_invoice_id IS NOT NULL
       AND v_src.raw_id::uuid = p_carrier_invoice_id THEN
      RAISE EXCEPTION 'Hoá đơn không thể tự gánh nợ của chính nó' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_nguon FROM public.invoices
     WHERE id = v_src.raw_id::uuid AND deleted_at IS NULL;
    IF NOT FOUND
       OR v_nguon.organization_id IS DISTINCT FROM p_organization_id THEN
      RAISE EXCEPTION 'Nguồn nợ cũ không thuộc tổ chức này' USING ERRCODE = '42501';
    END IF;
    IF v_nguon.contract_id IS DISTINCT FROM p_contract_id THEN
      RAISE EXCEPTION 'Nguồn nợ cũ không thuộc hợp đồng của hoá đơn này'
        USING ERRCODE = '42501';
    END IF;

    IF v_src.raw_amount IS NULL
       OR v_src.raw_amount::numeric IS NULL
       OR v_src.raw_amount::numeric <= 0 THEN
      RAISE EXCEPTION 'Số tiền nợ cũ phải dương' USING ERRCODE = '22023';
    END IF;
    -- CAP theo nợ CÒN LẠI lúc phát hành. Không có cap thì một hoá đơn gánh có
    -- thể khai số lớn hơn nợ thật, và khi nó được trả xong, recompute cộng phần
    -- suy ra vào hoá đơn nguồn — cap ở recompute chặn được tổng, nhưng con số
    -- sai vẫn nằm trong sổ và mọi báo cáo đọc previous_debt_sources đều lệch.
    v_con_lai := GREATEST(
      COALESCE(v_nguon.total_amount, 0) - COALESCE(v_nguon.paid_amount, 0), 0);
    IF v_src.raw_amount::numeric - v_con_lai >= 0.01 THEN
      RAISE EXCEPTION
        'Nợ cũ khai % vượt dư nợ còn lại % của hoá đơn nguồn',
        v_src.raw_amount::numeric, v_con_lai
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.assert_previous_debt_sources_v1(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- ═══ 3. recompute_invoice_for_id — thứ tự trạng thái, ngày theo org (H1.2/5/7) ═

CREATE OR REPLACE FUNCTION public.recompute_invoice_for_id(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric(15,2);
  v_paid numeric(15,2);
  v_rounding numeric(15,2);
  v_legacy_rounding numeric(15,2);
  v_has_v5_payment boolean;
  v_existing_status public.invoice_status;
  v_status public.invoice_status;
  v_paid_date date;
  v_due_date date;
  v_org uuid;
  v_created_at timestamptz;
  v_carried numeric(15,2);
  -- H1.7: mốc bật writer thu tiền V5 (migration 20260721100000, giờ VN). Hoá
  -- đơn phát hành TỪ mốc này trở đi luôn được thu qua V5, nơi phần lẻ được ghi
  -- tử tế vào rounding_amount. Nhánh "xoá nợ lẻ <10.000đ" bên dưới là di sản
  -- của writer cũ và không ghi rounding_amount ở đâu cả — tiền biến mất khỏi
  -- sổ mà không có bút toán. Khoanh nó lại cho đúng phần lịch sử nó sinh ra.
  c_moc_v5 constant timestamptz := timestamptz '2026-07-21 00:00:00+07';
BEGIN
  IF p_invoice_id IS NULL THEN
    RETURN;
  END IF;

  SELECT total_amount, status, due_date, organization_id, created_at
    INTO v_total, v_existing_status, v_due_date, v_org, v_created_at
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Số đã thu TRỰC TIẾP: một công thức, một chỗ (xem invoice_direct_paid_v1).
  v_paid := app_private.invoice_direct_paid_v1(p_invoice_id);

  SELECT max(payment_date),
         COALESCE(sum(rounding_amount), 0),
         COALESCE(bool_or(collection_id IS NOT NULL), false)
    INTO v_paid_date, v_rounding, v_has_v5_payment
  FROM public.payments
  WHERE invoice_id = p_invoice_id
    AND reversed_at IS NULL;

  SELECT COALESCE(sum(voucher.rounding_amount), 0)
    INTO v_legacy_rounding
  FROM public.income_expenses voucher
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.payment_collection_id IS NULL
    AND voucher.type = 'INCOME'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL;

  v_rounding := v_rounding + v_legacy_rounding;

  IF v_existing_status = 'CANCELLED' THEN
    UPDATE public.invoices
       SET paid_amount = v_paid
     WHERE id = p_invoice_id;
    RETURN;
  END IF;

  -- [B1] Phần công nợ đã được hoá đơn SAU gánh hộ (previous_debt_sources).
  -- settle_previous_debt_sources từng ghi THẲNG paid_amount lên hoá đơn nguồn
  -- mà không tạo dòng payments; hàm này lại DẪN XUẤT paid_amount từ payments,
  -- nên mỗi lần recompute chạy lại là khoản nợ đã trả song đôi. Nay suy ra tại
  -- chỗ: nguồn sự thật duy nhất vẫn là hàm này.
  --
  -- Đặt SAU nhánh CANCELLED — xem chú thích trong invoice_carried_debt_v1.
  v_carried := app_private.invoice_carried_debt_v1(p_invoice_id);
  v_paid := v_paid + v_carried;

  IF v_total > 0 THEN
    IF v_paid >= v_total OR v_paid + v_rounding >= v_total
       OR (
         -- H1.7: chỉ còn áp cho hoá đơn phát hành TRƯỚC mốc V5.
         v_created_at < c_moc_v5
         AND NOT v_has_v5_payment
         AND v_paid > 0
         AND v_total - v_paid > 0
         AND v_total - v_paid < 10000
       ) THEN
      v_status := 'PAID';
    -- H1.5: PARTIAL_PAID phải đứng TRƯỚC OVERDUE.
    -- Bản cũ để "v_paid > 0 AND quá hạn ⇒ OVERDUE" lên đầu, nên hoá đơn đã thu
    -- một phần mà quá hạn KHÔNG BAO GIỜ đạt được PARTIAL_PAID: nhìn vào sổ thì
    -- nó giống hệt hoá đơn chưa trả đồng nào. Giữ nguyên việc GHI XUỐNG trạng
    -- thái (đọc/ghi quanh cột status đã dựa vào đó), chỉ đổi thứ tự; phần "quá
    -- hạn" của hoá đơn đã thu một phần nay đọc bằng cột suy public.is_overdue.
    ELSIF v_paid > 0 THEN
      v_status := 'PARTIAL_PAID';
      v_paid_date := NULL;
    ELSIF v_due_date < public.org_today_v1(v_org) THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSE
      v_status := 'APPROVED';
      v_paid_date := NULL;
    END IF;
  ELSIF v_total < 0 THEN
    IF v_paid <= v_total THEN
      v_status := 'PAID';
    ELSIF v_paid < 0 THEN
      v_status := 'PARTIAL_PAID';
      v_paid_date := NULL;
    ELSIF v_due_date < public.org_today_v1(v_org) THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSE
      v_status := 'APPROVED';
      v_paid_date := NULL;
    END IF;
  ELSE
    v_status := CASE
      WHEN v_paid <> 0 THEN 'PAID'::public.invoice_status
      ELSE 'APPROVED'::public.invoice_status
    END;
    IF v_paid = 0 THEN
      v_paid_date := NULL;
    END IF;
  END IF;

  UPDATE public.invoices
     SET paid_amount = v_paid,
         status = v_status,
         paid_date = v_paid_date,
         updated_at = now()
   WHERE id = p_invoice_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.recompute_invoice_for_id(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_invoice_for_id(uuid) TO service_role;

-- ═══ 3b. CỘT SUY is_overdue (H1.5) ═══════════════════════════════════════════
--
-- "Quá hạn" phụ thuộc NGÀY HÔM NAY nên không thể là cột GENERATED (Postgres đòi
-- biểu thức IMMUTABLE) và cũng không thể là cột thường có trigger (trigger chỉ
-- chạy khi hàng đổi, còn hôm nay thì tự trôi). Cách duy nhất đúng là suy ở LỚP
-- ĐỌC — và PostgREST có sẵn cơ chế "computed column": một hàm nhận nguyên hàng
-- của bảng thì đọc được như một cột, `?select=*,is_overdue`.
--
-- SECURITY INVOKER (mặc định): hàm chỉ đọc lại chính hàng mà người gọi đã được
-- RLS cho phép thấy, không mở thêm cửa nào.

CREATE OR REPLACE FUNCTION public.is_overdue(public.invoices)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT $1.due_date IS NOT NULL
     AND $1.deleted_at IS NULL
     AND $1.status NOT IN ('PAID'::public.invoice_status, 'CANCELLED'::public.invoice_status)
     AND COALESCE($1.paid_amount, 0) < COALESCE($1.total_amount, 0)
     AND $1.due_date < public.org_today_v1($1.organization_id);
$function$;

REVOKE ALL ON FUNCTION public.is_overdue(public.invoices) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_overdue(public.invoices) TO authenticated, service_role;

COMMENT ON FUNCTION public.is_overdue(public.invoices) IS
  'Cột suy cho PostgREST (?select=*,is_overdue): hoá đơn quá hạn mà chưa trả đủ. '
  'Từ 15/09/2026 status OVERDUE chỉ còn ghi khi CHƯA thu đồng nào, nên báo cáo '
  'muốn đếm đủ hoá đơn quá hạn phải đọc cột này thay vì lọc status=OVERDUE.';


-- ═══ 4. HAI ĐƯỜNG HUỶ HOÁ ĐƠN — hàng rào status/paid_amount (H1.1) ═══════════

CREATE OR REPLACE FUNCTION public.cancel_invoice_v1(p_invoice_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice public.invoices%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
    AND invoice_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.can_edit_invoice_building_v1(v_invoice.building_id) THEN
    RAISE EXCEPTION 'Missing permission to cancel invoice'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.customer_credit_applications application_row
    WHERE application_row.invoice_id = p_invoice_id
  ) THEN
    RAISE EXCEPTION 'Use cancel_invoice_with_credit_v1 for this invoice'
      USING ERRCODE = '55000';
  END IF;
  PERFORM app_private.assert_invoice_credit_cancellable_v1(p_invoice_id);
  IF v_invoice.status = 'CANCELLED' THEN
    RETURN v_invoice;
  END IF;
  -- H1.1 (rà soát 15/09): hàng rào status/paid_amount phải nằm Ở ĐÂY.
  -- Trước bản này, `canCancelInvoice` bên client là hàng rào DUY NHẤT: gọi thẳng
  -- PostgREST là huỷ được hoá đơn đã thu tiền, và restore sau đó trả về APPROVED
  -- thay vì PARTIAL_PAID — số đã thu vẫn còn nhưng trạng thái nói ngược lại.
  -- Cùng một luật với soft_delete_invoice_with_credit_v1 đã có sẵn ngay dưới.
  -- Super admin KHÔNG đi đường này: họ có super_admin_force_cancel_invoice_with_credit_v1
  -- (hàm đó tự kiểm payment và unwind credit trước khi huỷ).
  IF v_invoice.status NOT IN ('DRAFT', 'APPROVED')
     OR COALESCE(v_invoice.paid_amount, 0) <> 0 THEN
    RAISE EXCEPTION
      'Không thể huỷ hoá đơn ở trạng thái này (chỉ huỷ được hoá đơn nháp/đã duyệt và chưa thu đồng nào)';
  END IF;
  UPDATE public.invoices
     SET status = 'CANCELLED'
   WHERE id = p_invoice_id
   RETURNING * INTO v_invoice;
  RETURN v_invoice;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_invoice_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_invoice_v1(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cancel_invoice_with_credit_v1(p_invoice_id uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_contract_id uuid;
  v_invoice public.invoices%ROWTYPE;
  v_credit jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;

  SELECT invoice_row.contract_id INTO v_contract_id
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id;
  IF v_contract_id IS NOT NULL THEN
    PERFORM 1 FROM public.contracts contract_row
    WHERE contract_row.id = v_contract_id FOR UPDATE;
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
    AND invoice_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = '42501';
  END IF;
  IF NOT app_private.can_edit_invoice_building_v1(v_invoice.building_id) THEN
    RAISE EXCEPTION 'Missing permission to cancel invoice'
      USING ERRCODE = '42501';
  END IF;
  IF v_invoice.status = 'CANCELLED' THEN
    RETURN jsonb_build_object(
      'invoice', to_jsonb(v_invoice),
      'credit', NULL,
      'noop', true
    );
  END IF;
  -- H1.1 (rà soát 15/09): hàng rào status/paid_amount phải nằm Ở ĐÂY.
  -- Trước bản này, `canCancelInvoice` bên client là hàng rào DUY NHẤT: gọi thẳng
  -- PostgREST là huỷ được hoá đơn đã thu tiền, và restore sau đó trả về APPROVED
  -- thay vì PARTIAL_PAID — số đã thu vẫn còn nhưng trạng thái nói ngược lại.
  -- Cùng một luật với soft_delete_invoice_with_credit_v1 đã có sẵn ngay dưới.
  -- Super admin KHÔNG đi đường này: họ có super_admin_force_cancel_invoice_with_credit_v1
  -- (hàm đó tự kiểm payment và unwind credit trước khi huỷ).
  IF v_invoice.status NOT IN ('DRAFT', 'APPROVED')
     OR COALESCE(v_invoice.paid_amount, 0) <> 0 THEN
    RAISE EXCEPTION
      'Không thể huỷ hoá đơn ở trạng thái này (chỉ huỷ được hoá đơn nháp/đã duyệt và chưa thu đồng nào)';
  END IF;

  PERFORM app_private.assert_invoice_credit_cancellable_v1(p_invoice_id);
  v_credit := app_private.reverse_invoice_customer_credit_v1(
    v_actor, p_invoice_id, 'Cancel invoice and restore applied customer credit', v_key
  );

  PERFORM app_private.begin_accounting_chain_write_v1();
  UPDATE public.invoices
     SET status = 'CANCELLED'
   WHERE id = p_invoice_id
   RETURNING * INTO v_invoice;
  PERFORM app_private.end_accounting_chain_write_v1();

  RETURN jsonb_build_object(
    'invoice', to_jsonb(v_invoice),
    'credit', v_credit,
    'noop', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_invoice_with_credit_v1(uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_invoice_with_credit_v1(uuid, text) TO authenticated;

-- ═══ 5. HAI WRITER HOÁ ĐƠN — re-sum p_items + kiểm nguồn nợ cũ (H1.2, H1.3) ══

CREATE OR REPLACE FUNCTION public.create_invoice_v1(p_contract_id uuid, p_building_id uuid, p_room_id uuid, p_billing_month text, p_issue_date date, p_due_date date, p_kind text, p_subtotal numeric, p_discount_amount numeric, p_total_amount numeric, p_previous_debt numeric, p_items jsonb, p_idempotency_key text, p_prepaid_amount numeric DEFAULT 0, p_discount_notes text DEFAULT NULL::text, p_electricity_prev_overridden boolean DEFAULT false, p_previous_debt_sources jsonb DEFAULT '[]'::jsonb, p_template_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_applied_credit numeric DEFAULT 0, p_creator_name text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_authz boolean;
  v_auto boolean;
  v_status text;
  v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  v_invoice uuid;
  v_invoice_number text;
  v_resp json;
  it jsonb; v_idx int := 0;
  v_total_calc numeric(15,2);
  v_items_sum numeric(15,2);
  v_applied numeric(15,2);
  c_op constant text := 'invoice.create.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_total_amount is null or p_total_amount < 0 then raise exception 'Tổng tiền không hợp lệ'; end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items phải là JSON array'; end if;

  FOR it IN SELECT value FROM jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) LOOP
    IF jsonb_typeof(it) IS DISTINCT FROM 'object' OR
       (it ? 'accounting_class' AND ((it->>'accounting_class') IS NULL OR
        (it->>'accounting_class') NOT IN ('REVENUE','DEPOSIT','NON_PNL'))) THEN
      RAISE EXCEPTION 'accounting_class không hợp lệ' USING ERRCODE='22023';
    END IF;
  END LOOP;

  -- derive + lock: building → org; contract same-org; room same-building/org.
  select b.organization_id into v_org from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.id=p_building_id and b.deleted_at is null for share of o,b;
  if not found or v_org is null then
    raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;
  -- contracts link to a building via their room, not a direct building_id column.
  perform 1 from public.contracts c where c.id=p_contract_id and c.deleted_at is null
    and c.organization_id=v_org for share;
  if not found then raise exception 'Hợp đồng không thuộc tổ chức' using errcode='42501'; end if;
  if p_room_id is not null then
    perform 1 from public.rooms r where r.id=p_room_id and r.deleted_at is null
      and r.building_id=p_building_id and r.organization_id=v_org for share;
    if not found then raise exception 'Phòng không thuộc toà/tổ chức' using errcode='42501'; end if;
  end if;
  -- H1.2 (rà soát 15/09): nguồn nợ cũ phải cùng tổ chức VÀ cùng hợp đồng.
  PERFORM app_private.assert_previous_debt_sources_v1(
    v_org, p_contract_id, NULL::uuid, p_previous_debt_sources);

  -- exact permission invoices.create, building-scoped.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'invoices.create', p_building_id, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền tạo hoá đơn (invoices.create)' using errcode='42501'; end if;

  -- server decides APPROVED vs DRAFT from org settings; missing row = abort.
  select auto_approve_invoice into v_auto from public.organization_invoice_settings
   where organization_id = v_org;
  if v_auto is null then
    raise exception 'Thiếu cấu hình auto_approve_invoice cho tổ chức' using errcode='55000'; end if;
  v_status := case when v_auto then 'APPROVED' else 'DRAFT' end;

  v_hash := md5(jsonb_build_object('contract',p_contract_id,'month',p_billing_month,
    'total',p_total_amount,'org',v_org)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_contract_id::text || '|' || p_billing_month, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op
     and o.subject_scope=p_contract_id::text || '|' || p_billing_month
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then
    raise exception 'Writer hoá đơn chưa bật cho tổ chức này' using errcode='55000'; end if;

  -- ---- PARITY: làm tròn server mirror roundInvoiceTotal + ASSERT khớp total ----
  -- total = round(p_subtotal − discount + nợ cũ) TRÊN SUBTOTAL CLIENT GỬI (KHÔNG
  -- re-sum items — giữ giả định item-shape của mọi caller, gồm create_contract_v1).
  -- KHÔNG clamp ≥0 (mirror useCreateInvoice; KHÁC clamp hiển thị Math.max(0,…) của
  -- GenerateInvoiceDialog). Guard p_total_amount<0 ở trên vẫn chặn tổng âm.
  -- H1.3 (rà soát 15/09): SERVER tự cộng lại p_items thay vì tin p_subtotal.
  -- Phép đối chiếu tổng bên dưới chỉ so p_total_amount với round(subtotal − giảm
  -- trừ + nợ cũ) — cả ba vế đều do client gửi, nên một client sửa được p_subtotal
  -- thì sửa luôn tổng cho khớp và hoá đơn ghi xuống ít hơn số hạng mục thật.
  -- Công thức COALESCE ở đây chép ĐÚNG công thức ghi invoice_items bên dưới (amount
  -- client gửi, vắng thì đơn giá × số lượng × hệ số) để không có hạng mục nào
  -- được cộng theo một luật khác với lúc nó được lưu.
  -- Ngưỡng 0.01: client là JavaScript double, server là numeric.
  SELECT COALESCE(sum(
           COALESCE((value->>'amount')::numeric,
                    COALESCE((value->>'unit_price')::numeric, 0)
                    * COALESCE((value->>'quantity')::numeric, 1)
                    * COALESCE((value->>'coefficient')::numeric, 1))), 0)
    INTO v_items_sum
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb));
  IF abs(v_items_sum - COALESCE(p_subtotal, 0)) >= 0.01 THEN
    RAISE EXCEPTION
      'Tạm tính client (%) khác tổng hạng mục server cộng lại (%)',
      COALESCE(p_subtotal, 0), v_items_sum;
  END IF;

  v_total_calc := app_private.round_invoice_total_v1(
    coalesce(p_subtotal,0) - coalesce(p_discount_amount,0) + coalesce(p_previous_debt,0));

  if v_total_calc is distinct from p_total_amount then
    raise exception
      'Tổng tiền client (%) khác tổng server làm tròn (%) [subtotal=%, discount=%, nợ cũ=%]',
      p_total_amount, v_total_calc, coalesce(p_subtotal,0),
      coalesce(p_discount_amount,0), coalesce(p_previous_debt,0)
      using errcode='22000';
  end if;

  -- create the invoice; the live partial-unique (contract_id, billing_month)
  -- WHERE deleted_at IS NULL AND status<>'CANCELLED' AND kind='MONTHLY'
  -- enforces one-per-period. invoice_number BỎ TRỐNG → trigger
  -- generate_invoice_number_v2 (BEFORE INSERT) tự sinh.
  insert into public.invoices
    (user_id, organization_id, contract_id, building_id, room_id, billing_month,
     issue_date, due_date, kind, status, subtotal, discount_amount, discount_notes,
     electricity_prev_overridden, total_amount, prepaid_amount, paid_amount,
     previous_debt, previous_debt_sources, notes, template_id, creator_name,
     approved_by, approved_at)
  values
    (v_actor, v_org, p_contract_id, p_building_id, p_room_id, p_billing_month,
     p_issue_date, p_due_date, coalesce(p_kind,'MONTHLY'), v_status::invoice_status,
     coalesce(p_subtotal,0), coalesce(p_discount_amount,0), p_discount_notes,
     coalesce(p_electricity_prev_overridden,false), p_total_amount,
     coalesce(p_prepaid_amount,0), 0,
     coalesce(p_previous_debt,0),
     coalesce(p_previous_debt_sources,'[]'::jsonb), p_notes, p_template_id,
     p_creator_name,
     case when v_auto then v_actor else null end,
     case when v_auto then now() else null end)
  returning id, invoice_number into v_invoice, v_invoice_number;

  -- ---- PARITY: bước tiêu credit (mirror useCreateInvoice:639-652) ----
  -- Áp credit vào Giảm trừ HĐ → ghi excess_amounts ÂM CÙNG TX. amount đã cộng vào
  -- discount_amount ở client nên KHÔNG trừ 2 lần; row âm chỉ hạ số dư credit HĐ.
  v_applied := coalesce(p_applied_credit,0);
  if v_applied > 0 and p_contract_id is not null then
    insert into public.excess_amounts
      (user_id, organization_id, contract_id, amount, description,
       source_invoice_id, source_payment_id)
    values
      (v_actor, v_org, p_contract_id, -v_applied,
       'Áp credit vào Giảm trừ HĐ ' || coalesce(v_invoice_number, v_invoice::text),
       v_invoice, null);
  end if;

  -- ---- PARITY: items whitelist 12 field client ----
  -- amount = amount client gửi (1 trong 12 field, giữ hành vi writer cũ), fallback
  -- tính unit_price*quantity*coefficient nếu vắng. sort_order lấy client, fallback
  -- thứ tự xuất hiện.
  if p_items is not null then
    for it in select value from jsonb_array_elements(p_items) loop
      v_idx := v_idx + 1;
      insert into public.invoice_items
        (invoice_id, organization_id, service_id, type, description, unit_price,
         quantity, coefficient, amount, previous_reading, current_reading,
         from_date, to_date, sort_order, accounting_class)
      values (
        v_invoice, v_org,
        nullif(it->>'service_id','')::uuid,
        coalesce(nullif(it->>'type','')::invoice_item_type, 'OTHER'::invoice_item_type),
        it->>'description',
        coalesce((it->>'unit_price')::numeric,0),
        coalesce((it->>'quantity')::numeric,1),
        coalesce((it->>'coefficient')::numeric,1),
        coalesce((it->>'amount')::numeric,
          coalesce((it->>'unit_price')::numeric,0)
          * coalesce((it->>'quantity')::numeric,1)
          * coalesce((it->>'coefficient')::numeric,1)),
        nullif(it->>'previous_reading','')::numeric,
        nullif(it->>'current_reading','')::numeric,
        nullif(it->>'from_date','')::date,
        nullif(it->>'to_date','')::date,
        coalesce((it->>'sort_order')::int, v_idx),
        coalesce(it->>'accounting_class','REVENUE')
      );
    end loop;
  end if;

  v_resp := json_build_object('invoice_id', v_invoice, 'status', v_status,
                              'invoice_number', v_invoice_number);
  update app_private.canonical_write_operations
     set subject_id=v_invoice, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op
     and subject_scope=p_contract_id::text || '|' || p_billing_month
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$;

REVOKE ALL ON FUNCTION public.create_invoice_v1(
  uuid, uuid, uuid, text, date, date, text, numeric, numeric, numeric, numeric,
  jsonb, text, numeric, text, boolean, jsonb, uuid, text, numeric, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_v1(
  uuid, uuid, uuid, text, date, date, text, numeric, numeric, numeric, numeric,
  jsonb, text, numeric, text, boolean, jsonb, uuid, text, numeric, text
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_invoice_v1(p_invoice_id uuid, p_contract_id uuid, p_building_id uuid, p_room_id uuid, p_billing_month text, p_issue_date date, p_due_date date, p_subtotal numeric, p_discount_amount numeric, p_total_amount numeric, p_previous_debt numeric, p_items jsonb, p_prepaid_amount numeric DEFAULT 0, p_discount_notes text DEFAULT NULL::text, p_electricity_prev_overridden boolean DEFAULT false, p_previous_debt_sources jsonb DEFAULT '[]'::jsonb, p_template_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
  v_org uuid;
  it jsonb; v_idx int := 0;
  v_total_calc numeric(15,2);
  v_items_sum numeric(15,2);
  v_normalized_items jsonb := '[]'::jsonb;
  v_class text;
  v_match uuid;
  v_matches integer;
  v_matched uuid[] := '{}'::uuid[];
  v_has_legacy boolean;
  v_has_deposit boolean;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items phải là JSON array'; end if;

  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode='42501'; end if;
  v_org := v_row.organization_id;

  -- SERVER mirror canEditInvoice: (DRAFT|APPROVED) AND paid_amount=0. Dùng errcode
  -- mặc định (P0001, KHÔNG fallback) → lỗi hiện thẳng như legacy hook, không rơi
  -- xuống đường legacy để lách guard.
  if v_row.status <> 'DRAFT'::invoice_status or v_row.adjustment_revision<>0
     or coalesce(v_row.paid_amount,0) <> 0 then
    raise exception 'Hóa đơn đã phát hành cần điều chỉnh qua phiên bản mới; vui lòng tải lại' using errcode='55000';
  end if;

  -- quyền edit theo toà HIỆN TẠI của hoá đơn.
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền chỉnh sửa hoá đơn này' using errcode='42501'; end if;

  -- Nếu ĐỔI toà → chặn cross-org + đòi quyền edit trên toà đích. (Đổi phòng cũng
  -- verify thuộc toà đích/cùng org, mirror ràng buộc create.)
  if p_building_id is distinct from v_row.building_id then
    perform 1 from public.buildings b
     where b.id=p_building_id and b.deleted_at is null and b.organization_id=v_org;
    if not found then
      raise exception 'Toà đích không thuộc tổ chức của hoá đơn' using errcode='42501'; end if;
    if not app_private.can_edit_invoice_building_v1(p_building_id) then
      raise exception 'Không có quyền chỉnh sửa sang toà này' using errcode='42501'; end if;
  end if;
  if p_room_id is not null then
    perform 1 from public.rooms r
     where r.id=p_room_id and r.deleted_at is null
       and r.building_id=p_building_id and r.organization_id=v_org;
    if not found then
      raise exception 'Phòng không thuộc toà/tổ chức' using errcode='42501'; end if;
  end if;
  -- H1.2 (rà soát 15/09): nguồn nợ cũ phải cùng tổ chức VÀ cùng hợp đồng.
  PERFORM app_private.assert_previous_debt_sources_v1(
    v_org, p_contract_id, p_invoice_id, p_previous_debt_sources);

  -- Validate classification BEFORE replacing rows. Item IDs identify only rows
  -- on this invoice; legacy clients can preserve a unique structural identity.
  SELECT EXISTS (SELECT 1 FROM public.invoice_items old
    WHERE old.invoice_id=p_invoice_id AND old.accounting_class='DEPOSIT') INTO v_has_deposit;
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) x
    WHERE NOT (x ? 'accounting_class')) INTO v_has_legacy;
  FOR it IN SELECT value FROM jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) LOOP
    IF jsonb_typeof(it) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Hạng mục phải là JSON object' USING ERRCODE='22023';
    END IF;
    v_match := NULL;
    IF nullif(it->>'id','') IS NOT NULL THEN
      SELECT old.id INTO v_match FROM public.invoice_items old
       WHERE old.id=(it->>'id')::uuid AND old.invoice_id=p_invoice_id;
      IF v_match IS NULL THEN
        RAISE EXCEPTION 'Hạng mục không thuộc hoá đơn' USING ERRCODE='42501';
      END IF;
    ELSE
      SELECT count(*), (array_agg(old.id))[1] INTO v_matches,v_match
        FROM public.invoice_items old
       WHERE old.invoice_id=p_invoice_id
         AND old.type=coalesce(nullif(it->>'type','')::invoice_item_type,'OTHER'::invoice_item_type)
         AND old.service_id IS NOT DISTINCT FROM nullif(it->>'service_id','')::uuid
         AND old.description IS NOT DISTINCT FROM it->>'description';
      IF v_matches <> 1 THEN v_match := NULL; END IF;
    END IF;
    IF it ? 'accounting_class' THEN
      v_class := it->>'accounting_class';
      IF v_class IS NULL OR v_class NOT IN ('REVENUE','DEPOSIT','NON_PNL') THEN
        RAISE EXCEPTION 'accounting_class không hợp lệ' USING ERRCODE='22023';
      END IF;
    ELSIF v_match IS NOT NULL AND NOT (v_match=ANY(v_matched)) THEN
      SELECT old.accounting_class INTO v_class FROM public.invoice_items old WHERE old.id=v_match;
    ELSIF v_has_deposit THEN
      RAISE EXCEPTION 'Không xác định duy nhất hạng mục cọc; vui lòng tải lại hoá đơn' USING ERRCODE='22023';
    ELSE
      v_class := 'REVENUE';
    END IF;
    IF v_match IS NOT NULL THEN v_matched := array_append(v_matched,v_match); END IF;
    v_normalized_items := v_normalized_items || jsonb_build_array(it || jsonb_build_object('accounting_class',v_class));
  END LOOP;
  IF (v_has_legacy OR p_items IS NULL OR p_items='[]'::jsonb) AND v_has_deposit
     AND EXISTS (SELECT 1 FROM public.invoice_items old WHERE old.invoice_id=p_invoice_id
       AND old.accounting_class='DEPOSIT' AND NOT (old.id=ANY(v_matched))) THEN
    RAISE EXCEPTION 'Thiếu phân loại hạng mục cọc; vui lòng tải lại hoá đơn' USING ERRCODE='22023';
  END IF;

  -- H1.3 (rà soát 15/09): SERVER tự cộng lại p_items thay vì tin p_subtotal.
  -- Phép đối chiếu tổng bên dưới chỉ so p_total_amount với round(subtotal − giảm
  -- trừ + nợ cũ) — cả ba vế đều do client gửi, nên một client sửa được p_subtotal
  -- thì sửa luôn tổng cho khớp và hoá đơn ghi xuống ít hơn số hạng mục thật.
  -- Công thức COALESCE ở đây chép ĐÚNG công thức ghi invoice_items bên dưới (amount
  -- client gửi, vắng thì đơn giá × số lượng × hệ số) để không có hạng mục nào
  -- được cộng theo một luật khác với lúc nó được lưu.
  -- Ngưỡng 0.01: client là JavaScript double, server là numeric.
  SELECT COALESCE(sum(
           COALESCE((value->>'amount')::numeric,
                    COALESCE((value->>'unit_price')::numeric, 0)
                    * COALESCE((value->>'quantity')::numeric, 1)
                    * COALESCE((value->>'coefficient')::numeric, 1))), 0)
    INTO v_items_sum
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb));
  IF abs(v_items_sum - COALESCE(p_subtotal, 0)) >= 0.01 THEN
    RAISE EXCEPTION
      'Tạm tính client (%) khác tổng hạng mục server cộng lại (%)',
      COALESCE(p_subtotal, 0), v_items_sum;
  END IF;

  -- recalc total + assert (làm tròn trên p_subtotal, giống create).
  v_total_calc := app_private.round_invoice_total_v1(
    coalesce(p_subtotal,0) - coalesce(p_discount_amount,0) + coalesce(p_previous_debt,0));

  if v_total_calc is distinct from p_total_amount then
    raise exception
      'Tổng tiền client (%) khác tổng server làm tròn (%) [subtotal=%, discount=%, nợ cũ=%]',
      p_total_amount, v_total_calc, coalesce(p_subtotal,0),
      coalesce(p_discount_amount,0), coalesce(p_previous_debt,0)
      using errcode='22000';
  end if;

  update public.invoices
     set contract_id                 = p_contract_id,
         building_id                 = p_building_id,
         room_id                     = p_room_id,
         billing_month               = p_billing_month,
         issue_date                  = p_issue_date,
         due_date                    = p_due_date,
         subtotal                    = coalesce(p_subtotal,0),
         discount_amount             = coalesce(p_discount_amount,0),
         discount_notes              = p_discount_notes,
         electricity_prev_overridden = coalesce(p_electricity_prev_overridden,false),
         total_amount                = p_total_amount,
         prepaid_amount              = coalesce(p_prepaid_amount,0),
         previous_debt               = coalesce(p_previous_debt,0),
         previous_debt_sources       = coalesce(p_previous_debt_sources,'[]'::jsonb),
         notes                       = p_notes,
         template_id                 = p_template_id
   where id = p_invoice_id
   returning * into v_row;

  -- replace items (delete-all rồi insert lại, mirror legacy).
  delete from public.invoice_items where invoice_id = p_invoice_id;
  if p_items is not null then
    for it in select value from jsonb_array_elements(v_normalized_items) loop
      v_idx := v_idx + 1;
      insert into public.invoice_items
        (invoice_id, organization_id, service_id, type, description, unit_price,
         quantity, coefficient, amount, previous_reading, current_reading,
         from_date, to_date, sort_order, accounting_class)
      values (
        p_invoice_id, v_org,
        nullif(it->>'service_id','')::uuid,
        coalesce(nullif(it->>'type','')::invoice_item_type, 'OTHER'::invoice_item_type),
        it->>'description',
        coalesce((it->>'unit_price')::numeric,0),
        coalesce((it->>'quantity')::numeric,1),
        coalesce((it->>'coefficient')::numeric,1),
        coalesce((it->>'amount')::numeric,
          coalesce((it->>'unit_price')::numeric,0)
          * coalesce((it->>'quantity')::numeric,1)
          * coalesce((it->>'coefficient')::numeric,1)),
        nullif(it->>'previous_reading','')::numeric,
        nullif(it->>'current_reading','')::numeric,
        nullif(it->>'from_date','')::date,
        nullif(it->>'to_date','')::date,
        coalesce((it->>'sort_order')::int, v_idx),
        coalesce(it->>'accounting_class','REVENUE')
      );
    end loop;
  end if;

  return v_row;
end;
$function$;

REVOKE ALL ON FUNCTION public.update_invoice_v1(
  uuid, uuid, uuid, uuid, text, date, date, numeric, numeric, numeric, numeric,
  jsonb, numeric, text, boolean, jsonb, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_invoice_v1(
  uuid, uuid, uuid, uuid, text, date, date, numeric, numeric, numeric, numeric,
  jsonb, numeric, text, boolean, jsonb, uuid, text
) TO authenticated, service_role;

-- ═══ 6. THU TIỀN — chặn ngày thu ở tương lai (H1.4) ══════════════════════════

CREATE OR REPLACE FUNCTION public.record_invoice_collection_v5(p_invoice_id uuid, p_collection_date date, p_tenders jsonb, p_overpay_action text, p_allow_rounding boolean, p_notes text, p_receipt_image_url text, p_expected_paid_amount numeric, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_collector_membership uuid;
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_invoice public.invoices%ROWTYPE;
  v_org uuid;
  v_owner uuid;
  v_authz boolean;
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_collection_id uuid;
  v_tender jsonb;
  v_tender_id uuid;
  v_payment_id uuid;
  v_voucher_id uuid;
  v_item_id uuid;
  v_credit_lot_id uuid;
  v_credit_tender_count integer;
  v_excess_id uuid;
  v_account_id uuid;
  v_change_account_id uuid;
  v_rounding_account_id uuid;
  v_method public.payment_method;
  v_gross numeric;
  v_gross_total numeric := 0;
  v_tm_total numeric := 0;
  v_explicit_change boolean;
  v_requested_change numeric;
  v_requested_change_total numeric := 0;
  v_rounding_line_idx integer;
  v_fallback_rounding_account uuid;
  v_refund_audit_posting uuid;
  v_refund_audit_evidence uuid;
  v_remaining numeric;
  v_applied_total numeric;
  v_change_total numeric := 0;
  v_credit_total numeric := 0;
  v_rounding_total numeric := 0;
  v_retained_total numeric;
  v_remaining_apply numeric;
  v_change_left numeric;
  v_credit_left numeric;
  v_line_left numeric;
  v_line_change numeric;
  v_line_credit numeric;
  v_line_retained numeric;
  v_line_applied numeric;
  v_line_revenue numeric;
  v_line_internal numeric;
  v_line_deposit numeric;
  v_later_tm_total numeric;
  v_later_gross_total numeric;
  v_revenue_due numeric;
  v_internal_due numeric := 0;
  v_deposit_due numeric := 0;
  v_revenue_covered numeric := 0;
  v_internal_covered numeric := 0;
  v_deposit_covered numeric := 0;
  v_projected_revenue numeric;
  v_projected_internal numeric;
  v_projected_deposit numeric;
  v_projection_left numeric;
  v_idx integer := 0;
  v_last_tm_idx integer := -1;
  v_last_line_idx integer;
  v_revenue_type_id uuid;
  v_deposit_type_id uuid;
  v_credit_type_id uuid;
  v_response jsonb;
  v_tender_results jsonb := '[]'::jsonb;
  v_creator_name text;
  v_rounding_target_account uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'
      USING ERRCODE = '22023';
  END IF;
  IF p_collection_date IS NULL OR jsonb_typeof(p_tenders) <> 'array'
     OR jsonb_array_length(p_tenders) = 0 THEN
    RAISE EXCEPTION 'Ngày thu hoặc danh sách phương thức không hợp lệ'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hóa đơn' USING ERRCODE = '42501';
  END IF;

  SELECT building_row.organization_id, v_invoice.user_id
    INTO v_org, v_owner
  FROM public.buildings building_row
  JOIN public.organizations org_row
    ON org_row.id = building_row.organization_id AND org_row.status = 'ACTIVE'
  WHERE building_row.id = v_invoice.building_id
    AND building_row.deleted_at IS NULL
  FOR SHARE OF building_row, org_row;
  IF v_org IS NULL OR v_invoice.organization_id <> v_org THEN
    RAISE EXCEPTION 'Hóa đơn không thuộc tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  -- H1.4 (rà soát 15/09): ngày thu ở TƯƠNG LAI đóng băng một con số chưa xảy ra
  -- vào invoice_payment_collections.collection_date, payments.payment_date và
  -- ngày phiếu thu — mọi báo cáo theo kỳ đọc sai từ đó trở đi, và khoản thu còn
  -- không hoàn tác được (reverse đòi ngày hoàn tác ≥ ngày thu nhưng ≤ hôm nay).
  -- reverse_invoice_collection_v5 đã chặn cận trên từ 13/09; đường GHI thì chưa.
  -- "Hôm nay" đo theo NGÀY CỦA ORG, không theo CURRENT_DATE: phiên Postgres chạy
  -- TimeZone=UTC nên từ 00:00 đến 07:00 giờ VN, CURRENT_DATE vẫn là hôm qua và
  -- mọi khoản thu ghi "hôm nay" theo giờ VN sẽ bị từ chối oan.
  IF p_collection_date > public.org_today_v1(v_org) THEN
    RAISE EXCEPTION 'Ngày thu không được ở tương lai (hôm nay là %)',
      to_char(public.org_today_v1(v_org), 'DD/MM/YYYY')
      USING ERRCODE = '22023';
  END IF;

  -- Membership của người thu — dùng cho chốt possession trên sổ nhận tiền.
  SELECT m.id INTO v_collector_membership
  FROM public.organization_memberships m
  WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE'
  LIMIT 1;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền thu tiền hóa đơn' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'invoice_id', p_invoice_id,
    'collection_date', p_collection_date,
    'tenders', p_tenders,
    'overpay_action', upper(COALESCE(p_overpay_action, 'REJECT')),
    'allow_rounding', COALESCE(p_allow_rounding, false),
    'notes', p_notes,
    'receipt_image_url', p_receipt_image_url
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    v_org, 'invoice.collection.v5', p_invoice_id::text, v_actor, v_key, v_hash
  ) ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
    DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'invoice.collection.v5'
    AND operation_row.subject_scope = p_invoice_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM app_private.canonical_write_operations compat_operation
    WHERE compat_operation.organization_id = v_org
      AND compat_operation.operation = 'invoice.collection.compat.v4'
      AND compat_operation.subject_scope = p_invoice_id::text
      AND compat_operation.actor_id = v_actor
      AND compat_operation.idempotency_key = v_key
      AND compat_operation.completed_at IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.income_expenses legacy_voucher
    WHERE legacy_voucher.organization_id = v_org
      AND legacy_voucher.idempotency_key = v_key
      AND legacy_voucher.payment_collection_id IS NULL
      AND legacy_voucher.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'idempotency_key đã hoàn tất ở đường payment tương thích'
      USING ERRCODE = '23505';
  END IF;

  v_route := app_private.evaluate_feature_route('invoice.collection.v5', v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer invoice.collection.v5 đang bị đóng băng'
      USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Writer invoice.collection.v5 chưa bật' USING ERRCODE = '55000';
  END IF;

  IF v_invoice.status NOT IN ('APPROVED', 'PARTIAL_PAID', 'OVERDUE') THEN
    RAISE EXCEPTION 'Trạng thái hóa đơn không cho phép thu tiền: %', v_invoice.status
      USING ERRCODE = '55000';
  END IF;
  IF p_expected_paid_amount IS NULL
     OR p_expected_paid_amount = 'NaN'::numeric
     OR abs(COALESCE(v_invoice.paid_amount, 0) - p_expected_paid_amount) >= 0.01 THEN
    RAISE EXCEPTION 'Số đã thu vừa thay đổi; vui lòng tải lại hóa đơn'
      USING ERRCODE = 'PT409';
  END IF;

  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(p_tenders) t
    WHERE t ? 'requested_change_amount') INTO v_explicit_change;
  IF v_explicit_change AND upper(COALESCE(p_overpay_action, 'REJECT')) <> 'REFUND' THEN
    RAISE EXCEPTION 'Tiền thối tùy chỉnh chỉ dùng khi chọn thối lại'
      USING ERRCODE = '22023';
  END IF;

  FOR v_tender IN SELECT value FROM jsonb_array_elements(p_tenders) LOOP
    v_gross := COALESCE((v_tender->>'gross_amount')::numeric, 0);
    IF v_gross IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
       OR v_gross <= 0 OR round(v_gross, 2) <> v_gross THEN
      RAISE EXCEPTION 'Mỗi dòng thanh toán phải lớn hơn 0 và tối đa 2 số lẻ'
        USING ERRCODE = '22023';
    END IF;
    v_method := (v_tender->>'payment_method')::public.payment_method;
    IF v_explicit_change THEN
      IF v_method = 'TM' THEN
        IF jsonb_typeof(v_tender->'requested_change_amount') IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'Phải nhập tiền thối bằng số cho tất cả dòng tiền mặt'
            USING ERRCODE = '22023';
        END IF;
        v_requested_change := (v_tender->>'requested_change_amount')::numeric;
        IF v_requested_change IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
           OR v_requested_change < 0 OR v_requested_change > v_gross
           OR round(v_requested_change, 2) <> v_requested_change THEN
          RAISE EXCEPTION 'Tiền thối phải không âm, tối đa 2 số lẻ và không vượt tiền mặt của dòng'
            USING ERRCODE = '22023';
        END IF;
        v_requested_change_total := v_requested_change_total + v_requested_change;
      ELSIF v_tender ? 'requested_change_amount' THEN
        RAISE EXCEPTION 'Chỉ được thối từ dòng tiền mặt TM' USING ERRCODE = '22023';
      END IF;
    END IF;
    v_account_id := NULLIF(v_tender->>'account_id', '')::uuid;
    IF v_account_id IS NULL THEN
      RAISE EXCEPTION 'Mỗi dòng thanh toán phải có sổ quỹ' USING ERRCODE = '22023';
    END IF;

    PERFORM 1 FROM public.accounts account_row
    WHERE account_row.id = v_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ nhận tiền phải là sổ tiền thật của tổ chức'
        USING ERRCODE = '42501';
    END IF;
    SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(
      v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_account_id
    );
    IF NOT COALESCE(v_authz, false) THEN
      RAISE EXCEPTION 'Không có quyền ghi vào một sổ quỹ đã chọn' USING ERRCODE = '42501';
    END IF;

    -- CHỐT POSSESSION TRÊN SỔ NHẬN TIỀN (02/08/2026).
    -- 'thu_tien.collect' khai requires_cashbook_possession = false và
    -- required_dimensions = [], nên tham số p_cashbook_id ở trên bị BỎ QUA: đo
    -- trên prod, một người thu được ở toà là server cho ghi vào CẢ 16/16 sổ của
    -- tổ chức, kể cả sổ chưa từng được cấp quyền gì. Trước đây chỉ có danh sách
    -- trên giao diện vô tình gác cổng; gọi thẳng API thì không còn gì chặn.
    --
    -- KHÔNG bật requires_cashbook_possession cho 'thu_tien.collect' để vá:
    -- authorize_tenant_action_v3 khi đó đòi cạnh ALLOW phải là scope CASHBOOK,
    -- mà vai trò "Quản Lý Tòa" chỉ có binding scope BUILDING (18 binding/org)
    -- ⇒ bật lên là chặn sạch mọi người thu. Vì vậy kiểm possession TRỰC TIẾP.
    --
    -- CUSTODIAN hoặc KNOWER đều hợp lệ (helper đã khai đúng vậy): người thu chỉ
    -- đạo tiền vào tài khoản ngân hàng của chủ thì là "người biết sổ", không
    -- phải người giữ tiền. Đo lịch sử 120 ngày: 0/31 lần thu bị chốt này chặn.
    IF v_collector_membership IS NULL
       OR NOT app_private.ie_has_cashbook_possession_v1(v_org, v_account_id, v_collector_membership) THEN
      RAISE EXCEPTION 'Bạn không được giao sổ quỹ này (cần là Người giữ sổ hoặc Người biết sổ). Chọn sổ khác.'
        USING ERRCODE = '42501';
    END IF;

    v_gross_total := v_gross_total + v_gross;
    IF v_method = 'TM' THEN
      v_tm_total := v_tm_total + v_gross;
      v_last_tm_idx := v_idx;
    END IF;
    v_idx := v_idx + 1;
  END LOOP;

  v_last_line_idx := v_idx - 1;
  v_remaining := GREATEST(v_invoice.total_amount - COALESCE(v_invoice.paid_amount, 0), 0);
  v_applied_total := LEAST(v_gross_total, v_remaining);

  IF v_gross_total > v_remaining THEN
    CASE upper(COALESCE(p_overpay_action, 'REJECT'))
      WHEN 'REFUND' THEN v_change_total := v_gross_total - v_remaining;
      WHEN 'CREDIT' THEN
        IF v_invoice.contract_id IS NULL THEN
          RAISE EXCEPTION 'Không thể giữ credit cho hóa đơn không có hợp đồng'
            USING ERRCODE = '22023';
        END IF;
        v_credit_total := v_gross_total - v_remaining;
      ELSE
        RAISE EXCEPTION 'Số thu vượt còn phải thu; chọn thối lại hoặc giữ credit'
          USING ERRCODE = '22023';
    END CASE;
    IF v_change_total > 0
       AND (v_last_tm_idx < 0 OR v_tm_total < v_change_total) THEN
      RAISE EXCEPTION 'Phần hoàn tiền phải nằm trong dòng tiền mặt TM của lần thu hiện tại'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_explicit_change THEN
    IF v_requested_change_total < GREATEST(v_gross_total - v_remaining, 0) THEN
      RAISE EXCEPTION 'Tiền thối không được nhỏ hơn phần dư; chọn giữ credit nếu cần giữ tiền'
        USING ERRCODE = '22023';
    END IF;
    IF v_gross_total - v_requested_change_total <= 0 THEN
      RAISE EXCEPTION 'Số tiền thực thu sau khi thối phải lớn hơn 0' USING ERRCODE = '22023';
    END IF;
    v_change_total := v_requested_change_total;
    v_applied_total := LEAST(v_gross_total - v_change_total, v_remaining);
  END IF;

  IF v_applied_total <= 0 THEN
    RAISE EXCEPTION 'Hóa đơn không còn số tiền có thể thu' USING ERRCODE = '55000';
  END IF;

  IF COALESCE(p_allow_rounding, false)
     AND v_remaining - v_applied_total > 0
     AND v_remaining - v_applied_total < 10000 THEN
    v_rounding_total := v_remaining - v_applied_total;
  END IF;

  v_retained_total := v_gross_total - v_change_total;

  SELECT COALESCE(sum(item.amount), 0)
    INTO v_deposit_due
  FROM public.invoice_items item
  WHERE item.invoice_id = p_invoice_id
    AND item.accounting_class = 'DEPOSIT';

  SELECT v_deposit_due + COALESCE(sum((source_row->>'amount')::numeric), 0)
    INTO v_deposit_due
  FROM jsonb_array_elements(COALESCE(v_invoice.previous_debt_sources, '[]'::jsonb)) source_row
  WHERE source_row->>'type' = 'deposit';
  v_deposit_due := COALESCE(v_deposit_due, 0);
  SELECT COALESCE(sum(item.amount), 0)
    INTO v_internal_due
  FROM public.invoice_items item
  WHERE item.invoice_id = p_invoice_id
    AND item.accounting_class = 'NON_PNL';

  v_internal_due := COALESCE(v_internal_due, 0);
  v_revenue_due := GREATEST(
    v_invoice.total_amount - v_deposit_due - v_internal_due,
    0
  );
  IF v_deposit_due = 'NaN'::numeric
     OR v_internal_due = 'NaN'::numeric
     OR v_invoice.total_amount = 'NaN'::numeric
     OR v_deposit_due + v_internal_due - v_invoice.total_amount >= 0.01 THEN
    RAISE EXCEPTION 'Dữ liệu cọc/NON_PNL vượt tổng phải thu; cần review kế toán'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'PNL'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'DEPOSIT'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'INTERNAL'), 0)
  INTO v_revenue_covered, v_deposit_covered, v_internal_covered
  FROM public.income_expenses voucher
  JOIN public.income_expense_items item
    ON item.income_expense_id = voucher.id
  LEFT JOIN public.invoice_payment_collections source_collection
    ON source_collection.id = voucher.payment_collection_id
  LEFT JOIN public.payments source_payment
    ON source_payment.id = voucher.payment_id
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.type = 'INCOME'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL
    AND (
      voucher.payment_collection_id IS NULL
      OR source_collection.status = 'ACTIVE'
    )
    AND (voucher.payment_id IS NULL OR source_payment.reversed_at IS NULL);

  IF v_revenue_covered - v_revenue_due >= 0.01
     OR v_deposit_covered - v_deposit_due >= 0.01
     OR v_internal_covered - v_internal_due >= 0.01 THEN
    RAISE EXCEPTION 'Bút toán đã ghi vượt semantic của hóa đơn; cần review kế toán'
      USING ERRCODE = '55000';
  END IF;
  IF abs(
    v_revenue_covered + v_deposit_covered + v_internal_covered
    - COALESCE(v_invoice.paid_amount, 0)
  ) >= 0.01 THEN
    RAISE EXCEPTION 'Số đã thu không khớp bút toán semantic; cần đối soát trước'
      USING ERRCODE = '55000';
  END IF;
  v_revenue_covered := GREATEST(LEAST(v_revenue_covered, v_revenue_due), 0);
  v_deposit_covered := GREATEST(LEAST(v_deposit_covered, v_deposit_due), 0);
  v_internal_covered := GREATEST(LEAST(v_internal_covered, v_internal_due), 0);

  v_projection_left := v_applied_total;
  v_projected_revenue := v_revenue_covered + LEAST(
    v_projection_left,
    GREATEST(v_revenue_due - v_revenue_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_revenue - v_revenue_covered);
  v_projected_deposit := v_deposit_covered + LEAST(
    v_projection_left,
    GREATEST(v_deposit_due - v_deposit_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_deposit - v_deposit_covered);
  v_projected_internal := v_internal_covered + LEAST(
    v_projection_left,
    GREATEST(v_internal_due - v_internal_covered, 0)
  );
  v_projection_left := v_projection_left - (v_projected_internal - v_internal_covered);
  IF abs(v_projection_left) >= 0.01 THEN
    RAISE EXCEPTION 'Không thể phân bổ số thu vào semantic hóa đơn'
      USING ERRCODE = '55000';
  END IF;

  IF v_rounding_total > 0 AND (
    v_deposit_due - v_projected_deposit >= 0.01
    OR v_internal_due - v_projected_internal >= 0.01
  ) THEN
    RAISE EXCEPTION 'Không được làm tròn bỏ qua cọc hoặc khoản NON_PNL còn thiếu'
      USING ERRCODE = '22023';
  END IF;

  SELECT type_row.id INTO v_revenue_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND NOT type_row.is_deposit
  ORDER BY type_row.is_default DESC,
           CASE WHEN lower(btrim(type_row.name)) IN ('thu tiền hoá đơn', 'thu tiền hóa đơn') THEN 0 ELSE 1 END,
           type_row.created_at
  LIMIT 1 FOR SHARE;

  SELECT type_row.id INTO v_deposit_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND type_row.is_deposit
  ORDER BY CASE WHEN lower(btrim(type_row.name)) = 'tiền cọc' THEN 0 ELSE 1 END,
           type_row.created_at
  LIMIT 1 FOR SHARE;

  SELECT type_row.id INTO v_credit_type_id
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND lower(btrim(type_row.name)) = 'tiền khách trả thừa'
  LIMIT 1 FOR SHARE;

  IF v_revenue_type_id IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có loại thu hóa đơn' USING ERRCODE = '55000';
  END IF;
  IF v_deposit_due > 0 AND v_deposit_type_id IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có loại thu cọc' USING ERRCODE = '55000';
  END IF;
  IF v_credit_total > 0 AND v_credit_type_id IS NULL THEN
    INSERT INTO public.income_expense_types (
      organization_id, user_id, name, type, description, is_default, is_deposit
    ) VALUES (
      v_org, v_owner, 'Tiền khách trả thừa', 'income',
      'Khoản khách trả dư giữ lại để cấn kỳ sau; ngoài KQKD', false, false
    ) RETURNING id INTO v_credit_type_id;
  END IF;

  v_creator_name := COALESCE(
    auth.jwt()->'user_metadata'->>'full_name',
    auth.jwt()->'user_metadata'->>'name',
    auth.jwt()->>'email',
    'Người dùng'
  );

  PERFORM app_private.claim_feature_operation_v1(
    'invoice.collection.v5',
    v_org,
    p_invoice_id::text,
    v_actor,
    v_key,
    v_retained_total
  );

  PERFORM app_private.begin_accounting_chain_write_v1();

  INSERT INTO public.invoice_payment_collections (
    organization_id, invoice_id, contract_id, status, collection_date,
    actor_id, idempotency_key, payload_hash, expected_paid_amount,
    gross_amount, retained_amount, applied_amount, change_amount,
    credit_amount, rounding_amount, notes, receipt_image_url
  ) VALUES (
    v_org, p_invoice_id, v_invoice.contract_id, 'ACTIVE', p_collection_date,
    v_actor, v_key, v_hash, p_expected_paid_amount,
    v_gross_total, v_retained_total, v_applied_total, v_change_total,
    v_credit_total, v_rounding_total, NULLIF(btrim(p_notes), ''), p_receipt_image_url
  ) RETURNING id INTO v_collection_id;

  -- A fully refunded final TM tender has no payment. Keep rounding on the
  -- last tender with real applied money so recompute/reversal see it exactly once.
  v_rounding_line_idx := v_last_line_idx;
  IF v_explicit_change AND v_rounding_total > 0 THEN
    SELECT max(ord - 1)::integer INTO v_rounding_line_idx
    FROM jsonb_array_elements(p_tenders) WITH ORDINALITY t(value, ord)
    WHERE (value->>'gross_amount')::numeric
      - COALESCE((value->>'requested_change_amount')::numeric, 0) > 0;
  END IF;
  v_fallback_rounding_account := NULLIF(p_tenders->v_last_line_idx->>'rounding_account_id', '')::uuid;

  v_remaining_apply := v_applied_total;
  v_change_left := v_change_total;
  v_credit_left := v_credit_total;
  v_idx := 0;

  FOR v_tender IN SELECT value FROM jsonb_array_elements(p_tenders) LOOP
    v_payment_id := NULL;
    v_voucher_id := NULL;
    v_gross := (v_tender->>'gross_amount')::numeric;
    v_method := (v_tender->>'payment_method')::public.payment_method;
    v_account_id := (v_tender->>'account_id')::uuid;
    v_change_account_id := NULLIF(v_tender->>'change_account_id', '')::uuid;
    v_rounding_account_id := NULLIF(v_tender->>'rounding_account_id', '')::uuid;
    IF v_explicit_change AND v_idx = v_rounding_line_idx AND v_rounding_total > 0 THEN
      -- The original final line owns the rounding account, matching old payloads.
      v_rounding_account_id := v_fallback_rounding_account;
    END IF;
    v_line_change := 0;
    v_line_credit := 0;
    v_line_revenue := 0;
    v_line_deposit := 0;
    v_line_internal := 0;

    IF v_explicit_change AND v_method = 'TM' THEN
      v_line_change := (v_tender->>'requested_change_amount')::numeric;
      v_change_left := v_change_left - v_line_change;
    ELSIF v_method = 'TM' AND v_change_left > 0 THEN
      SELECT COALESCE(sum((later.value->>'gross_amount')::numeric), 0)
        INTO v_later_tm_total
      FROM jsonb_array_elements(p_tenders) WITH ORDINALITY later(value, ord)
      WHERE later.ord - 1 > v_idx
        AND later.value->>'payment_method' = 'TM';

      v_line_change := LEAST(
        v_gross,
        GREATEST(v_change_total - v_later_tm_total, 0)
      );
      v_change_left := v_change_left - v_line_change;
    END IF;

    IF v_credit_left > 0 THEN
      SELECT COALESCE(sum((later.value->>'gross_amount')::numeric), 0)
        INTO v_later_gross_total
      FROM jsonb_array_elements(p_tenders) WITH ORDINALITY later(value, ord)
      WHERE later.ord - 1 > v_idx;

      v_line_credit := LEAST(
        v_gross - v_line_change,
        GREATEST(v_credit_total - v_later_gross_total, 0)
      );
      v_credit_left := v_credit_left - v_line_credit;
    END IF;

    IF v_line_change > 0 THEN
      IF v_change_account_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu sổ quỹ tiền thối' USING ERRCODE = '22023';
      END IF;
      PERFORM 1 FROM public.accounts account_row
      WHERE account_row.id = v_change_account_id
        AND account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND account_row.is_virtual
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Sổ tiền thối phải là sổ ảo của tổ chức'
          USING ERRCODE = '42501';
      END IF;
      SELECT allowed INTO v_authz
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_change_account_id
      );
      IF NOT COALESCE(v_authz, false) THEN
        RAISE EXCEPTION 'Không có quyền ghi tiền thối vào sổ đã chọn'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    v_line_retained := v_gross - v_line_change;
    v_line_applied := LEAST(v_line_retained - v_line_credit, v_remaining_apply);
    v_remaining_apply := v_remaining_apply - v_line_applied;

    v_line_left := v_line_applied;
    v_line_revenue := LEAST(
      v_line_left,
      GREATEST(v_revenue_due - v_revenue_covered, 0)
    );
    v_revenue_covered := v_revenue_covered + v_line_revenue;
    v_line_left := v_line_left - v_line_revenue;

    v_line_deposit := LEAST(
      v_line_left,
      GREATEST(v_deposit_due - v_deposit_covered, 0)
    );
    v_deposit_covered := v_deposit_covered + v_line_deposit;
    v_line_left := v_line_left - v_line_deposit;

    v_line_internal := LEAST(
      v_line_left,
      GREATEST(v_internal_due - v_internal_covered, 0)
    );
    v_internal_covered := v_internal_covered + v_line_internal;
    v_line_left := v_line_left - v_line_internal;
    IF abs(v_line_left) >= 0.01 THEN
      RAISE EXCEPTION 'Dòng thanh toán không phân bổ hết vào semantic hóa đơn'
        USING ERRCODE = '55000';
    END IF;

    IF v_idx = v_rounding_line_idx AND v_rounding_total > 0 THEN
      IF v_rounding_account_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu sổ quỹ làm tròn' USING ERRCODE = '22023';
      END IF;
      PERFORM 1 FROM public.accounts account_row
      WHERE account_row.id = v_rounding_account_id
        AND account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND account_row.is_virtual
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Sổ làm tròn phải là sổ ảo của tổ chức'
          USING ERRCODE = '42501';
      END IF;
      SELECT allowed INTO v_authz
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, v_rounding_account_id
      );
      IF NOT COALESCE(v_authz, false) THEN
        RAISE EXCEPTION 'Không có quyền dùng sổ làm tròn đã chọn'
          USING ERRCODE = '42501';
      END IF;
      v_rounding_target_account := v_rounding_account_id;
    END IF;

    INSERT INTO public.invoice_payment_tenders (
      organization_id, collection_id, line_index, payment_method, account_id,
      change_account_id, rounding_account_id, gross_amount, retained_amount,
      applied_amount, change_amount, credit_amount, rounding_amount, receipt_number
    ) VALUES (
      v_org, v_collection_id, v_idx, v_method, v_account_id,
      v_change_account_id, v_rounding_account_id, v_gross, v_line_retained,
      v_line_applied, v_line_change, v_line_credit,
      CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_total ELSE 0 END,
      NULLIF(v_tender->>'receipt_number', '')
    ) RETURNING id INTO v_tender_id;

    IF v_line_applied > 0 THEN
      INSERT INTO public.payments (
        organization_id, user_id, invoice_id, receipt_number, amount,
        received_amount, credit_amount, change_amount, rounding_amount,
        payment_method, payment_date, notes, receipt_image_url,
        collection_id, tender_id
      ) VALUES (
        v_org, v_owner, p_invoice_id, NULLIF(v_tender->>'receipt_number', ''),
        v_line_applied, v_line_retained, v_line_credit, v_line_change,
        CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_total ELSE 0 END,
        v_method, p_collection_date, NULLIF(btrim(p_notes), ''),
        CASE WHEN v_idx = 0 THEN p_receipt_image_url END,
        v_collection_id, v_tender_id
      ) RETURNING id INTO v_payment_id;
    ELSE
      v_payment_id := NULL;
    END IF;

    IF v_line_retained > 0
       OR v_line_change > 0
       OR (v_idx = v_rounding_line_idx AND v_rounding_total > 0) THEN
      INSERT INTO public.income_expenses (
        user_id, organization_id, type, name, building_id, room_id, contract_id,
        account_id, invoice_id, payment_id, payment_collection_id, voucher_date,
        payer_name, notes, attachments, total_amount, approval_status,
        approved_by, approved_at, business_result_accounting, creator_name,
        change_amount, change_account_id, rounding_amount, rounding_account_id,
        system_source, idempotency_key
      ) VALUES (
        v_owner, v_org, 'INCOME', 'Thu tiền theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
        v_invoice.building_id, v_invoice.room_id, v_invoice.contract_id,
        v_account_id, p_invoice_id, v_payment_id, v_collection_id, p_collection_date,
        NULL, NULLIF(btrim(p_notes), ''),
        CASE WHEN v_idx = 0 AND p_receipt_image_url IS NOT NULL
          THEN jsonb_build_array(p_receipt_image_url) ELSE '[]'::jsonb END,
        v_line_retained, 'APPROVED', v_actor, clock_timestamp(), NULL,
        v_creator_name, v_line_change, v_change_account_id,
        CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_total ELSE 0 END,
        CASE WHEN v_idx = v_rounding_line_idx THEN v_rounding_account_id END,
        'invoice.collection.v5', v_key || ':tender:' || v_idx
      ) RETURNING id INTO v_voucher_id;

      IF v_line_revenue > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_revenue_type_id,
          'Thanh toán HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_revenue, v_line_revenue, p_collection_date, p_collection_date, 'PNL'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'PNL', v_line_revenue
        );
      END IF;

      IF v_line_deposit > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_deposit_type_id,
          'Tiền cọc theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_deposit, v_line_deposit, p_collection_date, p_collection_date, 'DEPOSIT'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'DEPOSIT', v_line_deposit
        );
      END IF;

      IF v_line_internal > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_revenue_type_id,
          'Khoản ngoài KQKD theo HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_internal, v_line_internal,
          p_collection_date, p_collection_date, 'INTERNAL'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'INTERNAL', v_line_internal
        );
      END IF;

      IF v_line_credit > 0 THEN
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_voucher_id, v_org, v_credit_type_id,
          'Tiền khách trả thừa từ HĐ ' || COALESCE(v_invoice.invoice_number, ''),
          1, v_line_credit, v_line_credit, p_collection_date, p_collection_date,
          'CUSTOMER_CREDIT'
        ) RETURNING id INTO v_item_id;
        INSERT INTO public.invoice_payment_allocations (
          organization_id, collection_id, tender_id, voucher_id,
          income_expense_item_id, accounting_class, amount
        ) VALUES (
          v_org, v_collection_id, v_tender_id, v_voucher_id,
          v_item_id, 'CUSTOMER_CREDIT', v_line_credit
        );
      END IF;

      INSERT INTO app_private.income_expense_flow_ownership (
        income_expense_id, organization_id, flow_kind, flow_version,
        lifecycle_owner, lifecycle_state, writer_operation,
        payload_hash_scheme, payload_hash_value, maker_user_id,
        claimed_by_user_id, correlation_id
      ) VALUES (
        v_voucher_id, v_org, 'INVOICE_COLLECTION_V5', 5,
        'INVOICE_COLLECTION_V5', 'APPROVED', 'invoice.collection.v5',
        'PG_MD5_JSONB_TEXT_V1', v_hash, v_actor, v_actor, v_collection_id
      ) ON CONFLICT (income_expense_id) DO NOTHING;
    END IF;

    UPDATE public.invoice_payment_tenders
       SET payment_id = v_payment_id, voucher_id = v_voucher_id
     WHERE id = v_tender_id;

    -- A fully returned tender has no real cash movement. The generic bridge
    -- skips zero-value vouchers, so emit ONLY its virtual change audit line.
    -- A real MAIN line here would fabricate income. Keep a posting lineage so
    -- the existing collection reversal can mirror/cancel this audit as usual.
    IF v_explicit_change AND v_line_retained = 0 AND v_line_change > 0 THEN
      IF app_private.evaluate_feature_route('income_expense.posting.v2', v_org) <> 'CANONICAL' THEN
        RAISE EXCEPTION 'Ghi sổ tiền thối chưa bật hoặc đang bị đóng băng' USING ERRCODE = '55000';
      END IF;
      INSERT INTO public.income_expense_postings (
        organization_id, voucher_id, posting_subject_kind, posting_subject_id,
        direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
        net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
        approval_version, event_kind, idempotency_key, source_kind,
        external_source_kind, external_source_id, external_source_line_id, posting_generation
      ) VALUES (
        v_org, v_voucher_id, 'VOUCHER', v_voucher_id,
        'INCOME', v_account_id, v_gross, 0, 'EXTERNAL_TENDER_GROSS',
        v_line_change, p_collection_date, v_collector_membership, v_actor,
        1, 'POSTING', 'v5:refund-audit:' || v_tender_id::text, 'COLLECTION_V5_ADAPTER',
        'COLLECTION_V5', v_collection_id, v_tender_id, 1
      ) RETURNING id INTO v_refund_audit_posting;
      INSERT INTO public.income_expense_posting_lines
        (organization_id, posting_id, account_id, line_kind, signed_amount)
      VALUES (v_org, v_refund_audit_posting, v_change_account_id, 'CHANGE', v_line_change);
      v_refund_audit_evidence := app_private.register_system_evidence_v2(
        v_org, 'INVOICE_COLLECTION_V5', v_collection_id, v_tender_id, NULL,
        md5(v_gross::text || ':0:' || v_tender_id::text));
      INSERT INTO public.income_expense_posting_evidence
        (organization_id, posting_id, evidence_id, relation_kind)
      VALUES (v_org, v_refund_audit_posting, v_refund_audit_evidence, 'ORIGINAL');
      INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
      VALUES (v_voucher_id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
      ON CONFLICT (income_expense_id) DO UPDATE SET xid=excluded.xid, purpose=excluded.purpose;
      UPDATE public.income_expenses
        SET active_posting_id_v2 = v_refund_audit_posting, posting_status = 'POSTED',
            posting_id = v_refund_audit_posting, posted_at_v2 = now()
      WHERE id = v_voucher_id;
      DELETE FROM app_private.ie_transition_authorization
      WHERE income_expense_id = v_voucher_id AND xid = pg_current_xact_id();
    END IF;

    v_tender_results := v_tender_results || jsonb_build_array(jsonb_build_object(
      'tender_id', v_tender_id,
      'payment_id', v_payment_id,
      'voucher_id', v_voucher_id,
      'applied_amount', v_line_applied,
      'revenue_amount', v_line_revenue,
      'internal_amount', v_line_internal,
      'deposit_amount', v_line_deposit,
      'credit_amount', v_line_credit,
      'change_amount', v_line_change
    ));
    v_idx := v_idx + 1;
  END LOOP;

  IF v_remaining_apply <> 0 OR v_change_left <> 0 OR v_credit_left <> 0 THEN
    RAISE EXCEPTION 'Phân bổ collection không cân bằng' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_payment_tenders tender
    LEFT JOIN public.invoice_payment_allocations allocation
      ON allocation.tender_id = tender.id
    WHERE tender.collection_id = v_collection_id
    GROUP BY tender.id, tender.retained_amount
    HAVING abs(
      tender.retained_amount - COALESCE(sum(allocation.amount), 0)
    ) >= 0.01
  ) THEN
    RAISE EXCEPTION 'Tổng allocation không khớp số tiền giữ lại của tender'
      USING ERRCODE = '55000';
  END IF;

  IF v_credit_total > 0 THEN
    SELECT count(*) INTO v_credit_tender_count
    FROM public.invoice_payment_tenders
    WHERE collection_id = v_collection_id AND credit_amount > 0;
    IF v_credit_tender_count = 1 THEN
      SELECT id, payment_id INTO v_tender_id, v_payment_id
      FROM public.invoice_payment_tenders
      WHERE collection_id = v_collection_id AND credit_amount > 0;
    ELSE
      v_tender_id := NULL;
      v_payment_id := NULL;
    END IF;

    INSERT INTO public.customer_credit_lots (
      organization_id, contract_id, source_collection_id, source_tender_id,
      source_payment_id, amount, remaining_amount, status
    ) VALUES (
      v_org, v_invoice.contract_id, v_collection_id, v_tender_id,
      v_payment_id, v_credit_total, v_credit_total, 'ACTIVE'
    ) RETURNING id INTO v_credit_lot_id;

    INSERT INTO public.excess_amounts (
      organization_id, user_id, contract_id, amount, description,
      source_invoice_id, source_payment_id, credit_lot_id
    ) VALUES (
      v_org, v_owner, v_invoice.contract_id, v_credit_total,
      'Tiền thừa từ hóa đơn ' || COALESCE(v_invoice.invoice_number, ''),
      p_invoice_id, v_payment_id, v_credit_lot_id
    ) RETURNING id INTO v_excess_id;

    UPDATE public.customer_credit_lots
       SET source_excess_amount_id = v_excess_id
     WHERE id = v_credit_lot_id;
  END IF;

  PERFORM public.recompute_invoice_for_id(p_invoice_id);
  PERFORM public.recompute_contract_deposit_paid(v_invoice.contract_id);

  SELECT jsonb_build_object(
    'collection_id', v_collection_id,
    'invoice_id', p_invoice_id,
    'gross_amount', v_gross_total,
    'applied_amount', v_applied_total,
    'change_amount', v_change_total,
    'credit_amount', v_credit_total,
    'rounding_amount', v_rounding_total,
    'credit_lot_id', v_credit_lot_id,
    'tenders', v_tender_results,
    'invoice', to_jsonb(invoice_row)
  ) INTO v_response
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id;

  UPDATE app_private.canonical_write_operations
     SET subject_id = v_collection_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'invoice.collection.v5'
     AND subject_scope = p_invoice_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_invoice_collection_v5(
  uuid, date, jsonb, text, boolean, text, text, numeric, text
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_invoice_collection_v5(
  uuid, date, jsonb, text, boolean, text, text, numeric, text
) TO authenticated;

-- ═══ 7. HOÀN TÁC THU TIỀN — LIFO trừ phần nợ kéo suy ra (H1.6) ═══════════════

CREATE OR REPLACE FUNCTION public.reverse_invoice_collection_v5(p_collection_id uuid, p_reversal_date date, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_collection public.invoice_payment_collections%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_org uuid;
  v_authz boolean;
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_tender public.invoice_payment_tenders%ROWTYPE;
  v_allocation record;
  v_reversal_voucher_id uuid;
  v_reversal_item_id uuid;
  v_expense_type_id uuid;
  v_credit_lot public.customer_credit_lots%ROWTYPE;
  v_response jsonb;
  v_reversal_vouchers jsonb := '[]'::jsonb;
  -- Đợt 5
  v_in_place boolean := false;
  v_membership uuid;
  v_block text;
  v_rev_posting uuid;
  v_mode text;
  -- WP2_UNDO_VISIBLE_BOOK: chủ tổ chức / super admin đi thẳng, người còn
  -- lại phải có ÍT NHẤT quan hệ "được nhìn sổ" với từng sổ quỹ nguồn.
  v_book_bypass boolean := false;
  v_tender_building uuid;
  v_book_name text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF p_reversal_date IS NULL OR char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'Ngày hoàn tác hoặc lý do 8-1000 ký tự không hợp lệ'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_collection
  FROM public.invoice_payment_collections
  WHERE id = p_collection_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy collection' USING ERRCODE = '42501';
  END IF;
  IF p_reversal_date < v_collection.collection_date THEN
    RAISE EXCEPTION 'Reversal date cannot be earlier than collection date'
      USING ERRCODE = '22023';
  END IF;
  -- Cận TRÊN: ngày hoàn tác nằm ở tương lai sẽ đóng băng một con số chưa
  -- xảy ra vào invoice_payment_collections.reversal_date và làm mọi báo cáo
  -- theo kỳ đọc sai. 2099-12-31 từng được nhận.
  --
  -- "Hôm nay" đo theo NGÀY CỦA ORG (public.org_today_v1), KHÔNG theo
  -- CURRENT_DATE: phiên Postgres chạy TimeZone=UTC nên từ 00:00 đến 07:00 giờ
  -- VN, CURRENT_DATE vẫn là hôm qua và mọi khoản thu ghi "hôm nay" theo giờ VN
  -- bị coi là tương lai — không hoàn tác được (đo 14/09/2026 00:05 VN).
  IF p_reversal_date > public.org_today_v1(v_collection.organization_id) THEN
    RAISE EXCEPTION 'Ngày hoàn tác không được ở tương lai (hôm nay là %)',
      to_char(public.org_today_v1(v_collection.organization_id), 'DD/MM/YYYY')
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = v_collection.invoice_id
  FOR UPDATE;

  SELECT building_row.organization_id INTO v_org
  FROM public.buildings building_row
  JOIN public.organizations organization_row
    ON organization_row.id = building_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE building_row.id = v_invoice.building_id
    AND building_row.deleted_at IS NULL
  FOR SHARE OF building_row, organization_row;
  IF v_org IS NULL
     OR v_invoice.organization_id <> v_org
     OR v_collection.organization_id <> v_org THEN
    RAISE EXCEPTION 'Collection không thuộc tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);

  -- ĐỢT A (vá sau audit): gate 'thu_tien.undo' bị bỏ kéo theo việc mất luôn
  -- cửa kiểm THÀNH VIÊN, vì authorize_tenant_action_v3 vốn từ chối bằng
  -- MEMBERSHIP_INACTIVE_OR_MISSING. Hệ quả: nhân viên đã bị gỡ khỏi tổ chức
  -- vẫn khớp nhánh "chính người đã thu" (user_id trên phiếu cũ không đổi) và
  -- hoàn tác được khoản thu cũ — JWT Supabase không bị thu hồi khi gỡ
  -- membership. Khôi phục ĐÚNG điều kiện "còn là người của tổ chức", không
  -- khôi phục gate quyền (giữ quyết định #8).
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m0
     WHERE m0.user_id = v_actor AND m0.organization_id = v_org
       AND m0.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Bạn không còn thuộc tổ chức này nên không hoàn tác được khoản thu.'
      USING ERRCODE = '42501';
  END IF;
  -- ĐỢT A: luật huỷ thống nhất (quyết định #8 của chủ 01/08/2026) — huỷ
  -- khoản thu KHÔNG còn hỏi quyền 'thu_tien.undo'. Điều kiện duy nhất là
  -- CHÍNH NGƯỜI ĐÃ THU (hoặc chủ tổ chức / super admin), kiểm ở vòng tender
  -- bên dưới. Cùng một luật cho cả trang Thu tiền lẫn trang Thu chi.

  v_hash := md5(jsonb_build_object(
    'collection_id', p_collection_id,
    'reversal_date', p_reversal_date,
    'reason', v_reason
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    v_org, 'invoice.collection.reverse.v5',
    p_collection_id::text, v_actor, v_key, v_hash
  ) ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
    DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'invoice.collection.reverse.v5'
    AND operation_row.subject_scope = p_collection_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  v_route := app_private.evaluate_feature_route('invoice.collection.reverse.v5', v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer hoàn tác invoice.collection.v5 đang bị đóng băng'
      USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Writer hoàn tác invoice.collection.v5 chưa bật'
      USING ERRCODE = '55000';
  END IF;

  IF v_collection.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Collection đã được hoàn tác' USING ERRCODE = '23505';
  END IF;

  -- Allocation is revenue-first then deposit. Reversing an older collection
  -- would leave newer allocation rows attached to the wrong accounting class.
  -- H1.6 (rà soát 15/09): trừ phần NỢ KÉO SUY RA trước khi so.
  -- invoices.paid_amount không chỉ là tiền thu trực tiếp: recompute_invoice_for_id
  -- cộng thêm phần nợ của hoá đơn này đã được một hoá đơn SAU gánh hộ và trả
  -- xong (previous_debt_sources). expected_paid_amount thì chỉ là ảnh chụp lúc
  -- thu. Nên hoá đơn vừa được thu vừa bị kéo nợ luôn lệch một khoản đúng bằng
  -- phần suy ra, và khoản thu đó KHÔNG BAO GIỜ hoàn tác được — không phải vì có
  -- khoản thu mới hơn, mà vì phép so đang cộng hai nguồn khác loại.
  IF abs(
    COALESCE(v_invoice.paid_amount, 0)
    - app_private.invoice_carried_debt_v1(v_invoice.id)
    - (v_collection.expected_paid_amount + v_collection.applied_amount)
  ) >= 0.01 THEN
    RAISE EXCEPTION 'Phải hoàn tác khoản thu mới hơn trước (thứ tự LIFO)'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_credit_lot
  FROM public.customer_credit_lots lot
  WHERE lot.source_collection_id = p_collection_id
  FOR UPDATE;
  IF FOUND AND v_credit_lot.remaining_amount <> v_credit_lot.amount THEN
    RAISE EXCEPTION 'Credit của collection đã được sử dụng; phải unwind trước khi hoàn tác'
      USING ERRCODE = '55000';
  END IF;

  -- ══ ĐỢT 5: chọn đường ═════════════════════════════════════════════
  -- Chế độ linh hoạt → huỷ tại chỗ. Nhưng kỳ đã đóng thì DỪNG HẲN, không
  -- lặng lẽ rơi về đường sinh phiếu đối ứng: một khoản tiền rời khỏi tháng đã
  -- chia lợi nhuận cho cổ đông phải là quyết định có người ký.
  v_in_place := true;  -- ĐỢT A: phiếu thu luôn huỷ tại chỗ (quyết định #3)

  -- KIỂM KỲ CHO CẢ HAI CHẾ ĐỘ: kỳ đã đóng thì KHÔNG đường nào được đụng,
  -- kể cả đường sinh phiếu đối ứng của chế độ Chuẩn kế toán.
  SELECT m.id INTO v_membership FROM public.organization_memberships m
     WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE'
     LIMIT 1;
  v_book_bypass := public.is_super_admin()
                   OR app_private.is_org_owner_v1(v_org, v_actor);

    FOR v_tender IN
      SELECT * FROM public.invoice_payment_tenders
      WHERE collection_id = p_collection_id
      ORDER BY line_index
    LOOP
      CONTINUE WHEN v_tender.voucher_id IS NULL;
      v_block := app_private.period_block_code_v1(v_tender.voucher_id);
      IF v_block IS NOT NULL THEN
        RAISE EXCEPTION '%',
          CASE v_block
            WHEN 'PROFIT_LOCKED' THEN
              '[PROFIT_LOCKED] Lợi nhuận của tháng chứa khoản thu này đã chốt và đã chia cho cổ đông — hệ thống không tự huỷ khoản thu của tháng đó. Nếu thật sự cần điều chỉnh, hãy liên hệ quản trị để lập phiếu chi đối ứng ở kỳ hiện tại.'
            WHEN 'CASHBOOK_CLOSED' THEN
              '[CASHBOOK_CLOSED] Sổ quỹ chứa khoản thu này đã chốt & bàn giao — kỳ đó khoá vĩnh viễn. Nếu thật sự cần điều chỉnh, hãy liên hệ quản trị để lập phiếu chi đối ứng ở kỳ hiện tại.'
            WHEN 'HANDOVER_LOCKED' THEN
              '[HANDOVER_LOCKED] Phiếu thu này nằm trong một phiên bàn giao đã xác nhận — phải huỷ phiên đó trước (cần cả hai bên đồng ý).'
            ELSE
              '[PERIOD_CLOSED] Kỳ kế toán của khoản thu này đã đóng nên không huỷ được. Nếu thật sự cần điều chỉnh, hãy liên hệ quản trị để lập phiếu chi đối ứng ở kỳ hiện tại.'
          END
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;

  -- Đường CŨ cần hạng mục "Hoàn tác thu tiền"; đường huỷ tại chỗ thì không,
  -- và cố ý KHÔNG tạo hạng mục rác cho tổ chức chưa từng dùng nó.
  IF NOT v_in_place THEN
    SELECT type_row.id INTO v_expense_type_id
    FROM public.income_expense_types type_row
    WHERE type_row.organization_id = v_collection.organization_id
      AND lower(type_row.type) = 'expense'
      AND lower(btrim(type_row.name)) = 'hoàn tác thu tiền'
    LIMIT 1 FOR SHARE;
    IF v_expense_type_id IS NULL THEN
      INSERT INTO public.income_expense_types (
        organization_id, user_id, name, type, description, is_default, is_deposit
      ) VALUES (
        v_collection.organization_id, v_invoice.user_id,
        'Hoàn tác thu tiền', 'expense',
        'Bút toán đối ứng cho collection đã hoàn tác', false, false
      ) RETURNING id INTO v_expense_type_id;
    END IF;
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();

  FOR v_tender IN
    SELECT * FROM public.invoice_payment_tenders
    WHERE collection_id = p_collection_id
    ORDER BY line_index
    FOR UPDATE
  LOOP
    IF v_tender.voucher_id IS NULL THEN
      CONTINUE;
    END IF;

    -- B: toà của CHÍNH tender này (phiếu thu của tender), không phải toà
    -- của hoá đơn. Một collection nhiều tender có thể bắc qua nhiều toà.
    SELECT tender_voucher.building_id INTO v_tender_building
    FROM public.income_expenses tender_voucher WHERE tender_voucher.id = v_tender.voucher_id;
    v_tender_building := COALESCE(v_tender_building, v_invoice.building_id);

    -- ĐỢT A: bỏ gate quyền theo sổ quỹ nguồn (quyết định #8).

    -- A (WP2_UNDO_VISIBLE_BOOK): quyền thôi chưa đủ. Một override cấp
    -- ORGANIZATION phủ MỌI sổ, kể cả sổ người này không giữ, không biết,
    -- không được chia sẻ. Chủ chốt "với việc thu chỉ cần biết sổ là được".
    -- ĐỢT A: bỏ gate "sổ được nhìn" (quyết định #8) — danh tính người thu
    -- đã là điều kiện đủ; không bắt thêm quan hệ với sổ quỹ.

    -- Chỉ CHÍNH NGƯỜI ĐÃ THU được hoàn tác khoản thu đó (yêu cầu của chủ
    -- 30/07). Chủ tổ chức / super admin giữ cửa phụ, nếu không thì khoản
    -- thu của nhân viên đã nghỉ là bất khả hoàn tác vĩnh viễn.
    IF NOT public.is_super_admin()
       AND NOT app_private.is_org_owner_v1(v_collection.organization_id, v_actor)
       AND NOT EXISTS (SELECT 1 FROM public.income_expenses src
                        WHERE src.id = v_tender.voucher_id AND src.user_id = v_actor) THEN
      RAISE EXCEPTION 'Chỉ người đã thu khoản này mới hoàn tác được. Nhờ người thu hoặc chủ tổ chức thực hiện.'
        USING ERRCODE = '42501';
    END IF;

    IF v_in_place THEN
      -- ── HUỶ TẠI CHỖ: không sinh phiếu nào ──────────────────────────
      v_rev_posting := app_private.cancel_collection_voucher_in_place_v1(
        v_tender.voucher_id, v_reason, v_actor, v_membership);
      v_reversal_voucher_id := v_tender.voucher_id;

      v_reversal_vouchers := v_reversal_vouchers || jsonb_build_array(jsonb_build_object(
        'source_voucher_id', v_tender.voucher_id,
        'reversal_voucher_id', NULL,
        'reversal_posting_id', v_rev_posting,
        'mode', 'IN_PLACE_CANCEL',
        'account_id', v_tender.account_id,
        'amount', v_tender.retained_amount
      ));
    ELSE
      -- ── ĐƯỜNG CŨ: sinh phiếu chi đối ứng (chế độ Chuẩn kế toán) ────
      INSERT INTO public.income_expenses (
        user_id, organization_id, type, name, building_id, room_id, contract_id,
        account_id, invoice_id, payment_collection_id, reversal_of_income_expense_id,
        voucher_date, total_amount, approval_status, approved_by, approved_at,
        notes, business_result_accounting, creator_name, system_source,
        idempotency_key, change_amount, change_account_id,
        rounding_amount, rounding_account_id
      ) VALUES (
        v_invoice.user_id, v_collection.organization_id, 'EXPENSE',
        'Hoàn tác thu tiền ' || COALESCE(v_invoice.invoice_number, ''),
        v_invoice.building_id, v_invoice.room_id, v_invoice.contract_id,
        v_tender.account_id, NULL, p_collection_id, v_tender.voucher_id,
        p_reversal_date, v_tender.retained_amount, 'APPROVED', v_actor,
        clock_timestamp(), v_reason, NULL, 'Invoice Collection V5',
        'invoice.collection.reverse.v5', v_key || ':tender:' || v_tender.line_index,
        -v_tender.change_amount, v_tender.change_account_id,
        -v_tender.rounding_amount, v_tender.rounding_account_id
      ) RETURNING id INTO v_reversal_voucher_id;

      FOR v_allocation IN
        SELECT allocation.accounting_class, allocation.amount
        FROM public.invoice_payment_allocations allocation
        WHERE allocation.tender_id = v_tender.id
        ORDER BY allocation.id
      LOOP
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_reversal_voucher_id, v_collection.organization_id, v_expense_type_id,
          CASE v_allocation.accounting_class
            WHEN 'PNL' THEN 'Hoàn tác doanh thu hóa đơn'
            WHEN 'DEPOSIT' THEN 'Hoàn tác tiền cọc'
            WHEN 'CUSTOMER_CREDIT' THEN 'Hoàn tác credit khách hàng'
            ELSE 'Hoàn tác khoản ngoài KQKD'
          END,
          1, v_allocation.amount, v_allocation.amount,
          p_reversal_date, p_reversal_date, v_allocation.accounting_class
        ) RETURNING id INTO v_reversal_item_id;
      END LOOP;

      INSERT INTO app_private.income_expense_flow_ownership (
        income_expense_id, organization_id, flow_kind, flow_version,
        lifecycle_owner, lifecycle_state, writer_operation,
        payload_hash_scheme, payload_hash_value, maker_user_id,
        claimed_by_user_id, correlation_id
      ) VALUES (
        v_reversal_voucher_id, v_collection.organization_id,
        'INVOICE_COLLECTION_REVERSAL_V5', 5,
        'INVOICE_COLLECTION_V5', 'APPROVED', 'invoice.collection.reverse.v5',
        'PG_MD5_JSONB_TEXT_V1', v_hash, v_actor, v_actor, p_collection_id
      ) ON CONFLICT (income_expense_id) DO NOTHING;

      v_reversal_vouchers := v_reversal_vouchers || jsonb_build_array(jsonb_build_object(
        'source_voucher_id', v_tender.voucher_id,
        'reversal_voucher_id', v_reversal_voucher_id,
        'mode', 'COUNTER_VOUCHER',
        'account_id', v_tender.account_id,
        'amount', v_tender.retained_amount
      ));
    END IF;

    -- Hai lệnh dưới đây gánh TIỀN THẬT và phải chạy ở CẢ HAI đường:
    -- recompute_invoice_for_id đọc public.payments (reversed_at IS NULL) chứ
    -- không đọc approval_status của phiếu.
    IF v_tender.payment_id IS NOT NULL THEN
      UPDATE public.payments
         SET reversed_at = clock_timestamp(),
             reversed_by_collection_id = p_collection_id,
             updated_at = now()
       WHERE id = v_tender.payment_id;

      INSERT INTO app_private.payment_reversals (
        original_payment_id, reversal_voucher_id, organization_id, actor_id, reason,
        reversal_kind
      ) VALUES (
        v_tender.payment_id, v_reversal_voucher_id,
        v_collection.organization_id, v_actor, v_reason,
        CASE WHEN v_in_place THEN 'IN_PLACE_CANCEL' ELSE 'COUNTER_VOUCHER' END
      ) ON CONFLICT (original_payment_id) DO NOTHING;
    END IF;
  END LOOP;

  IF v_credit_lot.id IS NOT NULL THEN
    UPDATE public.customer_credit_lots
       SET remaining_amount = 0, status = 'REVERSED', reversed_at = clock_timestamp()
     WHERE id = v_credit_lot.id;

    INSERT INTO public.excess_amounts (
      organization_id, user_id, contract_id, amount, description,
      source_invoice_id, source_payment_id, credit_lot_id
    ) VALUES (
      v_collection.organization_id, v_invoice.user_id, v_collection.contract_id,
      -v_credit_lot.amount, 'Hoàn tác credit collection',
      v_invoice.id, v_credit_lot.source_payment_id, v_credit_lot.id
    );
  END IF;

  UPDATE public.invoice_payment_collections
     SET status = 'REVERSED', reversed_at = clock_timestamp(), reversed_by = v_actor,
         reversal_date = p_reversal_date, reversal_reason = v_reason,
         reversal_idempotency_key = v_key
   WHERE id = p_collection_id;

  PERFORM public.recompute_invoice_for_id(v_invoice.id);
  PERFORM public.recompute_contract_deposit_paid(v_invoice.contract_id);

  v_mode := CASE WHEN v_in_place THEN 'IN_PLACE_CANCEL' ELSE 'COUNTER_VOUCHER' END;

  SELECT jsonb_build_object(
    'collection_id', p_collection_id,
    'status', 'REVERSED',
    'reversal_mode', v_mode,
    'reversal_date', p_reversal_date,
    'reversal_vouchers', v_reversal_vouchers,
    'invoice', to_jsonb(invoice_row)
  ) INTO v_response
  FROM public.invoices invoice_row
  WHERE invoice_row.id = v_invoice.id;

  UPDATE app_private.canonical_write_operations
     SET subject_id = p_collection_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_collection.organization_id
     AND operation = 'invoice.collection.reverse.v5'
     AND subject_scope = p_collection_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_invoice_collection_v5(uuid, date, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_invoice_collection_v5(uuid, date, text, text)
  TO authenticated, service_role;

-- ═══ 8. SỐ HOÁ ĐƠN — năm theo ngày của tổ chức (H1.7) ════════════════════════

CREATE OR REPLACE FUNCTION public.generate_invoice_number_v2()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prefix TEXT;
  v_year   TEXT;
  v_seq    INTEGER;
BEGIN
  IF NEW.invoice_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- H1.7 (rà soát 15/09): NĂM lấy theo ngày của TỔ CHỨC, không theo NOW() của
  -- phiên Postgres. Server chạy UTC nên trong 00:00–07:00 giờ VN ngày 01/01, NOW()
  -- vẫn là 31/12 năm cũ: hoá đơn đầu năm sẽ mang số của năm trước và chen vào
  -- dãy đã dùng hết — đúng bảy giờ mỗi năm, và chỉ lộ ra một lần một năm.
  v_year := TO_CHAR(public.org_today_v1(NEW.organization_id), 'YYYY');

  SELECT COALESCE(value->>'invoice_prefix', 'INV')
    INTO v_prefix
    FROM settings
   WHERE user_id = NEW.user_id AND key = 'invoice_number_format';

  IF v_prefix IS NULL OR v_prefix = '' THEN
    v_prefix := 'INV';
  END IF;

  -- Serialize concurrent inserts sharing the same prefix+year so MAX+1 cannot race.
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number:' || v_prefix || ':' || v_year));

  -- GLOBAL max over "<prefix>-<year>-<digits>" (constraint is global, not per-user).
  SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '(\d+)$') AS INTEGER)), 0) + 1
    INTO v_seq
    FROM invoices
   WHERE invoice_number LIKE (v_prefix || '-' || v_year || '-%')
     AND invoice_number ~ ('^' || v_prefix || '-' || v_year || '-\d+$');

  NEW.invoice_number := v_prefix || '-' || v_year || '-' || LPAD(v_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.generate_invoice_number_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_invoice_number_v2() TO service_role;

-- ═══ 9. THU HỒI QUYỀN CỦA HAI WRITER THU TIỀN ĐÃ NGỪNG DÙNG (H1.7) ═══════════
--
-- record_invoice_payment_v2/_v3 là wrapper tương thích cho client cũ còn cache
-- chữ ký; toàn bộ đường thu tiền thật đã đi record_invoice_collection_v5 từ
-- 21/07/2026 và KHÔNG có chỗ nào trong src/ gọi chúng nữa. Giữ quyền
-- authenticated tức là giữ một cửa thứ hai vào đường tiền, đi vòng qua các
-- gate possession/sổ quỹ mà V5 mới có. v2 đã bị thu hồi từ 20260721100000; v3
-- thì chưa. Các bản `_legacy` thu hồi luôn cho cùng một luật.
--
-- Bọc trong to_regprocedure để idempotent và không phụ thuộc hàm nào còn tồn tại.

DO $revoke_legacy_payment_writers$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.record_invoice_payment_v2(uuid,numeric,public.payment_method,date,text,text)',
    'public.record_invoice_payment_v3(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)',
    'public._record_invoice_payment_v3_legacy(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)',
    'public._reverse_invoice_payment_v3_legacy(uuid,text,text)'
  ] LOOP
    IF to_regprocedure(v_sig) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
        to_regprocedure(v_sig)::regprocedure);
    END IF;
  END LOOP;
END
$revoke_legacy_payment_writers$;

-- ═══ 10. TỰ KIỂM ═════════════════════════════════════════════════════════════
--
-- Bốn khẳng định rẻ, chạy ngay trong migration: nếu một trong số đó sai thì
-- file này đã không làm được việc nó nói, và tốt nhất là abort thay vì để phát
-- hiện ra sau vài tuần.

DO $tu_kiem$
DECLARE
  v_than text;
BEGIN
  -- (a) Hai đường huỷ đều có hàng rào status/paid_amount.
  FOREACH v_than IN ARRAY ARRAY[
    pg_get_functiondef('public.cancel_invoice_v1(uuid)'::regprocedure),
    pg_get_functiondef('public.cancel_invoice_with_credit_v1(uuid,text)'::regprocedure)
  ] LOOP
    IF v_than NOT LIKE '%COALESCE(v_invoice.paid_amount, 0) <> 0%' THEN
      RAISE EXCEPTION 'Đường huỷ hoá đơn vẫn thiếu hàng rào paid_amount. DỪNG.';
    END IF;
  END LOOP;

  -- (b) Nợ kéo chỉ cộng trong cùng tổ chức.
  IF pg_get_functiondef('app_private.invoice_carried_debt_v1(uuid)'::regprocedure)
     NOT LIKE '%carrier.organization_id = inv.organization_id%' THEN
    RAISE EXCEPTION 'Predicate biên giới tổ chức của nợ kéo đã biến mất. DỪNG.';
  END IF;

  -- (c) recompute không còn đoán org bằng org_today_v1(NULL).
  IF pg_get_functiondef('public.recompute_invoice_for_id(uuid)'::regprocedure)
     LIKE '%org_today_v1(NULL)%' THEN
    RAISE EXCEPTION 'recompute vẫn gọi org_today_v1(NULL). DỪNG.';
  END IF;

  -- (d) Cột suy is_overdue đọc được.
  PERFORM 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'is_overdue';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Thiếu cột suy public.is_overdue. DỪNG.';
  END IF;
END
$tu_kiem$;
