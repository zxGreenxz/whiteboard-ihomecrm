-- Forward-only: add refund evidence and actual actor display names. No backfill.
-- Existing RPC signatures, authorization, cash posting and request hashes stay intact.
BEGIN;

-- Optional refund evidence is validated before any new settlement or payment write.
-- A previously successful retry keeps its original authorization and hash behavior.
-- Persist the original references (not signed URLs); storage.ts resolves them on read.
CREATE OR REPLACE FUNCTION app_private.reservation_refund_attachments_v1(p_input jsonb,p_org uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SET search_path=pg_catalog,app_private AS $$
DECLARE evidence jsonb; item jsonb; ref text; object_path text; result text[]:=ARRAY[]::text[];
BEGIN
  IF NOT (p_input ? 'refundAttachments') THEN RETURN result; END IF;
  evidence:=p_input->'refundAttachments';
  IF jsonb_typeof(evidence) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Ảnh chứng từ phải là danh sách tệp đã tải lên' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(evidence)>10 THEN
    RAISE EXCEPTION 'Tối đa 10 ảnh chứng từ cho mỗi lần hoàn tiền' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(evidence) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Ảnh chứng từ phải là đường dẫn tệp đã tải lên' USING ERRCODE='22023';
    END IF;
    ref:=item #>> '{}';
    -- AttachmentUpload emits UUID user folder + sanitized flat filename. Accept
    -- current Supabase references. This bucket has not migrated to R2; binding
    -- requires its real storage.objects row and never trusts a fabricated URL.
    -- No query, fragment, URL credentials, encoded traversal, script or data URL.
    IF length(ref)>2048 OR ref !~* '^https://[A-Za-z0-9][A-Za-z0-9.-]*/storage/v1/object/public/income-expense-attachments/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[A-Za-z0-9_.-]+[.](jpg|jpeg|png|webp|pdf)$'
      OR ref LIKE '%..%' THEN
      RAISE EXCEPTION 'Đường dẫn ảnh chứng từ không hợp lệ' USING ERRCODE='22023';
    END IF;
    object_path:=split_part(ref,'/income-expense-attachments/',2);
    IF split_part(object_path,'/',1) IS DISTINCT FROM auth.uid()::text OR EXISTS (
      SELECT 1 FROM app_private.storage_object_links l
      WHERE l.bucket_id='income-expense-attachments' AND l.object_name=object_path
        AND l.organization_id IS NOT NULL AND l.organization_id<>p_org
    ) THEN
      RAISE EXCEPTION 'Chứng từ phải là tệp của bạn trong tổ chức này' USING ERRCODE='22023';
    END IF;
    result:=array_append(result,ref);
  END LOOP;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION app_private.reservation_refund_attachments_v1(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Bind real uploaded proof to the refund organization. A multi-org uploader's
-- storage trigger creates a quarantined NULL-org link; attachment JSON alone
-- does not make that private object readable by the organization's other staff.
CREATE OR REPLACE FUNCTION app_private.reservation_bind_refund_evidence_v1(p_settlement uuid,p_voucher uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s public.reservation_deposit_settlements; evidence jsonb; object_path text; stored storage.objects;
BEGIN
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app_private.reservation_settlement_write_tokens
    WHERE settlement_id=s.id AND xid=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Thiếu quyền ghi chứng từ hoàn cọc' USING ERRCODE='42501';
  END IF;
  SELECT v.attachments INTO evidence FROM public.income_expenses v
    JOIN public.reservation_settlement_vouchers l ON l.voucher_id=v.id
    WHERE v.id=p_voucher AND v.organization_id=s.organization_id
      AND l.settlement_id=s.id AND l.kind='REFUND';
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu chứng từ hoàn cọc không hợp lệ' USING ERRCODE='22023'; END IF;
  -- Consistent object order prevents overlapping multi-image payments taking
  -- the same storage/link locks in opposite order.
  FOR object_path IN SELECT DISTINCT split_part(value,'/income-expense-attachments/',2)
    FROM jsonb_array_elements_text(evidence) ORDER BY 1
  LOOP
    SELECT * INTO stored FROM storage.objects
      WHERE bucket_id='income-expense-attachments' AND name=object_path FOR UPDATE;
    IF NOT FOUND OR COALESCE(stored.owner_id,stored.owner::text) IS DISTINCT FROM auth.uid()::text
      OR stored.archived_at IS NOT NULL OR stored.is_delete_marker THEN
      RAISE EXCEPTION 'Chứng từ phải là tệp đã tải lên còn tồn tại của bạn' USING ERRCODE='22023';
    END IF;
    INSERT INTO app_private.storage_object_links AS link
      (bucket_id,object_name,organization_id,owner_user_id,derivation)
    VALUES('income-expense-attachments',object_path,s.organization_id,auth.uid(),'RESERVATION_REFUND')
    ON CONFLICT(bucket_id,object_name) DO UPDATE
      SET organization_id=EXCLUDED.organization_id,derivation=EXCLUDED.derivation
      WHERE link.organization_id IS NULL AND link.owner_user_id=auth.uid();
    -- Existing same-org links stay intact; a conflict can never transfer a
    -- different org's proof, even if its link changed after initial validation.
    IF NOT EXISTS(SELECT 1 FROM app_private.storage_object_links l
      WHERE l.bucket_id='income-expense-attachments' AND l.object_name=object_path
        AND l.organization_id=s.organization_id) THEN
      RAISE EXCEPTION 'Chứng từ không thuộc tổ chức của phiếu hoàn cọc' USING ERRCODE='22023';
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app_private.reservation_bind_refund_evidence_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.reservation_create_leg_v1(p_settlement uuid,p_kind text,p_voucher uuid,p_account uuid,p_day date,p_amount numeric)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s public.reservation_deposit_settlements; src public.income_expenses; tid uuid; mid uuid;
  actor_name text; title text; side text; source text; is_dep boolean; posting uuid;
BEGIN
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app_private.reservation_settlement_write_tokens
    WHERE settlement_id=s.id AND xid=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Thiếu quyền ghi hồ sơ bỏ cọc' USING ERRCODE='42501';
  END IF;
  SELECT * INTO src FROM public.income_expenses WHERE id=s.source_voucher_id;
  SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
  SELECT COALESCE(NULLIF(btrim(full_name),''),NULLIF(btrim(email),'')) INTO actor_name FROM public.profiles WHERE id=auth.uid();
  IF p_kind='REVENUE' THEN
    title:='Doanh thu bỏ cọc giữ chỗ'; side:='INCOME'; source:='reservation.forfeit_revenue'; is_dep:=false;
  ELSIF p_kind='OFFSET' THEN
    title:='Cấn cọc giữ chỗ chuyển doanh thu'; side:='EXPENSE'; source:='reservation.forfeit_offset'; is_dep:=true;
  ELSIF p_kind='REFUND' THEN
    title:='Hoàn cọc giữ chỗ'; side:='EXPENSE'; source:='reservation.refund'; is_dep:=true;
  ELSE RAISE EXCEPTION 'Loại bút toán bỏ cọc không hợp lệ' USING ERRCODE='22023'; END IF;
  tid:=app_private.ensure_income_expense_type_v1(s.organization_id,auth.uid(),title,lower(side),NULL,NULL,false,is_dep,false,false,false,true);
  INSERT INTO public.reservation_settlement_vouchers(voucher_id,settlement_id,organization_id,kind)
    VALUES(p_voucher,s.id,s.organization_id,p_kind);
  INSERT INTO public.income_expenses(id,organization_id,user_id,type,name,building_id,room_id,account_id,
    voucher_date,total_amount,approval_status,posting_mode,posting_status,system_source,payer_name,notes,maker_membership_id,creator_name)
  VALUES(p_voucher,s.organization_id,auth.uid(),side,title,s.building_id,s.room_id,p_account,
    p_day,p_amount,'UNAPPROVED',CASE WHEN p_kind='REFUND' THEN 'CASHBOOK' ELSE 'NON_CASH' END,
    CASE WHEN p_kind='REFUND' THEN 'UNPOSTED' ELSE 'NOT_APPLICABLE' END,source,src.payer_name,
    'Xử lý phiếu cọc '||COALESCE(src.code,src.id::text)||'. '||s.reason_text,mid,actor_name);
  INSERT INTO public.income_expense_items(organization_id,income_expense_id,income_expense_type_id,
    description,quantity,unit_price,amount,accounting_class,start_date,end_date)
  VALUES(s.organization_id,p_voucher,tid,title,1,p_amount,p_amount,CASE WHEN is_dep THEN 'DEPOSIT' ELSE 'PNL' END,p_day,p_day);
  -- Specialized authorized decision, retaining the canonical manual birth boundary.
  -- Token suppresses both legacy posting bridges; shared core owns cash calculations.
  INSERT INTO app_private.ie_transition_authorization(income_expense_id,xid,purpose)
    VALUES(p_voucher,pg_current_xact_id(),'FINANCE_V2_LIFECYCLE')
    ON CONFLICT(income_expense_id) DO UPDATE SET xid=EXCLUDED.xid,purpose=EXCLUDED.purpose,granted_at=now();
  UPDATE public.income_expenses SET approval_status='APPROVED',approved_by=auth.uid(),approved_at=now(),
    review_state='RESOLVED',approval_version=approval_version+1,updated_at=now() WHERE id=p_voucher;
  IF p_kind='REFUND' THEN
    posting:=app_private.finance_v2_post_voucher_with_source_v1(
      p_org=>s.organization_id,p_voucher_id=>p_voucher,p_source_kind=>'RESERVATION_REFUND',
      p_external_kind=>'RESERVATION_REFUND_VOUCHER',p_external_id=>p_voucher,p_external_line_id=>NULL,
      p_posted_on=>p_day,p_amount_basis=>'VOUCHER_TOTAL',p_generation=>1);
    UPDATE public.income_expenses SET active_posting_id_v2=posting,posting_id=posting,posting_status='POSTED',
      posted_at_v2=now(),posting_version=posting_version+1,updated_at=now() WHERE id=p_voucher;
  END IF;
  DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id=p_voucher AND xid=pg_current_xact_id();
END $$;

CREATE OR REPLACE FUNCTION public.settle_reservation_deposit_v1(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
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
END $$;

CREATE OR REPLACE FUNCTION public.pay_reservation_refund_v1(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s public.reservation_deposit_settlements; src public.income_expenses; op app_private.reservation_refund_operations;
  refund_attachments text[]; key text; request_hash text; vid uuid; mid uuid; aid uuid;
BEGIN
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=(p_input->>'settlementId')::uuid;
  IF NOT FOUND OR NOT app_private.reservation_settlement_can_read_v1(s.organization_id,s.building_id) THEN
    RAISE EXCEPTION 'Không có quyền hoàn khoản cọc này' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.rooms WHERE id=s.room_id FOR NO KEY UPDATE;
  src:=app_private.reservation_settlement_authorize_v1(s.source_voucher_id);
  PERFORM 1 FROM public.income_expenses WHERE id=s.source_voucher_id FOR UPDATE;
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=s.id FOR UPDATE;
  PERFORM app_private.reservation_settlement_authorize_v1(s.source_voucher_id);
  aid:=(p_input->>'accountId')::uuid;
  SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
  PERFORM app_private.assert_cashbook_access_v2(s.organization_id,aid,'CUSTODIAN',mid);
  key:=btrim(p_input->>'idempotencyKey'); request_hash:=md5((p_input-'idempotencyKey')::text);
  IF key IS NULL OR length(key) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'Mã yêu cầu không hợp lệ' USING ERRCODE='22023'; END IF;
  SELECT * INTO op FROM app_private.reservation_refund_operations WHERE settlement_id=s.id AND idempotency_key=key;
  IF FOUND THEN
    IF op.request_hash<>request_hash THEN RAISE EXCEPTION 'Mã yêu cầu hoàn tiền đã dùng với nội dung khác' USING ERRCODE='22023'; END IF;
    -- A reversed refund is debt again; retry never issues money a second time.
    RETURN app_private.reservation_settlement_json_v1(s.id);
  END IF;
  refund_attachments:=app_private.reservation_refund_attachments_v1(p_input,s.organization_id);
  IF s.refund_amount>0 AND app_private.reservation_settlement_refunded_v1(s.id)=s.refund_amount THEN
    INSERT INTO app_private.reservation_refund_operations(settlement_id,idempotency_key,request_hash,refund_voucher_id)
      VALUES(s.id,key,request_hash,s.refund_voucher_id);
    RETURN app_private.reservation_settlement_json_v1(s.id);
  END IF;
  INSERT INTO app_private.reservation_settlement_write_tokens(settlement_id,xid) VALUES(s.id,pg_current_xact_id());
  vid:=app_private.reservation_pay_refund_v1(s.id,aid,(p_input->>'paidOn')::date);
  UPDATE public.income_expenses SET attachments=to_jsonb(refund_attachments) WHERE id=vid;
  PERFORM app_private.reservation_bind_refund_evidence_v1(s.id,vid);
  INSERT INTO app_private.reservation_refund_operations(settlement_id,idempotency_key,request_hash,refund_voucher_id)
    VALUES(s.id,key,request_hash,vid);
  PERFORM app_private.reservation_settlement_assert_v1(s.id);
  DELETE FROM app_private.reservation_settlement_write_tokens WHERE settlement_id=s.id AND xid=pg_current_xact_id();
  RETURN app_private.reservation_settlement_json_v1(s.id);
END $$;

COMMIT;
