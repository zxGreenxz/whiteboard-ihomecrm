-- Nối tiếp 20261010141134 (đã áp production 10/10/2026): bỏ NOT NULL của
-- public_room_settings.organization_id, giữ trigger trg_public_room_settings_fill_org làm bảo đảm.
-- Lý do: cột NOT NULL không default làm generated types bắt client gửi organization_id khi upsert,
-- mà client không biết đúng tổ chức (owner thuộc nhiều tổ chức; gửi tổ chức đang chọn sẽ ghi đè
-- tổ chức của dòng có sẵn qua ON CONFLICT DO UPDATE, và tổ chức sandbox thì policy
-- hide_sandbox_admin che mất dòng). Trigger BEFORE INSERT OR UPDATE vẫn điền hoặc ném 23502, nên
-- không dòng mới/sửa nào giữ được organization_id NULL. Không ghi dữ liệu.

ALTER TABLE public.public_room_settings ALTER COLUMN organization_id DROP NOT NULL;

DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.public_room_settings'::regclass
                  AND tgname='trg_public_room_settings_fill_org' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Thiếu trigger điền tổ chức: không được bỏ NOT NULL khi chưa có bảo đảm khác';
  END IF;
  IF EXISTS (SELECT 1 FROM public.public_room_settings WHERE organization_id IS NULL) THEN
    RAISE EXCEPTION 'Còn dòng public_room_settings thiếu organization_id';
  END IF;
END
$assert$;
