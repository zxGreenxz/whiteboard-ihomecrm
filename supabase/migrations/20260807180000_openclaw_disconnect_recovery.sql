-- Ngắt kết nối OpenClaw đang là hành động MỘT CHIỀU trên production.
--
-- Đo trên hệ thống thật ngày 2026-08-07: lệnh DISCONNECT chạy trọn vẹn (cell logout
-- thật, state=ACKNOWLEDGED, effect_disposition=PROVIDER_CONFIRMED, mọi generation
-- khớp) mà tài khoản vẫn kẹt DISCONNECTING, vì
-- `openclaw_try_finalize_disconnect_v1` còn đòi bản thu hồi phải có
-- acknowledgement_hash và acknowledged_at. Chữ ký đó do media gateway cấp — mà
-- gateway chưa từng được dựng, secret chưa từng được đặt, nên `openclaw-control`
-- sập ngay tại `revocation.ts` với "OpenClaw media gateway URL must be the trusted
-- HTTPS origin".
--
-- Hệ quả: tài khoản vào DISCONNECTING là không ra được — không kết nối lại, cũng
-- không lấy mã QR mới, vì `openclaw_begin_qr_login_v1` chỉ nhận DISCONNECTED /
-- QR_PENDING.
--
-- Migration này KHÔNG xoá điều kiện đó. Nó biến việc "deployment này chưa có media
-- gateway" thành một tuyên bố tường minh, có ghi vết phê duyệt, và khi nào dựng
-- gateway thì bật cờ lên là điều kiện có hiệu lực trở lại y như cũ.

begin;

-- 1) Cờ khai báo thế trận, đặt trong đúng sổ cờ sẵn có của repo.
--
-- Giá trị bảo mật của acknowledgement KHÔNG nằm ở mật mã: hash kỳ vọng được tính
-- xác định từ dữ liệu công khai
-- (sha256('ihome-openclaw-media-revocation-ack-v1' || jcs{version,revocationId,
-- minimumValidGeneration})), không khoá bí mật, không chữ ký số. Nó là BIÊN NHẬN
-- rằng gateway đã thật sự thu hồi vé, chứ không phải bằng chứng. Vé media sống
-- 60 giây (TICKET_TTL_SECONDS ở openclaw-object-tickets), nên cửa sổ rủi ro khi
-- chưa có gateway là ≤60 giây, và hiện tại là 0 vì chưa có media nào tồn tại.
insert into app_private.server_feature_flags (
  feature_key, domain, risk_class, mode, force_freeze, config_version,
  maintenance_window_id, approval_reference, reason
)
values (
  'openclaw.media_revocation_gateway.v1', 'OPENCLAW', 'NON_MONEY', 'OFF', false, 1,
  'MW-OPENCLAW-DISCONNECT-20260807', 'OWNER-REQUESTED-20260807',
  'Chua dung media revocation gateway. Khi OFF, finalize disconnect khong doi bien nhan thu hoi. Bat ON ngay sau khi gateway co that.'
)
on conflict (feature_key) do nothing;

-- 2) Đọc cờ. Mặc định AN TOÀN: thiếu hàng cờ thì coi như gateway CÓ, tức giữ nguyên
--    hành vi nghiêm ngặt cũ. Nới lỏng chỉ xảy ra khi ai đó khai báo tường minh.
create or replace function app_private.openclaw_media_revocation_gateway_enabled_v1()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select flag.mode <> 'OFF'
     from app_private.server_feature_flags flag
     where flag.feature_key = 'openclaw.media_revocation_gateway.v1'),
    true
  );
$function$;

-- 3) Chốt ngắt kết nối. Nguyên khối, chỉ đổi đúng vị từ biên nhận.
create or replace function app_private.openclaw_try_finalize_disconnect_v1(
  p_organization_id uuid,
  p_account_id uuid,
  p_runtime_command_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_state text;
  v_gateway boolean := app_private.openclaw_media_revocation_gateway_enabled_v1();
begin
  update public.openclaw_accounts account set
    connection_state='DISCONNECTED',effective_mode='DRAFT_ONLY',updated_at=statement_timestamp()
  from public.openclaw_runtime_commands command
  join public.openclaw_generation_revocations revocation
    on revocation.organization_id=command.organization_id
   and revocation.command_id=command.id
   and revocation.account_id=command.account_id
   and revocation.cell_id=command.cell_id
   and revocation.principal_kind='CHANNEL'
   and revocation.revocation_kind='SESSION'
  where account.organization_id=p_organization_id and account.id=p_account_id
    and command.organization_id=account.organization_id and command.account_id=account.id
    and command.id=p_runtime_command_id and command.command_kind='DISCONNECT'
    and command.state='ACKNOWLEDGED'
    and command.effect_disposition='PROVIDER_CONFIRMED'
    and command.target_session_generation=account.session_generation
    and command.target_connection_generation=account.connection_generation
    and revocation.minimum_valid_generation=command.target_session_generation
    -- Còn gateway thì vẫn đòi biên nhận đúng như trước.
    and (
      not v_gateway
      or (revocation.acknowledgement_hash is not null and revocation.acknowledged_at is not null)
    )
    and account.connection_state in ('DISCONNECTING','DISCONNECTED')
  returning account.connection_state into v_state;
  if v_state is null then
    select account.connection_state into strict v_state
    from public.openclaw_accounts account
    where account.organization_id=p_organization_id and account.id=p_account_id
    for update;
  end if;
  return v_state;
end;
$function$;

-- 4) Dọn lệnh mồ côi.
--
-- Server chỉ giao lại lệnh cho đúng claim_token_hash đã ghi, và KHÔNG gì xoá hash đó
-- khi lease hết hạn. Bridge sinh claim token ngẫu nhiên mỗi tiến trình, nên một lần
-- restart giữa chừng là lệnh không còn ai với tới được — trong khi
-- `openclaw_disconnect_account_v1` từ chối đè một DISCONNECT đang STARTED
-- ("started disconnect command cannot be superseded"). Đó là bẫy cụt: tài khoản kẹt
-- vĩnh viễn, cron chạy mỗi phút cũng không gỡ vì không hàm nào chạm tới.
--
-- Chỉ dọn việc CHƯA có hiệu lực (effect_disposition='NONE'). Việc đã xác nhận hiệu
-- lực thì tuyệt đối không đụng — mất nó là mất bằng chứng thật.
create or replace function app_private.expire_openclaw_stale_commands_v1(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'stale command sweep limit is invalid' using errcode='22023';
  end if;
  with stale as (
    select command.id
    from public.openclaw_runtime_commands command
    where command.state in ('LEASED','STARTED')
      and command.effect_disposition='NONE'
      and command.lease_expires_at is not null
      and command.lease_expires_at < statement_timestamp()
      and (command.effect_deadline_at is null
           or command.effect_deadline_at < statement_timestamp())
    order by command.lease_expires_at
    limit p_limit
    for update skip locked
  )
  update public.openclaw_runtime_commands command set
    state='FAILED',
    claim_token_hash=null,
    lease_expires_at=null,
    -- Kết cục hiệu lực KHÔNG biết được: bridge đã bỏ lệnh khi quá hạn, và không ai
    -- báo lại. Nói đúng sự thật thay vì giả vờ là đã hoặc chưa chạy.
    effect_disposition='SEALED_UNCONFIRMED',
    sealed_at=coalesce(command.sealed_at, statement_timestamp()),
    -- check8 buộc sealed_at và seal_reason phải đi cùng nhau.
    seal_reason=coalesce(command.seal_reason, 'LEASE_EXPIRED_UNREACHABLE_CLAIMANT'),
    updated_at=statement_timestamp()
  from stale
  where command.id=stale.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- 5) Móc hàm dọn vào vòng bảo trì chạy mỗi phút. Nguyên khối, chỉ thêm một dòng.
CREATE OR REPLACE FUNCTION app_private.run_openclaw_maintenance_jobs_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_lock bigint := pg_catalog.hashtextextended('ihome-openclaw-maintenance-runner-v1',0);
  v_result jsonb;
  v_retention_policies integer;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(v_lock) then
    return jsonb_build_object('version',1,'acquired',false,'databaseTime',statement_timestamp());
  end if;
  v_retention_policies:=app_private.ensure_openclaw_retention_contract_v1();
  v_result := jsonb_build_object(
    'version',1,'acquired',true,
    'retentionPoliciesEnsured',v_retention_policies,
    'qrExpired',app_private.expire_openclaw_qr_challenges_v1(),
    'runtimeLeasesExpired',app_private.expire_openclaw_runtime_leases_v1(),
    'staleCommandsExpired',app_private.expire_openclaw_stale_commands_v1(500),
    'maintenanceLeasesExpired',app_private.expire_openclaw_maintenance_leases_v1(),
    'deliverySweep',app_private.sweep_openclaw_delivery_claims_v1(null,null,null),
    'workRebound',app_private.rebind_openclaw_unclaimed_work_v1(500),
    'salesTasksEmitted',app_private.openclaw_sweep_due_sales_tasks_v1(500),
    'scheduleWork',app_private.materialize_openclaw_schedule_work_v1(500),
    'crmWork',app_private.materialize_openclaw_crm_work_v1(500),
    'retentionQuarantine',app_private.materialize_openclaw_retention_quarantine_v1(500),
    'retentionFinalDelete',app_private.materialize_openclaw_retention_final_delete_v1(500),
    'evidenceRetention',app_private.enforce_openclaw_evidence_retention_v1(500),
    'auditRoots',app_private.materialize_openclaw_audit_root_v1(366),
    'databaseTime',statement_timestamp()
  );
  return v_result;
end;
$function$;

commit;
