-- =============================================================================
-- Đưa unapprove_meter_reading_v1(uuid) VÀO MIGRATION — nối tiếp 20260902082002
-- (PMETER-C01, re-anchor bảo mật 02/09/2026).
--
-- VÌ SAO: hàm có authz thật (can_do_on_building) đang chạy trên production nhưng
-- chỉ tồn tại trong scripts/authz-prepared/prod-snapshot/PS04 (chạy tay) → dựng lại
-- DB từ baseline sẽ THIẾU nó, và hook useUnapproveMeterReading rơi về UPDATE thẳng
-- meter_readings (PostgREST + RLS, không có kiểm quyền theo toà). Chép NGUYÊN VĂN
-- PS04; ACL khớp production (anon KHÔNG, authenticated CÓ). Idempotent.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.unapprove_meter_reading_v1(p_id uuid)
 RETURNS public.meter_readings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_row public.meter_readings; v_building uuid;
begin
  select * into v_row from public.meter_readings where id = p_id and deleted_at is null;
  if not found then raise exception 'Không tìm thấy chỉ số' using errcode='42501'; end if;
  select building_id into v_building from public.meters where id = v_row.meter_id;
  if not public.can_do_on_building('meter_readings','edit',v_building) then
    raise exception 'Không có quyền bỏ duyệt chỉ số cho toà này' using errcode='42501'; end if;
  if v_row.status = 'UNAPPROVED' then return v_row; end if; -- idempotent
  update public.meter_readings
     set status='UNAPPROVED', approved_by=null, approved_at=null
   where id = p_id returning * into v_row;
  return v_row;
end;
$function$;

REVOKE ALL ON FUNCTION public.unapprove_meter_reading_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unapprove_meter_reading_v1(uuid) TO authenticated, service_role;

DO $$
BEGIN
  IF to_regprocedure('public.unapprove_meter_reading_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu unapprove_meter_reading_v1. DỪNG.';
  END IF;
  IF has_function_privilege('anon', 'public.unapprove_meter_reading_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon vẫn EXECUTE được unapprove_meter_reading_v1. DỪNG.';
  END IF;
END $$;
