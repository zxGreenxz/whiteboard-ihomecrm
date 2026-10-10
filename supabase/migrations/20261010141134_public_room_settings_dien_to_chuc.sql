-- public_room_settings luôn mang organization_id (chủ chốt 10/10/2026).
-- Nguồn lỗi: useUpsertPublicRoomSettings upsert theo owner_id mà không gửi organization_id, bảng không có
-- trigger điền org, và policy org_boundary cho qua organization_id NULL ⇒ dòng cài đặt mới (tạo khi lưu
-- chính sách sale 10/10) mang org rỗng; measure-org-leak (security-gates) đỏ, chặn promote.
-- Không dùng app_private.autofill_org_strict: nó suy theo người chỉ khi người đó thuộc đúng MỘT tổ chức,
-- và BEFORE INSERT vẫn chạy với upsert ON CONFLICT ⇒ chủ thuộc 2 tổ chức (có thật trên production) sẽ
-- không lưu được cài đặt. Ở đây suy theo thứ tự tin cậy:
--   (1) dòng cài đặt sẵn có của chính chủ đó (upsert cập nhật giữ nguyên tổ chức);
--   (2) tổ chức DUY NHẤT của các toà chủ sở hữu, trong số tổ chức chủ đang là thành viên ACTIVE —
--       reader phòng trống cũng phân theo b.user_id = chủ;
--   (3) tổ chức ACTIVE DUY NHẤT của người đó.
-- Không suy được ⇒ 23502 (fail-closed, không đoán bừa). Điền org cho dòng thiếu rồi chốt NOT NULL.

CREATE OR REPLACE FUNCTION app_private.public_room_settings_org_v1(p_owner uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
DECLARE v_org uuid; v_n integer;
BEGIN
  SELECT s.organization_id INTO v_org FROM public.public_room_settings s
   WHERE s.owner_id=p_owner AND s.organization_id IS NOT NULL;
  IF v_org IS NOT NULL THEN RETURN v_org; END IF;
  -- Chỉ tính toà ở tổ chức chủ đang là thành viên ACTIVE: gán org ngoài my_org_ids() thì policy
  -- org_boundary chặn chính chủ đọc/sửa dòng của mình.
  SELECT (array_agg(DISTINCT b.organization_id))[1], count(DISTINCT b.organization_id) INTO v_org, v_n
    FROM public.buildings b
   WHERE b.user_id=p_owner AND b.deleted_at IS NULL AND b.organization_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.organization_memberships m
                  WHERE m.user_id=p_owner AND m.status='ACTIVE' AND m.organization_id=b.organization_id);
  IF v_n=1 THEN RETURN v_org; END IF;
  SELECT (array_agg(DISTINCT m.organization_id))[1], count(DISTINCT m.organization_id) INTO v_org, v_n
    FROM public.organization_memberships m
   WHERE m.user_id=p_owner AND m.status='ACTIVE';
  IF v_n=1 THEN RETURN v_org; END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.public_room_settings_org_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.public_room_settings_fill_org_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
BEGIN
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := app_private.public_room_settings_org_v1(NEW.owner_id);
    IF NEW.organization_id IS NULL THEN
      RAISE EXCEPTION 'public_room_settings: không suy được tổ chức cho cài đặt phòng trống (chủ phải có toà hoặc thuộc đúng một tổ chức)'
        USING ERRCODE='23502';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.public_room_settings_fill_org_v1() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_public_room_settings_fill_org ON public.public_room_settings;
CREATE TRIGGER trg_public_room_settings_fill_org
  BEFORE INSERT OR UPDATE ON public.public_room_settings
  FOR EACH ROW EXECUTE FUNCTION app_private.public_room_settings_fill_org_v1();

-- Dòng thiếu org hiện có: trigger BEFORE UPDATE tự suy (hoặc 23502 làm hỏng cả migration nếu không suy được).
UPDATE public.public_room_settings SET updated_at=updated_at WHERE organization_id IS NULL;

ALTER TABLE public.public_room_settings ALTER COLUMN organization_id SET NOT NULL;

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM public.public_room_settings WHERE organization_id IS NULL) THEN
    RAISE EXCEPTION 'Còn dòng public_room_settings thiếu organization_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.public_room_settings'::regclass
                  AND tgname='trg_public_room_settings_fill_org' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Thiếu trigger điền tổ chức cho public_room_settings';
  END IF;
END
$assert$;
