-- =============================================================================
-- Tạo bucket 'avatars' cho ảnh đại diện người dùng — vá finding C-01 của
-- docs/audits/AUDIT-DB-BANG-MO-COI-VA-PHAN-CHUA-HOAT-DONG-2026-09-02.md.
--
-- VÌ SAO: src/hooks/useProfile.ts upload vào bucket 'avatars' từ lâu nhưng
-- bucket CHƯA TỪNG tồn tại trên production (đo storage.buckets 02/09/2026) —
-- tính năng đổi ảnh đại diện chết 100% ngay tại upload.
--
-- VÌ SAO PUBLIC (đi ngược hướng 20260601000200_sec_private_buckets — CÓ CHỦ Ý):
-- 7 bucket bị đóng private hồi 01/06 đều chứa dữ liệu nhạy cảm (CCCD, biên lai,
-- chứng từ). Ảnh đại diện là ảnh người dùng TỰ CHỌN để hiển thị cho đồng nghiệp
-- (Header/Sidebar/danh sách), code hiện hành lưu publicUrl thẳng vào
-- profiles.avatar_url và <img src> — private hoá sẽ đòi viết lại toàn bộ chỗ
-- hiển thị sang signed URL mà không thêm an toàn thực chất. Path vẫn khoá theo
-- auth.uid() nên chỉ chủ tài khoản ghi/sửa/xoá được ảnh của mình.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('avatars', 'avatars', true, 5242880)
ON CONFLICT (id) DO UPDATE
  SET public = true, file_size_limit = excluded.file_size_limit;

-- Đọc: công khai (bucket public phục vụ qua CDN; policy SELECT cho đường API).
DROP POLICY IF EXISTS "avatars doc cong khai" ON storage.objects;
CREATE POLICY "avatars doc cong khai"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

-- Ghi/sửa/xoá: chỉ chủ tài khoản, path bắt buộc <auth.uid()>/<file>
-- (khớp useProfile.ts: `${user.id}/avatar.${ext}`).
DROP POLICY IF EXISTS "avatars ghi theo chu tai khoan" ON storage.objects;
CREATE POLICY "avatars ghi theo chu tai khoan"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "avatars sua theo chu tai khoan" ON storage.objects;
CREATE POLICY "avatars sua theo chu tai khoan"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "avatars xoa theo chu tai khoan" ON storage.objects;
CREATE POLICY "avatars xoa theo chu tai khoan"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Nghiệm thu: bucket đúng cờ + đủ 4 policy, sai là DỪNG cả file.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'avatars' AND public = true
  ) THEN
    RAISE EXCEPTION 'Bucket avatars chưa tồn tại hoặc không public. DỪNG.';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname IN (
           'avatars doc cong khai',
           'avatars ghi theo chu tai khoan',
           'avatars sua theo chu tai khoan',
           'avatars xoa theo chu tai khoan')) <> 4 THEN
    RAISE EXCEPTION 'Thiếu policy storage cho avatars. DỪNG.';
  END IF;
END $$;
