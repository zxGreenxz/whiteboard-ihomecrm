-- Existing refund guards and natural claim locks remain in one shared creation implementation.
BEGIN;
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)'::regprocedure)) NOT IN ('cdc2896ff50e836cb782219683ba5474','79dda3e01cdcdee2d36d55dd7a7df670') THEN RAISE EXCEPTION 'Refund writer definition drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)'::regprocedure AND (proowner<>'postgres'::regrole OR EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee NOT IN ('postgres'::regrole,'authenticated'::regrole,'service_role'::regrole) OR a.is_grantable))) THEN RAISE EXCEPTION 'Refund legacy owner/ACL drift'; END IF;
 IF to_regprocedure('app_private.create_termination_refund_voucher_with_recipient_v1(uuid,uuid,boolean,text,text,text,text)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('app_private.create_termination_refund_voucher_with_recipient_v1(uuid,uuid,boolean,text,text,text,text)')))<>'9d0ce57d4ccc0818bbdc5aa09e3b56ca' THEN RAISE EXCEPTION 'Refund core definition drift'; END IF;
 IF to_regprocedure('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text,text,text,text)') IS NOT NULL AND md5(pg_get_functiondef(to_regprocedure('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text,text,text,text)')))<>'0409f151a3cf489c8977307892c6c6ad' THEN RAISE EXCEPTION 'Refund recipient writer definition drift'; END IF;
 IF md5(pg_get_functiondef('public.read_contract_settlement_create_source_v1(uuid,text,uuid,numeric)'::regprocedure))<>'f8acf6adaa1e8da590c373735fb4768c' THEN RAISE EXCEPTION 'Refund source reader definition drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.create_termination_refund_voucher_with_recipient_v1(uuid,uuid,boolean,text,text,text,text)') AND (proowner<>'postgres'::regrole OR EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee<>'postgres'::regrole OR a.is_grantable))) THEN RAISE EXCEPTION 'Refund core owner/ACL drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text,text,text,text)') AND (proowner<>'postgres'::regrole OR EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee NOT IN ('postgres'::regrole,'authenticated'::regrole) OR a.is_grantable))) THEN RAISE EXCEPTION 'Refund recipient owner/ACL drift'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION app_private.create_termination_refund_voucher_with_recipient_v1(p_obligation_id uuid, p_account_id uuid, p_force boolean, p_force_reason text, p_recipient_name text, p_recipient_bank text, p_recipient_account text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_o     public.termination_refund_obligations;
  v_c     public.contracts;
  v_tstatus text;
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

  -- Khoá HỒ SƠ: tuần tự hoá mọi lần sinh phiếu trên cùng hồ sơ (kể cả khi hai
  -- người gọi trên HAI phiên bản nghĩa vụ khác nhau), và đọc status dưới khoá.
  SELECT status INTO v_tstatus FROM contract_terminations
   WHERE id = v_o.termination_id FOR UPDATE;
  IF v_tstatus IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy hồ sơ thanh lý của nghĩa vụ này' USING ERRCODE='P0002';
  END IF;

  -- F3: hồ sơ CHƯA DUYỆT thì không có phiếu chi. DRAFT/PENDING_APPROVAL sửa
  -- được số ⇒ phiếu sinh lúc này là chi theo một con số chưa ai chốt.
  IF v_tstatus NOT IN ('APPROVED','COMPLETED') THEN
    RAISE EXCEPTION
      'Hồ sơ thanh lý đang ở trạng thái % — phải được duyệt (APPROVED/COMPLETED) rồi mới sinh phiếu hoàn.',
      v_tstatus USING ERRCODE='55000';
  END IF;

  -- F2a: gỡ link tới phiếu đã HUỶ/XOÁ ở mọi phiên bản nghĩa vụ của hồ sơ này.
  -- Không có bước này thì khoá "một phiếu sống một hồ sơ" bên dưới sẽ giết luôn
  -- đường nghiệp vụ hợp lệ "huỷ phiếu sai rồi sinh lại phiếu mới".
  UPDATE termination_refund_obligations o
     SET voucher_id = NULL
   WHERE o.organization_id = v_o.organization_id
     AND o.termination_id  = v_o.termination_id
     AND o.voucher_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM income_expenses ie
                  WHERE ie.id = o.voucher_id
                    AND (ie.approval_status = 'CANCELLED' OR ie.deleted_at IS NOT NULL));

  -- F2b: hồ sơ đã có phiếu SỐNG ở BẤT KỲ phiên bản nghĩa vụ nào ⇒ trả phiếu đó,
  -- tuyệt đối không đẻ phiếu thứ hai. (Bản cũ chỉ nhìn voucher_id của CHÍNH
  -- phiên bản đang gọi — record thêm version mới là lách qua được.)
  SELECT o.voucher_id, ie.code INTO v_ie, v_code
    FROM termination_refund_obligations o
    JOIN income_expenses ie ON ie.id = o.voucher_id
   WHERE o.organization_id = v_o.organization_id
     AND o.termination_id  = v_o.termination_id
     AND o.voucher_id IS NOT NULL
   ORDER BY o.version DESC
   LIMIT 1;
  IF v_ie IS NOT NULL THEN
    RETURN jsonb_build_object('voucherId', v_ie, 'code', v_code,
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

  -- F1: 'termination.refund' — ĐÚNG chuỗi mà ô KPI /deposits,
  -- useDepositDashboard, useContractDetailData và voucherSources đang lọc.
  -- Chuỗi cũ 'termination.refund.v2' không màn nào đọc ⇒ tiền ra khỏi két mà
  -- mọi báo cáo vẫn nói "chưa hoàn".
  INSERT INTO income_expenses
    (user_id, organization_id, type, name, building_id, room_id, contract_id,
     voucher_date, total_amount, approval_status, account_id, system_source, payer_name, receive_bank_name, receive_bank_account, notes)
  VALUES
    (v_actor, v_o.organization_id, 'EXPENSE',
     'Hoàn tiền cọc — HĐ ' || COALESCE(v_c.contract_number, left(v_c.id::text,8)),
     v_bld, v_c.room_id, v_o.contract_id,
     public.org_today_v1(v_o.organization_id), v_o.requested_amount,
     'UNAPPROVED', v_acc, 'termination.refund', nullif(btrim(p_recipient_name),''), nullif(btrim(p_recipient_bank),''), nullif(btrim(p_recipient_account),''),
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

ALTER FUNCTION app_private.create_termination_refund_voucher_with_recipient_v1(uuid,uuid,boolean,text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.create_termination_refund_voucher_with_recipient_v1(uuid,uuid,boolean,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role,ie_action_snapshot_reader;
CREATE OR REPLACE FUNCTION public.create_termination_refund_voucher_v1(p_obligation_id uuid,p_account_id uuid DEFAULT NULL,p_force boolean DEFAULT false,p_force_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private
AS $legacy$ SELECT app_private.create_termination_refund_voucher_with_recipient_v1(p_obligation_id,p_account_id,p_force,p_force_reason,NULL,NULL,NULL); $legacy$;
ALTER FUNCTION public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text) OWNER TO postgres;
CREATE OR REPLACE FUNCTION public.create_termination_refund_voucher_v1(p_obligation_id uuid,p_account_id uuid,p_force boolean,p_force_reason text,p_recipient_name text,p_recipient_bank text,p_recipient_account text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private
AS $recipient$
DECLARE v_org uuid;v_termination uuid;v_source jsonb;
BEGIN
 SELECT organization_id,termination_id INTO v_org,v_termination FROM public.termination_refund_obligations WHERE id=p_obligation_id;
 IF v_org IS NULL THEN RAISE EXCEPTION 'Nghĩa vụ hoàn chưa sẵn sàng' USING ERRCODE='42501'; END IF;
 -- Public reader switches to the non-bypass role and checks the actual source RLS.
 v_source:=public.read_contract_settlement_create_source_v1(v_org,'termination_refund',v_termination,NULL);
 IF NOT coalesce((v_source->>'canCreate')::boolean,false) OR coalesce((v_source->>'hiddenExisting')::boolean,true) THEN RAISE EXCEPTION 'Nguồn hoàn chưa sẵn sàng để lập phiếu' USING ERRCODE='42501'; END IF;
 RETURN app_private.create_termination_refund_voucher_with_recipient_v1(p_obligation_id,p_account_id,p_force,p_force_reason,p_recipient_name,p_recipient_bank,p_recipient_account);
END $recipient$;
ALTER FUNCTION public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text,text,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text,text,text,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
