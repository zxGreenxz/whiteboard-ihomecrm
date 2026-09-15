-- job_types: gắn nhãn tổ chức khi tạo, và dán nhãn cho các dòng đã lỡ để trống.
--
-- VÌ SAO
--   `useCreateJobType` (và mọi đường tạo khác) không gửi organization_id, còn bảng
--   không có default lẫn trigger ⇒ loại công việc tạo từ giao diện nằm NULL. Công
--   thức biên giới của repo có nhánh `organization_id IS NULL` (20260808020000 ghi
--   rõ: giữ nhánh đó tới khi backfill xong), nên dòng NULL HIỆN RA CHO MỌI TỔ CHỨC.
--   Đo trên production 15/09/2026: 2 dòng ("vệ", "giặt") do joey@username.ihomecrm.local
--   tạo lúc 12:49–12:50 UTC, đang được 2 phiếu việc của chính org aaaa dùng.
--   `measure-org-leak` bắt đúng việc này và làm CI đỏ.
--
-- CÁCH CHỮA
--   1. Trigger stamp org từ membership DUY NHẤT của người tạo — vá mọi đường ghi
--      (giao diện, Copilot, script) chứ không chỉ một hook. Người thuộc nhiều tổ
--      chức (hiện chỉ 1 tài khoản, là super admin) phải truyền tường minh; trigger
--      không đoán hộ.
--   2. Backfill theo chính membership của người tạo, không chép cứng id tổ chức.
--
-- Không đụng bảng khác: đo cùng lúc, income_expense_types / job_groups / materials /
-- sla_configs / document_templates đều 0 dòng NULL. Idempotent.
CREATE OR REPLACE FUNCTION public.set_organization_id_from_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_orgs uuid[];
BEGIN
  IF NEW.organization_id IS NOT NULL OR auth.uid() IS NULL THEN RETURN NEW; END IF;
  SELECT array_agg(DISTINCT m.organization_id) INTO v_orgs
    FROM public.organization_memberships m
   WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
     AND (m.valid_to IS NULL OR m.valid_to > now());
  -- Đúng một tổ chức thì mới dán; nhiều hơn là mơ hồ, để NULL còn hơn dán sai.
  IF array_length(v_orgs, 1) = 1 THEN NEW.organization_id := v_orgs[1]; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.set_organization_id_from_membership() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS job_types_set_organization_id ON public.job_types;
CREATE TRIGGER job_types_set_organization_id BEFORE INSERT ON public.job_types
  FOR EACH ROW EXECUTE FUNCTION public.set_organization_id_from_membership();

UPDATE public.job_types jt
   SET organization_id = s.org
  FROM (SELECT m.user_id, (array_agg(DISTINCT m.organization_id))[1] AS org
          FROM public.organization_memberships m
         WHERE m.status = 'ACTIVE'
           AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
           AND (m.valid_to IS NULL OR m.valid_to > now())
         GROUP BY m.user_id
        HAVING count(DISTINCT m.organization_id) = 1) s
 WHERE jt.organization_id IS NULL AND jt.user_id = s.user_id;

DO $bao_cao$
DECLARE v_con int;
BEGIN
  SELECT count(*) INTO v_con FROM public.job_types WHERE organization_id IS NULL;
  IF v_con > 0 THEN
    -- Không RAISE: dòng của người nhiều tổ chức phải do người quyết, không đoán.
    RAISE WARNING 'job_types còn % dòng chưa có tổ chức (người tạo thuộc nhiều tổ chức hoặc không còn membership).', v_con;
  END IF;
END $bao_cao$;
