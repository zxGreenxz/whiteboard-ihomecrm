-- =====================================================================
-- Sửa: preview_termination_refund_v1 nhận CẢ id hồ sơ thanh lý LẪN id hợp đồng.
--
-- Bắt được khi tự bấm thử trên giao diện: báo cáo "Thanh lý hợp đồng"
-- (/reports/real-estate/terminations) liệt kê HỢP ĐỒNG đã thanh lý, nên `term.id`
-- ở đó là `contracts.id`, KHÔNG phải `contract_terminations.id`. Hàm cũ chỉ nhận
-- id hồ sơ nên dialog báo "Không tìm thấy hồ sơ thanh lý" cho mọi dòng.
--
-- Nhận cả hai thay vì bắt giao diện tự tra: chỗ gọi có nhiều (báo cáo, danh sách
-- hợp đồng, trang cọc) và mỗi chỗ cầm một loại id khác nhau. Để hàm tự phân giải
-- thì không chỗ nào phải nhớ luật.
-- =====================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.preview_termination_refund_v1(p_termination_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_t   public.contract_terminations;
  v_org uuid;
  v_b   jsonb;
  v_real numeric; v_hist numeric; v_req numeric;
  v_status text; v_warn text;
BEGIN
  -- Thử theo id hồ sơ trước; không có thì hiểu là id HỢP ĐỒNG và lấy hồ sơ mới nhất.
  SELECT * INTO v_t FROM contract_terminations WHERE id = p_termination_id;
  IF NOT FOUND THEN
    SELECT * INTO v_t FROM contract_terminations
     WHERE contract_id = p_termination_id
     ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF v_t.id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng này chưa có hồ sơ thanh lý — chưa tính được tiền hoàn.'
      USING ERRCODE='P0002';
  END IF;
  v_org := v_t.organization_id;

  IF NOT (EXISTS (SELECT 1 FROM organization_memberships m
                   WHERE m.organization_id=v_org AND m.user_id=auth.uid() AND m.status='ACTIVE')
          OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không thuộc tổ chức này' USING ERRCODE='42501';
  END IF;

  v_b := app_private.resolve_signed_contract_deposit_basis_v1(v_org, v_t.contract_id);
  v_real := (v_b->>'netHeld')::numeric;
  v_hist := (v_b->>'recognizedHistoricalIn')::numeric;
  v_req  := COALESCE(v_t.refund_amount, 0);

  -- "chưa từng vào két" nặng hơn "vượt cọc" — xét trước.
  IF v_req > 0 AND v_real <= 0 AND v_hist > 0 THEN
    v_status := 'CHUA_TUNG_VAO_KET';
    v_warn := format('Cọc %sđ của hợp đồng này chỉ được GHI NHẬN trên sổ ảo, chưa từng vào két thật. Hoàn %sđ tiền mặt là chi một khoản chưa hề thu.',
                     round(v_hist)::bigint, round(v_req)::bigint);
  ELSIF v_req > v_real THEN
    v_status := 'VUOT_COC_THAT';
    v_warn := format('Số hoàn %sđ LỚN HƠN cọc thật đang giữ %sđ (chênh %sđ).',
                     round(v_req)::bigint, round(v_real)::bigint, round(v_req - v_real)::bigint);
  ELSE
    v_status := 'OK';
  END IF;

  RETURN jsonb_build_object(
    'terminationId', v_t.id,
    'contractId', v_t.contract_id,
    'organizationId', v_org,
    'requestedAmount', v_req,
    'realHeld', v_real,
    'recognizedOnly', v_hist,
    'basisStatus', v_b->>'basisStatus',
    'basisFingerprint', v_b->>'fingerprint',
    'obligationStatus', v_status,
    'warning', v_warn,
    'basis', v_b);
END;
$function$;

-- record_... cũng phải phân giải giống hệt, kẻo giao diện xem trước được mà chốt không được.
CREATE OR REPLACE FUNCTION public.record_termination_refund_obligation_v1(
  p_termination_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_p jsonb; v_org uuid; v_ct uuid; v_tm uuid; v_ver int; v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  v_p   := public.preview_termination_refund_v1(p_termination_id);
  v_tm  := (v_p->>'terminationId')::uuid;   -- id ĐÃ phân giải
  v_org := (v_p->>'organizationId')::uuid;
  v_ct  := (v_p->>'contractId')::uuid;

  PERFORM 1 FROM contract_terminations WHERE id = v_tm FOR UPDATE;

  SELECT COALESCE(max(version),0) + 1 INTO v_ver
    FROM termination_refund_obligations
   WHERE organization_id=v_org AND termination_id=v_tm;

  INSERT INTO termination_refund_obligations
    (organization_id, termination_id, contract_id, version,
     requested_amount, real_held, recognized_only, basis_status, basis_fingerprint,
     obligation_status, warning, snapshot, created_by)
  VALUES
    (v_org, v_tm, v_ct, v_ver,
     (v_p->>'requestedAmount')::numeric, (v_p->>'realHeld')::numeric,
     (v_p->>'recognizedOnly')::numeric, v_p->>'basisStatus', v_p->>'basisFingerprint',
     v_p->>'obligationStatus', v_p->>'warning', v_p, auth.uid())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('obligationId', v_id, 'version', v_ver,
                            'terminationId', v_tm,
                            'obligationStatus', v_p->>'obligationStatus',
                            'warning', v_p->>'warning');
END;
$function$;

DO $selfcheck$
DECLARE v_code text;
BEGIN
  SELECT lower(regexp_replace(p.prosrc,'--[^\n]*','','g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='preview_termination_refund_v1';
  IF position('contract_id = p_termination_id' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Không phân giải được id hợp đồng. DỪNG.';
  END IF;
  IF position('resolve_signed_contract_deposit_basis_v1' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Mất lời gọi cơ sở cọc dùng chung. DỪNG.';
  END IF;
  IF position('chua_tung_vao_ket' IN v_code) > position('vuot_coc_that' IN v_code) THEN
    RAISE EXCEPTION 'Thứ tự cảnh báo sai. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
