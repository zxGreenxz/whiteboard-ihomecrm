-- Sửa policy SELECT của residence_dossier_files: bỏ điều kiện deleted_at IS NULL.
-- Lý do (đo thật 15/09/2026 bằng harness JWT trong ROLLBACK): PostgreSQL áp USING của
-- policy SELECT lên cả DÒNG MỚI khi UPDATE có WHERE, nên xoá mềm (SET deleted_at)
-- bị "new row violates row-level security policy" 42501. Client luôn lọc
-- deleted_at IS NULL; object trong bucket vẫn chỉ đọc được khi dòng chưa xoá
-- (app_private.residence_doc_object_can_read_v1). Idempotent.
DROP POLICY IF EXISTS residence_dossier_files_select ON public.residence_dossier_files;
CREATE POLICY residence_dossier_files_select ON public.residence_dossier_files FOR SELECT TO authenticated
  USING (app_private.residence_dossier_can_read_v1(building_id, organization_id));
