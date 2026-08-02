-- PR-4c — §D.1a: sổ khử trùng cho edge function `send-push`.
--
-- VÌ SAO CẦN: drain push có thể chạy hai lần mà không ai làm gì sai — Vercel retry lượt cron,
-- người bấm "Chạy lại" ở OwnerDashboardV5, hoặc lease 15' hết hạn đúng lúc edge function timeout
-- giữa chừng (đã gửi xong nhưng chưa settle). Không có khoá khử trùng thì một sự cố mạng =
-- người dùng nhận thông báo trùng. Bảng này là khoá đó: `send-push` INSERT … ON CONFLICT DO NOTHING
-- TRƯỚC khi gửi; đụng conflict ⇒ trả outcome='DUPLICATE' và KHÔNG gửi.
--
-- AI DÙNG: chỉ edge function `send-push` qua service_role (rolbypassrls=true). Không màn hình FE
-- nào đọc bảng này ⇒ RLS bật nhưng CỐ Ý KHÔNG có policy nào, và anon/authenticated bị revoke sạch.
-- (Đo 29/07/2026: pg_default_acl của public cấp mặc định arwdDxtm cho anon + authenticated trên
--  MỌI bảng mới — nên câu REVOKE bên dưới là bắt buộc, không phải trang trí.)
--
-- KHÔNG tạo VIEW, KHÔNG pg_net, KHÔNG cron job mới (§D.0/§D.5). Dọn 7 ngày ghép vào job retention
-- sẵn có: `delete from public.push_send_log where created_at < now() - interval '7 days';`
-- (service_role có đủ quyền DELETE nhờ grant bên dưới; index theo created_at phục vụ đúng câu này.)

begin;

create table if not exists public.push_send_log (
  idempotency_key text primary key,
  user_id         uuid,
  outcome         text,
  sent            int,
  created_at      timestamptz not null default now()
);

-- Chạy lại lần hai / bảng đã tồn tại từ lượt apply dở: bổ sung cột còn thiếu thay vì lỗi.
alter table public.push_send_log
  add column if not exists user_id    uuid,
  add column if not exists outcome    text,
  add column if not exists sent       int,
  add column if not exists created_at timestamptz not null default now();

-- Chốt trần 128 ký tự của contract §D.1a ngay ở tầng DB: edge function đã chặn, nhưng nếu sau này
-- có đường ghi khác thì khoá vẫn không phình ra thành nơi nhét dữ liệu.
alter table public.push_send_log drop constraint if exists push_send_log_key_len_chk;
alter table public.push_send_log add constraint push_send_log_key_len_chk
  check (length(idempotency_key) between 1 and 128);

-- Phục vụ câu DELETE dọn 7 ngày (không có index này thì mỗi lượt dọn là seq scan toàn bảng).
create index if not exists idx_push_send_log_created_at
  on public.push_send_log (created_at);

alter table public.push_send_log enable row level security;

-- CỐ Ý KHÔNG CÓ POLICY NÀO.
-- RLS bật + 0 policy = anon/authenticated thấy 0 dòng kể cả khi ai đó lỡ grant lại;
-- service_role có rolbypassrls=true nên edge function vẫn đọc/ghi bình thường.
-- (Nếu mai này cần cho super admin soi, thêm policy SELECT riêng — đừng gỡ RLS.)

revoke all on public.push_send_log from anon;
revoke all on public.push_send_log from authenticated;
grant select, insert, update, delete on public.push_send_log to service_role;

comment on table public.push_send_log is
  'Sổ khử trùng gửi push (§D.1a). Edge function send-push ghi 1 dòng/lượt gửi TRƯỚC khi bắn, '
  'on conflict do nothing; trùng khoá ⇒ outcome=DUPLICATE và không gửi. Dọn 7 ngày.';
comment on column public.push_send_log.idempotency_key is
  'Khoá khử trùng ≤128 ký tự. Drain: md5(user_id||min(created_at)||count) từ notify_claim_push_batch_v1. '
  'Nút "Gửi thử" trên web: usr:<uid>:<uuid> (namespace riêng, không bao giờ đụng khoá của drain).';
comment on column public.push_send_log.outcome is
  'SENDING khi vừa claim; sau khi gửi xong ghi đè bằng outcome cuối (SENT/PARTIAL/NO_DEVICE/'
  'ALL_FAILED/PROVIDER_ERROR). KHÔNG suy trạng thái giao vận từ HTTP status.';
comment on column public.push_send_log.sent is
  'Số thiết bị dịch vụ push đã NHẬN. KHÔNG chứng minh máy đã hiện thông báo (§L.3).';

notify pgrst, 'reload schema';

commit;
