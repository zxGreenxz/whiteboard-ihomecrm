-- ============================================================
-- Tên thường gọi của toà — bảng dùng chung, mỗi dòng một cách gọi.
--
-- Mã toà là "số nhà + chữ đầu tên đường" (102LVT, 417LVT, 1392QT) và phần lớn
-- toà có tên = mã (đo trên dữ liệu 02/10/2026: 18/19 toà không có tên đường
-- trong `name`). Người dùng lại NÓI tên đường: "một lẻ hai Lê Văn Thọ". Không
-- có nơi nào ghi "LVT = Lê Văn Thọ" nên máy không nhận ra được. Bảng này giữ
-- những cách gọi đó:
--   - trang Báo chi nhanh (src/lib/quickEntry/spokenBuilding.ts) dò cả các tên
--     này khi đọc câu chép từ giọng nói;
--   - hàm edge quick-entry gửi chúng làm cụm từ ưu tiên cho máy chép giọng.
--
-- Quyền:
--   - đọc  = ai xem được toà (`can_access_building`) — đúng phạm vi toà mà
--     người đó vẫn thấy ở mọi màn hình khác;
--   - thêm / xoá = ai xem được VÀ được sửa toà (`buildings.edit`, cùng khoá
--     với policy buildings_update_rbac). Không có UPDATE: đổi tên = xoá + thêm.
--   - organization_id tự điền theo toà (public._autofill_org, dùng chung với
--     các bảng khác) và policy thêm bắt nó bằng đúng org của toà — người thuộc
--     hai công ty không gắn được tên cho toà của công ty này dưới org kia.
--   - RESTRICTIVE *_org_boundary và *_hide_sandbox_admin theo Contract §2.
--
-- Idempotent: IF NOT EXISTS, DROP … IF EXISTS rồi CREATE; khối kiểm cuối chỉ
-- đọc catalog nên chạy được trên database rỗng (Restore Drill).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.building_common_names (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  building_id     uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  name            text NOT NULL,
  created_by      uuid DEFAULT auth.uid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- 100 ký tự = trần một cụm từ của máy chép giọng (Google speech adaptation).
  CONSTRAINT building_common_names_name_check
    CHECK (name = btrim(name) AND char_length(name) BETWEEN 2 AND 100 AND name !~ '[[:cntrl:]]')
);

COMMENT ON TABLE public.building_common_names IS
  'Tên thường gọi của toà ("Lê Văn Thọ", "một lẻ hai Lê Văn Thọ") — Báo chi nhanh dò khi đọc câu nói và gửi làm cụm từ ưu tiên cho máy chép giọng.';

CREATE UNIQUE INDEX IF NOT EXISTS building_common_names_building_name_uidx
  ON public.building_common_names (building_id, lower(name));
CREATE INDEX IF NOT EXISTS building_common_names_org_idx
  ON public.building_common_names (organization_id);

DROP TRIGGER IF EXISTS trg_autofill_org ON public.building_common_names;
CREATE TRIGGER trg_autofill_org
  BEFORE INSERT ON public.building_common_names
  FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

ALTER TABLE public.building_common_names ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.building_common_names FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.building_common_names TO authenticated;

DROP POLICY IF EXISTS building_common_names_select ON public.building_common_names;
CREATE POLICY building_common_names_select ON public.building_common_names
  FOR SELECT TO authenticated
  USING (public.can_access_building(building_id));

DROP POLICY IF EXISTS building_common_names_insert ON public.building_common_names;
CREATE POLICY building_common_names_insert ON public.building_common_names
  FOR INSERT TO authenticated
  WITH CHECK (
    public.can_access_building(building_id)
    AND app_private.can_v3('buildings.edit', building_id)
    AND organization_id = (SELECT b.organization_id FROM public.buildings b WHERE b.id = building_id AND b.deleted_at IS NULL)
  );

DROP POLICY IF EXISTS building_common_names_delete ON public.building_common_names;
CREATE POLICY building_common_names_delete ON public.building_common_names
  FOR DELETE TO authenticated
  USING (public.can_access_building(building_id) AND app_private.can_v3('buildings.edit', building_id));

DROP POLICY IF EXISTS building_common_names_org_boundary ON public.building_common_names;
CREATE POLICY building_common_names_org_boundary ON public.building_common_names
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));

DROP POLICY IF EXISTS building_common_names_hide_sandbox_admin ON public.building_common_names;
CREATE POLICY building_common_names_hide_sandbox_admin ON public.building_common_names
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT ((SELECT public.is_super_admin()) AND COALESCE(organization_id = ANY (public.sandbox_org_ids()), false)));

-- Kiểm bằng catalog (không cần dữ liệu): RLS bật, đủ 5 policy, trigger gắn đúng hàm,
-- anon/service_role không có quyền nào, authenticated không có UPDATE.
DO $kiem$
DECLARE
  v_rel oid := 'public.building_common_names'::regclass;
  v_policies integer;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel) THEN
    RAISE EXCEPTION 'building_common_names: RLS chưa bật';
  END IF;

  SELECT count(*) INTO v_policies
  FROM pg_policy
  WHERE polrelid = v_rel
    AND polname IN ('building_common_names_select', 'building_common_names_insert', 'building_common_names_delete',
                    'building_common_names_org_boundary', 'building_common_names_hide_sandbox_admin');
  IF v_policies <> 5 THEN
    RAISE EXCEPTION 'building_common_names: có % / 5 policy', v_policies;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_rel AND polpermissive
               AND polname IN ('building_common_names_org_boundary', 'building_common_names_hide_sandbox_admin')) THEN
    RAISE EXCEPTION 'building_common_names: policy biên giới phải là RESTRICTIVE';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_rel AND tgname = 'trg_autofill_org'
                   AND tgfoid = 'public._autofill_org()'::regprocedure AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'building_common_names: thiếu trigger tự điền organization_id';
  END IF;

  IF has_table_privilege('anon', v_rel, 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('service_role', v_rel, 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', v_rel, 'UPDATE')
     OR NOT has_table_privilege('authenticated', v_rel, 'SELECT')
     OR NOT has_table_privilege('authenticated', v_rel, 'INSERT')
     OR NOT has_table_privilege('authenticated', v_rel, 'DELETE') THEN
    RAISE EXCEPTION 'building_common_names: quyền bảng lệch (anon/service_role phải không có gì; authenticated SELECT/INSERT/DELETE, không UPDATE)';
  END IF;
END
$kiem$;
