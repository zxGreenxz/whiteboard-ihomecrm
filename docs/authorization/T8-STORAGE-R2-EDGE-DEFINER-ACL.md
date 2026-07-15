# T8 — Storage/R2/Edge/service identity + SECURITY DEFINER ACL burn-down

> Trạng thái: `IN_DESIGN`
> Production apply/flip: `BLOCKED` cho đến khi recovery set `VERIFIED` VÀ owner cung cấp exact commit SHA, migration SHA-256, maintenance window, canary count/VND cap (mặc định `0` = không flip). Phê duyệt tài liệu này KHÔNG phải phê duyệt áp production.

Đây là spec review-first cho một tranche. Không file `.sql` nào được đặt dưới `supabase/migrations/` cho tới khi review + recovery gate + lệnh owner riêng đạt; SQL dưới đây chỉ là intent trong fenced block.

## 1. Scope và dependency

- **Deliverable/tranche ID:** T8 — Storage/R2/Edge/service identity + full `SECURITY DEFINER` ACL baseline burn-down.
- **Domain:** Storage authorization boundary (Supabase Storage + Cloudflare R2 Worker), Edge/cron service identities, và ACL burn-down cho function `SECURITY DEFINER` toàn schema `public`.
- **Normative plan section:** `docs/AUTHORIZATION-PLAN.md` §14 (Storage authorization mục tiêu), §14.4 (Cloudflare R2 Worker — P0), §15 (Edge Functions), §4.3 (Storage LIVE inventory), và §27 (kết luận/tracker có thẩm quyền; §27.3 xếp T8 sau T7, trước T9; §27.6 yêu cầu mọi `SECURITY DEFINER` trong tranche có ACL explicit + pinned search path + burn-down plan).
- **Dependencies và trạng thái:**
  - T0a recovery certification — `BLOCKED` (recovery `20260715T152622Z-online-unfrozen`, `ONLINE_UNFROZEN/PARTIAL`; R2 mới `REFERENCED_OBJECTS_ONLY` 172/172 object, thiếu bucket-scoped list credential để enumerate orphan). T8 không được apply khi recovery chưa `VERIFIED`.
  - T2 RBAC source-of-truth / `authorize_v2` — `BLOCKED`. Storage policy org/resource-bound và Worker resolve permission đều cần authorize canonical đã ổn định.
  - T6a `organization_id` + derivation authoritative — `BLOCKED`. Object naming `<organization_id>/…` (§14.1) và `storage_object_links.organization_id` phụ thuộc org derivation fail-closed.
  - T4a JWT/concurrency/reconciliation/observability harness — `IN_DESIGN`. Cross-org Storage/REST negative tests cần fixture hai tổ chức và direct REST/RPC/Storage matrix.
  - T5/T6/T7 (canonical writers, RLS v2, per-domain cutover) — `BLOCKED`. T8 chạy sau khi các domain money đã cutover (§27.3).
- **In scope:**
  1. Storage bucket policy burn-down: đóng 7 SELECT policy authenticated-wide-chỉ-theo-bucket và policy owner/legacy-visibility của `document-templates`, thay bằng org/resource policy qua `storage_object_links` (§14.2); cleanup 4 policy mồ côi `room-sale-images` (đặc biệt `Public view room sale images` cấp SELECT `public`).
  2. Cloudflare R2 Worker (`infra/cloudflare-worker/src/index.ts`) — nâng từ Sprint-0 containment (JWT + `<bucket>/<uid>/` prefix + MIME/size + no-overwrite) lên mô hình §14.4: server dựng key ngẫu nhiên, upload-intent/link metadata DB trước upload, resolve org/resource + exact permission qua backend, private class dùng signed capability ngắn hạn (bật `/sign` Phase 2 hiện đang trả 501), tách public sale asset khỏi private PII.
  3. Rà `R2_PUBLIC_BASE` (`https://img.chillhome.io.vn`) như public origin: xác minh không có PII bucket nào phục vụ dưới public base; `room-sale-images` là public-DTO duy nhất được phép.
  4. Service identity inventory + hardening cho Edge/cron/worker chạm service role: `admin-create-user`, `llm-proxy`, `salary-v5-jobs`, `send-push`, `demo-reset`, Vercel `api/salary-v5-cron.js`, và Zalo VPS `worker/index.js` (§15).
  5. Full `SECURITY DEFINER` ACL burn-down: từ baseline "không tăng exposure" (`scripts/check-definer-acl.mjs`, baseline `count: 100` anon-executable) tiến tới zero unexplained client-callable definer; mỗi signature còn lại có ACL explicit + pinned `search_path` + lý do.
- **Out of scope:**
  - Thay đổi behavior tiền (payment/approval/invoice/deposit). T8 không sửa `record_invoice_payment_v3`, không wire approval prototype, không đụng compensating-reversal logic. Các quyết định §27.2 (auto_approve_invoice, locked revision, compensating reversal, maker-checker, 24h deposit hold, bulk per-invoice atomic) là ràng buộc bất biến mà T8 KHÔNG được đổi.
  - Xóa/retention legacy object hoặc bucket cũ (đó là T9). Migration Storage dual-read, giữ nguồn (§14.3 điểm 3, 7).
  - Rotate credential runtime như một mutation production trong tranche này (xem open_questions về anon key/secret; rotation thuộc secret-hygiene track riêng).
- **Business behavior trước thay đổi:** xem §2 bên dưới của phần "before/after".
- **Business behavior sau thay đổi:** như trên.
- **Ảnh hưởng nghiệp vụ/người dùng:** chủ yếu vô hình với luồng tiền. Rủi ro chính là hiển thị ảnh/tài liệu bị deny nếu policy org/resource siết trước khi backfill `storage_object_links` xong → phải dual-read và canary theo tổ chức.

## 1b. Business behavior trước / sau

| Chủ đề | Trước T8 (hiện trạng đã đọc từ code) | Sau T8 (đích, review-first) |
|---|---|---|
| Upload ảnh sale | `uploadFile()` (`src/lib/storage.ts`) route qua `isR2Bucket` → `uploadToR2()` PUT `${STORAGE_GATEWAY}/upload?key=<bucket>/<path>`; Worker kiểm JWT (`verifyUserId` gọi `/auth/v1/user`), ép prefix `room-sale-images/<uid>/`, MIME allowlist, 8MB, no-overwrite (409). Key do client chọn dưới prefix. | Server (upload-intent RPC) sinh key ngẫu nhiên `<organization_id>/<resource_type>/<resource_id>/<uuid>.<ext>` và ghi `storage_object_links` (nonce/org/resource/expected key/expiry/max bytes/MIME) TRƯỚC upload; Worker verify intent + resolve org/resource permission, không tin `Content-Type`/`X-Cache-Control` client (§14.4). |
| Đọc bucket private | `createSignedUrlFromStored()` tách `{bucket,path}` (`parseSupabaseRef` regex `/object/(public\|sign\|authenticated)/…`) rồi ký batched, TTL `SIGNED_URL_TTL=3600`. SELECT policy 7 bucket chỉ kiểm `bucket_id` cho `authenticated` → user đăng nhập bất kỳ đọc được object org khác nếu biết path (§4.3). | SELECT/signed URL qua `authorize(<resource>.view, org, resource)` dựa trên `storage_object_links`; cross-org path bị deny. R2 private class dùng signed capability ngắn hạn của Worker `/sign` (hiện trả `501 phase 2`), re-authorize trước khi ký. |
| `room-sale-images` | Đang live public trên R2 (`R2_PUBLIC_BUCKETS = {'room-sale-images'}`), đọc thẳng `img.chillhome.io.vn`, không ký. 4 policy Supabase mồ côi còn tồn (gồm SELECT `public`). | Giữ public-DTO có chủ đích, tách khỏi PII; cleanup policy mồ côi để bucket tái tạo không thừa hưởng SELECT `public` (§4.3). |
| Edge/cron/worker service role | `salary-v5-jobs` nhận 1-trong-3 (x-cron-secret/service JWT/admin JWT); `send-push` tin `role='service_role'` decode; `api/salary-v5-cron.js` đã verify `Bearer CRON_SECRET` constant-time; `demo-reset` shared secret; Zalo VPS worker giữ service key bypass RLS. | Service identity inventory đóng; service callers allowlist; `send-push` chỉ chấp nhận service secret xác minh chắc chắn (không tin decode payload) + deployment test `verify_jwt` không bị tắt (§15); Zalo worker vào service inventory + host hardening. |
| `SECURITY DEFINER` ACL | `scripts/check-definer-acl.mjs` chỉ chống TĂNG số anon-executable so baseline `count: 100`; live §4.1 báo 246 definer / 110 anon-executable tại `LIVE-20260712-A`. Không chứng minh 100+ signature an toàn. | Mỗi definer còn client-callable có ACL explicit, pinned `search_path`, lý do; zero unexplained callable definer; baseline thu nhỏ có chủ ý qua `--update`. |

## 2. Immutable release identity

Chưa có — phải do owner cung cấp trước khi apply. Không dùng branch name, "latest", glob migration hay broad `db push`.

- Full commit SHA: *(chưa cung cấp)*
- Exact migration path/signature: *(chưa cung cấp — một hoặc nhiều migration Storage policy; mỗi migration đụng VIEW phải chạy `node scripts/check-view-invoker.mjs`)*
- Migration SHA-256: *(chưa cung cấp)*
- Generated-types SHA-256: *(chưa cung cấp — nếu thêm bảng `storage_object_links` phải regen `src/integrations/supabase/types.ts`)*
- Deployed frontend SHA: *(chưa cung cấp)*
- Worker deploy identity: *(chưa cung cấp — `wrangler deploy` version id của `ihome-storage`, route `storage.chillhome.io.vn`, bucket binding `FILES=ihome-files`)*
- Recovery certification ID (`VERIFIED`): *(chưa có; hiện `20260715T152622Z-online-unfrozen` = PARTIAL)*
- Maintenance-window ID: *(chưa cung cấp)*
- Operator / Reviewer / Owner approval reference: *(chưa cung cấp)*

## 3. Live precheck (đọc — không mutate)

Trước prepare/apply phải chụp (read-only) và gắn thời điểm UTC:

- **Bucket inventory:** liệt kê bucket + `public` flag live; xác nhận 8 bucket Supabase đều `public=false` và trạng thái `room-sale-images` (Supabase orphan policy vs R2 live).
- **Storage policy inventory:** dump `pg_policies` cho schema `storage`; xác nhận đúng 7 SELECT policy authenticated-wide (`customer-id-cards`, `customer-images`, `payment-receipts`, `income-expense-attachments`, `meter-images`, `job-attachments`, `ui-references`), policy `document-templates` owner/legacy, và 4 policy mồ côi `room-sale-images` (gồm `Public view room sale images`).
- **`SECURITY DEFINER` ACL live:** chạy query của `scripts/check-definer-acl.mjs` (anon-executable definer) + query rộng hơn cho toàn bộ client-callable definer (`authenticated`); đối chiếu baseline `count: 100` và con số §4.1 (246 definer / 110 anon-executable). Ghi rõ mọi lệch — xem open_questions.
- **Active callers/writers:** grep code (`isR2Bucket`, `parseStorageRef`, `createSignedUrlFromStored`, `useSignedUrl`, `uploadFile`, `deleteFile`) + runtime PostgREST/Storage logs để map ai đọc/ghi bucket nào. Callers đã xác nhận từ code: `src/lib/storage.ts`, `src/lib/storage/r2Client.ts`, `src/hooks/useSignedUrl.ts`, `src/pages/phong-trong/PhongTrongSheet.tsx`.
- **R2 object inventory:** enumerate object dưới `ihome-files/room-sale-images/…` và đối chiếu DB references (`rooms.images`, `buildings.images`, `buildings.floor_layouts` — theo `scripts/migrate-bucket-to-r2.mjs` REWRITE map); phát hiện orphan/unreferenced (recovery ghi R2 mới `REFERENCED_OBJECTS_ONLY`).
- **Edge/cron/worker deploy state:** hash bundle Edge Functions đã deploy; xác nhận `verify_jwt` setting từng function; xác nhận `api/salary-v5-cron.js` và Zalo worker config.
- **Financial reconciliation baseline:** T8 không đụng tiền nhưng chụp baseline INCOME/EXPENSE + invoice/payment/credit để chứng minh delta = 0 sau apply.
- **Browser/runtime baseline:** trang Phòng trống công khai + trang có ảnh private (customer images/receipts) render bình thường; console/network sạch.
- **Monitoring/backup:** managed DB backups `COMPLETED`; alert Worker/Edge sống.

## 4. Change contract

- **Server-derived organization/actor/resources:** actor = `auth.uid()` từ JWT verified; organization = active org qua T6a derivation (không tin folder `<uid>` như tenant boundary — §14.1); resource (`resource_type`,`resource_id`) từ upload-intent, không từ key client.
- **Exact permission và resource scope:**
  - Upload: caller có upload permission trên đúng resource, path org = active org (§14.2 INSERT).
  - SELECT/signed URL: `authorize(<resource>.view, org, resource)`; PII bucket key riêng, không public URL.
  - Worker: verify Supabase JWT (đang gọi `/auth/v1/user`) → nhưng thêm resolve org/resource + exact permission qua backend RPC, không chỉ kiểm "đã đăng nhập".
- **State/version/CAS rules:** `storage_object_links` là intent trước object (nonce, expected key, expiry, max bytes, MIME); object không có link hợp lệ → orphan, không phục vụ. Immutable object ưu tiên; UPDATE hạn chế (§14.2).
- **Lock order:** upload-intent insert trước; object PUT sau; link finalize (hash/size) sau khi PUT ok. Không tạo link sau object (§14.4 điểm 5).
- **Idempotency scope, canonical payload hash và conflict behavior:** upload-intent unique theo `(organization_id, resource_type, resource_id, nonce)`; retry cùng nonce trả link cũ; Worker no-overwrite (`env.FILES.head` → 409) vẫn giữ. `/sign` capability ngắn hạn, HMAC (`SIGN_SECRET`), re-authorize trước ký.
- **Atomic effects:** policy swap + link table + Worker prefix rule là các unit tách biệt; mỗi migration một transaction; không gộp REVOKE DML khổng lồ (§27.4). Storage policy đổi không xóa object nguồn.
- **Audit/provenance:** actor/org/resource/hash/size/timestamp cho mỗi upload; append-only; không log signed URL/token/private path/PII (template §8).
- **External outbox/side effects:** Worker PUT vào R2 `ihome-files`; DB rewrite (nếu migrate thêm bucket) idempotent như `scripts/migrate-bucket-to-r2.mjs` (giữ Supabase nguồn làm backup).
- **Forward-fix/reversal behavior:** không xóa object để rollback; nếu policy siết gây deny hợp lệ, forward-fix backfill `storage_object_links` hoặc nới policy có kiểm soát, không mở lại authenticated-wide.
- **Feature flag default:** mọi thay đổi behavior (org/resource policy enforce, Worker intent model, `/sign` bật) mặc định `OFF`/shadow. Không flip nếu thiếu identity §2.

### SQL intent — CHƯA phải migration được duyệt

Signature/policy name phải lấy từ live catalog ngay trước apply; dưới đây là mẫu.

```sql
-- (a) Cleanup 4 policy mồ côi room-sale-images (đặc biệt SELECT public) trên storage.objects.
--     Tên policy phải khớp live: 'Public view room sale images',
--     'Authenticated upload/update/delete room sale images'.
begin;
drop policy if exists "Public view room sale images" on storage.objects;
-- ...các policy room-sale-images còn lại lấy exact name từ pg_policies...
commit;
```

```sql
-- (b) Link metadata (intent-before-object). Cột theo §14.1.
create table if not exists public.storage_object_links (
  id            uuid primary key default gen_random_uuid(),
  bucket_id     text not null,
  object_name   text not null,
  organization_id uuid not null,
  resource_type text not null,
  resource_id   uuid not null,
  uploaded_by   uuid not null,
  classification text not null,          -- 'public_sale' | 'pii' | ...
  nonce         uuid not null,
  expected_key  text not null,
  max_bytes     bigint,
  mime          text,
  expires_at    timestamptz,
  content_hash  text,
  byte_size     bigint,
  created_at    timestamptz not null default now(),
  unique (bucket_id, object_name),
  unique (organization_id, resource_type, resource_id, nonce)
);
alter table public.storage_object_links enable row level security;
-- RLS + org/resource SELECT policy qua authorize(...) thêm sau khi T2/T6a ổn định.
```

```sql
-- (c) Thay 7 SELECT policy authenticated-wide bằng org/resource policy.
--     CHỈ soạn sau khi backfill storage_object_links + dual-read xác minh.
--     Mẫu (bucket_id thật + join link + authorize):
-- create policy "<name> org scoped" on storage.objects for select to authenticated
--   using (exists (select 1 from public.storage_object_links l
--     where l.bucket_id = storage.objects.bucket_id
--       and l.object_name = storage.objects.name
--       and public.authorize('<resource>.view', l.organization_id, l.resource_id)));
```

Không đặt (a)/(b)/(c) vào `supabase/migrations/` trước khi restore test/review và recovery gate đạt.

## 5. Test evidence trước production

- **Project restore/staging ID:** *(chưa có — cần restore project để test policy swap + Worker)*.
- **Unit/property tests:** `sanitizeStorageFileName` (`src/lib/storageKey.ts`) đã pure/testable; thêm test `parseStorageRef`/`parseR2Ref`/`r2PublicUrl`/`toR2` cho biên (blob/data/public R2/private R2/Supabase legacy URL/path trần).
- **Direct JWT REST/RPC/Storage matrix:** user A với exact object name của B trên từng bucket → deny (§14.3 điểm 6, §4.3). Worker: A upload/overwrite/read key của B → 403/409.
- **Cross-org/foreign-resource tests:** signed URL cross-org bị deny; `authorize(<resource>.view)` false → không ký.
- **Concurrent/retry/rollback-injection:** upload-intent trùng nonce; Worker no-overwrite; `/sign` expiry/replay.
- `npm run typecheck:baseline`: phải không tăng lỗi so `ts-baseline.txt`.
- `npx tsc --noEmit -p tsconfig.app.json`: chạy (root `tsc` không check gì).
- **Related/full Vitest:** `npx vitest run` cho storage utils + bất kỳ hook dùng `useSignedUrl`.
- `npm run lint` / `npm run build`: xanh.
- `node scripts/check-definer-acl.mjs`: không có anon-executable definer mới ngoài baseline; ghi lại số live để burn-down.
- `node scripts/check-view-invoker.mjs`: chạy nếu migration đụng VIEW (GOTCHA `CREATE OR REPLACE VIEW` rớt `security_invoker`).
- **Generated Supabase type drift:** nếu thêm `storage_object_links`, `npm run gen:types > src/integrations/supabase/types.ts` + header comment; không để drift.
- **Full money reconciliation:** delta INCOME/EXPENSE/invoice/payment/credit = 0 (T8 không đụng tiền — chứng minh no side effect).
- **Browser happy/edge/deny:** trang Phòng trống công khai render; ảnh customer/receipt private render qua signed URL; user org khác không đọc được; console/network sạch.
- **Reviewer verdict:** *(chưa có)*.

## 6. Canary và production gate

- **Canary organization/users:** *(chưa chốt)*.
- **Transaction count cap:** T8 không phát sinh giao dịch tiền → cap tính theo số tổ chức bật org/resource policy; **mặc định 0** (không flip).
- **VND cap:** **mặc định `0`** (T8 không mutate tiền; nếu bất kỳ bước nào chạm số tiền phải dừng — ngoài scope).
- **Observation interval:** ≥ 1 ngày làm việc cho mỗi bước behavior; theo dõi deny rate ảnh/tài liệu.
- **Expansion approval / old writer drain proof / exact revoke:** revoke authenticated-wide SELECT policy chỉ sau khi dual-read chứng minh org/resource policy phủ 100% object hợp lệ; drain Worker legacy path (client-chosen key) trước khi ép server-derived key.

Default nếu chưa được owner chốt: canary count = `0`, VND cap = `0`, flag = `OFF`, **không apply/flip**.

## 7. Mandatory abort

Abort ngay khi có một trong:

- unauthorized hoặc cross-org Storage/R2 read/upload/overwrite success (user A chạm object B);
- lộ PII qua public base (`img.chillhome.io.vn`) cho bucket không phải `room-sale-images`;
- financial drift khác 0 (bất kỳ side effect tiền nào);
- policy swap gây deny happy-path ảnh/tài liệu không giải thích được trên canary;
- orphan object phục vụ được mà không có `storage_object_links` hợp lệ;
- unexpected legacy writer (client-chosen key sau khi đã ép server-derived);
- backup/object hash mismatch (R2/Storage content hash lệch capture);
- xuất hiện `SECURITY DEFINER` mới anon/authenticated-executable ngoài allowlist;
- 3 RPC/Worker failure liên tiếp hoặc >1% trong 5 phút; p95 >2× baseline trong 10 phút;
- mất monitoring/backup/audit telemetry.

Khi abort: disable canary, freeze Storage/R2 domain, giữ evidence; không xóa/sửa object hay row tiền để rollback. Reconcile, forward-fix (backfill link / nới policy có kiểm soát) và tạo compensating action có audit khi cần.

## 8. Post-apply evidence

- Apply start/end UTC; Worker deploy version id.
- Catalog/signature/grant pre/post diff: `pg_policies` schema `storage`; ACL `SECURITY DEFINER` (số client-callable trước/sau burn-down); policy mồ côi đã drop.
- Direct API deny/allow result: cross-org Storage/R2 negative tests; `/sign` capability.
- Browser result: Phòng trống công khai + ảnh private render; deny cross-org.
- Reconciliation delta: tiền = 0; object count/hash Storage vs R2 khớp capture.
- Runtime error/latency/deny metrics: Worker upload/sign + Storage signed-URL.
- Hidden caller/legacy writer result: không còn client-chosen key.
- Observation completed at; Final reviewer; Final state (`APPLIED`/`VERIFIED`); Tracker update commit (cập nhật `docs/AUTHORIZATION-IMPLEMENTATION-STATUS.md` hàng T8).

Evidence không được chứa credential, JWT, signed URL, private object path hoặc PII.

---

### Ghi chú ràng buộc bất biến (§27.2)

T8 KHÔNG đổi hành vi tiền. Các quyết định owner ngày 2026-07-15 vẫn nguyên: hóa đơn mặc định `APPROVED` với server enforce `auto_approve_invoice` (tắt → `DRAFT`); sửa invoice `APPROVED`-chưa-payment qua locked revision (expected_version + reason + audit); payment không hard-delete — dùng bút toán đối ứng liên kết "Hủy giao dịch thu tiền (tạo bút toán hoàn tác)" chống double-reversal; maker-checker mặc định no self-approve trừ ngoại lệ đóng phiếu chi thường dưới hạn mức trên sổ quỹ maker nắm giữ; force-approval bỏ qua hạn mức; maker chỉ chọn sổ mình nắm; phiếu chờ có thể trống sổ; kế toán/owner chọn sổ post + chứng từ ở final decision; hold cọc 24h theo giờ server có `expires_at`, không double-hold; bulk payment per-invoice atomic partial-success có kết quả từng dòng bền. Nếu bất kỳ bước T8 nào chạm các luồng này → dừng, đó là dấu hiệu sai scope.