-- PR-6 — §D.4: hai RPC giao vận push (claim/lease + settle). KHÔNG pg_net, KHÔNG cron mới.
--
-- ĐẶC TẢ: §D.0 (vì sao bỏ pg_net), §D.4a (claim), §D.4b (settle), §D.5 (lịch chạy).
--
-- KIẾN TRÚC: DB giữ HÀNG ĐỢI + LEASE + IDEMPOTENCY; việc gửi HTTP do edge function
-- `salary-v5-jobs` nhánh `push_drain` làm (chỉ nó mới đọc được phản hồi HTTP đồng bộ):
--
--   trigger ghi notifications (push_state='QUEUED')
--     └─ Vercel Cron (đã có, 0 0 * * *) → /api/salary-v5-cron?job=digest
--          └─ salary-v5-jobs?job=digest  → chạy digest xong thì chạy tiếp push_drain
--               ├─ rpc notify_claim_push_batch_v1()   ← file này
--               ├─ fetch send-push (service_role, contract §D.1a)
--               └─ rpc notify_settle_push_batch_v1()  ← file này
--
-- 🔴 KHÔNG BAO GIỜ đụng cột public.notifications.status. Đó là trục ĐỌC
-- (useUnreadNotificationsCount đếm `.eq('status','PENDING')`); ghi 'SENT' vào đó là huy hiệu
-- chưa-đọc tụt mất ngay khi push tới. Trục GIAO VẬN là push_state — hai trục khác nhau (§D.4b).
--
-- ⚠ push_state='SENT' chỉ có nghĩa DỊCH VỤ PUSH ĐÃ NHẬN, KHÔNG chứng minh máy đã hiện thông báo
-- (§L.3 cấm đánh đồng hai thứ này).
--
-- ⚠ RUNBOOK trước khi bật đường push: đếm `select count(*) from notifications where push_state='QUEUED'`.
-- Khi người ĐẦU TIÊN đăng ký thiết bị, toàn bộ backlog của người đó mở khoá trong MỘT lượt drain.
-- Bước 3 (gán NO_DEVICE) chính là cái van chặn backlog phình: dòng của người chưa có thiết bị bị
-- đóng ngay ở lượt drain đầu, không nằm chờ vô hạn.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- BA CHỖ LỆCH KHỎI CHỮ CỦA ĐẶC TẢ (có lý do, đã đo):
--
-- (1) CÓ THÊM HAI HÀM BỌC TRONG SCHEMA public.
--     §D.4c gọi `admin.rpc('notify_claim_push_batch_v1')` — supabase-js đi qua PostgREST, mà
--     PostgREST chỉ expose `api, public, graphql_public`; đo 29/07: has_schema_privilege(
--     'service_role','app_private','USAGE') = FALSE và nspacl app_private = {postgres=UC,
--     ie_canonical_writer=U}. ⇒ edge function KHÔNG THỂ gọi thẳng hàm app_private, dù có grant
--     execute. Lõi vẫn nằm ở app_private đúng tên §D.4; public chỉ là hai hàm bọc mỏng
--     SECURITY DEFINER, revoke sạch anon/authenticated, grant execute DUY NHẤT cho service_role.
--     Nhờ vậy đoạn code §D.4c giữ nguyên từng chữ.
--
-- (2) push_idem_key GHI THEO DÒNG, khoá lô là 32 ký tự md5 ĐẦU.
--     §D.4a bảo gộp theo NGƯỜI rồi ghi cùng một idem_key cho MỌI dòng trong lô; nhưng §D.3 tạo
--     push_idem_key nay là INDEX THƯỜNG (không UNIQUE) — xem 20260729141000 mục 3c
--     23505 ngay câu UPDATE. Hai mệnh đề của đặc tả chọi nhau. Cách hoà: khoá lô (md5, thứ gửi
--     cho send-push làm idempotencyKey và nhận lại lúc settle) giữ NGUYÊN công thức; còn ghi
--     xuống cột thì thêm hậu tố ':'||id ⇒ duy nhất theo dòng, và settle khớp bằng
--     split_part(push_idem_key,':',1). md5 không chứa ':' nên phép tách là chính xác.
--
-- (3) GIỜ YÊN TÍNH THEO TỪNG ORG, không phải một cờ toàn cục.
--     app_private.notification_org_config (§C) khoá chính là organization_id ⇒ mỗi org một khung
--     giờ yên. `return` toàn cục theo config của một org bất kỳ sẽ bịt miệng org khác. Ở đây:
--     lọc theo org của từng dòng, VÀ vẫn `return` sớm khi MỌI org đều đang giờ yên (đúng tinh
--     thần §D.4a bước 4 — và chỉ sau khi đã làm xong bước 2 + bước 3).
--     Bảng §C có thể CHƯA apply lúc file này chạy ⇒ khối đọc config bọc
--     `exception when undefined_table` và rơi về mặc định 21→7 giờ VN, không làm chết drain.
--
-- ⚠ HỆ QUẢ ĐO ĐƯỢC 29/07, phải biết trước khi hứa với chủ dự án: thông báo của NGƯỜI THUỘC ≥2 ORG
--   (đúng tài khoản chủ) có organization_id = NULL, vì trigger a90_autofill_org gọi
--   app_private.single_org_of_user_v1() và hàm này trả NULL khi user có nhiều org. Dòng NULL-org
--   luôn theo khung MẶC ĐỊNH 21→7, KHÔNG theo khung org chủ tự đặt ở màn Cài đặt. Muốn chữa thì
--   trigger sinh thông báo (§B) phải ghi organization_id tường minh — sửa ở đây là sai chỗ.
--
-- ⏰ MẶC ĐỊNH 21→7 LÀ NỬA HỞ Ở ĐẦU CUỐI: giờ yên ⇔ h >= 21 OR h < 7. Vercel Cron `0 0 * * *`
--    = ĐÚNG 07:00 giờ VN ⇒ h = 7 ⇒ KHÔNG phải giờ yên. Nếu đổi sang `h <= quiet_end` thì lượt
--    drain hằng ngày duy nhất rơi trọn vào giờ yên và KHÔNG BAO GIỜ gửi được gì.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
--
-- IDEMPOTENT: drop function if exists (kèm chữ ký) trước mỗi create; không CREATE TRIGGER, không
-- VIEW (bẫy security_invoker), không extension. Cả file là MỘT transaction (§3.3).

begin;

-- 0) Chặn apply sai thứ tự: file này ĐỌC/GHI năm cột hàng đợi của §D.3.
--    plpgsql chỉ soi cú pháp lúc CREATE nên thiếu cột vẫn "apply thành công" rồi chết lúc chạy.
do $guard$
begin
  if not exists (
    select 1 from pg_attribute a
     where a.attrelid = 'public.notifications'::regclass
       and a.attname in ('push_state','push_attempts','push_leased_at','push_idem_key')
       and not a.attisdropped
     having count(*) = 4
  ) then
    raise exception 'PR-6 cần các cột hàng đợi §D.3 trên public.notifications — apply 20260729141000_notifications_push_queue_columns.sql TRƯỚC';
  end if;
end
$guard$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1) §D.4a — CLAIM + LEASE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
drop function if exists app_private.notify_claim_push_batch_v1(int);

create function app_private.notify_claim_push_batch_v1(p_limit int default 100)
returns table (
  notification_ids uuid[],
  user_id          uuid,
  idem_key         text,
  title            text,
  body             text,
  url              text,
  tag              text
)
language plpgsql
security definer
set search_path to 'pg_catalog','app_private','public'
as $fn$
#variable_conflict use_column
declare
  -- 21→7 giờ VN: mặc định của §C, dùng cho org chưa có dòng config và cho dòng organization_id NULL.
  c_def_quiet_start constant int := 21;
  c_def_quiet_end   constant int := 7;
  v_limit           int  := greatest(1, least(coalesce(p_limit, 100), 500));
  -- 🔴 GIỜ VN, KHÔNG PHẢI UTC. Máy chủ chạy GMT (cron.timezone=GMT); so giờ yên bằng giờ UTC
  -- sẽ lệch đúng 7 tiếng và làm đêm VN thành ban ngày.
  v_hour            int  := extract(hour from (now() at time zone 'Asia/Ho_Chi_Minh'))::int;
  v_quiet_default   boolean;
  v_cfg_orgs        uuid[] := '{}'::uuid[];   -- org CÓ dòng config riêng
  v_cfg_quiet_orgs  uuid[] := '{}'::uuid[];   -- org có config riêng VÀ đang trong giờ yên
begin
  -- ── Bước 1: chống chạy chồng. `return` là BẮT BUỘC — thiếu nó thì advisory lock chỉ là trang
  --    trí, hai lượt drain cùng nhặt một lô. Án lệ: 20260701000001_secdef_code_generators.sql:42.
  --    Khoá xact ⇒ tự nhả khi transaction kết thúc, không cần unlock tay.
  if not pg_try_advisory_xact_lock(hashtext('notify_push_drain_v1')::bigint) then
    raise notice 'notify_push_drain: lượt trước còn đang chạy, bỏ lượt này';
    return;
  end if;

  -- ── Bước 2: dọn dòng treo (SENDING quá 15' không ai settle — edge function timeout/chết giữa chừng).
  --    ⚠ `else n.error_message` là BẮT BUỘC: CASE không ELSE trả NULL và sẽ XOÁ TRẮNG lỗi cũ
  --    (cột error_message đã lộ ra TS ở useNotifications.ts:47).
  --    coalesce(...,'epoch'): SENDING mà push_leased_at NULL là trạng thái hỏng — cũng phải dọn,
  --    không để nó nằm ngoài mọi mệnh đề rồi kẹt vĩnh viễn.
  update public.notifications n
     set push_state = case when n.push_attempts >= 3 then 'FAILED' else 'QUEUED' end,
         error_message = case when n.push_attempts >= 3
                              then 'push: không nhận được phản hồi sau 3 lần'
                              else n.error_message end,
         push_leased_at = null
   where n.push_state = 'SENDING'
     and coalesce(n.push_leased_at, timestamptz 'epoch') < now() - interval '15 minutes';

  -- ── Bước 3: gán NO_DEVICE cho người KHÔNG có thiết bị nào đang hoạt động.
  --    Đây là câu lệnh bản đặc tả trước THIẾU HẲN. Thiếu nó thì với push_subscriptions rỗng,
  --    100% dòng mới kẹt QUEUED vĩnh viễn, push_attempts không tăng, §H SQL (3) mãi ra 0 SENT.
  --    NO_DEVICE ≠ FAILED: không phải lỗi, không tính lượt thử.
  update public.notifications n
     set push_state = 'NO_DEVICE',
         push_leased_at = now()
   where n.push_state = 'QUEUED'
     and not exists (select 1 from public.push_subscriptions ps
                      where ps.user_id = n.user_id and ps.is_active);

  -- ── Bước 4: giờ yên (SAU bước 2 và 3 — dọn treo và đóng NO_DEVICE vẫn phải chạy 24/7).
  v_quiet_default := case
      when c_def_quiet_start = c_def_quiet_end then false
      when c_def_quiet_start <  c_def_quiet_end
        then v_hour >= c_def_quiet_start and v_hour < c_def_quiet_end
      else v_hour >= c_def_quiet_start or  v_hour < c_def_quiet_end
    end;

  begin
    select coalesce(array_agg(c.organization_id), '{}'::uuid[]),
           coalesce(array_agg(c.organization_id) filter (where
             case
               when c.quiet_start = c.quiet_end then false
               when c.quiet_start <  c.quiet_end then v_hour >= c.quiet_start and v_hour < c.quiet_end
               else v_hour >= c.quiet_start or  v_hour < c.quiet_end
             end), '{}'::uuid[])
      into v_cfg_orgs, v_cfg_quiet_orgs
      from app_private.notification_org_config c;
  exception when undefined_table then
    -- §C chưa apply: mọi org theo khung mặc định 21→7. KHÔNG để drain chết vì thứ tự PR.
    v_cfg_orgs := '{}'::uuid[];
    v_cfg_quiet_orgs := '{}'::uuid[];
  end;

  if v_quiet_default
     and (cardinality(v_cfg_orgs) = 0 or v_cfg_quiet_orgs @> v_cfg_orgs) then
    raise notice 'notify_push_drain: đang giờ yên (giờ VN = %), đã dọn treo + NO_DEVICE rồi dừng', v_hour;
    return;
  end if;

  -- ── Bước 5: claim + lease, GỘP THEO NGƯỜI, for update skip locked.
  return query
  with cand as (
    select n.id, n.user_id, n.subject, n.content,
           n.metadata->>'url' as url,
           n.created_at
      from public.notifications n
     where n.push_state = 'QUEUED'
       and n.push_attempts < 3
       -- debounce 10' cho E1 gộp: phiếu được duyệt trong vòng 10' KHÔNG bao giờ push.
       and (coalesce(n.metadata->>'kind','') <> 'ie_pending'
            or n.created_at < now() - interval '10 minutes')
       -- chỉ người CÓ thiết bị active. Bước 3 đã đóng phần còn lại nên mệnh đề này không bao giờ
       -- bỏ sót dòng lại phía sau.
       and exists (select 1 from public.push_subscriptions ps
                    where ps.user_id = n.user_id and ps.is_active)
       -- giờ yên theo org của chính dòng đó (organization_id NULL → khung mặc định)
       and not (case when n.organization_id = any (v_cfg_orgs)
                     then n.organization_id = any (v_cfg_quiet_orgs)
                     else v_quiet_default end)
     order by n.created_at
     for update skip locked
     limit v_limit
  ),
  grp as (
    select c.user_id                                                   as g_user_id,
           array_agg(c.id order by c.created_at, c.id)                  as ids,
           count(*)::int                                                as cnt,
           min(c.created_at)                                            as first_at,
           (array_agg(c.subject order by c.created_at desc, c.id desc))[1] as last_subject,
           (array_agg(c.content order by c.created_at desc, c.id desc))[1] as last_content,
           (array_agg(c.url     order by c.created_at desc, c.id desc))[1] as last_url
      from cand c
     group by c.user_id
  ),
  keyed as (
    -- Khoá lô = md5(user : mốc-sớm-nhất : số-dòng : vân-tay-danh-sách-id).
    --
    -- Hai chỗ khác công thức §D.4a, cả hai đều là lỗi ĐÃ TÁI HIỆN ĐƯỢC trong dry-run:
    --  · epoch-ms thay cho min(created_at)::text — ::text của timestamptz phụ thuộc TimeZone của
    --    session ⇒ hai session khác múi giờ sinh HAI khoá cho CÙNG một lô, mất sạch tác dụng
    --    khử trùng đúng lúc cần nhất (lượt gửi lại).
    --  · md5(danh sách id) — thiếu nó thì hai lô KHÁC NHAU vẫn có thể trùng khoá: created_at mặc
    --    định là now() = mốc TRANSACTION, nên mọi thông báo sinh trong CÙNG một giao dịch có
    --    created_at BẰNG NHAU. Lô bị p_limit cắt làm đôi ⇒ nửa sau có cùng (user, min, cnt) với
    --    nửa trước ⇒ send-push tra push_send_log thấy trùng, trả DUPLICATE, và settle đánh cả
    --    nửa sau là SENT **trong khi chưa hề gửi**. Dry-run 29/07 đã dựng lại đúng ca này.
    -- Lô gửi lại y hệt vẫn ra cùng khoá (ids không đổi) ⇒ tính khử trùng giữ nguyên.
    select g.*,
           md5(g.g_user_id::text || ':' ||
               (extract(epoch from g.first_at) * 1000)::bigint::text || ':' ||
               g.cnt::text || ':' ||
               md5(array_to_string(g.ids, ','))) as k_idem
      from grp g
  ),
  upd as (
    -- CTE ghi dữ liệu LUÔN chạy tới hết dù câu SELECT chính không đọc nó (PG docs).
    update public.notifications n
       set push_state     = 'SENDING',
           push_leased_at = now(),
           push_attempts  = n.push_attempts + 1,
           push_idem_key  = k.k_idem || ':' || n.id::text   -- xem chỗ lệch (2) ở đầu file
      from keyed k
     where n.id = any (k.ids)
    returning n.id
  )
  select k.ids,
         k.g_user_id,
         k.k_idem,
         -- 1 dòng → chính tiêu đề của nó; nhiều dòng → gộp thành "N thông báo mới"
         case when k.cnt = 1 then coalesce(nullif(btrim(k.last_subject), ''), 'CRM')
              else k.cnt::text || ' thông báo mới' end,
         left(coalesce(k.last_content, ''), 180),
         -- URL dự phòng /my-day (App.tsx:372, KHÔNG bọc RequirePermission).
         -- 🚫 KHÔNG dùng /notifications: route đó có gate, chỉ 7/9 role có notifications.view.
         coalesce(nullif(btrim(k.last_url), ''), '/my-day'),
         -- ⚠ Web Push THAY THẾ thông báo cùng tag. cnt=1 phải lấy tag theo notification, nếu để
         -- tag cố định theo người thì cái sau xoá sạch cái trước khỏi màn hình khoá.
         case when k.cnt = 1 then 'crm-' || k.ids[1]::text
              else 'crm-' || k.g_user_id::text end
    from keyed k
   order by k.first_at;
end
$fn$;

revoke all on function app_private.notify_claim_push_batch_v1(int) from public;
revoke all on function app_private.notify_claim_push_batch_v1(int) from anon;
revoke all on function app_private.notify_claim_push_batch_v1(int) from authenticated;
revoke all on function app_private.notify_claim_push_batch_v1(int) from service_role;

comment on function app_private.notify_claim_push_batch_v1(int) is
  'Drain push §D.4a: advisory lock → dọn treo 15p → gán NO_DEVICE → giờ yên (Asia/Ho_Chi_Minh) → '
  'claim+lease gộp theo NGƯỜI (for update skip locked). Gọi qua public.notify_claim_push_batch_v1.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 2) §D.4b — SETTLE theo OUTCOME (tuyệt đối KHÔNG theo HTTP status).
-- ══════════════════════════════════════════════════════════════════════════════════════════════
drop function if exists app_private.notify_settle_push_batch_v1(jsonb);

create function app_private.notify_settle_push_batch_v1(p_results jsonb)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog','app_private','public'
as $fn$
#variable_conflict use_column
declare
  v_rows int := 0;
begin
  if p_results is null
     or jsonb_typeof(p_results) <> 'array'
     or jsonb_array_length(p_results) = 0 then
    return 0;
  end if;

  with r as (
    select nullif(btrim(x->>'idem_key'), '') as idem_key,
           upper(coalesce(nullif(btrim(x->>'outcome'), ''), 'PROVIDER_ERROR')) as outcome,
           -- KHÔNG ::boolean: payload rác sẽ ném 22P02 và giết cả lượt settle ⇒ lô treo tới khi
           -- lease hết hạn rồi gửi TRÙNG. So chuỗi thì không bao giờ ném.
           (lower(coalesce(x->>'retryable', 'true')) not in ('false','f','0','no')) as retryable,
           nullif(btrim(coalesce(x->>'error', '')), '') as error
      from jsonb_array_elements(p_results) x
     where jsonb_typeof(x) = 'object'
  ),
  d as (select * from r where r.idem_key is not null),
  upd as (
    update public.notifications n
       set push_state = case
             when d.outcome in ('SENT','PARTIAL','DUPLICATE') then 'SENT'
             when d.outcome = 'NO_DEVICE'                     then 'NO_DEVICE'
             when not d.retryable                             then 'FAILED'
             when n.push_attempts >= 3                        then 'FAILED'
             else 'QUEUED'
           end,
           -- sent_at giữ ĐÚNG một nghĩa: "đã đẩy push thành công lúc nào" (§0.4 B).
           sent_at = case when d.outcome in ('SENT','PARTIAL','DUPLICATE') then now()
                          else n.sent_at end,
           error_message = case when d.outcome in ('SENT','PARTIAL','DUPLICATE') then null
                                else left(concat_ws(' ', 'push', d.outcome, d.error), 300) end,
           push_leased_at = null
           -- 🔴 KHÔNG có `status = ...` ở đây và sẽ KHÔNG BAO GIỜ có. Xem đầu file.
      from d
     where n.push_state = 'SENDING'
       and n.push_idem_key is not null
       and split_part(n.push_idem_key, ':', 1) = d.idem_key
    returning 1 as one
  )
  select count(*)::int into v_rows from upd;

  return v_rows;
end
$fn$;

revoke all on function app_private.notify_settle_push_batch_v1(jsonb) from public;
revoke all on function app_private.notify_settle_push_batch_v1(jsonb) from anon;
revoke all on function app_private.notify_settle_push_batch_v1(jsonb) from authenticated;
revoke all on function app_private.notify_settle_push_batch_v1(jsonb) from service_role;

comment on function app_private.notify_settle_push_batch_v1(jsonb) is
  'Drain push §D.4b: đóng lô theo outcome của send-push (KHÔNG theo HTTP status). '
  'Trả về số dòng notifications đã đóng. Không bao giờ ghi cột status (trục ĐỌC).';

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 3) Hai hàm bọc trong public — cửa duy nhất cho service_role (xem chỗ lệch (1) ở đầu file).
--    SECURITY DEFINER owner=postgres nên vào được app_private; anon/authenticated bị revoke sạch
--    ⇒ scripts/check-definer-acl.mjs không thấy hàm mới nào anon-executable.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
drop function if exists public.notify_claim_push_batch_v1(int);

create function public.notify_claim_push_batch_v1(p_limit int default 100)
returns table (
  notification_ids uuid[],
  user_id          uuid,
  idem_key         text,
  title            text,
  body             text,
  url              text,
  tag              text
)
language plpgsql
security definer
set search_path to 'pg_catalog','app_private','public'
as $fn$
#variable_conflict use_column
begin
  return query select * from app_private.notify_claim_push_batch_v1(p_limit);
end
$fn$;

revoke all on function public.notify_claim_push_batch_v1(int) from public;
revoke all on function public.notify_claim_push_batch_v1(int) from anon;
revoke all on function public.notify_claim_push_batch_v1(int) from authenticated;
grant execute on function public.notify_claim_push_batch_v1(int) to service_role;

comment on function public.notify_claim_push_batch_v1(int) is
  'Cửa PostgREST cho drain push (§D.4c). CHỈ service_role. Lõi ở app_private.notify_claim_push_batch_v1.';

drop function if exists public.notify_settle_push_batch_v1(jsonb);

create function public.notify_settle_push_batch_v1(p_results jsonb)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog','app_private','public'
as $fn$
begin
  return app_private.notify_settle_push_batch_v1(p_results);
end
$fn$;

revoke all on function public.notify_settle_push_batch_v1(jsonb) from public;
revoke all on function public.notify_settle_push_batch_v1(jsonb) from anon;
revoke all on function public.notify_settle_push_batch_v1(jsonb) from authenticated;
grant execute on function public.notify_settle_push_batch_v1(jsonb) to service_role;

comment on function public.notify_settle_push_batch_v1(jsonb) is
  'Cửa PostgREST cho drain push (§D.4c). CHỈ service_role. Lõi ở app_private.notify_settle_push_batch_v1.';

notify pgrst, 'reload schema';

commit;
