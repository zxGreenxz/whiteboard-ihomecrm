-- Finance V2 — Hotfix 7r: policy upload 7q cần đọc registry nhưng registry kín.
--
-- finance_evidence_objects: RLS bật, KHÔNG policy + KHÔNG grant cho authenticated
-- ⇒ EXISTS trong ie_attachments_insert_v2 (7q) chạy dưới quyền user luôn thất bại
-- ⇒ upload vẫn 403. Cấp tối thiểu: SELECT own-rows (uploader = auth.uid()) —
-- đủ cho policy storage đối chiếu intent; không lộ chứng từ người khác.

BEGIN;

GRANT SELECT ON public.finance_evidence_objects TO authenticated;

DROP POLICY IF EXISTS fev_select_own ON public.finance_evidence_objects;
CREATE POLICY fev_select_own ON public.finance_evidence_objects
  FOR SELECT TO authenticated
  USING (uploader_user_id = auth.uid());

COMMIT;

NOTIFY pgrst, 'reload schema';
