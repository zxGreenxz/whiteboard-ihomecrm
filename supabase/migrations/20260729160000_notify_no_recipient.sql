-- PR-5 file 1/2 — SỔ GHI "KHÔNG CÓ AI NHẬN" cho hệ thống thông báo (§B.2, §B.6).
--
-- VÌ SAO PHẢI CÓ: bộ giải người duyệt `app_private.ie_approver_ids_v1` trả RỖNG là ca THẬT, không
-- phải giả thuyết — đo 29/07/2026: 3/17 phiếu chờ ra rỗng (PC2607153 org thật do chính người giữ
-- quyền duyệt lập; PC2607008 + PC2607010 ở DEMO do demo.chunha lập). Vì mỗi org chỉ có ĐÚNG MỘT
-- người giữ `income_expenses.approve`, mọi phiếu do chính người đó lập KHÔNG có ai nhận E1.
-- Tệ hơn: mọi phiếu thuộc approval engine cũng rơi vào ca rỗng (resolver rỗng trong khi /approvals
-- có 2 ứng viên). Tức "im lặng" nuốt đúng loại phiếu tiền cần báo nhất.
--
-- §L.2 nguyên văn: "Kết quả rỗng phải được coi là lỗi cấu hình hoặc NO_RECIPIENT, không được
-- silently commit một giao dịch tiền mà không có cảnh báo/metric." ⇒ ghi một dòng vào đây + RAISE
-- WARNING. KHÔNG fallback gửi cho người lập (tự gửi cho chính mình).
--
-- BA LÝ DO (khớp §B.2 và §B.6):
--   NO_APPROVER_IN_SCOPE — resolver chạy xong, trả rỗng (lỗi cấu hình phân quyền)
--   ORG_UNRESOLVED       — không suy được organization_id (cash_handovers.organization_id nullable,
--                          create_cash_handover KHÔNG gán; jobs.organization_id cũng nullable)
--   ENGINE_OWNED         — phiếu đang thuộc approval engine (approval_requests PENDING_APPROVAL),
--                          tập ứng viên của engine KHÁC resolver nên đường này phải im nhưng CÓ VẾT
--
-- NGƯỠNG GIÁM SÁT: có dòng mới trong 24h = lỗi cấu hình phân quyền, phải xem.
--   select reason, count(*) from app_private.notification_no_recipient_log
--    where created_at > now() - interval '24 hours' group by 1;
--
-- Bảng nằm ở app_private (nspacl = {postgres=UC, ie_canonical_writer=U}) ⇒ PostgREST không expose,
-- anon/authenticated không có USAGE. Vẫn bật RLS + REVOKE làm phòng vệ chiều sâu.

begin;

create table if not exists app_private.notification_no_recipient_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid,
  event_key       text not null,
  subject_kind    text not null,
  subject_id      uuid,
  building_id     uuid,
  actor_id        uuid,
  reason          text not null,
  created_at      timestamptz not null default now()
);

-- idempotent: drop trước khi add (ALTER TABLE ADD CONSTRAINT không có IF NOT EXISTS)
alter table app_private.notification_no_recipient_log
  drop constraint if exists notification_no_recipient_log_reason_chk;
alter table app_private.notification_no_recipient_log
  add constraint notification_no_recipient_log_reason_chk
  check (reason in ('NO_APPROVER_IN_SCOPE','ORG_UNRESOLVED','ENGINE_OWNED'));

-- event_key là HỌ sự kiện (5 họ), KHÔNG phải nhánh: E2b/E2c đều ghi 'E2' (§B.7 quy tắc ánh xạ).
alter table app_private.notification_no_recipient_log
  drop constraint if exists notification_no_recipient_log_event_key_chk;
alter table app_private.notification_no_recipient_log
  add constraint notification_no_recipient_log_event_key_chk
  check (event_key in ('E1','E2','E3','E4','E5'));

create index if not exists idx_notif_no_recipient_recent
  on app_private.notification_no_recipient_log (created_at desc);
create index if not exists idx_notif_no_recipient_org_reason
  on app_private.notification_no_recipient_log (organization_id, reason, created_at desc);

alter table app_private.notification_no_recipient_log enable row level security;
-- KHÔNG policy nào: schema app_private không cấp cho anon/authenticated.
revoke all on table app_private.notification_no_recipient_log
  from public, anon, authenticated, service_role;

-- Hàm ghi. TOÀN BỘ thân bọc trong BEGIN…EXCEPTION WHEN OTHERS THEN NULL vì đây là đường LOG chạy
-- bên trong giao dịch TIỀN: sổ ghi hỏng thì mất một dòng log, TUYỆT ĐỐI không được làm hỏng phiếu.
-- (Đây là ngoại lệ có chủ ý với §B.0 nguyên tắc 2 — nguyên tắc đó nói về hàm SINH thông báo, còn
--  hàm này chỉ ghi vết; RAISE WARNING bên dưới vẫn để lại dấu trong log Postgres.)
create or replace function app_private.notify_no_recipient_v1(
  p_org          uuid,
  p_event_key    text,
  p_subject_kind text,
  p_subject_id   uuid,
  p_building     uuid,
  p_actor        uuid,
  p_reason       text)
returns void
language plpgsql volatile security definer
set search_path to 'pg_catalog','app_private','public'
as $fn$
begin
  begin
    insert into app_private.notification_no_recipient_log
      (organization_id, event_key, subject_kind, subject_id, building_id, actor_id, reason)
    values (p_org,
            case when p_event_key like 'E2%' then 'E2' else p_event_key end,
            p_subject_kind, p_subject_id, p_building, p_actor, p_reason);

    raise warning '% NO_RECIPIENT subject=%:% org=% building=% actor=% reason=%',
      p_event_key, p_subject_kind, p_subject_id, p_org, p_building, p_actor, p_reason;
  exception when others then
    null;
  end;
end $fn$;

revoke all on function app_private.notify_no_recipient_v1(uuid,text,text,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;

commit;
