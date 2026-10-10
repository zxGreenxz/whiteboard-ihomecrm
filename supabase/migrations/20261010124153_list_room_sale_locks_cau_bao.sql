-- Nối tiếp 20261010114500 (đã áp production 10/10/2026): chỉ đổi câu báo lỗi của
-- list_room_sale_locks_v1. Câu cũ chứa chữ "lock" + khoảng trắng + chữ cái, khớp bộ dò
-- `lock table …` của gate:stable-fn-locks ⇒ hàm STABLE bị chấm là có khoá dòng (báo nhầm;
-- thân hàm không FOR UPDATE/SHARE). Thân hàm chép nguyên từ 20261010114500, không đổi
-- kiểu trả về, độ biến động hay ACL (CREATE OR REPLACE giữ GRANT).
CREATE OR REPLACE FUNCTION public.list_room_sale_locks_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false)
    OR (public.is_super_admin() AND COALESCE(p_organization_id=ANY(public.sandbox_org_ids()),false)) THEN
    RAISE EXCEPTION 'Không có quyền xem phòng đang khoá tạm trong tổ chức' USING ERRCODE='42501';END IF;
  RETURN jsonb_build_object('server_now',now(),'locks',COALESCE((
    SELECT jsonb_agg(app_private.room_sale_lock_response_v1(l.id) ORDER BY l.expires_at,l.id)
    FROM public.room_sale_locks l
    JOIN public.rooms rm ON rm.id=l.room_id
    JOIN public.buildings b ON b.id=l.building_id
    WHERE l.organization_id=p_organization_id AND l.released_at IS NULL AND l.expires_at>now()
      AND public.can_access_building(l.building_id)
      AND (public.can_do_on_building('deposits','view',l.building_id) OR public.can_do_on_building('sale_phong','lock_room',l.building_id))
      AND EXISTS(SELECT 1 FROM app_private.room_sale_workflow_base_fact_v1(l.room_id,l.organization_id,rm.status::text,
        EXISTS(SELECT 1 FROM public.room_pass_listings pl WHERE pl.room_id=l.room_id AND pl.user_id=b.user_id AND pl.active),
        COALESCE((SELECT s.soon_days FROM public.public_room_settings s WHERE s.owner_id=b.user_id LIMIT 1),30)) f
        WHERE f.status_public IN ('free','soon'))
  ),'[]'::jsonb));
END;
$function$;
