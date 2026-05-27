-- =============================================
-- Phase 3: RBAC policies cho contracts + contract_* + deposits
-- =============================================
-- ADDITIVE: thêm policy mới song song với policy cũ.
--
-- Policy mới đi qua dây FK: contract → room → building → can_access_building().
-- Các bảng phụ (contract_customers, _tenants, _services, _extensions, _terminations,
-- _transfers, deposits) traverse qua contract_id → building.
-- =============================================

-- ─── CONTRACTS ──────────────────────────────────────────────────────────────
CREATE POLICY contracts_select_rbac ON public.contracts
  FOR SELECT
  USING (
    public.is_super_admin()
    OR public.is_admin()
    OR (room_id IS NOT NULL AND public.can_access_building(
      (SELECT building_id FROM public.rooms WHERE id = contracts.room_id)
    ))
  );

CREATE POLICY contracts_insert_rbac ON public.contracts
  FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (room_id IS NOT NULL AND public.can_do_on_building('contracts','create',
      (SELECT building_id FROM public.rooms WHERE id = contracts.room_id)
    ))
  );

CREATE POLICY contracts_update_rbac ON public.contracts
  FOR UPDATE
  USING (
    public.is_super_admin()
    OR (room_id IS NOT NULL AND public.can_do_on_building('contracts','edit',
      (SELECT building_id FROM public.rooms WHERE id = contracts.room_id)
    ))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (room_id IS NOT NULL AND public.can_do_on_building('contracts','edit',
      (SELECT building_id FROM public.rooms WHERE id = contracts.room_id)
    ))
  );

CREATE POLICY contracts_delete_rbac ON public.contracts
  FOR DELETE
  USING (
    public.is_super_admin()
    OR (room_id IS NOT NULL AND public.can_do_on_building('contracts','delete',
      (SELECT building_id FROM public.rooms WHERE id = contracts.room_id)
    ))
  );

-- ─── CONTRACT_CUSTOMERS ─────────────────────────────────────────────────────
-- Traverse qua contract_id → contracts → room → building.
CREATE POLICY contract_customers_select_rbac ON public.contract_customers
  FOR SELECT
  USING (public.can_access_building(public.building_of_contract(contract_id)));

CREATE POLICY contract_customers_insert_rbac ON public.contract_customers
  FOR INSERT
  WITH CHECK (public.can_do_on_building('contracts','create', public.building_of_contract(contract_id)));

CREATE POLICY contract_customers_update_rbac ON public.contract_customers
  FOR UPDATE
  USING (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)))
  WITH CHECK (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)));

CREATE POLICY contract_customers_delete_rbac ON public.contract_customers
  FOR DELETE
  USING (public.can_do_on_building('contracts','delete', public.building_of_contract(contract_id)));

-- ─── CONTRACT_TENANTS ───────────────────────────────────────────────────────
CREATE POLICY contract_tenants_select_rbac ON public.contract_tenants
  FOR SELECT
  USING (public.can_access_building(public.building_of_contract(contract_id)));

CREATE POLICY contract_tenants_insert_rbac ON public.contract_tenants
  FOR INSERT
  WITH CHECK (public.can_do_on_building('contracts','create', public.building_of_contract(contract_id)));

CREATE POLICY contract_tenants_update_rbac ON public.contract_tenants
  FOR UPDATE
  USING (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)))
  WITH CHECK (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)));

CREATE POLICY contract_tenants_delete_rbac ON public.contract_tenants
  FOR DELETE
  USING (public.can_do_on_building('contracts','delete', public.building_of_contract(contract_id)));

-- ─── CONTRACT_SERVICES ──────────────────────────────────────────────────────
CREATE POLICY contract_services_select_rbac ON public.contract_services
  FOR SELECT
  USING (public.can_access_building(public.building_of_contract(contract_id)));

CREATE POLICY contract_services_insert_rbac ON public.contract_services
  FOR INSERT
  WITH CHECK (public.can_do_on_building('contracts','create', public.building_of_contract(contract_id)));

CREATE POLICY contract_services_update_rbac ON public.contract_services
  FOR UPDATE
  USING (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)))
  WITH CHECK (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)));

CREATE POLICY contract_services_delete_rbac ON public.contract_services
  FOR DELETE
  USING (public.can_do_on_building('contracts','delete', public.building_of_contract(contract_id)));

-- ─── CONTRACT_EXTENSIONS ────────────────────────────────────────────────────
CREATE POLICY contract_extensions_select_rbac ON public.contract_extensions
  FOR SELECT
  USING (public.can_access_building(public.building_of_contract(contract_id)));

CREATE POLICY contract_extensions_insert_rbac ON public.contract_extensions
  FOR INSERT
  WITH CHECK (public.can_do_on_building('contracts','create', public.building_of_contract(contract_id)));

CREATE POLICY contract_extensions_update_rbac ON public.contract_extensions
  FOR UPDATE
  USING (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)))
  WITH CHECK (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)));

CREATE POLICY contract_extensions_delete_rbac ON public.contract_extensions
  FOR DELETE
  USING (public.can_do_on_building('contracts','delete', public.building_of_contract(contract_id)));

-- ─── CONTRACT_TERMINATIONS ──────────────────────────────────────────────────
CREATE POLICY contract_terminations_select_rbac ON public.contract_terminations
  FOR SELECT
  USING (public.can_access_building(public.building_of_contract(contract_id)));

CREATE POLICY contract_terminations_insert_rbac ON public.contract_terminations
  FOR INSERT
  WITH CHECK (public.can_do_on_building('contracts','create', public.building_of_contract(contract_id)));

CREATE POLICY contract_terminations_update_rbac ON public.contract_terminations
  FOR UPDATE
  USING (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)))
  WITH CHECK (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)));

CREATE POLICY contract_terminations_delete_rbac ON public.contract_terminations
  FOR DELETE
  USING (public.can_do_on_building('contracts','delete', public.building_of_contract(contract_id)));

-- ─── CONTRACT_TRANSFERS ─────────────────────────────────────────────────────
CREATE POLICY contract_transfers_select_rbac ON public.contract_transfers
  FOR SELECT
  USING (public.can_access_building(public.building_of_contract(contract_id)));

CREATE POLICY contract_transfers_insert_rbac ON public.contract_transfers
  FOR INSERT
  WITH CHECK (public.can_do_on_building('contracts','create', public.building_of_contract(contract_id)));

CREATE POLICY contract_transfers_update_rbac ON public.contract_transfers
  FOR UPDATE
  USING (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)))
  WITH CHECK (public.can_do_on_building('contracts','edit', public.building_of_contract(contract_id)));

CREATE POLICY contract_transfers_delete_rbac ON public.contract_transfers
  FOR DELETE
  USING (public.can_do_on_building('contracts','delete', public.building_of_contract(contract_id)));

-- ─── DEPOSITS ───────────────────────────────────────────────────────────────
-- Traverse qua contract_id (nullable). Nếu NULL → fallback room_id → building.
CREATE POLICY deposits_select_rbac ON public.deposits
  FOR SELECT
  USING (
    public.is_super_admin()
    OR public.is_admin()
    OR (contract_id IS NOT NULL AND public.can_access_building(public.building_of_contract(contract_id)))
    OR (contract_id IS NULL AND room_id IS NOT NULL AND public.can_access_building(
      (SELECT building_id FROM public.rooms WHERE id = deposits.room_id)
    ))
  );

CREATE POLICY deposits_insert_rbac ON public.deposits
  FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (contract_id IS NOT NULL AND public.can_do_on_building('deposits','create', public.building_of_contract(contract_id)))
    OR (contract_id IS NULL AND room_id IS NOT NULL AND public.can_do_on_building('deposits','create',
      (SELECT building_id FROM public.rooms WHERE id = deposits.room_id)
    ))
  );

CREATE POLICY deposits_update_rbac ON public.deposits
  FOR UPDATE
  USING (
    public.is_super_admin()
    OR (contract_id IS NOT NULL AND public.can_do_on_building('deposits','edit', public.building_of_contract(contract_id)))
    OR (contract_id IS NULL AND room_id IS NOT NULL AND public.can_do_on_building('deposits','edit',
      (SELECT building_id FROM public.rooms WHERE id = deposits.room_id)
    ))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (contract_id IS NOT NULL AND public.can_do_on_building('deposits','edit', public.building_of_contract(contract_id)))
    OR (contract_id IS NULL AND room_id IS NOT NULL AND public.can_do_on_building('deposits','edit',
      (SELECT building_id FROM public.rooms WHERE id = deposits.room_id)
    ))
  );

CREATE POLICY deposits_delete_rbac ON public.deposits
  FOR DELETE
  USING (
    public.is_super_admin()
    OR (contract_id IS NOT NULL AND public.can_do_on_building('deposits','delete', public.building_of_contract(contract_id)))
    OR (contract_id IS NULL AND room_id IS NOT NULL AND public.can_do_on_building('deposits','delete',
      (SELECT building_id FROM public.rooms WHERE id = deposits.room_id)
    ))
  );

-- ─── TRIGGERS auto-fill user_id ─────────────────────────────────────────────
CREATE TRIGGER contracts_set_user_id_audit
  BEFORE INSERT ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

CREATE TRIGGER contract_extensions_set_user_id_audit
  BEFORE INSERT ON public.contract_extensions
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

CREATE TRIGGER contract_terminations_set_user_id_audit
  BEFORE INSERT ON public.contract_terminations
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

CREATE TRIGGER contract_transfers_set_user_id_audit
  BEFORE INSERT ON public.contract_transfers
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

CREATE TRIGGER deposits_set_user_id_audit
  BEFORE INSERT ON public.deposits
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
