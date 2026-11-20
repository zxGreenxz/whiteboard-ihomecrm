-- Room sale uploads accept MP4 up to 32 MiB. Keep org-scoped storage and
-- existing file validation, and allow the worker to stage the same original.
UPDATE storage.buckets SET file_size_limit=33554432
WHERE id='zalo-media' AND file_size_limit=26214400;
DO $fn$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='zalo-media' AND (file_size_limit IS NULL OR file_size_limit>=33554432)) THEN
    RAISE EXCEPTION 'Expected the existing zalo-media bucket to support 32 MiB room videos';
  END IF;
END $fn$;
