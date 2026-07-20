-- ============================================================================
-- PS02_payment_invoice_writers.sql
-- SNAPSHOT sinh tự động từ PROD (Supabase project tryymsxyyckgbrmmvozx,
-- PostgreSQL 17.6) ngày 2026-07-19 — KHÔNG SỬA TAY.
-- Dùng cho khôi phục thảm hoạ / dựng lại môi trường: các đối tượng dưới đây
-- đang sống trên prod nhưng chưa có migration nào trên main tái tạo được.
-- Sinh lại: đọc pg_proc/pg_constraint/pg_indexes/pg_trigger/information_schema
-- rồi ghi đè file này (đừng patch thủ công — sẽ lệch với prod).
--
-- CÁCH CHẠY LẠI (idempotent, chạy nhiều lần không lỗi):
--   psql "$PROD" -v ON_ERROR_STOP=1 -f scripts/authz-prepared/prod-snapshot/PS02_payment_invoice_writers.sql
--
-- THỨ TỰ TRONG FILE (chạy được từ DB trắng đã có base schema):
--   0. role  →  1. bảng  →  2. constraint  →  3. index  →  4. hàm  →  5. trigger  →  6. grant
--   (KHÔNG có RLS policy: cả 2 bảng app_private đều relrowsecurity = false trên prod)
--
-- ĐỐI TƯỢNG TRONG FILE — 32 khối DDL (2+9+1+17+3) + 1 role;
-- phần GRANT phủ 19 đối tượng (2 bảng + 17 hàm) bằng 19 REVOKE + 15 GRANT:
--   [BẢNG 2]
--     app_private.canonical_write_operations   (sổ idempotency append-only)
--     app_private.payment_reversals            (map payment gốc → phiếu đảo)
--   [CONSTRAINT 9]
--     canonical_write_operations: _pkey, _completion_check, _idempotency_key_check,
--       _payload_hash_check, _actor_id_fkey, _organization_id_fkey
--     payment_reversals: _pkey, _original_payment_id_fkey, _reversal_voucher_id_fkey
--   [INDEX 1 rời]
--     canonical_write_operations_subject_idx   (2 index _pkey do PK constraint tự tạo)
--   [HÀM 17] — 15 hàm trong phạm vi + 2 hàm trigger bắt buộc kèm theo:
--     app_private.round_invoice_total_v1(numeric)
--     app_private.can_edit_invoice_building_v1(uuid)
--     app_private.guard_canonical_write_operation()      -- kèm theo: trigger của bảng trên
--     app_private.guard_payment_canonical_link()         -- kèm theo: trigger public.payments
--     public.record_invoice_payment_v4(12 arg)
--     public.reverse_invoice_payment_v3(3 arg)
--     public.create_invoice_v1(21 arg)
--     public.update_invoice_v1(18 arg)
--     public.approve_invoice_v1 / unapprove_invoice_v1 / bulk_approve_invoices_v1 /
--     public.cancel_invoice_v1 / restore_invoice_v1 / soft_delete_invoice_v1 /
--     public.bulk_soft_delete_invoices_v1 / mark_overdue_invoices_v1
--     public.super_admin_force_cancel_invoice_v2(uuid)
--   [TRIGGER 3]
--     canonical_write_operations_immutable      ON app_private.canonical_write_operations
--     canonical_write_operations_no_truncate    ON app_private.canonical_write_operations
--     a00_payment_canonical_link_guard          ON public.payments
--   [ROLE 1] ie_canonical_writer (NOLOGIN NOINHERIT) — cần cho GRANT bảng ledger
--
-- KHÔNG NẰM TRONG FILE NÀY (phụ thuộc ngoài — phải có sẵn trước khi chạy):
--   * base schema public: invoices, invoice_items, payments, income_expenses,
--     buildings, rooms, contracts, organizations, excess_amounts + enum
--     payment_method, invoice_status; schema auth (auth.users, auth.uid()).
--   * helper authz nền: is_super_admin(), is_admin(), has_perm_full_scope(),
--     permitted_building_ids().
--   * app_private khác (snapshot ở file PS khác): authorize_tenant_action_v3,
--     evaluate_feature_route, lock_org_for_decision_v1, is_income_expense_flow_owned,
--     server_feature_flags, server_feature_flag_operations.
--   * roles Supabase chuẩn: anon, authenticated, service_role.
--   Chạy file này TRƯỚC khi các phụ thuộc trên tồn tại sẽ lỗi — đó là hành vi mong muốn.
-- ============================================================================

\set ON_ERROR_STOP on

-- search_path phiên chạy: cố định để FK/enum không phụ thuộc cấu hình role.
SET search_path = pg_catalog, public;

-- ============================================================================
-- 0. ROLE — ie_canonical_writer (owner ACL của sổ canonical trên prod)
-- ============================================================================

DO $ps02$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ie_canonical_writer') THEN
    CREATE ROLE ie_canonical_writer NOLOGIN NOINHERIT;
  END IF;
END
$ps02$;

GRANT ie_canonical_writer TO postgres;

-- ============================================================================
-- 1. BẢNG
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_private.canonical_write_operations (
  organization_id  uuid        NOT NULL,
  operation        text        NOT NULL,
  subject_scope    text        NOT NULL,
  actor_id         uuid        NOT NULL,
  idempotency_key  text        NOT NULL,
  payload_hash     text        NOT NULL,
  subject_id       uuid,
  response_payload jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

CREATE TABLE IF NOT EXISTS app_private.payment_reversals (
  original_payment_id uuid        NOT NULL,
  reversal_voucher_id uuid        NOT NULL,
  organization_id     uuid        NOT NULL,
  actor_id            uuid        NOT NULL,
  reason              text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- ============================================================================
-- 2. CONSTRAINT (2 PRIMARY KEY tự sinh index _pkey tương ứng)
-- ============================================================================

DO $ps02$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'canonical_write_operations_pkey'
       AND conrelid = 'app_private.canonical_write_operations'::regclass
  ) THEN
    ALTER TABLE app_private.canonical_write_operations
      ADD CONSTRAINT canonical_write_operations_pkey
      PRIMARY KEY (organization_id, operation, subject_scope, actor_id, idempotency_key);
  END IF;
END
$ps02$;

DO $ps02$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'canonical_write_operations_completion_check'
       AND conrelid = 'app_private.canonical_write_operations'::regclass
  ) THEN
    ALTER TABLE app_private.canonical_write_operations
      ADD CONSTRAINT canonical_write_operations_completion_check
      CHECK ((((completed_at IS NULL) = (response_payload IS NULL)) AND ((completed_at IS NULL) = (subject_id IS NULL))));
  END IF;
END
$ps02$;

DO $ps02$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'canonical_write_operations_idempotency_key_check'
       AND conrelid = 'app_private.canonical_write_operations'::regclass
  ) THEN
    ALTER TABLE app_private.canonical_write_operations
      ADD CONSTRAINT canonical_write_operations_idempotency_key_check
      CHECK ((((char_length(idempotency_key) >= 8) AND (char_length(idempotency_key) <= 200)) AND (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'::text)));
  END IF;
END
$ps02$;

DO $ps02$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'canonical_write_operations_payload_hash_check'
       AND conrelid = 'app_private.canonical_write_operations'::regclass
  ) THEN
    ALTER TABLE app_private.canonical_write_operations
      ADD CONSTRAINT canonical_write_operations_payload_hash_check
      CHECK ((char_length(payload_hash) = 32));
  END IF;
END
$ps02$;

DO $ps02$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'canonical_write_operations_actor_id_fkey'
       AND conrelid = 'app_private.canonical_write_operations'::regclass
  ) THEN
    ALTER TABLE app_private.canonical_write_operations
      ADD CONSTRAINT canonical_write_operations_actor_id_fkey
      FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
  END IF;
END
$ps02$;

DO $ps02$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'canonical_write_operations_organization_id_fkey'
       AND conrelid = 'app_private.canonical_write_operations'::regclass
  ) THEN
    ALTER TABLE app_private.canonical_write_operations
      ADD CONSTRAINT canonical_write_operations_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;
END
$ps02$;

DO $ps02$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_reversals_pkey'
       AND conrelid = 'app_private.payment_reversals'::regclass
  ) THEN
    ALTER TABLE app_private.payment_reversals
      ADD CONSTRAINT payment_reversals_pkey
      PRIMARY KEY (original_payment_id);
  END IF;
END
$ps02$;

DO $ps02$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_reversals_original_payment_id_fkey'
       AND conrelid = 'app_private.payment_reversals'::regclass
  ) THEN
    ALTER TABLE app_private.payment_reversals
      ADD CONSTRAINT payment_reversals_original_payment_id_fkey
      FOREIGN KEY (original_payment_id) REFERENCES public.payments(id);
  END IF;
END
$ps02$;

DO $ps02$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_reversals_reversal_voucher_id_fkey'
       AND conrelid = 'app_private.payment_reversals'::regclass
  ) THEN
    ALTER TABLE app_private.payment_reversals
      ADD CONSTRAINT payment_reversals_reversal_voucher_id_fkey
      FOREIGN KEY (reversal_voucher_id) REFERENCES public.income_expenses(id);
  END IF;
END
$ps02$;

-- ============================================================================
-- 3. INDEX (chỉ index rời — _pkey do constraint ở mục 2 tạo)
-- ============================================================================

CREATE INDEX IF NOT EXISTS canonical_write_operations_subject_idx
  ON app_private.canonical_write_operations USING btree (organization_id, operation, subject_id)
  WHERE (subject_id IS NOT NULL);

-- ============================================================================
-- 4. HÀM (17) — nguyên văn pg_get_functiondef() trên prod
--    Helper + hàm trigger đặt trước vì writer gọi tới.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 4.1 Helper & hàm trigger (app_private)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.round_invoice_total_v1(p_total numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select case
    when p_total is null or p_total <= 0 then p_total
    when mod(p_total, 1000) = 0          then p_total
    when mod(p_total, 1000) >= 900       then ceil(p_total / 1000.0) * 1000
    else                                      floor(p_total / 1000.0) * 1000
  end;
$function$;

CREATE OR REPLACE FUNCTION app_private.can_edit_invoice_building_v1(p_building_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
  select is_super_admin()
      or is_admin()
      or has_perm_full_scope('invoices', 'edit')
      or (p_building_id is not null
          and p_building_id in (select permitted_building_ids('invoices', 'edit')));
$function$;

CREATE OR REPLACE FUNCTION app_private.guard_canonical_write_operation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$

BEGIN

  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN

    RAISE EXCEPTION 'Canonical operation ledger is append-only'

      USING ERRCODE = '55000';

  END IF;



  IF OLD.subject_id IS NOT NULL

     OR OLD.response_payload IS NOT NULL

     OR OLD.completed_at IS NOT NULL THEN

    RAISE EXCEPTION 'Completed canonical operation is immutable'

      USING ERRCODE = '55000';

  END IF;

  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id

     OR NEW.operation IS DISTINCT FROM OLD.operation

     OR NEW.subject_scope IS DISTINCT FROM OLD.subject_scope

     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id

     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key

     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash

     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN

    RAISE EXCEPTION 'Canonical operation identity is immutable'

      USING ERRCODE = '55000';

  END IF;

  IF NEW.subject_id IS NULL

     OR NEW.response_payload IS NULL

     OR NEW.completed_at IS NULL THEN

    RAISE EXCEPTION 'Canonical operation can only transition once to completed'

      USING ERRCODE = '55000';

  END IF;



  RETURN NEW;

END;

$function$;

CREATE OR REPLACE FUNCTION app_private.guard_payment_canonical_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$

declare

  v_id uuid;

begin

  v_id := case when tg_op = 'DELETE' then old.id else new.id end;

  if exists (

    select 1 from public.income_expenses ie

     where ie.payment_id = v_id and ie.deleted_at is null

       and app_private.is_income_expense_flow_owned(ie.id)

  ) then

    raise exception 'payment % links a canonical voucher — direct % rejected',

      v_id, tg_op using errcode = '55000';

  end if;

  if tg_op = 'DELETE' then return old; end if;

  return new;

end;

$function$;

-- ----------------------------------------------------------------------------
-- 4.2 Thu tiền / đảo thu tiền (canonical write, có idempotency ledger)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_invoice_payment_v4(p_invoice_id uuid, p_amount numeric, p_payment_method payment_method, p_payment_date date, p_idempotency_key text, p_account_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_receipt_image_url text DEFAULT NULL::text, p_voucher jsonb DEFAULT NULL::jsonb, p_items jsonb DEFAULT NULL::jsonb, p_receipt_number text DEFAULT NULL::text, p_voucher_owner_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

declare

  v_actor uuid := auth.uid();

  v_org uuid;

  v_authz record;

  v_inv record;

  v_owner uuid;

  v_key text;

  v_amount numeric(15,2);

  v_payload jsonb;

  v_items jsonb := '[]'::jsonb;

  v_hash text;

  v_op app_private.canonical_write_operations%rowtype;

  v_route text;

  v_flag app_private.server_feature_flags%rowtype;

  v_payment_id uuid;

  v_voucher_id uuid;

  v_new_paid numeric(15,2);

  v_status text;

  v_paid_date date;

  v_excess numeric(15,2) := 0;

  v_resp json;

  it jsonb; v_idx int := 0; v_type_id uuid;

  v_room uuid; v_chg uuid; v_rnd uuid;

  c_op constant text := 'invoice.record_payment.v1';

  c_max constant numeric := 9999999999999.99;

begin

  -- (0) auth + cheap normalization; NO ledger lookup yet.

  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  if p_amount is null or p_amount <= 0 or round(p_amount,2) <> p_amount or p_amount > c_max then

    raise exception 'Số tiền không hợp lệ'; end if;

  v_amount := p_amount;

  if p_payment_date is null or p_payment_date < date '2000-01-01'

     or p_payment_date > date '2100-12-31' then

    raise exception 'Ngày thu không hợp lệ'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));

  if char_length(v_key) < 8 or char_length(v_key) > 200

     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then

    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;



  -- (1) lock invoice + derive org from its building (invoices.organization_id

  --     untrusted). BEFORE any ledger read.

  select i.id, i.user_id, i.building_id, i.room_id, i.contract_id,

         i.total_amount, i.paid_amount, i.status, i.organization_id, i.invoice_number

    into v_inv from public.invoices i

   where i.id = p_invoice_id and i.deleted_at is null for update;

  if not found then raise exception 'Không tìm thấy hoá đơn' using errcode='42501'; end if;



  select b.organization_id into v_org

    from public.buildings b

    join public.organizations o on o.id = b.organization_id and o.status='ACTIVE'

   where b.id = v_inv.building_id and b.deleted_at is null for share of o, b;

  if not found or v_org is null then

    raise exception 'Toà nhà của hoá đơn không thuộc tổ chức đang hoạt động' using errcode='42501';

  end if;

  if v_inv.organization_id is not null and v_inv.organization_id <> v_org then

    raise exception 'Hoá đơn lệch tổ chức' using errcode='42501';

  end if;



  -- (2) authorize BEFORE idempotency: exact thu_tien.collect, server-derived

  --     org + building scope (+ cashbook when an account is used).

  perform app_private.lock_org_for_decision_v1(v_org);

  select * into v_authz from app_private.authorize_tenant_action_v3(

    v_actor, v_org, 'thu_tien.collect', v_inv.building_id, p_account_id);

  if not coalesce(v_authz.allowed,false) then

    raise exception 'Không có quyền thu tiền (thu_tien.collect)' using errcode='42501';

  end if;



  if p_voucher_owner_id is not null and p_voucher_owner_id <> v_inv.user_id then

    raise exception 'p_voucher_owner_id phải là chủ hoá đơn' using errcode='42501';

  end if;

  v_owner := v_inv.user_id;



  -- (3) validate every foreign resource to the SAME org; build canonical payload.

  if p_account_id is not null then

    perform 1 from public.accounts a

     where a.id = p_account_id and a.deleted_at is null and a.organization_id = v_org for share;

    if not found then raise exception 'Sổ quỹ không thuộc tổ chức của hoá đơn' using errcode='42501'; end if;

  end if;



  perform 1 from public.contracts c

   where c.id = v_inv.contract_id and c.deleted_at is null and c.organization_id = v_org for share;

  if not found then raise exception 'Hợp đồng của hoá đơn không thuộc tổ chức' using errcode='42501'; end if;



  if p_voucher is not null then

    v_room := nullif(p_voucher->>'room_id','')::uuid;

    v_chg  := nullif(p_voucher->>'change_account_id','')::uuid;

    v_rnd  := nullif(p_voucher->>'rounding_account_id','')::uuid;

    if v_room is not null then

      perform 1 from public.rooms r where r.id=v_room and r.deleted_at is null

        and r.building_id=v_inv.building_id and r.organization_id=v_org for share;

      if not found then raise exception 'Phòng của phiếu không thuộc toà/tổ chức' using errcode='42501'; end if;

    end if;

    if v_chg is not null then

      perform 1 from public.accounts a where a.id=v_chg and a.deleted_at is null and a.organization_id=v_org for share;

      if not found then raise exception 'Sổ quỹ tiền thối không thuộc tổ chức' using errcode='42501'; end if;

    end if;

    if v_rnd is not null then

      perform 1 from public.accounts a where a.id=v_rnd and a.deleted_at is null and a.organization_id=v_org for share;

      if not found then raise exception 'Sổ quỹ làm tròn không thuộc tổ chức' using errcode='42501'; end if;

    end if;

  end if;



  if p_items is not null then

    if jsonb_typeof(p_items) <> 'array' then raise exception 'items phải là mảng'; end if;

    for it in select value from jsonb_array_elements(p_items) loop

      v_idx := v_idx + 1;

      v_type_id := nullif(it->>'income_expense_type_id','')::uuid;

      if v_type_id is null then raise exception 'Hạng mục % thiếu loại thu', v_idx; end if;

      perform 1 from public.income_expense_types t

       where t.id=v_type_id and lower(t.type)='income' and t.organization_id=v_org for share;

      if not found then raise exception 'Loại hạng mục % không thuộc tổ chức/sai chiều thu', v_idx using errcode='42501'; end if;

      v_items := v_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(

        'income_expense_type_id', v_type_id,

        'description', nullif(btrim(it->>'description'),''),

        'quantity', coalesce((it->>'quantity')::numeric,1),

        'unit_price', round((it->>'unit_price')::numeric,2),

        'start_date', nullif(it->>'start_date','')::date,

        'end_date', nullif(it->>'end_date','')::date)));

    end loop;

  end if;



  v_payload := jsonb_strip_nulls(jsonb_build_object(

    'invoice_id', p_invoice_id, 'organization_id', v_org, 'amount', v_amount,

    'payment_method', p_payment_method::text, 'payment_date', p_payment_date,

    'account_id', p_account_id, 'receipt_number', nullif(btrim(p_receipt_number),''),

    'receipt_image_url', nullif(btrim(p_receipt_image_url),''),

    'notes', nullif(p_notes,''), 'voucher_owner_id', v_owner,

    'room_id', v_room, 'change_account_id', v_chg, 'rounding_account_id', v_rnd,

    'items', v_items));

  v_hash := md5(v_payload::text);



  -- (4) durable idempotency claim = linearization point (AFTER authz).

  insert into app_private.canonical_write_operations

    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)

  values (v_org, c_op, p_invoice_id::text, v_actor, v_key, v_hash)

  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;



  select * into v_op from app_private.canonical_write_operations o

   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_invoice_id::text

     and o.actor_id=v_actor and o.idempotency_key=v_key for update;

  if not found then raise exception 'Không nhận diện được operation idempotency' using errcode='55000'; end if;



  if v_op.payload_hash <> v_hash then

    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505';

  end if;

  if v_op.completed_at is not null then

    return v_op.response_payload::json; -- replay original; survives OFF/freeze

  end if;



  -- (4b) Cross-ledger guard (route-flip race), NEW CLAIMANTS ONLY — phải đứng

  -- SAU replay-return: voucher do chính v4 tạo cũng stamp idempotency_key, nên

  -- đặt guard trước replay sẽ 23505 nhầm chính op đã hoàn tất của v4 (bắt được

  -- nhờ canary live 2026-07-18, t1b_90 replay-không-voucher không lộ). Với claim

  -- MỚI: key đã bị đường LEGACY v3 tiêu thụ (stamp trên income_expenses) mà

  -- re-execute canonical thì retry vắt qua flip sẽ double-pay → 23505 hiển thị.

  -- Residual: v3 không voucher-mirror không stamp key (gap có sẵn của v3).

  if exists (select 1 from public.income_expenses ie

              where ie.idempotency_key = v_key and ie.deleted_at is null) then

    raise exception 'idempotency_key đã dùng ở đường legacy (v3)' using errcode='23505';

  end if;



  -- (5) rollout admission — new claimant only. Default OFF ⇒ blocked.

  v_route := app_private.evaluate_feature_route(c_op, v_org);

  if v_route <> 'CANONICAL' then

    raise exception 'Writer thu tiền chưa bật cho tổ chức này' using errcode='55000';

  end if;



  -- (5b) rollout cap accounting + enforcement. FOR UPDATE serializes concurrent

  -- admits per feature; ops row rolls back with the tx nếu effects fail.

  -- Count-cap enforce ở evaluate_feature_route lần gọi SAU (count >= max →

  -- FROZEN → thông điệp "chưa bật" → client coexistence-fallback về legacy).

  -- Amount-caps enforce tại đây cho mode CANARY; thông điệp giữ cụm "chưa bật"

  -- để adapter route giao dịch vượt hạn mức về legacy thay vì fail user.

  select * into v_flag from app_private.server_feature_flags

   where feature_key = c_op for update;

  if v_flag.mode = 'CANARY' then

    if v_amount > v_flag.max_single_amount_vnd then

      raise exception 'Writer thu tiền chưa bật cho giao dịch này (vượt hạn mức đơn lẻ canary)'

        using errcode='55000';

    end if;

    if coalesce((select sum(o.amount_vnd)

                   from app_private.server_feature_flag_operations o

                  where o.feature_key = c_op

                    and o.config_version = v_flag.config_version), 0) + v_amount

       > v_flag.max_total_amount_vnd then

      raise exception 'Writer thu tiền chưa bật cho giao dịch này (vượt tổng hạn mức canary)'

        using errcode='55000';

    end if;

  end if;

  insert into app_private.server_feature_flag_operations

    (feature_key, config_version, operation_key, organization_id, amount_vnd)

  values (c_op, v_flag.config_version, v_key || ':' || p_invoice_id::text, v_org, v_amount)

  on conflict do nothing;



  -- (6) effects — atomic, all org-stamped (v3 omits org).

  insert into public.payments

    (invoice_id, organization_id, user_id, amount, payment_method, payment_date,

     notes, receipt_image_url, receipt_number)

  values (p_invoice_id, v_org, v_owner, v_amount, p_payment_method, p_payment_date,

          p_notes, p_receipt_image_url, p_receipt_number)

  returning id into v_payment_id;



  v_new_paid := coalesce(v_inv.paid_amount,0) + v_amount;

  if v_new_paid >= v_inv.total_amount then

    v_status := 'PAID'; v_paid_date := p_payment_date; v_excess := v_new_paid - v_inv.total_amount;

    if v_excess > 0 then

      insert into public.excess_amounts

        (contract_id, organization_id, user_id, amount, description, source_invoice_id, source_payment_id)

      values (v_inv.contract_id, v_org, v_owner, v_excess,

              'Tiền thừa từ hoá đơn ' || coalesce(v_inv.invoice_number,''), p_invoice_id, v_payment_id);

    end if;

  else

    v_status := 'PARTIAL_PAID'; v_paid_date := null;

  end if;



  update public.invoices set paid_amount=v_new_paid, status=v_status::invoice_status, paid_date=v_paid_date

   where id = p_invoice_id;



  if p_account_id is not null and p_voucher is not null then

    insert into public.income_expenses (

      user_id, organization_id, type, name, building_id, room_id, contract_id,

      account_id, invoice_id, payment_id, voucher_date, payer_name, notes, attachments,

      approval_status, approved_by, approved_at, idempotency_key)

    values (

      v_owner, v_org, 'INCOME', coalesce(p_voucher->>'name','Thu tiền hoá đơn'),

      v_inv.building_id, v_room, v_inv.contract_id, p_account_id, p_invoice_id, v_payment_id,

      p_payment_date, p_voucher->>'payer_name', p_voucher->>'notes',

      coalesce(p_voucher->'attachments','[]'::jsonb),

      'APPROVED', v_actor, now(), v_key)

    returning id into v_voucher_id;

    insert into public.income_expense_items

      (income_expense_id, organization_id, income_expense_type_id, description,

       quantity, unit_price, start_date, end_date)

    select v_voucher_id, v_org, (x->>'income_expense_type_id')::uuid, x->>'description',

      coalesce((x->>'quantity')::numeric,1), (x->>'unit_price')::numeric,

      nullif(x->>'start_date','')::date, nullif(x->>'end_date','')::date

    from jsonb_array_elements(v_items) as x;

  end if;



  -- (7) complete the operation durably.

  v_resp := json_build_object('payment_id', v_payment_id, 'voucher_id', v_voucher_id,

    'new_paid_amount', v_new_paid, 'new_status', v_status, 'excess_amount', v_excess);

  update app_private.canonical_write_operations

     set subject_id=v_payment_id, response_payload=to_jsonb(v_resp), completed_at=now()

   where organization_id=v_org and operation=c_op and subject_scope=p_invoice_id::text

     and actor_id=v_actor and idempotency_key=v_key;



  return v_resp;

end;

$function$;

CREATE OR REPLACE FUNCTION public.reverse_invoice_payment_v3(p_payment_id uuid, p_reason text, p_idempotency_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

declare

  v_actor uuid := auth.uid();

  v_org uuid;

  v_authz boolean;

  v_pay record;

  v_inv record;

  v_key text;

  v_hash text;

  v_op app_private.canonical_write_operations%rowtype;

  v_route text;

  v_refund_voucher uuid;

  v_refund_type uuid;

  v_excess_total numeric(15,2);

  v_resp json;

  c_op constant text := 'invoice.reverse_payment.v1';

begin

  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));

  if char_length(v_key) < 8 or char_length(v_key) > 200

     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then

    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;

  if coalesce(length(btrim(p_reason)),0) < 5 then

    raise exception 'Lý do hoàn tác quá ngắn'; end if;



  -- lock the original payment + its invoice; derive org from building.

  select p.id, p.invoice_id, p.amount, p.payment_date

    into v_pay from public.payments p where p.id = p_payment_id for update;

  if not found then raise exception 'Không tìm thấy giao dịch thu' using errcode='42501'; end if;



  select i.id, i.building_id, i.room_id, i.contract_id, i.organization_id

    into v_inv from public.invoices i where i.id = v_pay.invoice_id and i.deleted_at is null for update;

  if not found then raise exception 'Hoá đơn không còn tồn tại' using errcode='42501'; end if;



  select b.organization_id into v_org from public.buildings b

    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'

   where b.id=v_inv.building_id and b.deleted_at is null for share of o,b;

  if not found or v_org is null then

    raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;



  -- exact permission thu_tien.undo (NOT a new key), building-scoped.

  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(

    v_actor, v_org, 'thu_tien.undo', v_inv.building_id, null);

  if not coalesce(v_authz,false) then

    raise exception 'Không có quyền hoàn tác thu tiền (thu_tien.undo)' using errcode='42501'; end if;



  v_hash := md5(jsonb_build_object('payment_id',p_payment_id,'org',v_org,'amount',v_pay.amount)::text);



  -- durable idempotency claim FIRST — a same-key replay must return the original

  -- response before the anti-double check (otherwise a legitimate retry looks

  -- like a double-reversal).

  insert into app_private.canonical_write_operations

    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)

  values (v_org, c_op, p_payment_id::text, v_actor, v_key, v_hash)

  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;

  select * into v_op from app_private.canonical_write_operations o

   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_payment_id::text

     and o.actor_id=v_actor and o.idempotency_key=v_key for update;

  if v_op.payload_hash <> v_hash then

    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;

  if v_op.completed_at is not null then return v_op.response_payload::json; end if;



  -- anti-double (a DIFFERENT key trying to reverse an already-reversed payment).

  if exists (select 1 from app_private.payment_reversals where original_payment_id = p_payment_id) then

    raise exception 'Giao dịch đã được hoàn tác' using errcode='55000'; end if;

  -- cannot reverse a refund voucher's own payment (there is none, but guard the

  -- case where p_payment_id is a reversal target).

  if exists (select 1 from app_private.payment_reversals pr

             where pr.reversal_voucher_id in (

               select ie.id from public.income_expenses ie where ie.payment_id = p_payment_id)) then

    raise exception 'Không thể hoàn tác một bút toán hoàn tác' using errcode='55000'; end if;



  v_route := app_private.evaluate_feature_route(c_op, v_org);

  if v_route <> 'CANONICAL' then

    raise exception 'Writer hoàn tác chưa bật cho tổ chức này' using errcode='55000'; end if;



  -- Forward-fix: compensating REFUND voucher (EXPENSE, type 'Tiền thối') that

  -- the live recompute_invoice_for_id SUBTRACTS from paid_amount. Original

  -- payment row stays intact. Get-or-create the org's refund type.

  select id into v_refund_type from public.income_expense_types

   where organization_id = v_org and name = 'Tiền thối' and lower(coalesce(type,'expense'))='expense'

   limit 1;

  if v_refund_type is null then

    insert into public.income_expense_types (organization_id, name, type)

    values (v_org, 'Tiền thối', 'expense') returning id into v_refund_type;

  end if;



  insert into public.income_expenses

    (user_id, organization_id, type, name, building_id, room_id, contract_id,

     invoice_id, voucher_date, approval_status, approved_by, approved_at, notes)

  values

    (v_actor, v_org, 'EXPENSE', 'Hoàn tác thu tiền', v_inv.building_id, v_inv.room_id,

     v_inv.contract_id, v_inv.id, v_pay.payment_date, 'APPROVED', v_actor, now(),

     'Hoàn tác: ' || p_reason)

  returning id into v_refund_voucher;

  insert into public.income_expense_items

    (income_expense_id, organization_id, income_expense_type_id, description, quantity, unit_price)

  values (v_refund_voucher, v_org, v_refund_type, 'Hoàn tác thu tiền', 1, v_pay.amount);



  -- recompute needs a nudge (item insert doesn't fire the payments trigger);

  -- touch the invoice's payments to re-run recompute deterministically.

  perform recompute_invoice_for_id(v_inv.id);



  -- record the reversal linkage (anti-double).

  insert into app_private.payment_reversals

    (original_payment_id, reversal_voucher_id, organization_id, actor_id, reason)

  values (p_payment_id, v_refund_voucher, v_org, v_actor, p_reason);



  -- negate any excess credit from the original payment (compensating row).

  select coalesce(sum(amount),0) into v_excess_total from public.excess_amounts

   where source_payment_id = p_payment_id;

  if v_excess_total <> 0 then

    insert into public.excess_amounts

      (contract_id, organization_id, user_id, amount, description, source_invoice_id, source_payment_id)

    values (v_inv.contract_id, v_org, v_actor, -v_excess_total,

            'Hoàn tác tiền thừa', v_inv.id, p_payment_id);

  end if;



  v_resp := json_build_object('reversal_voucher_id', v_refund_voucher,

    'original_payment_id', p_payment_id, 'reversed_amount', v_pay.amount);

  update app_private.canonical_write_operations

     set subject_id=v_refund_voucher, response_payload=to_jsonb(v_resp), completed_at=now()

   where organization_id=v_org and operation=c_op and subject_scope=p_payment_id::text

     and actor_id=v_actor and idempotency_key=v_key;

  return v_resp;

end;

$function$;

-- ----------------------------------------------------------------------------
-- 4.3 Tạo & sửa hoá đơn
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_invoice_v1(p_contract_id uuid, p_building_id uuid, p_room_id uuid, p_billing_month text, p_issue_date date, p_due_date date, p_kind text, p_subtotal numeric, p_discount_amount numeric, p_total_amount numeric, p_previous_debt numeric, p_items jsonb, p_idempotency_key text, p_prepaid_amount numeric DEFAULT 0, p_discount_notes text DEFAULT NULL::text, p_electricity_prev_overridden boolean DEFAULT false, p_previous_debt_sources jsonb DEFAULT '[]'::jsonb, p_template_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_applied_credit numeric DEFAULT 0, p_creator_name text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_authz boolean;
  v_auto boolean;
  v_status text;
  v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  v_invoice uuid;
  v_invoice_number text;
  v_resp json;
  it jsonb; v_idx int := 0;
  v_total_calc numeric(15,2);
  v_applied numeric(15,2);
  c_op constant text := 'invoice.create.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_total_amount is null or p_total_amount < 0 then raise exception 'Tổng tiền không hợp lệ'; end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items phải là JSON array'; end if;

  -- derive + lock: building → org; contract same-org; room same-building/org.
  select b.organization_id into v_org from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.id=p_building_id and b.deleted_at is null for share of o,b;
  if not found or v_org is null then
    raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;
  -- contracts link to a building via their room, not a direct building_id column.
  perform 1 from public.contracts c where c.id=p_contract_id and c.deleted_at is null
    and c.organization_id=v_org for share;
  if not found then raise exception 'Hợp đồng không thuộc tổ chức' using errcode='42501'; end if;
  if p_room_id is not null then
    perform 1 from public.rooms r where r.id=p_room_id and r.deleted_at is null
      and r.building_id=p_building_id and r.organization_id=v_org for share;
    if not found then raise exception 'Phòng không thuộc toà/tổ chức' using errcode='42501'; end if;
  end if;

  -- exact permission invoices.create, building-scoped.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'invoices.create', p_building_id, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền tạo hoá đơn (invoices.create)' using errcode='42501'; end if;

  -- server decides APPROVED vs DRAFT from org settings; missing row = abort.
  select auto_approve_invoice into v_auto from public.organization_invoice_settings
   where organization_id = v_org;
  if v_auto is null then
    raise exception 'Thiếu cấu hình auto_approve_invoice cho tổ chức' using errcode='55000'; end if;
  v_status := case when v_auto then 'APPROVED' else 'DRAFT' end;

  v_hash := md5(jsonb_build_object('contract',p_contract_id,'month',p_billing_month,
    'total',p_total_amount,'org',v_org)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_contract_id::text || '|' || p_billing_month, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op
     and o.subject_scope=p_contract_id::text || '|' || p_billing_month
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then
    raise exception 'Writer hoá đơn chưa bật cho tổ chức này' using errcode='55000'; end if;

  -- ---- PARITY: làm tròn server mirror roundInvoiceTotal + ASSERT khớp total ----
  -- total = round(p_subtotal − discount + nợ cũ) TRÊN SUBTOTAL CLIENT GỬI (KHÔNG
  -- re-sum items — giữ giả định item-shape của mọi caller, gồm create_contract_v1).
  -- KHÔNG clamp ≥0 (mirror useCreateInvoice; KHÁC clamp hiển thị Math.max(0,…) của
  -- GenerateInvoiceDialog). Guard p_total_amount<0 ở trên vẫn chặn tổng âm.
  v_total_calc := app_private.round_invoice_total_v1(
    coalesce(p_subtotal,0) - coalesce(p_discount_amount,0) + coalesce(p_previous_debt,0));

  if v_total_calc is distinct from p_total_amount then
    raise exception
      'Tổng tiền client (%) khác tổng server làm tròn (%) [subtotal=%, discount=%, nợ cũ=%]',
      p_total_amount, v_total_calc, coalesce(p_subtotal,0),
      coalesce(p_discount_amount,0), coalesce(p_previous_debt,0)
      using errcode='22000';
  end if;

  -- create the invoice; the live partial-unique (contract_id, billing_month)
  -- WHERE deleted_at IS NULL AND status<>'CANCELLED' AND kind='MONTHLY'
  -- enforces one-per-period. invoice_number BỎ TRỐNG → trigger
  -- generate_invoice_number_v2 (BEFORE INSERT) tự sinh.
  insert into public.invoices
    (user_id, organization_id, contract_id, building_id, room_id, billing_month,
     issue_date, due_date, kind, status, subtotal, discount_amount, discount_notes,
     electricity_prev_overridden, total_amount, prepaid_amount, paid_amount,
     previous_debt, previous_debt_sources, notes, template_id, creator_name,
     approved_by, approved_at)
  values
    (v_actor, v_org, p_contract_id, p_building_id, p_room_id, p_billing_month,
     p_issue_date, p_due_date, coalesce(p_kind,'MONTHLY'), v_status::invoice_status,
     coalesce(p_subtotal,0), coalesce(p_discount_amount,0), p_discount_notes,
     coalesce(p_electricity_prev_overridden,false), p_total_amount,
     coalesce(p_prepaid_amount,0), 0,
     coalesce(p_previous_debt,0),
     coalesce(p_previous_debt_sources,'[]'::jsonb), p_notes, p_template_id,
     p_creator_name,
     case when v_auto then v_actor else null end,
     case when v_auto then now() else null end)
  returning id, invoice_number into v_invoice, v_invoice_number;

  -- ---- PARITY: bước tiêu credit (mirror useCreateInvoice:639-652) ----
  -- Áp credit vào Giảm trừ HĐ → ghi excess_amounts ÂM CÙNG TX. amount đã cộng vào
  -- discount_amount ở client nên KHÔNG trừ 2 lần; row âm chỉ hạ số dư credit HĐ.
  v_applied := coalesce(p_applied_credit,0);
  if v_applied > 0 and p_contract_id is not null then
    insert into public.excess_amounts
      (user_id, organization_id, contract_id, amount, description,
       source_invoice_id, source_payment_id)
    values
      (v_actor, v_org, p_contract_id, -v_applied,
       'Áp credit vào Giảm trừ HĐ ' || coalesce(v_invoice_number, v_invoice::text),
       v_invoice, null);
  end if;

  -- ---- PARITY: items whitelist 12 field client ----
  -- amount = amount client gửi (1 trong 12 field, giữ hành vi writer cũ), fallback
  -- tính unit_price*quantity*coefficient nếu vắng. sort_order lấy client, fallback
  -- thứ tự xuất hiện.
  if p_items is not null then
    for it in select value from jsonb_array_elements(p_items) loop
      v_idx := v_idx + 1;
      insert into public.invoice_items
        (invoice_id, organization_id, service_id, type, description, unit_price,
         quantity, coefficient, amount, previous_reading, current_reading,
         from_date, to_date, sort_order)
      values (
        v_invoice, v_org,
        nullif(it->>'service_id','')::uuid,
        coalesce(nullif(it->>'type','')::invoice_item_type, 'OTHER'::invoice_item_type),
        it->>'description',
        coalesce((it->>'unit_price')::numeric,0),
        coalesce((it->>'quantity')::numeric,1),
        coalesce((it->>'coefficient')::numeric,1),
        coalesce((it->>'amount')::numeric,
          coalesce((it->>'unit_price')::numeric,0)
          * coalesce((it->>'quantity')::numeric,1)
          * coalesce((it->>'coefficient')::numeric,1)),
        nullif(it->>'previous_reading','')::numeric,
        nullif(it->>'current_reading','')::numeric,
        nullif(it->>'from_date','')::date,
        nullif(it->>'to_date','')::date,
        coalesce((it->>'sort_order')::int, v_idx)
      );
    end loop;
  end if;

  v_resp := json_build_object('invoice_id', v_invoice, 'status', v_status,
                              'invoice_number', v_invoice_number);
  update app_private.canonical_write_operations
     set subject_id=v_invoice, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op
     and subject_scope=p_contract_id::text || '|' || p_billing_month
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_invoice_v1(p_invoice_id uuid, p_contract_id uuid, p_building_id uuid, p_room_id uuid, p_billing_month text, p_issue_date date, p_due_date date, p_subtotal numeric, p_discount_amount numeric, p_total_amount numeric, p_previous_debt numeric, p_items jsonb, p_prepaid_amount numeric DEFAULT 0, p_discount_notes text DEFAULT NULL::text, p_electricity_prev_overridden boolean DEFAULT false, p_previous_debt_sources jsonb DEFAULT '[]'::jsonb, p_template_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
  v_org uuid;
  it jsonb; v_idx int := 0;
  v_total_calc numeric(15,2);
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items phải là JSON array'; end if;

  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode='42501'; end if;
  v_org := v_row.organization_id;

  -- SERVER mirror canEditInvoice: (DRAFT|APPROVED) AND paid_amount=0. Dùng errcode
  -- mặc định (P0001, KHÔNG fallback) → lỗi hiện thẳng như legacy hook, không rơi
  -- xuống đường legacy để lách guard.
  if v_row.status not in ('DRAFT'::invoice_status, 'APPROVED'::invoice_status)
     or coalesce(v_row.paid_amount,0) <> 0 then
    raise exception 'Không thể chỉnh sửa hoá đơn ở trạng thái này';
  end if;

  -- quyền edit theo toà HIỆN TẠI của hoá đơn.
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền chỉnh sửa hoá đơn này' using errcode='42501'; end if;

  -- Nếu ĐỔI toà → chặn cross-org + đòi quyền edit trên toà đích. (Đổi phòng cũng
  -- verify thuộc toà đích/cùng org, mirror ràng buộc create.)
  if p_building_id is distinct from v_row.building_id then
    perform 1 from public.buildings b
     where b.id=p_building_id and b.deleted_at is null and b.organization_id=v_org;
    if not found then
      raise exception 'Toà đích không thuộc tổ chức của hoá đơn' using errcode='42501'; end if;
    if not app_private.can_edit_invoice_building_v1(p_building_id) then
      raise exception 'Không có quyền chỉnh sửa sang toà này' using errcode='42501'; end if;
  end if;
  if p_room_id is not null then
    perform 1 from public.rooms r
     where r.id=p_room_id and r.deleted_at is null
       and r.building_id=p_building_id and r.organization_id=v_org;
    if not found then
      raise exception 'Phòng không thuộc toà/tổ chức' using errcode='42501'; end if;
  end if;

  -- recalc total + assert (làm tròn trên p_subtotal, giống create).
  v_total_calc := app_private.round_invoice_total_v1(
    coalesce(p_subtotal,0) - coalesce(p_discount_amount,0) + coalesce(p_previous_debt,0));

  if v_total_calc is distinct from p_total_amount then
    raise exception
      'Tổng tiền client (%) khác tổng server làm tròn (%) [subtotal=%, discount=%, nợ cũ=%]',
      p_total_amount, v_total_calc, coalesce(p_subtotal,0),
      coalesce(p_discount_amount,0), coalesce(p_previous_debt,0)
      using errcode='22000';
  end if;

  update public.invoices
     set contract_id                 = p_contract_id,
         building_id                 = p_building_id,
         room_id                     = p_room_id,
         billing_month               = p_billing_month,
         issue_date                  = p_issue_date,
         due_date                    = p_due_date,
         subtotal                    = coalesce(p_subtotal,0),
         discount_amount             = coalesce(p_discount_amount,0),
         discount_notes              = p_discount_notes,
         electricity_prev_overridden = coalesce(p_electricity_prev_overridden,false),
         total_amount                = p_total_amount,
         prepaid_amount              = coalesce(p_prepaid_amount,0),
         previous_debt               = coalesce(p_previous_debt,0),
         previous_debt_sources       = coalesce(p_previous_debt_sources,'[]'::jsonb),
         notes                       = p_notes,
         template_id                 = p_template_id
   where id = p_invoice_id
   returning * into v_row;

  -- replace items (delete-all rồi insert lại, mirror legacy).
  delete from public.invoice_items where invoice_id = p_invoice_id;
  if p_items is not null then
    for it in select value from jsonb_array_elements(p_items) loop
      v_idx := v_idx + 1;
      insert into public.invoice_items
        (invoice_id, organization_id, service_id, type, description, unit_price,
         quantity, coefficient, amount, previous_reading, current_reading,
         from_date, to_date, sort_order)
      values (
        p_invoice_id, v_org,
        nullif(it->>'service_id','')::uuid,
        coalesce(nullif(it->>'type','')::invoice_item_type, 'OTHER'::invoice_item_type),
        it->>'description',
        coalesce((it->>'unit_price')::numeric,0),
        coalesce((it->>'quantity')::numeric,1),
        coalesce((it->>'coefficient')::numeric,1),
        coalesce((it->>'amount')::numeric,
          coalesce((it->>'unit_price')::numeric,0)
          * coalesce((it->>'quantity')::numeric,1)
          * coalesce((it->>'coefficient')::numeric,1)),
        nullif(it->>'previous_reading','')::numeric,
        nullif(it->>'current_reading','')::numeric,
        nullif(it->>'from_date','')::date,
        nullif(it->>'to_date','')::date,
        coalesce((it->>'sort_order')::int, v_idx)
      );
    end loop;
  end if;

  return v_row;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 4.4 Writer trạng thái hoá đơn (8)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.approve_invoice_v1(p_invoice_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode = '42501';
  end if;
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền duyệt hoá đơn này' using errcode = '42501';
  end if;
  if v_row.status = 'APPROVED' then
    return v_row; -- idempotent no-op
  end if;
  if v_row.status <> 'DRAFT' then
    raise exception 'Chỉ duyệt được hoá đơn Nháp (trạng thái hiện tại: %)', v_row.status;
  end if;
  update public.invoices
     set status = 'APPROVED', approved_at = now(), approved_by = v_actor
   where id = v_row.id
   returning * into v_row;
  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.unapprove_invoice_v1(p_invoice_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode = '42501';
  end if;
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền bỏ duyệt hoá đơn này' using errcode = '42501';
  end if;
  if v_row.status = 'DRAFT' then
    return v_row; -- idempotent no-op
  end if;
  if v_row.status <> 'APPROVED' then
    raise exception 'Chỉ bỏ duyệt được hoá đơn Đã duyệt (trạng thái hiện tại: %)', v_row.status;
  end if;
  update public.invoices
     set status = 'DRAFT', approved_at = null, approved_by = null
   where id = v_row.id
   returning * into v_row;
  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bulk_approve_invoices_v1(p_invoice_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_count integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  if p_invoice_ids is null or array_length(p_invoice_ids, 1) is null then
    return 0;
  end if;
  update public.invoices i
     set status = 'APPROVED', approved_at = now(), approved_by = v_actor
   where i.id = any (p_invoice_ids)
     and i.deleted_at is null
     and i.status = 'DRAFT'
     and app_private.can_edit_invoice_building_v1(i.building_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_invoice_v1(p_invoice_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode = '42501';
  end if;
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền huỷ hoá đơn này' using errcode = '42501';
  end if;
  if v_row.status = 'CANCELLED' then
    return v_row; -- idempotent no-op
  end if;
  update public.invoices
     set status = 'CANCELLED'
   where id = v_row.id
   returning * into v_row;
  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.restore_invoice_v1(p_invoice_id uuid)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode = '42501';
  end if;
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền phục hồi hoá đơn này' using errcode = '42501';
  end if;
  if v_row.status <> 'CANCELLED' then
    raise exception 'Chỉ phục hồi được hoá đơn Đã huỷ (trạng thái hiện tại: %)', v_row.status;
  end if;
  update public.invoices
     set status = 'APPROVED', approved_at = now(), approved_by = v_actor
   where id = v_row.id
   returning * into v_row;
  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.soft_delete_invoice_v1(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode = '42501';
  end if;
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền xoá hoá đơn này' using errcode = '42501';
  end if;
  if v_row.status not in ('DRAFT', 'APPROVED') or coalesce(v_row.paid_amount, 0) <> 0 then
    raise exception 'Không thể xoá hoá đơn ở trạng thái này';
  end if;
  update public.invoices
     set deleted_at = now()
   where id = v_row.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bulk_soft_delete_invoices_v1(p_invoice_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_count integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  if p_invoice_ids is null or array_length(p_invoice_ids, 1) is null then
    return 0;
  end if;
  update public.invoices i
     set deleted_at = now()
   where i.id = any (p_invoice_ids)
     and i.deleted_at is null
     and i.status = 'DRAFT'
     and app_private.can_edit_invoice_building_v1(i.building_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_overdue_invoices_v1()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_count integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  update public.invoices i
     set status = 'OVERDUE'
   where i.deleted_at is null
     and i.status in ('APPROVED', 'PARTIAL_PAID')
     and i.due_date < current_date
     and app_private.can_edit_invoice_building_v1(i.building_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 4.5 Super-admin force cancel
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.super_admin_force_cancel_invoice_v2(p_invoice_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$

declare

  v_actor uuid := auth.uid();

  v_inv public.invoices%rowtype;

  v_active_payments int;

  v_has_reversals boolean;

begin

  if v_actor is null then

    raise exception 'Chưa đăng nhập' using errcode = '42501';

  end if;

  if not public.is_super_admin() then

    raise exception 'Chỉ super admin được phép huỷ hoá đơn ở trạng thái này' using errcode = '42501';

  end if;



  select * into v_inv from public.invoices where id = p_invoice_id for update;

  if not found then

    raise exception 'Hoá đơn không tồn tại';

  end if;

  if v_inv.deleted_at is not null then

    raise exception 'Hoá đơn đã bị xoá trước đó';

  end if;

  if v_inv.status = 'CANCELLED' then

    return json_build_object('invoice_id', v_inv.id, 'status', 'CANCELLED', 'noop', true);

  end if;



  -- LUẬT OWNER: mọi phiếu thu phải được huỷ/hoàn TRƯỚC.

  select to_regclass('app_private.payment_reversals') is not null into v_has_reversals;

  if v_has_reversals then

    execute

      'select count(*) from public.payments p

        where p.invoice_id = $1

          and not exists (select 1 from app_private.payment_reversals r

                           where r.original_payment_id = p.id)'

      into v_active_payments using p_invoice_id;

  else

    select count(*) into v_active_payments from public.payments p

     where p.invoice_id = p_invoice_id;

  end if;



  if v_active_payments > 0 then

    raise exception 'Hoá đơn còn % phiếu thu hiệu lực — hãy huỷ/hoàn từng phiếu thu trước rồi mới huỷ hoá đơn', v_active_payments;

  end if;



  -- Sạch phiếu thu: xoá credit gốc sinh TỪ hoá đơn này (không phải từ payment —

  -- các dòng đó thuộc vòng đời payment/reversal), rồi huỷ.

  delete from public.excess_amounts

   where source_invoice_id = p_invoice_id and source_payment_id is null;



  update public.invoices set status = 'CANCELLED' where id = p_invoice_id;



  return json_build_object('invoice_id', v_inv.id, 'status', 'CANCELLED', 'noop', false);

end;

$function$;

-- ============================================================================
-- 5. TRIGGER (3)
-- ============================================================================

DROP TRIGGER IF EXISTS canonical_write_operations_immutable ON app_private.canonical_write_operations;
CREATE TRIGGER canonical_write_operations_immutable BEFORE DELETE OR UPDATE ON app_private.canonical_write_operations FOR EACH ROW EXECUTE FUNCTION app_private.guard_canonical_write_operation();

DROP TRIGGER IF EXISTS canonical_write_operations_no_truncate ON app_private.canonical_write_operations;
CREATE TRIGGER canonical_write_operations_no_truncate BEFORE TRUNCATE ON app_private.canonical_write_operations FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_canonical_write_operation();

DROP TRIGGER IF EXISTS a00_payment_canonical_link_guard ON public.payments;
CREATE TRIGGER a00_payment_canonical_link_guard BEFORE DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION app_private.guard_payment_canonical_link();

-- ============================================================================
-- 6. GRANT / REVOKE — chép đúng ACL thật trên prod (pg_proc.proacl, pg_class.relacl)
-- ============================================================================

-- 6.1 Bảng
REVOKE ALL ON TABLE app_private.canonical_write_operations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE app_private.canonical_write_operations TO ie_canonical_writer;

-- payment_reversals: owner-only trên prod (relacl chỉ có postgres) — không cấp cho ai.
REVOKE ALL ON TABLE app_private.payment_reversals FROM PUBLIC, anon, authenticated, service_role;

-- 6.2 Hàm — app_private helper/trigger: owner-only (proacl chỉ postgres=X)
REVOKE ALL ON FUNCTION app_private.round_invoice_total_v1(numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.can_edit_invoice_building_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_canonical_write_operation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_payment_canonical_link() FROM PUBLIC, anon, authenticated, service_role;

-- 6.3 Hàm thu tiền: authenticated (KHÔNG cấp service_role — đúng như prod)
REVOKE ALL ON FUNCTION public.record_invoice_payment_v4(uuid, numeric, public.payment_method, date, text, uuid, text, text, jsonb, jsonb, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment_v4(uuid, numeric, public.payment_method, date, text, uuid, text, text, jsonb, jsonb, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.reverse_invoice_payment_v3(uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_invoice_payment_v3(uuid, text, text) TO authenticated;

-- 6.4 Hàm hoá đơn: authenticated + service_role
REVOKE ALL ON FUNCTION public.create_invoice_v1(uuid, uuid, uuid, text, date, date, text, numeric, numeric, numeric, numeric, jsonb, text, numeric, text, boolean, jsonb, uuid, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_v1(uuid, uuid, uuid, text, date, date, text, numeric, numeric, numeric, numeric, jsonb, text, numeric, text, boolean, jsonb, uuid, text, numeric, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_invoice_v1(uuid, uuid, uuid, uuid, text, date, date, numeric, numeric, numeric, numeric, jsonb, numeric, text, boolean, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_invoice_v1(uuid, uuid, uuid, uuid, text, date, date, numeric, numeric, numeric, numeric, jsonb, numeric, text, boolean, jsonb, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.approve_invoice_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_invoice_v1(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.unapprove_invoice_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unapprove_invoice_v1(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.bulk_approve_invoices_v1(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_approve_invoices_v1(uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_invoice_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_invoice_v1(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restore_invoice_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_invoice_v1(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.soft_delete_invoice_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_invoice_v1(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.bulk_soft_delete_invoices_v1(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_soft_delete_invoices_v1(uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_overdue_invoices_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_overdue_invoices_v1() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.super_admin_force_cancel_invoice_v2(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.super_admin_force_cancel_invoice_v2(uuid) TO authenticated, service_role;

-- ============================================================================
-- HẾT PS02 — 2 bảng, 9 constraint, 1 index rời, 17 hàm, 3 trigger, 0 policy, 1 role
-- ============================================================================
