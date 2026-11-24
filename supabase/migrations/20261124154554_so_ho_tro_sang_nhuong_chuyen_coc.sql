-- Số tiền khách cũ hỗ trợ khách mới khi sang nhượng phòng: chuyển cọc giữa hai hợp đồng, khớp hai bên, không qua
-- doanh thu. Plan "Sang nhượng phòng trong hộp Thanh lý", đợt 3, phần máy chủ (chủ duyệt 24/11/2026).
--
-- Bút toán: một cặp phiếu ĐÃ DUYỆT trên sổ nội bộ (_internal_settlement_account), cùng số tiền, cùng ngày hôm nay
-- của công ty: phiếu chi dòng DEPOSIT trên hợp đồng cũ (exit.support_out) và phiếu thu dòng DEPOSIT trên hợp đồng
-- mới (exit.support_in). contracts.deposit_paid của hai bên đổi đúng số đó (contract_deposit_paid_derived), nên máy
-- quyết toán không đổi: cọc cũ đem ra quyết toán tự nhỏ đi, hoá đơn đầu của khách mới thiếu cọc ít đi.
-- Trần: số hỗ trợ <= cọc cũ đã thu - phí môi giới, và <= phần cọc còn thiếu của hợp đồng mới.
--
-- Hàm hiện hành chỉ nối thêm bằng neo (mỗi neo đúng một lần, chạy lại thì bỏ qua):
--   create_contract_v2 (một dòng trước recompute_contract_deposit_paid), sign_and_checkin_contract_draft_v1 (nhận
--   transfer_support_amount ở đường nháp), meter_capture_exit_v1 + app_private.meter_capture_invoke_writer_v1 (đường
--   ảnh đồng hồ đi qua confirm_contract_return_v2, để trả phòng trước hạn trường hợp chủ nhà hỗ trợ quyết toán ngay),
--   app_private.contract_exit_early_terms_response_v1 (thêm mã hai phiếu).
-- Không vá hàm nào trong nhóm retirement của supabase/migration-policy.json.

DO $requires$
BEGIN
  IF to_regclass('public.contract_exit_early_terms') IS NULL OR to_regclass('app_private.contract_exit_early_term_events') IS NULL
    OR to_regclass('public.income_expenses') IS NULL OR to_regclass('public.income_expense_items') IS NULL
    OR to_regclass('app_private.sale_bonus_claims') IS NULL
    OR to_regprocedure('public.create_contract_v2(jsonb,text)') IS NULL
    OR to_regprocedure('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])') IS NULL
    OR to_regprocedure('public.meter_capture_exit_v1(uuid,text,jsonb,jsonb)') IS NULL
    OR to_regprocedure('app_private.meter_capture_invoke_writer_v1(text,jsonb)') IS NULL
    OR to_regprocedure('public.confirm_contract_return_v2(uuid,uuid,timestamp with time zone,text,date,text,text,jsonb,jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.contract_exit_early_terms_response_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.contract_exit_early_term_event_v1(uuid,text,text,uuid,text,jsonb)') IS NULL
    OR to_regprocedure('public._internal_settlement_account(uuid)') IS NULL
    OR to_regprocedure('public.normalize_income_expense_type_name(text)') IS NULL
    OR to_regprocedure('public.recompute_contract_deposit_paid(uuid)') IS NULL
    OR to_regprocedure('public.contract_deposit_paid_derived(uuid)') IS NULL
    OR to_regprocedure('app_private.finance_v2_transition_owned_approval(uuid,text,text)') IS NULL
    OR to_regprocedure('app_private.assert_contract_exit_writer_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.require_building_perm_v1(uuid,text,text[])') IS NULL
    OR to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') IS NULL
    OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
    OR to_regprocedure('public.my_org_ids()') IS NULL THEN
    RAISE EXCEPTION 'so_ho_tro_sang_nhuong_thieu_phu_thuoc' USING ERRCODE='55000';
  END IF;
END
$requires$;

-- 1. Giấy phép ghi/đảo hai phiếu chuyển cọc: chỉ sống trong đúng giao dịch và tiến trình đang ghi.
CREATE TABLE IF NOT EXISTS app_private.contract_exit_support_writes (
  income_expense_id uuid PRIMARY KEY,
  xid xid8 NOT NULL,
  backend_pid integer NOT NULL
);
ALTER TABLE app_private.contract_exit_support_writes OWNER TO postgres;
ALTER TABLE app_private.contract_exit_support_writes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.contract_exit_support_writes FROM PUBLIC,anon,authenticated,service_role;

-- 2. Số hỗ trợ và hai mã phiếu đi cùng nhau; chỉ có ở hồ sơ sang nhượng đã nối hợp đồng mới.
DO $constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.contract_exit_early_terms'::regclass
      AND conname='contract_exit_early_terms_support') THEN
    ALTER TABLE public.contract_exit_early_terms ADD CONSTRAINT contract_exit_early_terms_support CHECK (
      (support_amount=0)=(support_out_voucher_id IS NULL) AND (support_amount=0)=(support_in_voucher_id IS NULL)
      AND (support_amount=0 OR (early_reason IN ('SALE_ASSISTED','SELF_FOUND') AND new_contract_id IS NOT NULL)));
  END IF;
END
$constraint$;

CREATE OR REPLACE FUNCTION app_private.exit_support_write_allowed_v1(p_voucher uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT EXISTS (SELECT 1 FROM app_private.contract_exit_support_writes w
    WHERE w.income_expense_id=p_voucher AND w.xid=pg_current_xact_id_if_assigned() AND w.backend_pid=pg_backend_pid())
$fn$;

-- 3. Hai phiếu chuyển cọc không xoá, không huỷ, không sửa tiền/hợp đồng/sổ/ngày được; chỉ đảo qua
-- reverse_contract_exit_support_v1. Phiếu mới mang nguồn exit.support_* chỉ do writer của migration này ghi.
CREATE OR REPLACE FUNCTION app_private.guard_exit_support_voucher_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.system_source IN ('exit.support_out','exit.support_in') AND NOT app_private.exit_support_write_allowed_v1(NEW.id) THEN
      RAISE EXCEPTION 'Phiếu chuyển cọc khách cũ hỗ trợ khách nhận chỉ được ghi khi tạo hợp đồng khách nhận' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.system_source IN ('exit.support_out','exit.support_in') THEN
      RAISE EXCEPTION 'Phiếu chuyển cọc khách cũ hỗ trợ khách nhận không xoá được; đảo số hỗ trợ ở hồ sơ trả phòng' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF (OLD.system_source IN ('exit.support_out','exit.support_in') OR NEW.system_source IN ('exit.support_out','exit.support_in'))
    AND NOT app_private.exit_support_write_allowed_v1(OLD.id)
    AND (NEW.approval_status IS DISTINCT FROM OLD.approval_status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
      OR NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.type IS DISTINCT FROM OLD.type
      OR NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.room_id IS DISTINCT FROM OLD.room_id
      OR NEW.building_id IS DISTINCT FROM OLD.building_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.voucher_date IS DISTINCT FROM OLD.voucher_date OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.system_source IS DISTINCT FROM OLD.system_source OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id) THEN
    RAISE EXCEPTION 'Phiếu chuyển cọc khách cũ hỗ trợ khách nhận không huỷ hay sửa được; đảo số hỗ trợ ở hồ sơ trả phòng' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS a00_exit_support_voucher_guard ON public.income_expenses;
CREATE TRIGGER a00_exit_support_voucher_guard BEFORE INSERT OR UPDATE OR DELETE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_exit_support_voucher_v1();

CREATE OR REPLACE FUNCTION app_private.guard_exit_support_item_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_new uuid; v_old uuid;
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') THEN v_new:=NEW.income_expense_id; END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN v_old:=OLD.income_expense_id; END IF;
  IF TG_OP='UPDATE' AND NEW.income_expense_id IS NOT DISTINCT FROM OLD.income_expense_id
    AND NEW.amount IS NOT DISTINCT FROM OLD.amount AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
    AND NEW.unit_price IS NOT DISTINCT FROM OLD.unit_price AND NEW.accounting_class IS NOT DISTINCT FROM OLD.accounting_class
    AND NEW.income_expense_type_id IS NOT DISTINCT FROM OLD.income_expense_type_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.income_expenses v WHERE v.id IN (v_new,v_old)
      AND v.system_source IN ('exit.support_out','exit.support_in') AND NOT app_private.exit_support_write_allowed_v1(v.id)) THEN
    RAISE EXCEPTION 'Dòng của phiếu chuyển cọc khách cũ hỗ trợ khách nhận không sửa được; đảo số hỗ trợ ở hồ sơ trả phòng' USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END
$fn$;
DROP TRIGGER IF EXISTS a00_exit_support_item_guard ON public.income_expense_items;
CREATE TRIGGER a00_exit_support_item_guard BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_items
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_exit_support_item_v1();

-- Hợp đồng cũ hoặc mới đang có số hỗ trợ: không xoá được tới khi đảo số hỗ trợ.
CREATE OR REPLACE FUNCTION app_private.guard_contract_exit_support_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF (TG_OP='DELETE' OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL))
    AND EXISTS (SELECT 1 FROM public.contract_exit_early_terms t
      WHERE (t.new_contract_id=OLD.id OR t.contract_id=OLD.id) AND t.support_amount<>0) THEN
    RAISE EXCEPTION 'Hợp đồng đang có số tiền khách cũ hỗ trợ khách mới (chuyển cọc giữa hai hợp đồng); đảo số hỗ trợ ở hồ sơ trả phòng trước khi xoá'
      USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END
$fn$;
DROP TRIGGER IF EXISTS a02_contract_exit_support_guard ON public.contracts;
CREATE TRIGGER a02_contract_exit_support_guard BEFORE UPDATE OF deleted_at OR DELETE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_contract_exit_support_v1();

-- Phiếu chuyển cọc không phải tiền khách nộp: không làm nguồn "Thưởng nóng Sale theo phiếu cọc". Thưởng trên phiếu
-- cọc thật lúc giữ chỗ không mang hợp đồng, nên phép kiểm trùng theo hợp đồng của hàm thưởng không bắt được thưởng
-- thứ hai đặt trên phiếu exit.support_in. Sổ claim là nơi mọi thưởng theo phiếu cọc phải ghi, nên chặn ở đây.
CREATE OR REPLACE FUNCTION app_private.guard_exit_support_bonus_claim_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.income_expenses v WHERE v.id=NEW.deposit_voucher_id
      AND v.system_source IN ('exit.support_out','exit.support_in')) THEN
    RAISE EXCEPTION 'Phiếu chuyển cọc từ hợp đồng cũ (khách cũ hỗ trợ khách nhận) không phải tiền cọc khách nộp, không dùng làm nguồn thưởng Sale'
      USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS a00_exit_support_bonus_claim_guard ON app_private.sale_bonus_claims;
CREATE TRIGGER a00_exit_support_bonus_claim_guard BEFORE INSERT OR UPDATE OF deposit_voucher_id ON app_private.sale_bonus_claims
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_exit_support_bonus_claim_v1();

-- Hạng mục của hai phiếu chuyển cọc, tra và tạo đúng trong tổ chức của hồ sơ (không suy tổ chức từ thành viên của chủ
-- toà như _termination_ensure_type: chủ thuộc nhiều tổ chức thì chọn nhầm). Cùng khoá duy nhất (tổ chức, loại, tên chuẩn hoá).
CREATE OR REPLACE FUNCTION app_private.exit_support_type_v1(p_organization_id uuid,p_owner uuid,p_type text,p_name text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_id uuid;
BEGIN
  SELECT t.id INTO v_id FROM public.income_expense_types t
  WHERE t.organization_id=p_organization_id AND lower(btrim(t.type))=p_type
    AND public.normalize_income_expense_type_name(t.name)=public.normalize_income_expense_type_name(p_name)
  ORDER BY t.created_at,t.id LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO public.income_expense_types(user_id,organization_id,type,name,description,is_deposit,force_approval)
    VALUES(p_owner,p_organization_id,p_type,p_name,'Tự tạo khi ghi số khách cũ hỗ trợ khách nhận phòng (chuyển cọc giữa hai hợp đồng)',true,true)
    ON CONFLICT DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT t.id INTO v_id FROM public.income_expense_types t
      WHERE t.organization_id=p_organization_id AND lower(btrim(t.type))=p_type
        AND public.normalize_income_expense_type_name(t.name)=public.normalize_income_expense_type_name(p_name)
      ORDER BY t.created_at,t.id LIMIT 1;
    END IF;
  END IF;
  UPDATE public.income_expense_types SET is_deposit=true WHERE id=v_id AND is_deposit IS DISTINCT FROM true;
  RETURN v_id;
END
$fn$;

-- 4. Ghi số hỗ trợ khi tạo hợp đồng khách nhận. Gọi từ create_contract_v2 ngay trước khi tính lại cọc đã thu:
-- lúc đó trigger tự nối đã nối hợp đồng mới với hồ sơ cũ, phiếu cọc có sẵn đã gắn và phiếu cọc mới đã ghi.
-- Lặp lại cùng khoá tạo hợp đồng thì create_contract_v2 trả kết quả cũ trước khi tới đây.
CREATE OR REPLACE FUNCTION app_private.apply_exit_support_on_contract_create_v1(p_organization_id uuid,p_contract_id uuid,
  p_amount jsonb,p_idempotency_key text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_amount numeric; t public.contract_exit_early_terms%ROWTYPE; e public.contract_exit_cases%ROWTYPE;
  oc public.contracts%ROWTYPE; nc public.contracts%ROWTYPE; v_owner uuid; v_account uuid; v_type_out uuid; v_type_in uuid;
  v_out uuid:=gen_random_uuid(); v_in uuid:=gen_random_uuid(); v_today date; v_old_paid numeric; v_new_paid numeric;
  v_cap_old numeric; v_cap_new numeric; v_old_label text; v_new_label text; v_note text;
BEGIN
  IF p_amount IS NULL OR jsonb_typeof(p_amount)='null' THEN RETURN; END IF;
  IF jsonb_typeof(p_amount) NOT IN ('number','string') THEN
    RAISE EXCEPTION 'Số tiền khách cũ hỗ trợ khách mới không hợp lệ' USING ERRCODE='22023';
  END IF;
  BEGIN
    v_amount:=(p_amount#>>'{}')::numeric;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Số tiền khách cũ hỗ trợ khách mới không hợp lệ' USING ERRCODE='22023';
  END;
  IF v_amount IS NULL OR v_amount::text IN ('NaN','Infinity','-Infinity') OR v_amount<0 OR round(v_amount,2)<>v_amount THEN
    RAISE EXCEPTION 'Số tiền khách cũ hỗ trợ khách mới không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF v_amount=0 THEN RETURN; END IF;

  SELECT * INTO nc FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id AND deleted_at IS NULL;
  SELECT * INTO t FROM public.contract_exit_early_terms
    WHERE new_contract_id=p_contract_id AND organization_id=p_organization_id FOR UPDATE;
  IF nc.id IS NULL OR t.exit_case_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng này không nối với hồ sơ khách cũ đang chờ sang nhượng phòng; bỏ số tiền khách cũ hỗ trợ khách mới'
      USING ERRCODE='55000';
  END IF;
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=t.exit_case_id AND organization_id=t.organization_id FOR UPDATE;
  IF t.early_reason NOT IN ('SALE_ASSISTED','SELF_FOUND') OR e.state IS DISTINCT FROM 'PENDING' OR t.support_amount<>0 THEN
    RAISE EXCEPTION 'Hồ sơ khách cũ không còn nhận số tiền hỗ trợ (đã quyết toán, đổi trường hợp hoặc đã ghi số hỗ trợ)'
      USING ERRCODE='55000';
  END IF;
  -- Số hỗ trợ trừ vào phần trả khách cũ: người ghi phải có quyền thanh lý ở toà của hồ sơ cũ.
  PERFORM app_private.assert_contract_exit_writer_v1(t.organization_id,t.building_id);
  PERFORM app_private.require_building_perm_v1(t.building_id,'ghi số tiền khách cũ hỗ trợ khách mới','contracts.terminate');

  SELECT * INTO oc FROM public.contracts WHERE id=t.contract_id AND organization_id=t.organization_id FOR UPDATE;
  v_old_paid:=public.contract_deposit_paid_derived(t.contract_id);
  v_new_paid:=public.contract_deposit_paid_derived(p_contract_id);
  v_cap_old:=GREATEST(v_old_paid-t.broker_fee,0);
  v_cap_new:=GREATEST(COALESCE(nc.total_deposit,0)-v_new_paid,0);
  IF v_amount>v_cap_old THEN
    RAISE EXCEPTION 'Số tiền khách cũ hỗ trợ vượt cọc cũ đã thu sau khi trừ phí môi giới (tối đa %đ)',
      to_char(v_cap_old,'FM999G999G999G990') USING ERRCODE='22023';
  END IF;
  IF v_amount>v_cap_new THEN
    RAISE EXCEPTION 'Số tiền khách cũ hỗ trợ vượt phần cọc còn thiếu của hợp đồng mới (tối đa %đ)',
      to_char(v_cap_new,'FM999G999G999G990') USING ERRCODE='22023';
  END IF;

  SELECT b.user_id INTO v_owner FROM public.buildings b WHERE b.id=t.building_id AND b.organization_id=t.organization_id;
  v_owner:=COALESCE(v_owner,oc.user_id);
  v_account:=public._internal_settlement_account(v_owner);
  IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id=v_account AND a.is_virtual AND a.deleted_at IS NULL
      AND a.organization_id=t.organization_id) THEN
    RAISE EXCEPTION 'Không xác định được sổ nội bộ cấn trừ thanh lý của toà' USING ERRCODE='55000';
  END IF;
  v_type_out:=app_private.exit_support_type_v1(t.organization_id,v_owner,'expense','Chuyển cọc sang hợp đồng khách nhận');
  v_type_in:=app_private.exit_support_type_v1(t.organization_id,v_owner,'income','Nhận cọc chuyển từ hợp đồng cũ');
  IF (SELECT count(*) FROM public.income_expense_types x WHERE x.id IN (v_type_out,v_type_in)
      AND x.organization_id=t.organization_id AND x.is_deposit AND NOT COALESCE(x.internal_transfer,false))<>2 THEN
    RAISE EXCEPTION 'Hạng mục chuyển cọc không thuộc tổ chức' USING ERRCODE='55000';
  END IF;

  v_today:=public.org_today_v1(t.organization_id);
  v_old_label:=COALESCE(NULLIF(btrim(oc.contract_number),''),'hợp đồng cũ');
  v_new_label:=COALESCE(NULLIF(btrim(nc.contract_number),''),'hợp đồng mới');
  v_note:='[CHUYỂN KHOẢN] Bút toán nội bộ: khách cũ hỗ trợ khách nhận phòng, chuyển cọc từ '||v_old_label||' sang '||v_new_label
    ||' (không phải tiền thật, không vào kết quả kinh doanh). Đảo ở hồ sơ trả phòng nếu ghi nhầm.';
  INSERT INTO app_private.contract_exit_support_writes(income_expense_id,xid,backend_pid)
    VALUES(v_out,pg_current_xact_id(),pg_backend_pid()),(v_in,pg_current_xact_id(),pg_backend_pid());
  INSERT INTO public.income_expenses(id,user_id,organization_id,type,name,building_id,room_id,contract_id,account_id,voucher_date,
    total_amount,approval_status,approved_by,approved_at,notes,system_source,idempotency_key)
  VALUES(v_out,v_owner,t.organization_id,'EXPENSE','Khách cũ hỗ trợ khách nhận — chuyển cọc '||v_old_label||' sang '||v_new_label,
    t.building_id,t.room_id,t.contract_id,v_account,v_today,v_amount,'APPROVED',auth.uid(),clock_timestamp(),v_note,
    'exit.support_out',p_idempotency_key||':exit-support:out');
  INSERT INTO public.income_expense_items(income_expense_id,organization_id,income_expense_type_id,description,quantity,unit_price,amount,
    start_date,end_date,accounting_class)
  VALUES(v_out,t.organization_id,v_type_out,'Chuyển cọc sang hợp đồng khách nhận '||v_new_label,1,v_amount,v_amount,v_today,v_today,'DEPOSIT');
  INSERT INTO public.income_expenses(id,user_id,organization_id,type,name,building_id,room_id,contract_id,account_id,voucher_date,
    total_amount,approval_status,approved_by,approved_at,notes,system_source,idempotency_key)
  VALUES(v_in,v_owner,t.organization_id,'INCOME','Cọc chuyển từ '||v_old_label||' (khách cũ hỗ trợ khách nhận)',
    t.building_id,nc.room_id,p_contract_id,v_account,v_today,v_amount,'APPROVED',auth.uid(),clock_timestamp(),v_note,
    'exit.support_in',p_idempotency_key||':exit-support:in');
  INSERT INTO public.income_expense_items(income_expense_id,organization_id,income_expense_type_id,description,quantity,unit_price,amount,
    start_date,end_date,accounting_class)
  VALUES(v_in,t.organization_id,v_type_in,'Cọc chuyển từ hợp đồng cũ '||v_old_label,1,v_amount,v_amount,v_today,v_today,'DEPOSIT');
  DELETE FROM app_private.contract_exit_support_writes WHERE income_expense_id IN (v_out,v_in)
    AND xid=pg_current_xact_id() AND backend_pid=pg_backend_pid();

  PERFORM public.recompute_contract_deposit_paid(t.contract_id);
  PERFORM public.recompute_contract_deposit_paid(p_contract_id);
  IF public.contract_deposit_paid_derived(t.contract_id)<>v_old_paid-v_amount
    OR public.contract_deposit_paid_derived(p_contract_id)<>v_new_paid+v_amount
    OR (SELECT count(*) FROM public.income_expense_items i WHERE i.income_expense_id IN (v_out,v_in) AND i.accounting_class='DEPOSIT')<>2 THEN
    RAISE EXCEPTION 'Cặp phiếu chuyển cọc không khớp cọc đã thu của hai hợp đồng' USING ERRCODE='55000';
  END IF;

  UPDATE public.contract_exit_early_terms SET support_amount=v_amount,support_out_voucher_id=v_out,support_in_voucher_id=v_in,
    version=version+1,updated_at=clock_timestamp()
  WHERE exit_case_id=t.exit_case_id RETURNING * INTO t;
  PERFORM app_private.contract_exit_early_term_event_v1(t.exit_case_id,'SUPPORT_APPLIED',
    'Khách cũ hỗ trợ khách nhận phòng: chuyển cọc sang hợp đồng mới',
    md5('exit-support-applied:'||p_contract_id::text)::uuid,md5(jsonb_build_object('contract',p_contract_id,'amount',v_amount)::text),
    jsonb_build_object('amount',v_amount,'new_contract_id',p_contract_id,'support_out_voucher_id',v_out,'support_in_voucher_id',v_in,
      'old_deposit_paid_before',v_old_paid,'new_deposit_paid_before',v_new_paid,'broker_fee',t.broker_fee));
END
$fn$;

-- 5. Đảo số hỗ trợ (vd khách nhận huỷ, ghi nhầm số): huỷ đúng cặp phiếu, cọc hai bên về như trước, có lý do và nhật ký.
-- Chỉ khi hồ sơ cũ còn chờ quyết toán. Sau khi đảo mới đổi trường hợp hoặc xoá hợp đồng khách nhận được.
CREATE OR REPLACE FUNCTION public.reverse_contract_exit_support_v1(p_organization_id uuid,p_exit_case_id uuid,p_expected_version bigint,
  p_request_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE; t public.contract_exit_early_terms%ROWTYPE; h app_private.contract_exit_early_term_events%ROWTYPE;
  v_reason text:=NULLIF(btrim(p_reason),''); v_hash text; v_amount numeric; v_out uuid; v_in uuid; v_old_paid numeric; v_new_paid numeric;
BEGIN
  IF p_request_id IS NULL OR p_expected_version IS NULL OR p_expected_version<1 OR v_reason IS NULL OR char_length(v_reason)>2000 THEN
    RAISE EXCEPTION 'Đảo số tiền khách cũ hỗ trợ cần lý do' USING ERRCODE='22023';
  END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_exit_case_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hồ sơ trả phòng' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  PERFORM app_private.require_building_perm_v1(e.building_id,'đảo số tiền khách cũ hỗ trợ khách mới','contracts.terminate');
  v_hash:=md5(jsonb_build_object('case',e.id,'version',p_expected_version,'reason',v_reason)::text);
  SELECT * INTO h FROM app_private.contract_exit_early_term_events WHERE request_id=p_request_id;
  IF FOUND THEN
    IF h.exit_case_id<>e.id OR h.actor_id IS DISTINCT FROM auth.uid() OR h.event<>'SUPPORT_REVERSED' OR h.intent_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng cho thao tác khác' USING ERRCODE='23505';
    END IF;
    RETURN app_private.contract_exit_early_terms_response_v1(e.id);
  END IF;
  SELECT * INTO t FROM public.contract_exit_early_terms WHERE exit_case_id=e.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hồ sơ chưa chọn trường hợp trả phòng trước hạn' USING ERRCODE='55000'; END IF;
  IF t.version<>p_expected_version THEN RAISE EXCEPTION 'Hồ sơ trường hợp trả phòng đã thay đổi; tải lại' USING ERRCODE='PT409'; END IF;
  IF t.support_amount=0 THEN RAISE EXCEPTION 'Hồ sơ không có số tiền khách cũ hỗ trợ để đảo' USING ERRCODE='55000'; END IF;
  IF e.state<>'PENDING' THEN
    RAISE EXCEPTION 'Hồ sơ khách cũ đã quyết toán; không đảo được số tiền hỗ trợ' USING ERRCODE='55000';
  END IF;
  v_amount:=t.support_amount; v_out:=t.support_out_voucher_id; v_in:=t.support_in_voucher_id;
  PERFORM 1 FROM public.contracts c WHERE c.id IN (t.contract_id,t.new_contract_id) ORDER BY c.id FOR UPDATE;
  v_old_paid:=public.contract_deposit_paid_derived(t.contract_id);
  v_new_paid:=public.contract_deposit_paid_derived(t.new_contract_id);
  IF NOT EXISTS (SELECT 1 FROM public.contracts c WHERE c.id=t.new_contract_id AND c.deleted_at IS NULL AND c.status::text IN ('ACTIVE','EXTENDED')) THEN
    RAISE EXCEPTION 'Hợp đồng khách nhận không còn hiệu lực; không đảo được số hỗ trợ' USING ERRCODE='55000';
  END IF;
  IF v_new_paid<v_amount OR (SELECT count(*) FROM public.income_expenses v WHERE v.id IN (v_out,v_in)
      AND v.approval_status='APPROVED' AND v.deleted_at IS NULL)<>2 THEN
    RAISE EXCEPTION 'Cặp phiếu chuyển cọc hoặc cọc của hợp đồng mới đã thay đổi; không đảo được' USING ERRCODE='55000';
  END IF;
  INSERT INTO app_private.contract_exit_support_writes(income_expense_id,xid,backend_pid)
    VALUES(v_out,pg_current_xact_id(),pg_backend_pid()),(v_in,pg_current_xact_id(),pg_backend_pid());
  PERFORM app_private.finance_v2_transition_owned_approval(v_out,'CANCELLED','NOT_APPLICABLE');
  PERFORM app_private.finance_v2_transition_owned_approval(v_in,'CANCELLED','NOT_APPLICABLE');
  DELETE FROM app_private.contract_exit_support_writes WHERE income_expense_id IN (v_out,v_in)
    AND xid=pg_current_xact_id() AND backend_pid=pg_backend_pid();
  PERFORM public.recompute_contract_deposit_paid(t.contract_id);
  PERFORM public.recompute_contract_deposit_paid(t.new_contract_id);
  IF public.contract_deposit_paid_derived(t.contract_id)<>v_old_paid+v_amount
    OR public.contract_deposit_paid_derived(t.new_contract_id)<>v_new_paid-v_amount THEN
    RAISE EXCEPTION 'Đảo cặp phiếu chuyển cọc không khớp cọc đã thu của hai hợp đồng' USING ERRCODE='55000';
  END IF;
  UPDATE public.contract_exit_early_terms SET support_amount=0,support_out_voucher_id=NULL,support_in_voucher_id=NULL,
    version=version+1,updated_at=clock_timestamp()
  WHERE exit_case_id=t.exit_case_id RETURNING * INTO t;
  PERFORM app_private.contract_exit_early_term_event_v1(t.exit_case_id,'SUPPORT_REVERSED',v_reason,p_request_id,v_hash,
    jsonb_build_object('amount',v_amount,'support_out_voucher_id',v_out,'support_in_voucher_id',v_in,'new_contract_id',t.new_contract_id));
  RETURN app_private.contract_exit_early_terms_response_v1(e.id);
END
$fn$;

-- 6. Nối vào hàm hiện hành bằng neo. Neo phải xuất hiện đúng một lần; đã nối thì bỏ qua.
DO $patch$
DECLARE r record; v_body text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    (1,'public.create_contract_v2(jsonb,text)',
      '  PERFORM public.recompute_contract_deposit_paid(v_contract_id);',
      '  PERFORM app_private.apply_exit_support_on_contract_create_v1(v_org,v_contract_id,p_payload->''transfer_support_amount'',v_key);'||chr(10)
        ||'  PERFORM public.recompute_contract_deposit_paid(v_contract_id);',
      'apply_exit_support_on_contract_create_v1('),
    (2,'public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])',
      '''existing_deposit_voucher_ids'',''invoice_template_id'')) THEN',
      '''existing_deposit_voucher_ids'',''invoice_template_id'',''transfer_support_amount'')) THEN',
      '''invoice_template_id'',''transfer_support_amount''))'),
    (3,'public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])',
      '||(p_creation_options-''first_invoice''-''deposit_receipts''-''existing_deposit_voucher_ids''),',
      '||(p_creation_options-''first_invoice''-''deposit_receipts''-''existing_deposit_voucher_ids''-''transfer_support_amount''),',
      '-''transfer_support_amount''),'),
    (4,'public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])',
      '  IF p_creation_options ? ''first_invoice'' THEN v_payload:=v_payload||jsonb_build_object(''first_invoice'',p_creation_options->''first_invoice''); END IF;',
      '  IF p_creation_options ? ''first_invoice'' THEN v_payload:=v_payload||jsonb_build_object(''first_invoice'',p_creation_options->''first_invoice''); END IF;'||chr(10)
        ||'  IF p_creation_options ? ''transfer_support_amount'' THEN v_payload:=v_payload||jsonb_build_object(''transfer_support_amount'',p_creation_options->''transfer_support_amount''); END IF;',
      'jsonb_build_object(''transfer_support_amount'','),
    -- Đường ảnh đồng hồ: nhận writer v2 (trả phòng trước hạn có trường hợp). v2 chỉ cho quyết toán ngay ở trường hợp
    -- chủ nhà hỗ trợ; hai trường hợp sang nhượng vẫn chỉ ghi trả phòng, quyết toán sau.
    (5,'public.meter_capture_exit_v1(uuid,text,jsonb,jsonb)',
      ' IF p_rpc_name NOT IN (''confirm_contract_return_v1'',''finalize_contract_exit_case_v1'',''finalize_contract_transfer_exit_v1'')',
      ' IF p_rpc_name NOT IN (''confirm_contract_return_v1'',''confirm_contract_return_v2'',''finalize_contract_exit_case_v1'',''finalize_contract_transfer_exit_v1'')',
      '''confirm_contract_return_v1'',''confirm_contract_return_v2'',''finalize_contract_exit_case_v1'''),
    (6,'public.meter_capture_exit_v1(uuid,text,jsonb,jsonb)',
      ' IF p_rpc_name=''confirm_contract_return_v1'' THEN',
      ' IF p_rpc_name IN (''confirm_contract_return_v1'',''confirm_contract_return_v2'') THEN',
      'IF p_rpc_name IN (''confirm_contract_return_v1'',''confirm_contract_return_v2'') THEN'),
    (7,'app_private.meter_capture_invoke_writer_v1(text,jsonb)',
      '''confirm_contract_return_v1'',''finalize_contract_exit_case_v1'',''finalize_contract_transfer_exit_v1'') OR jsonb_typeof',
      '''confirm_contract_return_v1'',''confirm_contract_return_v2'',''finalize_contract_exit_case_v1'',''finalize_contract_transfer_exit_v1'') OR jsonb_typeof',
      '''confirm_contract_return_v2'',''finalize_contract_exit_case_v1'''),
    (8,'app_private.contract_exit_early_terms_response_v1(uuid)',
      '''support_in_voucher_id'',t.support_in_voucher_id,''commission_voucher_id'',t.commission_voucher_id,',
      '''support_in_voucher_id'',t.support_in_voucher_id,'
        ||'''support_out_code'',(SELECT so.code FROM public.income_expenses so WHERE so.id=t.support_out_voucher_id),'
        ||'''support_in_code'',(SELECT si.code FROM public.income_expenses si WHERE si.id=t.support_in_voucher_id),'
        ||'''commission_voucher_id'',t.commission_voucher_id,',
      '''support_out_code'',')
  ) AS edits(ord,signature,anchor,replacement,marker) ORDER BY ord LOOP
    v_body:=pg_get_functiondef(r.signature::regprocedure);
    IF strpos(v_body,r.marker)=0 THEN
      IF (length(v_body)-length(replace(v_body,r.anchor,'')))<>length(r.anchor) THEN
        RAISE EXCEPTION 'so_ho_tro_sang_nhuong_neo_lech %',r.ord USING ERRCODE='55000';
      END IF;
      EXECUTE replace(v_body,r.anchor,r.replacement);
    ELSIF (length(v_body)-length(replace(v_body,r.marker,'')))<>length(r.marker)
      OR (length(v_body)-length(replace(v_body,r.replacement,'')))<>length(r.replacement) THEN
      RAISE EXCEPTION 'so_ho_tro_sang_nhuong_noi_sai_cho %',r.ord USING ERRCODE='55000';
    END IF;
  END LOOP;
END
$patch$;

-- 7. Quyền gọi.
DO $acl$
DECLARE v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'app_private.exit_support_write_allowed_v1(uuid)','app_private.exit_support_type_v1(uuid,uuid,text,text)',
    'app_private.guard_exit_support_voucher_v1()','app_private.guard_exit_support_item_v1()',
    'app_private.guard_contract_exit_support_v1()','app_private.guard_exit_support_bonus_claim_v1()',
    'app_private.apply_exit_support_on_contract_create_v1(uuid,uuid,jsonb,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_signature);
  END LOOP;
  EXECUTE 'ALTER FUNCTION public.reverse_contract_exit_support_v1(uuid,uuid,bigint,uuid,text) OWNER TO postgres';
  EXECUTE 'REVOKE ALL ON FUNCTION public.reverse_contract_exit_support_v1(uuid,uuid,bigint,uuid,text) FROM PUBLIC,anon,authenticated,service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.reverse_contract_exit_support_v1(uuid,uuid,bigint,uuid,text) TO authenticated';
END
$acl$;

-- 8. Nghiệm thu: mỗi điểm nối đúng một lần, độ biến động giữ nguyên, bốn trigger có mặt, helper đóng, RPC mở.
DO $check$
DECLARE r record; v_def text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.create_contract_v2(jsonb,text)','apply_exit_support_on_contract_create_v1(','v'),
    ('public.create_contract_v2(jsonb,text)','PERFORM public.recompute_contract_deposit_paid(v_contract_id);','v'),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])','''invoice_template_id'',''transfer_support_amount''))','v'),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])','-''transfer_support_amount''),','v'),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])','jsonb_build_object(''transfer_support_amount'',','v'),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])','public.create_contract_v2(','v'),
    ('public.meter_capture_exit_v1(uuid,text,jsonb,jsonb)','''confirm_contract_return_v1'',''confirm_contract_return_v2'',''finalize_contract_exit_case_v1''','v'),
    ('public.meter_capture_exit_v1(uuid,text,jsonb,jsonb)','IF p_rpc_name IN (''confirm_contract_return_v1'',''confirm_contract_return_v2'') THEN','v'),
    ('app_private.meter_capture_invoke_writer_v1(text,jsonb)','''confirm_contract_return_v2'',''finalize_contract_exit_case_v1''','v'),
    ('app_private.contract_exit_early_terms_response_v1(uuid)','''support_out_code'',','s'),
    ('app_private.contract_exit_early_terms_response_v1(uuid)','''support_in_code'',','s')
  ) AS t(sig,marker,vol) LOOP
    v_def:=pg_get_functiondef(r.sig::regprocedure);
    IF (length(v_def)-length(replace(v_def,r.marker,'')))<>length(r.marker)
      OR (SELECT p.provolatile::text FROM pg_proc p WHERE p.oid=r.sig::regprocedure)<>r.vol THEN
      RAISE EXCEPTION 'so_ho_tro_sang_nhuong_nghiem_thu_lech %',r.marker USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (
        (tgrelid='public.income_expenses'::regclass AND tgname='a00_exit_support_voucher_guard')
        OR (tgrelid='public.income_expense_items'::regclass AND tgname='a00_exit_support_item_guard')
        OR (tgrelid='public.contracts'::regclass AND tgname='a02_contract_exit_support_guard')
        OR (tgrelid='app_private.sale_bonus_claims'::regclass AND tgname='a00_exit_support_bonus_claim_guard')))<>4
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.contract_exit_early_terms'::regclass AND conname='contract_exit_early_terms_support')
    OR has_function_privilege('authenticated','app_private.apply_exit_support_on_contract_create_v1(uuid,uuid,jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','public.reverse_contract_exit_support_v1(uuid,uuid,bigint,uuid,text)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.reverse_contract_exit_support_v1(uuid,uuid,bigint,uuid,text)','EXECUTE')
    OR has_table_privilege('authenticated','app_private.contract_exit_support_writes','INSERT') THEN
    RAISE EXCEPTION 'so_ho_tro_sang_nhuong_nghiem_thu_lech' USING ERRCODE='55000';
  END IF;
END
$check$;
