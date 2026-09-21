-- T6 review I1. Shared Sale claim bridge; no voucher/source contract_id rewrite and no posting change.
-- Definition provenance: the two source writers and T6 selected-source enrichment are hash pinned below.
-- Existing auth/amount/cap/account guards and public signatures/ACL are retained exactly.
BEGIN;
DO $guard$
DECLARE r record;
BEGIN
 IF md5(pg_get_functiondef('app_private.lock_org_for_decision_v1(uuid)'::regprocedure))<>'6130719b1956a291878bed6c58800e5a' THEN RAISE EXCEPTION 'Sale claim org lock definition drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND rolinherit) OR pg_has_role('authenticated','ie_action_snapshot_reader','SET') OR has_schema_privilege('ie_action_snapshot_reader','public','CREATE') OR has_schema_privilege('ie_action_snapshot_reader','app_private','CREATE') THEN RAISE EXCEPTION 'Sale claim source reader role drift'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)','c134aa5857144c2b8f66145f0e9feab5','8e71112be4f8244298b347c47e15dd05'),
  ('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)','fbaed9b582feab422372165eb55a8288','3ed571ba5d2262ec5a125a4804ef9f4a'),
  ('app_private.contract_settlement_create_facts_v1(uuid,text,uuid)','330d0c496245baa2daba55bed7fbc619','b97c2f4d3e9ff2fa3cefae1f32072c80')
 ) x(signature,old_hash,new_hash) LOOP
  IF to_regprocedure(r.signature) IS NULL OR (SELECT md5(pg_get_functiondef(to_regprocedure(r.signature)))) NOT IN (r.old_hash,r.new_hash) THEN RAISE EXCEPTION 'Sale claim dependency definition drift: %',r.signature; END IF;
  IF (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure(r.signature)) <> 'postgres'::regrole THEN RAISE EXCEPTION 'Sale claim dependency owner drift: %',r.signature; END IF;
 END LOOP;

 -- Private helper/trigger ownership and ACL drift are refused, never silently repaired.
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid IN (to_regprocedure('app_private.sale_bonus_source_claims_v1(uuid,uuid,uuid)'),to_regprocedure('app_private.guard_sale_bonus_source_claim_v1()'))) OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('guard_sale_bonus_link_claim','guard_sale_bonus_deposit_claim','guard_sale_bonus_voucher_claim')) THEN
  FOR r IN SELECT * FROM (VALUES ('app_private.sale_bonus_source_claims_v1(uuid,uuid,uuid)','60ea1b7fd95d97dc6e595a8fc06f194a'),('app_private.guard_sale_bonus_source_claim_v1()','790b93bd17b5feef285b5ab5cf75e93e')) x(signature,expected_hash) LOOP
   IF to_regprocedure(r.signature) IS NULL OR md5(pg_get_functiondef(to_regprocedure(r.signature)))<>r.expected_hash THEN RAISE EXCEPTION 'Sale claim helper definition drift: %',r.signature; END IF;
   IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(r.signature) AND (p.proowner<>'postgres'::regrole OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>'postgres'::regrole OR a.is_grantable))) THEN RAISE EXCEPTION 'Sale claim helper owner/ACL drift: %',r.signature; END IF;
  END LOOP;
  FOR r IN SELECT * FROM (VALUES
   ('public.contract_deposit_links','guard_sale_bonus_link_claim','ab86554952e7a54a262dccb6c3a53e28'),
   ('app_private.sale_bonus_claims','guard_sale_bonus_deposit_claim','46eb88e01d693101f616818ffe3f2a2f'),
   ('public.income_expenses','guard_sale_bonus_voucher_claim','42753c904979bbe5a6d35a02b9c532c2')
  ) x(relation,trigger_name,expected_hash) LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=r.relation::regclass AND t.tgname=r.trigger_name AND t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))=r.expected_hash) THEN RAISE EXCEPTION 'Sale claim trigger drift: %',r.trigger_name; END IF;
  END LOOP;
 END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)',ARRAY['postgres','authenticated','service_role']::text[]),
  ('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)',ARRAY['postgres','authenticated','service_role']::text[]),
  ('app_private.contract_settlement_create_facts_v1(uuid,text,uuid)',ARRAY['postgres','ie_action_snapshot_reader']::text[])
 ) x(signature,roles) LOOP
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=to_regprocedure(r.signature) AND (NOT a.grantee=ANY(ARRAY(SELECT role_name::regrole::oid FROM unnest(r.roles) role_name)) OR a.is_grantable)) OR EXISTS(SELECT 1 FROM unnest(r.roles) role_name WHERE NOT has_function_privilege(role_name,r.signature,'EXECUTE')) THEN RAISE EXCEPTION 'Sale claim dependency ACL drift: %',r.signature; END IF;
 END LOOP;
END $guard$;

CREATE OR REPLACE FUNCTION app_private.sale_bonus_source_claims_v1(p_org uuid,p_contract uuid,p_deposit uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private
AS $claims$
 WITH selected_contracts AS (
  SELECT c.id FROM public.contracts c WHERE c.organization_id=p_org AND (
   c.id=p_contract OR c.id IN (
    SELECT d.contract_id FROM public.income_expenses d WHERE d.id=p_deposit AND d.organization_id=p_org AND d.type='INCOME'
    UNION
    SELECT l.contract_id FROM public.contract_deposit_links l JOIN public.income_expenses d ON d.id=l.income_expense_id AND d.organization_id=l.organization_id AND d.type='INCOME'
    WHERE l.organization_id=p_org AND d.id=p_deposit AND l.link_source IN ('EXPLICIT_V2','BACKFILL_REVIEWED')
   )
  )
 ), selected_deposits AS (
  SELECT d.id FROM public.income_expenses d WHERE d.organization_id=p_org AND d.type='INCOME' AND (
   d.id=p_deposit OR d.contract_id IN (SELECT id FROM selected_contracts) OR EXISTS (
    SELECT 1 FROM public.contract_deposit_links l WHERE l.organization_id=p_org AND l.income_expense_id=d.id
      AND l.contract_id IN (SELECT id FROM selected_contracts) AND l.link_source IN ('EXPLICIT_V2','BACKFILL_REVIEWED')
   )
  )
 )
 SELECT coalesce(array_agg(DISTINCT b.id ORDER BY b.id),'{}'::uuid[]) FROM public.income_expenses b
 WHERE b.organization_id=p_org AND b.commission_kind='sale' AND b.type='EXPENSE' AND b.deleted_at IS NULL AND b.approval_status<>'CANCELLED'
 AND (b.contract_id IN (SELECT id FROM selected_contracts) OR EXISTS (
  SELECT 1 FROM app_private.sale_bonus_claims claim WHERE claim.organization_id=p_org AND claim.bonus_voucher_id=b.id AND claim.deposit_voucher_id IN (SELECT id FROM selected_deposits)
 ));
$claims$;
ALTER FUNCTION app_private.sale_bonus_source_claims_v1(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.sale_bonus_source_claims_v1(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,ie_action_snapshot_reader;

CREATE OR REPLACE FUNCTION app_private.guard_sale_bonus_source_claim_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private
AS $guard_claim$
DECLARE v_claims uuid[];v_deposit uuid;v_max integer:=0;v_exclude uuid;
BEGIN
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='contract_deposit_links' THEN
  IF TG_OP='UPDATE' AND (NEW.organization_id,NEW.contract_id,NEW.income_expense_id,NEW.link_source) IS NOT DISTINCT FROM (OLD.organization_id,OLD.contract_id,OLD.income_expense_id,OLD.link_source) THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.contracts c JOIN public.income_expenses d ON d.id=NEW.income_expense_id AND d.organization_id=c.organization_id AND d.type='INCOME' WHERE c.id=NEW.contract_id AND c.organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Sale source link organization mismatch' USING ERRCODE='23514'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(NEW.organization_id);
  v_claims:=app_private.sale_bonus_source_claims_v1(NEW.organization_id,NEW.contract_id,NEW.income_expense_id);
  v_max:=1;
 ELSIF TG_TABLE_SCHEMA='app_private' AND TG_TABLE_NAME='sale_bonus_claims' THEN
  IF NOT EXISTS(SELECT 1 FROM public.income_expenses b WHERE b.id=NEW.bonus_voucher_id AND b.organization_id=NEW.organization_id AND b.type='EXPENSE' AND b.commission_kind='sale') OR (NEW.deposit_voucher_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.income_expenses d WHERE d.id=NEW.deposit_voucher_id AND d.organization_id=NEW.organization_id AND d.type='INCOME')) OR (NEW.contract_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=NEW.contract_id AND c.organization_id=NEW.organization_id)) THEN RAISE EXCEPTION 'Sale claim organization/source mismatch' USING ERRCODE='23514'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(NEW.organization_id);
  v_claims:=app_private.sale_bonus_source_claims_v1(NEW.organization_id,NEW.contract_id,NEW.deposit_voucher_id);
  v_exclude:=NEW.bonus_voucher_id;
 ELSIF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='income_expenses' THEN
  IF TG_OP='UPDATE' AND (NEW.organization_id,NEW.contract_id,NEW.commission_kind,NEW.type,NEW.deleted_at IS NULL AND NEW.approval_status<>'CANCELLED') IS NOT DISTINCT FROM (OLD.organization_id,OLD.contract_id,OLD.commission_kind,OLD.type,OLD.deleted_at IS NULL AND OLD.approval_status<>'CANCELLED') THEN RETURN NEW; END IF;
  IF NEW.deleted_at IS NOT NULL OR NEW.approval_status='CANCELLED' THEN RETURN NEW; END IF;
  IF NEW.type='EXPENSE' AND NEW.commission_kind='sale' THEN
   SELECT claim.deposit_voucher_id INTO v_deposit FROM app_private.sale_bonus_claims claim WHERE claim.organization_id=NEW.organization_id AND claim.bonus_voucher_id=NEW.id;
   IF NEW.contract_id IS NULL AND v_deposit IS NULL THEN RETURN NEW; END IF; -- New deposit birth is checked when its private claim is inserted in the same transaction.
   PERFORM app_private.lock_org_for_decision_v1(NEW.organization_id);
   v_claims:=app_private.sale_bonus_source_claims_v1(NEW.organization_id,NEW.contract_id,v_deposit);
   v_exclude:=NEW.id;
  ELSIF NEW.type='INCOME' AND NEW.contract_id IS NOT NULL THEN
   PERFORM app_private.lock_org_for_decision_v1(NEW.organization_id);
   v_claims:=app_private.sale_bonus_source_claims_v1(NEW.organization_id,NEW.contract_id,NEW.id);
   v_max:=1;
  ELSE RETURN NEW; END IF;
 ELSE RAISE EXCEPTION 'Invalid Sale claim trigger target'; END IF;
 IF cardinality(array_remove(v_claims,v_exclude))>v_max THEN
  RAISE EXCEPTION 'Nguồn liên kết đã có phiếu thưởng Sale còn hiệu lực. Tải lại để đối chiếu.' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END $guard_claim$;
ALTER FUNCTION app_private.guard_sale_bonus_source_claim_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.guard_sale_bonus_source_claim_v1() FROM PUBLIC,anon,authenticated,service_role,ie_action_snapshot_reader;

DROP TRIGGER IF EXISTS guard_sale_bonus_link_claim ON public.contract_deposit_links;
CREATE TRIGGER guard_sale_bonus_link_claim BEFORE INSERT OR UPDATE ON public.contract_deposit_links FOR EACH ROW EXECUTE FUNCTION app_private.guard_sale_bonus_source_claim_v1();
DROP TRIGGER IF EXISTS guard_sale_bonus_deposit_claim ON app_private.sale_bonus_claims;
CREATE TRIGGER guard_sale_bonus_deposit_claim BEFORE INSERT OR UPDATE ON app_private.sale_bonus_claims FOR EACH ROW EXECUTE FUNCTION app_private.guard_sale_bonus_source_claim_v1();
DROP TRIGGER IF EXISTS guard_sale_bonus_voucher_claim ON public.income_expenses;
CREATE TRIGGER guard_sale_bonus_voucher_claim BEFORE INSERT OR UPDATE OF organization_id,contract_id,commission_kind,type,deleted_at,approval_status ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.guard_sale_bonus_source_claim_v1();

CREATE OR REPLACE FUNCTION public.create_commission_voucher(p_contract_id uuid, p_kind text, p_amount numeric, p_voucher_date date, p_account_id uuid DEFAULT NULL::uuid, p_payer_name text DEFAULT NULL::text, p_recipient_name text DEFAULT NULL::text, p_recipient_bank text DEFAULT NULL::text, p_recipient_account text DEFAULT NULL::text, p_item_description text DEFAULT NULL::text, p_attachments jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_contract record;
  v_existing record;
  v_type_id uuid;
  v_type_name text;
  v_kind_label text;
  v_creator text;
  v_name text;
  v_id uuid;
  v_code text;
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('broker', 'sale') THEN
    RAISE EXCEPTION 'Loại hoa hồng không hợp lệ: %', COALESCE(p_kind, 'null')
      USING ERRCODE = '23514';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền hoa hồng phải lớn hơn 0'
      USING ERRCODE = '23514';
  END IF;
  IF p_voucher_date IS NULL THEN
    RAISE EXCEPTION 'Thiếu ngày chi' USING ERRCODE = '23502';
  END IF;
  IF jsonb_typeof(v_attachments) <> 'array' THEN
    RAISE EXCEPTION 'Ảnh chứng từ không hợp lệ (cần mảng URL)'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    contract_row.id,
    contract_row.contract_number,
    room_row.id AS room_id,
    building_row.id AS building_id,
    building_row.user_id AS owner_id,
    COALESCE(contract_row.organization_id, building_row.organization_id)
      AS organization_id
  INTO v_contract
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hợp đồng' USING ERRCODE = 'P0002';
  END IF;
  IF v_contract.organization_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa thuộc tổ chức'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    public.can_access_building(v_contract.building_id)
    OR public.ie_all_buildings_scope(v_contract.building_id)
    OR v_contract.owner_id = v_uid
    OR public.is_admin()
    OR public.is_super_admin()
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền chi hoa hồng cho tòa nhà này'
      USING ERRCODE = '42501';
  END IF;

  -- Shared source claim lock precedes the claim witness (including explicit deposit links).
  IF p_kind = 'sale' THEN
    PERFORM app_private.lock_org_for_decision_v1(v_contract.organization_id);
  IF cardinality(app_private.sale_bonus_source_claims_v1(v_contract.organization_id,p_contract_id,NULL)) > 0 THEN
    RAISE EXCEPTION 'Nguồn này đã có phiếu thưởng Sale còn hiệu lực. Tải lại để đối chiếu.' USING ERRCODE='23505';
  END IF;
  END IF;

  v_kind_label := CASE p_kind
    WHEN 'broker' THEN 'hoa hồng môi giới'
    ELSE 'thưởng nóng Sale'
  END;

  PERFORM pg_advisory_xact_lock(
    hashtext('commission:' || p_contract_id::text || ':' || p_kind)
  );

  SELECT voucher.code
    INTO v_existing
  FROM public.income_expenses voucher
  WHERE voucher.contract_id = p_contract_id
    AND voucher.commission_kind = p_kind
    AND voucher.deleted_at IS NULL
    AND voucher.approval_status <> 'CANCELLED'
  ORDER BY voucher.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'HĐ % đã có phiếu % (mã %). Mỗi hợp đồng chỉ chi 1 lần — không thể tạo thêm. Nếu phiếu cũ sai, hãy hủy phiếu đó trước.',
      COALESCE(v_contract.contract_number, ''),
      v_kind_label,
      v_existing.code
      USING ERRCODE = 'P0001';
  END IF;

  -- SALE_BONUS_SEES_DEPOSIT_CLAIM: phiếu thưởng Sale có thể đã sinh từ PHIẾU CỌC lúc
  -- hợp đồng chưa tồn tại. Phiếu đó contract_id NULL nên VÔ HÌNH với cả
  -- advisory lock, pre-check P0001 lẫn unique index ở trên. Không có chốt
  -- này thì mở luồng "thưởng từ phiếu cọc" là mở toang khoá chống chi trùng.
  IF p_kind = 'sale' THEN
    DECLARE v_prev uuid; v_prev_code text;
    BEGIN
      SELECT bon.id, bon.code INTO v_prev, v_prev_code
        FROM app_private.sale_bonus_claims sbc
        JOIN public.income_expenses dep ON dep.id = sbc.deposit_voucher_id
        JOIN public.income_expenses bon ON bon.id = sbc.bonus_voucher_id
       WHERE dep.contract_id = p_contract_id
         AND bon.deleted_at IS NULL
         AND bon.approval_status <> 'CANCELLED'
       LIMIT 1;
      IF v_prev IS NOT NULL THEN
        RAISE EXCEPTION 'Hợp đồng này đã được thưởng Sale từ phiếu cọc rồi (phiếu %)',
          COALESCE(v_prev_code, v_prev::text) USING ERRCODE = 'P0001';
      END IF;
    END;
  END IF;

  v_type_name := CASE p_kind
    WHEN 'broker' THEN 'Hoa hồng môi giới'
    ELSE 'Thưởng nóng Sale'
  END;

  SELECT t.id
    INTO v_type_id
  FROM public.income_expense_types AS t
  WHERE t.organization_id = v_contract.organization_id
    AND lower(btrim(t.type)) = 'expense'
    AND public.normalize_income_expense_type_name(t.name) =
        public.normalize_income_expense_type_name(v_type_name)
  ORDER BY COALESCE(t.is_default, false) DESC, t.created_at, t.id
  LIMIT 1;

  IF v_type_id IS NULL THEN
    v_type_id := app_private.ensure_income_expense_type_v1(
      p_organization_id => v_contract.organization_id,
      p_user_id => v_contract.owner_id,
      p_name => v_type_name,
      p_type => 'expense',
      p_description => CASE p_kind
        WHEN 'broker' THEN 'Tự động tạo khi tạo hợp đồng — % tiền phòng theo bậc tháng cấu hình ở tòa nhà.'
        ELSE 'Thưởng cho Sale khi tạo hợp đồng — số tiền do người dùng nhập.'
      END,
      p_force_approval => true,
      p_system_only => true
    );
  END IF;

  SELECT COALESCE(
           NULLIF(profile.full_name, ''),
           NULLIF(profile.email, ''),
           auth_user.email,
           'Người dùng'
         )
    INTO v_creator
  FROM auth.users auth_user
  LEFT JOIN public.profiles profile ON profile.id = auth_user.id
  WHERE auth_user.id = v_uid;

  -- TÊN THEO PHÒNG (02/09/2026): "Hoa hồng <Phòng>/<Tòa> - dd/mm/yyyy - STT".
  -- Facts NULL (HĐ không có phòng) ⇒ giữ tên cũ để không bao giờ chặn tạo phiếu.
  v_name := COALESCE(
    app_private.commission_voucher_name_v1(p_kind, p_contract_id),
    btrim(
      CASE p_kind
        WHEN 'broker' THEN 'Hoa hồng môi giới HĐ '
        ELSE 'Thưởng nóng Sale HĐ '
      END || COALESCE(v_contract.contract_number, '')
    )
  );

  INSERT INTO public.income_expenses (
    user_id,
    organization_id,
    creator_name,
    type,
    approval_status,
    name,
    building_id,
    room_id,
    tenant_id,
    contract_id,
    voucher_date,
    account_id,
    payer_name,
    receive_bank_name,
    receive_bank_account,
    notes,
    attachments,
    business_result_accounting,
    repeat_cycle,
    repeat_infinity,
    repeat_count,
    repeat_remaining,
    commission_kind,
    system_source
  ) VALUES (
    v_uid,
    v_contract.organization_id,
    v_creator,
    'EXPENSE',
    'UNAPPROVED',
    v_name,
    v_contract.building_id,
    v_contract.room_id,
    NULL,
    p_contract_id,
    p_voucher_date,
    p_account_id,
    p_payer_name,
    p_recipient_bank,
    p_recipient_account,
    CASE
      WHEN COALESCE(p_recipient_name, '') <> ''
        THEN 'Người nhận: ' || p_recipient_name
      ELSE NULL
    END,
    v_attachments,
    NULL,
    'NONE',
    false,
    0,
    0,
    p_kind,
    'contract.commission'
  )
  RETURNING id, code INTO v_id, v_code;

  INSERT INTO public.income_expense_items (
    income_expense_id,
    income_expense_type_id,
    organization_id,
    description,
    quantity,
    unit_price,
    start_date,
    end_date
  ) VALUES (
    v_id,
    v_type_id,
    v_contract.organization_id,
    COALESCE(NULLIF(p_item_description, ''), v_name),
    1,
    p_amount,
    p_voucher_date,
    p_voucher_date
  );

  -- COMMISSION_AUTOPAY_V1: hoa hồng môi giới đủ bốn điều kiện chủ chốt 31/07 thì
  -- máy duyệt hộ và ghi sổ luôn. Thiếu một điều ⇒ để nguyên chờ duyệt (hành
  -- vi cũ). Bảng bậc rỗng ⇒ luôn rơi vào NO_TIER ⇒ không phiếu nào tự duyệt.
  IF p_kind = 'broker' AND v_id IS NOT NULL THEN
    DECLARE v_chk jsonb; v_acc_ok boolean;
    BEGIN
      v_chk := app_private.commission_autopay_check_v1(p_contract_id, p_amount);
      SELECT (a.id IS NOT NULL AND NOT COALESCE(a.is_virtual,false)) INTO v_acc_ok
        FROM public.accounts a
       WHERE a.id = (SELECT account_id FROM public.income_expenses WHERE id = v_id);
      IF (v_chk->>'verdict') = 'VALID' AND COALESCE(v_acc_ok,false) THEN
        PERFORM app_private.special_fee_approve_and_post_v1(v_id, 'BROKER_COMMISSION');
      END IF;
    END;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'code', v_code);
END
$function$
;

CREATE OR REPLACE FUNCTION public.create_sale_bonus_from_deposit_v1(p_deposit_voucher_id uuid, p_amount numeric, p_recipient text DEFAULT NULL::text, p_account_number text DEFAULT NULL::text, p_bank text DEFAULT NULL::text, p_voucher_date date DEFAULT NULL::date, p_account_id uuid DEFAULT NULL::uuid, p_attachments jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_dep   public.income_expenses;
  v_org   uuid;
  v_bld   uuid;
  v_room  uuid;
  v_cap   numeric;
  v_type  uuid;
  v_ie    uuid;
  v_code  text;
  v_exist uuid;
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
  v_acc_org   uuid;
  v_acc_owner uuid;
  v_acc_ok    boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền thưởng phải lớn hơn 0' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_attachments) <> 'array' THEN
    RAISE EXCEPTION 'Ảnh chứng từ không hợp lệ (cần mảng URL)' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_attachments) e
     WHERE jsonb_typeof(e) <> 'string'
  ) THEN
    RAISE EXCEPTION 'Ảnh chứng từ không hợp lệ (mỗi phần tử phải là URL dạng chuỗi)'
      USING ERRCODE = '23514';
  END IF;

  -- Org before deposit: serialize with contract creation/linking and the Sale contract writer.
  SELECT organization_id INTO v_org FROM public.income_expenses WHERE id=p_deposit_voucher_id;
  IF v_org IS NOT NULL THEN PERFORM app_private.lock_org_for_decision_v1(v_org); END IF;

  -- Khoá phiếu cọc: hai người cùng bấm thưởng cho một phiếu cọc phải xếp hàng.
  SELECT * INTO v_dep FROM public.income_expenses
   WHERE id = p_deposit_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu cọc' USING ERRCODE = 'P0002';
  END IF;
  IF v_dep.deleted_at IS NOT NULL OR v_dep.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiếu cọc đã huỷ — không thưởng được' USING ERRCODE = '55000';
  END IF;
  IF v_dep.type IS DISTINCT FROM 'INCOME' THEN
    RAISE EXCEPTION 'Phiếu này không phải phiếu thu cọc' USING ERRCODE = '22023';
  END IF;

  v_org  := v_dep.organization_id;
  v_bld  := v_dep.building_id;
  v_room := v_dep.room_id;

  IF NOT (public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld)
       OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền tạo phiếu trên toà này' USING ERRCODE = '42501';
  END IF;

  -- ══ SỔ QUỸ — tuỳ chọn, nhưng đã chọn thì phải có quyền ════════════
  IF p_account_id IS NOT NULL THEN
    SELECT a.organization_id, a.user_id INTO v_acc_org, v_acc_owner
      FROM public.accounts a
     WHERE a.id = p_account_id AND a.deleted_at IS NULL;
    IF v_acc_org IS NULL OR v_acc_org IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
    -- §9.2: CUSTODIAN/OPERATOR làm mọi loại phiếu; KNOWER chỉ Phiếu thu, mà đây
    -- là phiếu CHI ⇒ KNOWER không đủ.
    v_acc_ok := (v_acc_owner = v_actor) OR EXISTS (
      SELECT 1
        FROM public.cashbook_possession_bindings b
        JOIN public.organization_memberships m ON m.id = b.membership_id
       WHERE b.cashbook_id = p_account_id
         AND b.organization_id = v_org
         AND m.user_id = v_actor
         AND m.status = 'ACTIVE'
         AND b.valid_to IS NULL
         AND b.possession_kind IN ('CUSTODIAN','OPERATOR')
    );
    IF NOT COALESCE(v_acc_ok, false) THEN
      RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF cardinality(app_private.sale_bonus_source_claims_v1(v_org,NULL,p_deposit_voucher_id)) > 0 THEN
    RAISE EXCEPTION 'Nguồn này đã có phiếu thưởng Sale còn hiệu lực. Tải lại để đối chiếu.' USING ERRCODE='23505';
  END IF;

  -- ══ CHỐNG CHI TRÙNG — hai hướng ═══════════════════════════════════
  -- (a) Chính phiếu cọc này đã thưởng chưa.
  SELECT sbc.bonus_voucher_id INTO v_exist
    FROM app_private.sale_bonus_claims sbc
    JOIN public.income_expenses bon ON bon.id = sbc.bonus_voucher_id
   WHERE sbc.deposit_voucher_id = p_deposit_voucher_id
     AND bon.deleted_at IS NULL AND bon.approval_status <> 'CANCELLED';
  IF v_exist IS NOT NULL THEN
    SELECT code INTO v_code FROM public.income_expenses WHERE id = v_exist;
    RAISE EXCEPTION 'Phiếu cọc này đã được thưởng Sale rồi (phiếu %)', COALESCE(v_code, v_exist::text)
      USING ERRCODE = 'P0001';
  END IF;

  -- (b) Phiếu cọc đã gắn hợp đồng, mà hợp đồng đó đã thưởng qua đường khác.
  IF v_dep.contract_id IS NOT NULL THEN
    SELECT ie.id INTO v_exist FROM public.income_expenses ie
     WHERE ie.contract_id = v_dep.contract_id AND ie.commission_kind = 'sale'
       AND ie.deleted_at IS NULL AND ie.approval_status <> 'CANCELLED'
       AND NOT COALESCE(ie.commission_legacy_dup, false)
     LIMIT 1;
    IF v_exist IS NOT NULL THEN
      SELECT code INTO v_code FROM public.income_expenses WHERE id = v_exist;
      RAISE EXCEPTION 'Hợp đồng của phiếu cọc này đã được thưởng Sale rồi (phiếu %)',
        COALESCE(v_code, v_exist::text) USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ══ TRẦN — chỉ áp khi chủ đã công bố ══════════════════════════════
  v_cap := app_private.sale_bonus_cap_for_v1(v_org, v_bld, public.org_today_v1(v_org));
  IF v_cap IS NOT NULL AND p_amount > v_cap THEN
    RAISE EXCEPTION
      'Thưởng % vượt trần % của toà này. Muốn chi cao hơn thì chủ phải nâng trần ở Cài đặt.',
      replace(to_char(round(p_amount), 'FM999G999G999G999'), ',', '.') || 'đ',
      replace(to_char(round(v_cap),   'FM999G999G999G999'), ',', '.') || 'đ'
      USING ERRCODE = '55000';
  END IF;

  v_type := app_private.ensure_income_expense_type_v1(
              v_org, v_actor, 'Thưởng nóng Sale', 'expense',
              NULL, NULL, false, false, false, false, false, false);

  -- Cấp phát UUID TRƯỚC để mở được cửa `SALE_BONUS_DEPOSIT` cho đúng phiếu này:
  -- `trigger_ie_commission_guard` chạy BEFORE INSERT nên cửa phải mở trước đó,
  -- mà bảng cửa khoá theo id phiếu. Đóng cửa ngay sau lệnh INSERT.
  v_ie := gen_random_uuid();
  PERFORM app_private.begin_ie_flex_write_v1(v_ie, 'SALE_BONUS_DEPOSIT');

  INSERT INTO public.income_expenses
    (id, user_id, organization_id, type, name, building_id, room_id, contract_id,
     voucher_date, total_amount, approval_status, commission_kind, system_source,
     account_id, attachments, receive_bank_account, receive_bank_name, notes)
  VALUES
    (v_ie, v_actor, v_org, 'EXPENSE',
     'Thưởng nóng Sale' || COALESCE(' — ' || NULLIF(btrim(p_recipient), ''), ''),
     v_bld, v_room,
     -- Cố ý GIỮ NGUYÊN contract_id của phiếu cọc (thường là NULL lúc này).
     -- Không tự bịa hợp đồng: quan hệ nằm ở sổ claim bên dưới.
     v_dep.contract_id,
     COALESCE(p_voucher_date, public.org_today_v1(v_org)),
     p_amount, 'UNAPPROVED', 'sale', 'contract.commission',
     p_account_id,
     v_attachments,
     NULLIF(btrim(p_account_number), ''),
     NULLIF(btrim(p_bank), ''),
     'Thưởng Sale theo phiếu cọc ' || COALESCE(v_dep.code, left(v_dep.id::text, 8))
       || COALESCE(' — ' || NULLIF(btrim(p_recipient), ''), '')
       || COALESCE(' — STK ' || NULLIF(btrim(p_account_number), ''), '')
       || COALESCE(' — ' || NULLIF(btrim(p_bank), ''), ''))
  RETURNING code INTO v_code;

  PERFORM app_private.end_ie_flex_write_v1(v_ie);

  INSERT INTO public.income_expense_items
    (income_expense_id, income_expense_type_id, accounting_class,
     description, quantity, unit_price, amount)
  VALUES (v_ie, v_type, 'PNL',
          'Thưởng nóng Sale — phiếu cọc ' || COALESCE(v_dep.code, left(v_dep.id::text, 8)),
          1, p_amount, p_amount);

  INSERT INTO app_private.sale_bonus_claims
    (organization_id, deposit_voucher_id, contract_id, bonus_voucher_id, amount, created_by)
  VALUES (v_org, p_deposit_voucher_id, v_dep.contract_id, v_ie, p_amount, v_actor);

  RETURN jsonb_build_object(
    'voucherId', v_ie, 'code', v_code, 'amount', p_amount,
    'depositVoucherId', p_deposit_voucher_id,
    'note', 'Phiếu thưởng đã tạo và đang CHỜ DUYỆT. Khi hợp đồng của phiếu cọc này được ký, hệ thống sẽ tự biết là đã thưởng rồi.');
END;
$function$
;

CREATE OR REPLACE FUNCTION app_private.contract_settlement_create_facts_v1(p_org uuid, p_kind text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE v_contract public.contracts%ROWTYPE; v_dep public.income_expenses%ROWTYPE; v_term public.contract_terminations%ROWTYPE;
 v_building public.buildings%ROWTYPE; v_bld uuid; v_contract_id uuid; v_claims uuid[]; v_allowed boolean; v_cap numeric; v_months integer; v_rate numeric; v_preview jsonb; v_obligation jsonb;
BEGIN
 -- Only the non-bypass public reader has EXECUTE, after checking actual source RLS.
 PERFORM app_private.income_expense_action_scope_v1(p_org);
 IF p_kind IN ('broker','sale_contract') THEN
  SELECT * INTO STRICT v_contract FROM public.contracts WHERE id=p_id AND organization_id=p_org AND deleted_at IS NULL;
  v_contract_id:=v_contract.id;SELECT building_id INTO v_bld FROM public.rooms WHERE id=v_contract.room_id AND organization_id=p_org;
 ELSIF p_kind='sale_deposit' THEN
  SELECT * INTO STRICT v_dep FROM public.income_expenses WHERE id=p_id AND organization_id=p_org AND deleted_at IS NULL;
  v_bld:=v_dep.building_id;v_contract_id:=v_dep.contract_id;
 ELSIF p_kind='termination_refund' THEN
  SELECT * INTO STRICT v_term FROM public.contract_terminations WHERE id=p_id AND organization_id=p_org;
  SELECT * INTO STRICT v_contract FROM public.contracts WHERE id=v_term.contract_id AND organization_id=p_org AND deleted_at IS NULL;
  v_contract_id:=v_contract.id;SELECT building_id INTO v_bld FROM public.rooms WHERE id=v_contract.room_id AND organization_id=p_org;
 ELSE RAISE EXCEPTION 'Unsupported source kind' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT v_building FROM public.buildings WHERE id=v_bld AND organization_id=p_org AND deleted_at IS NULL;
 -- Mirrors the existing source writers, including broker's building-owner case.
 v_allowed:=public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld) OR public.is_admin() OR public.is_super_admin() OR (p_kind IN ('broker','sale_contract') AND v_building.user_id=auth.uid());
 IF p_kind='broker' THEN
  SELECT array_agg(v.id ORDER BY v.id) INTO v_claims FROM public.income_expenses v WHERE v.organization_id=p_org AND v.contract_id=p_id AND v.commission_kind='broker' AND v.deleted_at IS NULL AND v.approval_status<>'CANCELLED';
  v_months:=greatest(0,(extract(year FROM age(v_contract.end_date,v_contract.start_date))*12+extract(month FROM age(v_contract.end_date,v_contract.start_date)))::integer);
  v_rate:=app_private.commission_rate_for_v1(p_org,v_bld,v_months,public.org_today_v1(p_org));
 ELSIF p_kind IN ('sale_contract','sale_deposit') THEN
  v_cap:=app_private.sale_bonus_cap_for_v1(p_org,v_bld,public.org_today_v1(p_org));
  v_claims:=app_private.sale_bonus_source_claims_v1(p_org,CASE WHEN p_kind='sale_contract' THEN p_id END,CASE WHEN p_kind='sale_deposit' THEN p_id END);
 ELSE
  v_preview:=public.preview_termination_refund_v1(p_id)-'basis';
  SELECT array_agg(DISTINCT v.id ORDER BY v.id) INTO v_claims FROM public.termination_refund_obligations o JOIN public.income_expenses v ON v.id=o.voucher_id AND v.organization_id=o.organization_id WHERE o.organization_id=p_org AND o.termination_id=p_id AND v.deleted_at IS NULL AND v.approval_status<>'CANCELLED';
  SELECT jsonb_build_object('id',o.id,'organization_id',o.organization_id,'termination_id',o.termination_id,'contract_id',o.contract_id,'version',o.version,'requested_amount',o.requested_amount,'real_held',o.real_held,'recognized_only',o.recognized_only,'basis_fingerprint',o.basis_fingerprint,'obligation_status',o.obligation_status) INTO v_obligation FROM public.termination_refund_obligations o WHERE o.organization_id=p_org AND o.termination_id=p_id ORDER BY o.version DESC,o.id LIMIT 1;
 END IF;
 RETURN jsonb_build_object('canCreate',coalesce(v_allowed,false),'canForce',public.is_super_admin() OR app_private.is_org_owner_v1(p_org,auth.uid()),'claimIds',coalesce(to_jsonb(v_claims),'[]'::jsonb),'isDeposit',CASE WHEN p_kind='sale_deposit' THEN EXISTS(SELECT 1 FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id=i.income_expense_type_id WHERE i.income_expense_id=p_id AND i.organization_id=p_org AND t.is_deposit) ELSE NULL END,
  'capAmount',v_cap,'months',v_months,'ratePercent',v_rate,'expectedAmount',CASE WHEN v_rate IS NOT NULL THEN round(v_contract.rent_price*v_rate/100) ELSE NULL END,'refund',v_preview,'latestObligation',v_obligation);
END $function$
;
NOTIFY pgrst,'reload schema';
COMMIT;
