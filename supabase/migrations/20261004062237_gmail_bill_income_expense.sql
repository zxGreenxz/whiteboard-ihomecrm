-- User-confirmed email prefill only. This registry never approves or posts money:
-- create_income_expense_v1 remains the sole financial writer and spending gate.
CREATE TABLE IF NOT EXISTS public.email_bill_imports (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  provider text NOT NULL CHECK (provider IN ('grab','shopee')),
  receipt_id text NOT NULL CHECK (receipt_id ~ '^[A-Z0-9][A-Z0-9._:-]{0,199}$'),
  mailbox text NOT NULL CHECK (length(mailbox) BETWEEN 3 AND 320),
  message_id text NOT NULL CHECK (message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  building_id uuid NOT NULL REFERENCES public.buildings(id),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  income_expense_id uuid UNIQUE REFERENCES public.income_expenses(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,provider,receipt_id)
);
ALTER TABLE public.email_bill_imports OWNER TO postgres;
REVOKE ALL ON public.email_bill_imports FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.email_bill_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_bill_imports_hide_sandbox_admin ON public.email_bill_imports;
CREATE POLICY email_bill_imports_hide_sandbox_admin ON public.email_bill_imports
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT (public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)))
  WITH CHECK (NOT (public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));

CREATE OR REPLACE FUNCTION app_private.normalize_email_bill_source_v1(p_source jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE k text; provider text; receipt text; mailbox text; message text;
BEGIN
  IF jsonb_typeof(p_source) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Nguồn hóa đơn không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF (p_source - ARRAY['provider','receipt_id','mailbox','message_id']::text[]) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Nguồn hóa đơn có trường không được hỗ trợ' USING ERRCODE='22023';
  END IF;
  FOREACH k IN ARRAY ARRAY['provider','receipt_id','mailbox','message_id'] LOOP
    IF jsonb_typeof(p_source->k) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Nguồn hóa đơn thiếu trường văn bản bắt buộc' USING ERRCODE='22023';
    END IF;
  END LOOP;
  provider:=lower(btrim(p_source->>'provider'));
  receipt:=upper(btrim(p_source->>'receipt_id'));
  mailbox:=lower(btrim(p_source->>'mailbox'));
  message:=btrim(p_source->>'message_id');
  IF provider NOT IN ('grab','shopee') OR length(p_source->>'provider')>20
    OR length(p_source->>'receipt_id')>220 OR receipt !~ '^[A-Z0-9][A-Z0-9._:-]{0,199}$'
    OR length(p_source->>'mailbox')>340 OR length(mailbox)>320
    OR mailbox !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR length(p_source->>'message_id')>148 OR message !~ '^[A-Za-z0-9_-]{1,128}$' THEN
    RAISE EXCEPTION 'Định dạng nguồn hóa đơn không hợp lệ' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('provider',provider,'receipt_id',receipt,'mailbox',mailbox,'message_id',message);
END $fn$;

-- Caller locks the organization in a prior statement before evaluating v3.
-- Check again after any claim wait: membership validity uses wall-clock time.
CREATE OR REPLACE FUNCTION app_private.assert_email_bill_scope_v1(p_org uuid,p_building uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL OR p_org IS NULL OR p_building IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.buildings b WHERE b.id=p_building AND b.organization_id=p_org AND b.deleted_at IS NULL)
    OR NOT COALESCE(public.can_access_building(p_building),false)
    OR NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'income_expenses.create',p_building,NULL)),false) THEN
    RAISE EXCEPTION 'Không có quyền nhập hóa đơn trong tổ chức/tòa nhà này' USING ERRCODE='42501';
  END IF;
END $fn$;

-- Completed imports may disclose a voucher only while its current read and
-- canonical creation gates still pass. First-time creation stays with the writer.
CREATE OR REPLACE FUNCTION app_private.can_replay_email_bill_v1(p_org uuid,p_voucher uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v public.income_expenses%ROWTYPE; actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL OR NOT COALESCE(app_private.ie_supplement_can_read_v1(p_voucher),false) THEN RETURN false; END IF;
  SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher AND organization_id=p_org AND deleted_at IS NULL;
  IF NOT FOUND OR NOT COALESCE(app_private.authorize_income_expense_on_building(actor,p_org,'create',v.building_id),false) THEN RETURN false; END IF;
  IF (COALESCE(v.has_restricted_item,false) OR EXISTS (
      SELECT 1 FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id=i.income_expense_type_id
      WHERE i.income_expense_id=v.id AND t.is_restricted))
    AND NOT COALESCE(app_private.authorize_income_expense_on_building(actor,p_org,'restricted_create',v.building_id),false) THEN RETURN false; END IF;
  IF v.account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.accounts a WHERE a.id=v.account_id AND a.organization_id=p_org AND a.deleted_at IS NULL
      AND (a.user_id=actor OR EXISTS (
        SELECT 1 FROM public.cashbook_possession_bindings b JOIN public.organization_memberships m ON m.id=b.membership_id
        WHERE b.cashbook_id=a.id AND b.organization_id=p_org AND m.user_id=actor AND m.status='ACTIVE'
          AND b.valid_to IS NULL AND b.possession_kind IN ('CUSTODIAN','OPERATOR')))) THEN RETURN false; END IF;
  RETURN true;
END $fn$;

CREATE OR REPLACE FUNCTION public.create_income_expense_from_email_v1(p_organization_id uuid,p_source jsonb,p_voucher jsonb,p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  s jsonb; k text; item jsonb; attachment jsonb; building uuid; financial_hash text; stable_key text;
  claim public.email_bill_imports%ROWTYPE; result public.income_expenses%ROWTYPE;
  inserted integer; parsed_date date;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  s:=app_private.normalize_email_bill_source_v1(p_source);
  IF jsonb_typeof(p_voucher) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Phiếu chi không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF (p_voucher-ARRAY['type','name','building_id','room_id','tenant_id','contract_id','payer_name','receive_bank_account','receive_bank_name','account_id','attachments','business_result_accounting','voucher_date']::text[]) <> '{}'::jsonb
    OR p_voucher->>'type' IS DISTINCT FROM 'EXPENSE'
    OR jsonb_typeof(p_voucher->'name') IS DISTINCT FROM 'string'
    OR length(btrim(p_voucher->>'name')) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Trường phiếu chi không hợp lệ' USING ERRCODE='22023';
  END IF;
  FOREACH k IN ARRAY ARRAY['building_id','room_id','tenant_id','contract_id','account_id'] LOOP
    IF (k='building_id' AND COALESCE(jsonb_typeof(p_voucher->k),'null')='null') OR
      (COALESCE(jsonb_typeof(p_voucher->k),'null')<>'null' AND
       (jsonb_typeof(p_voucher->k)<>'string' OR (p_voucher->>k)!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
      RAISE EXCEPTION 'Mã tham chiếu phiếu chi không hợp lệ' USING ERRCODE='22023';
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['payer_name','receive_bank_account','receive_bank_name'] LOOP
    IF COALESCE(jsonb_typeof(p_voucher->k),'null')<>'null' AND
      (jsonb_typeof(p_voucher->k)<>'string' OR length(p_voucher->>k)>255) THEN
      RAISE EXCEPTION 'Thông tin người nhận không hợp lệ' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF COALESCE(jsonb_typeof(p_voucher->'business_result_accounting'),'null') NOT IN ('boolean','null') THEN
    RAISE EXCEPTION 'Tùy chọn hạch toán không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF p_voucher ? 'attachments' THEN
    IF jsonb_typeof(p_voucher->'attachments') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Tệp đính kèm không hợp lệ' USING ERRCODE='22023';
    END IF;
    IF jsonb_array_length(p_voucher->'attachments')>20 THEN RAISE EXCEPTION 'Quá nhiều tệp đính kèm' USING ERRCODE='22023'; END IF;
    FOR attachment IN SELECT value FROM jsonb_array_elements(p_voucher->'attachments') LOOP
      IF jsonb_typeof(attachment)<>'string' OR length(attachment#>>'{}') NOT BETWEEN 1 AND 2048 THEN
        RAISE EXCEPTION 'Tệp đính kèm không hợp lệ' USING ERRCODE='22023';
      END IF;
    END LOOP;
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Chi tiết chi không hợp lệ' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Số dòng chi không hợp lệ' USING ERRCODE='22023'; END IF;
  BEGIN
    IF jsonb_typeof(p_voucher->'voucher_date') IS DISTINCT FROM 'string' OR (p_voucher->>'voucher_date')!~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'Ngày phiếu không hợp lệ' USING ERRCODE='22023';
    END IF;
    parsed_date:=(p_voucher->>'voucher_date')::date;
    IF parsed_date NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31' THEN RAISE EXCEPTION 'Ngày phiếu ngoài phạm vi' USING ERRCODE='22023'; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
      IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Dòng chi không hợp lệ' USING ERRCODE='22023'; END IF;
      IF (item-ARRAY['income_expense_type_id','description','quantity','unit_price','start_date','end_date']::text[])<>'{}'::jsonb
        OR jsonb_typeof(item->'income_expense_type_id') IS DISTINCT FROM 'string'
        OR (item->>'income_expense_type_id')!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'unit_price') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Trường dòng chi không hợp lệ' USING ERRCODE='22023';
      END IF;
      IF (item->>'quantity')::numeric NOT BETWEEN 1 AND 2147483647 OR (item->>'quantity')::numeric<>trunc((item->>'quantity')::numeric)
        OR (item->>'unit_price')::numeric NOT BETWEEN 0 AND 9999999999999.99 THEN
        RAISE EXCEPTION 'Số lượng/số tiền không hợp lệ' USING ERRCODE='22023';
      END IF;
      IF COALESCE(jsonb_typeof(item->'description'),'null')<>'null' AND
        (jsonb_typeof(item->'description')<>'string' OR length(item->>'description')>1000) THEN
        RAISE EXCEPTION 'Mô tả dòng chi không hợp lệ' USING ERRCODE='22023';
      END IF;
      FOREACH k IN ARRAY ARRAY['start_date','end_date'] LOOP
        IF COALESCE(jsonb_typeof(item->k),'null')<>'null' THEN
          IF jsonb_typeof(item->k)<>'string' OR (item->>k)!~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Ngày dòng chi không hợp lệ' USING ERRCODE='22023'; END IF;
          parsed_date:=(item->>k)::date;
          IF parsed_date NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31' THEN RAISE EXCEPTION 'Ngày dòng chi ngoài phạm vi' USING ERRCODE='22023'; END IF;
        END IF;
      END LOOP;
    END LOOP;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Ngày hoặc số tiền không hợp lệ' USING ERRCODE='22023';
  END;
  building:=(p_voucher->>'building_id')::uuid;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  PERFORM app_private.assert_email_bill_scope_v1(p_organization_id,building);
  financial_hash:=encode(sha256(convert_to(jsonb_build_object('voucher',p_voucher,'items',p_items)::text,'UTF8')),'hex');
  stable_key:='email-bill:'||encode(sha256(convert_to(jsonb_build_array(p_organization_id,s->>'provider',s->>'receipt_id')::text,'UTF8')),'hex');

  -- Unique-index arbitration waits for concurrent transactions. A rolled-back
  -- winner leaves no claim; a committed winner is read in the next statement.
  INSERT INTO public.email_bill_imports(organization_id,provider,receipt_id,mailbox,message_id,building_id,created_by,payload_hash)
  VALUES(p_organization_id,s->>'provider',s->>'receipt_id',s->>'mailbox',s->>'message_id',building,auth.uid(),financial_hash)
  ON CONFLICT (organization_id,provider,receipt_id) DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  SELECT * INTO STRICT claim FROM public.email_bill_imports
    WHERE organization_id=p_organization_id AND provider=s->>'provider' AND receipt_id=s->>'receipt_id' FOR UPDATE;
  PERFORM app_private.assert_email_bill_scope_v1(p_organization_id,claim.building_id);
  IF inserted=0 THEN
    IF claim.income_expense_id IS NULL THEN RAISE EXCEPTION 'Biên nhận nhập hóa đơn chưa hoàn tất' USING ERRCODE='55000'; END IF;
    IF NOT app_private.can_replay_email_bill_v1(p_organization_id,claim.income_expense_id) THEN
      RAISE EXCEPTION 'Không còn quyền truy cập biên nhận hóa đơn này' USING ERRCODE='42501';
    END IF;
  END IF;
  IF claim.payload_hash<>financial_hash THEN
    RAISE EXCEPTION 'Hóa đơn đã được nhập với nội dung khác' USING ERRCODE='23505';
  END IF;
  IF inserted=0 THEN
    RETURN jsonb_build_object('id',claim.income_expense_id,'created',false);
  END IF;
  SELECT * INTO result FROM public.create_income_expense_v1(
    'EXPENSE',p_voucher->>'name',building,(p_voucher->>'room_id')::uuid,(p_voucher->>'tenant_id')::uuid,(p_voucher->>'contract_id')::uuid,
    p_voucher->>'payer_name',p_voucher->>'receive_bank_account',p_voucher->>'receive_bank_name',(p_voucher->>'account_id')::uuid,
    COALESCE(p_voucher->'attachments','[]'::jsonb),(p_voucher->>'business_result_accounting')::boolean,
    NULL,(p_voucher->>'voucher_date')::date,p_items,stable_key);
  IF result.id IS NULL OR result.organization_id IS DISTINCT FROM p_organization_id OR result.building_id IS DISTINCT FROM building THEN
    RAISE EXCEPTION 'Biên nhận phiếu chi không khớp nguồn' USING ERRCODE='55000';
  END IF;
  UPDATE public.email_bill_imports SET income_expense_id=result.id
    WHERE organization_id=p_organization_id AND provider=s->>'provider' AND receipt_id=s->>'receipt_id';
  RETURN jsonb_build_object('id',result.id,'created',true);
END $fn$;

CREATE OR REPLACE FUNCTION public.get_imported_email_bills_v1(p_organization_id uuid,p_sources jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s jsonb; normalized jsonb:='[]'; response jsonb:='[]'; permitted boolean; claim public.email_bill_imports%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập vào tổ chức' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_sources) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Danh sách nguồn không hợp lệ' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_sources)>100 THEN RAISE EXCEPTION 'Quá nhiều nguồn trong một lần tra cứu' USING ERRCODE='22023'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(p_sources) LOOP
    normalized:=normalized||jsonb_build_array(app_private.normalize_email_bill_source_v1(s));
  END LOOP;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT EXISTS(SELECT 1 FROM public.buildings b WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL
    AND COALESCE(public.can_access_building(b.id),false)
    AND COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'income_expenses.create',b.id,NULL)),false)) INTO permitted;
  IF NOT permitted THEN RAISE EXCEPTION 'Không có quyền tra cứu hóa đơn trong tổ chức' USING ERRCODE='42501'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(normalized) LOOP
    SELECT * INTO claim FROM public.email_bill_imports WHERE organization_id=p_organization_id AND provider=s->>'provider' AND receipt_id=s->>'receipt_id';
    permitted:=false;
    IF FOUND AND claim.income_expense_id IS NOT NULL THEN
      permitted:=COALESCE(public.can_access_building(claim.building_id),false)
        AND COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'income_expenses.create',claim.building_id,NULL)),false)
        AND app_private.can_replay_email_bill_v1(p_organization_id,claim.income_expense_id);
    END IF;
    response:=response||jsonb_build_array(jsonb_build_object('provider',s->>'provider','receipt_id',s->>'receipt_id','imported',permitted));
  END LOOP;
  RETURN response;
END $fn$;

ALTER FUNCTION app_private.normalize_email_bill_source_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.assert_email_bill_scope_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION app_private.can_replay_email_bill_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.create_income_expense_from_email_v1(uuid,jsonb,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION public.get_imported_email_bills_v1(uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.normalize_email_bill_source_v1(jsonb),app_private.assert_email_bill_scope_v1(uuid,uuid),
  app_private.can_replay_email_bill_v1(uuid,uuid),
  public.create_income_expense_from_email_v1(uuid,jsonb,jsonb,jsonb),public.get_imported_email_bills_v1(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.create_income_expense_from_email_v1(uuid,jsonb,jsonb,jsonb),public.get_imported_email_bills_v1(uuid,jsonb) TO authenticated;
