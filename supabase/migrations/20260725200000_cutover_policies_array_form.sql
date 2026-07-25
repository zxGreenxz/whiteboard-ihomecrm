-- =============================================================================
-- NGÀY G (phần 1/3) — viết lại 74 policy sang dạng MẢNG
--
-- VÌ SAO PHẢI SỬA POLICY, KHÔNG CHỈ ĐỔI RUỘT HELPER
--   Đo trên org thật (892 hoá đơn, EXPLAIN ANALYZE):
--     can_do_on_building cũ, gọi theo dòng            453 ms
--     ruột mới bọc trong SECURITY DEFINER           5.555 ms  (chậm 11 lần — hỏng)
--     dạng mảng viết THẲNG trong policy                16 ms  (nhanh hơn hiện tại 30 lần)
--   SECURITY DEFINER không inline được nên thân hàm chạy lại cho TỪNG DÒNG.
--   Chỉ khi biểu thức nằm thẳng trong policy thì planner mới tính mảng MỘT LẦN
--   rồi so thành viên cho từng dòng.
--
-- PHÉP ĐỔI
--   can_do_on_building('res','act', EXPR)
--     -> ((EXPR) = ANY (app_private.buildings_for_v3('res.act')))
--
--   Nhánh is_super_admin() sẵn có được GIỮ NGUYÊN. 41/74 policy KHÔNG có nhánh
--   riêng mà dựa vào nhánh BÊN TRONG can_do_on_building — với chúng, nhánh được
--   THÊM LẠI tường minh để phép đổi là tương đương chứng minh được, không âm thầm
--   gỡ bypass của quản trị nền tảng.
--   Bỏ guard is_actor_offboarded_v1: người bị thu hồi không còn membership ACTIVE
--   nên authorized_scope_v3 trả mảng rỗng — cùng kết quả, bớt một lời gọi.
--
-- Sinh tự động từ pg_policies bản ĐANG CHẠY, khớp ngoặc cân bằng (tham số thứ ba
-- có thể là hàm lồng như building_of_contract(...) hoặc cả một truy vấn con).
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- BẢN CHỤP ĐỂ QUAY LUI — chạy TRƯỚC mọi ALTER.
-- Nằm trong CÙNG transaction: nếu một ALTER nào hỏng thì cả bản chụp lẫn thay đổi
-- cùng rollback, database về đúng như cũ.
-- Khôi phục: sinh lại ALTER POLICY từ bảng này (xem cột qual / with_check).
-- ---------------------------------------------------------------------------
create table if not exists app_private.authz_policy_backup (
  id            bigserial primary key,
  captured_at   timestamptz not null default now(),
  captured_label text       not null,
  schemaname    text not null,
  tablename     text not null,
  policyname    text not null,
  cmd           text,
  permissive    text,
  roles         text,
  qual          text,
  with_check    text
);
revoke all on table app_private.authz_policy_backup from public, anon, authenticated;

insert into app_private.authz_policy_backup
  (captured_label, schemaname, tablename, policyname, cmd, permissive, roles, qual, with_check)
select 'pre-cutover-array-form', p.schemaname, p.tablename, p.policyname, p.cmd,
       p.permissive, p.roles::text, p.qual, p.with_check
  from pg_policies p
 where p.schemaname = 'public'
   and (coalesce(p.qual,'')||coalesce(p.with_check,'')) like '%can_do_on_building%'
   and not exists (
     select 1 from app_private.authz_policy_backup b
      where b.captured_label = 'pre-cutover-array-form'
        and b.tablename = p.tablename and b.policyname = p.policyname);

-- Chốt chặn: phải chụp đủ 74 policy trước khi đổi.
do $$
declare v_n integer;
begin
  select count(*) into v_n from app_private.authz_policy_backup
   where captured_label = 'pre-cutover-array-form';
  if v_n <> 74 then
    raise exception 'Bản chụp có % policy, kỳ vọng 74 — dừng, không đổi gì', v_n;
  end if;
end $$;

-- asset_handovers.asset_handovers_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "asset_handovers_delete_rbac" ON public.asset_handovers
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('assets.delete'::text))))));

-- asset_handovers.asset_handovers_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "asset_handovers_insert_rbac" ON public.asset_handovers
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('assets.create'::text))))));

-- asset_handovers.asset_handovers_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "asset_handovers_update_rbac" ON public.asset_handovers
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('assets.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('assets.edit'::text))))));

-- asset_warehouses.asset_warehouses_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "asset_warehouses_delete_rbac" ON public.asset_warehouses
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('warehouses.delete'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('warehouses'::text, 'delete'::text))));

-- asset_warehouses.asset_warehouses_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "asset_warehouses_insert_rbac" ON public.asset_warehouses
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('warehouses.create'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('warehouses'::text, 'create'::text))));

-- asset_warehouses.asset_warehouses_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "asset_warehouses_update_rbac" ON public.asset_warehouses
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('warehouses.edit'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('warehouses'::text, 'edit'::text))))
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('warehouses.edit'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('warehouses'::text, 'edit'::text))));

-- assets.assets_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "assets_delete_rbac" ON public.assets
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('assets.delete'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('assets'::text, 'delete'::text))));

-- assets.assets_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "assets_insert_rbac" ON public.assets
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('assets.create'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('assets'::text, 'create'::text))));

-- assets.assets_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "assets_update_rbac" ON public.assets
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('assets.edit'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('assets'::text, 'edit'::text))))
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('assets.edit'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('assets'::text, 'edit'::text))));

-- auto_debt_config.auto_debt_config_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "auto_debt_config_delete_rbac" ON public.auto_debt_config
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('auto_debt.delete'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('auto_debt'::text, 'delete'::text))));

-- auto_debt_config.auto_debt_config_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "auto_debt_config_insert_rbac" ON public.auto_debt_config
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('auto_debt.create'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('auto_debt'::text, 'create'::text))));

-- auto_debt_config.auto_debt_config_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "auto_debt_config_update_rbac" ON public.auto_debt_config
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('auto_debt.edit'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('auto_debt'::text, 'edit'::text))))
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('auto_debt.edit'::text)))) OR ((building_id IS NULL) AND (user_id = ANY (current_visible_owner_ids())) AND can_access_org_entity('auto_debt'::text, 'edit'::text))));

-- building_services.building_services_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "building_services_delete_rbac" ON public.building_services
  USING ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('services.delete'::text))))));

-- building_services.building_services_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "building_services_insert_rbac" ON public.building_services
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('services.create'::text))))));

-- building_services.building_services_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "building_services_update_rbac" ON public.building_services
  USING ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('services.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('services.edit'::text))))));

-- buildings.buildings_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "buildings_delete_rbac" ON public.buildings
  USING ((( SELECT public.is_super_admin()) OR (((id) = ANY (app_private.buildings_for_v3('buildings.delete'::text))))));

-- buildings.buildings_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "buildings_update_rbac" ON public.buildings
  USING ((( SELECT public.is_super_admin()) OR (((id) = ANY (app_private.buildings_for_v3('buildings.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((id) = ANY (app_private.buildings_for_v3('buildings.edit'::text))))));

-- contract_customers.contract_customers_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "contract_customers_delete_rbac" ON public.contract_customers
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.delete'::text))))));

-- contract_customers.contract_customers_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "contract_customers_insert_rbac" ON public.contract_customers
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.create'::text))))));

-- contract_customers.contract_customers_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "contract_customers_update_rbac" ON public.contract_customers
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))));

-- contract_extensions.contract_extensions_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "contract_extensions_delete_rbac" ON public.contract_extensions
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.delete'::text))))));

-- contract_extensions.contract_extensions_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "contract_extensions_insert_rbac" ON public.contract_extensions
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.create'::text))))));

-- contract_extensions.contract_extensions_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "contract_extensions_update_rbac" ON public.contract_extensions
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))));

-- contract_services.contract_services_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "contract_services_delete_rbac" ON public.contract_services
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.delete'::text))))));

-- contract_services.contract_services_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "contract_services_insert_rbac" ON public.contract_services
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.create'::text))))));

-- contract_services.contract_services_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "contract_services_update_rbac" ON public.contract_services
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))));

-- contract_tenants.contract_tenants_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "contract_tenants_delete_rbac" ON public.contract_tenants
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.delete'::text))))));

-- contract_tenants.contract_tenants_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "contract_tenants_insert_rbac" ON public.contract_tenants
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.create'::text))))));

-- contract_tenants.contract_tenants_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "contract_tenants_update_rbac" ON public.contract_tenants
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))));

-- contract_terminations.contract_terminations_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "contract_terminations_delete_rbac" ON public.contract_terminations
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.delete'::text))))));

-- contract_terminations.contract_terminations_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "contract_terminations_insert_rbac" ON public.contract_terminations
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.create'::text))))));

-- contract_terminations.contract_terminations_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "contract_terminations_update_rbac" ON public.contract_terminations
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))));

-- contract_transfers.contract_transfers_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "contract_transfers_delete_rbac" ON public.contract_transfers
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.delete'::text))))));

-- contract_transfers.contract_transfers_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "contract_transfers_insert_rbac" ON public.contract_transfers
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.create'::text))))));

-- contract_transfers.contract_transfers_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "contract_transfers_update_rbac" ON public.contract_transfers
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))));

-- contracts.contracts_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "contracts_delete_rbac" ON public.contracts
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((room_id IS NOT NULL) AND ((( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = contracts.room_id))) = ANY (app_private.buildings_for_v3('contracts.delete'::text))))));

-- contracts.contracts_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "contracts_insert_rbac" ON public.contracts
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((room_id IS NOT NULL) AND ((( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = contracts.room_id))) = ANY (app_private.buildings_for_v3('contracts.create'::text))))));

-- contracts.contracts_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "contracts_update_rbac" ON public.contracts
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((room_id IS NOT NULL) AND ((( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = contracts.room_id))) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))))
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((room_id IS NOT NULL) AND ((( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = contracts.room_id))) = ANY (app_private.buildings_for_v3('contracts.edit'::text))))));

-- deposits.deposits_delete_rbac [DELETE] — đổi 2 lời gọi
ALTER POLICY "deposits_delete_rbac" ON public.deposits
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((contract_id IS NOT NULL) AND ((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('deposits.delete'::text)))) OR ((contract_id IS NULL) AND (room_id IS NOT NULL) AND ((( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = deposits.room_id))) = ANY (app_private.buildings_for_v3('deposits.delete'::text))))));

-- deposits.deposits_insert_rbac [INSERT] — đổi 2 lời gọi
ALTER POLICY "deposits_insert_rbac" ON public.deposits
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((contract_id IS NOT NULL) AND ((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('deposits.create'::text)))) OR ((contract_id IS NULL) AND (room_id IS NOT NULL) AND ((( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = deposits.room_id))) = ANY (app_private.buildings_for_v3('deposits.create'::text))))));

-- deposits.deposits_update_rbac [UPDATE] — đổi 4 lời gọi
ALTER POLICY "deposits_update_rbac" ON public.deposits
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((contract_id IS NOT NULL) AND ((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('deposits.edit'::text)))) OR ((contract_id IS NULL) AND (room_id IS NOT NULL) AND ((( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = deposits.room_id))) = ANY (app_private.buildings_for_v3('deposits.edit'::text))))))
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((contract_id IS NOT NULL) AND ((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('deposits.edit'::text)))) OR ((contract_id IS NULL) AND (room_id IS NOT NULL) AND ((( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = deposits.room_id))) = ANY (app_private.buildings_for_v3('deposits.edit'::text))))));

-- excess_amounts.excess_amounts_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "excess_amounts_delete_rbac" ON public.excess_amounts
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('invoices.delete'::text))))));

-- excess_amounts.excess_amounts_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "excess_amounts_insert_rbac" ON public.excess_amounts
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('invoices.create'::text))))));

-- excess_amounts.excess_amounts_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "excess_amounts_update_rbac" ON public.excess_amounts
  USING ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('invoices.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_contract(contract_id)) = ANY (app_private.buildings_for_v3('invoices.edit'::text))))));

-- expenses.expenses_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "expenses_delete_rbac" ON public.expenses
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('income_expenses.delete'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('income_expenses'::text, 'delete'::text))));

-- expenses.expenses_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "expenses_insert_rbac" ON public.expenses
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('income_expenses.create'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('income_expenses'::text, 'create'::text))));

-- expenses.expenses_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "expenses_update_rbac" ON public.expenses
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('income_expenses.edit'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('income_expenses'::text, 'edit'::text))))
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('income_expenses.edit'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('income_expenses'::text, 'edit'::text))));

-- floors.floors_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "floors_delete_rbac" ON public.floors
  USING ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('buildings.delete'::text))))));

-- floors.floors_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "floors_insert_rbac" ON public.floors
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('buildings.create'::text))))));

-- floors.floors_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "floors_update_rbac" ON public.floors
  USING ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('buildings.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('buildings.edit'::text))))));

-- invoice_items.invoice_items_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "invoice_items_delete_rbac" ON public.invoice_items
  USING ((( SELECT public.is_super_admin()) OR (((building_of_invoice(invoice_id)) = ANY (app_private.buildings_for_v3('invoices.delete'::text))))));

-- invoice_items.invoice_items_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "invoice_items_insert_rbac" ON public.invoice_items
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_invoice(invoice_id)) = ANY (app_private.buildings_for_v3('invoices.create'::text))))));

-- invoice_items.invoice_items_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "invoice_items_update_rbac" ON public.invoice_items
  USING ((( SELECT public.is_super_admin()) OR (((building_of_invoice(invoice_id)) = ANY (app_private.buildings_for_v3('invoices.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_of_invoice(invoice_id)) = ANY (app_private.buildings_for_v3('invoices.edit'::text))))));

-- issues.issues_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "issues_delete_rbac" ON public.issues
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('tasks.delete'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'delete'::text))));

-- issues.issues_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "issues_insert_rbac" ON public.issues
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('tasks.create'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'create'::text))));

-- issues.issues_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "issues_update_rbac" ON public.issues
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('tasks.edit'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'edit'::text))))
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('tasks.edit'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'edit'::text))));

-- jobs.jobs_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "jobs_delete_rbac" ON public.jobs
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('tasks.delete'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'delete'::text))));

-- jobs.jobs_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "jobs_insert_rbac" ON public.jobs
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('tasks.create'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'create'::text))));

-- jobs.jobs_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "jobs_update_rbac" ON public.jobs
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('tasks.edit'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'edit'::text))))
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('tasks.edit'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'edit'::text))));

-- leads.leads_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "leads_delete_rbac" ON public.leads
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('leads.delete'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('leads'::text, 'delete'::text))));

-- leads.leads_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "leads_insert_rbac" ON public.leads
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('leads.create'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('leads'::text, 'create'::text))));

-- leads.leads_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "leads_update_rbac" ON public.leads
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('leads.edit'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('leads'::text, 'edit'::text))))
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('leads.edit'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('leads'::text, 'edit'::text))));

-- meter_readings.meter_readings_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "meter_readings_delete_rbac" ON public.meter_readings
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('meter_readings.delete'::text))))));

-- meter_readings.meter_readings_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "meter_readings_insert_rbac" ON public.meter_readings
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('meter_readings.create'::text))))));

-- meter_readings.meter_readings_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "meter_readings_update_rbac" ON public.meter_readings
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('meter_readings.edit'::text))))))
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('meter_readings.edit'::text))))));

-- meters.meters_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "meters_delete_rbac" ON public.meters
  USING ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('meters.delete'::text))))));

-- meters.meters_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "meters_insert_rbac" ON public.meters
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('meters.create'::text))))));

-- meters.meters_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "meters_update_rbac" ON public.meters
  USING ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('meters.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('meters.edit'::text))))));

-- rooms.rooms_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "rooms_delete_rbac" ON public.rooms
  USING ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('rooms.delete'::text))))));

-- rooms.rooms_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "rooms_insert_rbac" ON public.rooms
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('rooms.create'::text))))));

-- rooms.rooms_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "rooms_update_rbac" ON public.rooms
  USING ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('rooms.edit'::text))))))
  WITH CHECK ((( SELECT public.is_super_admin()) OR (((building_id) = ANY (app_private.buildings_for_v3('rooms.edit'::text))))));

-- vehicles.vehicles_delete_rbac [DELETE] — đổi 1 lời gọi
ALTER POLICY "vehicles_delete_rbac" ON public.vehicles
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('vehicles.delete'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('vehicles'::text, 'delete'::text) AND (user_id = ANY (current_visible_owner_ids())))));

-- vehicles.vehicles_insert_rbac [INSERT] — đổi 1 lời gọi
ALTER POLICY "vehicles_insert_rbac" ON public.vehicles
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('vehicles.create'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('vehicles'::text, 'create'::text) AND (user_id = ANY (current_visible_owner_ids())))));

-- vehicles.vehicles_update_rbac [UPDATE] — đổi 2 lời gọi
ALTER POLICY "vehicles_update_rbac" ON public.vehicles
  USING ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('vehicles.edit'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('vehicles'::text, 'edit'::text) AND (user_id = ANY (current_visible_owner_ids())))))
  WITH CHECK ((( SELECT is_super_admin() AS is_super_admin) OR ((building_id IS NOT NULL) AND ((building_id) = ANY (app_private.buildings_for_v3('vehicles.edit'::text)))) OR ((building_id IS NULL) AND can_access_org_entity('vehicles'::text, 'edit'::text) AND (user_id = ANY (current_visible_owner_ids())))));

commit;
