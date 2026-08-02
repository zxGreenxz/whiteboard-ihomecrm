-- =====================================================================
-- Đợt 8 — SINH PHIẾU HOÀN CỌC từ nghĩa vụ đã chốt
--
-- Đợt 7 dựng nghĩa vụ ("phải hoàn bao nhiêu, đối chiếu với cọc thật"). File này
-- biến nghĩa vụ thành PHIẾU CHI — vẫn ở trạng thái CHỜ DUYỆT, không tự ra tiền.
--
-- CHỐT CHẶN QUAN TRỌNG NHẤT: nghĩa vụ nào KHÔNG ở trạng thái OK thì phải có
-- `p_force` + lý do, và chỉ CHỦ TỔ CHỨC / super admin mới ép được. Lý do: trên
-- prod có 9 hồ sơ mà số hoàn vượt cọc thật (tổng 13.292.000đ) — nếu writer cứ thế
-- sinh phiếu thì máy biến một lỗi dữ liệu thành một lần chi tiền thật.
--
-- MỘT PHIẾU / MỘT PHIÊN BẢN NGHĨA VỤ: unique index trên (org, obligation_id) chỉ
-- áp cho phiếu chưa huỷ, nên huỷ phiếu rồi sinh lại được.
--
-- KHÔNG tự ghi sổ: phiếu ra UNAPPROVED, cầu a85/a85b hiện có sẽ ghi sổ khi người
-- ta duyệt. Writer này KHÔNG gọi lõi ghi sổ.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.termination_refund_obligations') IS NULL THEN
    RAISE EXCEPTION 'Thiếu termination_refund_obligations — chạy Đợt 7 trước. DỪNG.';
  END IF;
  IF to_regprocedure('app_private.is_org_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu is_org_owner_v1. DỪNG.';
  END IF;
  IF to_regprocedure('app_private.ensure_income_expense_type_v1(uuid,uuid,text,text,text,text,boolean,boolean,boolean,boolean,boolean,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu ensure_income_expense_type_v1. DỪNG.';
  END IF;
END
$preflight$;

ALTER TABLE public.termination_refund_obligations
  ADD COLUMN IF NOT EXISTS voucher_id uuid REFERENCES public.income_expenses(id) ON DELETE SET NULL;

-- Một phiếu sống / một phiên bản nghĩa vụ.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tro_voucher
  ON public.termination_refund_obligations (organization_id, id)
  WHERE voucher_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_termination_refund_voucher_v1(
  p_obligation_id uuid,
  p_account_id    uuid DEFAULT NULL,
  p_force         boolean DEFAULT false,
  p_force_reason  text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_o     public.termination_refund_obligations;
  v_c     public.contracts;
  v_bld   uuid;
  v_acc   uuid;
  v_type  uuid;
  v_ie    uuid;
  v_code  text;
  v_is_owner boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_o FROM termination_refund_obligations
   WHERE id = p_obligation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy nghĩa vụ hoàn' USING ERRCODE='P0002';
  END IF;

  IF v_o.voucher_id IS NOT NULL THEN
    -- Đã sinh rồi: trả lại phiếu cũ thay vì đẻ phiếu thứ hai.
    SELECT code INTO v_code FROM income_expenses WHERE id = v_o.voucher_id;
    RETURN jsonb_build_object('voucherId', v_o.voucher_id, 'code', v_code,
                              'alreadyCreated', true);
  END IF;

  SELECT * INTO v_c FROM contracts WHERE id = v_o.contract_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hợp đồng' USING ERRCODE='P0002'; END IF;
  SELECT r.building_id INTO v_bld FROM rooms r WHERE r.id = v_c.room_id;
  IF v_bld IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng không gắn phòng/toà — không xác định được toà để ghi phiếu'
      USING ERRCODE='22023';
  END IF;

  IF NOT (public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld)
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE='42501';
  END IF;

  IF v_o.requested_amount <= 0 THEN
    RAISE EXCEPTION 'Nghĩa vụ này không phải hoàn tiền (số hoàn %đ) — không sinh phiếu chi.',
      round(v_o.requested_amount)::bigint USING ERRCODE='22023';
  END IF;

  -- ══ CHỐT CHẶN: nghĩa vụ lệch thì phải CHỦ ép, kèm lý do ═══════════
  IF v_o.obligation_status <> 'OK' THEN
    v_is_owner := public.is_super_admin()
               OR app_private.is_org_owner_v1(v_o.organization_id, v_actor);
    IF NOT p_force THEN
      RAISE EXCEPTION
        'Nghĩa vụ này đang cảnh báo [%]: %. Muốn vẫn sinh phiếu thì chủ tổ chức phải ép (p_force) kèm lý do.',
        v_o.obligation_status, COALESCE(v_o.warning,'(không rõ)')
        USING ERRCODE = '55000';
    END IF;
    IF NOT v_is_owner THEN
      RAISE EXCEPTION
        'Chỉ chủ tổ chức hoặc super admin mới ép sinh phiếu hoàn khi nghĩa vụ đang cảnh báo [%].',
        v_o.obligation_status USING ERRCODE = '42501';
    END IF;
    IF COALESCE(length(btrim(p_force_reason)),0) < 8 THEN
      RAISE EXCEPTION 'Ép sinh phiếu phải kèm lý do ít nhất 8 ký tự' USING ERRCODE='22023';
    END IF;
  END IF;

  -- Sổ quỹ: bắt buộc là sổ THẬT (không ảo) — hoàn cọc là tiền ra khỏi két.
  v_acc := p_account_id;
  IF v_acc IS NOT NULL THEN
    PERFORM 1 FROM accounts a
     WHERE a.id = v_acc AND a.deleted_at IS NULL
       AND a.organization_id = v_o.organization_id
       AND NOT COALESCE(a.is_virtual,false);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ không hợp lệ, khác tổ chức, hoặc là SỔ ẢO (hoàn cọc là tiền thật ra khỏi két)'
        USING ERRCODE='22023';
    END IF;
  END IF;

  v_type := app_private.ensure_income_expense_type_v1(
              v_o.organization_id, v_actor, 'Hoàn tiền cọc', 'expense',
              NULL, NULL, false, true, false, false, false, false);

  INSERT INTO income_expenses
    (user_id, organization_id, type, name, building_id, room_id, contract_id,
     voucher_date, total_amount, approval_status, account_id, system_source, notes)
  VALUES
    (v_actor, v_o.organization_id, 'EXPENSE',
     'Hoàn tiền cọc — HĐ ' || COALESCE(v_c.contract_number, left(v_c.id::text,8)),
     v_bld, v_c.room_id, v_o.contract_id,
     public.org_today_v1(v_o.organization_id), v_o.requested_amount,
     'UNAPPROVED', v_acc, 'termination.refund.v2',
     CASE WHEN v_o.obligation_status <> 'OK'
          THEN 'ÉP SINH dù cảnh báo [' || v_o.obligation_status || ']: ' || btrim(p_force_reason)
          ELSE 'Sinh từ nghĩa vụ hoàn cọc đã đối chiếu với cọc thật' END)
  RETURNING id, code INTO v_ie, v_code;

  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, accounting_class,
     description, quantity, unit_price, amount)
  -- accounting_class CHECK chỉ nhận PNL / DEPOSIT / CUSTOMER_CREDIT / INTERNAL.
  -- Hoàn cọc là DEPOSIT (bảng cân đối), KHÔNG phải chi phí kinh doanh (PNL) —
  -- ghi nhầm PNL là thổi phồng chi phí và làm lệch Báo cáo Lợi Nhuận.
  VALUES (v_ie, v_type, 'DEPOSIT', 'Hoàn cọc thanh lý', 1,
          v_o.requested_amount, v_o.requested_amount);

  UPDATE termination_refund_obligations SET voucher_id = v_ie WHERE id = p_obligation_id;

  RETURN jsonb_build_object(
    'voucherId', v_ie, 'code', v_code, 'amount', v_o.requested_amount,
    'obligationStatus', v_o.obligation_status, 'forced', (v_o.obligation_status <> 'OK'),
    'note', 'Phiếu ở trạng thái CHỜ DUYỆT — tiền chỉ ra khỏi két khi có người duyệt.');
END;
$function$;

REVOKE ALL ON FUNCTION public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text) IS
  'Đợt 8: biến nghĩa vụ hoàn thành PHIẾU CHI ở trạng thái CHỜ DUYỆT. Nghĩa vụ không '
  'OK thì phải CHỦ TỔ CHỨC ép kèm lý do — trên prod có 9 hồ sơ số hoàn vượt cọc thật '
  '(13.292.000đ), writer mà cứ thế sinh phiếu là biến lỗi dữ liệu thành lần chi tiền '
  'thật. Sổ quỹ bắt buộc là sổ THẬT. Gọi lại trả phiếu cũ, không đẻ phiếu thứ hai.';

DO $selfcheck$
DECLARE v_code text;
BEGIN
  SELECT lower(regexp_replace(p.prosrc,'--[^\n]*','','g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='create_termination_refund_voucher_v1';
  IF position('is_org_owner_v1' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Không kiểm quyền chủ khi ép sinh phiếu. DỪNG.';
  END IF;
  IF position('is_virtual' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Không chặn sổ ảo — hoàn cọc là tiền thật ra khỏi két. DỪNG.';
  END IF;
  IF position('''unapproved''' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Phiếu không ra ở trạng thái CHỜ DUYỆT. DỪNG.';
  END IF;
  -- Writer này TUYỆT ĐỐI không được tự ghi sổ.
  IF position('post_voucher_with_source' IN v_code) > 0
     OR position('income_expense_postings' IN v_code) > 0 THEN
    RAISE EXCEPTION 'Writer đang tự ghi sổ — phải để người duyệt rồi cầu a85 ghi. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
