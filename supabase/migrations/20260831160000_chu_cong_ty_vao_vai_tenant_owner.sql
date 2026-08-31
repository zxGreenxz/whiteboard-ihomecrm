-- =====================================================================
-- P1-02 (audit /thanh-toan 31/08, user duyệt "sửa toàn bộ"): mở đặc quyền
-- CHỦ TỔ CHỨC cho chủ công ty thật của org iHome — bằng cách GẮN BINDING vào
-- vai TENANT_OWNER sẵn có, KHÔNG đổi system_key của vai nào.
--
-- BẰNG CHỨNG ĐO TRƯỚC KHI SỬA (SQL read-only 31/08 → 01/09):
--   • user 0520169e-0860-4b4e-a603-675c8aa245aa (chủ công ty thật):
--       organization_memberships.member_type = 'OWNER'
--       vai đang giữ = 'Chủ công ty' (5af8986f…, system_key NULL)
--       app_private.is_org_owner_v1(org, uid) = FALSE
--     ⇒ pay_period_fee trả can_force=false — CHÍNH CHỦ bị khoá "Đóng thêm";
--     chỉ super admin (tài khoản hệ thống IT) bấm được.
--   • Vai TENANT_OWNER của org là 'Chủ sở hữu tổ chức' (c2d3b599…, is_system,
--     ACTIVE), hiện 1 binding → nguyentamca165@gmail.com (tài khoản HỆ THỐNG).
--
-- VÌ SAO LÀ BINDING CHỨ KHÔNG PHẢI ĐỔI KEY (đường đi đã thử và bị chặn ĐÚNG):
--   Phương án "gắn TENANT_OWNER thêm cho vai Chủ công ty" bị unique index
--   organization_roles_system_key_uidx từ chối (23505) — schema CHỐT mỗi org
--   đúng MỘT vai cho mỗi system_key. Di dời key khỏi vai IT thì đụng một tài
--   khoản đang vận hành tự động — ngoài phạm vi fix này. Còn lại đúng một
--   đường thuận thiết kế: người chủ thật NHẬN THÊM binding vào vai chủ sẵn có.
--   is_org_owner_v1 nhận "có binding còn hiệu lực tới vai TENANT_OWNER" nên
--   binding là đủ; vai 'Chủ công ty' (231 quyền TENANT) giữ nguyên làm nguồn
--   quyền nghiệp vụ hằng ngày.
--
-- ĐƯỜNG LÙI: DELETE đúng binding mở (org, membership, role) vừa thêm — một câu
-- lệnh, không mất dữ liệu, không đụng vai/membership nào khác.
-- =====================================================================
BEGIN;

DO $fix$
DECLARE
  v_org   uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_uid   uuid := '0520169e-0860-4b4e-a603-675c8aa245aa';
  v_role  uuid;
  v_mem   uuid;
  v_cnt   int;
BEGIN
  -- Preflight 0: schema đúng hình.
  IF to_regclass('public.role_bindings') IS NULL OR to_regclass('public.organization_roles') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng role_bindings/organization_roles. DỪNG.';
  END IF;
  IF to_regprocedure('app_private.is_org_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.is_org_owner_v1(uuid,uuid). DỪNG.';
  END IF;

  -- Preflight 1: vai TENANT_OWNER của org — uidx bảo đảm tối đa 1, đòi đúng 1.
  SELECT count(*) INTO v_cnt FROM organization_roles
   WHERE organization_id = v_org AND system_key = 'TENANT_OWNER' AND status = 'ACTIVE';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Org % có % vai TENANT_OWNER ACTIVE (kỳ vọng 1). DỪNG — soi tay.', v_org, v_cnt;
  END IF;
  SELECT id INTO v_role FROM organization_roles
   WHERE organization_id = v_org AND system_key = 'TENANT_OWNER' AND status = 'ACTIVE'
   LIMIT 1;

  -- Preflight 2: membership ACTIVE duy nhất của chủ trong org.
  SELECT count(*) INTO v_cnt FROM organization_memberships
   WHERE organization_id = v_org AND user_id = v_uid AND status = 'ACTIVE';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'User % có % membership ACTIVE trong org % (kỳ vọng 1). DỪNG.', v_uid, v_cnt, v_org;
  END IF;
  SELECT id INTO v_mem FROM organization_memberships
   WHERE organization_id = v_org AND user_id = v_uid AND status = 'ACTIVE'
   LIMIT 1;

  -- Data-fix (idempotent: binding mở đã có thì thôi — khớp partial uidx
  -- role_bindings_one_open_canonical_role_uidx).
  INSERT INTO role_bindings (organization_id, membership_id, role_id)
  SELECT v_org, v_mem, v_role
   WHERE NOT EXISTS (
     SELECT 1 FROM role_bindings rb
      WHERE rb.organization_id = v_org AND rb.membership_id = v_mem AND rb.role_id = v_role
        AND rb.legacy_assignment_id IS NULL AND rb.valid_to IS NULL
   );

  -- Selfcheck 1: binding mở tồn tại.
  IF NOT EXISTS (
    SELECT 1 FROM role_bindings rb
     WHERE rb.organization_id = v_org AND rb.membership_id = v_mem AND rb.role_id = v_role
       AND rb.valid_to IS NULL
  ) THEN
    RAISE EXCEPTION 'Binding chủ công ty → vai TENANT_OWNER chưa tồn tại sau INSERT. DỪNG.';
  END IF;

  -- Selfcheck 2: vai 'Chủ công ty' KHÔNG bị đụng (vẫn system_key NULL — nguồn
  -- quyền nghiệp vụ giữ nguyên, không ai "thăng cấp" nhầm nó).
  IF EXISTS (
    SELECT 1 FROM organization_roles
     WHERE organization_id = v_org AND name = 'Chủ công ty' AND system_key IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Vai "Chủ công ty" bị đổi system_key — fix này không được đụng nó. DỪNG.';
  END IF;

  -- Selfcheck 3: chính chủ giờ lọt cửa chủ — đúng số đo đã trình user.
  IF NOT app_private.is_org_owner_v1(v_org, v_uid) THEN
    RAISE EXCEPTION 'is_org_owner_v1(%, %) vẫn FALSE sau khi thêm binding. DỪNG.', v_org, v_uid;
  END IF;
END
$fix$;

COMMIT;
