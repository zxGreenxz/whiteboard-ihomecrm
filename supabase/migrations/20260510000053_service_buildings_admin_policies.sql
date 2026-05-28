-- =============================================
-- Migration: Admin / super-admin RLS policies for service_buildings
-- Description: service_buildings only had per-owner CRUD policies keyed on
-- services.user_id = auth.uid(), so admins/super-admins editing a service
-- they did not personally create got `42501 new row violates row-level
-- security policy for table "service_buildings"` when the EditServiceDialog
-- replaced the building list. Mirror the contract_services pattern, which
-- already has _admin_all and _super_admin_all policies so admins can manage
-- the junction rows of any owner's record.
-- =============================================

DROP POLICY IF EXISTS service_buildings_admin_all ON service_buildings;
CREATE POLICY service_buildings_admin_all ON service_buildings
  FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS service_buildings_super_admin_all ON service_buildings;
CREATE POLICY service_buildings_super_admin_all ON service_buildings
  FOR ALL
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
