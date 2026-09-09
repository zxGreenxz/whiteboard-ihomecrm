-- Reservation deposits: preserve original cash receipt, recognize retained
-- deposit through a guarded NON_CASH pair, refund through the shared posting core.
-- Based on live pg_get_functiondef captured 2026-09-09; no legacy data backfill.
BEGIN;

CREATE TABLE public.reservation_deposit_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  source_voucher_id uuid NOT NULL UNIQUE REFERENCES public.income_expenses(id),
  building_id uuid NOT NULL REFERENCES public.buildings(id),
  room_id uuid REFERENCES public.rooms(id),
  deposit_amount numeric(18,0) NOT NULL CHECK (deposit_amount > 0),
  retained_amount numeric(18,0) NOT NULL CHECK (retained_amount >= 0),
  refund_amount numeric(18,0) NOT NULL CHECK (refund_amount >= 0),
  settlement_date date NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('CHANGED_MIND','NO_SHOW','OTHER')),
  reason_text text NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  basis_fingerprint text NOT NULL,
  request_hash text NOT NULL,
  idempotency_key text NOT NULL,
  revenue_voucher_id uuid REFERENCES public.income_expenses(id) DEFERRABLE INITIALLY DEFERRED,
  offset_voucher_id uuid REFERENCES public.income_expenses(id) DEFERRABLE INITIALLY DEFERRED,
  refund_voucher_id uuid REFERENCES public.income_expenses(id) DEFERRABLE INITIALLY DEFERRED,
  reservation_hold_id uuid REFERENCES public.room_reservation_holds(id),
  CHECK (deposit_amount = retained_amount + refund_amount),
  CHECK ((retained_amount = 0 AND revenue_voucher_id IS NULL AND offset_voucher_id IS NULL)
    OR (retained_amount > 0 AND revenue_voucher_id IS NOT NULL AND offset_voucher_id IS NOT NULL))
);
CREATE INDEX reservation_settlements_org_date_idx
  ON public.reservation_deposit_settlements(organization_id,created_at DESC,id DESC);

-- Historical refund attempts remain linked even after reversal and repayment.
CREATE TABLE public.reservation_settlement_vouchers (
  voucher_id uuid PRIMARY KEY REFERENCES public.income_expenses(id) DEFERRABLE INITIALLY DEFERRED,
  settlement_id uuid NOT NULL REFERENCES public.reservation_deposit_settlements(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  kind text NOT NULL CHECK (kind IN ('REVENUE','OFFSET','REFUND')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_settlement_vouchers_parent_idx
  ON public.reservation_settlement_vouchers(settlement_id,kind);

CREATE TABLE app_private.reservation_settlement_write_tokens (
  settlement_id uuid NOT NULL, xid xid8 NOT NULL,
  PRIMARY KEY(settlement_id,xid)
);
REVOKE ALL ON app_private.reservation_settlement_write_tokens FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app_private.reservation_deposit_is_settled_v1(p_voucher_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.reservation_deposit_settlements WHERE source_voucher_id=p_voucher_id)
$$;

CREATE FUNCTION app_private.reservation_settlement_can_read_v1(p_org uuid,p_building uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.organization_memberships m
      WHERE m.user_id=auth.uid() AND m.organization_id=p_org AND m.status='ACTIVE'
        AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=now() AND (m.valid_to IS NULL OR m.valid_to>now()))
    AND public.can_access_building(p_building)
    AND NOT (public.is_super_admin() AND COALESCE(p_org=ANY(public.sandbox_org_ids()),false))
$$;
REVOKE ALL ON FUNCTION app_private.reservation_deposit_is_settled_v1(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION app_private.reservation_settlement_can_read_v1(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.reservation_settlement_can_read_v1(uuid,uuid) TO authenticated;

ALTER TABLE public.reservation_deposit_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_settlement_vouchers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reservation_deposit_settlements,public.reservation_settlement_vouchers FROM anon,authenticated;
GRANT SELECT ON public.reservation_deposit_settlements,public.reservation_settlement_vouchers TO authenticated;
CREATE POLICY reservation_settlements_read ON public.reservation_deposit_settlements FOR SELECT TO authenticated
  USING(app_private.reservation_settlement_can_read_v1(organization_id,building_id));
CREATE POLICY reservation_deposit_settlements_hide_sandbox_admin ON public.reservation_deposit_settlements
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING(NOT(public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));
CREATE POLICY reservation_settlement_vouchers_read ON public.reservation_settlement_vouchers FOR SELECT TO authenticated
  USING(EXISTS(SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.id=settlement_id AND s.organization_id=reservation_settlement_vouchers.organization_id));
CREATE POLICY reservation_settlement_vouchers_hide_sandbox_admin ON public.reservation_settlement_vouchers
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING(NOT(public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));

CREATE FUNCTION app_private.reservation_settlement_authorize_v1(p_voucher uuid)
RETURNS public.income_expenses LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $$
DECLARE v public.income_expenses;
BEGIN
  SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher;
  IF NOT FOUND OR NOT app_private.reservation_settlement_can_read_v1(v.organization_id,v.building_id) THEN
    RAISE EXCEPTION 'Không có quyền xử lý phiếu cọc này' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v.organization_id);
  IF NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
      auth.uid(),v.organization_id,'deposits.refund',v.building_id,NULL)),false)
    OR NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
      auth.uid(),v.organization_id,'income_expenses.approve',v.building_id,NULL)),false) THEN
    RAISE EXCEPTION 'Bạn cần quyền xử lý cọc và duyệt thu chi trên tòa nhà này' USING ERRCODE='42501';
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION app_private.reservation_settlement_basis_v1(p_voucher uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE v public.income_expenses; v_dep numeric; v_mismatch boolean; v_items jsonb;
  v_posts jsonb; v_received numeric; v_count integer;
BEGIN
  SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher;
  SELECT COALESCE(SUM(i.amount) FILTER(WHERE i.accounting_class='DEPOSIT' AND t.is_deposit),0),
    COALESCE(bool_or((i.accounting_class='DEPOSIT') IS DISTINCT FROM COALESCE(t.is_deposit,false)),false),
    COALESCE(jsonb_agg(jsonb_build_array(i.id,i.amount,i.accounting_class,t.is_deposit) ORDER BY i.id),'[]'::jsonb)
  INTO v_dep,v_mismatch,v_items
  FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id=i.income_expense_type_id
  WHERE i.income_expense_id=p_voucher;
  IF v_dep::text IN ('NaN','Infinity','-Infinity') OR v_dep<>trunc(v_dep) OR v_dep>9007199254740991 THEN
    RAISE EXCEPTION 'Tiền cọc nguồn phải là số VND nguyên hợp lệ' USING ERRCODE='22023';
  END IF;
  SELECT count(*),COALESCE(SUM(p.net_cash_effect),0),
    COALESCE(jsonb_agg(jsonb_build_array(p.id,p.net_cash_effect,p.voucher_amount_snapshot) ORDER BY p.id),'[]'::jsonb)
  INTO v_count,v_received,v_posts
  FROM public.income_expense_postings p JOIN public.accounts a ON a.id=p.account_id
  WHERE p.organization_id=v.organization_id AND p.voucher_id=v.id AND p.event_kind='POSTING'
    AND p.direction='INCOME' AND a.organization_id=v.organization_id AND NOT COALESCE(a.is_virtual,false)
    AND p.voucher_amount_snapshot=v.total_amount
    AND p.net_cash_effect=(SELECT COALESCE(sum(l.signed_amount),0) FROM public.income_expense_posting_lines l WHERE l.posting_id=p.id AND l.organization_id=p.organization_id)
    AND NOT EXISTS(SELECT 1 FROM public.income_expense_postings r WHERE r.reversal_of_id=p.id);
  RETURN jsonb_build_object('amount',v_dep,'mismatch',v_mismatch,
    'received',v_count=1 AND v_received>=v_dep AND v_dep>0 AND v.approval_status='APPROVED'
      AND v.deleted_at IS NULL AND v.type='INCOME',
    'fingerprint',md5(jsonb_build_array(v.id,v.organization_id,v.building_id,v.room_id,v.contract_id,
      v.total_amount,v.approval_status,v.deleted_at,v_items,v_posts)::text));
END $$;

CREATE FUNCTION app_private.reservation_room_blockers_v1(p_room uuid,p_exclude_voucher uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE b jsonb:='[]'; v_status text;
BEGIN
  IF p_room IS NULL THEN RETURN '["ROOM_UNAVAILABLE"]'::jsonb; END IF;
  SELECT status INTO v_status FROM public.rooms WHERE id=p_room AND deleted_at IS NULL;
  IF v_status IS NULL OR v_status NOT IN ('AVAILABLE','RESERVED') THEN b:=b||'["ROOM_UNAVAILABLE"]'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM public.contracts WHERE room_id=p_room AND deleted_at IS NULL AND status IN ('ACTIVE','EXTENDED')) THEN
    b:=b||'["ACTIVE_CONTRACT"]'::jsonb;
  END IF;
  IF EXISTS(SELECT 1 FROM public.income_expenses ie WHERE ie.room_id=p_room AND ie.id IS DISTINCT FROM p_exclude_voucher
      AND ie.contract_id IS NULL AND ie.deleted_at IS NULL AND ie.type='INCOME'
      AND COALESCE(ie.approval_status,'')<>'CANCELLED' AND public.ie_has_deposit_item(ie.id)
      AND NOT app_private.reservation_deposit_is_settled_v1(ie.id))
    OR EXISTS(SELECT 1 FROM public.deposits d WHERE d.room_id=p_room AND d.contract_id IS NULL AND d.deleted_at IS NULL AND d.status IN ('PENDING','CONFIRMED')) THEN
    b:=b||'["OTHER_DEPOSIT"]'::jsonb;
  END IF;
  IF EXISTS(SELECT 1 FROM public.room_reservation_holds h WHERE h.room_id=p_room
    AND h.status IN ('PENDING_APPROVAL','APPROVED') AND h.expires_at>now()) THEN b:=b||'["UNRELATED_HOLD"]'::jsonb; END IF;
  RETURN b;
END $$;

CREATE FUNCTION public.preview_reservation_settlement_v1(p_voucher_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE v public.income_expenses; basis jsonb; blocks jsonb:='[]'; can_pay boolean;
BEGIN
  v:=app_private.reservation_settlement_authorize_v1(p_voucher_id);
  basis:=app_private.reservation_settlement_basis_v1(v.id);
  IF v.contract_id IS NOT NULL OR v.deleted_at IS NOT NULL OR v.type<>'INCOME'
    OR app_private.reservation_deposit_is_settled_v1(v.id)
    OR EXISTS(SELECT 1 FROM public.contract_deposit_links WHERE income_expense_id=v.id) THEN
    blocks:=blocks||'["ALREADY_USED"]'::jsonb;
  END IF;
  IF NOT COALESCE((basis->>'received')::boolean,false) THEN blocks:=blocks||'["NOT_RECEIVED"]'::jsonb; END IF;
  IF (basis->>'mismatch')::boolean THEN blocks:=blocks||'["DEPOSIT_CLASS_MISMATCH"]'::jsonb; END IF;
  IF NOT app_private.finance_v2_is_recognition_period_open(v.organization_id,public.org_today_v1(v.organization_id)) THEN
    blocks:=blocks||'["PERIOD_LOCKED"]'::jsonb;
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.cashbook_possession_bindings cb
    JOIN public.organization_memberships m ON m.id=cb.membership_id AND m.organization_id=cb.organization_id
    JOIN public.accounts a ON a.id=cb.cashbook_id AND a.organization_id=cb.organization_id
    WHERE m.user_id=auth.uid() AND m.status='ACTIVE' AND m.organization_id=v.organization_id
      AND cb.possession_kind='CUSTODIAN' AND cb.valid_from<=now() AND (cb.valid_to IS NULL OR cb.valid_to>now())
      AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual,false)) INTO can_pay;
  RETURN jsonb_build_object('voucherId',v.id,'depositAmount',(basis->>'amount')::numeric,'fingerprint',basis->>'fingerprint',
    'canSettle',blocks='[]'::jsonb,'canRefundNow',can_pay,'blockers',blocks,
    'roomBlockers',app_private.reservation_room_blockers_v1(v.room_id,v.id),
    'voucherCode',v.code,'payerName',v.payer_name,'voucherDate',v.voucher_date,
    'roomName',(SELECT name FROM public.rooms WHERE id=v.room_id),'buildingName',(SELECT name FROM public.buildings WHERE id=v.building_id));
END $$;

CREATE FUNCTION app_private.reservation_settlement_refunded_v1(p_settlement uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT COALESCE(SUM(-p.net_cash_effect),0)
  FROM public.reservation_settlement_vouchers l
  JOIN public.income_expense_postings p ON p.voucher_id=l.voucher_id AND p.organization_id=l.organization_id
  WHERE l.settlement_id=p_settlement AND l.kind='REFUND' AND p.event_kind='POSTING' AND p.direction='EXPENSE'
    AND NOT EXISTS(SELECT 1 FROM public.income_expense_postings r WHERE r.reversal_of_id=p.id)
$$;

CREATE FUNCTION app_private.reservation_settlement_json_v1(p_settlement uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s public.reservation_deposit_settlements; v public.income_expenses; paid numeric; rb jsonb;
BEGIN
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement;
  SELECT * INTO v FROM public.income_expenses WHERE id=s.source_voucher_id;
  paid:=app_private.reservation_settlement_refunded_v1(s.id);
  rb:=app_private.reservation_room_blockers_v1(s.room_id);
  RETURN jsonb_build_object('id',s.id,'sourceVoucherId',s.source_voucher_id,
    'depositAmount',s.deposit_amount,'retainedAmount',s.retained_amount,'refundAmount',s.refund_amount,
    'refundedAmount',paid,'refundRemaining',s.refund_amount-paid,
    'refundState',CASE WHEN s.refund_amount=0 THEN 'NOT_REQUIRED' WHEN paid=s.refund_amount THEN 'PAID' ELSE 'PENDING' END,
    'roomReleased',rb='[]'::jsonb AND EXISTS(SELECT 1 FROM public.rooms WHERE id=s.room_id AND status='AVAILABLE'),
    'roomBlockers',rb,'revenueVoucherId',s.revenue_voucher_id,'offsetVoucherId',s.offset_voucher_id,'refundVoucherId',s.refund_voucher_id,
    'createdAt',s.created_at,'settlementDate',s.settlement_date,'reasonCode',s.reason_code,'reasonText',s.reason_text,
    'buildingId',s.building_id,'buildingName',(SELECT name FROM public.buildings WHERE id=s.building_id),
    'roomId',s.room_id,'roomName',(SELECT name FROM public.rooms WHERE id=s.room_id),'payerName',v.payer_name,'voucherCode',v.code);
END $$;

-- Protect both business records and source receipts, not just UI controls.
CREATE FUNCTION app_private.guard_reservation_settlement_record_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE sid uuid;
BEGIN
  sid:=((CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>
    CASE WHEN TG_TABLE_NAME='reservation_deposit_settlements' THEN 'id' ELSE 'settlement_id' END)::uuid;
  IF NOT EXISTS(SELECT 1 FROM app_private.reservation_settlement_write_tokens WHERE settlement_id=sid AND xid=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Hồ sơ bỏ cọc chỉ được ghi qua xử lý cọc' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Không xóa lịch sử bỏ cọc' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='reservation_deposit_settlements' AND TG_OP='UPDATE'
    AND (to_jsonb(NEW)-'refund_voucher_id'-'reservation_hold_id') IS DISTINCT FROM (to_jsonb(OLD)-'refund_voucher_id'-'reservation_hold_id') THEN
    RAISE EXCEPTION 'Số tiền và căn cứ bỏ cọc đã chốt không được sửa' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservation_settlement_record_guard BEFORE INSERT OR UPDATE OR DELETE ON public.reservation_deposit_settlements
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_reservation_settlement_record_v1();
CREATE TRIGGER reservation_settlement_voucher_record_guard BEFORE INSERT OR UPDATE OR DELETE ON public.reservation_settlement_vouchers
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_reservation_settlement_record_v1();

CREATE FUNCTION app_private.guard_reservation_voucher_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE vid uuid; sid uuid; leg text; token boolean; oldj jsonb; newj jsonb;
BEGIN
  oldj:=to_jsonb(OLD); newj:=to_jsonb(NEW);
  vid:=((CASE WHEN TG_OP='DELETE' THEN oldj ELSE newj END)->>
    CASE WHEN TG_TABLE_NAME='income_expenses' THEN 'id'
      WHEN TG_TABLE_NAME IN ('income_expense_items','contract_deposit_links') THEN 'income_expense_id' ELSE 'voucher_id' END)::uuid;
  -- Item/link/posting writes serialize on the same source lock as settlement.
  IF TG_TABLE_NAME<>'income_expenses' THEN
    PERFORM 1 FROM public.income_expenses WHERE id=vid FOR UPDATE;
  END IF;
  SELECT id INTO sid FROM public.reservation_deposit_settlements WHERE source_voucher_id=vid;
  IF sid IS NOT NULL THEN
    IF TG_TABLE_NAME='income_expenses' AND TG_OP='UPDATE' THEN
      oldj:=to_jsonb(OLD)-ARRAY['notes','attachments','updated_at','verified_at','verified_by','verified_by_name','verified_note'];
      newj:=to_jsonb(NEW)-ARRAY['notes','attachments','updated_at','verified_at','verified_by','verified_by_name','verified_note'];
      IF oldj IS NOT DISTINCT FROM newj THEN RETURN NEW; END IF;
    END IF;
    -- Historical link DELETE is not a valid correction after settlement either.
    RAISE EXCEPTION 'Phiếu cọc đã xử lý bỏ cọc; không được sửa tiền, dùng lại hoặc hoàn tác' USING ERRCODE='55000';
  END IF;
  SELECT settlement_id,kind INTO sid,leg FROM public.reservation_settlement_vouchers WHERE voucher_id=vid;
  token:=sid IS NOT NULL AND EXISTS(SELECT 1 FROM app_private.reservation_settlement_write_tokens WHERE settlement_id=sid AND xid=pg_current_xact_id());
  IF token THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF sid IS NOT NULL THEN
    IF leg='REFUND' AND EXISTS(SELECT 1 FROM app_private.ie_transition_authorization
      WHERE income_expense_id=vid AND xid=pg_current_xact_id() AND purpose='FINANCE_V2_LIFECYCLE') THEN
      IF TG_TABLE_NAME='income_expenses' AND TG_OP='UPDATE'
        AND oldj->>'posting_status'='POSTED' AND newj->>'posting_status'='REVERSED'
        AND newj->>'active_posting_id_v2' IS NULL
        AND (newj-ARRAY['posting_status','active_posting_id_v2','posting_version','reversed_by_posting_id','updated_at'])
          IS NOT DISTINCT FROM (oldj-ARRAY['posting_status','active_posting_id_v2','posting_version','reversed_by_posting_id','updated_at']) THEN RETURN NEW; END IF;
      IF TG_TABLE_NAME='income_expense_postings' AND TG_OP='INSERT' AND newj->>'event_kind'='REVERSAL' THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'Bút toán bỏ cọc chỉ được ghi qua xử lý cọc' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='income_expenses' AND TG_OP<>'DELETE'
    AND newj->>'system_source' IN ('reservation.forfeit_revenue','reservation.forfeit_offset','reservation.refund') THEN
    RAISE EXCEPTION 'Bút toán bỏ cọc thiếu hồ sơ xử lý hợp lệ' USING ERRCODE='55000';
  END IF;
  -- A moved item must also check its original parent.
  IF TG_TABLE_NAME IN ('income_expense_items','contract_deposit_links') AND TG_OP='UPDATE'
    AND oldj->>'income_expense_id' IS DISTINCT FROM newj->>'income_expense_id'
    AND (app_private.reservation_deposit_is_settled_v1((oldj->>'income_expense_id')::uuid)
      OR EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers WHERE voucher_id=(oldj->>'income_expense_id')::uuid)) THEN
    RAISE EXCEPTION 'Không chuyển hạng mục của phiếu cọc đã xử lý' USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER a01_reservation_voucher_guard BEFORE INSERT OR UPDATE OR DELETE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_reservation_voucher_v1();
CREATE TRIGGER a01_reservation_item_guard BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_items
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_reservation_voucher_v1();
CREATE TRIGGER a01_reservation_contract_link_guard BEFORE INSERT OR UPDATE OR DELETE ON public.contract_deposit_links
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_reservation_voucher_v1();
CREATE TRIGGER a01_reservation_posting_guard BEFORE INSERT ON public.income_expense_postings
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_reservation_voucher_v1();

CREATE TABLE app_private.reservation_refund_operations (
  settlement_id uuid NOT NULL REFERENCES public.reservation_deposit_settlements(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  refund_voucher_id uuid NOT NULL REFERENCES public.income_expenses(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(settlement_id,idempotency_key)
);
REVOKE ALL ON app_private.reservation_refund_operations FROM PUBLIC,anon,authenticated,service_role;
CREATE UNIQUE INDEX reservation_settlement_request_key_idx
  ON public.reservation_deposit_settlements(organization_id,idempotency_key);

-- Explicit tenant, never infer account or category organization from profile selection.
CREATE FUNCTION app_private.reservation_internal_account_v1(p_org uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE aid uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('reservation.internal:'||p_org::text,0));
  SELECT id INTO aid FROM public.accounts
    WHERE organization_id=p_org AND is_virtual AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1;
  IF aid IS NULL THEN
    INSERT INTO public.accounts(organization_id,user_id,name,is_virtual,initial_amount)
      VALUES(p_org,auth.uid(),'Cấn trừ nội bộ',true,0) RETURNING id INTO aid;
  END IF;
  RETURN aid;
END $$;

CREATE FUNCTION app_private.reservation_create_leg_v1(p_settlement uuid,p_kind text,p_voucher uuid,p_account uuid,p_day date,p_amount numeric)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s public.reservation_deposit_settlements; src public.income_expenses; tid uuid; mid uuid;
  title text; side text; source text; is_dep boolean; posting uuid;
BEGIN
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app_private.reservation_settlement_write_tokens
    WHERE settlement_id=s.id AND xid=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Thiếu quyền ghi hồ sơ bỏ cọc' USING ERRCODE='42501';
  END IF;
  SELECT * INTO src FROM public.income_expenses WHERE id=s.source_voucher_id;
  SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
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
    voucher_date,total_amount,approval_status,posting_mode,posting_status,system_source,payer_name,notes,maker_membership_id)
  VALUES(p_voucher,s.organization_id,auth.uid(),side,title,s.building_id,s.room_id,p_account,
    p_day,p_amount,'UNAPPROVED',CASE WHEN p_kind='REFUND' THEN 'CASHBOOK' ELSE 'NON_CASH' END,
    CASE WHEN p_kind='REFUND' THEN 'UNPOSTED' ELSE 'NOT_APPLICABLE' END,source,src.payer_name,
    'Xử lý phiếu cọc '||COALESCE(src.code,src.id::text)||'. '||s.reason_text,mid);
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

CREATE FUNCTION app_private.reservation_pay_refund_v1(p_settlement uuid,p_account uuid,p_day date)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s public.reservation_deposit_settlements; a public.accounts; mid uuid; remaining numeric; vid uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement FOR UPDATE;
  PERFORM app_private.reservation_settlement_authorize_v1(s.source_voucher_id);
  SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
  SELECT * INTO a FROM public.accounts WHERE id=p_account FOR UPDATE;
  IF NOT FOUND OR a.organization_id IS DISTINCT FROM s.organization_id OR a.deleted_at IS NOT NULL OR a.is_virtual THEN
    RAISE EXCEPTION 'Chọn sổ quỹ thực đang hoạt động trong tổ chức này để hoàn tiền' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.assert_cashbook_access_v2(s.organization_id,a.id,'CUSTODIAN',mid);
  IF p_day IS NULL OR p_day<s.settlement_date OR p_day>public.org_today_v1(s.organization_id) THEN
    RAISE EXCEPTION 'Ngày hoàn tiền không hợp lệ' USING ERRCODE='22023';
  END IF;
  remaining:=s.refund_amount-app_private.reservation_settlement_refunded_v1(s.id);
  IF remaining<=0 THEN RAISE EXCEPTION 'Khoản cọc này không còn tiền chờ hoàn' USING ERRCODE='55000'; END IF;
  PERFORM app_private.reservation_create_leg_v1(s.id,'REFUND',vid,p_account,p_day,remaining);
  UPDATE public.reservation_deposit_settlements SET refund_voucher_id=vid WHERE id=s.id;
  IF app_private.reservation_settlement_refunded_v1(s.id)<>s.refund_amount THEN
    RAISE EXCEPTION 'Số tiền hoàn đã ghi sổ không khớp' USING ERRCODE='23514';
  END IF;
  RETURN vid;
END $$;

CREATE FUNCTION app_private.reservation_settlement_assert_v1(p_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s public.reservation_deposit_settlements; paid numeric; leg record;
BEGIN
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_id;
  paid:=app_private.reservation_settlement_refunded_v1(s.id);
  IF s.deposit_amount<>s.retained_amount+s.refund_amount OR paid<0 OR paid>s.refund_amount THEN
    RAISE EXCEPTION 'Số tiền xử lý cọc không khớp' USING ERRCODE='23514';
  END IF;
  IF s.retained_amount>0 THEN
    IF (SELECT count(*) FROM public.reservation_settlement_vouchers WHERE settlement_id=s.id AND kind IN ('OFFSET','REVENUE'))<>2 THEN
      RAISE EXCEPTION 'Thiếu cặp bút toán bỏ cọc' USING ERRCODE='23514';
    END IF;
    FOR leg IN SELECT v.*,l.kind FROM public.reservation_settlement_vouchers l
      JOIN public.income_expenses v ON v.id=l.voucher_id WHERE l.settlement_id=s.id AND l.kind IN ('OFFSET','REVENUE')
    LOOP
      IF leg.organization_id<>s.organization_id OR leg.total_amount<>s.retained_amount
        OR leg.approval_status<>'APPROVED' OR leg.posting_mode<>'NON_CASH' OR leg.posting_status<>'NOT_APPLICABLE'
        OR leg.kqkd_amount IS DISTINCT FROM (CASE WHEN leg.kind='REVENUE' THEN s.retained_amount ELSE 0 END)
        OR EXISTS(SELECT 1 FROM public.income_expense_postings WHERE voucher_id=leg.id)
        OR NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=leg.account_id AND organization_id=s.organization_id AND is_virtual) THEN
        RAISE EXCEPTION 'Bút toán chuyển cọc thành doanh thu không khớp' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
END $$;

CREATE FUNCTION public.settle_reservation_deposit_v1(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE v public.income_expenses; s public.reservation_deposit_settlements; basis jsonb; preview jsonb;
  sid uuid:=gen_random_uuid(); rev uuid; offid uuid; acc uuid;
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
    PERFORM app_private.reservation_pay_refund_v1(sid,(p_input->>'refundAccountId')::uuid,public.org_today_v1(v.organization_id));
  END IF;
  -- A hold without an exact source link remains intact and is reported to the user.
  IF app_private.reservation_room_blockers_v1(v.room_id)='[]'::jsonb THEN
    PERFORM public.recompute_room_reservation(v.room_id);
  END IF;
  PERFORM app_private.reservation_settlement_assert_v1(sid);
  DELETE FROM app_private.reservation_settlement_write_tokens WHERE settlement_id=sid AND xid=pg_current_xact_id();
  RETURN app_private.reservation_settlement_json_v1(sid);
END $$;

CREATE FUNCTION public.pay_reservation_refund_v1(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s public.reservation_deposit_settlements; src public.income_expenses; op app_private.reservation_refund_operations;
  key text; request_hash text; vid uuid; mid uuid; aid uuid;
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
  IF s.refund_amount>0 AND app_private.reservation_settlement_refunded_v1(s.id)=s.refund_amount THEN
    INSERT INTO app_private.reservation_refund_operations(settlement_id,idempotency_key,request_hash,refund_voucher_id)
      VALUES(s.id,key,request_hash,s.refund_voucher_id);
    RETURN app_private.reservation_settlement_json_v1(s.id);
  END IF;
  INSERT INTO app_private.reservation_settlement_write_tokens(settlement_id,xid) VALUES(s.id,pg_current_xact_id());
  vid:=app_private.reservation_pay_refund_v1(s.id,aid,(p_input->>'paidOn')::date);
  INSERT INTO app_private.reservation_refund_operations(settlement_id,idempotency_key,request_hash,refund_voucher_id)
    VALUES(s.id,key,request_hash,vid);
  PERFORM app_private.reservation_settlement_assert_v1(s.id);
  DELETE FROM app_private.reservation_settlement_write_tokens WHERE settlement_id=s.id AND xid=pg_current_xact_id();
  RETURN app_private.reservation_settlement_json_v1(s.id);
END $$;

CREATE FUNCTION public.get_reservation_settlement_summary_v1(p_building_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
  WITH amounts AS (
    SELECT s.*,app_private.reservation_settlement_refunded_v1(s.id) AS paid
    FROM public.reservation_deposit_settlements s
    WHERE app_private.reservation_settlement_can_read_v1(s.organization_id,s.building_id)
      AND (p_building_ids IS NULL OR s.building_id=ANY(p_building_ids))
  ) SELECT jsonb_build_object('retainedAmount',COALESCE(sum(retained_amount),0),'retainedCount',count(*) FILTER(WHERE retained_amount>0),
    'refundPendingAmount',COALESCE(sum(refund_amount-paid),0),'refundPendingCount',count(*) FILTER(WHERE refund_amount>paid),
    'refundPaidAmount',COALESCE(sum(paid),0),'refundPaidCount',count(*) FILTER(WHERE paid>0)) FROM amounts
$$;

CREATE FUNCTION public.get_reservation_settlements_v1(p_building_ids uuid[] DEFAULT NULL,p_refund_state text DEFAULT NULL,p_cursor jsonb DEFAULT NULL,p_limit integer DEFAULT 50,p_source_voucher_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE result jsonb; lim integer:=LEAST(GREATEST(COALESCE(p_limit,50),1),200);
BEGIN
  IF p_refund_state IS NOT NULL AND p_refund_state NOT IN ('PENDING','PAID','NOT_REQUIRED') THEN
    RAISE EXCEPTION 'Trạng thái hoàn tiền không hợp lệ' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT s.*,app_private.reservation_settlement_refunded_v1(s.id) AS paid
    FROM public.reservation_deposit_settlements s
    WHERE app_private.reservation_settlement_can_read_v1(s.organization_id,s.building_id)
      AND (p_source_voucher_id IS NULL OR s.source_voucher_id=p_source_voucher_id)
      AND (p_building_ids IS NULL OR s.building_id=ANY(p_building_ids))
      AND (p_cursor IS NULL OR (s.created_at,s.id)<((p_cursor->>'createdAt')::timestamptz,(p_cursor->>'id')::uuid))
  ), filtered AS (
    SELECT * FROM candidates WHERE p_refund_state IS NULL
      OR p_refund_state=CASE WHEN refund_amount=0 THEN 'NOT_REQUIRED' WHEN paid=refund_amount THEN 'PAID' ELSE 'PENDING' END
    ORDER BY created_at DESC,id DESC LIMIT lim+1
  ), page AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT lim)
  SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(app_private.reservation_settlement_json_v1(id) ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb),
    'nextCursor',CASE WHEN (SELECT count(*) FROM filtered)>lim THEN (SELECT jsonb_build_object('createdAt',created_at,'id',id) FROM page ORDER BY created_at,id LIMIT 1) ELSE NULL END)
  INTO result;
  RETURN result;
END $$;

-- Existing reversal RPC is retained, including its cash math. Reservation refunds
-- additionally recheck authorization before its historical replay branch.
CREATE FUNCTION app_private.reservation_authorize_reversal_v1(p_voucher uuid,p_cashbook uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s public.reservation_deposit_settlements; mid uuid;
BEGIN
  SELECT parent.* INTO s FROM public.reservation_deposit_settlements parent
    JOIN public.reservation_settlement_vouchers l ON l.settlement_id=parent.id
    WHERE l.voucher_id=p_voucher AND l.kind='REFUND';
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM app_private.lock_org_for_decision_v1(s.organization_id);
  IF NOT app_private.reservation_settlement_can_read_v1(s.organization_id,s.building_id)
    OR NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),s.organization_id,
      'income_expenses.reverse',s.building_id,NULL)),false) THEN
    RAISE EXCEPTION 'Không có quyền đảo phiếu hoàn cọc tại tòa nhà này' USING ERRCODE='42501';
  END IF;
  SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
  PERFORM app_private.assert_cashbook_access_v2(s.organization_id,p_cashbook,'CUSTODIAN',mid);
END $$;

-- Patch only measured anchors of the currently deployed readers/writer. Any drift aborts.
DO $patch$
DECLARE def text; anchor text; sig text;
BEGIN
  sig:='public.reverse_posted_income_expense_v2(uuid,uuid,date,text,text)'; def:=pg_get_functiondef(sig::regprocedure);
  anchor:='v_op := app_private.finance_v2_begin_canonical_op(';
  IF strpos(def,anchor)=0 THEN RAISE EXCEPTION 'Catalog drift: %',sig; END IF;
  EXECUTE replace(def,anchor,'PERFORM app_private.reservation_authorize_reversal_v1(p_voucher,p_cashbook);'||E'\n  '||anchor);
  sig:='public.room_has_holding_deposit(uuid)'; def:=pg_get_functiondef(sig::regprocedure);
  anchor:='AND public.ie_has_deposit_item(ie.id)';
  IF strpos(def,anchor)=0 THEN RAISE EXCEPTION 'Catalog drift: %',sig; END IF;
  EXECUTE replace(def,anchor,anchor||E'\n        AND NOT app_private.reservation_deposit_is_settled_v1(ie.id)');
  sig:='public.trg_contract_link_orphan_deposits()'; def:=pg_get_functiondef(sig::regprocedure);
  anchor:='WHERE voucher.contract_id IS NULL';
  IF strpos(def,anchor)=0 THEN RAISE EXCEPTION 'Catalog drift: %',sig; END IF;
  EXECUTE replace(def,anchor,anchor||E'\n       AND NOT app_private.reservation_deposit_is_settled_v1(voucher.id)');
  sig:='public.create_contract_v2(jsonb,text)'; def:=pg_get_functiondef(sig::regprocedure);
  anchor:='AND voucher.contract_id IS NULL';
  IF strpos(def,anchor)=0 THEN RAISE EXCEPTION 'Catalog drift: %',sig; END IF;
  EXECUTE replace(def,anchor,anchor||E'\n      AND NOT app_private.reservation_deposit_is_settled_v1(voucher.id)');
  -- This reader is SECURITY INVOKER: use its RLS-protected relation, not a private predicate.
  sig:='public.get_reservation_deposit_summary(uuid[])'; def:=pg_get_functiondef(sig::regprocedure);
  anchor:='WHERE ie.contract_id IS NULL';
  IF strpos(def,anchor)=0 THEN RAISE EXCEPTION 'Catalog drift: %',sig; END IF;
  EXECUTE replace(def,anchor,anchor||E'\n      AND NOT EXISTS(SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.source_voucher_id=ie.id)');
END $patch$;

CREATE FUNCTION app_private.guard_reservation_deposit_type_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['name','description','updated_at','sort_order']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['name','description','updated_at','sort_order'])
    AND EXISTS(SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_type_id=OLD.id
      AND (app_private.reservation_deposit_is_settled_v1(i.income_expense_id)
        OR EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers l WHERE l.voucher_id=i.income_expense_id))) THEN
    RAISE EXCEPTION 'Không đổi bản chất hạng mục đã dùng trong xử lý bỏ cọc' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a01_reservation_type_guard BEFORE UPDATE ON public.income_expense_types
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_reservation_deposit_type_v1();

-- Every private helper is internal; policies alone need the scoped read predicate.
DO $acl$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='app_private' AND p.proname IN ('reservation_deposit_is_settled_v1','reservation_settlement_can_read_v1',
      'reservation_settlement_authorize_v1','reservation_settlement_basis_v1','reservation_room_blockers_v1',
      'reservation_settlement_refunded_v1','reservation_settlement_json_v1','reservation_internal_account_v1',
      'reservation_create_leg_v1','reservation_pay_refund_v1','reservation_settlement_assert_v1','reservation_authorize_reversal_v1',
      'guard_reservation_voucher_v1','guard_reservation_settlement_record_v1','guard_reservation_deposit_type_v1')
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature); END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION app_private.reservation_settlement_can_read_v1(uuid,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.preview_reservation_settlement_v1(uuid),public.settle_reservation_deposit_v1(jsonb),
  public.pay_reservation_refund_v1(jsonb),public.get_reservation_settlement_summary_v1(uuid[]),
  public.get_reservation_settlements_v1(uuid[],text,jsonb,integer,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.preview_reservation_settlement_v1(uuid),public.settle_reservation_deposit_v1(jsonb),
  public.pay_reservation_refund_v1(jsonb),public.get_reservation_settlement_summary_v1(uuid[]),
  public.get_reservation_settlements_v1(uuid[],text,jsonb,integer,uuid) TO authenticated;
DO $realtime$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.reservation_deposit_settlements,public.reservation_settlement_vouchers;
  END IF;
END $realtime$;

COMMIT;
