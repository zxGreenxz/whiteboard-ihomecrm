-- PR-5 file 2/2 — NĂM SỰ KIỆN THÔNG BÁO (§B.2 → §B.7).
--
-- PHỤ THUỘC (§G bước 9 & 10 — apply ĐÚNG THỨ TỰ, nếu không trigger sẽ fail-open câm):
--   bước 3 : enum notification_type += 'ACTION_REQUIRED','APPROVAL_RESULT'   (file RIÊNG)
--   bước 4 : notifications.push_state / push_attempts / push_leased_at / push_idem_key (§D.3)
--   bước 7 : app_private.notification_org_config + public.notification_preferences (§C)
--   bước 8 : app_private.ie_approver_ids_v1 + app_private.notif_actor_label_v1   (§B.1)
--   bước 8′: assert_no_engine_request_v1 vào approve_income_expense_v2 / reject_… (§0.4A)
--   file 1 : app_private.notify_no_recipient_v1                                 (§B.2)
--
-- BA NGUYÊN TẮC (§B.0) — đây là bảng TIỀN, income_expenses đã có 36 trigger:
--   1. Tên trigger z95_* để chạy SAU toàn bộ trigger nghiệp vụ (a000…a90, trg_*).
--   2. SECURITY DEFINER + search_path cố định; EXCEPTION WHEN OTHERS bọc ở CẤP TỪNG NGƯỜI NHẬN,
--      KHÔNG bọc cả thân hàm. Mọi handler đều RAISE WARNING để không "chết câm".
--   3. channel BẮT BUỘC 'IN_APP' (useNotifications.ts:78,129 đều .eq('channel','IN_APP') — sai
--      channel là VÔ HÌNH), organization_id truyền TƯỜNG MINH.
--
-- KHÔNG có khoá 'org' trong metadata (org là CỘT), KHÔNG ghi khoá 'event_key' (suy ra được).
-- Mọi chỗ tra preference/org-config đi qua app_private.notify_gate_v1 và dùng đúng ánh xạ
-- `case when event like 'E2%' then 'E2' else event end` (§B.7).

begin;

------------------------------------------------------------------------------
-- 0) NĂM INDEX DEDUPE (§B.7). Tên cố định, đừng đổi — FE và runbook neo vào đây.
--    notifications.status NULLABLE ⇒ mọi predicate dùng `status is distinct from 'READ'`.
------------------------------------------------------------------------------

-- E1: TRẦN CỨNG — tối đa 1 thông báo E1 chưa đọc / người / org tại mọi thời điểm,
-- kể cả ngày cao điểm 76 phiếu (05/07/2026) hay lượt cron đẻ 13 phiếu con định kỳ.
create unique index if not exists uq_notif_ie_pending_open
  on public.notifications (user_id, organization_id)
  where (metadata->>'kind') = 'ie_pending' and status is distinct from 'READ';

-- E2/E2b/E2c: KHÔNG đưa approval_version vào khoá — approve_voucher, unapprove_voucher,
-- cancel_income_expense_v1, restore_income_expense, ie_compat_cancel_v2 đều KHÔNG tăng nó
-- (2438/2592 dòng vẫn = 1).
create unique index if not exists uq_notif_ie_result
  on public.notifications (user_id, (metadata->>'ie_id'), (metadata->>'event'))
  where (metadata->>'event') in ('E2','E2b','E2c');

-- E3: gộp theo GIAO DỊCH. ie_compat_cancel_v2 nhận MẢNG id (useCancelIncomeExpenseBatch,
-- batch.ts:268) — đo thật 8 phiếu/lô. Dedupe theo voucher_id KHÔNG chống được bùng.
create unique index if not exists uq_notif_ie_e3_batch
  on public.notifications (user_id, (metadata->>'batch'))
  where (metadata->>'event') = 'E3';

-- E4: dùng CỘT job_id (đã có sẵn, có FK on delete cascade).
create unique index if not exists uq_notif_job_assigned
  on public.notifications (user_id, job_id)
  where (metadata->>'event') = 'E4';

-- E5: notifications KHÔNG có cột handover_id (bản đặc tả trước chết 42703 ở đây) ⇒ soi metadata.
create unique index if not exists uq_notif_handover_pending
  on public.notifications (user_id, (metadata->>'handover_id'))
  where (metadata->>'event') = 'E5';

------------------------------------------------------------------------------
-- 1) CỔNG SỞ THÍCH — org config + preference cá nhân (§C, §B.7)
--    Trả (g_in_app, g_push). MẶC ĐỊNH MỞ: chưa có bảng/dòng cấu hình ⇒ bật cả hai.
--    Tra bằng HỌ sự kiện: notification_preferences.event_key CHECK chỉ nhận 5 họ, còn
--    metadata.event có 7 nhánh ⇒ E2b/E2c phải quy về 'E2', nếu không tra ra rỗng.
------------------------------------------------------------------------------
create or replace function app_private.notify_gate_v1(
  p_user uuid, p_org uuid, p_event text, p_amount numeric default null)
returns table (g_in_app boolean, g_push boolean)
language plpgsql stable security definer
set search_path to 'pg_catalog','app_private','public'
as $fn$
declare
  v_family  text := case when p_event like 'E2%' then 'E2' else p_event end;  -- §B.7 BẮT BUỘC
  v_cfg     jsonb;
  v_min     numeric;
  v_in      boolean := true;
  v_push    boolean := true;
  v_cadence text := 'IMMEDIATE';
begin
  begin
    select c.events -> v_family into v_cfg
      from app_private.notification_org_config c
     where c.organization_id = p_org;

    if v_cfg is not null then
      if coalesce((v_cfg->>'enabled')::boolean, true) = false then
        g_in_app := false; g_push := false; return next; return;
      end if;
      v_min := nullif(v_cfg->>'min_amount','')::numeric;
    end if;

    select coalesce(np.in_app, true), coalesce(np.push, true), coalesce(np.cadence,'IMMEDIATE')
      into v_in, v_push, v_cadence
      from public.notification_preferences np
     where np.user_id = p_user and np.organization_id = p_org and np.event_key = v_family;
  exception when others then
    -- Chưa apply bước 7, hoặc bảng đổi hình dạng: MỞ (thà ồn còn hơn câm), nhưng để lại vết.
    raise warning 'notify_gate_v1: không đọc được cấu hình (user=% org=% event=%): % %',
      p_user, p_org, p_event, sqlstate, sqlerrm;
    v_in := true; v_push := true; v_cadence := 'IMMEDIATE'; v_min := null;
  end;

  if v_cadence = 'OFF' then
    v_in := false; v_push := false;
  elsif v_cadence = 'DIGEST' then
    v_push := false;    -- §D.3: push_state 'SKIPPED' dành cho DIGEST, gom ở đợt 2 (§D.6)
  end if;

  -- min_amount CHỈ áp cho sự kiện mang MỘT số tiền cụ thể (E2*, E3, E5). E1 là dòng GỘP nên số
  -- tiền của nó là TỔNG — lọc theo tổng là vô nghĩa. Mặc định NULL = không lọc (§C: đo thật, nâng
  -- ngưỡng 300k→3tr chỉ hạ đỉnh 15→14 thông báo/ngày ⇒ ngưỡng tiền gần như vô dụng).
  if v_min is not null and p_amount is not null and p_amount < v_min then
    v_in := false; v_push := false;
  end if;

  g_in_app := v_in; g_push := v_push; return next;
end $fn$;

revoke all on function app_private.notify_gate_v1(uuid,uuid,text,numeric)
  from public, anon, authenticated, service_role;

------------------------------------------------------------------------------
-- 2) E1 — ĐẾM LẠI TỪ NGUỒN rồi cập nhật TẠI CHỖ (§B.2)
--    434/485 lượt duyệt org thật trong 60 ngày xong trong <1 giây ⇒ bắn từng phiếu là thông báo
--    chết yểu. Đây là dòng GỘP, sống-duy-nhất trên mỗi (người nhận, org).
------------------------------------------------------------------------------
create or replace function app_private.notify_ie_pending_refresh_v1(p_org uuid, p_user uuid)
returns void
language plpgsql volatile security definer
set search_path to 'pg_catalog','app_private','public'
as $fn$
declare
  v_n      bigint  := 0;
  v_sum    numeric := 0;
  v_ids    uuid[]  := '{}'::uuid[];
  v_old    bigint;
  v_up     boolean;
  v_in_app boolean := true;
  v_push   boolean := true;
begin
  if p_org is null or p_user is null then
    return;
  end if;

  select g.g_in_app, g.g_push into v_in_app, v_push
    from app_private.notify_gate_v1(p_user, p_org, 'E1', null) g;

  if coalesce(v_in_app, true) then
    with pend as (
      select ie.id, ie.total_amount, ie.building_id, ie.created_at
        from public.income_expenses ie
       where ie.organization_id = p_org
         and ie.deleted_at is null
         and ie.approval_status = 'UNAPPROVED'
         -- chép ĐÚNG predicate của approve_income_expense_v2 (§0.4A): COALESCE(...,'') nghĩa là
         -- review_state NULL bị coi là KHÔNG duyệt được (DEMO đang có 4 dòng sống như vậy và chúng
         -- KHÔNG tự lành vì a001_ie_lifecycle_normalize chỉ chạy BEFORE INSERT).
         and coalesce(ie.review_state,'') in ('PENDING','CHANGES_REQUESTED')
         -- §B.2 điểm 5: LOẠI TRỪ phiếu đang thuộc approval engine. a001 ép review_state='PENDING'
         -- cho MỌI phiếu UNAPPROVED, còn salary_payout_v1/manager_salary_payout_v1 INSERT đúng
         -- hình dạng đó RỒI MỚI nạp engine ⇒ predicate review_state KHÔNG che gì cả.
         and not exists (select 1 from public.approval_requests ar
                          where ar.subject_type = 'FINANCIAL_VOUCHER'
                            and ar.subject_id = ie.id
                            and ar.state = 'PENDING_APPROVAL')),
    bld as (select distinct p.building_id from pend p),
    -- gọi atav3 MỘT LẦN trên mỗi TOÀ có phiếu chờ, không phải mỗi phiếu
    ok as (select b.building_id from bld b
            where (select a.allowed from app_private.authorize_tenant_action_v3(
                     p_user, p_org, 'income_expenses.approve', b.building_id, null) a))
    select count(*), coalesce(sum(p.total_amount),0),
           coalesce(array_agg(p.id order by p.created_at), '{}'::uuid[])
      into v_n, v_sum, v_ids
      from pend p
     where p.building_id in (select building_id from ok);
  end if;

  -- ĐỌC SỐ ĐẾM CŨ trước khi ghi — v_up quyết định có bump created_at/push_state hay không.
  select coalesce((n.metadata->>'count')::bigint, 0) into v_old
    from public.notifications n
   where n.user_id = p_user and n.organization_id = p_org
     and (n.metadata->>'kind') = 'ie_pending' and n.status is distinct from 'READ'
   limit 1;
  v_old := coalesce(v_old, 0);

  -- v_n = 0 ⇒ XOÁ dòng đang mở. Đây chính là chỗ E3 làm người duyệt "khỏi phải chờ" tự động.
  if coalesce(v_n,0) = 0 then
    delete from public.notifications n
     where n.user_id = p_user and n.organization_id = p_org
       and (n.metadata->>'kind') = 'ie_pending' and n.status is distinct from 'READ';
    return;
  end if;

  v_up := v_n > v_old;

  insert into public.notifications
    (user_id, organization_id, type, channel, status, subject, content, metadata, push_state)
  values (p_user, p_org, 'ACTION_REQUIRED', 'IN_APP', 'PENDING',
          'Phiếu chờ bạn duyệt',
          v_n || ' phiếu đang chờ bạn duyệt · tổng '
            || replace(to_char(v_sum,'FM999,999,999,999'), ',', '.') || ' đ',
          jsonb_build_object(
            'kind','ie_pending', 'event','E1', 'count',v_n, 'amount',v_sum,
            'voucher_ids', to_jsonb(v_ids),
            -- BẮT BUỘC có &layer=PENDING: EMPTY_INCOME_EXPENSE_FILTERS mặc định layer:"CASH" và
            -- applyLayerFilters ép .eq("approval_status","APPROVED"); hai .eq cùng cột KHÔNG ghi đè
            -- nhau (postgrest-js dùng searchParams.append) ⇒ AND ⇒ 0 DÒNG.
            'url','/income-expense?approval_status=UNAPPROVED&layer=PENDING',
            'actor_id', auth.uid()),
          case when coalesce(v_push,true) then 'QUEUED' else 'SKIPPED' end)
  on conflict (user_id, organization_id)
    where (metadata->>'kind') = 'ie_pending' and status is distinct from 'READ'
  do update set
    content    = excluded.content,
    metadata   = excluded.metadata,
    -- CHỈ bump khi số TĂNG: bump mọi lần thì E3 liên tục reset đồng hồ và push không bao giờ tới.
    created_at = case when v_up then now() else public.notifications.created_at end,
    push_state = case when v_up then excluded.push_state else public.notifications.push_state end;
end $fn$;

revoke all on function app_private.notify_ie_pending_refresh_v1(uuid,uuid)
  from public, anon, authenticated, service_role;

------------------------------------------------------------------------------
-- 3) TRIGGER FUNCTION E1 + E2/E2b/E2c + E3 (§B.2, §B.3, §B.4)
------------------------------------------------------------------------------
create or replace function app_private.notify_ie_lifecycle_v1()
returns trigger
language plpgsql volatile security definer
set search_path to 'pg_catalog','app_private','public'
as $fn$
declare
  v_actor    uuid := auth.uid();
  v_maker    uuid := coalesce(NEW.maker_user_id, NEW.user_id);   -- maker_user_id chỉ điền 141/2592
  v_org      uuid := NEW.organization_id;
  v_label    text := 'hệ thống';
  v_amount   text;
  v_ins      boolean := (TG_OP = 'INSERT');
  v_enter    boolean := false;   -- vào (hoặc quay lại) hàng chờ duyệt
  v_approved boolean := false;
  v_cancel   boolean := false;
  v_softdel  boolean := false;
  v_e3       boolean := false;
  v_stale    boolean := false;   -- có cần đếm lại cho người ĐANG giữ dòng E1 mở không
  v_event    text;
  v_subject  text;
  v_content  text;
  v_approvers uuid[] := '{}'::uuid[];
  v_resolved boolean := true;
  v_batch    text;
  v_u        uuid;
  v_in_app   boolean;
  v_push     boolean;
  v_nid      uuid;
  v_ids      jsonb;
  v_cnt      int;
begin
  -- (a) org phải giải được — §L.2 cấm fallback im lặng về NULL.
  if v_org is null then
    perform app_private.notify_no_recipient_v1(
      null, 'E1', 'INCOME_EXPENSE', NEW.id, NEW.building_id, v_actor, 'ORG_UNRESOLVED');
    return null;
  end if;

  -- (b) phiếu thuộc approval engine: đường thông báo này KHÔNG đụng vào (tập ứng viên của engine
  --     KHÁC resolver — đo DEMO 29/07 07:36Z: engine={90450d5f, fb0651bb}, resolver=RỖNG).
  if exists (select 1 from public.approval_requests ar
              where ar.subject_type = 'FINANCIAL_VOUCHER'
                and ar.subject_id = NEW.id
                and ar.state = 'PENDING_APPROVAL') then
    perform app_private.notify_no_recipient_v1(
      v_org, 'E1', 'INCOME_EXPENSE', NEW.id, NEW.building_id, v_actor, 'ENGINE_OWNED');
    return null;
  end if;

  -- (c) phân loại chuyển trạng thái (TG_OP chỉ dùng được TRONG THÂN HÀM, không dùng ở WHEN — 42703)
  if v_ins then
    v_enter := true;
  else
    v_enter    := NEW.approval_status = 'UNAPPROVED'
                  and NEW.approval_status is distinct from OLD.approval_status;
    v_approved := NEW.approval_status = 'APPROVED'  and OLD.approval_status = 'UNAPPROVED';
    v_cancel   := NEW.approval_status = 'CANCELLED' and OLD.approval_status = 'UNAPPROVED';
    v_softdel  := NEW.deleted_at is not null and OLD.deleted_at is null
                  and NEW.approval_status = 'UNAPPROVED';
  end if;
  v_e3    := v_cancel or v_softdel;
  v_stale := (not v_ins) and (v_approved or v_e3);   -- các nhánh làm hàng chờ NGẮN ĐI

  -- nhãn người thao tác chỉ để HIỂN THỊ ⇒ hỏng thì lùi về 'hệ thống', không được làm hỏng phiếu tiền
  begin
    v_label := coalesce(app_private.notif_actor_label_v1(v_actor), 'hệ thống');
  exception when others then
    raise warning 'notify: notif_actor_label_v1 lỗi (ie=%): % %', NEW.id, sqlstate, sqlerrm;
    v_label := 'hệ thống';
  end;
  v_amount := replace(to_char(coalesce(NEW.total_amount,0),'FM999,999,999,999'), ',', '.');

  ----------------------------------------------------------------------------
  -- (d) E2 / E2b / E2c — báo NGƯỜI LẬP PHIẾU. Bỏ nếu v_maker = v_actor.
  --     CHỐT CHẶN THÔNG BÁO KÉP: trg_forfeit_settle_on_approve lan trạng thái sang phiếu đối ứng
  --     của cặp thanh lý bỏ cọc ⇒ 1 thao tác = 2 lần trigger. Chỉ bỏ CHÂN ĐỐI ỨNG
  --     (offset_voucher_id), TUYỆT ĐỐI KHÔNG lọc bằng system_source vì nó chặn CẢ HAI chân.
  ----------------------------------------------------------------------------
  if (v_approved or v_cancel)
     and v_maker is not null
     and v_maker is distinct from v_actor
     and not exists (select 1 from app_private.termination_forfeit_authorizations t
                      where t.offset_voucher_id = NEW.id) then

    if v_approved then
      v_event   := 'E2';
      v_subject := 'Phiếu đã được duyệt';
      v_content := 'Phiếu ' || coalesce(NEW.code,'—') || ' · ' || v_amount
                   || ' đ đã được ' || v_label || ' duyệt.';
    elsif NEW.cancellation_kind = 'REJECTED_INVALID' then
      -- E2b hôm nay CHƯA CÓ ĐƯỜNG PHÁT SINH (reject_invalid_income_expense_v2 tồn tại nhưng 0 file
      -- FE gọi, cancellation_kind='REJECTED_INVALID' có 0 dòng thật). Cài vì rẻ + đúng ngữ nghĩa.
      v_event   := 'E2b';
      v_subject := 'Phiếu bị từ chối';
      v_content := 'Phiếu ' || coalesce(NEW.code,'—') || ' bị ' || v_label || ' từ chối. Lý do: '
                   || coalesce(nullif(NEW.review_reason,''), '(không ghi)');
    elsif v_actor is not null then
      -- v_actor IS NOT NULL BẮT BUỘC: NULL IS DISTINCT FROM v_maker = TRUE ⇒ thiếu nó thì mọi
      -- đường hệ thống/cron bắn "phiếu của bạn bị người khác huỷ".
      -- KHÔNG gọi đây là "từ chối": ie_compat_cancel_v2 chỉ đòi membership ACTIVE.
      v_event   := 'E2c';
      v_subject := 'Phiếu bị huỷ khi đang chờ duyệt';
      v_content := 'Phiếu ' || coalesce(NEW.code,'—') || ' · ' || v_amount
                   || ' đ đã bị ' || v_label || ' huỷ.';
    else
      v_event := null;
    end if;

    if v_event is not null then
      begin
        select g.g_in_app, g.g_push into v_in_app, v_push
          from app_private.notify_gate_v1(v_maker, v_org, v_event, NEW.total_amount) g;

        if coalesce(v_in_app, true) then
          insert into public.notifications
            (user_id, organization_id, type, channel, status, subject, content, metadata, push_state)
          values (v_maker, v_org, 'APPROVAL_RESULT', 'IN_APP', 'PENDING', v_subject, v_content,
                  jsonb_build_object(
                    'event', v_event, 'ie_id', NEW.id::text,
                    'code', NEW.code,            -- CHỈ để hiển thị: DEMO có 2 phiếu cùng PC2607039
                    'amount', NEW.total_amount,
                    -- KHÔNG set notifications.contract_id: 7/9 phiếu chờ là hoa hồng có contract_id,
                    -- UI sẽ điều hướng sang trang hợp đồng — SAI ĐÍCH.
                    'url', '/income-expense/voucher/' || NEW.id::text,
                    'actor_id', v_actor),
                  case when coalesce(v_push,true) then 'QUEUED' else 'SKIPPED' end)
          on conflict (user_id, (metadata->>'ie_id'), (metadata->>'event'))
            where (metadata->>'event') in ('E2','E2b','E2c')
          do nothing;
        end if;
      exception when others then
        raise warning 'notify %: bỏ qua người nhận % (ie=%): % %',
          v_event, v_maker, NEW.id, sqlstate, sqlerrm;
      end;
    end if;
  end if;

  ----------------------------------------------------------------------------
  -- (e) NGƯỜI DUYỆT — resolver. atav3 KHÔNG tham chiếu auth.uid() ở bất kỳ đâu nên dùng được
  --     trong trigger/cron. Bọc riêng: resolver hỏng thì mất thông báo, KHÔNG được mất phiếu tiền.
  ----------------------------------------------------------------------------
  begin
    v_approvers := app_private.ie_approver_ids_v1(
                     v_org, NEW.building_id, array_remove(array[v_actor, v_maker], null));
  exception when others then
    v_resolved  := false;
    v_approvers := '{}'::uuid[];
    raise warning 'notify: ie_approver_ids_v1 lỗi (ie=%): % %', NEW.id, sqlstate, sqlerrm;
  end;

  -- Tập rỗng là ca THẬT (3/17 phiếu chờ) ⇒ KHÔNG im lặng, ghi sổ + RAISE WARNING.
  if v_enter and v_resolved and coalesce(array_length(v_approvers,1),0) = 0 then
    perform app_private.notify_no_recipient_v1(
      v_org, 'E1', 'INCOME_EXPENSE', NEW.id, NEW.building_id, v_actor, 'NO_APPROVER_IN_SCOPE');
  end if;

  v_batch := pg_current_xact_id()::text;   -- gộp E3 theo GIAO DỊCH

  for v_u in
    select distinct x.uid
      from (
        select unnest(v_approvers) as uid
        union
        -- Người ĐANG giữ một dòng E1 mở trong org này cũng phải được đếm lại khi hàng chờ NGẮN ĐI
        -- (kể cả người vừa thao tác — nếu không thì số đếm của họ đứng hình ở giá trị cũ).
        -- Chỉ mở nhánh này ở các nhánh GIẢM (duyệt/huỷ/xoá mềm) nên không bao giờ tự bắn cho mình.
        select n.user_id
          from public.notifications n
         where v_stale
           and n.organization_id = v_org
           and (n.metadata->>'kind') = 'ie_pending'
           and n.status is distinct from 'READ'
      ) x
     where x.uid is not null
  loop
    -- FAIL-OPEN Ở CẤP TỪNG NGƯỜI NHẬN (§B.0 nguyên tắc 2) — KHÔNG bọc cả thân hàm.
    begin
      perform app_private.notify_ie_pending_refresh_v1(v_org, v_u);

      if v_e3 and v_u = any(v_approvers) then
        select g.g_in_app, g.g_push into v_in_app, v_push
          from app_private.notify_gate_v1(v_u, v_org, 'E3', NEW.total_amount) g;

        if coalesce(v_in_app, true) then
          select n.id, n.metadata->'voucher_ids' into v_nid, v_ids
            from public.notifications n
           where n.user_id = v_u
             and (n.metadata->>'event') = 'E3'
             and (n.metadata->>'batch') = v_batch
           limit 1;

          if v_nid is null then
            insert into public.notifications
              (user_id, organization_id, type, channel, status, subject, content, metadata, push_state)
            values (v_u, v_org, 'APPROVAL_RESULT', 'IN_APP', 'PENDING',
                    'Không cần duyệt nữa',
                    'Phiếu ' || coalesce(NEW.code,'—') || ' · ' || v_amount
                      || ' đ đã được ' || v_label || ' huỷ, bạn không cần duyệt.',
                    jsonb_build_object(
                      'event','E3', 'batch', v_batch,
                      'code', NEW.code, 'amount', NEW.total_amount,
                      'voucher_ids', jsonb_build_array(NEW.id::text),
                      'url','/income-expense/voucher/' || NEW.id::text,
                      'actor_id', v_actor),
                    case when coalesce(v_push,true) then 'QUEUED' else 'SKIPPED' end)
            on conflict (user_id, (metadata->>'batch'))
              where (metadata->>'event') = 'E3'
            do nothing;
          elsif not (coalesce(v_ids,'[]'::jsonb) @> to_jsonb(NEW.id::text)) then
            -- cùng batch = cùng transaction ⇒ không có đua; index vẫn giữ làm chốt chặn
            v_ids := coalesce(v_ids,'[]'::jsonb) || to_jsonb(NEW.id::text);
            v_cnt := jsonb_array_length(v_ids);
            update public.notifications n
               set metadata = n.metadata || jsonb_build_object(
                                'voucher_ids', v_ids,
                                'url', '/income-expense'),   -- ≥2 phiếu thì về danh sách
                   content  = v_cnt::text || ' phiếu chờ duyệt vừa bị ' || v_label || ' huỷ.',
                   push_state = case when coalesce(v_push,true) then 'QUEUED' else n.push_state end
             where n.id = v_nid;
          end if;
        end if;
      end if;
    exception when others then
      raise warning 'notify E1/E3: bỏ qua người nhận % (ie=%): % %', v_u, NEW.id, sqlstate, sqlerrm;
    end;
  end loop;

  return null;
end $fn$;

revoke all on function app_private.notify_ie_lifecycle_v1()
  from public, anon, authenticated, service_role;

------------------------------------------------------------------------------
-- 4) TRIGGER FUNCTION E4 — việc được giao (§B.5)
------------------------------------------------------------------------------
create or replace function app_private.notify_job_assigned_v1()
returns trigger
language plpgsql volatile security definer
set search_path to 'pg_catalog','app_private','public'
as $fn$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid := NEW.organization_id;
  v_label  text := 'hệ thống';
  v_in_app boolean;
  v_push   boolean;
begin
  if v_org is null then
    perform app_private.notify_no_recipient_v1(
      null, 'E4', 'JOB', NEW.id, NEW.building_id, v_actor, 'ORG_UNRESOLVED');
    return null;
  end if;

  begin
    v_label := coalesce(app_private.notif_actor_label_v1(v_actor), 'hệ thống');
  exception when others then
    raise warning 'notify: notif_actor_label_v1 lỗi (job=%): % %', NEW.id, sqlstate, sqlerrm;
    v_label := 'hệ thống';
  end;

  begin
    select g.g_in_app, g.g_push into v_in_app, v_push
      from app_private.notify_gate_v1(NEW.assignee_id, v_org, 'E4', null) g;

    if coalesce(v_in_app, true) then
      insert into public.notifications
        (user_id, organization_id, type, channel, status, subject, content, job_id, metadata, push_state)
      values (NEW.assignee_id, v_org, 'ACTION_REQUIRED', 'IN_APP', 'PENDING',
              'Việc mới được giao cho bạn',
              coalesce(nullif(NEW.title,''),'(không tiêu đề)') || ' (' || coalesce(NEW.code,'—')
                || ') — do ' || v_label || ' giao.',
              NEW.id,
              jsonb_build_object('event','E4',
                                 'url','/tasks?job=' || NEW.id::text,
                                 'actor_id', v_actor),
              case when coalesce(v_push,true) then 'QUEUED' else 'SKIPPED' end)
      on conflict (user_id, job_id) where (metadata->>'event') = 'E4'
      do nothing;
    end if;
  exception when others then
    raise warning 'notify E4: bỏ qua người nhận % (job=%): % %',
      NEW.assignee_id, NEW.id, sqlstate, sqlerrm;
  end;

  return null;
end $fn$;

revoke all on function app_private.notify_job_assigned_v1()
  from public, anon, authenticated, service_role;

------------------------------------------------------------------------------
-- 5) TRIGGER FUNCTION E5 — bàn giao tiền mặt chờ xác nhận (§B.6)
------------------------------------------------------------------------------
create or replace function app_private.notify_handover_v1()
returns trigger
language plpgsql volatile security definer
set search_path to 'pg_catalog','app_private','public'
as $fn$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_giver  text := 'hệ thống';
  v_amount text;
  v_in_app boolean;
  v_push   boolean;
begin
  -- SUY ORG, ĐỪNG TIN CỘT: cash_handovers.organization_id nullable, bảng KHÔNG có trg_autofill_org,
  -- create_cash_handover KHÔNG hề gán — dòng mới nhất BG2607004 (22/07) đang NULL thật.
  -- accounts có 70 dòng, organization_id NULL = 0, from_account_id NOT NULL 7/7.
  v_org := coalesce(NEW.organization_id,
                    (select a.organization_id from public.accounts a where a.id = NEW.from_account_id));

  if v_org is null then
    perform app_private.notify_no_recipient_v1(
      null, 'E5', 'CASH_HANDOVER', NEW.id, null, v_actor, 'ORG_UNRESOLVED');
    return null;
  end if;

  -- create_cash_handover đã RAISE nếu p_receiver_id = auth.uid(); chốt thêm ở đây cho đường khác.
  if NEW.receiver_id is null or NEW.receiver_id = v_actor then
    return null;
  end if;

  begin
    v_giver := coalesce(nullif(NEW.giver_name,''),
                        app_private.notif_actor_label_v1(NEW.giver_id), 'hệ thống');
  exception when others then
    raise warning 'notify: notif_actor_label_v1 lỗi (handover=%): % %', NEW.id, sqlstate, sqlerrm;
    v_giver := coalesce(nullif(NEW.giver_name,''), 'hệ thống');
  end;
  v_amount := replace(to_char(coalesce(NEW.total_amount,0),'FM999,999,999,999'), ',', '.');

  begin
    select g.g_in_app, g.g_push into v_in_app, v_push
      from app_private.notify_gate_v1(NEW.receiver_id, v_org, 'E5', NEW.total_amount) g;

    if coalesce(v_in_app, true) then
      insert into public.notifications
        (user_id, organization_id, type, channel, status, subject, content, metadata, push_state)
      values (NEW.receiver_id, v_org, 'ACTION_REQUIRED', 'IN_APP', 'PENDING',
              'Bàn giao tiền mặt chờ bạn xác nhận',
              coalesce(NEW.code,'—') || ' · ' || v_amount || ' đ từ ' || v_giver || ' — '
                || coalesce(NEW.voucher_count,0)::text || ' phiếu.',
              jsonb_build_object('event','E5',
                                 'handover_id', NEW.id::text,   -- notifications KHÔNG có cột này
                                 'url','/thu-tien?handover=' || NEW.id::text,
                                 'actor_id', v_actor),
              case when coalesce(v_push,true) then 'QUEUED' else 'SKIPPED' end)
      on conflict (user_id, (metadata->>'handover_id')) where (metadata->>'event') = 'E5'
      do nothing;
    end if;
  exception when others then
    raise warning 'notify E5: bỏ qua người nhận % (handover=%): % %',
      NEW.receiver_id, NEW.id, sqlstate, sqlerrm;
  end;

  return null;
end $fn$;

revoke all on function app_private.notify_handover_v1()
  from public, anon, authenticated, service_role;

------------------------------------------------------------------------------
-- 6) TRIGGER — tên z95_* để chạy SAU 36 trigger nghiệp vụ của income_expenses.
--    Postgres KHÔNG có CREATE TRIGGER IF NOT EXISTS ⇒ MỖI create phải có drop … if exists đứng
--    trước, nếu không chạy lại lần hai là 42710.
------------------------------------------------------------------------------

drop trigger if exists z95_notify_ie_ins on public.income_expenses;
create trigger z95_notify_ie_ins
after insert on public.income_expenses
for each row when (NEW.deleted_at is null and NEW.approval_status = 'UNAPPROVED')
execute function app_private.notify_ie_lifecycle_v1();

-- NĂM ĐIỂM KHÔNG ĐƯỢC SỬA trong mệnh đề dưới:
--  1. OLD.approval_status='UNAPPROVED' ở nhánh APPROVED là BẮT BUỘC — viết lỏng thì
--     restore_income_expense (CANCELLED→APPROVED, 7 lần/90 ngày) bắn "được duyệt" GIẢ.
--  2. KHÔNG kẹp review_state (lọc ở tầng đếm): unapprove_voucher để lại UNAPPROVED + RESOLVED và
--     ta vẫn cần cơ hội cập nhật lại số đếm.
--  3. KHÔNG kẹp posting_status (UNPOSTED/NOT_APPLICABLE tuỳ posting_mode).
--  4. Nhánh deleted_at là CHỐT CHẶN THÔNG BÁO MỒ CÔI: phiếu chờ duyệt biến mất bằng soft-delete
--     (cancel_utility_bill, cancel_period_fee, confirm_cancel_handover,
--     finance_v2_apply_voucher_delete_v1) mà approval_status KHÔNG đổi — đã xảy ra thật
--     (PC2607012, PC2607039 ở DEMO).
--  5. Nhánh (a) KHÔNG kẹp OLD nên bắt cả CANCELLED → UNAPPROVED — CHỦ Ý: phiếu quay lại hàng chờ
--     thì phải hiện.
drop trigger if exists z95_notify_ie_upd on public.income_expenses;
create trigger z95_notify_ie_upd
after update of approval_status, deleted_at on public.income_expenses
for each row when (
     (NEW.approval_status is distinct from OLD.approval_status
      and (NEW.approval_status = 'UNAPPROVED'
        or (NEW.approval_status = 'APPROVED'  and OLD.approval_status = 'UNAPPROVED')
        or (NEW.approval_status = 'CANCELLED' and OLD.approval_status = 'UNAPPROVED')))
  or (NEW.deleted_at is not null and OLD.deleted_at is null
      and NEW.approval_status = 'UNAPPROVED'))
execute function app_private.notify_ie_lifecycle_v1();

-- E4 phải TÁCH ĐÔI ins/upd: WHEN cấp SQL KHÔNG dùng được subquery (0A000) và KHÔNG dùng được
-- TG_OP (42703). So với auth.uid(), KHÔNG so với jobs.user_id: mệnh đề assignee_id <> user_id cho
-- ĐÚNG 0 kết quả (org thật 183/187 việc là tự giao); set_user_id_from_auth chỉ điền user_id KHI
-- NULL nên hai mốc so sánh KHÔNG tương đương. auth.uid() IS NOT NULL chặn đường job nền.
drop trigger if exists z95_notify_job_assigned_ins on public.jobs;
create trigger z95_notify_job_assigned_ins
after insert on public.jobs
for each row when (NEW.assignee_id is not null and auth.uid() is not null
                   and NEW.assignee_id is distinct from auth.uid())
execute function app_private.notify_job_assigned_v1();

drop trigger if exists z95_notify_job_assigned_upd on public.jobs;
create trigger z95_notify_job_assigned_upd
after update of assignee_id on public.jobs
for each row when (NEW.assignee_id is not null and auth.uid() is not null
                   and OLD.assignee_id is distinct from NEW.assignee_id
                   and NEW.assignee_id is distinct from auth.uid())
execute function app_private.notify_job_assigned_v1();

drop trigger if exists z95_notify_handover on public.cash_handovers;
create trigger z95_notify_handover
after insert on public.cash_handovers
for each row when (NEW.status = 'PENDING')
execute function app_private.notify_handover_v1();

commit;
