-- =============================================================================
-- Đợt 1 hardening sau audit đối chiếu AUTHORIZATION-PLAN.md (2026-07-25)
--
-- Đóng 5 khoảng hở cấu trúc phát hiện khi chấm lại 15 tiêu chí nghiệm thu §20.
-- Tất cả đều là thu hẹp bề mặt, KHÔNG đổi hành vi nghiệp vụ của người dùng hợp lệ.
--
--   (1) §20-11 · 14 SECURITY DEFINER writer finance-v2 đang anon-executable.
--       Nguyên nhân: Postgres mặc định GRANT EXECUTE ... TO PUBLIC khi CREATE
--       FUNCTION; các tranche 23-25/07 không kèm REVOKE nên CI gate
--       `scripts/check-definer-acl.mjs` đỏ. Đây đúng kịch bản §9.2 đã cảnh báo.
--
--   (2) §4.3 · 4 policy mồ côi `room-sale-images` (bucket đã chuyển sang R2).
--       `Public view room sale images` cấp SELECT cho role `public` — nếu ai đó
--       tạo lại bucket cùng tên, nó thừa hưởng ngay quyền đọc công khai.
--
--   (3) §20-5 · `invoices`/`payments`/`accounts` còn GRANT INSERT/UPDATE/DELETE
--       cho `anon`. Đây là Pha A của scripts/authz-prepared/T7_PREPARED_drain_
--       legacy_dml.sql — an toàn áp sớm vì FE luôn chạy dưới `authenticated`,
--       không bao giờ ghi dưới `anon`. Pha B (revoke `authenticated`) VẪN CHỜ
--       đủ chu kỳ vận hành theo điều kiện go/no-go trong file đó.
--
--   (4) §20-12 · Storage thiếu lớp RESTRICTIVE cho INSERT. t5_29 đã phủ
--       SELECT/UPDATE/DELETE nhưng không phủ INSERT, nên user org A vẫn tạo
--       được object trong bucket PII ở thư mục của org B.
--
--   (5) §9.3-5 · `generate_invoices_for_building(uuid,uuid,text,text)` là
--       SECURITY DEFINER nhưng thiếu pinned search_path (ngoại lệ cuối cùng).
--
-- Idempotent: revoke/drop-if-exists/create-or-replace. Chạy lại nhiều lần an toàn.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- (1) REVOKE anon + PUBLIC cho 14 SECURITY DEFINER mới.
--
-- Theo ĐÚNG hai kiểu đã dùng ở 20260710130500_revoke_internal_definer_grants.sql:
--   • Trigger function  -> internal-only, revoke cả `authenticated`.
--   • RPC client gọi    -> revoke PUBLIC+anon, GIỮ `authenticated`.
-- Revoke theo signature đầy đủ để không bỏ sót overload.
-- -----------------------------------------------------------------------------

-- 1a. Trigger function: không client role nào được gọi trực tiếp.
revoke all on function public.jobs_stamp_completion_time()
  from public, anon, authenticated;

-- 1b. Writer/reader RPC: chặn anon, giữ authenticated (FE gọi thật).
revoke all on function public.create_income_expense_v2(jsonb)                       from public, anon;
grant  execute on function public.create_income_expense_v2(jsonb)                   to authenticated;

revoke all on function public.approve_income_expense_v2(uuid, bigint, text)          from public, anon;
grant  execute on function public.approve_income_expense_v2(uuid, bigint, text)      to authenticated;

revoke all on function public.approve_and_post_income_expense_v2(jsonb)              from public, anon;
grant  execute on function public.approve_and_post_income_expense_v2(jsonb)          to authenticated;

revoke all on function public.post_approved_income_expense_v2(jsonb)                 from public, anon;
grant  execute on function public.post_approved_income_expense_v2(jsonb)             to authenticated;

revoke all on function public.reverse_posted_income_expense_v2(uuid, uuid, date, text, text)     from public, anon;
grant  execute on function public.reverse_posted_income_expense_v2(uuid, uuid, date, text, text) to authenticated;

revoke all on function public.cancel_unposted_income_expense_v2(uuid, bigint, bigint, text, text)     from public, anon;
grant  execute on function public.cancel_unposted_income_expense_v2(uuid, bigint, bigint, text, text) to authenticated;

revoke all on function public.withdraw_income_expense_v2(uuid, bigint, bigint, text)     from public, anon;
grant  execute on function public.withdraw_income_expense_v2(uuid, bigint, bigint, text) to authenticated;

revoke all on function public.resubmit_income_expense_v2(uuid, bigint, jsonb, text)      from public, anon;
grant  execute on function public.resubmit_income_expense_v2(uuid, bigint, jsonb, text)  to authenticated;

revoke all on function public.reject_invalid_income_expense_v2(uuid, bigint, text, text)     from public, anon;
grant  execute on function public.reject_invalid_income_expense_v2(uuid, bigint, text, text) to authenticated;

revoke all on function public.request_income_expense_changes_v2(uuid, bigint, text, jsonb, text)     from public, anon;
grant  execute on function public.request_income_expense_changes_v2(uuid, bigint, text, jsonb, text) to authenticated;

revoke all on function public.mark_income_expense_disputed_v2(uuid, bigint, uuid, text, timestamptz, text)     from public, anon;
grant  execute on function public.mark_income_expense_disputed_v2(uuid, bigint, uuid, text, timestamptz, text) to authenticated;

revoke all on function public.adopt_voucher_attachments_as_evidence_v2(uuid)         from public, anon;
grant  execute on function public.adopt_voucher_attachments_as_evidence_v2(uuid)     to authenticated;

revoke all on function public.list_cashbook_visibility_v2()                          from public, anon;
grant  execute on function public.list_cashbook_visibility_v2()                      to authenticated;

-- -----------------------------------------------------------------------------
-- (2) Dọn 4 policy mồ côi `room-sale-images`.
--
-- Bucket không còn tồn tại trong storage.buckets (ảnh sale đã sang Cloudflare R2,
-- đọc thẳng qua custom domain). Policy vô hiệu nhưng vẫn nằm trong catalog và sẽ
-- được BUCKET TẠO LẠI kế thừa — đặc biệt `Public view room sale images` cấp
-- SELECT cho role `public`. Xoá để không còn bẫy.
-- -----------------------------------------------------------------------------

drop policy if exists "Public view room sale images"           on storage.objects;
drop policy if exists "Authenticated upload room sale images"   on storage.objects;
drop policy if exists "Authenticated update room sale images"   on storage.objects;
drop policy if exists "Authenticated delete room sale images"   on storage.objects;

-- -----------------------------------------------------------------------------
-- (3) T7 Pha A: rút DML của riêng `anon` trên 3 bảng tiền còn lại.
--
-- `income_expenses`/`income_expense_items`/`approval_*` đã sạch từ tranche trước;
-- ba bảng này là phần còn lại. KHÔNG đụng `authenticated` (Pha B) và KHÔNG đụng
-- SELECT (trang công khai /c/:code, /r/:token đọc qua RPC SECURITY DEFINER nên
-- không phụ thuộc grant này, nhưng vẫn giữ nguyên quyền đọc cho an toàn).
-- -----------------------------------------------------------------------------

revoke insert, update, delete on table public.invoices  from anon;
revoke insert, update, delete on table public.payments  from anon;
revoke insert, update, delete on table public.accounts  from anon;

-- -----------------------------------------------------------------------------
-- (4) Lớp RESTRICTIVE cho INSERT vào bucket PII.
--
-- `can_read_storage_object_v1` KHÔNG dùng lại được cho INSERT: object mới chưa có
-- dòng trong storage_object_links nên hàm đó trả false ⇒ chặn sạch mọi upload.
-- Vì vậy dựng hàm ghi riêng, chấp nhận đúng hai hình dạng path hợp lệ đang chạy:
--
--   a) `<auth.uid()>/...`             — quy ước hiện hành của mọi màn upload
--                                       (customer-id-cards, customer-images,
--                                        job-attachments, payment-receipts,
--                                        document-templates, meter-images,
--                                        income-expense-attachments v1)
--   b) `v2/<org>/<membership>/<uuid>` — chứng từ finance-v2, path do server cấp
--                                       qua create_finance_evidence_upload_intent_v2;
--                                       xác thực bằng chính dòng intent của caller.
--
-- Bucket không chứa PII giữ nguyên hành vi cũ. Super admin luôn qua.
-- -----------------------------------------------------------------------------

create or replace function app_private.can_write_storage_object_v1(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
  select
    -- Bucket không chứa PII: không siết thêm.
    p_bucket not in ('customer-id-cards','customer-images','income-expense-attachments',
                     'job-attachments','payment-receipts','meter-images','document-templates')
    or (select public.is_super_admin())
    -- (a) Thư mục gốc phải là chính người đang upload.
    or (storage.foldername(p_name))[1] = (select auth.uid())::text
    -- (b) Path do server cấp cho chứng từ finance-v2, gắn với intent của caller.
    or exists (
      select 1
        from public.finance_evidence_objects e
       where e.bucket_id   = p_bucket
         and e.object_name = p_name
         and e.uploader_user_id = (select auth.uid())
    );
$fn$;

comment on function app_private.can_write_storage_object_v1(text, text) is
  'Gác GHI storage cho bucket PII: chỉ cho thư mục của chính caller hoặc path do upload-intent finance-v2 cấp. Cặp với can_read_storage_object_v1 (đọc/sửa/xoá).';

-- ACL giống hệt hàm đọc: chỉ `authenticated` (policy đánh giá dưới quyền caller).
revoke all on function app_private.can_write_storage_object_v1(text, text) from public, anon;
grant execute on function app_private.can_write_storage_object_v1(text, text) to authenticated;

drop policy if exists storage_pii_org_isolation_insert on storage.objects;
create policy storage_pii_org_isolation_insert
  on storage.objects
  as restrictive
  for insert
  to authenticated
  with check (app_private.can_write_storage_object_v1(bucket_id, name));

-- -----------------------------------------------------------------------------
-- (5) Pin search_path cho SECURITY DEFINER cuối cùng còn thiếu.
-- -----------------------------------------------------------------------------

alter function public.generate_invoices_for_building(uuid, uuid, text, text)
  set search_path to 'pg_catalog', 'public';

commit;
