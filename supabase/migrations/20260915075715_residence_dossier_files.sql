-- Hồ sơ đăng ký tạm trú trên Cổng DVC Bộ Công an: ảnh CT01/hợp đồng đã ký theo
-- khách, giấy tờ chứng minh chỗ ở hợp pháp theo toà. Bucket riêng, private, đọc
-- qua signed URL; object chỉ đọc được khi người gọi đọc được dòng bảng tương ứng.
-- Quyền: CT01/LEASE theo customers.print (cùng cửa với in CT01), OWNERSHIP theo
-- buildings.edit. Idempotent.
INSERT INTO storage.buckets (id, name, public) VALUES ('residence-docs', 'residence-docs', false)
ON CONFLICT (id) DO UPDATE SET public = false;

CREATE TABLE IF NOT EXISTS public.residence_dossier_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  contract_id uuid REFERENCES public.contracts(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('CT01','LEASE','OWNERSHIP')),
  bucket_id text NOT NULL DEFAULT 'residence-docs' CHECK (bucket_id = 'residence-docs'),
  object_name text NOT NULL CHECK (length(object_name) BETWEEN 3 AND 500 AND object_name NOT LIKE '%..%'),
  file_name text NOT NULL DEFAULT '' CHECK (length(file_name) <= 255),
  content_type text NOT NULL DEFAULT '' CHECK (length(content_type) <= 100),
  size_bytes integer NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT residence_dossier_files_kind_target CHECK (
    (kind = 'OWNERSHIP' AND customer_id IS NULL) OR (kind IN ('CT01','LEASE') AND customer_id IS NOT NULL)),
  CONSTRAINT residence_dossier_files_object_unique UNIQUE (bucket_id, object_name)
);
CREATE INDEX IF NOT EXISTS residence_dossier_files_customer
  ON public.residence_dossier_files (customer_id, kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS residence_dossier_files_building
  ON public.residence_dossier_files (building_id, kind) WHERE deleted_at IS NULL;
ALTER TABLE public.residence_dossier_files ENABLE ROW LEVEL SECURITY;

-- Đọc: thấy toà + (in hồ sơ/CT01 hoặc sửa toà). Super admin không thấy org sandbox.
CREATE OR REPLACE FUNCTION app_private.residence_dossier_can_read_v1(p_building_id uuid, p_organization_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT auth.uid() IS NOT NULL
    AND NOT ((SELECT public.is_super_admin()) AND COALESCE(p_organization_id = ANY(public.sandbox_org_ids()), false))
    AND EXISTS (SELECT 1 FROM public.buildings b WHERE b.id = p_building_id
      AND b.organization_id = p_organization_id AND b.deleted_at IS NULL
      AND public.can_access_building(b.id)
      AND (public.can_do_on_building('customers','print',b.id) OR public.can_do_on_building('buildings','edit',b.id)));
$$;
REVOKE ALL ON FUNCTION app_private.residence_dossier_can_read_v1(uuid,uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION app_private.residence_dossier_can_read_v1(uuid,uuid) TO authenticated;

-- Ghi: CT01/LEASE cần customers.print và khách cùng org; OWNERSHIP cần buildings.edit.
CREATE OR REPLACE FUNCTION app_private.residence_dossier_can_write_v1(
  p_kind text, p_building_id uuid, p_organization_id uuid, p_customer_id uuid, p_contract_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT auth.uid() IS NOT NULL
    AND NOT ((SELECT public.is_super_admin()) AND COALESCE(p_organization_id = ANY(public.sandbox_org_ids()), false))
    AND EXISTS (SELECT 1 FROM public.buildings b WHERE b.id = p_building_id
      AND b.organization_id = p_organization_id AND b.deleted_at IS NULL
      AND public.can_access_building(b.id)
      AND CASE WHEN p_kind = 'OWNERSHIP' THEN public.can_do_on_building('buildings','edit',b.id)
               ELSE public.can_do_on_building('customers','print',b.id) END)
    AND (p_kind = 'OWNERSHIP' OR EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer_id
      AND c.organization_id = p_organization_id AND c.deleted_at IS NULL))
    AND (p_contract_id IS NULL OR EXISTS (SELECT 1 FROM public.contracts ct WHERE ct.id = p_contract_id
      AND ct.organization_id = p_organization_id AND ct.deleted_at IS NULL));
$$;
REVOKE ALL ON FUNCTION app_private.residence_dossier_can_write_v1(text,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION app_private.residence_dossier_can_write_v1(text,uuid,uuid,uuid,uuid) TO authenticated;

DROP POLICY IF EXISTS residence_dossier_files_select ON public.residence_dossier_files;
CREATE POLICY residence_dossier_files_select ON public.residence_dossier_files FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND app_private.residence_dossier_can_read_v1(building_id, organization_id));
DROP POLICY IF EXISTS residence_dossier_files_insert ON public.residence_dossier_files;
CREATE POLICY residence_dossier_files_insert ON public.residence_dossier_files FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND deleted_at IS NULL
    AND object_name LIKE auth.uid()::text || '/%'
    AND app_private.residence_dossier_can_write_v1(kind, building_id, organization_id, customer_id, contract_id));
DROP POLICY IF EXISTS residence_dossier_files_update ON public.residence_dossier_files;
CREATE POLICY residence_dossier_files_update ON public.residence_dossier_files FOR UPDATE TO authenticated
  USING (deleted_at IS NULL AND app_private.residence_dossier_can_write_v1(kind, building_id, organization_id, customer_id, contract_id))
  WITH CHECK (app_private.residence_dossier_can_write_v1(kind, building_id, organization_id, customer_id, contract_id));
DROP POLICY IF EXISTS residence_dossier_files_hide_sandbox_admin ON public.residence_dossier_files;
CREATE POLICY residence_dossier_files_hide_sandbox_admin ON public.residence_dossier_files AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT ((SELECT public.is_super_admin()) AND COALESCE(organization_id = ANY(public.sandbox_org_ids()), false)));
REVOKE ALL ON public.residence_dossier_files FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.residence_dossier_files TO authenticated;

-- Storage: ghi vào thư mục của chính mình; đọc khi có dòng bảng đọc được; xoá object của mình.
CREATE OR REPLACE FUNCTION app_private.residence_doc_object_can_read_v1(p_bucket text, p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app_private AS $$
  SELECT p_bucket = 'residence-docs' AND EXISTS (SELECT 1 FROM public.residence_dossier_files f
    WHERE f.bucket_id = p_bucket AND f.object_name = p_name AND f.deleted_at IS NULL
      AND app_private.residence_dossier_can_read_v1(f.building_id, f.organization_id));
$$;
REVOKE ALL ON FUNCTION app_private.residence_doc_object_can_read_v1(text,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION app_private.residence_doc_object_can_read_v1(text,text) TO authenticated;
DROP POLICY IF EXISTS residence_docs_insert ON storage.objects;
CREATE POLICY residence_docs_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'residence-docs' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS residence_docs_select ON storage.objects;
CREATE POLICY residence_docs_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'residence-docs' AND app_private.residence_doc_object_can_read_v1(bucket_id, name));
DROP POLICY IF EXISTS residence_docs_delete ON storage.objects;
CREATE POLICY residence_docs_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'residence-docs' AND (storage.foldername(name))[1] = auth.uid()::text);
