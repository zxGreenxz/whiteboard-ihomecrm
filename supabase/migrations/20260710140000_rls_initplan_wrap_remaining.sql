-- =============================================================
-- Phase 4: wrap is_admin()/is_super_admin() TRẦN -> (SELECT ...) cho 128 policy
-- còn sót (write/self/share) mà migration initplan trước (20260702150000) bỏ qua.
-- Semantics-preserving: (SELECT fn()) cho kết quả HỆT fn() nhưng Postgres eval 1
-- lần (initplan) thay vì per-row → giảm CPU trên hot path RLS.
-- Sinh tự động từ pg_policies (regexp_replace), chỉ policy đổi thật. Áp all-or-nothing.
-- ROLLBACK: không cần thiết (chỉ tối ưu); nếu muốn đảo, bỏ lớp (SELECT ...) quanh fn.
-- =============================================================
BEGIN;
ALTER POLICY accounts_hide_demo_admin ON public.accounts USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY area_buildings_hide_demo_admin ON public.area_buildings USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY area_buildings_write_rbac ON public.area_buildings USING (((SELECT public.is_super_admin()) OR (EXISTS ( SELECT 1
   FROM (staff_assignments sa
     LEFT JOIN roles r ON ((r.id = sa.role_id)))
  WHERE ((sa.staff_id = auth.uid()) AND (sa.building_id IS NULL) AND (sa.area_id IS NULL) AND ((COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb) OR ((r.name)::text = 'Admin'::text) OR (COALESCE((((COALESCE(sa.permissions, r.permissions) -> 'areas'::text) ->> 'edit'::text))::boolean, false) = true))))))) WITH CHECK (((SELECT public.is_super_admin()) OR (EXISTS ( SELECT 1
   FROM (staff_assignments sa
     LEFT JOIN roles r ON ((r.id = sa.role_id)))
  WHERE ((sa.staff_id = auth.uid()) AND (sa.building_id IS NULL) AND (sa.area_id IS NULL) AND ((COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb) OR ((r.name)::text = 'Admin'::text) OR (COALESCE((((COALESCE(sa.permissions, r.permissions) -> 'areas'::text) ->> 'edit'::text))::boolean, false) = true)))))));
ALTER POLICY areas_delete_rbac ON public.areas USING (((SELECT public.is_super_admin()) OR (EXISTS ( SELECT 1
   FROM (staff_assignments sa
     LEFT JOIN roles r ON ((r.id = sa.role_id)))
  WHERE ((sa.staff_id = auth.uid()) AND (sa.building_id IS NULL) AND (sa.area_id IS NULL) AND ((COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb) OR ((r.name)::text = 'Admin'::text) OR (COALESCE((((COALESCE(sa.permissions, r.permissions) -> 'areas'::text) ->> 'delete'::text))::boolean, false) = true)))))));
ALTER POLICY areas_hide_demo_admin ON public.areas USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY areas_insert_rbac ON public.areas WITH CHECK (((SELECT public.is_super_admin()) OR (EXISTS ( SELECT 1
   FROM (staff_assignments sa
     LEFT JOIN roles r ON ((r.id = sa.role_id)))
  WHERE ((sa.staff_id = auth.uid()) AND (sa.building_id IS NULL) AND (sa.area_id IS NULL) AND ((COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb) OR ((r.name)::text = 'Admin'::text) OR (COALESCE((((COALESCE(sa.permissions, r.permissions) -> 'areas'::text) ->> 'create'::text))::boolean, false) = true)))))));
ALTER POLICY areas_select_rbac ON public.areas USING (((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR (EXISTS ( SELECT 1
   FROM staff_assignments sa
  WHERE ((sa.staff_id = auth.uid()) AND (((sa.building_id IS NULL) AND (sa.area_id IS NULL)) OR (sa.area_id = areas.id) OR (EXISTS ( SELECT 1
           FROM area_buildings ab
          WHERE ((ab.area_id = areas.id) AND (ab.building_id = sa.building_id))))))))));
ALTER POLICY areas_update_rbac ON public.areas USING (((SELECT public.is_super_admin()) OR (EXISTS ( SELECT 1
   FROM (staff_assignments sa
     LEFT JOIN roles r ON ((r.id = sa.role_id)))
  WHERE ((sa.staff_id = auth.uid()) AND (sa.building_id IS NULL) AND (sa.area_id IS NULL) AND ((COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb) OR ((r.name)::text = 'Admin'::text) OR (COALESCE((((COALESCE(sa.permissions, r.permissions) -> 'areas'::text) ->> 'edit'::text))::boolean, false) = true))))))) WITH CHECK (((SELECT public.is_super_admin()) OR (EXISTS ( SELECT 1
   FROM (staff_assignments sa
     LEFT JOIN roles r ON ((r.id = sa.role_id)))
  WHERE ((sa.staff_id = auth.uid()) AND (sa.building_id IS NULL) AND (sa.area_id IS NULL) AND ((COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb) OR ((r.name)::text = 'Admin'::text) OR (COALESCE((((COALESCE(sa.permissions, r.permissions) -> 'areas'::text) ->> 'edit'::text))::boolean, false) = true)))))));
ALTER POLICY asset_handovers_hide_demo_admin ON public.asset_handovers USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY asset_maintenance_hide_demo_admin ON public.asset_maintenance USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY asset_movements_hide_demo_admin ON public.asset_movements USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY asset_warehouses_delete_rbac ON public.asset_warehouses USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('warehouses'::text, 'delete'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('warehouses'::text, 'delete'::text))));
ALTER POLICY asset_warehouses_insert_rbac ON public.asset_warehouses WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('warehouses'::text, 'create'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('warehouses'::text, 'create'::text))));
ALTER POLICY asset_warehouses_select_rbac ON public.asset_warehouses USING (((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR ((building_id IS NOT NULL) AND can_access_building(building_id)) OR ((building_id IS NULL) AND can_access_org_entity('warehouses'::text, 'view'::text))));
ALTER POLICY asset_warehouses_update_rbac ON public.asset_warehouses USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('warehouses'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('warehouses'::text, 'edit'::text)))) WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('warehouses'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('warehouses'::text, 'edit'::text))));
ALTER POLICY assets_delete_rbac ON public.assets USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('assets'::text, 'delete'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('assets'::text, 'delete'::text))));
ALTER POLICY assets_hide_demo_admin ON public.assets USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY assets_insert_rbac ON public.assets WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('assets'::text, 'create'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('assets'::text, 'create'::text))));
ALTER POLICY assets_select_rbac ON public.assets USING (((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR ((building_id IS NOT NULL) AND can_access_building(building_id)) OR ((building_id IS NULL) AND can_access_org_entity('assets'::text, 'view'::text))));
ALTER POLICY assets_update_rbac ON public.assets USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('assets'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('assets'::text, 'edit'::text)))) WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('assets'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('assets'::text, 'edit'::text))));
ALTER POLICY auto_debt_config_delete_rbac ON public.auto_debt_config USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('auto_debt'::text, 'delete'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('auto_debt'::text, 'delete'::text))));
ALTER POLICY auto_debt_config_insert_rbac ON public.auto_debt_config WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('auto_debt'::text, 'create'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('auto_debt'::text, 'create'::text))));
ALTER POLICY auto_debt_config_select_rbac ON public.auto_debt_config USING (((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR ((building_id IS NOT NULL) AND can_access_building(building_id)) OR ((building_id IS NULL) AND can_access_org_entity('auto_debt'::text, 'view'::text))));
ALTER POLICY auto_debt_config_update_rbac ON public.auto_debt_config USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('auto_debt'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('auto_debt'::text, 'edit'::text)))) WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('auto_debt'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('auto_debt'::text, 'edit'::text))));
ALTER POLICY bfa_select ON public.building_fee_accounts USING (((user_id = auth.uid()) OR can_access_building(building_id) OR ie_all_buildings_scope(building_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY building_services_hide_demo_admin ON public.building_services USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (building_id IN ( SELECT unnest(demo_building_ids()) AS unnest)))));
ALTER POLICY bldg_sh_owner_all ON public.building_shareholders USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY building_shareholders_hide_demo_admin ON public.building_shareholders USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY bua_select ON public.building_utility_accounts USING (((user_id = auth.uid()) OR can_access_building(building_id) OR ie_all_buildings_scope(building_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY buildings_hide_demo_admin ON public.buildings USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY buildings_insert_rbac ON public.buildings WITH CHECK (((SELECT public.is_super_admin()) OR (EXISTS ( SELECT 1
   FROM (staff_assignments sa
     LEFT JOIN roles r ON ((r.id = sa.role_id)))
  WHERE ((sa.staff_id = auth.uid()) AND (sa.building_id IS NULL) AND (sa.area_id IS NULL) AND ((COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb) OR ((r.name)::text = 'Admin'::text) OR (COALESCE((((COALESCE(sa.permissions, r.permissions) -> 'buildings'::text) ->> 'create'::text))::boolean, false) = true)))))));
ALTER POLICY cash_handover_items_select ON public.cash_handover_items USING ((EXISTS ( SELECT 1
   FROM cash_handovers h
  WHERE ((h.id = cash_handover_items.handover_id) AND ((h.giver_id = auth.uid()) OR (h.receiver_id = auth.uid()) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))))));
ALTER POLICY cash_handovers_select ON public.cash_handovers USING (((giver_id = auth.uid()) OR (receiver_id = auth.uid()) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY cbk_recon_select ON public.cashbook_reconciliations USING (((proposed_by = auth.uid()) OR (counterparty_id = auth.uid()) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()) OR (EXISTS ( SELECT 1
   FROM accounts a
  WHERE ((a.id = cashbook_reconciliations.account_id) AND ((a.user_id = auth.uid()) OR same_team(a.user_id)))))));
ALTER POLICY contract_extensions_hide_demo_admin ON public.contract_extensions USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY contracts_delete_rbac ON public.contracts USING (((SELECT public.is_super_admin()) OR ((room_id IS NOT NULL) AND can_do_on_building('contracts'::text, 'delete'::text, ( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = contracts.room_id))))));
ALTER POLICY contracts_hide_demo_admin ON public.contracts USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY contracts_insert_rbac ON public.contracts WITH CHECK (((SELECT public.is_super_admin()) OR ((room_id IS NOT NULL) AND can_do_on_building('contracts'::text, 'create'::text, ( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = contracts.room_id))))));
ALTER POLICY contracts_update_rbac ON public.contracts USING (((SELECT public.is_super_admin()) OR ((room_id IS NOT NULL) AND can_do_on_building('contracts'::text, 'edit'::text, ( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = contracts.room_id)))))) WITH CHECK (((SELECT public.is_super_admin()) OR ((room_id IS NOT NULL) AND can_do_on_building('contracts'::text, 'edit'::text, ( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = contracts.room_id))))));
ALTER POLICY cron_runs_admin ON public.cron_runs USING ((SELECT public.is_admin()));
ALTER POLICY ct01_declarations_hide_demo_admin ON public.ct01_declarations USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY customers_hide_demo_admin ON public.customers USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY deposits_delete_rbac ON public.deposits USING (((SELECT public.is_super_admin()) OR ((contract_id IS NOT NULL) AND can_do_on_building('deposits'::text, 'delete'::text, building_of_contract(contract_id))) OR ((contract_id IS NULL) AND (room_id IS NOT NULL) AND can_do_on_building('deposits'::text, 'delete'::text, ( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = deposits.room_id))))));
ALTER POLICY deposits_hide_demo_admin ON public.deposits USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY deposits_insert_rbac ON public.deposits WITH CHECK (((SELECT public.is_super_admin()) OR ((contract_id IS NOT NULL) AND can_do_on_building('deposits'::text, 'create'::text, building_of_contract(contract_id))) OR ((contract_id IS NULL) AND (room_id IS NOT NULL) AND can_do_on_building('deposits'::text, 'create'::text, ( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = deposits.room_id))))));
ALTER POLICY deposits_select_rbac ON public.deposits USING (((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR ((contract_id IS NOT NULL) AND can_access_building(building_of_contract(contract_id))) OR ((contract_id IS NULL) AND (room_id IS NOT NULL) AND can_access_building(( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = deposits.room_id))))));
ALTER POLICY deposits_update_rbac ON public.deposits USING (((SELECT public.is_super_admin()) OR ((contract_id IS NOT NULL) AND can_do_on_building('deposits'::text, 'edit'::text, building_of_contract(contract_id))) OR ((contract_id IS NULL) AND (room_id IS NOT NULL) AND can_do_on_building('deposits'::text, 'edit'::text, ( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = deposits.room_id)))))) WITH CHECK (((SELECT public.is_super_admin()) OR ((contract_id IS NOT NULL) AND can_do_on_building('deposits'::text, 'edit'::text, building_of_contract(contract_id))) OR ((contract_id IS NULL) AND (room_id IS NOT NULL) AND can_do_on_building('deposits'::text, 'edit'::text, ( SELECT rooms.building_id
   FROM rooms
  WHERE (rooms.id = deposits.room_id))))));
ALTER POLICY expenses_delete_rbac ON public.expenses USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('income_expenses'::text, 'delete'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('income_expenses'::text, 'delete'::text))));
ALTER POLICY expenses_insert_rbac ON public.expenses WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('income_expenses'::text, 'create'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('income_expenses'::text, 'create'::text))));
ALTER POLICY expenses_select_rbac ON public.expenses USING (((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR ((building_id IS NOT NULL) AND can_access_building(building_id)) OR ((building_id IS NULL) AND can_access_org_entity('income_expenses'::text, 'view'::text))));
ALTER POLICY expenses_update_rbac ON public.expenses USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('income_expenses'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('income_expenses'::text, 'edit'::text)))) WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('income_expenses'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('income_expenses'::text, 'edit'::text))));
ALTER POLICY income_expense_items_select_rbac ON public.income_expense_items USING ((EXISTS ( SELECT 1
   FROM income_expenses ie
  WHERE ((ie.id = income_expense_items.income_expense_id) AND ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR ((ie.building_id IS NOT NULL) AND can_access_building(ie.building_id)))))));
ALTER POLICY income_expense_types_hide_demo_admin ON public.income_expense_types USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY income_expenses_hide_demo_admin ON public.income_expenses USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY insp_photo_select ON public.inspection_photos USING ((EXISTS ( SELECT 1
   FROM inspection_sessions s
  WHERE ((s.id = inspection_photos.session_id) AND ((s.user_id = auth.uid()) OR (SELECT public.is_admin()))))));
ALTER POLICY insp_sess_select ON public.inspection_sessions USING (((user_id = auth.uid()) OR (SELECT public.is_admin())));
ALTER POLICY insp_sess_update ON public.inspection_sessions USING (((user_id = auth.uid()) OR (SELECT public.is_admin())));
ALTER POLICY invoice_audit_log_select_visible ON public.invoice_audit_log USING ((EXISTS ( SELECT 1
   FROM invoices i
  WHERE ((i.id = invoice_audit_log.invoice_id) AND ((i.user_id = auth.uid()) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()) OR (i.user_id = ANY (current_visible_owner_ids())))))));
ALTER POLICY invoices_hide_demo_admin ON public.invoices USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY issues_delete_rbac ON public.issues USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('tasks'::text, 'delete'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'delete'::text))));
ALTER POLICY issues_insert_rbac ON public.issues WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('tasks'::text, 'create'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'create'::text))));
ALTER POLICY issues_select_rbac ON public.issues USING (((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR ((building_id IS NOT NULL) AND can_access_building(building_id)) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'view'::text))));
ALTER POLICY issues_update_rbac ON public.issues USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('tasks'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'edit'::text)))) WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('tasks'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'edit'::text))));
ALTER POLICY jobs_delete_rbac ON public.jobs USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('tasks'::text, 'delete'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'delete'::text))));
ALTER POLICY jobs_hide_demo_admin ON public.jobs USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY jobs_insert_rbac ON public.jobs WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('tasks'::text, 'create'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'create'::text))));
ALTER POLICY jobs_select_rbac ON public.jobs USING (((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR ((building_id IS NOT NULL) AND can_access_building(building_id)) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'view'::text))));
ALTER POLICY jobs_update_rbac ON public.jobs USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('tasks'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'edit'::text)))) WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('tasks'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('tasks'::text, 'edit'::text))));
ALTER POLICY leads_delete_rbac ON public.leads USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('leads'::text, 'delete'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('leads'::text, 'delete'::text))));
ALTER POLICY leads_hide_demo_admin ON public.leads USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY leads_insert_rbac ON public.leads WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('leads'::text, 'create'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('leads'::text, 'create'::text))));
ALTER POLICY leads_select_rbac ON public.leads USING (((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR ((building_id IS NOT NULL) AND can_access_building(building_id)) OR ((building_id IS NULL) AND can_access_org_entity('leads'::text, 'view'::text))));
ALTER POLICY leads_update_rbac ON public.leads USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('leads'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('leads'::text, 'edit'::text)))) WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('leads'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('leads'::text, 'edit'::text))));
ALTER POLICY msc_owner_all ON public.manager_salary_config USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY material_adjustments_hide_demo_admin ON public.material_adjustments USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY material_purchases_hide_demo_admin ON public.material_purchases USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY material_usages_hide_demo_admin ON public.material_usages USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY materials_hide_demo_admin ON public.materials USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY meter_readings_delete_rbac ON public.meter_readings USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('meter_readings'::text, 'delete'::text, building_id))));
ALTER POLICY meter_readings_hide_demo_admin ON public.meter_readings USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY meter_readings_insert_rbac ON public.meter_readings WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('meter_readings'::text, 'create'::text, building_id))));
ALTER POLICY meter_readings_select_rbac ON public.meter_readings USING (((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR ((building_id IS NOT NULL) AND can_access_building(building_id))));
ALTER POLICY meter_readings_update_rbac ON public.meter_readings USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('meter_readings'::text, 'edit'::text, building_id)))) WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('meter_readings'::text, 'edit'::text, building_id))));
ALTER POLICY meters_hide_demo_admin ON public.meters USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY payments_hide_demo_admin ON public.payments USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY profiles_hide_demo_admin ON public.profiles USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY profit_alloc_owner_all ON public.profit_allocations USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY pma_owner_all ON public.profit_manager_allocations USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY pms_owner_all ON public.profit_manager_salaries USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY pmsb_owner_all ON public.profit_manager_salary_buildings USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY profit_managers_owner_all ON public.profit_managers USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY profit_monthly_owner_all ON public.profit_monthly USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY public_room_events_select ON public.public_room_events USING (((owner_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR (owner_id = ANY (current_visible_owner_ids()))));
ALTER POLICY roles_hide_demo_admin ON public.roles USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY rooms_hide_demo_admin ON public.rooms USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (building_id IN ( SELECT unnest(demo_building_ids()) AS unnest)))));
ALTER POLICY sa_owner_all ON public.salary_adjustments USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY sad_select ON public.salary_attendance_day USING (((user_id = auth.uid()) OR (SELECT public.is_admin())));
ALTER POLICY sae_admin ON public.salary_award_errors USING ((SELECT public.is_admin()));
ALTER POLICY sbr_owner_all ON public.salary_bonus_rules USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY sh_owner_all ON public.salary_holidays USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY sm_owner_all ON public.salary_monthly USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY sss_select ON public.salary_streak_state USING (((user_id = auth.uid()) OR (SELECT public.is_admin())));
ALTER POLICY sws_owner_all ON public.salary_work_ledger_snapshot USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY services_hide_demo_admin ON public.services USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY shareholders_hide_demo_admin ON public.shareholders USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY shareholders_owner_all ON public.shareholders USING (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin()))) WITH CHECK (((auth.uid() = user_id) OR (SELECT public.is_admin()) OR (SELECT public.is_super_admin())));
ALTER POLICY staff_assignments_hide_demo_admin ON public.staff_assignments USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY super_admins_modify ON public.super_admins USING ((SELECT public.is_super_admin())) WITH CHECK ((SELECT public.is_super_admin()));
ALTER POLICY super_admins_select ON public.super_admins USING ((SELECT public.is_super_admin()));
ALTER POLICY team_members_select ON public.team_members USING (((user_id = auth.uid()) OR (member_id = auth.uid()) OR same_team(member_id) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin())));
ALTER POLICY team_members_write ON public.team_members USING (((user_id = auth.uid()) OR (SELECT public.is_super_admin()))) WITH CHECK (((user_id = auth.uid()) OR (SELECT public.is_super_admin())));
ALTER POLICY teams_select ON public.teams USING (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR (EXISTS ( SELECT 1
   FROM team_members tm
  WHERE ((tm.team_id = teams.id) AND (tm.member_id = auth.uid()))))));
ALTER POLICY teams_write ON public.teams USING (((user_id = auth.uid()) OR (SELECT public.is_super_admin()))) WITH CHECK (((user_id = auth.uid()) OR (SELECT public.is_super_admin())));
ALTER POLICY tenants_hide_demo_admin ON public.tenants USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY vehicles_delete_rbac ON public.vehicles USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('vehicles'::text, 'delete'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('vehicles'::text, 'delete'::text) AND (user_id = ANY (current_visible_owner_ids())))));
ALTER POLICY vehicles_hide_demo_admin ON public.vehicles USING ((NOT (( SELECT ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) AND (user_id IN ( SELECT unnest(demo_user_ids()) AS unnest)))));
ALTER POLICY vehicles_insert_rbac ON public.vehicles WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('vehicles'::text, 'create'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('vehicles'::text, 'create'::text) AND (user_id = ANY (current_visible_owner_ids())))));
ALTER POLICY vehicles_select_rbac ON public.vehicles USING (((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR ((building_id IS NOT NULL) AND can_access_building(building_id)) OR ((building_id IS NULL) AND can_access_org_entity('vehicles'::text, 'view'::text) AND (user_id = ANY (current_visible_owner_ids())))));
ALTER POLICY vehicles_update_rbac ON public.vehicles USING (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('vehicles'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('vehicles'::text, 'edit'::text) AND (user_id = ANY (current_visible_owner_ids()))))) WITH CHECK (((SELECT public.is_super_admin()) OR ((building_id IS NOT NULL) AND can_do_on_building('vehicles'::text, 'edit'::text, building_id)) OR ((building_id IS NULL) AND can_access_org_entity('vehicles'::text, 'edit'::text) AND (user_id = ANY (current_visible_owner_ids())))));
ALTER POLICY zalo_accounts_owner_all ON public.zalo_accounts USING (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) WITH CHECK (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin())));
ALTER POLICY zalo_automations_owner_all ON public.zalo_automations USING (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) WITH CHECK (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin())));
ALTER POLICY zalo_conversations_select ON public.zalo_conversations USING (((user_id = auth.uid()) OR (assigned_staff_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin())));
ALTER POLICY zalo_conversations_write ON public.zalo_conversations USING (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) WITH CHECK (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin())));
ALTER POLICY zalo_labels_owner_all ON public.zalo_labels USING (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) WITH CHECK (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin())));
ALTER POLICY zalo_message_templates_owner_all ON public.zalo_message_templates USING (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) WITH CHECK (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin())));
ALTER POLICY zalo_messages_select ON public.zalo_messages USING (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR (EXISTS ( SELECT 1
   FROM zalo_conversations c
  WHERE ((c.id = zalo_messages.conversation_id) AND (c.assigned_staff_id = auth.uid()))))));
ALTER POLICY zalo_messages_write ON public.zalo_messages USING (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) WITH CHECK (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin())));
ALTER POLICY zalo_send_queue_owner_all ON public.zalo_send_queue USING (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin()))) WITH CHECK (((user_id = auth.uid()) OR (SELECT public.is_super_admin()) OR (SELECT public.is_admin())));COMMIT;
