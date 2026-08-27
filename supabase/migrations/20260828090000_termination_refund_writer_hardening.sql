-- =====================================================================
-- VÁ 4 LỖI CHẶN trên đường hoàn cọc mới — theo audit
-- docs/audits/AUDIT-PLAN2-ROOM-LIFECYCLE-REFUND-2026-08-27.md (F1, F2, F3, F11).
-- Đường này chưa từng chạy thật (termination_refund_obligations = 0 hàng trên
-- prod ngày 27/08) nên các lỗi dưới đây chưa nổ — vá TRƯỚC khi ai đó bấm nút.
--
-- F1 · `system_source` mồ côi: writer ghi 'termination.refund.v2' trong khi ô
--      KPI /deposits, useDepositDashboard, useContractDetailData và
--      voucherSources đều lọc BẰNG ĐÚNG 'termination.refund'. Tiền ra khỏi két
--      mà mọi màn vẫn nói "chưa hoàn", /thu-chi hiện nguồn "Nhập tay".
--      → writer ghi 'termination.refund' cho khớp mọi reader sẵn có.
--
-- F2 · Không gì chặn HAI phiếu hoàn cho một hồ sơ: `version` nghĩa vụ tăng vô
--      hạn, còn index cũ `ux_tro_voucher` là UNIQUE (organization_id, id)
--      WHERE voucher_id IS NOT NULL — `id` đã là PK nên nó KHÔNG ràng buộc gì
--      (bảo vệ giả, đã báo từ audit 13/08). → khoá thật theo
--      (organization_id, termination_id), kèm kiểm tra thân thiện trong writer
--      và bước gỡ link phiếu đã huỷ để đường "huỷ rồi sinh lại" vẫn sống.
--
-- F3 · Writer không đọc `contract_terminations.status`: hồ sơ DRAFT vẫn sinh
--      được phiếu chi. → chỉ APPROVED/COMPLETED mới sinh phiếu.
--
-- F11 · `record_termination_refund_obligation_v1` bản 20260731110000 đảo thứ
--      tự: preview TRƯỚC rồi mới FOR UPDATE — mất invariant "cơ sở phải chụp
--      trên trạng thái đứng yên" mà chính bản Đợt 7 (20260731090000:180-184)
--      ghi thành chú thích. → phân giải id → KHOÁ → rồi mới preview.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.termination_refund_obligations') IS NULL THEN
    RAISE EXCEPTION 'Thiếu termination_refund_obligations — chạy 20260731090000 trước. DỪNG.';
  END IF;
  IF to_regprocedure('public.preview_termination_refund_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu preview_termination_refund_v1. DỪNG.';
  END IF;
  IF to_regprocedure('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu create_termination_refund_voucher_v1 — chạy 20260731100000 trước. DỪNG.';
  END IF;
  IF to_regprocedure('app_private.is_org_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu is_org_owner_v1. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- F11 — record: phân giải id → KHOÁ hồ sơ → rồi mới chụp cơ sở.
-- Giữ nguyên hành vi 20260731110000 (nhận cả id hồ sơ lẫn id hợp đồng),
-- nhưng preview chạy DƯỚI khoá, trên id đã phân giải — cơ sở đứng yên.
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
  v_p jsonb; v_org uuid; v_ct uuid; v_tm uuid; v_ver int; v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  -- Phân giải trước, KHÔNG qua preview: thử id hồ sơ, không có thì hiểu là id
  -- HỢP ĐỒNG và lấy hồ sơ mới nhất (đúng luật của 20260731110000).
  SELECT id INTO v_tm FROM contract_terminations WHERE id = p_termination_id;
  IF v_tm IS NULL THEN
    SELECT id INTO v_tm FROM contract_terminations
     WHERE contract_id = p_termination_id
     ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF v_tm IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng này chưa có hồ sơ thanh lý — chưa tính được tiền hoàn.'
      USING ERRCODE='P0002';
  END IF;

  -- Khoá hồ sơ TRƯỚC khi đọc cơ sở: cơ sở phải chụp trên trạng thái đứng yên.
  PERFORM 1 FROM contract_terminations WHERE id = v_tm FOR UPDATE;

  v_p   := public.preview_termination_refund_v1(v_tm);
  v_org := (v_p->>'organizationId')::uuid;
  v_ct  := (v_p->>'contractId')::uuid;

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

REVOKE ALL ON FUNCTION public.record_termination_refund_obligation_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_termination_refund_obligation_v1(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- F1 + F2 + F3 — writer sinh phiếu
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_termination_refund_voucher_v1(
  p_obligation_id uuid,
  p_account_id    uuid DEFAULT NULL,
  p_force         boolean DEFAULT false,
  p_force_reason  text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_o     public.termination_refund_obligations;
  v_c     public.contracts;
  v_tstatus text;
  v_bld   uuid;
  v_acc   uuid;
  v_type  uuid;
  v_ie    uuid;
  v_code  text;
  v_is_owner boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_o FROM termination_refund_obligations
   WHERE id = p_obligation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy nghĩa vụ hoàn' USING ERRCODE='P0002';
  END IF;

  -- Khoá HỒ SƠ: tuần tự hoá mọi lần sinh phiếu trên cùng hồ sơ (kể cả khi hai
  -- người gọi trên HAI phiên bản nghĩa vụ khác nhau), và đọc status dưới khoá.
  SELECT status INTO v_tstatus FROM contract_terminations
   WHERE id = v_o.termination_id FOR UPDATE;
  IF v_tstatus IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy hồ sơ thanh lý của nghĩa vụ này' USING ERRCODE='P0002';
  END IF;

  -- F3: hồ sơ CHƯA DUYỆT thì không có phiếu chi. DRAFT/PENDING_APPROVAL sửa
  -- được số ⇒ phiếu sinh lúc này là chi theo một con số chưa ai chốt.
  IF v_tstatus NOT IN ('APPROVED','COMPLETED') THEN
    RAISE EXCEPTION
      'Hồ sơ thanh lý đang ở trạng thái % — phải được duyệt (APPROVED/COMPLETED) rồi mới sinh phiếu hoàn.',
      v_tstatus USING ERRCODE='55000';
  END IF;

  -- F2a: gỡ link tới phiếu đã HUỶ/XOÁ ở mọi phiên bản nghĩa vụ của hồ sơ này.
  -- Không có bước này thì khoá "một phiếu sống một hồ sơ" bên dưới sẽ giết luôn
  -- đường nghiệp vụ hợp lệ "huỷ phiếu sai rồi sinh lại phiếu mới".
  UPDATE termination_refund_obligations o
     SET voucher_id = NULL
   WHERE o.organization_id = v_o.organization_id
     AND o.termination_id  = v_o.termination_id
     AND o.voucher_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM income_expenses ie
                  WHERE ie.id = o.voucher_id
                    AND (ie.approval_status = 'CANCELLED' OR ie.deleted_at IS NOT NULL));

  -- F2b: hồ sơ đã có phiếu SỐNG ở BẤT KỲ phiên bản nghĩa vụ nào ⇒ trả phiếu đó,
  -- tuyệt đối không đẻ phiếu thứ hai. (Bản cũ chỉ nhìn voucher_id của CHÍNH
  -- phiên bản đang gọi — record thêm version mới là lách qua được.)
  SELECT o.voucher_id, ie.code INTO v_ie, v_code
    FROM termination_refund_obligations o
    JOIN income_expenses ie ON ie.id = o.voucher_id
   WHERE o.organization_id = v_o.organization_id
     AND o.termination_id  = v_o.termination_id
     AND o.voucher_id IS NOT NULL
   ORDER BY o.version DESC
   LIMIT 1;
  IF v_ie IS NOT NULL THEN
    RETURN jsonb_build_object('voucherId', v_ie, 'code', v_code,
                              'alreadyCreated', true);
  END IF;

  SELECT * INTO v_c FROM contracts WHERE id = v_o.contract_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hợp đồng' USING ERRCODE='P0002'; END IF;
  SELECT r.building_id INTO v_bld FROM rooms r WHERE r.id = v_c.room_id;
  IF v_bld IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng không gắn phòng/toà — không xác định được toà để ghi phiếu'
      USING ERRCODE='22023';
  END IF;

  IF NOT (public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld)
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE='42501';
  END IF;

  IF v_o.requested_amount <= 0 THEN
    RAISE EXCEPTION 'Nghĩa vụ này không phải hoàn tiền (số hoàn %đ) — không sinh phiếu chi.',
      round(v_o.requested_amount)::bigint USING ERRCODE='22023';
  END IF;

  -- ══ CHỐT CHẶN: nghĩa vụ lệch thì phải CHỦ ép, kèm lý do ═══════════
  IF v_o.obligation_status <> 'OK' THEN
    v_is_owner := public.is_super_admin()
               OR app_private.is_org_owner_v1(v_o.organization_id, v_actor);
    IF NOT p_force THEN
      RAISE EXCEPTION
        'Nghĩa vụ này đang cảnh báo [%]: %. Muốn vẫn sinh phiếu thì chủ tổ chức phải ép (p_force) kèm lý do.',
        v_o.obligation_status, COALESCE(v_o.warning,'(không rõ)')
        USING ERRCODE = '55000';
    END IF;
    IF NOT v_is_owner THEN
      RAISE EXCEPTION
        'Chỉ chủ tổ chức hoặc super admin mới ép sinh phiếu hoàn khi nghĩa vụ đang cảnh báo [%].',
        v_o.obligation_status USING ERRCODE = '42501';
    END IF;
    IF COALESCE(length(btrim(p_force_reason)),0) < 8 THEN
      RAISE EXCEPTION 'Ép sinh phiếu phải kèm lý do ít nhất 8 ký tự' USING ERRCODE='22023';
    END IF;
  END IF;

  -- Sổ quỹ: bắt buộc là sổ THẬT (không ảo) — hoàn cọc là tiền ra khỏi két.
  v_acc := p_account_id;
  IF v_acc IS NOT NULL THEN
    PERFORM 1 FROM accounts a
     WHERE a.id = v_acc AND a.deleted_at IS NULL
       AND a.organization_id = v_o.organization_id
       AND NOT COALESCE(a.is_virtual,false);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ không hợp lệ, khác tổ chức, hoặc là SỔ ẢO (hoàn cọc là tiền thật ra khỏi két)'
        USING ERRCODE='22023';
    END IF;
  END IF;

  v_type := app_private.ensure_income_expense_type_v1(
              v_o.organization_id, v_actor, 'Hoàn tiền cọc', 'expense',
              NULL, NULL, false, true, false, false, false, false);

  -- F1: 'termination.refund' — ĐÚNG chuỗi mà ô KPI /deposits,
  -- useDepositDashboard, useContractDetailData và voucherSources đang lọc.
  -- Chuỗi cũ 'termination.refund.v2' không màn nào đọc ⇒ tiền ra khỏi két mà
  -- mọi báo cáo vẫn nói "chưa hoàn".
  INSERT INTO income_expenses
    (user_id, organization_id, type, name, building_id, room_id, contract_id,
     voucher_date, total_amount, approval_status, account_id, system_source, notes)
  VALUES
    (v_actor, v_o.organization_id, 'EXPENSE',
     'Hoàn tiền cọc — HĐ ' || COALESCE(v_c.contract_number, left(v_c.id::text,8)),
     v_bld, v_c.room_id, v_o.contract_id,
     public.org_today_v1(v_o.organization_id), v_o.requested_amount,
     'UNAPPROVED', v_acc, 'termination.refund',
     CASE WHEN v_o.obligation_status <> 'OK'
          THEN 'ÉP SINH dù cảnh báo [' || v_o.obligation_status || ']: ' || btrim(p_force_reason)
          ELSE 'Sinh từ nghĩa vụ hoàn cọc đã đối chiếu với cọc thật' END)
  RETURNING id, code INTO v_ie, v_code;

  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, accounting_class,
     description, quantity, unit_price, amount)
  -- accounting_class CHECK chỉ nhận PNL / DEPOSIT / CUSTOMER_CREDIT / INTERNAL.
  -- Hoàn cọc là DEPOSIT (bảng cân đối), KHÔNG phải chi phí kinh doanh (PNL) —
  -- ghi nhầm PNL là thổi phồng chi phí và làm lệch Báo cáo Lợi Nhuận.
  VALUES (v_ie, v_type, 'DEPOSIT', 'Hoàn cọc thanh lý', 1,
          v_o.requested_amount, v_o.requested_amount);

  UPDATE termination_refund_obligations SET voucher_id = v_ie WHERE id = p_obligation_id;

  RETURN jsonb_build_object(
    'voucherId', v_ie, 'code', v_code, 'amount', v_o.requested_amount,
    'obligationStatus', v_o.obligation_status, 'forced', (v_o.obligation_status <> 'OK'),
    'note', 'Phiếu ở trạng thái CHỜ DUYỆT — tiền chỉ ra khỏi két khi có người duyệt.');
END;
$function$;

REVOKE ALL ON FUNCTION public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text) IS
  'Đợt 8 + vá 28/08: biến nghĩa vụ hoàn thành PHIẾU CHI ở trạng thái CHỜ DUYỆT. '
  'Chỉ hồ sơ APPROVED/COMPLETED. Một phiếu SỐNG cho mỗi hồ sơ, xét trên MỌI phiên '
  'bản nghĩa vụ (khoá ux_tro_phieu_song là hàng rào cuối). system_source = '
  '''termination.refund'' cho khớp mọi màn đọc. Nghĩa vụ không OK thì phải CHỦ TỔ '
  'CHỨC ép kèm lý do. Sổ quỹ bắt buộc là sổ THẬT. Gọi lại trả phiếu cũ.';

-- ─────────────────────────────────────────────────────────────────────
-- F2c — thay khoá giả bằng khoá thật.
-- Index cũ UNIQUE (organization_id, id) không ràng buộc gì vì id là PK.
-- Khoá mới: MỘT phiếu sống cho MỖI hồ sơ thanh lý, bất kể phiên bản nghĩa vụ.
-- Prod ngày 27/08 có 0 hàng nên không thể đụng dữ liệu cũ.
-- ─────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.ux_tro_voucher;
CREATE UNIQUE INDEX IF NOT EXISTS ux_tro_phieu_song
  ON public.termination_refund_obligations (organization_id, termination_id)
  WHERE voucher_id IS NOT NULL;

COMMENT ON INDEX public.ux_tro_phieu_song IS
  'Một phiếu hoàn SỐNG cho mỗi hồ sơ thanh lý — hàng rào cuối cho race hai phiên '
  'bản nghĩa vụ cùng sinh phiếu. Link tới phiếu đã huỷ được writer gỡ (SET NULL) '
  'trước khi sinh lại, nên "huỷ rồi sinh lại" vẫn sống.';

-- ─────────────────────────────────────────────────────────────────────
-- Self-check: văn bản hàm + khoá phải đúng như tuyên bố, sai là DỪNG cả migration
-- ─────────────────────────────────────────────────────────────────────
DO $selfcheck$
DECLARE v_code text; v_pos_lock int; v_pos_preview int; v_def text;
BEGIN
  -- Writer
  SELECT lower(regexp_replace(p.prosrc,'--[^\n]*','','g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='create_termination_refund_voucher_v1';
  IF position('''termination.refund''' IN v_code) = 0 THEN
    RAISE EXCEPTION 'F1 hỏng: writer không ghi system_source=termination.refund. DỪNG.';
  END IF;
  IF position('termination.refund.v2' IN v_code) > 0 THEN
    RAISE EXCEPTION 'F1 hỏng: chuỗi mồ côi .v2 vẫn còn trong writer. DỪNG.';
  END IF;
  IF position('''approved''' IN v_code) = 0 OR position('''completed''' IN v_code) = 0 THEN
    RAISE EXCEPTION 'F3 hỏng: writer không gác trạng thái hồ sơ. DỪNG.';
  END IF;
  IF position('is_org_owner_v1' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Không kiểm quyền chủ khi ép sinh phiếu. DỪNG.';
  END IF;
  IF position('is_virtual' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Không chặn sổ ảo — hoàn cọc là tiền thật ra khỏi két. DỪNG.';
  END IF;
  IF position('''unapproved''' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Phiếu không ra ở trạng thái CHỜ DUYỆT. DỪNG.';
  END IF;
  -- Writer này TUYỆT ĐỐI không được tự ghi sổ.
  IF position('post_voucher_with_source' IN v_code) > 0
     OR position('income_expense_postings' IN v_code) > 0 THEN
    RAISE EXCEPTION 'Writer đang tự ghi sổ — phải để người duyệt rồi cầu a85 ghi. DỪNG.';
  END IF;

  -- F11: record phải KHOÁ trước rồi mới preview
  SELECT lower(regexp_replace(p.prosrc,'--[^\n]*','','g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='record_termination_refund_obligation_v1';
  v_pos_lock    := position('for update' IN v_code);
  v_pos_preview := position('preview_termination_refund_v1' IN v_code);
  IF v_pos_lock = 0 OR v_pos_preview = 0 OR v_pos_lock > v_pos_preview THEN
    RAISE EXCEPTION 'F11 hỏng: record không khoá hồ sơ TRƯỚC khi chụp cơ sở (lock=% preview=%). DỪNG.',
      v_pos_lock, v_pos_preview;
  END IF;

  -- F2: khoá giả phải biến mất, khoá thật phải đúng hình
  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE schemaname='public' AND indexname='ux_tro_voucher') THEN
    RAISE EXCEPTION 'F2 hỏng: index giả ux_tro_voucher vẫn còn. DỪNG.';
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname='public' AND indexname='ux_tro_phieu_song';
  IF v_def IS NULL
     OR position('UNIQUE' IN v_def) = 0
     OR position('(organization_id, termination_id)' IN v_def) = 0
     OR position('voucher_id IS NOT NULL' IN v_def) = 0 THEN
    RAISE EXCEPTION 'F2 hỏng: ux_tro_phieu_song sai hình (%). DỪNG.', COALESCE(v_def,'(không tồn tại)');
  END IF;
END
$selfcheck$;

COMMIT;
