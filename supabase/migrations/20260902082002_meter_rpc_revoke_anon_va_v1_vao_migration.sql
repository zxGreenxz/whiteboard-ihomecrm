-- =============================================================================
-- PMETER-C01 (single + bulk) + FR009-C04 bước 1 — re-anchor bảo mật 02/09/2026.
--
-- (1) REVOKE anon/PUBLIC khỏi 3 SECURITY DEFINER đang anon-executable trên
--     production (đo 02/09: has_function_privilege('anon', …) = true):
--       approve_meter_reading(uuid), bulk_approve_meter_readings(uuid[]),
--       salary_work_ledger(date,uuid).
--     Cả ba đều KHÔNG kiểm user/building/org trong thân; anon không phải caller
--     hợp lệ của bất kỳ luồng nào (hook luôn có JWT) → cắt là không đổi hành vi.
--     `authenticated` giữ nguyên để không gãy đường legacy đang chạy.
--
-- (2) Đưa approve_meter_reading_v1 / bulk_approve_meter_readings_v1 VÀO
--     MIGRATION. Hai hàm này có authz thật (can_do_on_building) nhưng tới nay chỉ
--     tồn tại trong scripts/authz-prepared/prod-snapshot/PS04 (chạy tay bằng psql)
--     → dựng lại DB từ baseline sẽ THIẾU _v1 và hook (useMeterReadings.ts:549,
--     :582) tự rơi về nhánh legacy không authz — đúng kịch bản tệ nhất. Thân hàm
--     chép NGUYÊN VĂN từ PS04 (kể cả partial-success của bulk — đổi sang
--     all-or-nothing là đổi hành vi UI, để PR riêng có báo trước).
--
-- Không DROP, không đổi chữ ký. Idempotent (CREATE OR REPLACE, REVOKE lặp vô hại).
-- =============================================================================

REVOKE ALL ON FUNCTION public.approve_meter_reading(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bulk_approve_meter_readings(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.salary_work_ledger(date, uuid) FROM PUBLIC, anon;

-- public.approve_meter_reading_v1(uuid) — nguyên văn PS04_rbac_org_meter_threshold.sql
CREATE OR REPLACE FUNCTION public.approve_meter_reading_v1(p_id uuid)
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
    raise exception 'Không có quyền duyệt chỉ số cho toà này' using errcode='42501'; end if;
  if v_row.status = 'APPROVED' then return v_row; end if; -- idempotent
  update public.meter_readings
     set status='APPROVED', approved_by=auth.uid(), approved_at=now()
   where id = p_id returning * into v_row;
  return v_row;
end;
$function$;

-- public.bulk_approve_meter_readings_v1(uuid[]) — nguyên văn PS04
CREATE OR REPLACE FUNCTION public.bulk_approve_meter_readings_v1(p_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_id uuid; v_n int := 0;
begin
  foreach v_id in array coalesce(p_ids, array[]::uuid[]) loop
    begin
      perform public.approve_meter_reading_v1(v_id);
      v_n := v_n + 1;
    exception when insufficient_privilege then
      -- bỏ qua item không đủ quyền/không tồn tại; đếm số duyệt thành công
      null;
    end;
  end loop;
  return v_n;
end;
$function$;

-- ACL của _v1: khớp production hiện tại (anon KHÔNG, authenticated CÓ).
REVOKE ALL ON FUNCTION public.approve_meter_reading_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bulk_approve_meter_readings_v1(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_meter_reading_v1(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bulk_approve_meter_readings_v1(uuid[]) TO authenticated, service_role;

-- Nghiệm thu: anon phải HẾT quyền trên 3 hàm legacy; _v1 phải tồn tại và anon không gọi được.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT s AS sig FROM unnest(ARRAY[
      'public.approve_meter_reading(uuid)',
      'public.bulk_approve_meter_readings(uuid[])',
      'public.salary_work_ledger(date,uuid)',
      'public.approve_meter_reading_v1(uuid)',
      'public.bulk_approve_meter_readings_v1(uuid[])'
    ]) AS s
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'Thiếu hàm %. DỪNG.', r.sig;
    END IF;
    IF has_function_privilege('anon', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon vẫn EXECUTE được %. DỪNG.', r.sig;
    END IF;
  END LOOP;
END $$;
