-- Finance V2 — Hotfix 7q: policy INSERT storage cho path chứng từ v2/ (E2E bắt).
--
-- create_finance_evidence_upload_intent_v2 cấp path 'v2/<org>/<membership>/<uuid>'
-- nhưng policy INSERT duy nhất của bucket (ie_attachments_insert) đòi segment đầu
-- = auth.uid() (scheme cũ) ⇒ MỌI user không-super-admin bị 403 khi upload chứng
-- từ ⇒ "Duyệt và Chi"/"Thu tiền vào sổ" chỉ owner chạy được. (Giả định "policy
-- hiện hữu cho phép" trong 20260723210000 là SAI.)
--
-- Policy mới CHẶT theo registry-intent: chỉ cho upload ĐÚNG object mà server đã
-- cấp intent cho CHÍNH uploader và intent còn mở (state UPLOAD_INTENT — sau
-- finalize không ghi đè được). Không nới scheme cũ, không đụng policy cũ.

BEGIN;

DROP POLICY IF EXISTS ie_attachments_insert_v2 ON storage.objects;
CREATE POLICY ie_attachments_insert_v2 ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'income-expense-attachments'
    AND (storage.foldername(name))[1] = 'v2'
    AND EXISTS (
      SELECT 1 FROM public.finance_evidence_objects e
      WHERE e.bucket_id = 'income-expense-attachments'
        AND e.object_name = name
        AND e.uploader_user_id = auth.uid()
        AND e.state = 'UPLOAD_INTENT'
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
