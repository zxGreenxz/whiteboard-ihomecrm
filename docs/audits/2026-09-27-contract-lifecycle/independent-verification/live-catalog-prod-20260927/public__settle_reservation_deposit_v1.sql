-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.settle_reservation_deposit_v1(p_input jsonb) md5(prosrc)=14935bc556d03a404df71ab6b1aea3bf
CREATE OR REPLACE FUNCTION public.settle_reservation_deposit_v1(p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE v public.income_expenses; s public.reservation_deposit_settlements; basis jsonb; preview jsonb;
  refund_attachments text[]; refund_vid uuid; sid uuid:=gen_random_uuid(); rev uuid; offid uuid; acc uuid;
  refund numeric; retained numeric; mode text; day date; reason text; reason_text text;
  key text; request_hash text; fingerprint text; mid uuid;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Dữ liệu xử lý cọc không hợp lệ' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM public.income_expenses WHERE id=(p_input->>'voucherId')::uuid;
  IF NOT FOUND OR NOT app_private.reservation_settlement_can_read_v1(v.organization_id,v.building_id) THEN
    RAISE EXCEPTION 'Không có quyền xử lý phiếu cọc này' USING ERRCODE='42501';
  END IF;
  -- Same ordering as create_contract_v2: room -> organization -> source receipt.
  PERFORM 1 FROM public.rooms WHERE id=v.room_id FOR NO KEY UPDATE;
  PERFORM app_private.reservation_settlement_authorize_v1(v.id);
  SELECT * INTO v FROM public.income_expenses WHERE id=v.id FOR UPDATE;
  PERFORM app_private.reservation_settlement_authorize_v1(v.id);
  PERFORM 1 FROM public.income_expense_types t JOIN public.income_expense_items i ON i.income_expense_type_id=t.id
    WHERE i.income_expense_id=v.id FOR SHARE OF t;
  key:=btrim(p_input->>'idempotencyKey'); request_hash:=md5((p_input-'idempotencyKey')::text);
  IF key IS NULL OR length(key) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'Mã yêu cầu không hợp lệ' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE source_voucher_id=v.id FOR UPDATE;
  IF FOUND THEN
    IF s.request_hash IS DISTINCT FROM request_hash THEN RAISE EXCEPTION 'Phiếu cọc đã xử lý với nội dung khác; hãy tải lại' USING ERRCODE='55000'; END IF;
    IF p_input->>'refundMode'='NOW' THEN
      SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
      PERFORM app_private.assert_cashbook_access_v2(s.organization_id,(p_input->>'refundAccountId')::uuid,'CUSTODIAN',mid);
    END IF;
    RETURN app_private.reservation_settlement_json_v1(s.id);
  END IF;
  IF EXISTS(SELECT 1 FROM public.reservation_deposit_settlements WHERE organization_id=v.organization_id AND idempotency_key=key) THEN
    RAISE EXCEPTION 'Mã yêu cầu đã dùng cho phiếu khác' USING ERRCODE='22023';
  END IF;
  refund_attachments:=app_private.reservation_refund_attachments_v1(p_input,v.organization_id);
  IF cardinality(refund_attachments)>0 AND p_input->>'refundMode' IS DISTINCT FROM 'NOW' THEN
    RAISE EXCEPTION 'Chỉ thêm ảnh chứng từ khi hoàn tiền ngay' USING ERRCODE='22023';
  END IF;
  preview:=public.preview_reservation_settlement_v1(v.id);
  IF NOT (preview->>'canSettle')::boolean THEN
    RAISE EXCEPTION 'Phiếu cọc chưa nhận tiền, đã được dùng hoặc đang ở kỳ khóa; hãy tải lại' USING ERRCODE='55000',DETAIL=(preview->'blockers')::text;
  END IF;
  basis:=app_private.reservation_settlement_basis_v1(v.id); fingerprint:=p_input->>'basisFingerprint';
  IF fingerprint IS DISTINCT FROM basis->>'fingerprint' THEN
    RAISE EXCEPTION 'Phiếu cọc đã thay đổi; hãy tải lại trước khi xử lý' USING ERRCODE='40001';
  END IF;
  refund:=(p_input->>'refundAmount')::numeric; mode:=p_input->>'refundMode'; day:=(p_input->>'settlementDate')::date;
  reason:=p_input->>'reasonCode'; reason_text:=btrim(COALESCE(p_input->>'reasonText',''));
  IF refund IS NULL OR refund::text IN ('NaN','Infinity','-Infinity') OR refund<0 OR refund>(basis->>'amount')::numeric OR refund<>trunc(refund)
    OR (refund=0 AND mode IS DISTINCT FROM 'NONE') OR (refund>0 AND COALESCE(mode,'') NOT IN ('NOW','LATER'))
    OR (mode<>'NOW' AND NULLIF(p_input->>'refundAccountId','') IS NOT NULL) THEN
    RAISE EXCEPTION 'Số tiền hoặc cách hoàn cọc không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF day IS NULL OR day<v.voucher_date OR day>public.org_today_v1(v.organization_id)
    OR NOT app_private.finance_v2_is_recognition_period_open(v.organization_id,day) THEN
    RAISE EXCEPTION 'Ngày xử lý cọc không hợp lệ hoặc kỳ đã khóa' USING ERRCODE='55000';
  END IF;
  IF COALESCE(reason,'') NOT IN ('CHANGED_MIND','NO_SHOW','OTHER') OR (reason='OTHER' AND length(reason_text)=0) OR length(reason_text)>2000 THEN
    RAISE EXCEPTION 'Vui lòng nhập lý do bỏ cọc hợp lệ' USING ERRCODE='22023';
  END IF;
  retained:=(basis->>'amount')::numeric-refund;
  IF retained>0 THEN rev:=gen_random_uuid(); offid:=gen_random_uuid(); END IF;
  INSERT INTO app_private.reservation_settlement_write_tokens(settlement_id,xid) VALUES(sid,pg_current_xact_id());
  INSERT INTO public.reservation_deposit_settlements(id,organization_id,source_voucher_id,building_id,room_id,
    deposit_amount,retained_amount,refund_amount,settlement_date,reason_code,reason_text,created_by,basis_fingerprint,
    request_hash,idempotency_key,revenue_voucher_id,offset_voucher_id)
  VALUES(sid,v.organization_id,v.id,v.building_id,v.room_id,(basis->>'amount')::numeric,retained,refund,day,reason,reason_text,
    auth.uid(),fingerprint,request_hash,key,rev,offid);
  IF retained>0 THEN
    acc:=app_private.reservation_internal_account_v1(v.organization_id);
    PERFORM app_private.reservation_create_leg_v1(sid,'OFFSET',offid,acc,day,retained);
    PERFORM app_private.reservation_create_leg_v1(sid,'REVENUE',rev,acc,day,retained);
  END IF;
  IF mode='NOW' THEN
    refund_vid:=app_private.reservation_pay_refund_v1(sid,(p_input->>'refundAccountId')::uuid,public.org_today_v1(v.organization_id));
    UPDATE public.income_expenses SET attachments=to_jsonb(refund_attachments) WHERE id=refund_vid;
    PERFORM app_private.reservation_bind_refund_evidence_v1(sid,refund_vid);
  END IF;
  -- A hold without an exact source link remains intact and is reported to the user.
  IF app_private.reservation_room_blockers_v1(v.room_id)='[]'::jsonb THEN
    PERFORM public.recompute_room_reservation(v.room_id);
  END IF;
  PERFORM app_private.reservation_settlement_assert_v1(sid);
  DELETE FROM app_private.reservation_settlement_write_tokens WHERE settlement_id=sid AND xid=pg_current_xact_id();
  RETURN app_private.reservation_settlement_json_v1(sid);
END $function$

