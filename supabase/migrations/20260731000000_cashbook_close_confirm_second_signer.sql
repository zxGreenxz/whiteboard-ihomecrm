-- =====================================================================
-- PA4 (A/5) — NGƯỜI KÝ THỨ HAI CHO NGHI THỨC CHỐT SỔ
--
-- Đo trên prod 30/07/2026, org thật `iHome CRM`, 16 sổ không-ảo:
--   · 10 sổ (AG708, AG810, ATam, Chung, HKDHIEN, HKDHUY, HKDTAM, MBHIEP,
--     Tâm Thu, TK939) chỉ MỘT người dính líu — NG TÂM — ở CẢ HAI vế.
--   ·  6 sổ còn lại có người đề nghị khác (JOEY / NATHAN / B.Huy) nhưng vế
--     XÁC NHẬN vẫn chỉ NG TÂM.
-- ⇒ Nghi thức hai bên (`closure_request_two_party_chk`: confirmer <> proposer)
--   bất khả thi trên 10 sổ, và `cashbook_closing_blockers_v1` trả NO_CONFIRMER.
--   Đây chính là lý do prod có 0 closure sau khi Đợt 6 đã ship đủ.
--
-- Chủ quyết: người ký thứ hai = KẾ TOÁN + CHỦ SỞ HỮU TỔ CHỨC.
-- Nhưng KHÔNG org nào có vai trò 'Kế toán' (org thật chỉ có 'Chủ sở hữu tổ
-- chức', 'Super Admin', 'Quản Lý Tòa', 'Partner', 'Viewer', 'Huy').
--
-- Migration này làm ĐÚNG BA việc, không hơn:
--   1. tạo vai trò 'Kế toán' cho org còn thiếu (rỗng, 0 binding),
--   2. cấp 'cashbooks.close_confirm' cho vai trò đó,
--   3. đếm lại và BÁO ra sổ nào vẫn chưa có người ký.
--
-- ⚠ CỐ Ý KHÔNG TỰ GÁN AI vào vai trò. Gán người = trao quyền ký khoá kỳ VĨNH
--   VIỄN (không có đường mở khoá — quyết định #7). Việc đó phải do chủ bấm
--   trong màn phân quyền, không phải do một dòng SQL đoán hộ.
--
-- ⚠ CỐ Ý KHÔNG cấp close_confirm cho 'Quản Lý Tòa'. Vai trò đó đang giữ vế ĐỀ
--   NGHỊ (JOEY, NATHAN). Cấp cả hai vế cho cùng một vai trò là biến "hai bên"
--   thành lời nói: hai quản lý ký chéo cho nhau, không ai đại diện bên nhận.
--   Chính assert của 20260730160000:213-221 cảnh báo điều này.
--
-- KHÔNG có writer nào ở đây. Không đụng một đồng nào.
-- =====================================================================

BEGIN;

-- ── 1. Vai trò 'Kế toán' ────────────────────────────────────────────
-- public.organization_roles KHÔNG có unique constraint trên (organization_id,
-- name) — chỉ PK(id) và UNIQUE(organization_id, id) — nên phải guard bằng
-- NOT EXISTS, ON CONFLICT không dùng được. Bảng cũng không có trigger nào.
-- is_system=false, status='ACTIVE', version=1 đều là DEFAULT.
INSERT INTO public.organization_roles (organization_id, name)
SELECT o.id, 'Kế toán'
FROM public.organizations o
WHERE o.status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1 FROM public.organization_roles r
    WHERE r.organization_id = o.id AND r.name = 'Kế toán');

-- ── 1b. Phạm vi ORGANIZATION phải tồn tại để gán được ───────────────
-- Vai trò KHÔNG mang phạm vi; phạm vi gắn lúc GÁN (`role_bindings` +
-- `role_binding_scopes`). Binding KHÔNG có cạnh phạm vi nào thì
-- authorize_tenant_action_v3 trả DEFAULT_DENY — đã đo: gán 'Kế toán' cho JOEY
-- mà không kèm cạnh thì 0/16 sổ nhúc nhích. Màn "Thành viên" cho chọn "toàn tổ
-- chức", nhưng nó chỉ chọn được dòng CÓ SẴN trong authorization_scopes.
-- Đảm bảo mỗi org ACTIVE có đúng một dòng ORGANIZATION để không ai bấm vào ô
-- rỗng. Đây là dòng phạm vi, KHÔNG phải cấp quyền cho ai.
INSERT INTO public.authorization_scopes (organization_id, scope_type)
SELECT o.id, 'ORGANIZATION'
FROM public.organizations o
WHERE o.status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1 FROM public.authorization_scopes s
    WHERE s.organization_id = o.id AND s.scope_type = 'ORGANIZATION');

-- ── 2. Quyền ký ─────────────────────────────────────────────────────
-- 'cashbooks.close_confirm' đã có trong permission_definitions từ
-- 20260730160000:49-51 (ELEVATED, scope_kinds={ORGANIZATION,CASHBOOK},
-- requires_cashbook_possession=false — người xác nhận theo định nghĩa CHƯA giữ
-- sổ). Ở đây chỉ nối vai trò mới vào khoá đã có.
INSERT INTO public.role_permissions (organization_id, role_id, permission_key, effect)
SELECT r.organization_id, r.id, 'cashbooks.close_confirm', 'ALLOW'
FROM public.organization_roles r
WHERE r.name = 'Kế toán' AND r.status = 'ACTIVE'
ON CONFLICT (organization_id, role_id, permission_key) DO NOTHING;

-- Kế toán cũng cần NHÌN được sổ để đối chiếu trước khi ký. Không cấp
-- cashbooks.close (vế đề nghị) — đó là việc của người đang giữ sổ.
INSERT INTO public.role_permissions (organization_id, role_id, permission_key, effect)
SELECT r.organization_id, r.id, 'cashbooks.view', 'ALLOW'
FROM public.organization_roles r
WHERE r.name = 'Kế toán' AND r.status = 'ACTIVE'
  AND EXISTS (SELECT 1 FROM public.permission_definitions pd
               WHERE pd.key = 'cashbooks.view' AND pd.is_active)
ON CONFLICT (organization_id, role_id, permission_key) DO NOTHING;

-- ── 3. ĐẾM LẠI VÀ BÁO — không fail ──────────────────────────────────
-- Khác 20260730160000:201-204 (hard-fail khi 0 sổ chốt được): ở đây "chưa gán
-- kế toán" là trạng thái HỢP LỆ ngày apply, vì migration cố ý không gán ai.
-- Nên chỉ RAISE NOTICE. Con số này để đối chiếu với panel FE ở Đợt D.
DO $assert$
DECLARE
  v_ok int := 0;
  v_bad int := 0;
  v_names text := '';
  bk record;
  a int; b int; c int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.permission_definitions pd
     WHERE pd.key = 'cashbooks.close_confirm'
       AND pd.permission_domain = 'TENANT' AND pd.is_active) THEN
    RAISE EXCEPTION
      'Thiếu khoá cashbooks.close_confirm — 20260730160000 chưa apply, authorize_tenant_action_v3 sẽ fail-closed';
  END IF;

  FOR bk IN
    SELECT ac.id, ac.name, ac.organization_id
    FROM public.accounts ac
    JOIN public.organizations org ON org.id = ac.organization_id AND org.status = 'ACTIVE'
    WHERE ac.deleted_at IS NULL AND NOT COALESCE(ac.is_virtual, false)
  LOOP
    SELECT count(*) FILTER (WHERE p_ok),
           count(*) FILTER (WHERE c_ok),
           count(*) FILTER (WHERE p_ok AND c_ok)
      INTO a, b, c
    FROM (
      SELECT
        COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
          m.user_id, bk.organization_id, 'cashbooks.close', NULL, bk.id)), false) AS p_ok,
        COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
          m.user_id, bk.organization_id, 'cashbooks.close_confirm', NULL, bk.id)), false) AS c_ok
      FROM public.organization_memberships m
      WHERE m.organization_id = bk.organization_id AND m.status = 'ACTIVE'
    ) x;

    IF a >= 1 AND b >= 1 AND NOT (a = 1 AND b = 1 AND c = 1) THEN
      v_ok := v_ok + 1;
    ELSE
      v_bad := v_bad + 1;
      v_names := v_names || ' · ' || bk.name;
    END IF;
  END LOOP;

  RAISE NOTICE 'Chốt sổ: %/% sổ đã đủ hai bên.', v_ok, v_ok + v_bad;
  IF v_bad > 0 THEN
    RAISE NOTICE
      '% sổ CHƯA chốt được vì thiếu người ký thứ hai — hãy gán một người vào vai trò "Kế toán" trong màn phân quyền:%',
      v_bad, v_names;
  END IF;
END
$assert$;

COMMIT;

COMMENT ON TABLE public.organization_roles IS
  'Vai trò theo tổ chức. Vai trò "Kế toán" (tạo 31/07/2026) chỉ mang cashbooks.close_confirm + cashbooks.view — nó là vế NHẬN của nghi thức chốt sổ, cố ý KHÔNG có cashbooks.close.';
