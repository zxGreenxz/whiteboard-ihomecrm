-- Khôi phục bản tốt nhất trong 3 phương án đã đo cho đường theo-dòng:
--   can_v3 trực tiếp        401 ms  <-- dùng bản này
--   mảng bọc trong hàm   12.364 ms  (không inline được -> tệ nhất)
--   hàm cũ                  453 ms
create or replace function app_private.probe_can_do_on_building(_table text, _action text, _building_id uuid)
returns boolean language sql stable security definer
set search_path to 'pg_catalog','app_private','public' as $$
  select not app_private.is_actor_offboarded_v1()
     and (public.is_super_admin() or app_private.can_v3(_table||'.'||_action, _building_id));
$$;
create or replace function app_private.probe_permitted_building_ids(_table text, _action text)
returns setof uuid language sql stable security definer
set search_path to 'pg_catalog','app_private','public' as $$
  select b from unnest(app_private.buildings_for_v3(_table||'.'||_action)) as t(b)
   where not app_private.is_actor_offboarded_v1();
$$;
