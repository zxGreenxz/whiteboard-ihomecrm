-- ============================================================================
-- T5 §domain-meter PREPARED SQL — canonical approve/unapprove meter reading.
-- STATUS: APPLIED production 2026-07-18 (meter-domain cutover).
-- LÝ DO: legacy approve_meter_reading / bulk_approve_meter_readings KHÔNG check
--   permission (chỉ SELECT status + UPDATE) → bất kỳ authenticated (RLS cho qua)
--   duyệt được chỉ số toà bất kỳ. unapprove là direct-DML thẳng bảng. Viết writer
--   canonical: derive building từ meter, exact permission can_do_on_building
--   ('meter_readings','edit',building) — khớp pattern create_meter_reading_v1,
--   không dính staff-parity gap của resolver v3. Idempotent. Giữ self-approve
--   như hành vi hiện tại (create đã auto-approve; maker-checker meter là quyết
--   định nghiệp vụ riêng, KHÔNG đổi ở đây).
-- ============================================================================

begin;

create or replace function public.approve_meter_reading_v1(p_id uuid)
returns public.meter_readings
language plpgsql volatile security definer
set search_path to 'pg_catalog', 'public' as $fn$
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
$fn$;

create or replace function public.unapprove_meter_reading_v1(p_id uuid)
returns public.meter_readings
language plpgsql volatile security definer
set search_path to 'pg_catalog', 'public' as $fn$
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
$fn$;

create or replace function public.bulk_approve_meter_readings_v1(p_ids uuid[])
returns integer
language plpgsql volatile security definer
set search_path to 'pg_catalog', 'public' as $fn$
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
$fn$;

grant execute on function public.approve_meter_reading_v1(uuid) to authenticated;
grant execute on function public.unapprove_meter_reading_v1(uuid) to authenticated;
grant execute on function public.bulk_approve_meter_readings_v1(uuid[]) to authenticated;

commit;
