-- Sổ theo dõi hồ sơ Đăng ký tạm trú đã nộp trên Cổng DVC Bộ Công an.
--
-- VÌ SAO: nộp xong thì mã hồ sơ chỉ nằm trên cổng, muốn biết khách nào đã đăng ký
-- phải mở cổng dò từng mã. Extension đọc mã ngay trong gói `add_subm_info_v2` mà
-- cổng gửi đi (khoá SUBM_CODE, kèm is_send='1' để phân biệt với Lưu nháp) rồi
-- chuyển về CRM lưu vào đây, nên chi tiết khách hiện luôn "đã đăng ký · mã · hạn".
--
-- Quyền đọc/ghi đi cùng cửa với ảnh hồ sơ tạm trú: customers.print trên toà đó
-- (app_private.residence_dossier_can_read_v1 / _can_write_v1 đã có sẵn). Idempotent.
CREATE TABLE IF NOT EXISTS public.residence_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  contract_id uuid REFERENCES public.contracts(id) ON DELETE SET NULL,
  -- Mã hồ sơ cổng cấp, ví dụ G01.899.909-260916-890012.
  subm_code text NOT NULL CHECK (length(subm_code) BETWEEN 3 AND 100),
  -- Cơ quan tiếp nhận, để tra cứu lại không phải mở cổng.
  receive_org text NOT NULL DEFAULT '' CHECK (length(receive_org) <= 200),
  temp_resident_from date,
  temp_resident_to date,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT residence_registrations_term_order CHECK (
    temp_resident_from IS NULL OR temp_resident_to IS NULL OR temp_resident_to > temp_resident_from)
);
-- Nộp lại cùng một mã (extension gửi trùng, người dùng mở lại tab) không đẻ dòng mới.
CREATE UNIQUE INDEX IF NOT EXISTS residence_registrations_code_unique
  ON public.residence_registrations (organization_id, subm_code);
CREATE INDEX IF NOT EXISTS residence_registrations_customer
  ON public.residence_registrations (customer_id, submitted_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE public.residence_registrations ENABLE ROW LEVEL SECURITY;

-- SELECT không lọc deleted_at: PostgreSQL áp USING của policy SELECT lên cả DÒNG MỚI
-- khi UPDATE có WHERE, nên lọc ở đây làm xoá mềm nổ 42501 (án lệ 20260915083709).
DROP POLICY IF EXISTS residence_registrations_select ON public.residence_registrations;
CREATE POLICY residence_registrations_select ON public.residence_registrations FOR SELECT TO authenticated
  USING (app_private.residence_dossier_can_read_v1(building_id, organization_id));

DROP POLICY IF EXISTS residence_registrations_insert ON public.residence_registrations;
CREATE POLICY residence_registrations_insert ON public.residence_registrations FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND deleted_at IS NULL
    AND app_private.residence_dossier_can_write_v1('CT01', building_id, organization_id, customer_id, contract_id));

DROP POLICY IF EXISTS residence_registrations_update ON public.residence_registrations;
CREATE POLICY residence_registrations_update ON public.residence_registrations FOR UPDATE TO authenticated
  USING (app_private.residence_dossier_can_write_v1('CT01', building_id, organization_id, customer_id, contract_id))
  WITH CHECK (app_private.residence_dossier_can_write_v1('CT01', building_id, organization_id, customer_id, contract_id));

DROP POLICY IF EXISTS residence_registrations_hide_sandbox_admin ON public.residence_registrations;
CREATE POLICY residence_registrations_hide_sandbox_admin ON public.residence_registrations AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT ((SELECT public.is_super_admin()) AND COALESCE(organization_id = ANY(public.sandbox_org_ids()), false)))
  WITH CHECK (NOT ((SELECT public.is_super_admin()) AND COALESCE(organization_id = ANY(public.sandbox_org_ids()), false)));

COMMENT ON TABLE public.residence_registrations IS
  'Hồ sơ Đăng ký tạm trú đã nộp trên Cổng DVC: mã hồ sơ do extension iHome Tạm trú đọc được lúc nộp.';
COMMENT ON COLUMN public.residence_registrations.subm_code IS
  'Mã hồ sơ cổng cấp (SUBM_CODE trong gói add_subm_info_v2), dùng tra cứu trên dichvucong.dancuquocgia.gov.vn.';
