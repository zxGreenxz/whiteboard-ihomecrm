-- =====================================================================
-- Đợt 7 — NGHĨA VỤ HOÀN CỌC khi thanh lý hợp đồng
--
-- Hôm nay: thanh lý xong, số tiền phải hoàn nằm ở `contract_terminations.refund_amount`
-- — MỘT CON SỐ do người nhập, không ai kiểm lại, và không có gì nối nó với tiền
-- cọc THẬT ĐÃ THU. Hệ quả đo được trên prod 30/07:
--   • **8 hợp đồng đã chi ra thật 20.104.100đ trong khi thu thật = 0đ**
--   • 245 hợp đồng có 1,04 tỉ cọc chỉ GHI NHẬN trên sổ ảo, chưa từng vào két —
--     hoàn tiền mặt cho nhóm này là chi khoản chưa hề thu
--
-- File này dựng **NGHĨA VỤ HOÀN**: một dòng bất biến nói rõ "hợp đồng X phải hoàn
-- Y đồng, tính từ những nguồn nào, tại thời điểm nào" — và nó ĐỐI CHIẾU với cơ sở
-- cọc thật (`resolve_signed_contract_deposit_basis_v1` của Đợt 1) thay vì tin số
-- người nhập.
--
-- BA TRẠNG THÁI CẢNH BÁO (không chặn, vì dữ liệu cũ đã lệch sẵn):
--   OK                — số hoàn ≤ cọc thật đang giữ
--   VUOT_COC_THAT     — số hoàn > cọc thật ⇒ chi nhiều hơn đã thu
--   CHUA_TUNG_VAO_KET — cọc chỉ ghi nhận trên sổ ảo ⇒ hoàn tiền mặt là chi khoản chưa thu
--
-- KHÔNG ĐỤNG TIỀN: file tạo một bảng + hai hàm đọc + một hàm ghi nghĩa vụ.
-- Nghĩa vụ KHÔNG phải phiếu chi — nó chỉ nói "phải hoàn bao nhiêu". Việc sinh
-- phiếu là Đợt 8.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('app_private.resolve_signed_contract_deposit_basis_v1(uuid,uuid,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu resolve_signed_contract_deposit_basis_v1 — chạy Đợt 1 trước. DỪNG.';
  END IF;
  IF to_regclass('public.contract_terminations') IS NULL THEN
    RAISE EXCEPTION 'Thiếu contract_terminations. DỪNG.';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.termination_refund_obligations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  termination_id   uuid NOT NULL REFERENCES public.contract_terminations(id) ON DELETE CASCADE,
  contract_id      uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  version          integer NOT NULL DEFAULT 1,
  -- Số người nhập ở hồ sơ thanh lý
  requested_amount numeric(15,2) NOT NULL CHECK (requested_amount >= 0),
  -- Cơ sở cọc THẬT tại thời điểm chốt (từ resolve_signed_contract_deposit_basis_v1)
  real_held        numeric(15,2) NOT NULL,
  recognized_only  numeric(15,2) NOT NULL,
  basis_status     text NOT NULL,
  basis_fingerprint text NOT NULL,
  -- Kết luận
  obligation_status text NOT NULL
    CHECK (obligation_status IN ('OK','VUOT_COC_THAT','CHUA_TUNG_VAO_KET')),
  warning          text,
  snapshot         jsonb NOT NULL,      -- toàn bộ cơ sở, bất biến
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tro_version_positive CHECK (version > 0)
);

-- Một nghĩa vụ SỐNG cho mỗi hồ sơ; sửa thì tăng version (bất biến, không UPDATE).
CREATE UNIQUE INDEX IF NOT EXISTS ux_tro_termination_version
  ON public.termination_refund_obligations (organization_id, termination_id, version);

CREATE INDEX IF NOT EXISTS idx_tro_contract
  ON public.termination_refund_obligations (organization_id, contract_id);

COMMENT ON TABLE public.termination_refund_obligations IS
  'Đợt 7: nghĩa vụ hoàn cọc — BẤT BIẾN, sửa thì tăng version chứ không UPDATE. '
  'Đối chiếu số người nhập (requested_amount) với cọc THẬT đã thu '
  '(resolve_signed_contract_deposit_basis_v1) thay vì tin số nhập tay. Trên prod '
  '30/07 có 8 hợp đồng đã chi thật 20.104.100đ mà thu thật 0đ — đó là lớp lỗi bảng này bắt.';

ALTER TABLE public.termination_refund_obligations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tro_read ON public.termination_refund_obligations;
CREATE POLICY tro_read ON public.termination_refund_obligations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.organization_memberships m
                  WHERE m.organization_id = termination_refund_obligations.organization_id
                    AND m.user_id = auth.uid() AND m.status='ACTIVE')
      OR public.is_super_admin());

REVOKE ALL ON public.termination_refund_obligations FROM anon, authenticated;
GRANT SELECT ON public.termination_refund_obligations TO authenticated;
GRANT ALL ON public.termination_refund_obligations TO service_role;

-- ─────────────────────────────────────────────────────────────────────
-- XEM TRƯỚC nghĩa vụ — chỉ đọc, dùng chung công thức với lúc chốt
-- ─────────────────────────────────────────────────────────────────────
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
  SELECT * INTO v_t FROM contract_terminations WHERE id = p_termination_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hồ sơ thanh lý' USING ERRCODE='P0002';
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

  -- Thứ tự CÓ CHỦ Ý: "chưa từng vào két" nặng hơn "vượt cọc", vì nó nói rằng
  -- KHÔNG ĐỒNG NÀO từng vào — hoàn bao nhiêu cũng là chi khoản chưa thu.
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
    'terminationId', p_termination_id,
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

REVOKE ALL ON FUNCTION public.preview_termination_refund_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_termination_refund_v1(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.preview_termination_refund_v1(uuid) IS
  'Đợt 7: xem trước nghĩa vụ hoàn — đối chiếu số nhập tay ở hồ sơ thanh lý với cọc '
  'THẬT đã thu. CHỈ ĐỌC. Ba trạng thái: OK / VUOT_COC_THAT / CHUA_TUNG_VAO_KET '
  '(nặng nhất — không đồng nào từng vào két nên hoàn bao nhiêu cũng là chi khoản chưa thu).';

-- ─────────────────────────────────────────────────────────────────────
-- CHỐT nghĩa vụ — ghi một dòng bất biến
-- ─────────────────────────────────────────────────────────────────────
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
  v_p    jsonb;
  v_org  uuid;
  v_ct   uuid;
  v_ver  int;
  v_id   uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  -- Khoá hồ sơ trước khi đọc cơ sở: cơ sở phải chụp trên trạng thái đứng yên.
  PERFORM 1 FROM contract_terminations WHERE id = p_termination_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hồ sơ thanh lý' USING ERRCODE='P0002';
  END IF;

  v_p   := public.preview_termination_refund_v1(p_termination_id);
  v_org := (v_p->>'organizationId')::uuid;
  v_ct  := (v_p->>'contractId')::uuid;

  SELECT COALESCE(max(version),0) + 1 INTO v_ver
    FROM termination_refund_obligations
   WHERE organization_id=v_org AND termination_id=p_termination_id;

  INSERT INTO termination_refund_obligations
    (organization_id, termination_id, contract_id, version,
     requested_amount, real_held, recognized_only, basis_status, basis_fingerprint,
     obligation_status, warning, snapshot, created_by)
  VALUES
    (v_org, p_termination_id, v_ct, v_ver,
     (v_p->>'requestedAmount')::numeric, (v_p->>'realHeld')::numeric,
     (v_p->>'recognizedOnly')::numeric, v_p->>'basisStatus', v_p->>'basisFingerprint',
     v_p->>'obligationStatus', v_p->>'warning', v_p, auth.uid())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('obligationId', v_id, 'version', v_ver,
                            'obligationStatus', v_p->>'obligationStatus',
                            'warning', v_p->>'warning');
END;
$function$;

REVOKE ALL ON FUNCTION public.record_termination_refund_obligation_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_termination_refund_obligation_v1(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.record_termination_refund_obligation_v1(uuid) IS
  'Đợt 7: chốt nghĩa vụ hoàn thành một dòng BẤT BIẾN (sửa thì tăng version, không '
  'UPDATE). Khoá hồ sơ FOR UPDATE trước khi chụp cơ sở để cơ sở đứng yên. Lưu cả '
  'fingerprint của cơ sở cọc — đổi một nguồn là fingerprint đổi, biết ngay cơ sở đã trôi.';

DO $selfcheck$
DECLARE v_code text;
BEGIN
  SELECT lower(regexp_replace(p.prosrc,'--[^\n]*','','g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='preview_termination_refund_v1';
  IF position('resolve_signed_contract_deposit_basis_v1' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Không dùng cơ sở cọc dùng chung — sẽ tự chép công thức. DỪNG.';
  END IF;
  -- "chưa từng vào két" phải xét TRƯỚC "vượt cọc" (nặng hơn).
  IF position('chua_tung_vao_ket' IN v_code) > position('vuot_coc_that' IN v_code) THEN
    RAISE EXCEPTION 'Thứ tự cảnh báo sai: CHUA_TUNG_VAO_KET phải xét trước. DỪNG.';
  END IF;
  IF has_function_privilege('anon','public.preview_termination_refund_v1(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'anon gọi được preview — REVOKE. DỪNG.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public'
                AND p.proname IN ('preview_termination_refund_v1','record_termination_refund_obligation_v1')
                AND p.provolatile <> 'v') THEN
    RAISE EXCEPTION 'Hàm phải VOLATILE. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
