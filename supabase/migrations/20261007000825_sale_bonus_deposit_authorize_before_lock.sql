-- create_sale_bonus_from_deposit_v1: kiểm quyền TRƯỚC mọi khoá.
--
-- Bản bọc hỗ trợ tiền thuê (20260930101338) lấy khoá tổ chức
-- (lock_org_for_decision_v1 = FOR NO KEY UPDATE trên organizations) và khoá
-- dòng hợp đồng của phiếu cọc do người gọi đưa vào, RỒI mới chuyển sang bản
-- canonical để kiểm quyền. Người đăng nhập của công ty khác cầm một UUID phiếu
-- cọc là giữ được khoá của công ty đó suốt lời gọi. Không lộ hay ghi dữ liệu
-- (bản canonical vẫn RAISE 42501), nhưng đó là khoá trước khi kiểm quyền;
-- gate check-definer-body-authz bắt đúng chỗ này ngày 07/10/2026.
--
-- Bản vá chạy NGUYÊN VĂN điều kiện quyền của bản canonical (20260921085952):
-- can_access_building OR ie_all_buildings_scope OR is_admin OR is_super_admin
-- trên toà của phiếu cọc, bằng một lần đọc không khoá, trước mọi khoá. Giữ đúng
-- biểu thức (kể cả cách NULL lan) để không từ chối ai mà bản canonical nhận.
-- Người có quyền không đổi hành vi; người không có quyền nhận đúng lỗi 42501
-- như cũ, chỉ sớm hơn. Bản canonical vẫn kiểm lại dưới khoá.
-- Không đổi chữ ký, owner hay ACL (CREATE OR REPLACE giữ nguyên cả hai).
CREATE OR REPLACE FUNCTION public.create_sale_bonus_from_deposit_v1(p_deposit_voucher_id uuid,p_amount numeric,p_recipient text DEFAULT NULL,p_account_number text DEFAULT NULL,p_bank text DEFAULT NULL,p_voucher_date date DEFAULT NULL,p_account_id uuid DEFAULT NULL,p_attachments jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d public.income_expenses;org uuid;contract uuid;BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501';END IF;
 SELECT * INTO d FROM public.income_expenses WHERE id=p_deposit_voucher_id;
 IF d.id IS NULL THEN RAISE EXCEPTION 'Deposit not found' USING ERRCODE='P0002';END IF;
 IF NOT (public.can_access_building(d.building_id) OR public.ie_all_buildings_scope(d.building_id)
      OR public.is_admin() OR public.is_super_admin()) THEN
  RAISE EXCEPTION 'Bạn không có quyền tạo phiếu trên toà này' USING ERRCODE='42501';
 END IF;
 org:=d.organization_id;contract:=d.contract_id;
 PERFORM app_private.lock_org_for_decision_v1(org);
 IF contract IS NOT NULL THEN
  PERFORM 1 FROM public.contracts WHERE organization_id=org AND id=contract FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=org AND contract_id=contract) THEN
   PERFORM app_private.authorize_commission_request_v1(org,contract);
   RAISE EXCEPTION 'Use the saved rent support payout operation' USING ERRCODE='PT409';
  END IF;
 END IF;
 SELECT * INTO d FROM public.income_expenses WHERE id=p_deposit_voucher_id AND organization_id=org FOR UPDATE;
 IF d.contract_id IS DISTINCT FROM contract THEN RAISE EXCEPTION 'Deposit contract changed; retry after readback' USING ERRCODE='PT409';END IF;
 RETURN app_private.rent_support_legacy_deposit_bonus_v1(p_deposit_voucher_id,p_amount,p_recipient,p_account_number,p_bank,p_voucher_date,p_account_id,p_attachments);
END $$;
