-- ============================================================
-- Câu 26 (chủ chốt 21/10/2026) — HOÁ ĐƠN: kiểm quyền ở máy chủ khớp đúng quyền web cho huỷ /
-- khôi phục hoá đơn và hoàn tiền hoá đơn. Dùng app_private.require_building_perm_v1 của
-- 20261021180057_contract_lifecycle_permission_guard_v1 (áp file đó TRƯỚC).
--
-- LỖ (đọc pg_get_functiondef + catalog production 22/10/2026, chỉ đọc)
--   * Huỷ / khôi phục: web gác bằng canUse(perms,'invoices','cancel') || canUse(perms,'invoices','delete')
--     (InvoicesPage, InvoiceDetailView, InvoiceListTable, huỷ hàng loạt), máy chủ chỉ hỏi invoices.edit
--     (app_private.can_edit_invoice_building_v1) ở cancel_invoice_with_credit_v1 (web), cancel_invoice_v1,
--     restore_invoice_with_credit_v1 (web), restore_invoice_v1 (authenticated gọi thẳng được).
--     Thêm nữa: PATCH bảng invoices (RLS invoices.edit) đổi được hoá đơn NHÁP sang CANCELLED, lách
--     invoices.cancel (hoá đơn đã phát hành hiện bị guard_paid_invoice_direct_adjustment chặn mọi
--     PATCH do cột sinh remaining_amount — hệ quả phụ, không phải rào có chủ ý; đo TEST 22/10). Web
--     không ghi thẳng status CANCELLED ở đâu cả (chỉ đi RPC).
--   * Hoàn tiền: web gác nút "Hoàn trả khách" bằng canUse(perms,'invoices','record_payment');
--     create_invoice_refund_obligation_v2 chỉ đòi là thành viên ACTIVE của công ty (audit K11-05)
--     ⇒ vai chỉ-xem cũng sinh được phiếu CHI chờ duyệt (REFUND_CONTRA_REVENUE trừ KQKD) cho hoá đơn
--     ở toà mình không được giao.
--
-- ĐO PRODUCTION 90 NGÀY (23/07–22/10/2026, chỉ đọc, chỉ đếm; chi tiết theo vai ở mô tả PR)
--   Huỷ hoá đơn 43 lần (gồm cả hoá đơn do thanh lý bỏ cọc tự huỷ), khôi phục 5 lần — người làm là
--   Quản lý toà / Chủ sở hữu (+ super admin), đều có invoices.cancel. Với 13 membership ACTIVE:
--   phạm vi invoices.edit ⊆ invoices.cancel, invoices.delete ⊆ invoices.cancel ⇒ 0 người hợp lệ bị chặn
--   nhầm. Hoàn tiền hoá đơn (system_source invoice.refund): 0 lần trong 90 ngày.
--
-- VÁ
--   1. Hàm kiểm quyền dùng chung app_private.require_building_perm_v1: ở migration hợp đồng.
--   2. Năm hàm: chèn MỘT dòng PERFORM app_private.require_building_perm_v1(toà hoá đơn, việc, khoá…)
--      ngay sau rào quyền cũ (dấu "[q26] kiểm quyền máy chủ khớp web"): huỷ/khôi phục đòi
--      invoices.cancel HOẶC invoices.delete (đúng như web); hoàn tiền đòi invoices.record_payment
--      ở đúng toà của hoá đơn. Phần còn lại giữ nguyên từng chữ bản production (ghim md5 ở tiền kiểm);
--      chữ ký, kiểu trả về, ACL không đổi. Rào cũ giữ nguyên — chỉ thêm điều kiện.
--   3. Trigger a01_invoice_cancel_status_guard (BEFORE UPDATE OF status, WHEN current_user IN
--      ('authenticated','anon')): đường REST không đổi status vào/ra CANCELLED. Writer SECURITY
--      DEFINER (RPC huỷ/khôi phục, thanh lý bỏ cọc huỷ hoá đơn còn nợ, super admin huỷ cưỡng bức) và
--      service_role đi thẳng như cũ. Các lần đổi status khác qua REST (APPROVED/DRAFT/OVERDUE của hook
--      cũ) không bị chạm.
--
-- KHÔNG ĐỔI (ngoài phạm vi câu 26)
--   Xoá mềm hoá đơn (soft_delete_*), sửa/điều chỉnh, thu tiền, hoàn tác thu; PATCH status hoá đơn
--   NHÁP sang trạng thái khác CANCELLED (APPROVED/PAID…; production hiện 0 hoá đơn NHÁP) — ghi ở mô
--   tả PR là lỗ còn mở, chờ chủ quyết.
--
-- ĐƯỜNG LÙI (một forward migration khác, không phá dữ liệu)
--   DROP TRIGGER IF EXISTS a01_invoice_cancel_status_guard ON public.invoices;
--   CREATE OR REPLACE năm hàm bằng thân production = thân trong file này bỏ đúng các dòng mang dấu
--   [q26] (md5 ở tiền kiểm); rồi DROP FUNCTION app_private.guard_invoice_cancel_status_v1().
-- ============================================================

DO $can$
BEGIN
  IF to_regprocedure('app_private.require_building_perm_v1(uuid, text, text[])') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.require_building_perm_v1 — áp 20261021180057_contract_lifecycle_permission_guard_v1 trước. DỪNG.'
      USING ERRCODE = '55000';
  END IF;
END
$can$;

-- 0. Tiền kiểm — không vá mù lên định nghĩa lạ. md5 = pg_get_functiondef đọc trên production
--    (chỉ đọc, 22/10/2026); TEST cùng md5. Bản đã mang dấu [q26] (lượt chạy lại) thì replace lại y hệt.
DO $preflight$
DECLARE
  r record;
  v_def text;
BEGIN
  IF to_regprocedure('public.can_do_on_building(text, text, uuid)') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu helper quyền (can_do_on_building / is_super_admin / auth.uid) — DỪNG.' USING ERRCODE = '55000';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('public.cancel_invoice_with_credit_v1(uuid, text)', 'db997eae3f74ac9081a50e1ae1de270e'),
    ('public.cancel_invoice_v1(uuid)', '893b07386f21b0801fd8c00a7a903e3c'),
    ('public.restore_invoice_with_credit_v1(uuid, text)', '29730718fbd454d002fe2cdec086f28c'),
    ('public.restore_invoice_v1(uuid)', '2e6c95b7a924c83edaae8412d1e25d6d'),
    ('public.create_invoice_refund_obligation_v2(uuid, numeric, text, text, text)', '36ad0e4f45d14c15d67624a7c751ff67')
  ) AS t(sig, md5) LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'Thiếu hàm % — DỪNG.', r.sig USING ERRCODE = '55000';
    END IF;
    v_def := pg_get_functiondef(to_regprocedure(r.sig));
    IF position('[q26] kiểm quyền máy chủ khớp web' IN v_def) > 0 THEN
      CONTINUE;
    END IF;
    IF md5(v_def) <> r.md5 THEN
      RAISE EXCEPTION '% KHÁC bản đã đối chiếu (md5 %, chờ %) — DỪNG, đọc pg_get_functiondef trước khi replace.', r.sig, md5(v_def), r.md5
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$preflight$;


-- 2.1 public.cancel_invoice_with_credit_v1: thêm 'invoices.cancel' (thân production giữ nguyên từng chữ, md5 db997eae…)
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
  -- RENT_SUPPORT_LIFECYCLE_LOCK_V1
  PERFORM app_private.invoice_rent_support_lock_v1(p_invoice_id);
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
  PERFORM app_private.require_building_perm_v1(v_invoice.building_id, 'huỷ hoá đơn', 'invoices.cancel', 'invoices.delete'); -- [q26] kiểm quyền máy chủ khớp web
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

-- 2.2 public.cancel_invoice_v1: thêm 'invoices.cancel' (thân production giữ nguyên từng chữ, md5 893b0738…)
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
  -- RENT_SUPPORT_LIFECYCLE_LOCK_V1
  PERFORM app_private.invoice_rent_support_lock_v1(p_invoice_id);
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
  PERFORM app_private.require_building_perm_v1(v_invoice.building_id, 'huỷ hoá đơn', 'invoices.cancel', 'invoices.delete'); -- [q26] kiểm quyền máy chủ khớp web
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

-- 2.3 public.restore_invoice_with_credit_v1: thêm 'invoices.cancel' (thân production giữ nguyên từng chữ, md5 29730718…)
CREATE OR REPLACE FUNCTION public.restore_invoice_with_credit_v1(p_invoice_id uuid, p_idempotency_key text)
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
  v_active_count integer;
  v_restore_amount numeric(15,2);
  v_restore_fingerprint text;
  v_apply_key text;
  v_credit jsonb;
BEGIN
  -- RENT_SUPPORT_LIFECYCLE_LOCK_V1
  PERFORM app_private.invoice_rent_support_lock_v1(p_invoice_id);
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
    RAISE EXCEPTION 'Missing permission to restore invoice'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.require_building_perm_v1(v_invoice.building_id, 'khôi phục hoá đơn đã huỷ', 'invoices.cancel', 'invoices.delete'); -- [q26] kiểm quyền máy chủ khớp web
  IF v_invoice.status = 'APPROVED' THEN
    RETURN jsonb_build_object(
      'invoice', to_jsonb(v_invoice),
      'credit', NULL,
      'noop', true
    );
  END IF;
  IF v_invoice.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Only cancelled invoices can be restored'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_active_count
  FROM public.customer_credit_applications application_row
  WHERE application_row.invoice_id = p_invoice_id
    AND application_row.reversed_at IS NULL;

  SELECT COALESCE(sum(application_row.amount), 0)::numeric(15,2),
         md5(COALESCE(string_agg(
           application_row.id::text, ',' ORDER BY application_row.id
         ), ''))
    INTO v_restore_amount, v_restore_fingerprint
  FROM public.customer_credit_applications application_row
  WHERE application_row.invoice_id = p_invoice_id
    AND application_row.reversed_at IS NOT NULL
    AND application_row.restored_at IS NULL;

  IF v_active_count > 0 AND v_restore_amount > 0 THEN
    RAISE EXCEPTION 'Invoice has mixed active and pending-restoration credit applications'
      USING ERRCODE = '55000';
  END IF;

  IF v_restore_amount > 0 THEN
    IF v_contract_id IS NULL THEN
      RAISE EXCEPTION 'Credit invoice has no contract' USING ERRCODE = '55000';
    END IF;
    v_apply_key := left(v_key, 150) || ':cycle:' || v_restore_fingerprint;
    v_credit := app_private.apply_customer_credit_fifo_v1(
      v_actor, v_contract_id, v_restore_amount, p_invoice_id,
      'INVOICE_DISCOUNT',
      'Reapply customer credit while restoring invoice', v_apply_key
    );
  ELSE
    v_credit := jsonb_build_object(
      'invoice_id', p_invoice_id,
      'applied_amount', 0,
      'applications', '[]'::jsonb
    );
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();
  IF v_restore_amount > 0 THEN
    UPDATE public.customer_credit_applications
       SET restored_at = clock_timestamp(),
           restored_by = v_actor,
           restoration_idempotency_key = v_apply_key
     WHERE invoice_id = p_invoice_id
       AND reversed_at IS NOT NULL
       AND restored_at IS NULL;
  END IF;

  UPDATE public.invoices
     SET status = 'APPROVED',
         approved_at = clock_timestamp(),
         approved_by = v_actor
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

-- 2.4 public.restore_invoice_v1: thêm 'invoices.cancel' (thân production giữ nguyên từng chữ, md5 2e6c95b7…)
CREATE OR REPLACE FUNCTION public.restore_invoice_v1(p_invoice_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice public.invoices%ROWTYPE;
BEGIN
  -- RENT_SUPPORT_LIFECYCLE_LOCK_V1
  PERFORM app_private.invoice_rent_support_lock_v1(p_invoice_id);
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
    RAISE EXCEPTION 'Missing permission to restore invoice'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.require_building_perm_v1(v_invoice.building_id, 'khôi phục hoá đơn đã huỷ', 'invoices.cancel', 'invoices.delete'); -- [q26] kiểm quyền máy chủ khớp web
  IF EXISTS (
    SELECT 1 FROM public.customer_credit_applications application_row
    WHERE application_row.invoice_id = p_invoice_id
  ) THEN
    RAISE EXCEPTION 'Use restore_invoice_with_credit_v1 for this invoice'
      USING ERRCODE = '55000';
  END IF;
  IF v_invoice.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Only cancelled invoices can be restored'
      USING ERRCODE = '55000';
  END IF;
  UPDATE public.invoices
     SET status = 'APPROVED',
         approved_at = clock_timestamp(),
         approved_by = v_actor
   WHERE id = p_invoice_id
   RETURNING * INTO v_invoice;
  RETURN v_invoice;
END;
$function$;

-- 2.5 public.create_invoice_refund_obligation_v2: thêm 'invoices.record_payment' (thân production giữ nguyên từng chữ, md5 36ad0e4f…)
CREATE OR REPLACE FUNCTION public.create_invoice_refund_obligation_v2(p_invoice_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_refund_class text DEFAULT 'REFUND_CONTRA_REVENUE'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_org uuid; v_building uuid; v_actor record; v_result jsonb;
BEGIN
  SELECT i.organization_id, i.building_id INTO v_org, v_building
  FROM public.invoices i WHERE i.id = p_invoice_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Invoice không tồn tại' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_org);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'Không có membership active trong organization invoice' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.require_building_perm_v1(v_building, 'hoàn tiền hoá đơn', 'invoices.record_payment'); -- [q26] kiểm quyền máy chủ khớp web
  v_result := app_private.reserve_invoice_refund_obligation_v2(
    v_org, p_invoice_id, v_building, p_amount, p_refund_class, 'invoice.refund',
    v_actor.user_id, v_actor.membership_id,
    COALESCE(p_idempotency_key, 'refund:' || p_invoice_id::text || ':' || md5(p_amount::text || COALESCE(p_reason,''))));
  IF p_reason IS NOT NULL AND (v_result ? 'voucher_id') THEN
    UPDATE public.income_expenses SET notes = COALESCE(notes,'') || E'\n[Lý do hoàn] ' || p_reason
    WHERE id = (v_result->>'voucher_id')::uuid;
  END IF;
  RETURN v_result;
END
$function$;

-- 3. Huỷ / khôi phục hoá đơn qua REST (PATCH invoices.status bằng JWT): RLS chỉ đòi invoices.edit.
--    Hoá đơn NHÁP (chưa thu, chưa điều chỉnh) không bị guard_paid_invoice_direct_adjustment canh
--    ⇒ PATCH thẳng NHÁP→CANCELLED lách invoices.cancel. Hoá đơn đã phát hành hiện bị guard đó chặn
--    MỌI PATCH (đo TEST 22/10: cả notes=notes cũng 42501, vì cột sinh remaining_amount làm NEW khác
--    OLD trong trigger BEFORE) — hệ quả phụ, không phải rào có chủ ý. Web chỉ huỷ / khôi phục qua
--    RPC ⇒ chặn tường minh mọi lần đổi trạng thái vào/ra CANCELLED trên đường REST. WHEN chỉ khớp
--    vai authenticated/anon: writer SECURITY DEFINER (RPC huỷ, thanh lý bỏ cọc huỷ hoá đơn còn nợ,
--    super admin huỷ cưỡng bức) và service_role đi thẳng như cũ.
CREATE OR REPLACE FUNCTION app_private.guard_invoice_cancel_status_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF (NEW.status::text = 'CANCELLED') IS DISTINCT FROM (OLD.status::text = 'CANCELLED') THEN
    RAISE EXCEPTION '[HOA_DON_HUY_QUA_RPC] Không huỷ / khôi phục hoá đơn % bằng cách sửa thẳng trạng thái. Dùng nút Huỷ / Khôi phục trên trang Hoá đơn.',
      coalesce(OLD.invoice_number, left(OLD.id::text, 8))
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION app_private.guard_invoice_cancel_status_v1() IS
  'Trigger a01 trên invoices (chỉ đường REST: WHEN current_user là authenticated/anon): chặn đổi status vào/ra CANCELLED — 42501 [HOA_DON_HUY_QUA_RPC]; huỷ/khôi phục phải qua RPC (đã kiểm invoices.cancel). Writer SECURITY DEFINER và service_role không bị ảnh hưởng. Câu 26, 22/10/2026.';

REVOKE ALL ON FUNCTION app_private.guard_invoice_cancel_status_v1() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a01_invoice_cancel_status_guard ON public.invoices;
CREATE TRIGGER a01_invoice_cancel_status_guard
  BEFORE UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (current_user IN ('authenticated', 'anon'))
  EXECUTE FUNCTION app_private.guard_invoice_cancel_status_v1();

-- 4. Tự kiểm (chỉ catalog — chạy được trên database rỗng của Restore Drill).
DO $sau$
DECLARE
  r record;
  v_def text;
  v_n int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.cancel_invoice_with_credit_v1(uuid, text)', '''invoices.cancel'', ''invoices.delete'''),
    ('public.cancel_invoice_v1(uuid)', '''invoices.cancel'', ''invoices.delete'''),
    ('public.restore_invoice_with_credit_v1(uuid, text)', '''invoices.cancel'', ''invoices.delete'''),
    ('public.restore_invoice_v1(uuid)', '''invoices.cancel'', ''invoices.delete'''),
    ('public.create_invoice_refund_obligation_v2(uuid, numeric, text, text, text)', '''invoices.record_payment''')
  ) AS t(sig, perm) LOOP
    v_def := pg_get_functiondef(to_regprocedure(r.sig));
    IF (length(v_def) - length(replace(v_def, '[q26] kiểm quyền máy chủ khớp web', ''))) / length('[q26] kiểm quyền máy chủ khớp web') <> 1
       OR position('app_private.require_building_perm_v1(' IN v_def) = 0
       OR position(r.perm || ');' IN v_def) = 0 THEN
      RAISE EXCEPTION '% chưa có đúng một dòng kiểm % [q26]', r.sig, r.perm USING ERRCODE = '55000';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(r.sig)) THEN
      RAISE EXCEPTION '% phải SECURITY DEFINER', r.sig USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF has_function_privilege('authenticated', 'app_private.guard_invoice_cancel_status_v1()', 'EXECUTE')
     OR has_function_privilege('anon', 'app_private.guard_invoice_cancel_status_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated còn EXECUTE trên guard_invoice_cancel_status_v1' USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_trigger t
   WHERE NOT t.tgisinternal
     AND t.tgrelid = 'public.invoices'::regclass
     AND t.tgname = 'a01_invoice_cancel_status_guard'
     AND t.tgfoid = 'app_private.guard_invoice_cancel_status_v1()'::regprocedure
     AND t.tgenabled = 'O'
     AND position('BEFORE UPDATE OF status ON public.invoices' IN pg_get_triggerdef(t.oid)) > 0
     AND position('WHEN ((CURRENT_USER = ANY (ARRAY[''authenticated''::name, ''anon''::name])))' IN pg_get_triggerdef(t.oid)) > 0;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Thiếu trigger a01_invoice_cancel_status_guard (BEFORE UPDATE OF status; WHEN chỉ authenticated/anon; đang bật)' USING ERRCODE = '55000';
  END IF;
END
$sau$;
