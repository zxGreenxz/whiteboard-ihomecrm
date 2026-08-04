-- =====================================================================
-- Đợt 6 (bước 2/2) — CHỐT SỔ & BÀN GIAO QUỸ, HAI BÊN XÁC NHẬN
--
-- Quyết định #6 của chủ: "hai bên xác nhận rồi mới khoá". Quyết định #7: khoá
-- rồi thì KHÔNG AI mở, trừ ngoại lệ ảnh/ghi chú ở #8.
--
-- Lớp THỰC THI khoá đã có từ Đợt 3 (trigger trên phiếu / hạng mục / dòng bút
-- toán / chính bảng accounts, đều đọc app_private.cashbook_closed_through_v1).
-- Đợt 6 chỉ thêm NGHI THỨC ghi ra dòng `app_private.cashbook_closures` — thứ
-- mà tới hôm nay chưa hàm nào ghi (bảng đang rỗng).
--
-- ⚠ VÌ SAO KHÔNG XÂY TIẾP TRÊN NÚT "Chốt số & KHOÁ SỔ" CỦA BanGiaoReport:
--   a) Nút đó ĐÃ CHẾT trên prod: Đợt 3 đã `REVOKE EXECUTE ON
--      create_opening_adjustment FROM authenticated`, nên nhánh khoá của nó
--      luôn trả 42501 sau khi đã kịp ghi một dòng cashbook_reconciliations.
--   b) Nó khoá TRƯỚC khi bên kia đồng ý (chạy tiếp bất kể status='PENDING').
--   c) Không có màn hình nào để bên kia bấm xác nhận (useConfirmReconciliation
--      là code chết).
--   d) Phạm vi sổ của báo cáo đó lọc theo QUY ƯỚC ĐẶT TÊN (name LIKE '%Thu'
--      OR name ILIKE 'tk%' …) nên chỉ 9/27 sổ lọt vào; gắn nghi thức vào đó là
--      18 sổ vĩnh viễn không chốt được.
--
-- ⚠ MỘT CƠ SỞ SỐ DƯ DUY NHẤT. Trên màn đối soát hiện có BỐN định nghĩa số dư
--   khác nhau, và con số người dùng NHÌN khác con số GHI vào DB (đo thật: sổ
--   ATam lệch 2.530.000 giữa hai cơ sở). Cái bị đóng băng vĩnh viễn phải là con
--   số ai cũng nhìn thấy ⇒ dùng ĐÚNG công thức của view accounts_with_balance
--   (initial_amount + Σ signed_amount của dòng POSTING/REVERSAL) và chỉ thêm
--   lát cắt `posted_on <= ngày chốt`. Ghi cả `basis` lên biên bản.
-- =====================================================================

BEGIN;

-- ── 1. Số dư tới một NGÀY, một cơ sở duy nhất ───────────────────────
CREATE OR REPLACE FUNCTION app_private.cashbook_balance_as_of_v1(
  p_cashbook uuid,
  p_as_of date
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  -- Sao chép NGUYÊN VĂN công thức của public.accounts_with_balance, chỉ thêm
  -- `p.posted_on <= p_as_of`. Lọc theo l.organization_id = a.organization_id
  -- giữ nguyên vì view gốc có — bỏ đi là cộng nhầm dòng xuyên tổ chức.
  SELECT a.initial_amount + COALESCE((
    SELECT sum(l.signed_amount)
    FROM public.income_expense_posting_lines l
    JOIN public.income_expense_postings p ON p.id = l.posting_id
    WHERE l.account_id = a.id
      AND l.organization_id = a.organization_id
      AND p.event_kind IN ('POSTING', 'REVERSAL')
      AND p.posted_on <= p_as_of
  ), 0::numeric)
  FROM public.accounts a
  WHERE a.id = p_cashbook;
$fn$;

REVOKE ALL ON FUNCTION app_private.cashbook_balance_as_of_v1(uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. Đề nghị chốt đang chờ ────────────────────────────────────────
-- Tách khỏi `cashbook_closures` (biên bản CUỐI, append-only): một đề nghị còn
-- phải huỷ/từ chối được, mà bảng kia cấm UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS app_private.cashbook_closure_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  cashbook_id           uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  closed_through        date NOT NULL,
  counted_balance       numeric(15,2) NOT NULL,
  system_balance        numeric(15,2) NOT NULL,
  basis                 text NOT NULL DEFAULT 'POSTING_TRUTH_BY_POSTED_ON',
  note                  text,
  proposed_by           uuid NOT NULL,
  proposed_by_membership uuid,
  confirmer_user_id     uuid NOT NULL,
  status                text NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED')),
  confirmed_by          uuid,
  confirmed_at          timestamptz,
  cancelled_by          uuid,
  cancelled_at          timestamptz,
  cancel_reason         text,
  closure_id            bigint,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Người xác nhận PHẢI khác người đề nghị. Đây là toàn bộ giá trị của nghi
  -- thức; kiểm ở tầng bảng để không writer nào lách được.
  CONSTRAINT closure_request_two_party_chk CHECK (confirmer_user_id <> proposed_by)
);

-- Mỗi sổ chỉ một đề nghị đang chờ.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashbook_closure_request_pending
  ON app_private.cashbook_closure_requests (cashbook_id)
  WHERE status = 'PENDING';

REVOKE ALL ON app_private.cashbook_closure_requests
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Cái gì đang chặn chốt sổ ─────────────────────────────────────
-- Trả về DANH SÁCH, không phải một boolean: người đếm tiền cần biết còn phải
-- dọn gì. `blocking=false` là cảnh báo (vẫn chốt được), `true` là chặn cứng.
CREATE OR REPLACE FUNCTION public.cashbook_closing_blockers_v1(p_cashbook uuid)
RETURNS TABLE(code text, blocking boolean, detail text, count_n integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_org uuid;
  v_is_virtual boolean;
  v_closed date;
  v_n integer;
  v_today date := CURRENT_DATE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;

  SELECT a.organization_id, COALESCE(a.is_virtual, false)
    INTO v_org, v_is_virtual
  FROM public.accounts a WHERE a.id = p_cashbook AND a.deleted_at IS NULL;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy sổ quỹ' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của sổ quỹ' USING ERRCODE = '42501';
  END IF;

  IF v_is_virtual THEN
    code := 'VIRTUAL_CASHBOOK'; blocking := true; count_n := 0;
    detail := 'Sổ ảo (Thối / Làm tròn) không đếm tiền mặt được nên không chốt riêng. Nó đóng theo sổ mẹ.';
    RETURN NEXT;
  END IF;

  v_closed := app_private.cashbook_closed_through_v1(p_cashbook);
  IF v_closed IS NOT NULL AND v_closed >= v_today THEN
    code := 'ALREADY_CLOSED'; blocking := true; count_n := 0;
    detail := format('Sổ đã chốt tới %s — không chốt lại cùng ngày.', to_char(v_closed, 'DD/MM/YYYY'));
    RETURN NEXT;
  END IF;

  IF EXISTS (SELECT 1 FROM app_private.cashbook_closure_requests r
              WHERE r.cashbook_id = p_cashbook AND r.status = 'PENDING') THEN
    code := 'CLOSURE_PENDING'; blocking := true; count_n := 1;
    detail := 'Sổ này đã có một đề nghị chốt đang chờ xác nhận. Huỷ đề nghị cũ trước.';
    RETURN NEXT;
  END IF;

  -- Phiếu chờ duyệt: duyệt sau khi đã chốt số là đẻ posting NẰM TRONG kỳ vừa
  -- đóng băng ⇒ số đã ký sai. Phải dọn trước.
  SELECT count(*) INTO v_n FROM public.income_expenses ie
   WHERE ie.account_id = p_cashbook AND ie.deleted_at IS NULL
     AND ie.approval_status = 'UNAPPROVED' AND ie.voucher_date <= v_today;
  IF v_n > 0 THEN
    code := 'PENDING_APPROVAL'; blocking := true; count_n := v_n;
    detail := format('%s phiếu còn Chờ duyệt trong kỳ. Duyệt hoặc huỷ hết trước khi chốt.', v_n);
    RETURN NEXT;
  END IF;

  SELECT count(*) INTO v_n FROM public.income_expenses ie
   WHERE ie.account_id = p_cashbook AND ie.deleted_at IS NULL
     AND ie.approval_status = 'APPROVED'
     AND COALESCE(ie.posting_status, 'UNPOSTED') = 'UNPOSTED'
     AND ie.voucher_date <= v_today;
  IF v_n > 0 THEN
    code := 'APPROVED_NOT_POSTED'; blocking := true; count_n := v_n;
    detail := format('%s phiếu đã duyệt nhưng chưa ghi sổ. Ghi sổ hết thì số dư mới đúng.', v_n);
    RETURN NEXT;
  END IF;

  -- Phiên bàn giao tiền mặt PENDING: confirm_cash_handover chèn phiếu vào sổ,
  -- chốt trước là phiên đó kẹt.
  SELECT count(*) INTO v_n FROM public.cash_handovers h
   WHERE (h.from_account_id = p_cashbook OR h.to_account_id = p_cashbook)
     AND h.status = 'PENDING';
  IF v_n > 0 THEN
    code := 'HANDOVER_PENDING'; blocking := true; count_n := v_n;
    detail := format('%s phiên bàn giao tiền mặt đang chờ. Xác nhận hoặc huỷ hết trước khi chốt, nếu không chúng sẽ kẹt.', v_n);
    RETURN NEXT;
  END IF;

  -- CẢNH BÁO, không chặn: phiên CONFIRMED có phiếu gốc trong kỳ sắp khoá sẽ
  -- không huỷ được nữa (confirm_cancel_handover gỡ handover_id trên phiếu gốc,
  -- mà phiếu đó rơi vào kỳ đã đóng).
  SELECT count(DISTINCT h.id) INTO v_n
  FROM public.cash_handovers h
  JOIN public.income_expenses ie ON ie.handover_id = h.id
  WHERE h.status = 'CONFIRMED'
    AND (h.from_account_id = p_cashbook OR h.to_account_id = p_cashbook)
    AND ie.voucher_date <= v_today;
  IF v_n > 0 THEN
    code := 'HANDOVER_BECOMES_FINAL'; blocking := false; count_n := v_n;
    detail := format('%s phiên bàn giao đã xác nhận sẽ KHÔNG huỷ được nữa sau khi chốt.', v_n);
    RETURN NEXT;
  END IF;

  -- CẢNH BÁO: phiếu chưa có ảnh chứng từ. Sau khi chốt vẫn bổ sung ảnh được
  -- (quyết định #8) nên chỉ nhắc.
  SELECT count(*) INTO v_n FROM public.income_expenses ie
   WHERE ie.account_id = p_cashbook AND ie.deleted_at IS NULL
     AND ie.approval_status = 'APPROVED' AND ie.voucher_date <= v_today
     AND (ie.attachments IS NULL OR jsonb_array_length(COALESCE(ie.attachments, '[]'::jsonb)) = 0);
  IF v_n > 0 THEN
    code := 'MISSING_ATTACHMENTS'; blocking := false; count_n := v_n;
    detail := format('%s phiếu chưa có ảnh chứng từ. Sau khi chốt vẫn bổ sung được, nhưng nên chụp trước.', v_n);
    RETURN NEXT;
  END IF;

  -- Không ai đủ quyền xác nhận thì đề nghị sẽ treo vĩnh viễn — nói trước.
  SELECT count(*) INTO v_n
  FROM public.organization_memberships m
  WHERE m.organization_id = v_org AND m.status = 'ACTIVE' AND m.user_id <> auth.uid()
    AND COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
          m.user_id, v_org, 'cashbooks.close_confirm', NULL, p_cashbook)), false);
  IF v_n = 0 THEN
    code := 'NO_CONFIRMER'; blocking := true; count_n := 0;
    detail := 'Chưa có ai khác đủ quyền XÁC NHẬN nhận bàn giao sổ này. Nhờ quản trị cấp quyền "Xác nhận nhận bàn giao" cho người nhận trước.';
    RETURN NEXT;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.cashbook_closing_blockers_v1(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cashbook_closing_blockers_v1(uuid) TO authenticated;

-- ── 4. ĐỀ NGHỊ chốt ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.propose_cashbook_closing_v1(
  p_cashbook uuid,
  p_counted_balance numeric,
  p_confirmer uuid,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_membership uuid;
  v_today date := CURRENT_DATE;
  v_system numeric;
  v_blockers text;
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF p_counted_balance IS NULL THEN
    RAISE EXCEPTION 'Phải nhập số tiền thực đếm' USING ERRCODE = '22023';
  END IF;
  IF p_confirmer IS NULL OR p_confirmer = v_actor THEN
    RAISE EXCEPTION 'Phải chọn NGƯỜI KHÁC để xác nhận nhận bàn giao — chốt sổ cần cả hai bên.'
      USING ERRCODE = '22023';
  END IF;

  -- FOR UPDATE trên sổ: đua với trigger khoá của Đợt 3 (nó giữ FOR KEY SHARE
  -- khi ghi phiếu), nên phiếu đang chèn dở sẽ đụng độ thật thay vì lọt vào kỳ
  -- vừa bị đóng băng.
  SELECT a.organization_id INTO v_org
  FROM public.accounts a WHERE a.id = p_cashbook AND a.deleted_at IS NULL FOR UPDATE;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Không tìm thấy sổ quỹ' USING ERRCODE = '42501'; END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);

  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE' LIMIT 1;

  IF NOT public.is_super_admin() THEN
    IF NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
         v_actor, v_org, 'cashbooks.close', NULL, p_cashbook)), false) THEN
      RAISE EXCEPTION 'Không có quyền đề nghị chốt sổ quỹ này' USING ERRCODE = '42501';
    END IF;
    -- Người ĐANG GIỮ sổ mới đếm được tiền trong két.
    PERFORM app_private.assert_cashbook_access_v2(v_org, p_cashbook, 'CUSTODIAN', v_membership);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = p_confirmer AND m.organization_id = v_org AND m.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Người xác nhận không thuộc tổ chức này' USING ERRCODE = '22023';
  END IF;
  IF NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
       p_confirmer, v_org, 'cashbooks.close_confirm', NULL, p_cashbook)), false) THEN
    RAISE EXCEPTION 'Người được chọn không có quyền xác nhận nhận bàn giao sổ này'
      USING ERRCODE = '42501';
  END IF;

  SELECT string_agg(b.detail, ' | ') INTO v_blockers
  FROM public.cashbook_closing_blockers_v1(p_cashbook) b WHERE b.blocking;
  IF v_blockers IS NOT NULL THEN
    RAISE EXCEPTION 'Chưa chốt được: %', v_blockers USING ERRCODE = '55000';
  END IF;

  -- closed_through ÉP = HÔM NAY. Đếm tiền là đếm BÂY GIỜ; đem so với số dư một
  -- ngày quá khứ thì phần chênh chính là giao dịch ở giữa, và hệ thống sẽ ghi
  -- nhầm thành thừa/thiếu quỹ rồi khoá vĩnh viễn con số sai đó.
  v_system := app_private.cashbook_balance_as_of_v1(p_cashbook, v_today);

  INSERT INTO app_private.cashbook_closure_requests
    (organization_id, cashbook_id, closed_through, counted_balance, system_balance,
     note, proposed_by, proposed_by_membership, confirmer_user_id)
  VALUES
    (v_org, p_cashbook, v_today, round(p_counted_balance, 2), round(v_system, 2),
     nullif(btrim(COALESCE(p_note, '')), ''), v_actor, v_membership, p_confirmer)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'request_id', v_id,
    'cashbook_id', p_cashbook,
    'closed_through', v_today,
    'counted_balance', round(p_counted_balance, 2),
    'system_balance', round(v_system, 2),
    'difference', round(p_counted_balance - v_system, 2),
    'basis', 'POSTING_TRUTH_BY_POSTED_ON',
    'status', 'PENDING'
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.propose_cashbook_closing_v1(uuid, numeric, uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.propose_cashbook_closing_v1(uuid, numeric, uuid, text)
  TO authenticated;

-- ── 5. HUỶ đề nghị ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_cashbook_closing_v1(
  p_request uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  r app_private.cashbook_closure_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO r FROM app_private.cashbook_closure_requests
   WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy đề nghị' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'PENDING' THEN
    RETURN jsonb_build_object('request_id', p_request, 'changed', false, 'status', r.status);
  END IF;
  -- Chỉ hai bên trong cuộc (hoặc super admin) được rút lại.
  IF v_actor NOT IN (r.proposed_by, r.confirmer_user_id) AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Chỉ người đề nghị hoặc người được chỉ định xác nhận mới huỷ được'
      USING ERRCODE = '42501';
  END IF;

  UPDATE app_private.cashbook_closure_requests
     SET status = 'CANCELLED', cancelled_by = v_actor, cancelled_at = now(),
         cancel_reason = nullif(btrim(COALESCE(p_reason, '')), '')
   WHERE id = p_request;

  RETURN jsonb_build_object('request_id', p_request, 'changed', true, 'status', 'CANCELLED');
END
$fn$;

REVOKE ALL ON FUNCTION public.cancel_cashbook_closing_v1(uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_cashbook_closing_v1(uuid, text) TO authenticated;

-- ── 6. XÁC NHẬN — đây là lúc kỳ đóng VĨNH VIỄN ──────────────────────
CREATE OR REPLACE FUNCTION public.confirm_cashbook_closing_v1(
  p_request uuid,
  p_counted_balance numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  r app_private.cashbook_closure_requests%ROWTYPE;
  v_membership uuid;
  v_system numeric;
  v_blockers text;
  v_closure bigint;
  v_after numeric;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;

  SELECT * INTO r FROM app_private.cashbook_closure_requests
   WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy đề nghị' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Đề nghị này đã % rồi', lower(r.status) USING ERRCODE = '23505';
  END IF;

  -- Hai bên, hai người. Bảng đã có CHECK, nhưng nói lại cho rõ lỗi.
  IF v_actor = r.proposed_by THEN
    RAISE EXCEPTION 'Người đề nghị không tự xác nhận được — phải là người nhận bàn giao.'
      USING ERRCODE = '42501';
  END IF;
  IF v_actor <> r.confirmer_user_id AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Đề nghị này được gửi cho người khác xác nhận' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.accounts a WHERE a.id = r.cashbook_id FOR UPDATE;
  PERFORM app_private.lock_org_for_decision_v1(r.organization_id);

  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = r.organization_id AND m.status = 'ACTIVE' LIMIT 1;

  IF NOT public.is_super_admin()
     AND NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
       v_actor, r.organization_id, 'cashbooks.close_confirm', NULL, r.cashbook_id)), false) THEN
    RAISE EXCEPTION 'Không có quyền xác nhận nhận bàn giao' USING ERRCODE = '42501';
  END IF;

  -- CHẠY LẠI blockers và FAIL CỨNG. Tuyệt đối KHÔNG "duyệt hộ" ở bước này:
  -- duyệt sẽ đẻ posting NẰM TRONG kỳ, sau khi số chênh đã chốt.
  --
  -- Loại hai mã vô nghĩa ở phía người xác nhận:
  --  - CLOSURE_PENDING: đề nghị đang chờ CHÍNH LÀ cái sắp ký.
  --  - NO_CONFIRMER: rào đó đếm người xác nhận KHÁC người đang hỏi, để cảnh báo
  --    lúc ĐỀ NGHỊ. Ở đây người đang hỏi chính là người xác nhận, nên nếu họ là
  --    người duy nhất thì rào tự bắn vào chân mình và không ai ký được bao giờ.
  SELECT string_agg(b.detail, ' | ') INTO v_blockers
  FROM public.cashbook_closing_blockers_v1(r.cashbook_id) b
  WHERE b.blocking AND b.code NOT IN ('CLOSURE_PENDING', 'NO_CONFIRMER');
  IF v_blockers IS NOT NULL THEN
    RAISE EXCEPTION 'Không xác nhận được, sổ đã đổi kể từ lúc đề nghị: %', v_blockers
      USING ERRCODE = '55000';
  END IF;

  -- Số dư tính LẠI TƯƠI tại thời điểm ký. Nếu đã trôi khỏi lúc đề nghị thì
  -- dừng — người ký phải nhìn con số đúng của chính lúc ký.
  v_system := round(app_private.cashbook_balance_as_of_v1(r.cashbook_id, r.closed_through), 2);
  IF v_system <> r.system_balance THEN
    RAISE EXCEPTION
      'Số dư hệ thống đã đổi từ % thành % kể từ lúc đề nghị — huỷ đề nghị và đếm lại.',
      r.system_balance, v_system USING ERRCODE = '40001';
  END IF;
  IF p_counted_balance IS NULL OR round(p_counted_balance, 2) <> r.counted_balance THEN
    RAISE EXCEPTION
      'Số tiền bạn đếm (%) khác số người giao khai (%) — hai bên phải đếm lại cùng nhau.',
      round(COALESCE(p_counted_balance, 0), 2), r.counted_balance USING ERRCODE = '22023';
  END IF;

  -- Biên bản. Ghi CẢ HAI con số + tên cơ sở để sau này còn đối chiếu được.
  INSERT INTO app_private.cashbook_closures
    (organization_id, cashbook_id, closed_through, counted_balance, system_balance,
     basis, proposed_by, confirmed_by)
  VALUES
    (r.organization_id, r.cashbook_id, r.closed_through, r.counted_balance, v_system,
     r.basis, r.proposed_by, v_actor)
  RETURNING id INTO v_closure;

  UPDATE app_private.cashbook_closure_requests
     SET status = 'CONFIRMED', confirmed_by = v_actor, confirmed_at = now(),
         closure_id = v_closure
   WHERE id = p_request;

  -- Hậu điều kiện: kỳ PHẢI thật sự đóng sau khi ghi biên bản. Nếu
  -- cashbook_closed_through_v1 không trả về đúng ngày này thì mọi trigger khoá
  -- của Đợt 3 vẫn đang mở và lời hứa "khoá vĩnh viễn" là nói dối.
  IF app_private.cashbook_closed_through_v1(r.cashbook_id) IS DISTINCT FROM r.closed_through
     AND app_private.cashbook_closed_through_v1(r.cashbook_id) < r.closed_through THEN
    RAISE EXCEPTION 'Ghi biên bản xong nhưng kỳ chưa đóng — dừng lại' USING ERRCODE = '55000';
  END IF;

  -- Cache đọc nhanh trên accounts. Không phải nguồn sự thật (nguồn là
  -- cashbook_closures) nhưng nhiều màn hình cũ vẫn đọc lock_date.
  UPDATE public.accounts
     SET lock_date = GREATEST(COALESCE(lock_date, r.closed_through), r.closed_through)
   WHERE id = r.cashbook_id;

  v_after := round(app_private.cashbook_balance_as_of_v1(r.cashbook_id, r.closed_through), 2);
  IF v_after <> v_system THEN
    RAISE EXCEPTION 'Số dư đổi ngay trong lúc chốt (% -> %) — dừng lại', v_system, v_after
      USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'request_id', p_request,
    'closure_id', v_closure,
    'cashbook_id', r.cashbook_id,
    'closed_through', r.closed_through,
    'counted_balance', r.counted_balance,
    'system_balance', v_system,
    'difference', round(r.counted_balance - v_system, 2),
    'basis', r.basis,
    'status', 'CONFIRMED'
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.confirm_cashbook_closing_v1(uuid, numeric) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_cashbook_closing_v1(uuid, numeric) TO authenticated;

-- ── 7. Đọc cho giao diện ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_cashbook_closings_v1(p_cashbook uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;

  SELECT jsonb_build_object(
    'pending', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'request_id', r.id, 'cashbook_id', r.cashbook_id, 'cashbook_name', a.name,
        'closed_through', r.closed_through, 'counted_balance', r.counted_balance,
        'system_balance', r.system_balance,
        'difference', r.counted_balance - r.system_balance,
        'note', r.note, 'created_at', r.created_at,
        'proposed_by', r.proposed_by, 'proposed_by_name', pp.full_name,
        'confirmer_user_id', r.confirmer_user_id, 'confirmer_name', cp.full_name,
        'is_mine_to_confirm', (r.confirmer_user_id = auth.uid())
      ) ORDER BY r.created_at DESC)
      FROM app_private.cashbook_closure_requests r
      JOIN public.accounts a ON a.id = r.cashbook_id
      LEFT JOIN public.profiles pp ON pp.id = r.proposed_by
      LEFT JOIN public.profiles cp ON cp.id = r.confirmer_user_id
      WHERE r.status = 'PENDING'
        AND (p_cashbook IS NULL OR r.cashbook_id = p_cashbook)
        AND (public.is_super_admin() OR EXISTS (
          SELECT 1 FROM public.organization_memberships m
           WHERE m.user_id = auth.uid() AND m.organization_id = r.organization_id
             AND m.status = 'ACTIVE'))
    ), '[]'::jsonb),
    'closures', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'closure_id', c.id, 'cashbook_id', c.cashbook_id, 'cashbook_name', a.name,
        'closed_through', c.closed_through, 'counted_balance', c.counted_balance,
        'system_balance', c.system_balance,
        'difference', c.counted_balance - c.system_balance,
        'basis', c.basis, 'confirmed_at', c.confirmed_at,
        'proposed_by_name', pp.full_name, 'confirmed_by_name', cp.full_name
      ) ORDER BY c.closed_through DESC, c.id DESC)
      FROM app_private.cashbook_closures c
      JOIN public.accounts a ON a.id = c.cashbook_id
      LEFT JOIN public.profiles pp ON pp.id = c.proposed_by
      LEFT JOIN public.profiles cp ON cp.id = c.confirmed_by
      WHERE (p_cashbook IS NULL OR c.cashbook_id = p_cashbook)
        AND (public.is_super_admin() OR EXISTS (
          SELECT 1 FROM public.organization_memberships m
           WHERE m.user_id = auth.uid() AND m.organization_id = c.organization_id
             AND m.status = 'ACTIVE'))
    ), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.list_cashbook_closings_v1(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.list_cashbook_closings_v1(uuid) TO authenticated;

-- Số dư as-of cho giao diện (đọc, có kiểm phạm vi nhìn).
CREATE OR REPLACE FUNCTION public.cashbook_balance_as_of_v1(p_cashbook uuid, p_as_of date DEFAULT NULL)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE v_org uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT a.organization_id INTO v_org FROM public.accounts a WHERE a.id = p_cashbook;
  IF v_org IS NULL THEN RETURN NULL; END IF;
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của sổ quỹ' USING ERRCODE = '42501';
  END IF;
  -- Cùng doctrine với Đợt 0: hàm tổng hợp SECURITY DEFINER phải tự giới hạn
  -- phạm vi nhìn, nếu không ai cũng đọc được tồn quỹ sổ người khác.
  PERFORM app_private.assert_cashbook_access_v2(v_org, p_cashbook, 'KNOWER', NULL);
  RETURN app_private.cashbook_balance_as_of_v1(p_cashbook, COALESCE(p_as_of, CURRENT_DATE));
END
$fn$;

REVOKE ALL ON FUNCTION public.cashbook_balance_as_of_v1(uuid, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cashbook_balance_as_of_v1(uuid, date) TO authenticated;

-- Ai đủ tư cách NHẬN bàn giao sổ này. Giao diện phải hỏi trước, nếu không nó
-- bày ra cả danh bạ tổ chức rồi mới báo lỗi ở bước cuối.
-- Loại chính người đang hỏi: nghi thức đòi hai người khác nhau.
CREATE OR REPLACE FUNCTION public.cashbook_close_confirmers_v1(p_cashbook uuid)
RETURNS TABLE(user_id uuid, full_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE v_org uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT a.organization_id INTO v_org FROM public.accounts a WHERE a.id = p_cashbook;
  IF v_org IS NULL THEN RETURN; END IF;
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
  ) THEN RETURN; END IF;

  RETURN QUERY
  SELECT m.user_id, COALESCE(p.full_name, '')::text
  FROM public.organization_memberships m
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.organization_id = v_org
    AND m.status = 'ACTIVE'
    AND m.user_id <> auth.uid()
    AND COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
          m.user_id, v_org, 'cashbooks.close_confirm', NULL, p_cashbook)), false)
  ORDER BY 2;
END
$fn$;

REVOKE ALL ON FUNCTION public.cashbook_close_confirmers_v1(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cashbook_close_confirmers_v1(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
