-- Kiểm quyền TRƯỚC khi khoá tổ chức, cho hai hàm SECURITY DEFINER mở cho authenticated.
--
-- Cả hai lấy khoá tổ chức (lock_org_for_decision_v1 = FOR NO KEY UPDATE trên
-- organizations) và khoá dòng theo UUID do người gọi đưa vào, RỒI mới kiểm quyền.
-- Người đăng nhập của công ty khác cầm một UUID là giữ được khoá của công ty đó
-- suốt lời gọi. Không lộ hay ghi dữ liệu (cả hai vẫn RAISE 42501), nhưng đó là
-- khoá trước khi kiểm quyền. Gate check-definer-body-authz bắt hàm [1] ngày
-- 07/10/2026; review độc lập cùng ngày chỉ ra hàm [2] cùng kiểu.
--
-- Cách vá chung: chạy NGUYÊN VĂN điều kiện quyền sẵn có trên một lần đọc KHÔNG
-- khoá, trước mọi khoá; phần sau giữ y bản cũ, kể cả lần kiểm lại dưới khoá.
-- Người có quyền không đổi hành vi; người không có quyền nhận đúng lỗi 42501 như
-- cũ, chỉ sớm hơn. Không đổi chữ ký, owner hay ACL (CREATE OR REPLACE giữ nguyên).

-- [1] create_sale_bonus_from_deposit_v1 — bản bọc của 20260930101338.
-- Điều kiện quyền chép từ bản canonical 20260921085952: can_access_building OR
-- ie_all_buildings_scope OR is_admin OR is_super_admin trên toà của phiếu cọc,
-- giữ cả cách NULL lan để không từ chối ai mà bản canonical nhận. Đi kèm: bản
-- canonical từng trả "Phiếu cọc đã huỷ" (55000) cho công ty khác trước 42501.
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

-- [2] register_contract_signed_document_v1 — 20260928024559.
-- Bản cũ khoá tổ chức theo p_organization_id của người gọi và FOR UPDATE dòng ký
-- trước contract_draft_scope_allowed. Nay đọc toà của dòng ký không khoá, kiểm
-- đúng hai quyền view + print như cũ, rồi mới khoá và kiểm lại dưới khoá.
CREATE OR REPLACE FUNCTION public.register_contract_signed_document_v1(p_organization_id uuid,p_signing_id uuid,p_document_sha256 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.contract_draft_signings%ROWTYPE; v_building uuid;
BEGIN
  SELECT x.building_id INTO v_building FROM public.contract_draft_signings x WHERE x.id=p_signing_id AND x.organization_id=p_organization_id;
  IF NOT FOUND OR NOT app_private.contract_draft_scope_allowed(p_organization_id,v_building,'contracts.view')
    OR NOT app_private.contract_draft_scope_allowed(p_organization_id,v_building,'contracts.print') THEN
    RAISE EXCEPTION 'Không có quyền tạo bản tải hợp đồng' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO s FROM public.contract_draft_signings WHERE id=p_signing_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND OR NOT app_private.contract_draft_scope_allowed(p_organization_id,s.building_id,'contracts.view')
    OR NOT app_private.contract_draft_scope_allowed(p_organization_id,s.building_id,'contracts.print') THEN
    RAISE EXCEPTION 'Không có quyền tạo bản tải hợp đồng' USING ERRCODE='42501';
  END IF;
  IF p_document_sha256 IS NULL OR p_document_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Hash tài liệu không hợp lệ' USING ERRCODE='22023'; END IF;
  IF s.official_document_sha256 IS NOT NULL THEN
    IF s.official_document_sha256<>p_document_sha256 THEN RAISE EXCEPTION 'Bản tải đã đăng ký với nội dung khác' USING ERRCODE='23505'; END IF;
    RETURN to_jsonb(s)-'intent_hash';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='contract-signed-documents' AND name=s.official_document_path) THEN
    RAISE EXCEPTION 'Chưa tải lên bản hợp đồng' USING ERRCODE='22023';
  END IF;
  UPDATE public.contract_draft_signings SET official_document_sha256=p_document_sha256 WHERE id=s.id RETURNING * INTO s;
  RETURN to_jsonb(s)-'intent_hash';
END $$;
