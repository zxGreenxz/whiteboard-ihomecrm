-- fix_notifications_org_null_single_membership_v1
-- Vì sao: gate measure-org-leak (CI Gates · security-gates) đỏ 04/09/2026 vì
-- MỘT dòng public.notifications có organization_id NULL: digest V5 "Tuyến hôm nay"
-- (metadata.v5='digest', channel IN_APP) do cron sinh cho user_id
-- 90450d5f-… ngay sau khi tài khoản hệ thống được seed làm thành viên ACTIVE của
-- org DEMO (20260903220254). Đường sinh digest không điền organization_id.
-- Cách vá: dữ liệu — gán organization_id cho mọi notification NULL mà chủ nhân
-- có ĐÚNG MỘT membership ACTIVE (không suy đoán khi mơ hồ). Idempotent, DML thuần,
-- DB rỗng chạy được (0 dòng). Gốc rễ (cron digest thiếu org) ghi ở
-- tooling/known-gaps.yaml: notifications-digest-org-null.
BEGIN;
SET LOCAL lock_timeout = '15s';

UPDATE public.notifications n
   SET organization_id = m.organization_id
  FROM (
    SELECT om.user_id, (array_agg(om.organization_id))[1] AS organization_id
      FROM public.organization_memberships om
     WHERE om.status = 'ACTIVE'
     GROUP BY om.user_id
    HAVING COUNT(*) = 1
  ) m
 WHERE n.organization_id IS NULL
   AND n.user_id = m.user_id;

DO $nghiem_thu$
DECLARE v_con int;
BEGIN
  SELECT COUNT(*) INTO v_con
    FROM public.notifications n
   WHERE n.organization_id IS NULL
     AND EXISTS (SELECT 1 FROM public.organization_memberships om
                  WHERE om.user_id = n.user_id AND om.status = 'ACTIVE'
                  GROUP BY om.user_id HAVING COUNT(*) = 1);
  IF v_con > 0 THEN
    RAISE EXCEPTION 'fix_notifications_org_null: còn % dòng NULL có thể gán', v_con;
  END IF;
  RAISE NOTICE 'fix_notifications_org_null: OK';
END
$nghiem_thu$;

COMMIT;
