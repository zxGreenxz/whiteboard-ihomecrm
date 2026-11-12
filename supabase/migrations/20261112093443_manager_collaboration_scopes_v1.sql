-- Reviewed business selection: additive grants, no rewrite of the manager role.
-- Inert until the organization owner explicitly configures a source role.
-- Thu_tien, invoice posting/reversal, approvals and the undecided actions are absent.
-- Draft-only editing must not reuse edit: that key also annotates approved vouchers,
-- stops recurring schedules and authorizes legacy cancellation paths.
INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active,
  required_dimensions,requires_cashbook_possession,accepted_possession_kinds)
SELECT 'income_expenses.edit_draft','income_expenses','edit_draft',sensitivity,permission_domain,scope_kinds,true,
  required_dimensions,requires_cashbook_possession,accepted_possession_kinds
FROM public.permission_definitions WHERE key='income_expenses.edit'
ON CONFLICT(key) DO NOTHING;
CREATE OR REPLACE FUNCTION app_private.manager_collaboration_catalog_v1()
RETURNS TABLE(decision_id text, scope_kind text, permission_key text)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $fn$
  VALUES
    ('customer.view', 'company', 'customers.view'),
    ('customer.manage', 'company', 'customers.create'),
    ('customer.manage', 'company', 'customers.edit'),
    ('customer.manage', 'company', 'customers.print'),
    ('customer.bulk-export', 'company', 'customers.export'),
    ('customer.delete', 'company', 'customers.delete'),
    ('lead.manage', 'company', 'leads.view'),
    ('lead.manage', 'company', 'leads.create'),
    ('lead.manage', 'company', 'leads.edit'),
    ('lead.manage', 'company', 'leads.convert'),
    ('sale.view', 'company', 'sale_phong.view'),
    ('sale.content', 'company', 'sale_phong.edit'),
    ('sale.content', 'company', 'sale_phong.manage_images'),
    ('sale.content', 'company', 'sale_phong.edit_floor_plan'),
    ('sale.content', 'company', 'sale_phong.manage_pass_listings'),
    ('sale.settings', 'company', 'sale_phong.manage_settings'),
    ('sale.settings', 'company', 'sale_phong.manage_tokens'),
    ('deposit.manage', 'company', 'deposits.view'),
    ('deposit.manage', 'company', 'deposits.create'),
    ('deposit.manage', 'company', 'deposits.edit'),
    ('deposit.manage', 'company', 'deposits.print'),
    ('deposit.manage', 'company', 'deposits.convert'),
    ('deposit.manage', 'company', 'sale_phong.create_deposit'),
    ('contract.view', 'company', 'contracts.view'),
    ('contract.view', 'company', 'contracts.print'),
    ('contract.manage', 'company', 'contracts.create'),
    ('contract.manage', 'company', 'contracts.edit'),
    ('contract.lifecycle', 'company', 'contracts.renew'),
    ('contract.lifecycle', 'company', 'contracts.transfer'),
    ('contract.lifecycle', 'company', 'contracts.handover'),
    ('contract.terminate', 'company', 'contracts.terminate'),
    ('building.view', 'company', 'buildings.view'),
    ('building.view', 'company', 'rooms.view'),
    ('building.view', 'company', 'areas.view'),
    ('building.edit', 'company', 'buildings.edit'),
    ('room.manage', 'company', 'rooms.create'),
    ('room.manage', 'company', 'rooms.edit'),
    ('vehicle.manage', 'company', 'vehicles.view'),
    ('vehicle.manage', 'company', 'vehicles.create'),
    ('vehicle.manage', 'company', 'vehicles.edit'),
    ('vehicle.manage', 'company', 'vehicles.delete'),
    ('task.manage', 'company', 'tasks.view'),
    ('task.manage', 'company', 'tasks.create'),
    ('task.manage', 'company', 'tasks.edit'),
    ('task.manage', 'company', 'tasks.complete'),
    ('asset.manage', 'company', 'assets.view'),
    ('asset.manage', 'company', 'assets.create'),
    ('asset.manage', 'company', 'assets.edit'),
    ('asset.manage', 'company', 'assets.maintain'),
    ('asset.transfer', 'company', 'assets.move'),
    ('meter.manage', 'company', 'meters.view'),
    ('meter.manage', 'company', 'meters.create'),
    ('meter.manage', 'company', 'meters.edit'),
    ('meter.manage', 'company', 'meters.delete'),
    ('meter.manage', 'company', 'meter_readings.view'),
    ('meter.manage', 'company', 'meter_readings.create'),
    ('meter.manage', 'company', 'meter_readings.edit'),
    ('meter.manage', 'company', 'meter_readings.delete'),
    ('catalog.manage', 'company', 'categories.view'),
    ('catalog.manage', 'company', 'categories.create'),
    ('catalog.manage', 'company', 'categories.edit'),
    ('catalog.manage', 'company', 'categories.delete'),
    ('catalog.manage', 'company', 'services.view'),
    ('catalog.manage', 'company', 'services.create'),
    ('catalog.manage', 'company', 'services.edit'),
    ('catalog.manage', 'company', 'services.delete'),
    ('catalog.manage', 'company', 'service_quotas.view'),
    ('catalog.manage', 'company', 'service_quotas.create'),
    ('catalog.manage', 'company', 'service_quotas.edit'),
    ('catalog.manage', 'company', 'service_quotas.delete'),
    ('catalog.manage', 'company', 'asset_types.view'),
    ('catalog.manage', 'company', 'asset_types.create'),
    ('catalog.manage', 'company', 'asset_types.edit'),
    ('catalog.manage', 'company', 'asset_types.delete'),
    ('catalog.manage', 'company', 'task_types.view'),
    ('catalog.manage', 'company', 'task_types.create'),
    ('catalog.manage', 'company', 'task_types.edit'),
    ('catalog.manage', 'company', 'task_types.delete'),
    ('catalog.manage', 'company', 'suppliers.view'),
    ('catalog.manage', 'company', 'suppliers.create'),
    ('catalog.manage', 'company', 'suppliers.edit'),
    ('catalog.manage', 'company', 'suppliers.delete'),
    ('catalog.manage', 'company', 'materials.view'),
    ('catalog.manage', 'company', 'materials.create'),
    ('catalog.manage', 'company', 'materials.edit'),
    ('catalog.manage', 'company', 'materials.delete'),
    ('catalog.manage', 'company', 'warehouses.view'),
    ('catalog.manage', 'company', 'warehouses.create'),
    ('catalog.manage', 'company', 'warehouses.edit'),
    ('catalog.manage', 'company', 'warehouses.delete'),
    ('invoice.manage', 'company', 'invoices.view'),
    ('invoice.manage', 'company', 'invoices.create'),
    ('invoice.manage', 'company', 'invoices.edit'),
    ('invoice.manage', 'company', 'invoices.print'),
    ('voucher.create', 'company', 'income_expenses.create'),
    ('voucher.create', 'company', 'income_expenses.all_buildings'),
    ('voucher.view', 'company', 'income_expenses.view'),
    ('voucher.view', 'company', 'income_expenses.print'),
    ('voucher.edit-draft', 'company', 'income_expenses.edit_draft'),
    ('debt.manage', 'company', 'auto_debt.view'),
    ('debt.manage', 'company', 'auto_debt.create'),
    ('debt.manage', 'company', 'auto_debt.edit'),
    ('report.operations', 'company', 'reports_real_estate.view'),
    ('report.operations', 'company', 'reports_real_estate.vacant_rooms'),
    ('report.operations', 'company', 'reports_real_estate.expiring'),
    ('report.operations', 'company', 'reports_real_estate.occupancy'),
    ('report.operations', 'company', 'reports_real_estate.new_leases'),
    ('report.operations', 'company', 'reports_real_estate.renewals_transfers'),
    ('report.operations', 'company', 'reports_real_estate.terminations'),
    ('admin.devices', 'company', 'network_center.view'),
    ('admin.devices', 'company', 'network_center.execute'),
    ('admin.devices', 'company', 'door_access.view'),
    ('admin.devices', 'company', 'door_access.temp_password'),
    ('admin.devices', 'company', 'door_access.remote_unlock'),
    ('admin.devices', 'company', 'door_access.manage_devices'),
    ('cashbook.view', 'cashbook', 'cashbooks.view'),
    ('cashbook.use', 'cashbook', 'cashbooks.post'),
    ('cashbook.close', 'cashbook', 'cashbooks.close'),
    ('cashbook.close', 'cashbook', 'cashbooks.close_confirm'),
    ('salary.self', 'self', 'salary.view'),
    ('residence.documents', 'company', 'customers.print'),
    ('residence.documents', 'company', 'buildings.edit'),
    ('residence.documents', 'company', 'contracts.view')
$fn$;
REVOKE ALL ON FUNCTION app_private.manager_collaboration_catalog_v1() FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS app_private.manager_collaboration_roles (
  organization_id uuid NOT NULL,
  source_role_id uuid PRIMARY KEY,
  company_role_id uuid NOT NULL UNIQUE,
  cashbook_role_id uuid NOT NULL UNIQUE,
  cashbook_reader_role_id uuid NOT NULL UNIQUE,
  FOREIGN KEY (organization_id, source_role_id) REFERENCES public.organization_roles(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, company_role_id) REFERENCES public.organization_roles(organization_id,id),
  FOREIGN KEY (organization_id, cashbook_role_id) REFERENCES public.organization_roles(organization_id,id),
  FOREIGN KEY (organization_id, cashbook_reader_role_id) REFERENCES public.organization_roles(organization_id,id),
  CHECK (source_role_id <> company_role_id AND source_role_id <> cashbook_role_id AND company_role_id <> cashbook_role_id
    AND cashbook_reader_role_id NOT IN(source_role_id,company_role_id,cashbook_role_id))
);
CREATE TABLE IF NOT EXISTS app_private.manager_collaboration_bindings (
  source_binding_id uuid NOT NULL REFERENCES public.role_bindings(id) ON DELETE CASCADE,
  supplemental_binding_id uuid PRIMARY KEY REFERENCES public.role_bindings(id) ON DELETE CASCADE
);
REVOKE ALL ON app_private.manager_collaboration_roles, app_private.manager_collaboration_bindings FROM PUBLIC, anon, authenticated;


-- Distinguish grants inherited from an assignment from independently assigned roles.
-- A manager can have several legacy building assignments and differently dated
-- cashbook possessions. The existing canonical-role uniqueness still applies to
-- ALL independently assigned roles; derived bindings have an explicit parent FK.
ALTER TABLE public.role_bindings ADD COLUMN IF NOT EXISTS inherited_from_binding_id uuid;
DO $ddl$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.role_bindings'::regclass
    AND conname='role_bindings_inherited_parent_fk') THEN
    ALTER TABLE public.role_bindings ADD CONSTRAINT role_bindings_inherited_parent_fk
      FOREIGN KEY(organization_id,inherited_from_binding_id)
      REFERENCES public.role_bindings(organization_id,id) ON DELETE CASCADE;
    ALTER TABLE public.role_bindings ADD CONSTRAINT role_bindings_inherited_not_self
      CHECK(inherited_from_binding_id IS DISTINCT FROM id);
  END IF;
END $ddl$;
DROP INDEX IF EXISTS public.role_bindings_one_open_canonical_role_uidx;
CREATE UNIQUE INDEX role_bindings_one_open_canonical_role_uidx
  ON public.role_bindings(organization_id,membership_id,role_id)
  WHERE legacy_assignment_id IS NULL AND valid_to IS NULL AND inherited_from_binding_id IS NULL;
CREATE INDEX IF NOT EXISTS role_bindings_inherited_parent_idx ON public.role_bindings(inherited_from_binding_id)
  WHERE inherited_from_binding_id IS NOT NULL;

-- Each generated binding has the same lifetime as its source. Cashbook bindings
-- additionally intersect that lifetime with possession, including scheduled expiry.
CREATE OR REPLACE FUNCTION app_private.sync_manager_collaboration_v1(p_source_binding uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  b public.role_bindings%ROWTYPE;
  cfg app_private.manager_collaboration_roles%ROWTYPE;
  cp record;
  v_id uuid;
  v_scope uuid;
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  SELECT * INTO b FROM public.role_bindings WHERE id=p_source_binding FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO cfg FROM app_private.manager_collaboration_roles
    WHERE source_role_id=b.role_id AND organization_id=b.organization_id;
  -- Remove only generated bindings; never edit the original scope or permissions.
  DELETE FROM public.role_bindings WHERE id IN (
    SELECT supplemental_binding_id FROM app_private.manager_collaboration_bindings
    WHERE source_binding_id=p_source_binding);
  IF cfg.source_role_id IS NULL THEN RETURN; END IF;
  INSERT INTO public.authorization_scopes(organization_id,scope_type)
    VALUES(b.organization_id,'ORGANIZATION') ON CONFLICT DO NOTHING;
  SELECT id INTO STRICT v_scope FROM public.authorization_scopes
    WHERE organization_id=b.organization_id AND scope_type='ORGANIZATION';
  INSERT INTO public.role_bindings(organization_id,membership_id,role_id,valid_from,valid_to,inherited_from_binding_id)
    VALUES(b.organization_id,b.membership_id,cfg.company_role_id,b.valid_from,b.valid_to,b.id) RETURNING id INTO v_id;
  INSERT INTO app_private.manager_collaboration_bindings VALUES(b.id,v_id);
  INSERT INTO public.role_binding_scopes VALUES(b.organization_id,v_id,v_scope);
  FOR cp IN SELECT * FROM public.cashbook_possession_bindings
    WHERE membership_id=b.membership_id AND organization_id=b.organization_id
      AND possession_kind IN ('CUSTODIAN','OPERATOR','KNOWER')
  LOOP
    v_start:=greatest(coalesce(b.valid_from,'-infinity'),cp.valid_from);
    v_end:=least(coalesce(b.valid_to,'infinity'),coalesce(cp.valid_to,'infinity'));
    IF v_end <= v_start THEN CONTINUE; END IF;
    INSERT INTO public.authorization_scopes(organization_id,scope_type,cashbook_id)
      VALUES(b.organization_id,'CASHBOOK',cp.cashbook_id) ON CONFLICT DO NOTHING;
    SELECT id INTO STRICT v_scope FROM public.authorization_scopes
      WHERE organization_id=b.organization_id AND scope_type='CASHBOOK' AND cashbook_id=cp.cashbook_id;
    INSERT INTO public.role_bindings(organization_id,membership_id,role_id,valid_from,valid_to,inherited_from_binding_id)
      VALUES(b.organization_id,b.membership_id,
        CASE WHEN cp.possession_kind='KNOWER' THEN cfg.cashbook_reader_role_id ELSE cfg.cashbook_role_id END,
        v_start,nullif(v_end,'infinity'::timestamptz),b.id)
      RETURNING id INTO v_id;
    INSERT INTO app_private.manager_collaboration_bindings VALUES(b.id,v_id);
    INSERT INTO public.role_binding_scopes VALUES(b.organization_id,v_id,v_scope);
  END LOOP;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.sync_manager_collaboration_v1(uuid) FROM PUBLIC, anon, authenticated;

-- Derived roles are never independent assignments, including writes through older RPCs.
CREATE OR REPLACE FUNCTION app_private.validate_manager_collaboration_binding_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.manager_collaboration_roles%ROWTYPE; p public.role_bindings%ROWTYPE;
BEGIN
  SELECT * INTO c FROM app_private.manager_collaboration_roles
    WHERE NEW.role_id IN(company_role_id,cashbook_role_id,cashbook_reader_role_id);
  IF FOUND THEN
    SELECT * INTO p FROM public.role_bindings WHERE id=NEW.inherited_from_binding_id;
    IF p.id IS NULL OR p.role_id<>c.source_role_id OR p.organization_id<>NEW.organization_id
      OR p.membership_id<>NEW.membership_id
      OR coalesce(NEW.valid_from,'-infinity')<coalesce(p.valid_from,'-infinity')
      OR coalesce(NEW.valid_to,'infinity')>coalesce(p.valid_to,'infinity')
    THEN RAISE EXCEPTION 'Vai trò cộng tác được kế thừa tự động từ vai trò quản lý, không cấp riêng.'
      USING ERRCODE='42501'; END IF;
  ELSIF NEW.inherited_from_binding_id IS NOT NULL THEN
    RAISE EXCEPTION 'Vai trò này không phải vai trò kế thừa được cấu hình.' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION app_private.validate_manager_collaboration_binding_v1() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS manager_collaboration_binding_validate ON public.role_bindings;
CREATE TRIGGER manager_collaboration_binding_validate BEFORE INSERT OR UPDATE ON public.role_bindings
FOR EACH ROW EXECUTE FUNCTION app_private.validate_manager_collaboration_binding_v1();


CREATE OR REPLACE FUNCTION public.get_member_authorization_v1(p_membership uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_org uuid := app_private.current_admin_org_v1();
  v_m   public.organization_memberships%rowtype;
  v_out jsonb;
begin
  if v_org is null then
    raise exception 'Bạn không có quyền xem phân quyền thành viên.' using errcode = '42501';
  end if;
  select * into v_m from public.organization_memberships
   where id = p_membership and organization_id = v_org;
  if not found then
    raise exception 'Không tìm thấy thành viên này trong tổ chức của bạn.' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'membershipId', v_m.id,
    'userId',       v_m.user_id,
    'email',        coalesce(p.email, u.email),
    'fullName',     p.full_name,
    'memberType',   v_m.member_type,
    'status',       v_m.status,
    'version',      v_m.version,
    'isSelf',       (v_m.user_id = (select auth.uid())),
    'roleBindings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'bindingId', rb.id,
               'roleId',    rb.role_id,
               'roleName',  orl.name,
               'scopeIds',  coalesce((select jsonb_agg(rbs.scope_id)
                                        from public.role_binding_scopes rbs
                                       where rbs.role_binding_id = rb.id), '[]'::jsonb))
             order by orl.name)
        from public.role_bindings rb
        join public.organization_roles orl on orl.id = rb.role_id
       where rb.membership_id = v_m.id and rb.valid_to is null
         and rb.inherited_from_binding_id IS NULL), '[]'::jsonb),
    'overrides', coalesce((
      select jsonb_agg(jsonb_build_object(
               'overrideId',    o.id,
               'permissionKey', o.permission_key,
               'effect',        o.effect,
               'scopeMode',     o.scope_mode,
               'reason',        o.reason,
               'expiresAt',     o.expires_at,
               'createdAt',     o.created_at,
               'scopeIds', coalesce((select jsonb_agg(mos.scope_id)
                                       from public.member_override_scopes mos
                                      where mos.override_id = o.id), '[]'::jsonb))
             order by o.permission_key)
        from public.member_permission_overrides o
       where o.membership_id = v_m.id and o.revoked_at is null
         and (o.expires_at is null or o.expires_at > now())), '[]'::jsonb),
    'cashbooksHeld', coalesce((
      select jsonb_agg(jsonb_build_object(
               'cashbookId', cp.cashbook_id, 'name', cb.name, 'kind', cp.possession_kind))
        from public.cashbook_possession_bindings cp
        left join public.accounts cb on cb.id = cp.cashbook_id
       where cp.membership_id = v_m.id and cp.valid_from <= now()
         and (cp.valid_to is null or cp.valid_to > now())), '[]'::jsonb),
    -- Tab "Quyền hiệu lực": danh sách khoá thực sự dùng được, ở BẤT KỲ phạm vi.
    'effectiveKeys', to_jsonb(app_private.allowed_keys_for_membership_v3(v_m.id))
  ) into v_out
  from (select 1) z
  left join public.profiles p on p.id = v_m.user_id
  left join auth.users u      on u.id = v_m.user_id;

  return v_out;
end
$function$
;

CREATE OR REPLACE FUNCTION public.update_member_authorization_v1(p_membership uuid, p_expected_version bigint, p_role_bindings jsonb DEFAULT NULL::jsonb, p_overrides jsonb DEFAULT NULL::jsonb, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid;
  v_user     uuid;
  v_ver      bigint;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_truoc    text[];
  v_sau      text[];
  v_them     text[];
  v_mat      text[];
  v_b        jsonb;
  v_o        jsonb;
  v_id       uuid;
  v_n_bind   int := 0;
  v_n_ov     int := 0;
begin
  if v_actor is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;
  if p_membership is null or p_expected_version is null then
    raise exception 'Thiếu thành viên hoặc số phiên bản. Hãy tải lại trang rồi thử lại.'
      using errcode = '22023';
  end if;
  if p_role_bindings is null and p_overrides is null then
    raise exception 'Không có gì để lưu.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Hãy ghi lý do thay đổi phân quyền.' using errcode = '22023';
  end if;

  select m.organization_id, m.user_id into v_org, v_user
    from public.organization_memberships m where m.id = p_membership;
  if v_org is null then
    raise exception 'Không tìm thấy thành viên này.' using errcode = 'P0002';
  end if;

  -- So bằng user_id, KHÔNG bằng membership_id: người có nhiều hồ sơ thành viên
  -- trong cùng tổ chức sẽ lách được nếu chỉ so membership.
  if v_user = v_actor then
    raise exception 'Bạn không thể tự sửa quyền của chính mình. Hãy nhờ chủ sở hữu thực hiện.'
      using errcode = '42501';
  end if;

  perform app_private.require_perm_v1(v_org, 'users.edit', 'sửa phân quyền thành viên');

  -- Khoá dòng RỒI mới so phiên bản (đọc trước khi khoá là sai — hai người cùng
  -- lưu có thể cùng đọc đúng version rồi cùng ghi).
  select m.version into v_ver
    from public.organization_memberships m where m.id = p_membership for update;
  if v_ver <> p_expected_version then
    raise exception 'Có người vừa đổi phân quyền của thành viên này. Hãy tải lại trang để xem thay đổi mới nhất.'
      using errcode = '40001';
  end if;

  -- Ảnh chụp quyền TRƯỚC, để trả về "mất gì / được thêm gì".
  v_truoc := app_private.allowed_keys_for_membership_v3(p_membership);

  -- ---- Lớp VAI TRÒ ----
  if p_role_bindings is not null then
    -- role_bindings_check đòi valid_to > valid_from NGHIÊM NGẶT. now() là mốc đầu
    -- giao dịch, nên nếu một binding vừa được tạo rồi bị đóng TRONG CÙNG giao dịch
    -- (lưu hai lần liên tiếp, hoặc kịch bản kiểm thử) thì hai mốc bằng nhau và
    -- ràng buộc nổ. Đẩy thêm 1 micro giây để luôn hợp lệ.
    update public.role_bindings
       set valid_to = greatest(now(), valid_from + interval '1 microsecond'),
           version = version + 1
     where membership_id = p_membership and valid_to is null
       and inherited_from_binding_id IS NULL;

    for v_b in select * from jsonb_array_elements(p_role_bindings) loop
      if not exists (select 1 from public.organization_roles r
                      where r.id = (v_b->>'role_id')::uuid and r.organization_id = v_org) then
        raise exception 'Vai trò không thuộc tổ chức này.' using errcode = '22023';
      end if;
      v_id := gen_random_uuid();
      insert into public.role_bindings (id, organization_id, membership_id, role_id, valid_from, version)
      values (v_id, v_org, p_membership, (v_b->>'role_id')::uuid, now(), 1);

      insert into public.role_binding_scopes (organization_id, role_binding_id, scope_id)
      select v_org, v_id, s.id
        from jsonb_array_elements_text(coalesce(v_b->'scope_ids', '[]'::jsonb)) as t(sid)
        join public.authorization_scopes s on s.id = t.sid::uuid and s.organization_id = v_org;

      if not exists (select 1 from public.role_binding_scopes x where x.role_binding_id = v_id) then
        raise exception 'Vai trò phải kèm ít nhất một phạm vi (toàn tổ chức, khu vực hoặc toà nhà).'
          using errcode = '22023';
      end if;
      v_n_bind := v_n_bind + 1;
    end loop;
  end if;

  -- ---- Lớp NGOẠI LỆ ----
  if p_overrides is not null then
    -- Thu hồi bằng revoked_at, KHÔNG xoá dòng: giữ dấu vết ai từng được cấp gì.
    update public.member_permission_overrides
       set revoked_at = now()
     where membership_id = p_membership and revoked_at is null;

    for v_o in select * from jsonb_array_elements(p_overrides) loop
      if nullif(btrim(coalesce(v_o->>'reason','')), '') is null then
        raise exception 'Ngoại lệ "%": phải ghi lý do.', v_o->>'permission_key'
          using errcode = '22023';
      end if;
      if not exists (select 1 from public.permission_definitions pd
                      where pd.key = v_o->>'permission_key' and pd.is_active
                        and pd.permission_domain = 'TENANT') then
        raise exception 'Quyền "%" không tồn tại hoặc không dùng được.', v_o->>'permission_key'
          using errcode = '22023';
      end if;

      v_id := gen_random_uuid();
      insert into public.member_permission_overrides
        (id, organization_id, membership_id, permission_key, effect, reason,
         expires_at, created_by, created_at, scope_mode)
      values (v_id, v_org, p_membership, v_o->>'permission_key',
              upper(coalesce(v_o->>'effect','ALLOW')), btrim(v_o->>'reason'),
              nullif(v_o->>'expires_at','')::timestamptz, v_actor, now(),
              upper(coalesce(v_o->>'scope_mode','ORGANIZATION')));

      insert into public.member_override_scopes (organization_id, override_id, scope_id)
      select v_org, v_id, s.id
        from jsonb_array_elements_text(coalesce(v_o->'scope_ids','[]'::jsonb)) as t(sid)
        join public.authorization_scopes s on s.id = t.sid::uuid and s.organization_id = v_org;

      -- Kiểm hình dạng ở ĐÂY để báo lỗi tiếng Việt, thay vì để ràng buộc ném lỗi
      -- thô lúc COMMIT (lúc đó người dùng chỉ thấy mã 23514 khó hiểu).
      if upper(coalesce(v_o->>'scope_mode','ORGANIZATION')) = 'ORGANIZATION' then
        if (select count(*) from public.member_override_scopes x
             join public.authorization_scopes s2 on s2.id = x.scope_id
            where x.override_id = v_id and s2.scope_type = 'ORGANIZATION') <> 1
           or (select count(*) from public.member_override_scopes x where x.override_id = v_id) <> 1 then
          raise exception 'Ngoại lệ "%" áp cho toàn tổ chức thì chỉ được chọn đúng phạm vi "toàn tổ chức".',
            v_o->>'permission_key' using errcode = '22023';
        end if;
      else
        if (select count(*) from public.member_override_scopes x where x.override_id = v_id) = 0 then
          raise exception 'Ngoại lệ "%" phải chọn ít nhất một toà nhà, khu vực hoặc sổ quỹ.',
            v_o->>'permission_key' using errcode = '22023';
        end if;
        if exists (select 1 from public.member_override_scopes x
                    join public.authorization_scopes s2 on s2.id = x.scope_id
                   where x.override_id = v_id and s2.scope_type = 'ORGANIZATION') then
          raise exception 'Ngoại lệ "%" theo phạm vi hẹp thì không được chọn "toàn tổ chức".',
            v_o->>'permission_key' using errcode = '22023';
        end if;
      end if;
      v_n_ov := v_n_ov + 1;
    end loop;
  end if;

  update public.organization_memberships
     set version = version + 1
   where id = p_membership;

  -- Ảnh chụp quyền SAU.
  v_sau := app_private.allowed_keys_for_membership_v3(p_membership);

  select coalesce(array_agg(k order by k), '{}'::text[]) into v_them
    from (select unnest(v_sau) except select unnest(v_truoc)) t(k);
  select coalesce(array_agg(k order by k), '{}'::text[]) into v_mat
    from (select unnest(v_truoc) except select unnest(v_sau)) t(k);

  perform app_private.append_authz_audit_v1(
    v_org, 'MEMBER_AUTHORIZATION_UPDATED', 'organization_membership', p_membership,
    jsonb_build_object('permissions', to_jsonb(v_truoc), 'version', v_ver),
    jsonb_build_object('permissions', to_jsonb(v_sau), 'version', v_ver + 1,
                       'role_bindings', v_n_bind, 'overrides', v_n_ov),
    v_reason);

  return jsonb_build_object(
    'membershipId', p_membership, 'version', v_ver + 1,
    'roleBindings', v_n_bind, 'overrides', v_n_ov,
    'permissionsBefore', coalesce(array_length(v_truoc, 1), 0),
    'permissionsAfter', coalesce(array_length(v_sau, 1), 0),
    'gained', to_jsonb(v_them), 'lost', to_jsonb(v_mat));
end
$function$
;

CREATE OR REPLACE FUNCTION public.list_organization_roles_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_org uuid := app_private.current_admin_org_v1();
  v_out jsonb;
begin
  if v_org is null then
    raise exception 'Bạn không có quyền xem mẫu vai trò.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'roleId',   r.id,
           'name',     r.name,
           'isSystem', r.is_system,
           'status',   coalesce(r.status, 'ACTIVE'),
           'version',  r.version,
           'memberCount', (select count(distinct rb.membership_id)
                             from public.role_bindings rb
                            where rb.role_id = r.id and rb.valid_to is null),
           'allowKeys', coalesce((select jsonb_agg(rp.permission_key order by rp.permission_key)
                                    from public.role_permissions rp
                                   where rp.role_id = r.id and rp.effect = 'ALLOW'), '[]'::jsonb),
           'denyKeys',  coalesce((select jsonb_agg(rp.permission_key order by rp.permission_key)
                                    from public.role_permissions rp
                                   where rp.role_id = r.id and rp.effect = 'DENY'), '[]'::jsonb))
         order by r.is_system desc, r.name), '[]'::jsonb)
    into v_out
    from public.organization_roles r
   where r.organization_id = v_org and coalesce(r.status, 'ACTIVE') <> 'ARCHIVED'
     and not exists(select 1 from app_private.manager_collaboration_roles c
       where r.id in(c.company_role_id,c.cashbook_role_id,c.cashbook_reader_role_id));

  return v_out;
end
$function$
;

CREATE OR REPLACE FUNCTION app_private.can_without_manager_collaboration_v1(p_permission_key text, p_building uuid DEFAULT NULL::uuid, p_cashbook uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
BEGIN
  RETURN (
    select exists (
      select 1
        from public.permission_definitions pd
        join public.organization_memberships m
          on m.user_id = (select auth.uid())
         and m.status = 'ACTIVE'
         and coalesce(m.valid_from, '-infinity'::timestamptz) <= now()
         and (m.valid_to is null or m.valid_to > now())
        join public.organizations o
          on o.id = m.organization_id and o.status = 'ACTIVE'
       where pd.key = p_permission_key
         and pd.permission_domain = 'TENANT'
         and pd.is_active
         and not ('BUILDING' = any(pd.required_dimensions) and p_building is null)
         and not ('CASHBOOK' = any(pd.required_dimensions) and p_cashbook is null)
         and (p_building is null or exists (
               select 1 from public.buildings b
                where b.id = p_building and b.organization_id = m.organization_id))
         and (p_cashbook is null or exists (
               select 1 from public.accounts a
                where a.id = p_cashbook and a.organization_id = m.organization_id
                  and a.deleted_at is null))
         and not exists (
           select 1 from app_private.tenant_emergency_denies d
            where d.organization_id = m.organization_id
              and (d.permission_key is null or d.permission_key = p_permission_key)
              and d.active_from <= now()
              and (d.expires_at is null or d.expires_at > now()))
         and not exists (
           select 1
             from public.member_permission_overrides ov
             join public.member_override_scopes mos on mos.override_id = ov.id
             join public.authorization_scopes s on s.id = mos.scope_id
            where ov.membership_id = m.id and ov.permission_key = p_permission_key
              and ov.effect = 'DENY' and ov.revoked_at is null
              and (ov.expires_at is null or ov.expires_at > now())
              and app_private.scope_covers_v3(s.scope_type, s.building_id, s.cashbook_id, s.area_id,
                                              m.organization_id, p_building, p_cashbook))
         and not exists (
           select 1
             from public.role_bindings rb
             join public.role_permissions rp
               on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
              and rp.permission_key = p_permission_key and rp.effect = 'DENY'
             join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
             join public.authorization_scopes s on s.id = rbs.scope_id
            where rb.membership_id = m.id and rb.valid_to is null
              and app_private.scope_covers_v3(s.scope_type, s.building_id, s.cashbook_id, s.area_id,
                                              m.organization_id, p_building, p_cashbook))
         and (not pd.requires_cashbook_possession or (
               p_cashbook is not null and exists (
                 select 1 from public.cashbook_possession_bindings cp
                  where cp.membership_id = m.id and cp.cashbook_id = p_cashbook
                    and cp.possession_kind = any(pd.accepted_possession_kinds)
                    and cp.valid_from <= now()
                    and (cp.valid_to is null or cp.valid_to > now()))))
         and (
           exists (
             select 1
               from public.member_permission_overrides ov
               join public.member_override_scopes mos on mos.override_id = ov.id
               join public.authorization_scopes s on s.id = mos.scope_id
              where ov.membership_id = m.id and ov.permission_key = p_permission_key
                and ov.effect = 'ALLOW' and ov.revoked_at is null
                and (ov.expires_at is null or ov.expires_at > now())
                and s.scope_type = any(pd.scope_kinds)
                and case when pd.requires_cashbook_possession
                         then s.scope_type = 'CASHBOOK' and s.cashbook_id = p_cashbook
                         else app_private.scope_covers_v3(s.scope_type, s.building_id, s.cashbook_id,
                                s.area_id, m.organization_id, p_building, p_cashbook) end)
           or exists (
             select 1
               from public.role_bindings rb
               join public.role_permissions rp
                 on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
                and rp.permission_key = p_permission_key and rp.effect = 'ALLOW'
               join public.organization_roles orl
                 on orl.id = rb.role_id and coalesce(orl.status,'ACTIVE') = 'ACTIVE'
               join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
               join public.authorization_scopes s on s.id = rbs.scope_id
              where rb.membership_id = m.id
                and rb.inherited_from_binding_id IS NULL
                and coalesce(rb.valid_from, '-infinity'::timestamptz) <= now()
                and (rb.valid_to is null or rb.valid_to > now())
                and s.scope_type = any(pd.scope_kinds)
                and case when pd.requires_cashbook_possession
                         then s.scope_type = 'CASHBOOK' and s.cashbook_id = p_cashbook
                         else app_private.scope_covers_v3(s.scope_type, s.building_id, s.cashbook_id,
                                s.area_id, m.organization_id, p_building, p_cashbook) end)
         )
    )
  );
END
$function$
;


-- Preserve the pre-collaboration entry scope for legacy fee auto-approval.
-- Manual drafts can span the company; automatic approval cannot gain scope through viewing.
CREATE OR REPLACE FUNCTION app_private.manager_collaboration_fee_auto_allowed_v1(p_building uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
SELECT NOT EXISTS(
  SELECT 1 FROM public.role_bindings rb
  JOIN app_private.manager_collaboration_roles c ON c.source_role_id=rb.role_id
  JOIN public.organization_memberships m ON m.id=rb.membership_id
  WHERE m.user_id=auth.uid() AND m.status='ACTIVE'
    AND coalesce(rb.valid_from,'-infinity')<=now() AND (rb.valid_to IS NULL OR rb.valid_to>now())
) OR public.is_super_admin()
  OR EXISTS(SELECT 1 FROM public.buildings WHERE id=p_building AND user_id=auth.uid())
  OR app_private.can_without_manager_collaboration_v1('buildings.view',p_building,NULL)
  OR app_private.can_without_manager_collaboration_v1('income_expenses.all_buildings',p_building,NULL);
$fn$;
REVOKE ALL ON FUNCTION app_private.can_without_manager_collaboration_v1(text,uuid,uuid),
  app_private.manager_collaboration_fee_auto_allowed_v1(uuid) FROM PUBLIC,anon,authenticated;


CREATE OR REPLACE FUNCTION app_private.special_fee_approve_and_post_v1(p_voucher_id uuid, p_source_kind text DEFAULT 'SPECIAL_PAGE_FEE'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_ie       public.income_expenses;
  v_acc      public.accounts;
  v_posting  uuid;
  v_actor    uuid := auth.uid();
  v_reversed boolean;
  v_mid      uuid;
BEGIN
  SELECT * INTO v_ie FROM public.income_expenses WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu %', p_voucher_id USING ERRCODE = 'P0002';
  END IF;
  IF v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu % đã huỷ — không ghi sổ', p_voucher_id USING ERRCODE = '55000';
  END IF;

  -- ══ CHỐT LOẠI PHIẾU — hàng rào quan trọng nhất của hàm này ═════════
  -- Hàm này DUYỆT HỘ NGƯỜI DÙNG. Nó tuyệt đối không được chạm vào loại phiếu
  -- mà chủ đã quyết là phải có người duyệt:
  --   • Chủ chốt 31/07: "riêng HOÀN CỌC vẫn chờ duyệt kể cả khi số khớp".
  --   • Phiếu THU (INCOME) không thuộc phạm vi trang đóng phí.
  -- Không có chốt này thì bất kỳ writer nào lỡ gọi nhầm cũng tự duyệt được một
  -- phiếu hoàn cọc — đúng thứ chủ cấm.
  IF v_ie.type IS DISTINCT FROM 'EXPENSE' THEN
    RAISE EXCEPTION
      'Chỉ tự duyệt được phiếu CHI. Phiếu % là loại %.', p_voucher_id, COALESCE(v_ie.type,'(rỗng)')
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_ie.system_source, '') NOT IN ('special_fee.v1', 'fixed_fee', 'utility.bill', 'contract.commission') THEN
    RAISE EXCEPTION
      'Phiếu % không thuộc nhóm phí cố định của trang đóng tiền (nguồn: %) — không tự duyệt.',
      p_voucher_id, COALESCE(v_ie.system_source, '(không rõ)')
      USING ERRCODE = '42501';
  END IF;

  -- ══ (2) REPLAY — phải kiểm bút toán còn SỐNG, không chỉ còn con trỏ ══
  -- Bẫy đã đo được: nếu bút toán cũ ĐÃ BỊ ĐẢO thì trả con trỏ cũ ra rồi đóng
  -- dấu POSTED lên nó = phiếu nói "đã chi" trong khi sổ quỹ nói "chưa" — tiền
  -- biến mất khỏi tồn quỹ mà giao diện vẫn xanh. Phải phân biệt ba trạng thái.
  IF v_ie.active_posting_id_v2 IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.income_expense_postings r
       WHERE r.reversal_of_id = v_ie.active_posting_id_v2 AND r.event_kind = 'REVERSAL'
    ) INTO v_reversed;
    IF v_reversed THEN
      RAISE EXCEPTION
        'Phiếu % đã có bút toán bị ĐẢO — muốn ghi sổ lại phải qua đường ghi sổ lại có kiểm soát, không gọi lại hàm tự duyệt.',
        COALESCE(v_ie.code, p_voucher_id::text)
        USING ERRCODE = '55000';
    END IF;
    RETURN v_ie.active_posting_id_v2;
  END IF;

  -- Bút toán tồn tại theo khoá nguồn nhưng phiếu MẤT con trỏ (a85 xoá con trỏ
  -- khi đảo). Không được ghi đè POSTED lên đó.
  SELECT p.id INTO v_posting
    FROM public.income_expense_postings p
   WHERE p.organization_id = v_ie.organization_id
     AND p.external_source_kind = 'SPECIAL_FEE_VOUCHER'
     AND p.external_source_id   = p_voucher_id
     AND p.event_kind = 'POSTING';
  IF v_posting IS NOT NULL THEN
    RAISE EXCEPTION
      'Phiếu % đã từng được ghi sổ (bút toán %) nhưng con trỏ đã bị gỡ — cần rà tay, không tự ghi lại.',
      COALESCE(v_ie.code, p_voucher_id::text), v_posting
      USING ERRCODE = '55000';
  END IF;

  IF v_ie.account_id IS NULL THEN
    RAISE EXCEPTION 'Phiếu % chưa có sổ quỹ — không tự ghi sổ được', p_voucher_id
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_acc FROM public.accounts WHERE id = v_ie.account_id;
  IF NOT FOUND OR v_acc.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Sổ quỹ của phiếu % không còn hiệu lực', p_voucher_id USING ERRCODE = '22023';
  END IF;
  IF v_acc.organization_id IS DISTINCT FROM v_ie.organization_id THEN
    RAISE EXCEPTION 'Sổ quỹ khác tổ chức của phiếu %', p_voucher_id USING ERRCODE = '42501';
  END IF;

  -- An expanded collaboration scope creates a pending voucher, never a new approval authority.
  IF NOT app_private.manager_collaboration_fee_auto_allowed_v1(v_ie.building_id) THEN
    RETURN NULL;
  END IF;

  -- (3) TẮT CẦU a85/a85b cho transaction này. Xem khối chú thích ở trên.
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (p_voucher_id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
  ON CONFLICT (income_expense_id) DO UPDATE
    SET xid = EXCLUDED.xid, purpose = EXCLUDED.purpose, granted_at = now();

  -- (4) Lật APPROVED nếu chưa. Trigger khoá kỳ sẽ tự lên tiếng ở đây.
  IF v_ie.approval_status IS DISTINCT FROM 'APPROVED' THEN
    UPDATE public.income_expenses
       SET approval_status = 'APPROVED',
           review_state    = 'RESOLVED',
           approved_by     = COALESCE(approved_by, v_actor, user_id),
           approved_at     = COALESCE(approved_at, now())
     WHERE id = p_voucher_id;
  END IF;

  -- ══ SỔ ẢO: DUYỆT NHƯNG KHÔNG GHI SỔ QUỸ ═══════════════════════════
  -- Sổ ảo (cấn cọc, cấn trừ) không có tiền ra khỏi két nên không có bút toán
  -- sổ quỹ. Bản nháp trước NÉM LỖI ở đây — sai, vì hôm nay đóng phí từ sổ ảo
  -- vẫn chạy được (cầu a85b tự bỏ qua sổ ảo và phiếu vẫn APPROVED). Ném lỗi là
  -- LẤY MẤT một năng lực đang có. Giữ đúng hành vi cũ: duyệt, không ghi sổ.
  IF COALESCE(v_acc.is_virtual, false) THEN
    UPDATE public.income_expenses
       SET posting_status = COALESCE(NULLIF(posting_status, 'UNPOSTED'), 'NOT_APPLICABLE'),
           updated_at = now()
     WHERE id = p_voucher_id;
    DELETE FROM app_private.ie_transition_authorization
     WHERE income_expense_id = p_voucher_id AND xid = pg_current_xact_id();
    RETURN NULL;
  END IF;

  -- Lõi đòi một membership để ghi "ai ghi sổ", và cột đó NOT NULL. Người tạo
  -- phiếu có thể đã rời tổ chức ⇒ lõi ném 23502 trần không ai hiểu. Chặn sớm
  -- bằng câu tiếng Việt.
  SELECT om.id INTO v_mid
    FROM public.organization_memberships om
   WHERE om.organization_id = v_ie.organization_id
     AND om.user_id = COALESCE(v_ie.approved_by, v_ie.user_id, v_actor)
     AND om.status = 'ACTIVE'
   LIMIT 1;
  IF v_mid IS NULL AND v_ie.maker_membership_id IS NULL THEN
    RAISE EXCEPTION
      'Không xác định được người ghi sổ cho phiếu % (người tạo không còn là thành viên đang hoạt động) — phiếu đã duyệt nhưng cần vào sổ tay.',
      COALESCE(v_ie.code, p_voucher_id::text)
      USING ERRCODE = '22023';
  END IF;

  -- (5) Lõi dùng chung. Khoá replay là chính phiếu này.
  v_posting := app_private.finance_v2_post_voucher_with_source_v1(
    p_org             => v_ie.organization_id,
    p_voucher_id      => p_voucher_id,
    p_source_kind     => p_source_kind,
    p_external_kind   => 'SPECIAL_FEE_VOUCHER',
    p_external_id     => p_voucher_id,
    p_external_line_id=> NULL,
    p_posted_on       => v_ie.voucher_date,
    p_amount_basis    => 'VOUCHER_TOTAL',
    p_generation      => 1
  );

  -- (6) Con trỏ posting. Token còn hiệu lực nên cầu vẫn im (và a85 không khai
  --     posting_status trong danh sách cột kích hoạt nên nó cũng không chạy).
  UPDATE public.income_expenses
     SET active_posting_id_v2 = v_posting,
         posting_id           = v_posting,
         posting_status       = 'POSTED',
         posting_mode         = COALESCE(posting_mode, 'CASHBOOK'),
         posted_at_v2         = now(),
         updated_at           = now()
   WHERE id = p_voucher_id;

  -- (7) TRẢ TOKEN. Mọi writer cùng họ đều dọn; để lại thì cầu a85 CÂM cho toàn
  --     bộ phần còn lại của transaction — một lệnh xoá/đổi tiền sau đó sẽ không
  --     sinh bút toán đảo, tiền kẹt lại trong sổ.
  DELETE FROM app_private.ie_transition_authorization
   WHERE income_expense_id = p_voucher_id AND xid = pg_current_xact_id();

  RETURN v_posting;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.pay_utility_bill(p_building_id uuid, p_utility_type text, p_amount numeric, p_period_month text, p_voucher_date date DEFAULT NULL::date, p_provider_code text DEFAULT NULL::text, p_account_holder text DEFAULT NULL::text, p_account_id uuid DEFAULT NULL::uuid, p_attachments jsonb DEFAULT NULL::jsonb, p_utility_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_owner   uuid;
  v_acc     uuid;
  v_meter   uuid;
  v_type    uuid;
  v_caller  text;
  v_type_nm text;
  v_vdate   date;
  v_p_start date;
  v_p_end   date;
  v_voucher uuid;
  v_code    text;
  v_total   numeric;
  v_org     uuid;        -- t5_28: org của toà để đọc ngưỡng
  v_threshold numeric;   -- ngưỡng tự duyệt phiếu chi (nếu có)
  v_status  text;        -- trạng thái sinh theo ngưỡng
  v_appr_by uuid;
  v_appr_at timestamptz;
  v_spend_gate jsonb;   -- G5 26/09/2026: cổng bộ máy chi
  v_kind_vn text;        -- Slice −1: "điện"/"nước" cho câu lỗi
  v_dup_code   text;     -- Slice −1 B1: phiếu đã có của đúng slot này
  v_dup_amount numeric;
  v_dup_status text;
  v_meter_code text;     -- Slice −1 B1: mã khách hàng của công tơ ĐANG chọn
  v_meter_cnt  int;      -- Slice −1 B1: số công tơ cùng loại của toà (>1 thì gợi ý chọn lại)
  v_ceiling jsonb;       -- 28/08: verdict trần điện/nước (utility_ceiling_check_v1)
  v_ceiling_verdict text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF p_utility_type NOT IN ('ELECTRIC','WATER') THEN RAISE EXCEPTION 'Loại tiện ích không hợp lệ'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Số tiền phải lớn hơn 0'; END IF;
  IF p_period_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)'; END IF;

  v_kind_vn := CASE WHEN p_utility_type = 'ELECTRIC' THEN 'điện' ELSE 'nước' END;

  SELECT b.user_id, b.organization_id INTO v_owner, v_org
    FROM buildings b WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id) OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid() OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  -- ══ Slice −1 B2: KHÔNG tự tạo công tơ nữa ══════════════════════════
  -- Nhánh ELSE cũ INSERT một dòng building_utility_accounts mới mỗi lần
  -- p_utility_account_id NULL. Giao diện gửi NULL cho MỌI toà/loại chưa khai
  -- công tơ (dòng tổng hợp accountId=null), nên một cú bấm check bình thường
  -- là sinh công tơ trong im lặng; và vì map "đã đóng" khoá theo id công tơ,
  -- dòng vừa sinh không bao giờ hiện "đã đóng" ⇒ mời người dùng bấm lại.
  -- Chặn ở đây là chặn cả hai hệ quả bằng một câu.
  IF p_utility_account_id IS NULL THEN
    RAISE EXCEPTION
      '[UTILITY_METER_REQUIRED] Toà này chưa khai công tơ % — hãy khai công tơ (mã khách hàng / chủ hộ) rồi đóng tiền cho đúng công tơ. Trước đây hệ thống tự tạo công tơ mới mỗi lần bấm, nên dòng đó không bao giờ hiện "đã đóng" và tiền đóng hai lần không ai thấy.',
      v_kind_vn
      USING ERRCODE = '22023';
  END IF;

  SELECT id, NULLIF(btrim(COALESCE(provider_code, '')), '')
    INTO v_meter, v_meter_code
    FROM building_utility_accounts
   WHERE id = p_utility_account_id AND building_id = p_building_id
     AND utility_type = p_utility_type AND deleted_at IS NULL;
  IF v_meter IS NULL THEN RAISE EXCEPTION 'Không tìm thấy đồng hồ điện/nước'; END IF;

  -- Slice −1 B1: toà có MẤY công tơ cùng loại? Cần cho câu lỗi chống trùng.
  -- Ca thật 1392QT: HAI hợp đồng điện riêng (PE13000241972 và PE13000241924,
  -- cùng chủ hộ Hoàng Công Hiệp), mỗi tháng là một hoá đơn lớn + một hoá đơn nhỏ.
  -- Không nói rõ công tơ nào thì người dùng đọc "kỳ này đã có phiếu" sẽ tưởng
  -- mình bấm trùng, trong khi thực tế họ đang trả hoá đơn của công tơ CÒN LẠI.
  SELECT count(*) INTO v_meter_cnt
    FROM building_utility_accounts
   WHERE building_id = p_building_id AND utility_type = p_utility_type
     AND deleted_at IS NULL;

  v_p_start := to_date(p_period_month || '-01', 'YYYY-MM-DD');
  v_p_end   := (date_trunc('month', v_p_start) + interval '1 month - 1 day')::date;

  -- ══ Slice −1 B1: MỘT PHIẾU / MỘT CÔNG TƠ / MỘT KỲ ═════════════════
  -- Khoá tư vấn theo đúng slot TRƯỚC khi đọc: SELECT-rồi-INSERT trần bị đua
  -- (hai tab, hai lần bấm, hai transaction cùng thấy "chưa có" rồi cùng ghi).
  -- Khoá cấp transaction nên tự nhả khi commit/rollback, và chỉ xếp hàng đúng
  -- một slot — không serialize cả bảng.
  -- COALESCE quanh v_org là bắt buộc: pg_advisory_xact_lock STRICT, truyền NULL
  -- thì nó trả NULL và KHÔNG lấy khoá nào — mất chống-đua trong im lặng.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'utility.bill:' || COALESCE(v_org::text, '-') || ':' || v_meter::text || ':'
        || p_utility_type || ':' || to_char(v_p_start, 'YYYY-MM'),
      0
    )
  );

  -- Khoá nghiệp vụ = (org, công tơ, loại tiện ích, tháng tính tiền). Không cần
  -- viết org và loại vào WHERE: id công tơ QUYẾT ĐỊNH cả hai (công tơ thuộc
  -- đúng một toà, và ở trên đã kiểm building_id + utility_type khớp) — thêm
  -- `organization_id = v_org` vào đây chỉ tạo nguy cơ BỎ SÓT nếu có phiếu cũ
  -- org NULL, tức tự vô hiệu hoá chính chốt này.
  -- Tháng lấy từ ITEM (income_expenses không có cột kỳ); date_trunc để chịu
  -- được 19 phiếu lịch sử có start_date không nằm ngày 1.
  -- CỐ Ý ĐẾM CẢ 'UNAPPROVED': phiếu chờ duyệt là phiếu VÔ HÌNH trên bảng
  -- điện/nước (reader lọc APPROVED) — đó chính là lý do người dùng bấm lại.
  -- KHÔNG đếm phiếu đã huỷ: huỷ mềm (cancel_utility_bill đặt deleted_at) hoặc
  -- huỷ linh hoạt Đợt 4 (approval_status='CANCELLED') ⇒ đóng lại được.
  SELECT ie.code, ie.total_amount, ie.approval_status
    INTO v_dup_code, v_dup_amount, v_dup_status
    FROM income_expenses ie
   WHERE ie.system_source = 'utility.bill'
     AND ie.utility_account_id = v_meter
     AND ie.deleted_at IS NULL
     AND ie.approval_status <> 'CANCELLED'
     AND EXISTS (
       SELECT 1 FROM income_expense_items it
        WHERE it.income_expense_id = ie.id
          AND it.start_date IS NOT NULL
          AND date_trunc('month', it.start_date)::date = v_p_start
     )
   ORDER BY ie.created_at, ie.id
   LIMIT 1;

  IF v_dup_code IS NOT NULL THEN
    RAISE EXCEPTION
      '[UTILITY_BILL_DUPLICATE] Kỳ % của công tơ % ĐÃ CÓ phiếu chi % — %đ (%). Không tạo phiếu thứ hai. Nếu phiếu cũ đang chờ duyệt thì DUYỆT nó; nếu phiếu cũ sai thì HUỶ nó rồi đóng lại.%',
      to_char(v_p_start, 'MM/YYYY'),
      COALESCE(v_meter_code, 'này'),
      v_dup_code,
      round(COALESCE(v_dup_amount, 0))::bigint::text,
      CASE v_dup_status WHEN 'UNAPPROVED' THEN 'đang chờ duyệt' ELSE 'đã duyệt' END,
      -- Gợi ý chỉ hiện khi toà THẬT SỰ có nhiều công tơ cùng loại — nếu không thì
      -- thêm câu này chỉ làm người dùng đi tìm một công tơ không tồn tại.
      CASE WHEN COALESCE(v_meter_cnt, 1) > 1
           THEN format(' Lưu ý: toà này có %s công tơ %s. Nếu hoá đơn bạn đang trả thuộc công tơ khác thì hãy chọn đúng công tơ đó rồi đóng lại.',
                       v_meter_cnt, v_kind_vn)
           ELSE '' END
      USING ERRCODE = '55000';
  END IF;

  -- Sổ ghi chi (mặc định "…Thu" caller)
  IF p_account_id IS NOT NULL THEN
    SELECT id INTO v_acc FROM accounts
     WHERE id = p_account_id AND deleted_at IS NULL
       AND (user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
    IF v_acc IS NULL THEN RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501'; END IF;
  ELSE
    SELECT id INTO v_acc FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_acc IS NULL THEN RAISE EXCEPTION 'Bạn chưa có sổ quỹ "…Thu" để chi tiền'; END IF;
  END IF;

  -- Học siêu dữ liệu công tơ — dời xuống SAU chốt chống trùng để một lần bấm
  -- bị từ chối không để lại thay đổi nào.
  UPDATE building_utility_accounts SET
    provider_code  = COALESCE(NULLIF(btrim(p_provider_code), ''), provider_code),
    account_holder = COALESCE(NULLIF(btrim(p_account_holder), ''), account_holder),
    updated_at = now()
  WHERE id = v_meter;

  -- t5_28: hoá đơn điện/nước là phiếu CHI → tôn trọng NGƯỠNG tự duyệt của org.
  -- Dưới ngưỡng (hoặc chưa đặt ngưỡng) → tự duyệt như cũ; từ ngưỡng trở lên →
  -- sinh NHÁP chờ duyệt tay (khớp phương án owner + create_income_expense_v1).
  --
  -- 26/08/2026: NGƯỜI LẬP PHIẾU MÀ CÓ QUYỀN DUYỆT đi thẳng, không qua ngưỡng.
  -- Đây đúng là luật chủ đã chốt 25/07/2026 cho create_income_expense_v1 (biến
  -- v_maker_can_approve), nhưng nó chưa bao giờ được áp cho hai RPC của trang
  -- Thanh toán. Hệ quả đo được: cùng một số tiền, nhập tay ở form Thu chi thì
  -- tự duyệt, còn bấm nút đóng tiền ở /thanh-toan lại sinh phiếu CHỜ DUYỆT rồi
  -- bắt chính người có quyền duyệt sang màn hình khác bấm lần hai.
  --
  -- Ngưỡng KHÔNG bị nới: nó giữ nguyên cho người không có quyền duyệt — đó mới
  -- là đối tượng nó sinh ra để soát.
  SELECT c.threshold INTO v_threshold
    FROM app_private.ie_auto_approve_config c WHERE c.organization_id = v_org;
  IF COALESCE(app_private.ie_maker_can_approve_v1(p_building_id), false) THEN
    v_status := 'APPROVED'; v_appr_by := auth.uid(); v_appr_at := now();
  ELSIF v_threshold IS NOT NULL AND p_amount >= v_threshold THEN
    v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
  ELSE
    v_status := 'APPROVED'; v_appr_by := auth.uid(); v_appr_at := now();
  END IF;

  -- ══ 28/08 — TRẦN ĐIỆN/NƯỚC (nối động cơ 20260801040000 vào writer) ═════
  -- Động cơ utility_ceiling_check_v1 tồn tại từ 01/08 nhưng KHÔNG writer nào
  -- gọi — trần chủ công bố là hình vẽ. Từ nay: phiếu VƯỢT TRẦN thì hạ về CHỜ
  -- DUYỆT, kể cả người-có-quyền-duyệt (họ duyệt được ngay sau đó, nhưng phải
  -- NHÌN cảnh báo một lần — trần sinh ra để bắt người nhìn số bất thường, và
  -- người bấm nhanh nhất chính là người có quyền). Không có trần (NO_RULE) ⇒
  -- hành vi y như cũ. KHÔNG chặn cứng: sai trần thì tệ nhất là chờ duyệt.
  v_ceiling := app_private.utility_ceiling_check_v1(
                 v_org, p_building_id, p_utility_type, v_p_start, p_amount);
  v_ceiling_verdict := COALESCE(v_ceiling->>'verdict', 'NO_RULE');
  IF v_ceiling_verdict IN ('OVER_CEILING', 'OVER_RATIO') THEN
    v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
  END IF;

  v_type_nm := CASE WHEN p_utility_type = 'ELECTRIC' THEN 'Đóng tiền điện' ELSE 'Đóng tiền nước' END;
  v_type := public._termination_ensure_type(v_owner, 'expense', v_type_nm);
  UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;
  -- G5 (26/09/2026): hỏi bộ máy chi (kiểu TRẦN của hạng mục điện/nước). Cổng chưa áp ⇒ giữ
  -- nguyên thang ngưỡng + trần ở trên. Không đụng khối INSERT mẫu neo bên dưới.
  v_spend_gate := app_private.ie_spend_gate_v1(
    v_org, p_building_id, 'EXPENSE', 'pay_utility_bill', 'utility.bill', v_acc,
    COALESCE(p_voucher_date, public.org_today_v1(NULL)),
    jsonb_build_array(jsonb_build_object('type_id', v_type, 'amount', p_amount,
                                         'start_date', v_p_start, 'end_date', v_p_end)));
  IF COALESCE((v_spend_gate->>'enforce')::boolean, false) THEN
    IF v_spend_gate->>'status' = 'APPROVED' THEN
      v_status := 'APPROVED'; v_appr_by := auth.uid(); v_appr_at := now();
    ELSE
      v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
    END IF;
  END IF;

  IF NOT app_private.manager_collaboration_fee_auto_allowed_v1(p_building_id) THEN
    v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
  END IF;

  v_vdate   := COALESCE(p_voucher_date, public.org_today_v1(NULL));
  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();

  -- ⚠ HAI DÒNG DƯỚI LÀ MẪU NEO của 20260724120000 — giữ VERBATIM (mục 5 tự kiểm).
  INSERT INTO income_expenses
    (user_id, organization_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, approved_by, approved_at,
     business_result_accounting, notes, creator_name,
     attachments, system_source, utility_account_id)
  VALUES
    (auth.uid(), v_org, 'EXPENSE',
     'Đóng ' || lower(v_type_nm) || ' (NCC) — kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     p_building_id, v_acc, v_vdate,
     p_amount, v_status, v_appr_by, v_appr_at, TRUE,
     'Chủ nhà đóng ' || lower(v_type_nm) || ' cho cả toà — kỳ ' || to_char(v_p_start, 'MM/YYYY')
       || COALESCE(' — mã ' || NULLIF(btrim(p_provider_code), ''), '')
       || COALESCE(' — chủ hộ ' || NULLIF(btrim(p_account_holder), ''), ''),
     v_caller,
     COALESCE(p_attachments, '[]'::jsonb), 'utility.bill', v_meter)
  RETURNING id INTO v_voucher;

  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES
    (v_voucher, v_type, 'Đóng ' || lower(v_type_nm) || ' kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     1, p_amount, v_p_start, v_p_end);

  -- Vượt trần: nối lý do vào ghi chú SAU insert — khối INSERT là MẪU NEO của
  -- 20260724120000, không được sửa một ký tự nào trong đó.
  IF v_ceiling_verdict IN ('OVER_CEILING', 'OVER_RATIO') THEN
    UPDATE income_expenses
       SET notes = notes || ' — [VƯỢT TRẦN ' || v_kind_vn || '] '
                 || COALESCE(v_ceiling->>'reason', 'vượt trần đã công bố')
                 || ' — phiếu chuyển CHỜ DUYỆT.'
     WHERE id = v_voucher;
  END IF;

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;
  RETURN jsonb_build_object('voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc, 'utility_account_id', v_meter,
    'ceilingVerdict', v_ceiling_verdict,
    'spendDecision', v_spend_gate - 'facts');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.generate_special_fees_v1(p_period text, p_building_ids uuid[], p_idempotency_key text, p_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_m0    date;
  v_m1    date;
  v_route text;
  v_key   text := btrim(COALESCE(p_idempotency_key,''));
  r       record;
  v_type  uuid;
  v_ie    uuid;
  v_code  text;
  v_n     int := 0;
  v_sum   numeric := 0;
  v_ids   uuid[] := '{}';
  v_label text;
  -- SPECIAL_FEE_AUTOPOST_V1
  v_acc      uuid;
  v_posted   int := 0;
  v_rule     jsonb;
  v_spend_gate jsonb;  -- G5 26/09/2026: cổng bộ máy chi
BEGIN
  -- Sổ quỹ (tuỳ chọn): có thì máy duyệt hộ + ghi sổ; không có thì y như cũ.
  IF p_account_id IS NOT NULL THEN
    SELECT a.id INTO v_acc FROM public.accounts a
     WHERE a.id = p_account_id AND a.deleted_at IS NULL
       AND NOT COALESCE(a.is_virtual, false);
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc là SỔ ẢO — phí cố định là tiền thật ra khỏi két'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_period !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)' USING ERRCODE='22023';
  END IF;
  IF char_length(v_key) < 8 OR char_length(v_key) > 200
     OR v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE='22023';
  END IF;
  IF p_building_ids IS NULL OR array_length(p_building_ids,1) IS NULL THEN
    RAISE EXCEPTION 'Phải chọn ít nhất một toà' USING ERRCODE='22023';
  END IF;

  v_m0 := to_date(p_period || '-01','YYYY-MM-DD');
  v_m1 := (date_trunc('month', v_m0) + interval '1 month - 1 day')::date;

  SELECT b.organization_id INTO v_org FROM buildings b
   WHERE b.id = p_building_ids[1] AND b.deleted_at IS NULL;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE='22023'; END IF;

  -- Mọi toà phải cùng org — không cho một lượt sinh chéo tổ chức.
  IF EXISTS (SELECT 1 FROM buildings b
              WHERE b.id = ANY(p_building_ids)
                AND (b.deleted_at IS NOT NULL OR b.organization_id IS DISTINCT FROM v_org)) THEN
    RAISE EXCEPTION 'Danh sách toà có toà đã xoá hoặc thuộc tổ chức khác' USING ERRCODE='42501';
  END IF;

  -- ROUTE OFF: cỗ máy này tự đẻ phiếu hàng loạt nên phải có công tắc riêng.
  v_route := app_private.evaluate_feature_route('special_fee.generate.v1', v_org);
  IF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION
      'Tính năng sinh phiếu phí cố định hàng loạt chưa được bật cho tổ chức này (route %). Bật cờ special_fee.generate.v1 rồi thử lại.',
      v_route USING ERRCODE = '55000';
  END IF;

  -- Khoá theo (org, kỳ): hai người bấm cùng lúc thì xếp hàng, không đẻ hai lượt.
  PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended('special_fee:'||v_org::text||':'||p_period, 0));

  FOR r IN
    SELECT * FROM public.preview_special_fees_v1(p_period, p_building_ids)
     WHERE status = 'SẼ_SINH'
  LOOP
    -- Quyền theo từng toà — preview đã lọc, nhưng writer không tin preview.
    IF NOT (public.can_access_building(r.building_id)
         OR public.ie_all_buildings_scope(r.building_id)
         OR public.is_admin() OR public.is_super_admin()) THEN
      CONTINUE;
    END IF;
    IF r.fee_category = 'quan_ly' AND NOT public.can_create_restricted_ie() THEN
      CONTINUE;   -- hạng mục hạn chế: bỏ qua thay vì làm hỏng cả lượt
    END IF;

    v_label := CASE r.fee_category
                 WHEN 'tien_nha' THEN 'Tiền nhà'   WHEN 'dien' THEN 'Tiền điện'
                 WHEN 'nuoc' THEN 'Tiền nước'      WHEN 'internet' THEN 'Internet'
                 WHEN 'quan_ly' THEN 'Quản Lý'     WHEN 've_sinh' THEN 'Vệ sinh định kỳ'
                 WHEN 'cong_an' THEN 'Công An'     WHEN 'rac' THEN 'Rác'
                 ELSE 'Thang máy' END;

    -- G5 (26/09/2026): dùng hạng mục đã ánh xạ (G3) cho khoá phí — luật chi đọc trên chính
    -- hạng mục đó; khoá chưa ánh xạ mới rơi về tìm/tạo theo tên như cũ.
    SELECT t.id INTO v_type FROM public.income_expense_types t
     WHERE t.organization_id = v_org AND t.fee_category = r.fee_category;
    IF v_type IS NULL THEN
      v_type := app_private.ensure_income_expense_type_v1(
                  v_org, v_actor, v_label, 'expense', NULL, NULL, false, false,
                  (r.fee_category = 'quan_ly'), false, false, false);
    END IF;

    INSERT INTO income_expenses
      (user_id, organization_id, type, name, building_id, voucher_date,
       total_amount, approval_status, system_source, notes)
    VALUES
      (v_actor, v_org, 'EXPENSE',
       v_label || ' ' || r.building_name || ' kỳ ' || p_period,
       r.building_id, public.org_today_v1(v_org),
       r.amount, 'UNAPPROVED', 'special_fee.v1',
       'Sinh tự động cho kỳ ' || p_period)
    RETURNING id, code INTO v_ie, v_code;

    INSERT INTO income_expense_items
      (income_expense_id, income_expense_type_id, accounting_class,
       description, quantity, unit_price, amount, start_date, end_date)
    VALUES
      (v_ie, v_type, 'PNL', 'Kỳ ' || p_period, 1, r.amount, r.amount, v_m0, v_m1);

    INSERT INTO special_fee_claims
      (organization_id, building_id, fee_category, period_month, amount,
       voucher_id, generated_by, batch_key)
    VALUES (v_org, r.building_id, r.fee_category, v_m0, r.amount, v_ie, v_actor, v_key);

    IF v_acc IS NOT NULL AND app_private.manager_collaboration_fee_auto_allowed_v1(r.building_id) THEN
      UPDATE income_expenses SET account_id = v_acc WHERE id = v_ie;
      v_rule := app_private.special_fee_rule_check_v1(
                  v_org, r.building_id, r.fee_category, v_m0, v_m1, r.amount);
      -- G5 (26/09/2026): hỏi bộ máy chi; cổng chưa áp ⇒ giữ luật SPECIAL_FEE_AUTOPOST_V1.
      v_spend_gate := app_private.ie_spend_gate_v1(
        v_org, r.building_id, 'EXPENSE', 'generate_special_fees_v1', 'special_fee.v1', v_acc,
        public.org_today_v1(v_org),
        jsonb_build_array(jsonb_build_object('type_id', v_type, 'amount', r.amount,
                                             'start_date', v_m0, 'end_date', v_m1)),
        v_ie);
      IF COALESCE((v_spend_gate->>'enforce')::boolean, false) THEN
        IF v_spend_gate->>'status' = 'APPROVED' THEN
          PERFORM app_private.special_fee_approve_and_post_v1(v_ie, 'SPECIAL_PAGE_FEE');
          v_posted := v_posted + 1;
        END IF;
      ELSIF (v_rule->>'verdict') IN ('VALID', 'CONFIG_REQUIRED') THEN
        PERFORM app_private.special_fee_approve_and_post_v1(v_ie, 'SPECIAL_PAGE_FEE');
        v_posted := v_posted + 1;
      END IF;
    END IF;

    v_n := v_n + 1; v_sum := v_sum + r.amount; v_ids := v_ids || v_ie;
  END LOOP;

  RETURN jsonb_build_object(
    'period', p_period, 'organizationId', v_org, 'batchKey', v_key,
    'created', v_n, 'totalAmount', v_sum, 'voucherIds', to_jsonb(v_ids),
    'posted', v_posted,
    'note', CASE WHEN v_acc IS NULL
      THEN 'Phiếu sinh ra ở trạng thái CHỜ DUYỆT — máy đề xuất, người duyệt.'
      ELSE v_posted || '/' || v_n || ' phiếu đã tự duyệt và vào sổ; phần còn lại chờ duyệt vì lệch giá đã công bố.'
    END);
END;
$function$
;

CREATE OR REPLACE FUNCTION app_private.manager_collaboration_binding_changed_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM public.role_bindings WHERE id IN (
      SELECT supplemental_binding_id FROM app_private.manager_collaboration_bindings WHERE source_binding_id=OLD.id);
    RETURN OLD;
  END IF;
  IF EXISTS(SELECT 1 FROM app_private.manager_collaboration_roles WHERE source_role_id=NEW.role_id)
    OR EXISTS(SELECT 1 FROM app_private.manager_collaboration_bindings WHERE source_binding_id=NEW.id)
  THEN PERFORM app_private.sync_manager_collaboration_v1(NEW.id); END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.manager_collaboration_binding_changed_v1() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS manager_collaboration_binding_write ON public.role_bindings;
CREATE TRIGGER manager_collaboration_binding_write AFTER INSERT OR UPDATE ON public.role_bindings
  FOR EACH ROW EXECUTE FUNCTION app_private.manager_collaboration_binding_changed_v1();
DROP TRIGGER IF EXISTS manager_collaboration_binding_delete ON public.role_bindings;
CREATE TRIGGER manager_collaboration_binding_delete BEFORE DELETE ON public.role_bindings
  FOR EACH ROW EXECUTE FUNCTION app_private.manager_collaboration_binding_changed_v1();

CREATE OR REPLACE FUNCTION app_private.manager_collaboration_possession_changed_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE v_binding uuid;
BEGIN
  FOR v_binding IN SELECT b.id FROM public.role_bindings b
    JOIN app_private.manager_collaboration_roles c ON c.source_role_id=b.role_id
    WHERE b.membership_id=CASE WHEN TG_OP='DELETE' THEN OLD.membership_id ELSE NEW.membership_id END
      OR (TG_OP='UPDATE' AND b.membership_id=OLD.membership_id)
  LOOP PERFORM app_private.sync_manager_collaboration_v1(v_binding); END LOOP;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.manager_collaboration_possession_changed_v1() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS manager_collaboration_possession_write ON public.cashbook_possession_bindings;
CREATE TRIGGER manager_collaboration_possession_write AFTER INSERT OR UPDATE OR DELETE ON public.cashbook_possession_bindings
  FOR EACH ROW EXECUTE FUNCTION app_private.manager_collaboration_possession_changed_v1();

CREATE OR REPLACE FUNCTION app_private.manager_collaboration_role_status_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  UPDATE public.organization_roles SET status=NEW.status
  WHERE id IN (SELECT company_role_id FROM app_private.manager_collaboration_roles WHERE source_role_id=NEW.id
    UNION ALL SELECT cashbook_role_id FROM app_private.manager_collaboration_roles WHERE source_role_id=NEW.id
    UNION ALL SELECT cashbook_reader_role_id FROM app_private.manager_collaboration_roles WHERE source_role_id=NEW.id);
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.manager_collaboration_role_status_v1() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS manager_collaboration_role_status ON public.organization_roles;
CREATE TRIGGER manager_collaboration_role_status AFTER UPDATE OF status ON public.organization_roles
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app_private.manager_collaboration_role_status_v1();

CREATE OR REPLACE FUNCTION public.configure_manager_collaboration_v1(p_organization_id uuid,p_source_role_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  source public.organization_roles%ROWTYPE;
  cfg app_private.manager_collaboration_roles%ROWTYPE;
  v_binding uuid;
  v_count integer:=0;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.organization_id=p_organization_id AND m.user_id=auth.uid() AND m.member_type='OWNER'
      AND m.status='ACTIVE' AND o.status='ACTIVE'
      AND coalesce(m.valid_from,'-infinity')<=now() AND (m.valid_to IS NULL OR m.valid_to>now())
  ) THEN RAISE EXCEPTION 'Only an active organization owner may configure manager collaboration' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('manager-collaboration:'||p_organization_id::text,0));
  SELECT * INTO source FROM public.organization_roles
    WHERE id=p_source_role_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND OR source.status<>'ACTIVE' OR EXISTS(
    SELECT 1 FROM app_private.manager_collaboration_roles
    WHERE company_role_id=p_source_role_id OR cashbook_role_id=p_source_role_id OR cashbook_reader_role_id=p_source_role_id
  ) THEN RAISE EXCEPTION 'Invalid source manager role' USING ERRCODE='22023'; END IF;
  IF EXISTS (
    SELECT 1 FROM app_private.manager_collaboration_catalog_v1() c
    LEFT JOIN public.permission_definitions p ON p.key=c.permission_key AND p.is_active
    WHERE p.key IS NULL OR (c.scope_kind IN ('company','self') AND NOT 'ORGANIZATION'=ANY(p.scope_kinds))
      OR (c.scope_kind='cashbook' AND NOT 'CASHBOOK'=ANY(p.scope_kinds))
  ) THEN RAISE EXCEPTION 'Collaboration catalog does not match permission definitions'; END IF;
  -- Additive grants respect existing explicit DENY overrides. Never revoke them
  -- while configuring a role: they also govern other roles and survive expiry.
  SELECT * INTO cfg FROM app_private.manager_collaboration_roles WHERE source_role_id=p_source_role_id;
  IF NOT FOUND THEN
    cfg.organization_id:=p_organization_id; cfg.source_role_id:=p_source_role_id;
    cfg.company_role_id:=gen_random_uuid(); cfg.cashbook_role_id:=gen_random_uuid(); cfg.cashbook_reader_role_id:=gen_random_uuid();
    INSERT INTO public.organization_roles(id,organization_id,name,status)
    VALUES (cfg.company_role_id,p_organization_id,source.name||' · Cộng tác công ty','ACTIVE'),
           (cfg.cashbook_role_id,p_organization_id,source.name||' · Sổ quỹ được giao','ACTIVE'),
           (cfg.cashbook_reader_role_id,p_organization_id,source.name||' · Biết sổ và nhận bàn giao','ACTIVE');
    INSERT INTO app_private.manager_collaboration_roles VALUES
      (cfg.organization_id,cfg.source_role_id,cfg.company_role_id,cfg.cashbook_role_id,cfg.cashbook_reader_role_id);
  END IF;
  INSERT INTO public.role_permissions(organization_id,role_id,permission_key,effect)
    SELECT DISTINCT p_organization_id,CASE WHEN c.scope_kind='cashbook' THEN cfg.cashbook_role_id ELSE cfg.company_role_id END,
      c.permission_key,'ALLOW' FROM app_private.manager_collaboration_catalog_v1() c
    ON CONFLICT DO NOTHING;
  -- Knowing a cashbook is not permission to spend or propose closing it.
  -- Confirming still requires being the named receiver of the closing request.
  INSERT INTO public.role_permissions(organization_id,role_id,permission_key,effect)
    VALUES(p_organization_id,cfg.cashbook_reader_role_id,'cashbooks.view','ALLOW'),
          (p_organization_id,cfg.cashbook_reader_role_id,'cashbooks.close_confirm','ALLOW') ON CONFLICT DO NOTHING;
  FOR v_binding IN SELECT id FROM public.role_bindings
    WHERE role_id=p_source_role_id AND organization_id=p_organization_id
  LOOP PERFORM app_private.sync_manager_collaboration_v1(v_binding); v_count:=v_count+1; END LOOP;
  RETURN jsonb_build_object('sourceBindings',v_count,'companyRoleId',cfg.company_role_id,'cashbookRoleId',cfg.cashbook_role_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.configure_manager_collaboration_v1(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.configure_manager_collaboration_v1(uuid,uuid) TO authenticated;

-- Customers are company records. Preserve the active-contract guard, authorize
CREATE OR REPLACE FUNCTION app_private.authorize_collaborative_income_expense_v1(
  p_actor uuid,p_organization_id uuid,p_action text,p_building_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF app_private.authorize_income_expense_on_building(p_actor,p_organization_id,p_action,p_building_id) THEN RETURN true; END IF;
  -- Restricted categories keep their old authorization; only selected creation expands.
  RETURN p_action='create' AND p_actor=auth.uid() AND EXISTS(
    SELECT 1 FROM public.role_bindings rb
    JOIN app_private.manager_collaboration_roles c ON c.source_role_id=rb.role_id
    JOIN public.organization_memberships m ON m.id=rb.membership_id
    WHERE m.user_id=p_actor AND m.organization_id=p_organization_id AND m.status='ACTIVE'
      AND coalesce(rb.valid_from,'-infinity')<=now() AND (rb.valid_to IS NULL OR rb.valid_to>now())
  ) AND coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(
    p_actor,p_organization_id,'income_expenses.create',p_building_id,NULL)),false);
END $fn$;
REVOKE ALL ON FUNCTION app_private.authorize_collaborative_income_expense_v1(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.create_income_expense_v1(p_type text, p_name text, p_building_id uuid, p_room_id uuid, p_tenant_id uuid, p_contract_id uuid, p_payer_name text, p_receive_bank_account text, p_receive_bank_name text, p_account_id uuid, p_attachments jsonb, p_business_result_accounting boolean, p_notes text, p_voucher_date date, p_items jsonb, p_idempotency_key text)
 RETURNS income_expenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

DECLARE

  -- t5_23/24: trạng thái sinh theo phương án org (cờ hạng mục + ngưỡng chi)
  v_birth_status text;
  v_birth_by uuid;
  v_birth_at timestamptz;
  v_force_cat boolean;
  v_auto_threshold numeric;
  v_maker_can_approve boolean := false;
  v_spend_gate jsonb;  -- G5 26/09/2026: cổng bộ máy chi

  v_actor uuid := app_private.current_uid_v1();

  v_claim_cap text;

  v_actor_name text;

  v_name text;

  v_org uuid;

  v_membership_id uuid;

  v_room_id uuid := p_room_id;

  v_tenant_id uuid := p_tenant_id;

  v_contract_room_id uuid;

  v_contract_tenant_id uuid;

  v_contract_deposit_paid_before public.contracts.deposit_paid%TYPE;

  v_contract_updated_at_before public.contracts.updated_at%TYPE;

  v_room_status_before public.rooms.status%TYPE;

  v_room_updated_at_before public.rooms.updated_at%TYPE;

  v_account_owner_id uuid;

  v_account_lock_date date;

  v_account_is_shared boolean := false;

  v_can_create_on_building boolean := false;

  v_can_create_restricted boolean := false;

  v_requires_restricted boolean := false;

  v_row public.income_expenses;

  v_operation app_private.canonical_write_operations%ROWTYPE;

  v_feature app_private.server_feature_flags%ROWTYPE;

  v_feature_route text;

  v_feature_operation_key text;

  v_feature_evaluated_at timestamptz;

  v_item jsonb;

  v_item_count integer;

  v_accrual_bucket_count integer := 0;

  v_index integer := 0;

  v_type_id uuid;

  v_type_is_restricted boolean;

  v_type_is_deposit boolean;

  v_type_normalized_name text;
  v_type_system_only boolean;

  v_quantity numeric;

  v_unit_price_raw numeric;

  v_unit_price numeric;

  v_start_date date;

  v_end_date date;

  v_description text;

  v_expected_type text;

  v_canonical_items jsonb := '[]'::jsonb;

  v_canonical_payload jsonb;

  v_payload_hash text;

  v_idempotency_key text;

  v_total_amount numeric := 0;

  v_feature_operation_count bigint;

  v_feature_total_amount numeric;

  v_stored_item_count bigint;

  v_stored_total_amount numeric;

  v_stored_has_restricted boolean;

  v_stored_counts_in_business_result boolean;

  v_stored_kqkd_amount numeric;
  v_stored_pnl_sum numeric;
  v_stored_has_deposit_item boolean;
  v_room_status_after public.rooms.status%TYPE;
  v_room_updated_at_after public.rooms.updated_at%TYPE;
  v_contract_deposit_paid_after public.contracts.deposit_paid%TYPE;
  v_contract_updated_at_after public.contracts.updated_at%TYPE;

  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);

  c_max_money constant numeric := 9999999999999.99;

  c_max_attachments constant integer := 20;

  c_max_attachment_length constant integer := 2048;

  c_max_name_length constant integer := 500;

  c_max_short_text_length constant integer := 255;

  c_max_notes_length constant integer := 5000;

  c_max_item_description_length constant integer := 1000;

  c_max_item_period_days constant integer := 3660;

  c_max_accrual_buckets constant integer := 2400;

  c_extra_whitespace constant text :=

    chr(160) || chr(173) || chr(5760)

    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)

    || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)

    || chr(8202) || chr(8203) || chr(8232) || chr(8233) || chr(8239)

    || chr(8287) || chr(8288) || chr(12288) || chr(65279);

BEGIN

  IF v_actor IS NULL THEN

    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';

  END IF;

  -- A.9 smallest-shape: actor display name via postgres-owned DEFINER delegate

  -- (auth.users/profiles RLS is not part of the writer role's capability set).

  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);

  IF v_actor_name IS NULL THEN

    RAISE EXCEPTION 'Không tìm thấy người dùng hiện tại' USING ERRCODE = '42501';

  END IF;

  -- Platform administration is not tenant business authority. A platform actor

  -- must also hold an active tenant membership and normalized tenant permission;

  -- emergency platform operations belong to a separate, audited endpoint.

  IF p_type NOT IN ('INCOME', 'EXPENSE') THEN

    RAISE EXCEPTION 'Loại phiếu không hợp lệ';

  END IF;

  v_name := btrim(p_name, E' \t\n\r\f\v' || c_extra_whitespace);

  IF p_name IS NULL OR v_name = '' THEN

    RAISE EXCEPTION 'Tên phiếu không được trống';

  END IF;

  IF char_length(v_name) > c_max_name_length THEN

    RAISE EXCEPTION 'Tên phiếu vượt quá % ký tự', c_max_name_length;

  END IF;

  IF p_building_id IS NULL THEN

    RAISE EXCEPTION 'Thiếu building_id';

  END IF;

  IF p_voucher_date IS NULL

     OR NOT isfinite(p_voucher_date)

     OR p_voucher_date < DATE '2000-01-01'

     OR p_voucher_date > DATE '2100-12-31' THEN

    RAISE EXCEPTION 'Ngày phiếu phải nằm trong khoảng 2000-01-01 đến 2100-12-31';

  END IF;

  v_idempotency_key := btrim(p_idempotency_key);

  IF v_idempotency_key IS NULL

     OR char_length(v_idempotency_key) < 8

     OR char_length(v_idempotency_key) > 200

     OR v_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN

    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII và chỉ chứa A-Z, a-z, 0-9, ., _, :, -';

  END IF;

  IF p_payer_name IS NOT NULL

     AND char_length(btrim(p_payer_name)) > c_max_short_text_length THEN

    RAISE EXCEPTION 'Tên người nộp/nhận vượt quá % ký tự', c_max_short_text_length;

  END IF;

  IF p_receive_bank_account IS NOT NULL

     AND char_length(btrim(p_receive_bank_account)) > c_max_short_text_length THEN

    RAISE EXCEPTION 'Số tài khoản nhận vượt quá % ký tự', c_max_short_text_length;

  END IF;

  IF p_receive_bank_name IS NOT NULL

     AND char_length(btrim(p_receive_bank_name)) > c_max_short_text_length THEN

    RAISE EXCEPTION 'Tên ngân hàng nhận vượt quá % ký tự', c_max_short_text_length;

  END IF;

  IF p_notes IS NOT NULL AND char_length(p_notes) > c_max_notes_length THEN

    RAISE EXCEPTION 'Ghi chú vượt quá % ký tự', c_max_notes_length;

  END IF;

  IF jsonb_typeof(v_attachments) <> 'array'

     OR jsonb_array_length(v_attachments) > c_max_attachments

     OR EXISTS (

       SELECT 1

         FROM jsonb_array_elements(v_attachments) x(value)

        WHERE jsonb_typeof(value) <> 'string'

           OR char_length(value #>> '{}') < 1

           OR char_length(value #>> '{}') > c_max_attachment_length

           OR value #>> '{}' ~ '[[:cntrl:]]'

           OR value #>> '{}' !~

                '^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:[/?#][^[:space:]\\]*)?$'

     ) THEN

    RAISE EXCEPTION 'attachments phải là mảng tối đa % HTTPS URL an toàn, mỗi URL dài 1-% ký tự',

      c_max_attachments, c_max_attachment_length;

  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN

    RAISE EXCEPTION 'items phải là mảng';

  END IF;

  v_item_count := jsonb_array_length(p_items);

  IF v_item_count < 1 OR v_item_count > 200 THEN

    RAISE EXCEPTION 'Phiếu phải có từ 1 đến 200 hạng mục';

  END IF;

  -- Lock order: organization/building → membership → staff/role scope → room →

  -- tenant → contract/contract_tenant → account/share → item types → feature row.

  SELECT b.organization_id

    INTO v_org

    FROM public.buildings b

    JOIN public.organizations o

      ON o.id = b.organization_id

     AND o.status = 'ACTIVE'

   WHERE b.id = p_building_id

     AND b.deleted_at IS NULL

   FOR SHARE OF o, b;

  IF NOT FOUND OR v_org IS NULL THEN

    RAISE EXCEPTION 'Không tìm thấy toà nhà trong tổ chức đang hoạt động'

      USING ERRCODE = '42501';

  END IF;

  SELECT m.id

    INTO v_membership_id

    FROM public.organization_memberships m

   WHERE m.user_id = v_actor

     AND m.organization_id = v_org

     AND m.status = 'ACTIVE'

     AND m.valid_from <= clock_timestamp()

     AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)

   ORDER BY m.id

   LIMIT 1

   FOR SHARE;

  IF NOT FOUND THEN

    RAISE EXCEPTION 'Không còn là thành viên đang hoạt động của tổ chức'

      USING ERRCODE = '42501';

  END IF;

  v_can_create_on_building :=

    app_private.authorize_collaborative_income_expense_v1(

      v_actor, v_org, 'create', p_building_id

    );

  v_can_create_restricted :=

    app_private.authorize_collaborative_income_expense_v1(

      v_actor, v_org, 'restricted_create', p_building_id

    );

  IF p_room_id IS NOT NULL THEN

    PERFORM 1

      FROM public.rooms r

     WHERE r.id = p_room_id

       AND r.deleted_at IS NULL

       AND r.building_id = p_building_id

       AND r.organization_id = v_org

     FOR SHARE;

    IF NOT FOUND THEN

      RAISE EXCEPTION 'Phòng không thuộc toà/tổ chức của phiếu'

        USING ERRCODE = '42501';

    END IF;

  END IF;

  IF p_tenant_id IS NOT NULL THEN

    PERFORM 1

      FROM public.tenants t

     WHERE t.id = p_tenant_id

       AND t.deleted_at IS NULL

       AND t.organization_id = v_org

     FOR SHARE;

    IF NOT FOUND THEN

      RAISE EXCEPTION 'Khách thuê không thuộc tổ chức của phiếu'

        USING ERRCODE = '42501';

    END IF;

  END IF;

  IF p_contract_id IS NOT NULL THEN

    SELECT c.room_id, c.tenant_id, c.deposit_paid, c.updated_at

      INTO v_contract_room_id, v_contract_tenant_id,

           v_contract_deposit_paid_before, v_contract_updated_at_before

      FROM public.contracts c

      JOIN public.rooms r

        ON r.id = c.room_id

       AND r.deleted_at IS NULL

       AND r.building_id = p_building_id

       AND r.organization_id = v_org

     WHERE c.id = p_contract_id

       AND c.deleted_at IS NULL

       AND c.organization_id = v_org

     FOR SHARE OF c, r;

    IF NOT FOUND THEN

      RAISE EXCEPTION 'Hợp đồng không thuộc toà/tổ chức của phiếu'

        USING ERRCODE = '42501';

    END IF;

    IF p_room_id IS NOT NULL AND p_room_id IS DISTINCT FROM v_contract_room_id THEN

      RAISE EXCEPTION 'Hợp đồng không khớp phòng của phiếu'

        USING ERRCODE = '42501';

    END IF;

    IF v_contract_tenant_id IS NOT NULL THEN

      PERFORM 1

        FROM public.tenants t

       WHERE t.id = v_contract_tenant_id

         AND t.deleted_at IS NULL

         AND t.organization_id = v_org

       FOR SHARE;

      IF NOT FOUND THEN

        RAISE EXCEPTION 'Khách thuê đại diện của hợp đồng không còn hợp lệ'

          USING ERRCODE = '42501';

      END IF;

      IF p_tenant_id IS NOT NULL

         AND p_tenant_id IS DISTINCT FROM v_contract_tenant_id THEN

        RAISE EXCEPTION 'Hợp đồng không khớp khách thuê của phiếu'

          USING ERRCODE = '42501';

      END IF;

      v_tenant_id := v_contract_tenant_id;

    ELSIF p_tenant_id IS NOT NULL THEN

      -- contracts.tenant_id is a nullable legacy representative. Only the legacy

      -- contract_tenants relation can prove a supplied tenants.id; contract_customers

      -- references public.customers and must never be used as a tenant bridge.

      PERFORM 1

        FROM public.contract_tenants ct

       WHERE ct.contract_id = p_contract_id

         AND ct.tenant_id = p_tenant_id

         AND (ct.organization_id IS NULL OR ct.organization_id = v_org)

       FOR SHARE;

      IF NOT FOUND THEN

        RAISE EXCEPTION 'Khách thuê không thuộc hợp đồng'

          USING ERRCODE = '42501';

      END IF;

      v_tenant_id := p_tenant_id;

    ELSE

      v_tenant_id := NULL;

    END IF;

    v_room_id := v_contract_room_id;

  END IF;

  IF NOT v_can_create_on_building THEN

    RAISE EXCEPTION 'Không có quyền tạo phiếu thu/chi cho toà này'

      USING ERRCODE = '42501';

  END IF;

  IF v_room_id IS NOT NULL THEN

    SELECT r.status, r.updated_at

      INTO v_room_status_before, v_room_updated_at_before

      FROM public.rooms r

     WHERE r.id = v_room_id

       AND r.deleted_at IS NULL

       AND r.building_id = p_building_id

       AND r.organization_id = v_org

     FOR SHARE;

    IF NOT FOUND THEN

      RAISE EXCEPTION 'Phòng hiệu lực không thuộc toà/tổ chức của phiếu'

        USING ERRCODE = '42501';

    END IF;

  END IF;

  IF p_account_id IS NOT NULL THEN

    SELECT a.user_id, a.lock_date

      INTO v_account_owner_id, v_account_lock_date

      FROM public.accounts a

     WHERE a.id = p_account_id

       AND a.deleted_at IS NULL

       AND a.organization_id = v_org

     FOR SHARE;

    IF NOT FOUND THEN

      RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức của phiếu'

        USING ERRCODE = '42501';

    END IF;

    -- Possession thay cho account_shared_users (cutover 02/08/2026). KHÔNG khoá
    -- dòng binding: hệ possession bất biến theo thời gian (thu hồi = đóng valid_to,
    -- không xoá dòng), nên hậu kiểm dưới đây đã đủ chặn revoke chạy song song.
    -- §9.2: CUSTODIAN/OPERATOR làm mọi loại phiếu, KNOWER chỉ Phiếu thu.
    SELECT EXISTS (
      SELECT 1
        FROM public.cashbook_possession_bindings b
        JOIN public.organization_memberships m ON m.id = b.membership_id
       WHERE b.cashbook_id = p_account_id
         AND b.organization_id = v_org
         AND m.user_id = v_actor
         AND m.status = 'ACTIVE'
         AND b.valid_to IS NULL
         AND (b.possession_kind IN ('CUSTODIAN','OPERATOR')
              OR (b.possession_kind = 'KNOWER' AND p_type = 'INCOME'))
    ) INTO v_account_is_shared;

    -- Cashbook ownership/sharing remains semantically authoritative until the

    -- normalized cashbooks.post resolver is complete. Building permission never

    -- implies use of an arbitrary same-organization cashbook, while account

    -- ownership/sharing never implies permission to create on the building.

    IF NOT (

      v_account_owner_id = v_actor

      OR v_account_is_shared

    ) THEN

      RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này'

        USING ERRCODE = '42501';

    END IF;

  END IF;

  v_expected_type := CASE p_type WHEN 'INCOME' THEN 'income' ELSE 'expense' END;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)

  LOOP

    v_index := v_index + 1;

    IF jsonb_typeof(v_item) <> 'object' THEN

      RAISE EXCEPTION 'Hạng mục % phải là object', v_index;

    END IF;

    IF (v_item - ARRAY[

      'income_expense_type_id', 'description', 'quantity', 'unit_price', 'start_date', 'end_date'

    ]) <> '{}'::jsonb THEN

      RAISE EXCEPTION 'Hạng mục % chứa trường không được phép', v_index;

    END IF;

    IF NOT (v_item ? 'income_expense_type_id')

       OR jsonb_typeof(v_item->'income_expense_type_id') <> 'string' THEN

      RAISE EXCEPTION 'Loại thu/chi hạng mục % phải là UUID dạng chuỗi', v_index;

    END IF;

    IF NOT (v_item ? 'quantity')

       OR jsonb_typeof(v_item->'quantity') <> 'number' THEN

      RAISE EXCEPTION 'Số lượng hạng mục % phải là JSON number', v_index;

    END IF;

    IF NOT (v_item ? 'unit_price')

       OR jsonb_typeof(v_item->'unit_price') <> 'number' THEN

      RAISE EXCEPTION 'Đơn giá hạng mục % phải là JSON number', v_index;

    END IF;

    IF NOT (v_item ? 'start_date')

       OR jsonb_typeof(v_item->'start_date') <> 'string'

       OR v_item->>'start_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN

      RAISE EXCEPTION 'Ngày bắt đầu hạng mục % phải là YYYY-MM-DD', v_index;

    END IF;

    IF NOT (v_item ? 'end_date')

       OR jsonb_typeof(v_item->'end_date') <> 'string'

       OR v_item->>'end_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN

      RAISE EXCEPTION 'Ngày kết thúc hạng mục % phải là YYYY-MM-DD', v_index;

    END IF;

    IF v_item ? 'description'

       AND jsonb_typeof(v_item->'description') NOT IN ('string', 'null') THEN

      RAISE EXCEPTION 'Mô tả hạng mục % phải là chuỗi', v_index;

    END IF;

    BEGIN

      v_type_id := NULLIF(v_item->>'income_expense_type_id', '')::uuid;

      v_quantity := (v_item->>'quantity')::numeric;

      v_unit_price_raw := (v_item->>'unit_price')::numeric;

      v_unit_price := round(v_unit_price_raw, 2);

      v_start_date := (v_item->>'start_date')::date;

      v_end_date := (v_item->>'end_date')::date;

      v_description := NULLIF(btrim(v_item->>'description'), '');

    EXCEPTION

      WHEN invalid_text_representation

        OR invalid_datetime_format

        OR numeric_value_out_of_range

        OR datetime_field_overflow THEN

        RAISE EXCEPTION 'Hạng mục % có dữ liệu không hợp lệ', v_index;

    END;

    IF v_type_id IS NULL THEN

      RAISE EXCEPTION 'Hạng mục % thiếu loại thu/chi', v_index;

    END IF;

    IF v_description IS NOT NULL

       AND char_length(v_description) > c_max_item_description_length THEN

      RAISE EXCEPTION 'Mô tả hạng mục % vượt quá % ký tự',

        v_index, c_max_item_description_length;

    END IF;

    IF v_quantity IS NULL

       OR v_quantity::text IN ('NaN', 'Infinity', '-Infinity')

       OR v_quantity < 1

       OR v_quantity > 2147483647

       OR v_quantity <> trunc(v_quantity) THEN

      RAISE EXCEPTION 'Số lượng hạng mục % phải là số nguyên hợp lệ >= 1', v_index;

    END IF;

    -- Quantity is stored as integer; normalize numeric spelling before hashing.

    v_quantity := trunc(v_quantity);

    IF v_unit_price_raw IS NULL

       OR v_unit_price_raw::text IN ('NaN', 'Infinity', '-Infinity')

       OR v_unit_price_raw < 0

       OR v_unit_price < 0

       OR v_unit_price > c_max_money THEN

      RAISE EXCEPTION 'Đơn giá hạng mục % không hợp lệ', v_index;

    END IF;

    IF v_quantity * v_unit_price > c_max_money THEN

      RAISE EXCEPTION 'Thành tiền hạng mục % vượt giới hạn', v_index;

    END IF;

    IF v_start_date IS NULL

       OR v_end_date IS NULL

       OR NOT isfinite(v_start_date)

       OR NOT isfinite(v_end_date)

       OR v_start_date < DATE '2000-01-01'

       OR v_end_date > DATE '2100-12-31'

       OR v_start_date > v_end_date

       OR v_end_date - v_start_date > c_max_item_period_days THEN

      RAISE EXCEPTION 'Kỳ áp dụng hạng mục % phải nằm trong 2000-01-01..2100-12-31 và không quá % ngày',

        v_index, c_max_item_period_days;

    END IF;

    v_accrual_bucket_count := v_accrual_bucket_count

      + (

          extract(year FROM v_end_date)::integer * 12

          + extract(month FROM v_end_date)::integer

          - extract(year FROM v_start_date)::integer * 12

          - extract(month FROM v_start_date)::integer

          + 1

        );

    IF v_accrual_bucket_count > c_max_accrual_buckets THEN

      RAISE EXCEPTION 'Tổng số bucket dồn tích vượt giới hạn %', c_max_accrual_buckets

        USING ERRCODE = '54000';

    END IF;

    SELECT t.is_restricted, t.is_deposit, public.nrm_vn(t.name), t.system_only
      INTO v_type_is_restricted, v_type_is_deposit, v_type_normalized_name, v_type_system_only

      FROM public.income_expense_types t

     WHERE t.id = v_type_id

       AND lower(t.type) = v_expected_type

       AND t.organization_id = v_org

     FOR SHARE;

    IF NOT FOUND THEN

      RAISE EXCEPTION 'Loại hạng mục % không thuộc tổ chức hoặc sai chiều thu/chi', v_index

        USING ERRCODE = '42501';

    END IF;

    -- Chốt chặn tạo tay: đọc CỜ `system_only` trên hạng mục thay vì so khớp TÊN.
    -- Cờ đã được bật cho đúng 36 dòng bằng chính hai vị từ cũ (is_deposit +
    -- tên hoa hồng/thưởng), nên hành vi KHÔNG đổi — chỉ hết mong manh khi đổi tên.
    -- Chủ sở hữu bật/tắt được từng hạng mục ở Cài đặt mà không cần sửa hàm.
    IF coalesce(v_type_system_only, false) THEN
      RAISE EXCEPTION 'Hạng mục "%" chỉ được sinh từ hệ thống (hợp đồng/cọc/thanh lý/hoa hồng), không tạo tay từ màn Thu/Chi',
        (SELECT name FROM public.income_expense_types WHERE id = v_type_id)
        USING ERRCODE = '0A000';
    END IF;

    

    IF v_type_is_restricted THEN

      v_requires_restricted := true;

      IF NOT v_can_create_restricted THEN

        RAISE EXCEPTION 'Không có quyền tạo hạng mục thu/chi hạn chế'

          USING ERRCODE = '42501';

      END IF;

    END IF;

    v_total_amount := v_total_amount + (v_quantity * v_unit_price);

    IF v_total_amount > c_max_money THEN

      RAISE EXCEPTION 'Tổng tiền phiếu vượt giới hạn';

    END IF;

    -- Build the equality token from typed values, not caller UUID/date spelling.

    v_canonical_items := v_canonical_items || jsonb_build_array(

      jsonb_strip_nulls(jsonb_build_object(

        'income_expense_type_id', v_type_id,

        'description', v_description,

        'quantity', v_quantity,

        'unit_price', v_unit_price,

        'start_date', v_start_date,

        'end_date', v_end_date

      ))

    );

  END LOOP;

  v_canonical_payload := jsonb_strip_nulls(jsonb_build_object(

    'type', p_type,

    'name', v_name,

    'building_id', p_building_id,

    'room_id', v_room_id,

    'tenant_id', v_tenant_id,

    'contract_id', p_contract_id,

    'payer_name', NULLIF(btrim(p_payer_name), ''),

    'receive_bank_account', NULLIF(btrim(p_receive_bank_account), ''),

    'receive_bank_name', NULLIF(btrim(p_receive_bank_name), ''),

    'account_id', p_account_id,

    'attachments', v_attachments,

    'business_result_accounting', p_business_result_accounting,

    'notes', NULLIF(p_notes, ''),

    'voucher_date', p_voucher_date,

    'items', v_canonical_items

  ));

  -- md5(jsonb::text) is deterministic for PostgreSQL jsonb canonical key ordering;

  -- payload_hash is an equality token, not a password/signature.

  v_payload_hash := md5(v_canonical_payload::text);

  -- The unconditional unique claim is the linearization point. ON CONFLICT waits

  -- for an in-flight claimant: if it aborts this transaction becomes the claimant;

  -- if it commits the locked reread observes its immutable completion. Rollout state

  -- is deliberately not consulted until after that outcome is known.

  INSERT INTO app_private.canonical_write_operations (

    organization_id, operation, subject_scope, actor_id,

    idempotency_key, payload_hash

  ) VALUES (

    v_org, 'income_expense.create_draft.v1', p_building_id::text, v_actor,

    v_idempotency_key, v_payload_hash

  )

  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)

  DO NOTHING;

  SELECT *

    INTO v_operation

    FROM app_private.canonical_write_operations o

   WHERE o.organization_id = v_org

     AND o.operation = 'income_expense.create_draft.v1'

     AND o.subject_scope = p_building_id::text

     AND o.actor_id = v_actor

     AND o.idempotency_key = v_idempotency_key

   FOR UPDATE;

  IF NOT FOUND THEN

    RAISE EXCEPTION 'Không thể nhận diện operation idempotency đã claim'

      USING ERRCODE = '55000';

  END IF;

  IF v_operation.payload_hash <> v_payload_hash THEN

    RAISE EXCEPTION 'idempotency_key đã được dùng với payload khác'

      USING ERRCODE = '23505';

  END IF;

  -- Completed replay still requires current tenant authority, but it must not depend

  -- on mutable rollout admission, canary enrollment/caps, or the cashbook lock date.

  -- Platform-super status is intentionally irrelevant to tenant business authority.

  IF NOT EXISTS (

    SELECT 1

      FROM public.organization_memberships m

     WHERE m.id = v_membership_id

       AND m.organization_id = v_org

       AND m.user_id = v_actor

       AND m.status = 'ACTIVE'

       AND m.valid_from <= clock_timestamp()

       AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)

  ) THEN

    RAISE EXCEPTION 'Tư cách thành viên đã hết hiệu lực'

      USING ERRCODE = '42501';

  END IF;

  IF NOT app_private.authorize_collaborative_income_expense_v1(

    v_actor, v_org, 'create', p_building_id

  ) THEN

    RAISE EXCEPTION 'Quyền tạo phiếu trên toà đã bị thu hồi'

      USING ERRCODE = '42501';

  END IF;

  IF v_requires_restricted

     AND NOT app_private.authorize_collaborative_income_expense_v1(

       v_actor, v_org, 'restricted_create', p_building_id

     ) THEN

    RAISE EXCEPTION 'Quyền tạo hạng mục hạn chế đã bị thu hồi'

      USING ERRCODE = '42501';

  END IF;

  IF p_account_id IS NOT NULL

     AND v_account_owner_id IS DISTINCT FROM v_actor

     AND NOT EXISTS (
         SELECT 1
           FROM public.cashbook_possession_bindings b
           JOIN public.organization_memberships m ON m.id = b.membership_id
          WHERE b.cashbook_id = p_account_id
            AND b.organization_id = v_org
            AND m.user_id = v_actor
            AND m.status = 'ACTIVE'
            AND b.valid_to IS NULL
            AND (b.possession_kind IN ('CUSTODIAN','OPERATOR')
                 OR (b.possession_kind = 'KNOWER' AND p_type = 'INCOME'))
       ) THEN

    RAISE EXCEPTION 'Quyền sử dụng sổ quỹ đã bị thu hồi'

      USING ERRCODE = '42501';

  END IF;

  IF v_operation.completed_at IS NOT NULL THEN

    SELECT *

      INTO v_row

      FROM jsonb_populate_record(

        NULL::public.income_expenses,

        v_operation.response_payload

      );

    IF v_row.id IS NULL OR v_row.id IS DISTINCT FROM v_operation.subject_id THEN

      RAISE EXCEPTION 'Kết quả idempotency không còn nhất quán';

    END IF;

    RETURN v_row;

  END IF;

  -- Only a new/pending claimant enters rollout admission. A completed operation above

  -- can therefore replay after OFF/freeze, enrollment removal, or window closure.

  SELECT *

    INTO v_feature

    FROM app_private.server_feature_flags f

   WHERE f.feature_key = 'income_expense.create_draft.v1'

   FOR SHARE;

  IF NOT FOUND THEN

    RAISE EXCEPTION 'Canonical writer chưa được cấu hình' USING ERRCODE = '55000';

  END IF;

  -- A CANARY enrollment used for admission must survive through commit. The shared

  -- feature lock freezes the release identity/configuration for this transaction.

  IF v_feature.mode = 'CANARY' THEN

    PERFORM 1

      FROM app_private.server_feature_flag_canary_orgs c

     WHERE c.feature_key = v_feature.feature_key

       AND c.organization_id = v_org

     FOR SHARE;

    IF NOT FOUND THEN

      RAISE EXCEPTION 'Tổ chức không còn trong canary'

        USING ERRCODE = '55000';

    END IF;

  END IF;

  v_feature_route := app_private.evaluate_feature_route(

    v_feature.feature_key, v_org

  );

  IF v_feature_route <> 'CANONICAL' THEN

    RAISE EXCEPTION 'Canonical writer chưa được bật hoặc đang đóng băng cho tổ chức này'

      USING ERRCODE = '55000';

  END IF;

  IF v_feature.mode = 'CANARY' THEN

    -- Serialize only one feature/config cap bucket; do not upgrade the shared row

    -- lock, which would deadlock concurrent readers and globally serialize ON mode.

    PERFORM pg_catalog.pg_advisory_xact_lock(

      pg_catalog.hashtextextended(

        v_feature.feature_key || ':' || v_feature.config_version::text,

        0

      )

    );

    v_feature_evaluated_at := clock_timestamp();

    IF v_feature.starts_at IS NULL

       OR v_feature.ends_at IS NULL

       OR NOT isfinite(v_feature.starts_at)

       OR NOT isfinite(v_feature.ends_at)

       OR v_feature.starts_at >= v_feature.ends_at

       OR v_feature_evaluated_at < v_feature.starts_at

       OR v_feature_evaluated_at >= v_feature.ends_at THEN

      RAISE EXCEPTION 'Cửa sổ canary không còn hiệu lực'

        USING ERRCODE = '55000';

    END IF;

    IF v_feature.max_single_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')

       OR v_feature.max_total_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')

       OR v_feature.max_operation_count <= 0

       OR v_feature.max_single_amount_vnd <= 0

       OR v_feature.max_total_amount_vnd <= 0 THEN

      RAISE EXCEPTION 'Hạn mức canary không hợp lệ'

        USING ERRCODE = '55000';

    END IF;

    IF v_total_amount > v_feature.max_single_amount_vnd THEN

      RAISE EXCEPTION 'Số tiền vượt cap canary cho một phiếu'

        USING ERRCODE = '54000';

    END IF;

    SELECT count(*), COALESCE(sum(o.amount_vnd), 0)

      INTO v_feature_operation_count, v_feature_total_amount

      FROM app_private.server_feature_flag_operations o

     WHERE o.feature_key = v_feature.feature_key

       AND o.config_version = v_feature.config_version;

    IF v_feature_operation_count >= v_feature.max_operation_count THEN

      RAISE EXCEPTION 'Đã hết số lượt canary' USING ERRCODE = '54000';

    END IF;

    IF v_feature_total_amount + v_total_amount > v_feature.max_total_amount_vnd THEN

      RAISE EXCEPTION 'Đã hết tổng hạn mức tiền canary' USING ERRCODE = '54000';

    END IF;

  END IF;

  -- Recheck expiring tenant authority after every idempotency, rollout, enrollment,

  -- and advisory-lock wait. Account lock_date is an effect-only rule: it is applied

  -- here for a new effect but was intentionally skipped by completed replay above.

  IF NOT EXISTS (

    SELECT 1

      FROM public.organization_memberships m

     WHERE m.id = v_membership_id

       AND m.organization_id = v_org

       AND m.user_id = v_actor

       AND m.status = 'ACTIVE'

       AND m.valid_from <= clock_timestamp()

       AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)

  ) THEN

    RAISE EXCEPTION 'Tư cách thành viên đã hết hiệu lực'

      USING ERRCODE = '42501';

  END IF;

  IF NOT app_private.authorize_collaborative_income_expense_v1(

    v_actor, v_org, 'create', p_building_id

  ) THEN

    RAISE EXCEPTION 'Quyền tạo phiếu trên toà đã bị thu hồi'

      USING ERRCODE = '42501';

  END IF;

  IF v_requires_restricted

     AND NOT app_private.authorize_collaborative_income_expense_v1(

       v_actor, v_org, 'restricted_create', p_building_id

     ) THEN

    RAISE EXCEPTION 'Quyền tạo hạng mục hạn chế đã bị thu hồi'

      USING ERRCODE = '42501';

  END IF;

  IF p_account_id IS NOT NULL THEN

    IF v_account_owner_id IS DISTINCT FROM v_actor

       AND NOT EXISTS (
         SELECT 1
           FROM public.cashbook_possession_bindings b
           JOIN public.organization_memberships m ON m.id = b.membership_id
          WHERE b.cashbook_id = p_account_id
            AND b.organization_id = v_org
            AND m.user_id = v_actor
            AND m.status = 'ACTIVE'
            AND b.valid_to IS NULL
            AND (b.possession_kind IN ('CUSTODIAN','OPERATOR')
                 OR (b.possession_kind = 'KNOWER' AND p_type = 'INCOME'))
       ) THEN

      RAISE EXCEPTION 'Quyền sử dụng sổ quỹ đã bị thu hồi'

        USING ERRCODE = '42501';

    END IF;

    IF v_account_lock_date IS NOT NULL AND p_voucher_date <= v_account_lock_date THEN

      RAISE EXCEPTION 'Sổ quỹ đã khoá tại ngày phiếu';

    END IF;

  END IF;

  IF v_feature.mode = 'CANARY' THEN

    v_feature_operation_key := md5(concat_ws(

      '|',

      'income_expense.create_draft.v1',

      v_org::text,

      p_building_id::text,

      v_actor::text,

      v_idempotency_key

    ));

    INSERT INTO app_private.server_feature_flag_operations (

      feature_key, config_version, operation_key, organization_id, amount_vnd

    ) VALUES (

      v_feature.feature_key, v_feature.config_version, v_feature_operation_key,

      v_org, v_total_amount

    );

  END IF;

  -- Deliberately unresolved: the final T3 containment contract must supply a

  -- server-owned canonical-flow marker that exists at draft creation time. Neither

  -- approval_request_id (NULL before submit) nor the private idempotency ledger is an

  -- acceptable provenance marker. Keep this function revoked until the replacement

  -- source writes that marker atomically with the header and legacy transition guards

  -- reject marked rows.

    -- t5_23/24: chọn trạng thái sinh — auto-duyệt TRỪ hạng mục đặc biệt (cờ
  -- force_approval, gồm hoàn cọc/thanh lý/lương/LN/HH/thưởng...) và TRỪ phiếu
  -- CHI từ ngưỡng cài đặt trở lên (app_private.ie_auto_approve_config; chưa
  -- đặt ngưỡng = tự duyệt như cũ). Phiếu không tự duyệt sinh ở NHÁP chờ duyệt tay.
  SELECT bool_or(coalesce(t.force_approval, false))
    INTO v_force_cat
    FROM jsonb_array_elements(p_items) AS it
    JOIN public.income_expense_types t
      ON t.id = (it->>'income_expense_type_id')::uuid;
  SELECT c.threshold INTO v_auto_threshold
    FROM app_private.ie_auto_approve_config c
   WHERE c.organization_id = v_org;
  -- Chủ sở hữu chốt 2026-07-25: NGƯỜI LẬP PHIẾU MÀ CÓ QUYỀN DUYỆT thì phiếu
  -- tự duyệt ngay lúc tạo, không qua Nháp và không chờ ai. Kiểm bằng mô hình
  -- quyền canonical (app_private.can_v3) — không đọc JSONB legacy.
  -- income_expenses.approve khai required_dimensions=['BUILDING'] nên phiếu không
  -- gắn toà phải hỏi dạng "có quyền ở bất kỳ đâu".
  v_maker_can_approve := CASE
    WHEN p_building_id IS NOT NULL
      THEN app_private.can_v3('income_expenses.approve', p_building_id)
    ELSE app_private.has_any_scope_v3('income_expenses.approve')
  END;

  IF coalesce(v_maker_can_approve, false) THEN
    v_birth_status := 'APPROVED';
  ELSIF p_type = 'INCOME' THEN
    -- Chủ sở hữu chốt 2026-07-27: MỌI phiếu THU tự duyệt + ghi sổ ngay khi
    -- tạo, kể cả hạng mục Tiền Cọc bên thu. Cờ force_approval và ngưỡng
    -- chi chỉ còn áp cho phiếu CHI (hoàn cọc, thanh lý, hoa hồng, lương…).
    v_birth_status := 'APPROVED';
  ELSIF coalesce(v_force_cat, false) THEN
    v_birth_status := 'UNAPPROVED';
  ELSIF p_type = 'EXPENSE' AND v_auto_threshold IS NOT NULL
        AND v_total_amount >= v_auto_threshold THEN
    v_birth_status := 'UNAPPROVED';
  ELSE
    v_birth_status := 'APPROVED';
  END IF;
  -- G5 (26/09/2026): hỏi bộ máy chi — một luật cho mọi cửa chi, đọc luật khai trên hạng mục.
  -- Chỉ ÁP khi cờ spend.engine.v1 = ON và mọi bucket của phiếu đã bật; còn lại giữ thang trên.
  IF p_type = 'EXPENSE' THEN
    v_spend_gate := app_private.ie_spend_gate_v1(
      v_org, p_building_id, 'EXPENSE', 'create_income_expense_v1', NULL, p_account_id,
      p_voucher_date,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'type_id', it->>'income_expense_type_id',
                'amount', COALESCE(NULLIF(it->>'quantity', '')::numeric, 0)
                          * COALESCE(NULLIF(it->>'unit_price', '')::numeric, 0),
                'start_date', it->>'start_date',
                'end_date', it->>'end_date')), '[]'::jsonb)
         FROM jsonb_array_elements(v_canonical_items) AS it));
    IF COALESCE((v_spend_gate->>'enforce')::boolean, false) THEN
      v_birth_status := v_spend_gate->>'status';
    END IF;
  END IF;

  -- Newly reachable buildings do not gain automatic expense approval.
  IF p_type='EXPENSE'
    AND NOT app_private.authorize_income_expense_on_building(v_actor,v_org,'create',p_building_id)
    AND NOT app_private.is_org_owner_v1(v_org,v_actor) AND NOT public.is_super_admin()
  THEN v_birth_status:='UNAPPROVED'; END IF;

  IF v_birth_status = 'APPROVED' THEN
    v_birth_by := v_actor; v_birth_at := now();
  ELSE
    v_birth_by := NULL; v_birth_at := NULL;
  END IF;

  INSERT INTO public.income_expenses (

    user_id, creator_name, organization_id,

    type, name, building_id, room_id, tenant_id, contract_id,

    payer_name, receive_bank_account, receive_bank_name, account_id,

    attachments, business_result_accounting, notes,

    repeat_cycle, repeat_infinity, repeat_count, repeat_auto_approve,

    repeat_remaining, repeat_next_date,

    voucher_date, approval_status, approved_by, approved_at,

    source_payload_hash, system_source

  ) VALUES (

    v_actor, v_actor_name, v_org,

    p_type, v_name, p_building_id, v_room_id, v_tenant_id, NULL,

    NULLIF(btrim(p_payer_name), ''), NULLIF(btrim(p_receive_bank_account), ''),

    NULLIF(btrim(p_receive_bank_name), ''), p_account_id,

    v_attachments, p_business_result_accounting, NULLIF(p_notes, ''),

    'NONE', false, 0, false,

    0, NULL,

    p_voucher_date, v_birth_status, v_birth_by, v_birth_at,

    v_payload_hash, NULL

  )

  RETURNING * INTO v_row;

  INSERT INTO public.income_expense_items (

    income_expense_id, income_expense_type_id, description,

    quantity, unit_price, start_date, end_date, organization_id

  )

  SELECT

    v_row.id,

    (item->>'income_expense_type_id')::uuid,

    item->>'description',

    (item->>'quantity')::integer,

    (item->>'unit_price')::numeric,

    (item->>'start_date')::date,

    (item->>'end_date')::date,

    v_org

  FROM jsonb_array_elements(v_canonical_items) AS x(item);

  -- Keep the parent detached while non-deposit/non-commission items are inserted.

  -- The legacy item trigger otherwise recomputes any historical approved deposit on

  -- the contract and churns contracts.updated_at even though this draft has no deposit.

  -- Commission flows are excluded above and retain their specialized writer because

  -- their invariants require contract_id on the header before item insertion.

  IF p_contract_id IS NOT NULL THEN

    UPDATE public.income_expenses

       SET contract_id = p_contract_id

     WHERE id = v_row.id

       AND contract_id IS NULL;

    IF NOT FOUND THEN

      RAISE EXCEPTION 'Không thể gắn hợp đồng đã xác thực vào phiếu nháp'

        USING ERRCODE = '23514';

    END IF;

  END IF;

  SELECT * INTO v_row FROM public.income_expenses WHERE id = v_row.id;

  SELECT count(*), COALESCE(sum(it.amount), 0),
         COALESCE(bool_or(t.is_restricted), false),
         COALESCE(sum(COALESCE(it.amount, it.unit_price * it.quantity))
           FILTER (WHERE it.accounting_class = 'PNL'), 0),
         COALESCE(bool_or(t.is_deposit), false)
    INTO v_stored_item_count, v_stored_total_amount, v_stored_has_restricted,
         v_stored_pnl_sum, v_stored_has_deposit_item

    FROM public.income_expense_items it

    JOIN public.income_expense_types t ON t.id = it.income_expense_type_id

   WHERE it.income_expense_id = v_row.id;

  -- Kỳ vọng phải MIRROR public.recompute_ie_business_result: khi caller không
  -- ép business_result_accounting, KQKD suy từ hạng mục (item accounting_class),
  -- KHÔNG mặc định là toàn bộ số tiền. Công thức cũ giả định NULL => (true, total)
  -- nên MỌI phiếu có hạng mục cọc (accounting_class='DEPOSIT') đều văng 23514 —
  -- đó là lý do phiếu thu tiền cọc chưa bao giờ đi qua được writer canonical.
  v_stored_kqkd_amount := CASE
    WHEN p_business_result_accounting IS TRUE THEN v_total_amount
    WHEN p_business_result_accounting IS FALSE THEN 0
    WHEN v_item_count = 0 THEN v_total_amount
    ELSE GREATEST(LEAST(v_stored_pnl_sum, v_total_amount), 0)
  END;
  v_stored_counts_in_business_result := (v_stored_kqkd_amount > 0);

  IF v_stored_item_count <> v_item_count

     OR v_stored_total_amount IS DISTINCT FROM v_total_amount

     OR v_row.total_amount IS DISTINCT FROM v_total_amount

     OR v_row.has_restricted_item IS DISTINCT FROM v_stored_has_restricted

     OR v_row.counts_in_business_result IS DISTINCT FROM v_stored_counts_in_business_result

     OR v_row.kqkd_amount IS DISTINCT FROM v_stored_kqkd_amount THEN

    RAISE EXCEPTION 'Trigger thu/chi không tạo đúng các trường tài chính suy diễn'

      USING ERRCODE = '23514';

  END IF;

  -- Generic non-deposit drafts must not reconcile pre-existing deposit or room

  -- reservation state. The earlier row locks make any difference attributable to

  -- this statement; aborting here rolls back the complete writer transaction.

  IF p_contract_id IS NOT NULL THEN
    SELECT c.deposit_paid, c.updated_at
      INTO v_contract_deposit_paid_after, v_contract_updated_at_after
      FROM public.contracts c
     WHERE c.id = p_contract_id;

    -- NỚI ĐÚNG MỘT KHE (án 29/07/2026): phiếu MANG item hạng mục cọc thì
    -- recompute_contract_deposit_paid CHẠY LÀ ĐÚNG THIẾT KẾ — cấm nó tức là cấm
    -- luôn lớp phiếu mà 20260727120000 vừa mở cửa cho writer canonical. Vẫn bắt
    -- writer chứng minh: giá trị sau cùng phải bằng SỐ DẪN XUẤT chuẩn, không
    -- phải số tuỳ ý. Phiếu KHÔNG có item cọc vẫn cấm tuyệt đối như cũ.
    IF (
      v_contract_deposit_paid_after IS DISTINCT FROM v_contract_deposit_paid_before
      OR v_contract_updated_at_after IS DISTINCT FROM v_contract_updated_at_before
    ) AND NOT (
      v_stored_has_deposit_item
      AND v_contract_deposit_paid_after
            IS NOT DISTINCT FROM public.contract_deposit_paid_derived(p_contract_id)
    ) THEN
      RAISE EXCEPTION 'Writer phiếu nháp tổng quát đã tác động trạng thái tiền cọc hợp đồng'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_room_id IS NOT NULL THEN
    SELECT r.status, r.updated_at
      INTO v_room_status_after, v_room_updated_at_after
      FROM public.rooms r
     WHERE r.id = v_room_id;

    -- Cùng một án với hậu kiểm hợp đồng ở trên: phiếu THU cọc GIỮ CHỖ (có item
    -- hạng mục cọc, CHƯA gắn HĐ) có NHIỆM VỤ khoá phòng — recompute_room_reservation
    -- lật AVAILABLE -> RESERVED. Nới đúng khe đó, và vẫn bắt writer chứng minh
    -- trạng thái mới khớp predicate chuẩn room_has_holding_deposit. Mọi chuyển
    -- dịch khác (RESERVED -> AVAILABLE, đụng OCCUPIED/MAINTENANCE, hay chỉ bump
    -- updated_at) vẫn là writer đụng nhầm state có sẵn => abort như cũ.
    IF (
      v_room_status_after IS DISTINCT FROM v_room_status_before
      OR v_room_updated_at_after IS DISTINCT FROM v_room_updated_at_before
    ) AND NOT (
      v_stored_has_deposit_item
      AND v_row.type = 'INCOME'
      AND v_row.contract_id IS NULL
      AND v_room_status_before = 'AVAILABLE'
      AND v_room_status_after = 'RESERVED'
      AND public.room_has_holding_deposit(v_room_id)
    ) THEN
      RAISE EXCEPTION 'Writer phiếu nháp tổng quát đã tác động trạng thái giữ phòng'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- The shared feature-row lock and, for CANARY, shared enrollment lock keep the

  -- admitted rollout identity stable. Re-evaluate only the time boundary here:

  -- counting the reservation we just inserted as a new admission would reject the

  -- exact final permitted count slot (count = max) after its effects were built.

  IF v_feature.mode = 'CANARY' AND (

    clock_timestamp() < v_feature.starts_at

    OR clock_timestamp() >= v_feature.ends_at

  ) THEN

    RAISE EXCEPTION 'Cửa sổ canary đã đóng trước khi hoàn tất'

      USING ERRCODE = '55000';

  END IF;

  -- =========================================================================

  -- T3 CLAIM (A.2 integration point): after construction + invariants +

  -- canary time recheck; before audit append and operation completion.

  -- A.9 smallest-shape: this wrapper is SECURITY DEFINER owned by postgres (so

  -- auth access + INVOKER triggers resolve on Supabase). Capability is proven by

  -- a transaction-local token stamped by a postgres-owned DEFINER setter that no

  -- app role can call, then echoed to the claim. (Replaces the unreachable

  -- current_user='ie_canonical_writer' gate — see t3_12.)

  -- =========================================================================

  v_claim_cap := app_private.grant_ie_claim_capability_v1();

  PERFORM app_private.claim_canonical_income_expense_draft_v1(

    v_row.id, v_idempotency_key, v_claim_cap);

  SELECT * INTO v_row FROM public.income_expenses WHERE id = v_row.id;

  -- A.5: canonical audit goes through the single hash-chain primitive; the

  -- audit-log writer-monopoly guard rejects any direct unchained INSERT.

  PERFORM app_private.append_income_expense_event_v1(

    v_org, v_row.id, 'CREATED_DRAFT', v_actor, v_actor_name,

    NULL, v_birth_status,
    CASE WHEN v_birth_status = 'APPROVED'
         THEN 'Tạo phiếu TỰ DUYỆT (ngoài hạng mục đặc biệt, dưới ngưỡng)'
         ELSE 'Tạo phiếu NHÁP chờ duyệt (hạng mục đặc biệt hoặc chi vượt ngưỡng)' END);

  UPDATE app_private.canonical_write_operations

     SET subject_id = v_row.id,

         response_payload = to_jsonb(v_row),

         completed_at = now()

   WHERE organization_id = v_org

     AND operation = 'income_expense.create_draft.v1'

     AND subject_scope = p_building_id::text

     AND actor_id = v_actor

     AND idempotency_key = v_idempotency_key;

  RETURN v_row;

END;

$function$
;

-- before inspecting relationships, and lock the record against concurrent deletes.
CREATE OR REPLACE FUNCTION public.soft_delete_customer(p_customer_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE c public.customers%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.customers WHERE id=p_customer_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT coalesce((
    SELECT a.allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),c.organization_id,'customers.delete',NULL,NULL) a
  ),false) THEN RAISE EXCEPTION 'Customer not found or not authorized' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.contract_customers cc JOIN public.contracts ct ON ct.id=cc.contract_id
    WHERE cc.customer_id=c.id AND ct.status='ACTIVE' AND ct.deleted_at IS NULL)
  THEN RAISE EXCEPTION 'CUSTOMER_HAS_ACTIVE_CONTRACT' USING ERRCODE='23514',
    HINT='Thanh lý hoặc kết thúc hợp đồng trước khi xoá khách hàng.'; END IF;
  UPDATE public.customers SET deleted_at=now() WHERE id=c.id;
END
$fn$;
REVOKE ALL ON FUNCTION public.soft_delete_customer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_customer(uuid) TO authenticated;
-- Canceling posted utility/period-fee vouchers remains a separate, scoped action.
-- Only the canonical draft editor calls this helper. Approved annotations,
-- cancellation, supplements and recurring schedules retain the original edit key.
CREATE OR REPLACE FUNCTION app_private.ie_can_edit_pending_axis_v1(p_organization_id uuid,p_building_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT app_private.ie_can_edit_money_axis_v1(p_organization_id,p_building_id)
    OR coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(
      auth.uid(),p_organization_id,'income_expenses.edit_draft',p_building_id,NULL)),false);
$fn$;
REVOKE ALL ON FUNCTION app_private.ie_can_edit_pending_axis_v1(uuid,uuid) FROM PUBLIC,anon,authenticated;

-- Keep the canonical editor's status, posting, restricted-category, CAS,
-- idempotency and audit checks; only its draft-specific scope predicate changes.
CREATE OR REPLACE FUNCTION app_private.commission_reason_revise_before_v1(p_voucher uuid, p_expected_approval_version bigint, p_patch jsonb, p_items jsonb DEFAULT NULL::jsonb, p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := app_private.current_uid_v1();
  v_actor_name text;
  v_is_super boolean := public.is_super_admin();
  v_org uuid;
  v_row public.income_expenses%ROWTYPE;
  v_membership uuid;
  v_maker uuid;
  v_patch jsonb := COALESCE(p_patch, '{}'::jsonb);
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_idem text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_system boolean;
  v_key text;
  v_ok boolean;
  v_prev public.income_expense_revisions%ROWTYPE;
  -- giá trị đích
  t_type text; t_code text; t_name text; t_building uuid; t_room uuid; t_tenant uuid; t_contract uuid;
  t_payer text; t_bank_account text; t_bank_name text; t_account uuid; t_attachments jsonb;
  t_notes text; t_date date; t_bra boolean;
  t_repeat_cycle text; t_repeat_count integer; t_repeat_infinity boolean; t_repeat_auto boolean;
  t_repeat_remaining integer; t_repeat_next date;
  -- hạng mục
  v_item jsonb;
  v_index integer := 0;
  v_type_id uuid;
  v_quantity numeric;
  v_unit_price_raw numeric;
  v_unit_price numeric;
  v_start date;
  v_end date;
  v_description text;
  v_type_restricted boolean;
  v_type_system_only boolean;
  v_total numeric := 0;
  v_new_items jsonb := '[]'::jsonb;
  v_old_norm jsonb;
  v_new_norm jsonb;
  v_old_money jsonb;
  v_new_money jsonb;
  v_old_type_ids uuid[];
  v_new_type_ids uuid[];
  v_items_changed boolean := false;
  v_items_money_changed boolean := false;
  -- hợp đồng
  v_contract_room uuid;
  v_contract_tenant uuid;
  -- kết quả
  v_changed text[] := '{}';
  v_money boolean := false;
  v_before jsonb;
  v_after jsonb;
  v_revision_no integer;
  c_max_money constant numeric := 9999999999999.99;
  c_extra_whitespace constant text :=
    chr(160) || chr(173) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)
    || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)
    || chr(8202) || chr(8203) || chr(8232) || chr(8233) || chr(8239)
    || chr(8287) || chr(8288) || chr(12288) || chr(65279);
  c_cho_phep text[] := ARRAY['type', 'name', 'building_id', 'room_id', 'tenant_id', 'contract_id',
    'payer_name', 'receive_bank_account', 'receive_bank_name', 'account_id', 'attachments',
    'notes', 'voucher_date', 'business_result_accounting',
    'repeat_cycle', 'repeat_count', 'repeat_infinity', 'repeat_auto_approve'];
  -- Máy chủ tự tính lại hai cột này từ chu kỳ + ngày phiếu.
  c_bo_qua text[] := ARRAY['repeat_remaining', 'repeat_next_date'];
BEGIN
  -- ── 1. Tham số ────────────────────────────────────────────────────────────
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_voucher IS NULL OR p_expected_approval_version IS NULL THEN
    RAISE EXCEPTION 'Thiếu phiếu hoặc phiên bản phiếu đang xem' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_patch) <> 'object' THEN
    RAISE EXCEPTION 'Dữ liệu sửa phải là object' USING ERRCODE = '22023';
  END IF;
  IF p_items IS NOT NULL AND jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Hạng mục phải là mảng' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'Lý do sửa tối đa 1000 ký tự' USING ERRCODE = '22023';
  END IF;
  IF v_idem IS NOT NULL AND v_idem !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII và chỉ chứa A-Z, a-z, 0-9, ., _, :, -'
      USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_patch) LOOP
    IF NOT (v_key = ANY (c_cho_phep) OR v_key = ANY (c_bo_qua)) THEN
      RAISE EXCEPTION 'Trường "%" không sửa được ở đây', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- ── 2. Khoá tổ chức rồi khoá phiếu ────────────────────────────────────────
  SELECT ie.organization_id INTO v_org FROM public.income_expenses ie WHERE ie.id = p_voucher;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT * INTO v_row FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  -- Gọi lại cùng khoá sau khi đã ghi: trả kết quả cũ (trước CAS vì phiên bản đã tăng).
  IF v_idem IS NOT NULL THEN
    SELECT * INTO v_prev
      FROM public.income_expense_revisions r
     WHERE r.income_expense_id = p_voucher
       AND r.actor_id = v_actor
       AND r.idempotency_key = v_idem;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'id', p_voucher, 'changed', true, 'replayed', true,
        'revision_no', v_prev.revision_no,
        'approval_version', v_row.approval_version,
        'changed_fields', to_jsonb(v_prev.changed_fields));
    END IF;
  END IF;

  -- ── 3. Trạng thái + phiên bản ─────────────────────────────────────────────
  IF v_row.approval_status <> 'UNAPPROVED' THEN
    RAISE EXCEPTION 'Chỉ sửa được phiếu Chờ duyệt — phiếu này đang ở trạng thái %',
      CASE v_row.approval_status WHEN 'APPROVED' THEN 'Đã duyệt' WHEN 'CANCELLED' THEN 'Đã huỷ'
                                 ELSE v_row.approval_status END
      USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_row.posting_status, 'UNPOSTED') = 'POSTED' OR v_row.active_posting_id_v2 IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đã ghi sổ — không sửa ở đây' USING ERRCODE = '55000';
  END IF;
  IF v_row.approval_version IS DISTINCT FROM p_expected_approval_version THEN
    RAISE EXCEPTION 'Phiếu vừa được người khác sửa — tải lại để xem thay đổi.' USING ERRCODE = 'PT409';
  END IF;

  -- ── 4. Loại phiếu sửa được ────────────────────────────────────────────────
  IF app_private.ie_flow_system_owned_v2(p_voucher) THEN
    RAISE EXCEPTION 'Phiếu thuộc luồng hệ thống — sửa ở luồng gốc' USING ERRCODE = '42501';
  END IF;
  IF v_row.system_source IS NOT NULL
     AND v_row.system_source NOT IN ('contract.commission', 'termination.refund') THEN
    RAISE EXCEPTION 'Phiếu do hệ thống sinh (%) — sửa ở luồng gốc', v_row.system_source
      USING ERRCODE = '42501';
  END IF;
  IF v_row.invoice_id IS NOT NULL OR v_row.payment_id IS NOT NULL
     OR v_row.payment_collection_id IS NOT NULL OR v_row.utility_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu gắn hoá đơn/khoản thu — sửa ở màn hoá đơn' USING ERRCODE = '42501';
  END IF;
  IF v_row.salary_staff_id IS NOT NULL OR v_row.shareholder_id IS NOT NULL
     OR v_row.profit_manager_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu lương / chia lợi nhuận — sửa ở luồng gốc' USING ERRCODE = '42501';
  END IF;
  IF v_row.handover_id IS NOT NULL OR v_row.handover_transfer_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu nằm trong phiên bàn giao tiền mặt — không sửa được' USING ERRCODE = '42501';
  END IF;
  IF v_row.reversal_of_income_expense_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đảo của phiếu khác — không sửa được' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profit_payout_reservations x WHERE x.payout_voucher_id = p_voucher)
     OR EXISTS (SELECT 1 FROM public.reservation_deposit_settlements x WHERE x.source_voucher_id = p_voucher)
     OR EXISTS (SELECT 1 FROM public.reservation_settlement_vouchers x WHERE x.voucher_id = p_voucher) THEN
    RAISE EXCEPTION 'Phiếu thuộc hồ sơ chia lợi nhuận / xử lý cọc giữ chỗ — sửa ở luồng gốc'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.assert_no_engine_request_v1(p_voucher);
  v_system := v_row.system_source IS NOT NULL;

  -- ── 5. Người sửa ──────────────────────────────────────────────────────────
  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);
  SELECT m.id INTO v_membership
    FROM public.organization_memberships m
   WHERE m.user_id = v_actor
     AND m.organization_id = v_org
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= clock_timestamp()
     AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)
   ORDER BY m.id
   LIMIT 1;
  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không còn là thành viên đang hoạt động của tổ chức' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_row.has_restricted_item, false)
     AND v_row.user_id IS DISTINCT FROM v_actor
     AND NOT public.can_view_restricted_ie()
     AND NOT v_is_super THEN
    RAISE EXCEPTION 'Phiếu chứa hạng mục hạn chế — không có quyền sửa' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(v_row.maker_user_id, o.maker_user_id, v_row.user_id) INTO v_maker
    FROM (SELECT 1) one
    LEFT JOIN app_private.income_expense_flow_ownership o ON o.income_expense_id = p_voucher;

  -- ── 6. Giá trị đích = hiện tại, đè bằng patch ─────────────────────────────
  t_type := v_row.type;
  t_name := v_row.name;
  t_building := v_row.building_id;
  t_room := v_row.room_id;
  t_tenant := v_row.tenant_id;
  t_contract := v_row.contract_id;
  t_payer := v_row.payer_name;
  t_bank_account := v_row.receive_bank_account;
  t_bank_name := v_row.receive_bank_name;
  t_account := v_row.account_id;
  t_attachments := COALESCE(v_row.attachments, '[]'::jsonb);
  t_notes := v_row.notes;
  t_date := v_row.voucher_date;
  t_bra := v_row.business_result_accounting;
  t_repeat_cycle := COALESCE(v_row.repeat_cycle, 'NONE');
  t_repeat_count := v_row.repeat_count;
  t_repeat_infinity := v_row.repeat_infinity;
  t_repeat_auto := v_row.repeat_auto_approve;

  BEGIN
    IF v_patch ? 'type' THEN
      t_type := v_patch->>'type';
      IF t_type IS NULL OR t_type NOT IN ('INCOME', 'EXPENSE') THEN
        RAISE EXCEPTION 'Loại phiếu không hợp lệ' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF v_patch ? 'name' THEN
      t_name := btrim(v_patch->>'name', E' \t\n\r\f\v' || c_extra_whitespace);
      IF t_name IS NULL OR t_name = '' THEN
        RAISE EXCEPTION 'Tên phiếu không được trống' USING ERRCODE = '22023';
      END IF;
      IF char_length(t_name) > 500 THEN
        RAISE EXCEPTION 'Tên phiếu vượt quá 500 ký tự' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF v_patch ? 'building_id' THEN
      t_building := NULLIF(v_patch->>'building_id', '')::uuid;
      IF t_building IS NULL THEN
        RAISE EXCEPTION 'Thiếu toà nhà' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF v_patch ? 'room_id' THEN t_room := NULLIF(v_patch->>'room_id', '')::uuid; END IF;
    IF v_patch ? 'tenant_id' THEN t_tenant := NULLIF(v_patch->>'tenant_id', '')::uuid; END IF;
    IF v_patch ? 'contract_id' THEN t_contract := NULLIF(v_patch->>'contract_id', '')::uuid; END IF;
    IF v_patch ? 'payer_name' THEN t_payer := NULLIF(btrim(v_patch->>'payer_name'), ''); END IF;
    IF v_patch ? 'receive_bank_account' THEN
      t_bank_account := NULLIF(btrim(v_patch->>'receive_bank_account'), '');
    END IF;
    IF v_patch ? 'receive_bank_name' THEN
      t_bank_name := NULLIF(btrim(v_patch->>'receive_bank_name'), '');
    END IF;
    IF v_patch ? 'account_id' THEN t_account := NULLIF(v_patch->>'account_id', '')::uuid; END IF;
    IF v_patch ? 'attachments' THEN
      t_attachments := COALESCE(NULLIF(v_patch->'attachments', 'null'::jsonb), '[]'::jsonb);
    END IF;
    IF v_patch ? 'notes' THEN t_notes := NULLIF(v_patch->>'notes', ''); END IF;
    IF v_patch ? 'voucher_date' THEN
      t_date := NULLIF(v_patch->>'voucher_date', '')::date;
    END IF;
    IF v_patch ? 'business_result_accounting' THEN
      t_bra := (v_patch->>'business_result_accounting')::boolean;
    END IF;
    IF v_patch ? 'repeat_cycle' THEN
      t_repeat_cycle := COALESCE(NULLIF(v_patch->>'repeat_cycle', ''), 'NONE');
    END IF;
    IF v_patch ? 'repeat_count' THEN
      t_repeat_count := COALESCE(NULLIF(v_patch->>'repeat_count', '')::integer, 0);
    END IF;
    IF v_patch ? 'repeat_infinity' THEN
      t_repeat_infinity := COALESCE((v_patch->>'repeat_infinity')::boolean, false);
    END IF;
    IF v_patch ? 'repeat_auto_approve' THEN
      t_repeat_auto := COALESCE((v_patch->>'repeat_auto_approve')::boolean, true);
    END IF;
  EXCEPTION
    WHEN invalid_text_representation OR invalid_datetime_format
      OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Dữ liệu sửa không hợp lệ (%)', SQLERRM USING ERRCODE = '22023';
  END;

  IF t_payer IS NOT NULL AND char_length(t_payer) > 255 THEN
    RAISE EXCEPTION 'Tên người nộp/nhận vượt quá 255 ký tự' USING ERRCODE = '22023';
  END IF;
  IF t_bank_account IS NOT NULL AND char_length(t_bank_account) > 255 THEN
    RAISE EXCEPTION 'Số tài khoản nhận vượt quá 255 ký tự' USING ERRCODE = '22023';
  END IF;
  IF t_bank_name IS NOT NULL AND char_length(t_bank_name) > 255 THEN
    RAISE EXCEPTION 'Tên ngân hàng nhận vượt quá 255 ký tự' USING ERRCODE = '22023';
  END IF;
  IF t_notes IS NOT NULL AND char_length(t_notes) > 5000 THEN
    RAISE EXCEPTION 'Ghi chú vượt quá 5000 ký tự' USING ERRCODE = '22023';
  END IF;
  IF t_date IS NULL OR NOT isfinite(t_date)
     OR t_date < DATE '2000-01-01' OR t_date > DATE '2100-12-31' THEN
    RAISE EXCEPTION 'Ngày phiếu phải nằm trong khoảng 2000-01-01 đến 2100-12-31' USING ERRCODE = '22023';
  END IF;
  -- Chỉ kiểm khi người dùng ĐỔI ảnh: phiếu cũ có ảnh không đạt khuôn (http, khoảng
  -- trắng, > 20 ảnh) vẫn phải sửa được các ô khác.
  IF t_attachments IS DISTINCT FROM COALESCE(v_row.attachments, '[]'::jsonb) AND (
     jsonb_typeof(t_attachments) <> 'array'
     OR jsonb_array_length(t_attachments) > 20
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(t_attachments) x(value)
        WHERE jsonb_typeof(value) <> 'string'
           OR char_length(value #>> '{}') < 1
           OR char_length(value #>> '{}') > 2048
           OR value #>> '{}' ~ '[[:cntrl:]]'
           OR value #>> '{}' !~
                '^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:[/?#][^[:space:]\\]*)?$'
     )) THEN
    RAISE EXCEPTION 'Ảnh chứng từ phải là tối đa 20 đường dẫn HTTPS hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF t_repeat_cycle NOT IN ('NONE', 'WEEK', 'MONTH', 'QUARTER', 'YEAR') THEN
    RAISE EXCEPTION 'Chu kỳ lặp không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF t_repeat_count IS NULL OR t_repeat_count < 0 OR t_repeat_count > 1000 THEN
    RAISE EXCEPTION 'Số lần lặp phải từ 0 đến 1000' USING ERRCODE = '22023';
  END IF;
  IF t_notes IS DISTINCT FROM v_row.notes THEN
    PERFORM app_private.assert_notes_markers_unchanged_v1(v_row.notes, t_notes);
  END IF;

  -- Lặp lại: không lặp trước và sau thì giữ nguyên mọi cột lặp; tắt lặp thì về 0;
  -- có lặp thì máy chủ tự tính lần sinh kế tiếp (phiếu gốc = kỳ #1).
  IF t_repeat_cycle = 'NONE' AND COALESCE(v_row.repeat_cycle, 'NONE') = 'NONE' THEN
    t_repeat_count := v_row.repeat_count;
    t_repeat_infinity := v_row.repeat_infinity;
    t_repeat_auto := v_row.repeat_auto_approve;
    t_repeat_remaining := v_row.repeat_remaining;
    t_repeat_next := v_row.repeat_next_date;
  ELSIF t_repeat_cycle = 'NONE' THEN
    t_repeat_count := 0;
    t_repeat_infinity := false;
    t_repeat_remaining := 0;
    t_repeat_next := NULL;
  ELSE
    t_repeat_remaining := CASE WHEN t_repeat_infinity THEN 0 ELSE t_repeat_count END;
    t_repeat_next := public.add_cycle(t_date, t_repeat_cycle, 1);
  END IF;

  -- Phiếu hoa hồng / trả khách thanh lý: khung do hệ thống dựng, không đổi được.
  IF v_system AND (
       t_type IS DISTINCT FROM v_row.type
    OR t_building IS DISTINCT FROM v_row.building_id
    OR t_room IS DISTINCT FROM v_row.room_id
    OR t_tenant IS DISTINCT FROM v_row.tenant_id
    OR t_contract IS DISTINCT FROM v_row.contract_id
    OR t_bra IS DISTINCT FROM v_row.business_result_accounting
    OR t_repeat_cycle IS DISTINCT FROM COALESCE(v_row.repeat_cycle, 'NONE')
    OR t_repeat_count IS DISTINCT FROM v_row.repeat_count
    OR t_repeat_infinity IS DISTINCT FROM v_row.repeat_infinity
    OR t_repeat_auto IS DISTINCT FROM v_row.repeat_auto_approve) THEN
    RAISE EXCEPTION 'Phiếu hoa hồng / trả khách thanh lý chỉ sửa được số tiền, sổ quỹ, ngày, người nhận, tên, ảnh — không đổi Thu/Chi, toà, phòng, khách, hợp đồng, KQKD, lặp lại'
      USING ERRCODE = '42501';
  END IF;

  -- ── 7. Quan hệ phải cùng tổ chức, đúng toà (luật của create_income_expense_v1)
  IF t_building IS DISTINCT FROM v_row.building_id THEN
    PERFORM 1 FROM public.buildings b
     WHERE b.id = t_building AND b.organization_id = v_org AND b.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Toà nhà không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF t_room IS NOT NULL AND (t_room IS DISTINCT FROM v_row.room_id OR t_building IS DISTINCT FROM v_row.building_id) THEN
    PERFORM 1 FROM public.rooms r
     WHERE r.id = t_room AND r.deleted_at IS NULL
       AND r.building_id = t_building AND r.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phòng không thuộc toà/tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF t_tenant IS NOT NULL AND t_tenant IS DISTINCT FROM v_row.tenant_id THEN
    PERFORM 1 FROM public.tenants t
     WHERE t.id = t_tenant AND t.deleted_at IS NULL AND t.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Khách thuê không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF t_contract IS NOT NULL
     AND (t_contract IS DISTINCT FROM v_row.contract_id
          OR t_room IS DISTINCT FROM v_row.room_id
          OR t_tenant IS DISTINCT FROM v_row.tenant_id
          OR t_building IS DISTINCT FROM v_row.building_id) THEN
    SELECT c.room_id, c.tenant_id INTO v_contract_room, v_contract_tenant
      FROM public.contracts c
      JOIN public.rooms r ON r.id = c.room_id AND r.deleted_at IS NULL
                         AND r.building_id = t_building AND r.organization_id = v_org
     WHERE c.id = t_contract AND c.deleted_at IS NULL AND c.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Hợp đồng không thuộc toà/tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
    IF t_room IS NOT NULL AND t_room IS DISTINCT FROM v_contract_room THEN
      RAISE EXCEPTION 'Hợp đồng không khớp phòng của phiếu' USING ERRCODE = '42501';
    END IF;
    t_room := v_contract_room;
    IF v_contract_tenant IS NOT NULL THEN
      IF t_tenant IS NOT NULL AND t_tenant IS DISTINCT FROM v_contract_tenant THEN
        RAISE EXCEPTION 'Hợp đồng không khớp khách thuê của phiếu' USING ERRCODE = '42501';
      END IF;
      t_tenant := v_contract_tenant;
    ELSIF t_tenant IS NOT NULL THEN
      PERFORM 1 FROM public.contract_tenants ct
       WHERE ct.contract_id = t_contract AND ct.tenant_id = t_tenant
         AND (ct.organization_id IS NULL OR ct.organization_id = v_org);
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Khách thuê không thuộc hợp đồng' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- ── 8. Quyền ──────────────────────────────────────────────────────────────
  --    Người lập (còn quyền lập phiếu ở toà đích) hoặc người có quyền sửa thu chi
  --    ở toà cũ (và toà mới nếu đổi toà). Super admin đi thẳng.
  IF NOT v_is_super THEN
    IF v_maker = v_actor THEN
      v_ok := app_private.authorize_income_expense_on_building(v_actor, v_org, 'create', t_building)
              OR app_private.ie_can_edit_pending_axis_v1(v_org, t_building);
      IF NOT v_ok THEN
        RAISE EXCEPTION 'Bạn không còn quyền lập phiếu thu chi ở toà này' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NOT app_private.ie_can_edit_pending_axis_v1(v_org, v_row.building_id) THEN
        RAISE EXCEPTION 'Chỉ người lập phiếu hoặc người có quyền sửa thu chi ở toà này mới sửa được'
          USING ERRCODE = '42501';
      END IF;
      IF t_building IS DISTINCT FROM v_row.building_id
         AND NOT app_private.ie_can_edit_pending_axis_v1(v_org, t_building) THEN
        RAISE EXCEPTION 'Không có quyền sửa thu chi ở toà mới' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- Sổ quỹ mới: cùng luật với lúc lập phiếu (chủ sổ, người giữ/vận hành sổ, người
  -- biết sổ chỉ với phiếu thu). Phiếu chưa ghi sổ nên sổ cũ không cần xét.
  IF t_account IS NOT NULL
     AND (t_account IS DISTINCT FROM v_row.account_id OR t_type IS DISTINCT FROM v_row.type) THEN
    PERFORM 1 FROM public.accounts a
     WHERE a.id = t_account AND a.deleted_at IS NULL AND a.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
    IF NOT (
      EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = t_account AND a.user_id = v_actor)
      OR EXISTS (
        SELECT 1
          FROM public.cashbook_possession_bindings b
          JOIN public.organization_memberships m ON m.id = b.membership_id
         WHERE b.cashbook_id = t_account
           AND b.organization_id = v_org
           AND m.user_id = v_actor
           AND m.status = 'ACTIVE'
           AND b.valid_to IS NULL
           AND (b.possession_kind IN ('CUSTODIAN', 'OPERATOR')
                OR (b.possession_kind = 'KNOWER' AND t_type = 'INCOME')))
    ) THEN
      RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ── 9. Hạng mục ───────────────────────────────────────────────────────────
  SELECT COALESCE(jsonb_agg(x.o ORDER BY x.o->>'t', x.o->>'s' NULLS FIRST, x.o->>'e' NULLS FIRST,
                            (x.o->>'p')::numeric, (x.o->>'q')::numeric, x.o->>'d' NULLS FIRST), '[]'::jsonb),
         COALESCE(jsonb_agg(x.o - 'd' ORDER BY x.o->>'t', x.o->>'s' NULLS FIRST, x.o->>'e' NULLS FIRST,
                            (x.o->>'p')::numeric, (x.o->>'q')::numeric), '[]'::jsonb),
         array_agg((x.o->>'t')::uuid ORDER BY x.o->>'t')
    INTO v_old_norm, v_old_money, v_old_type_ids
    FROM (
      SELECT jsonb_strip_nulls(jsonb_build_object(
               't', it.income_expense_type_id,
               'd', NULLIF(btrim(it.description), ''),
               'q', it.quantity,
               'p', it.unit_price,
               's', it.start_date,
               'e', it.end_date)) AS o
        FROM public.income_expense_items it
       WHERE it.income_expense_id = p_voucher
    ) x;

  IF p_items IS NOT NULL THEN
    IF jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 200 THEN
      RAISE EXCEPTION 'Phiếu phải có từ 1 đến 200 hạng mục' USING ERRCODE = '22023';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
      v_index := v_index + 1;
      IF jsonb_typeof(v_item) <> 'object' THEN
        RAISE EXCEPTION 'Hạng mục % phải là object', v_index USING ERRCODE = '22023';
      END IF;
      IF (v_item - ARRAY['income_expense_type_id', 'description', 'quantity', 'unit_price',
                         'start_date', 'end_date', 'accounting_class', 'id', 'amount']) <> '{}'::jsonb THEN
        RAISE EXCEPTION 'Hạng mục % chứa trường không được phép', v_index USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_type_id := NULLIF(v_item->>'income_expense_type_id', '')::uuid;
        v_quantity := (v_item->>'quantity')::numeric;
        v_unit_price_raw := (v_item->>'unit_price')::numeric;
        v_unit_price := round(v_unit_price_raw, 2);
        v_start := NULLIF(v_item->>'start_date', '')::date;
        v_end := NULLIF(v_item->>'end_date', '')::date;
        v_description := NULLIF(btrim(v_item->>'description'), '');
      EXCEPTION
        WHEN invalid_text_representation OR invalid_datetime_format
          OR numeric_value_out_of_range OR datetime_field_overflow THEN
          RAISE EXCEPTION 'Hạng mục % có dữ liệu không hợp lệ', v_index USING ERRCODE = '22023';
      END;
      IF v_type_id IS NULL THEN
        RAISE EXCEPTION 'Hạng mục % thiếu loại thu/chi', v_index USING ERRCODE = '22023';
      END IF;
      IF v_description IS NOT NULL AND char_length(v_description) > 1000 THEN
        RAISE EXCEPTION 'Mô tả hạng mục % vượt quá 1000 ký tự', v_index USING ERRCODE = '22023';
      END IF;
      IF v_quantity IS NULL OR v_quantity::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_quantity < 1 OR v_quantity > 2147483647 OR v_quantity <> trunc(v_quantity) THEN
        RAISE EXCEPTION 'Số lượng hạng mục % phải là số nguyên từ 1 trở lên', v_index USING ERRCODE = '22023';
      END IF;
      v_quantity := trunc(v_quantity);
      IF v_unit_price_raw IS NULL OR v_unit_price_raw::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_unit_price_raw < 0 OR v_unit_price < 0 OR v_unit_price > c_max_money THEN
        RAISE EXCEPTION 'Đơn giá hạng mục % không hợp lệ', v_index USING ERRCODE = '22023';
      END IF;
      IF v_quantity * v_unit_price > c_max_money THEN
        RAISE EXCEPTION 'Thành tiền hạng mục % vượt giới hạn', v_index USING ERRCODE = '22023';
      END IF;
      IF (v_start IS NULL) <> (v_end IS NULL) THEN
        RAISE EXCEPTION 'Hạng mục % phải có đủ ngày bắt đầu và ngày kết thúc (hoặc bỏ trống cả hai)', v_index
          USING ERRCODE = '22023';
      END IF;
      IF v_start IS NOT NULL AND (
           NOT isfinite(v_start) OR NOT isfinite(v_end)
        OR v_start < DATE '2000-01-01' OR v_end > DATE '2100-12-31'
        OR v_start > v_end OR v_end - v_start > 3660) THEN
        RAISE EXCEPTION 'Kỳ áp dụng hạng mục % phải nằm trong 2000-01-01..2100-12-31 và không quá 3660 ngày', v_index
          USING ERRCODE = '22023';
      END IF;

      SELECT t.is_restricted, t.system_only INTO v_type_restricted, v_type_system_only
        FROM public.income_expense_types t
       WHERE t.id = v_type_id
         AND lower(t.type) = CASE t_type WHEN 'INCOME' THEN 'income' ELSE 'expense' END
         AND t.organization_id = v_org;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Loại hạng mục % không thuộc tổ chức hoặc sai chiều thu/chi', v_index
          USING ERRCODE = '42501';
      END IF;
      -- Hạng mục chỉ-hệ-thống không được THÊM vào phiếu (giữ lại cái đang có thì được).
      IF COALESCE(v_type_system_only, false) AND NOT (v_type_id = ANY (COALESCE(v_old_type_ids, '{}'))) THEN
        RAISE EXCEPTION 'Hạng mục "%" chỉ được sinh từ hệ thống, không thêm tay',
          (SELECT name FROM public.income_expense_types WHERE id = v_type_id)
          USING ERRCODE = '0A000';
      END IF;
      IF COALESCE(v_type_restricted, false) AND NOT (v_type_id = ANY (COALESCE(v_old_type_ids, '{}')))
         AND NOT v_is_super
         AND NOT app_private.authorize_income_expense_on_building(v_actor, v_org, 'restricted_create', t_building) THEN
        RAISE EXCEPTION 'Không có quyền thêm hạng mục thu/chi hạn chế' USING ERRCODE = '42501';
      END IF;

      v_total := v_total + v_quantity * v_unit_price;
      IF v_total > c_max_money THEN
        RAISE EXCEPTION 'Tổng tiền phiếu vượt giới hạn' USING ERRCODE = '22023';
      END IF;
      v_new_items := v_new_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        't', v_type_id, 'd', v_description, 'q', v_quantity, 'p', v_unit_price,
        's', v_start, 'e', v_end)));
    END LOOP;

    SELECT COALESCE(jsonb_agg(x.o ORDER BY x.o->>'t', x.o->>'s' NULLS FIRST, x.o->>'e' NULLS FIRST,
                              (x.o->>'p')::numeric, (x.o->>'q')::numeric, x.o->>'d' NULLS FIRST), '[]'::jsonb),
           COALESCE(jsonb_agg(x.o - 'd' ORDER BY x.o->>'t', x.o->>'s' NULLS FIRST, x.o->>'e' NULLS FIRST,
                              (x.o->>'p')::numeric, (x.o->>'q')::numeric), '[]'::jsonb),
           array_agg((x.o->>'t')::uuid ORDER BY x.o->>'t')
      INTO v_new_norm, v_new_money, v_new_type_ids
      FROM jsonb_array_elements(v_new_items) x(o);

    v_items_changed := v_new_norm IS DISTINCT FROM v_old_norm;
    v_items_money_changed := v_new_money IS DISTINCT FROM v_old_money;

    IF v_system AND v_new_type_ids IS DISTINCT FROM v_old_type_ids THEN
      RAISE EXCEPTION 'Phiếu hoa hồng / trả khách thanh lý chỉ sửa được số tiền của các hạng mục đang có — không thêm, bớt hay đổi loại hạng mục'
        USING ERRCODE = '42501';
    END IF;
  ELSIF t_type IS DISTINCT FROM v_row.type THEN
    RAISE EXCEPTION 'Đổi Thu/Chi phải chọn lại hạng mục cho đúng chiều' USING ERRCODE = '22023';
  END IF;

  -- ── 10. Có gì đổi thật ────────────────────────────────────────────────────
  IF t_type IS DISTINCT FROM v_row.type THEN v_changed := v_changed || 'type'::text; END IF;
  IF t_name IS DISTINCT FROM v_row.name THEN v_changed := v_changed || 'name'::text; END IF;
  IF t_building IS DISTINCT FROM v_row.building_id THEN v_changed := v_changed || 'building_id'::text; END IF;
  IF t_room IS DISTINCT FROM v_row.room_id THEN v_changed := v_changed || 'room_id'::text; END IF;
  IF t_tenant IS DISTINCT FROM v_row.tenant_id THEN v_changed := v_changed || 'tenant_id'::text; END IF;
  IF t_contract IS DISTINCT FROM v_row.contract_id THEN v_changed := v_changed || 'contract_id'::text; END IF;
  IF t_payer IS DISTINCT FROM v_row.payer_name THEN v_changed := v_changed || 'payer_name'::text; END IF;
  IF t_bank_account IS DISTINCT FROM v_row.receive_bank_account THEN
    v_changed := v_changed || 'receive_bank_account'::text;
  END IF;
  IF t_bank_name IS DISTINCT FROM v_row.receive_bank_name THEN
    v_changed := v_changed || 'receive_bank_name'::text;
  END IF;
  IF t_account IS DISTINCT FROM v_row.account_id THEN v_changed := v_changed || 'account_id'::text; END IF;
  IF t_attachments IS DISTINCT FROM COALESCE(v_row.attachments, '[]'::jsonb) THEN
    v_changed := v_changed || 'attachments'::text;
  END IF;
  IF t_notes IS DISTINCT FROM v_row.notes THEN v_changed := v_changed || 'notes'::text; END IF;
  IF t_date IS DISTINCT FROM v_row.voucher_date THEN v_changed := v_changed || 'voucher_date'::text; END IF;
  IF t_bra IS DISTINCT FROM v_row.business_result_accounting THEN
    v_changed := v_changed || 'business_result_accounting'::text;
  END IF;
  IF t_repeat_cycle IS DISTINCT FROM COALESCE(v_row.repeat_cycle, 'NONE')
     OR t_repeat_count IS DISTINCT FROM v_row.repeat_count
     OR t_repeat_infinity IS DISTINCT FROM v_row.repeat_infinity
     OR t_repeat_auto IS DISTINCT FROM v_row.repeat_auto_approve THEN
    v_changed := v_changed || 'repeat'::text;
  END IF;
  IF v_items_changed THEN v_changed := v_changed || 'items'::text; END IF;

  IF cardinality(v_changed) = 0 THEN
    RETURN jsonb_build_object(
      'id', p_voucher, 'changed', false,
      'approval_version', v_row.approval_version,
      'revision_no', (SELECT max(r.revision_no) FROM public.income_expense_revisions r
                       WHERE r.income_expense_id = p_voucher),
      'changed_fields', '[]'::jsonb);
  END IF;

  -- Trục tiền phải có lý do (chủ chốt 25/09: số tiền, hạng mục, loại, sổ quỹ, toà).
  -- Chọn sổ quỹ LẦN ĐẦU cho phiếu chưa có sổ (hộp Duyệt vẫn làm) không phải đổi sổ.
  v_money := v_changed && ARRAY['type', 'building_id', 'business_result_accounting']
             OR ('account_id' = ANY (v_changed) AND v_row.account_id IS NOT NULL)
             OR v_items_money_changed;
  IF v_money AND (v_reason IS NULL OR char_length(v_reason) < 8) THEN
    RAISE EXCEPTION 'Đổi số tiền, hạng mục, loại, sổ quỹ hoặc toà phải ghi lý do (ít nhất 8 ký tự).'
      USING ERRCODE = '22023';
  END IF;

  -- Kỳ đã đóng ở vị trí CŨ (sổ chốt, phiên bàn giao, tháng lợi nhuận); vị trí MỚI do
  -- trigger khoá kỳ kiểm khi ghi.
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'sửa');

  -- ── 11. Ghi ───────────────────────────────────────────────────────────────
  v_before := app_private.ie_revision_snapshot_v1(p_voucher);

  -- Đổi Thu ↔ Chi: cấp mã MỚI đúng tiền tố (PT/PC) từ bộ đếm chung của tổ chức;
  -- số cũ bỏ, không tái dùng. Giữ mã PC trên phiếu thu từng làm bộ đếm cũ cấp
  -- trùng và kẹt cả dãy phiếu chi (sự cố PC2609124, 25/09/2026). Cấp ở đây — sau
  -- mọi bước kiểm — nên lần sửa bị từ chối không đốt số (cùng một transaction).
  IF t_type IS DISTINCT FROM v_row.type THEN
    t_code := app_private.next_voucher_code_v1(v_org, t_type);
    v_changed := v_changed || 'code'::text;
  ELSE
    t_code := v_row.code;
  END IF;

  PERFORM app_private.begin_ie_flex_write_v1(p_voucher, 'REVISE');

  UPDATE public.income_expenses ie
     SET type = t_type,
         code = t_code,
         name = t_name,
         building_id = t_building,
         room_id = t_room,
         tenant_id = t_tenant,
         contract_id = t_contract,
         payer_name = t_payer,
         receive_bank_account = t_bank_account,
         receive_bank_name = t_bank_name,
         account_id = t_account,
         attachments = t_attachments,
         notes = t_notes,
         voucher_date = t_date,
         business_result_accounting = t_bra,
         repeat_cycle = t_repeat_cycle,
         repeat_count = t_repeat_count,
         repeat_infinity = t_repeat_infinity,
         repeat_auto_approve = t_repeat_auto,
         repeat_remaining = t_repeat_remaining,
         repeat_next_date = t_repeat_next,
         approval_version = ie.approval_version + 1,
         updated_at = now()
   WHERE ie.id = p_voucher;

  IF v_items_changed THEN
    DELETE FROM public.income_expense_items it WHERE it.income_expense_id = p_voucher;
    -- Giữ đúng thứ tự người dùng nhập: mỗi dòng một mốc created_at tăng dần.
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_new_items) LOOP
      INSERT INTO public.income_expense_items
        (income_expense_id, income_expense_type_id, description, quantity, unit_price,
         start_date, end_date, organization_id, created_at)
      VALUES
        (p_voucher, (v_item->>'t')::uuid, v_item->>'d', (v_item->>'q')::numeric,
         (v_item->>'p')::numeric, (v_item->>'s')::date, (v_item->>'e')::date, v_org, clock_timestamp());
    END LOOP;
  END IF;

  PERFORM app_private.end_ie_flex_write_v1(p_voucher);

  v_after := app_private.ie_revision_snapshot_v1(p_voucher);

  SELECT COALESCE(max(r.revision_no), 0) + 1 INTO v_revision_no
    FROM public.income_expense_revisions r
   WHERE r.income_expense_id = p_voucher;

  INSERT INTO public.income_expense_revisions
    (organization_id, income_expense_id, revision_no, kind, actor_id, actor_name, reason,
     changed_fields, before_snapshot, after_snapshot, idempotency_key)
  VALUES
    (v_org, p_voucher, v_revision_no, 'EDIT_PENDING', v_actor, COALESCE(v_actor_name, 'Người dùng'),
     v_reason, v_changed, v_before, v_after, v_idem);

  PERFORM app_private.append_income_expense_event_v1(
    v_org, p_voucher, 'REVISED', v_actor, v_actor_name, 'UNAPPROVED', 'UNAPPROVED',
    left('Sửa phiếu chờ duyệt lần ' || v_revision_no || ': ' || array_to_string(v_changed, ', ')
         || COALESCE(' — ' || v_reason, ''), 1000));

  RETURN jsonb_build_object(
    'id', p_voucher,
    'changed', true,
    'revision_no', v_revision_no,
    'approval_version', v_row.approval_version + 1,
    'changed_fields', to_jsonb(v_changed));
END
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_period_fee(p_voucher_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bld       uuid;
  v_owner     uuid;
  v_src       text;
  v_del       timestamptz;
  v_creator   uuid;
  v_type_ok   boolean;
  v_in_batch  boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT ie.building_id, ie.system_source, ie.deleted_at, ie.user_id
    INTO v_bld, v_src, v_del, v_creator
    FROM income_expenses ie
   WHERE ie.id = p_voucher_id AND ie.type = 'EXPENSE'
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002'; END IF;
  IF v_del IS NOT NULL THEN RAISE EXCEPTION 'Phiếu đã bị hủy trước đó'; END IF;

  -- Phiếu hợp lệ để hủy từ trang này: tạo từ trang (fixed_fee/utility.bill)
  -- HOẶC phiếu chi có item khớp 1 hạng mục phí cố định (kể cả "(tự động lập)").
  IF v_src IS DISTINCT FROM 'utility.bill' AND v_src IS DISTINCT FROM 'fixed_fee' THEN
    SELECT EXISTS (
      SELECT 1
        FROM income_expense_items it
        JOIN income_expense_types t ON t.id = it.income_expense_type_id AND t.type = 'expense'
       WHERE it.income_expense_id = p_voucher_id
         AND EXISTS (
           SELECT 1 FROM unnest(ARRAY['tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may']) k
            WHERE public.fee_type_matches(k, t.category, t.name)
         )
    ) INTO v_type_ok;
    IF NOT v_type_ok THEN
      RAISE EXCEPTION 'Phiếu này không thuộc hạng mục phí cố định — hủy ở trang Thu chi';
    END IF;
  END IF;

  SELECT EXISTS (SELECT 1 FROM income_expense_batch_items bi WHERE bi.income_expense_id = p_voucher_id)
    INTO v_in_batch;
  IF v_in_batch THEN
    RAISE EXCEPTION 'Phiếu thuộc phiếu tổng — hủy qua chi tiết phiếu tổng ở Thu chi';
  END IF;

  SELECT b.user_id INTO v_owner FROM buildings b WHERE b.id = v_bld;

  IF NOT (v_creator = auth.uid()
          OR ((public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld))
            AND app_private.manager_collaboration_fee_auto_allowed_v1(v_bld))
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền hủy phiếu này' USING ERRCODE = '42501';
  END IF;

  UPDATE income_expenses SET deleted_at = now()
   WHERE id = p_voucher_id AND deleted_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'voucher_id', p_voucher_id);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.cancel_utility_bill(p_voucher_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bld     uuid;
  v_owner   uuid;
  v_src     text;
  v_del     timestamptz;
  v_creator uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT ie.building_id, ie.system_source, ie.deleted_at, ie.user_id
    INTO v_bld, v_src, v_del, v_creator
    FROM income_expenses ie
   WHERE ie.id = p_voucher_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002'; END IF;
  IF v_del IS NOT NULL THEN RAISE EXCEPTION 'Phiếu đã bị hủy trước đó'; END IF;
  IF v_src IS DISTINCT FROM 'utility.bill' AND v_src IS DISTINCT FROM 'fixed_fee' THEN
    RAISE EXCEPTION 'Phiếu này không phải phiếu Đóng tiền Điện nước';
  END IF;

  SELECT b.user_id INTO v_owner FROM buildings b WHERE b.id = v_bld;

  IF NOT (v_creator = auth.uid()
          OR ((public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld))
            AND app_private.manager_collaboration_fee_auto_allowed_v1(v_bld))
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền hủy phiếu này' USING ERRCODE = '42501';
  END IF;

  UPDATE income_expenses SET deleted_at = now()
   WHERE id = p_voucher_id AND deleted_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'voucher_id', p_voucher_id);
END;
$function$
;
