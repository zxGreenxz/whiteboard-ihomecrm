-- t5_30 — P1: dẹp NULL organization_id ở bảng sự kiện/audit + chặn sinh mới.
-- Các bảng này KHÔNG phải tiền/PII (rủi ro thấp) nhưng NULL-org làm bẩn boundary
-- và tăng dần mỗi ngày. Backfill từ cha (building/invoice/user/parent) + autofill
-- BEFORE INSERT cho 3 bảng phình nhanh nhất. cron_runs (log hệ thống) + settings
-- toàn cục giữ NULL hợp lệ — KHÔNG đụng.

begin;

-- helper: org DUY NHẤT của user (đúng 1 org active); NULL nếu 0 hoặc >1
create or replace function app_private.single_org_of_user_v1(p_uid uuid)
returns uuid language sql stable security definer
set search_path to 'pg_catalog', 'public' as $fn$
  -- HAVING count=1 → chỉ trả khi user thuộc ĐÚNG 1 org active; else 0 dòng (NULL)
  select (array_agg(distinct organization_id))[1]
    from public.organization_memberships
   where user_id = p_uid and status = 'ACTIVE'
  having count(distinct organization_id) = 1;
$fn$;
revoke execute on function app_private.single_org_of_user_v1(uuid) from public, anon;

-- ========== BACKFILL (cha → con) ==========
update public.public_room_events e set organization_id = b.organization_id
  from public.buildings b
 where e.organization_id is null and e.building_id = b.id and b.organization_id is not null;

-- invoice_audit_log: append-only (trigger chặn UPDATE) → KHÔNG backfill 330 dòng
-- audit bất biến hiện có; chỉ autofill dòng MỚI qua trigger BEFORE INSERT bên dưới.

update public.notifications n set organization_id = i.organization_id
  from public.invoices i where n.organization_id is null and n.invoice_id = i.id and i.organization_id is not null;
update public.notifications n set organization_id = c.organization_id
  from public.contracts c where n.organization_id is null and n.contract_id = c.id and c.organization_id is not null;
update public.notifications n set organization_id = app_private.single_org_of_user_v1(n.user_id)
 where n.organization_id is null and n.user_id is not null;

update public.inspection_sessions s set organization_id = b.organization_id
  from public.buildings b where s.organization_id is null and s.building_id = b.id and b.organization_id is not null;
update public.inspection_photos p set organization_id = s.organization_id
  from public.inspection_sessions s where p.organization_id is null and p.session_id = s.id and s.organization_id is not null;

update public.material_usages u set organization_id = app_private.single_org_of_user_v1(u.user_id)
 where u.organization_id is null and u.user_id is not null;
update public.material_purchases u set organization_id = app_private.single_org_of_user_v1(u.user_id)
 where u.organization_id is null and u.user_id is not null;
update public.material_usage_items i set organization_id = u.organization_id
  from public.material_usages u where i.organization_id is null and i.usage_id = u.id and u.organization_id is not null;
update public.material_purchase_items i set organization_id = p.organization_id
  from public.material_purchases p where i.organization_id is null and i.purchase_id = p.id and p.organization_id is not null;

update public.materials m set organization_id = app_private.single_org_of_user_v1(m.user_id)
 where m.organization_id is null and m.user_id is not null;
update public.salary_attendance_day s set organization_id = app_private.single_org_of_user_v1(s.user_id)
 where s.organization_id is null and s.user_id is not null;
update public.building_utility_accounts a set organization_id = b.organization_id
  from public.buildings b where a.organization_id is null and a.building_id = b.id and b.organization_id is not null;
update public.settings s set organization_id = app_private.single_org_of_user_v1(s.user_id)
 where s.organization_id is null and s.user_id is not null;

-- ========== AUTOFILL BEFORE INSERT (chặn sinh mới) ==========
-- public_room_events ← building (bảng phình nhất, ghi bởi anon → DEFINER để đọc org)
create or replace function app_private.autofill_pre_room_event_v1()
returns trigger language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private' as $fn$
begin
  if new.organization_id is null and new.building_id is not null then
    select b.organization_id into new.organization_id from public.buildings b where b.id = new.building_id;
  end if;
  return new;
end $fn$;
drop trigger if exists a90_autofill_org on public.public_room_events;
create trigger a90_autofill_org before insert on public.public_room_events
  for each row execute function app_private.autofill_pre_room_event_v1();

-- invoice_audit_log ← invoice
create or replace function app_private.autofill_pre_invoice_audit_v1()
returns trigger language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private' as $fn$
begin
  if new.organization_id is null and new.invoice_id is not null then
    select i.organization_id into new.organization_id from public.invoices i where i.id = new.invoice_id;
  end if;
  return new;
end $fn$;
drop trigger if exists a90_autofill_org on public.invoice_audit_log;
create trigger a90_autofill_org before insert on public.invoice_audit_log
  for each row execute function app_private.autofill_pre_invoice_audit_v1();

-- notifications ← invoice / contract / user
create or replace function app_private.autofill_pre_notification_v1()
returns trigger language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private' as $fn$
begin
  if new.organization_id is null then
    if new.invoice_id is not null then
      select i.organization_id into new.organization_id from public.invoices i where i.id = new.invoice_id;
    end if;
    if new.organization_id is null and new.contract_id is not null then
      select c.organization_id into new.organization_id from public.contracts c where c.id = new.contract_id;
    end if;
    if new.organization_id is null and new.user_id is not null then
      new.organization_id := app_private.single_org_of_user_v1(new.user_id);
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists a90_autofill_org on public.notifications;
create trigger a90_autofill_org before insert on public.notifications
  for each row execute function app_private.autofill_pre_notification_v1();

commit;
