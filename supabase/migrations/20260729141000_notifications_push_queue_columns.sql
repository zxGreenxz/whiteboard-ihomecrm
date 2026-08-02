-- PR-3 / file 2 — cột hàng đợi push trên public.notifications.
--
-- ĐẶC TẢ: §D.3 "File 1 — cột hàng đợi trên notifications".
--
-- Ý TƯỞNG: bỏ hẳn pg_net (§D.0 đã bác), DB chỉ giữ HÀNG ĐỢI + LEASE + IDEMPOTENCY; việc gửi HTTP
-- do edge function salary-v5-jobs làm (§D.4). Bảng notifications chính là hàng đợi — không dựng
-- bảng phụ, không dựng VIEW (bẫy security_invoker).
--
-- 🔴 push_queued_at vs push_leased_at — SỬA SAU AUDIT, ĐỌC KỸ (§D.3):
--   Bản đặc tả TRƯỚC khai một cột push_queued_at mang HAI nghĩa: ghi lúc chuyển sang SENDING
--   nhưng đọc như đồng hồ lease 15 phút ⇒ NULL trên mọi dòng QUEUED mới. Đúng loại lỗi §0.4(B)
--   vừa bác ở sent_at, vi phạm bất biến 4 của §L.6. Nay TÁCH ĐÔI, mỗi cột một nghĩa duy nhất:
--     push_queued_at = lúc VÀO hàng đợi (trigger sinh thông báo ghi)
--     push_leased_at = lúc BẮN / claim (drain ghi) — đây mới là đồng hồ dọn dòng treo
--   Index dọn treo vì thế neo vào push_leased_at, KHÔNG phải push_queued_at.
--
-- ⚠ KHÔNG có cột push_request_id: đó là di sản thiết kế pg_net, §D.0 đã bỏ. Đừng thêm lại.
--
-- push_state — 6 giá trị, ý nghĩa phân biệt (§D.3):
--   QUEUED    chờ drain nhặt
--   SENDING   drain đã claim, đang gửi (push_leased_at = mốc lease)
--   SENT      Web Push nhận
--   FAILED    gửi hỏng, hết lượt thử (push_attempts)
--   NO_DEVICE người nhận KHÔNG có push_subscriptions active — không phải lỗi
--   SKIPPED   cố ý bỏ qua, dành cho cadence='DIGEST' đợt 2 (§D.6) — KHÁC NO_DEVICE
--   NULL      dòng cũ / dòng không đi đường push (1130 dòng lịch sử đều rơi vào đây)
--
-- IDEMPOTENT: add column if not exists · drop constraint if exists TRƯỚC khi add constraint
-- (ALTER TABLE ADD CONSTRAINT không có IF NOT EXISTS) · create index if not exists.
-- KHÔNG dùng CREATE INDEX CONCURRENTLY: không chạy được trong transaction block, mà cả file này
-- là MỘT transaction (§3.3). Bảng 1130 dòng nên khoá vài chục ms.
--
-- LƯU Ý SAU KHI APPLY (§D.3): chạy `npm run gen:types` — KHÔNG redirect, KHÔNG thêm header tay:
-- scripts/gen-supabase-types.mjs tự ghi thẳng vào file và tự chèn header.

begin;

-- 1) Bốn cột hàng đợi.
--    KHÔNG có push_queued_at: không writer nào ghi và không reader nào đọc nó (grep toàn repo chỉ
--    ra định nghĩa + comment) ⇒ đúng khuyết tật "cột mang hai nghĩa / cột chết" mà §0.4(B) vừa bác
--    ở sent_at. Mốc VÀO hàng đợi đã có sẵn: notifications.created_at (trigger E1 còn chủ động bump
--    khi số đếm tăng). 🚫 Cũng KHÔNG dùng `default now()` cho cột này — fast-default sẽ đóng dấu
--    giờ giả cho 1130 dòng lịch sử.
alter table public.notifications
  add column if not exists push_state      text,
  add column if not exists push_attempts   smallint not null default 0,
  add column if not exists push_leased_at  timestamptz,   -- ghi khi BẮN (drain) — đồng hồ dọn treo
  add column if not exists push_idem_key   text;          -- khoá lô gửi (KHÔNG phải khoá khử trùng)

-- 2) CHECK cho push_state. NULL hợp lệ (dòng cũ + dòng không đi đường push).
alter table public.notifications drop constraint if exists notifications_push_state_chk;
alter table public.notifications add constraint notifications_push_state_chk
  check (push_state is null or push_state in
         ('QUEUED','SENDING','SENT','FAILED','NO_DEVICE','SKIPPED'));

-- 3) Ba index.
--    a) hàng đợi: drain quét theo (user_id, created_at) trong đám QUEUED — partial nên nhỏ xíu.
create index if not exists idx_notifications_push_queued
  on public.notifications (user_id, created_at) where push_state = 'QUEUED';
--    b) dọn treo: tìm dòng SENDING quá hạn lease theo push_leased_at.
create index if not exists idx_notifications_push_leased
  on public.notifications (push_leased_at) where push_state = 'SENDING';
--    c) tra cứu theo khoá lô — INDEX THƯỜNG, CỐ Ý KHÔNG UNIQUE.
--    🔴 Bản nháp dùng UNIQUE. Đã tái hiện trên prod (rollback) rằng đó là viên thuốc độc:
--    `authenticated` có UPDATE CẤP BẢNG trên notifications và policy own-row là PERMISSIVE, nên
--    một người dùng bất kỳ tự đặt push_idem_key của DÒNG MÌNH thành giá trị mà drain sắp dùng cho
--    người khác. Câu claim của drain là MỘT câu UPDATE ⇒ văng 23505 ⇒ hỏng CẢ LÔ, hỏng cho MỌI
--    người, lặp mãi tới khi dọn tay.
--    Khử trùng THẬT nằm ở public.push_send_log.idempotency_key (PRIMARY KEY, chỉ service_role ghi
--    được qua edge function) — xem 20260729152000_push_send_log.sql. Cột này chỉ để đối soát lô.
--    (Nếu sau này muốn UNIQUE thì phải cắt quyền ghi trước — nhớ án lệ: REVOKE cấp CỘT trong khi
--     GRANT cấp BẢNG còn đó là no-op.)
drop index if exists public.uq_notifications_push_idem;
create index if not exists idx_notifications_push_idem
  on public.notifications (push_idem_key) where push_idem_key is not null;

commit;
