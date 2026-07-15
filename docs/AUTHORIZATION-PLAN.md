# Kế hoạch tổng thể: Multi-tenant Authorization & Financial Approval

> **Trạng thái**: **NO-GO cho thi công/cutover**; đã cập nhật theo rà soát độc lập ngày 2026-07-14 và quyết định nghiệp vụ của owner ngày 2026-07-15 — **chưa phải migration có thể chạy**
> **Live DB được kiểm tra gần nhất**: 2026-07-14 (chỉ đọc, qua Management API); snapshot chi tiết ban đầu 2026-07-12 16:27:57–16:28:41 UTC vẫn được giữ làm manifest đối chiếu
> **Code được đối chiếu**: application/database source và các migration hiện có; mọi live fact phải chụp lại trước từng tranche vì production vẫn phát sinh giao dịch
> **Phạm vi**: React/Vite, Supabase Auth, Postgres/RLS/RPC, Storage, Edge Functions, các luồng ghi tài chính
> **Mục tiêu tài liệu**: đủ bằng chứng, quyết định nghiệp vụ, thiết kế, thứ tự migration, rollback, test và tiêu chí nghiệm thu để audit độc lập trước khi thi công.
> **Lịch sử tài liệu**: audit gốc ở `85503ae`, các vòng bổ sung tại `112849f`–`f78693e`; rà soát độc lập được tổng hợp ở `docs/Kết luận kiểm tra.md`; mục 27 là kết luận/tracker có thẩm quyền mới nhất và thay thế mọi thứ tự hoặc claim mâu thuẫn trước đó trong tài liệu.

---

## 0. Cách đọc và mức độ tin cậy

Tài liệu dùng ba nhãn bằng chứng:

- **[LIVE]**: truy vấn chỉ đọc trực tiếp catalog/data của project Supabase ngày 2026-07-12.
- **[CODE]**: đọc từ code/migration trong repository. Migration trong Git không tự chứng minh đã deploy.
- **[DESIGN]**: kiến trúc đích hoặc đề xuất; phải được audit và chuyển thành migration/code ở giai đoạn triển khai.

### Cảnh báo quan trọng

1. `supabase_migrations.schema_migrations` của live DB không phản ánh đầy đủ các object mới, trong khi catalog có definition mới hơn. Khi audit/cutover phải so sánh **catalog thực tế** (`pg_proc`, `pg_policies`, ACL, trigger, bucket), không suy ra deployment chỉ từ migration ledger.
2. Tên bảng `public.tenants` hiện là **người thuê/cư dân**, không phải SaaS tenant. Thiết kế mới dùng tên `organizations`; tuyệt đối không tái sử dụng `tenants`.
3. `SECURITY DEFINER` vượt RLS theo quyền owner của function. RLS tốt không bù được RPC `SECURITY DEFINER` thiếu guard hoặc được cấp `EXECUTE` quá rộng.
4. `service_role`, database owner và operator hạ tầng vẫn có thể vượt RLS/trigger. “Audit bất biến” trong Postgres chỉ bất biến đối với application roles. Nếu cần chống sửa bởi operator, phải xuất hash/event sang kho append-only bên ngoài.
5. Tài liệu này không thay đổi code/database. Mọi DDL bên dưới là **pseudo-DDL định hướng**, chưa được chạy.

### 0.1 Manifest bằng chứng và quy tắc làm mới

| ID | Loại | As-of | Nội dung |
|---|---|---|---|
| `CODE-20260712-A` | Git/code | `f78693e` | Route, hook, migration, Edge/API/Worker và write path. Các thay đổi working tree ngoài file này bị loại khỏi scope. |
| `LIVE-20260712-A` | Live/catalog | 2026-07-12 16:27:57–16:28:41 UTC | Aggregate catalog/RLS/function ACL, body các helper trọng yếu, orphan classification, Storage policy/bucket và aggregate trạng thái thu chi. |

- Các số `[LIVE]` ở mục 4 và finding “vẫn còn” trong mục 5/9 dùng `LIVE-20260712-A`, trừ nơi ghi timestamp khác.
- Bằng chứng live là snapshot, không phải invariant. Trước mỗi sprint/cutover phải lưu query đã review, hash query/result, UTC, project ref và code SHA trong artifact audit; không ghi identity, path object, token hoặc secret.
- `scripts/query-sql.mjs` chỉ là transport và **không cưỡng chế chế độ chỉ đọc ở cấp kỹ thuật**. Reviewer phải xác nhận file SQL chỉ chứa `SELECT/WITH` an toàn trước khi chạy.

---

## 1. Executive summary

Hệ thống hiện có nền RBAC đáng kể: `staff_assignments`, role JSONB, building/area scope, `can_access_building`, `can_do_on_building`, 136/136 bảng public bật RLS và migration hardening ngày 2026-07-10 đã đóng nhiều đường xuyên chủ dữ liệu. Tuy nhiên, mô hình hiện tại vẫn suy tenant qua `user_id`, building và quan hệ nhân viên; chưa có khóa ngoại `organization_id` làm biên tenant bắt buộc.

Bốn nhóm rủi ro cần xử lý trước khi gọi hệ thống là multi-tenant an toàn:

1. **Identity/privilege fail-open**: `get_my_permissions()` trả `{"__superadmin":true}` cho caller không phải staff/cổ đông/quản lý; live có 2 auth user thuộc nhánh này. Đây là suy luận “không có assignment = owner”, không phải bằng chứng owner.
2. **Backend attack surface quá rộng**: live có 246 `SECURITY DEFINER`; 110 hàm trong số đó caller `anon` có quyền execute hiệu lực. Ít nhất các helper ghi `_internal_settlement_account(...)`, `_termination_ensure_type(...)` và nhiều recompute helper đang callable trực tiếp mà không có guard đối tượng phát hiện được.
3. **Financial approval có thể bị bypass**: `income_expenses.approval_status` mặc định lịch sử là `APPROVED`; nhiều frontend path insert/update trực tiếp trạng thái `APPROVED`; payment, voucher và item thường ghi qua nhiều request không cùng transaction. “UNAPPROVED” đang đồng thời mang nghĩa nháp và chờ duyệt.
4. **Kênh ngoài Supabase chưa cùng authorization boundary**: Cloudflare R2 Worker hiện chỉ kiểm JWT hợp lệ rồi cho upload vào key bất kỳ và trả URL dưới public base; `api/salary-v5-cron.js` chưa xác thực request đi vào Vercel route trước khi chuyển tiếp cron secret. Hai kênh này phải vào Sprint 0, không chờ Sprint Storage/Edge cuối.

### Kiến trúc đích

- `organizations` là tenant boundary bắt buộc trên mọi dữ liệu nghiệp vụ.
- Membership xác định **ai thuộc tổ chức nào**.
- Role/permission xác định **được làm gì**.
- Binding/scope xác định **được làm ở đâu**: organization, area, building, cashbook.
- Override per-user có cả `ALLOW` và `DENY`, trong đó `DENY` thắng.
- Backend authorization function/RPC/RLS là nguồn quyết định cuối cùng; frontend chỉ phản chiếu UX.
- Mọi luồng tiền đi qua RPC transaction hẹp; client không được tự ghi `POSTED/APPROVED` hay sửa số dư trực tiếp. Invoice có thể được server tạo `APPROVED` theo setting đã duyệt vì đó là khoản phải thu, không phải client posting tiền.
- Approval request lưu snapshot rule và payload; quyết định duyệt + post cashbook là một transaction.
- Không khớp rule => **bắt buộc duyệt**.
- Maker-checker là mặc định. Ngoại lệ maker tự duyệt chỉ áp dụng cho phiếu chi thông thường dưới hạn mức, trên sổ quỹ maker nắm giữ và phải hậu kiểm; mọi force-approval vẫn cần người khác duyệt. Tenant owner emergency approve cần reason, event cảnh báo và audit bất biến.

### Quyết định triển khai

Chương trình triển khai đồng bộ qua 8 sprint. Tuy vậy, các P0 phải được hotfix ở Sprint 0 trước khi chờ hoàn thiện toàn bộ kiến trúc. Không nên đặt một “big bang migration” duy nhất lên production.

---

## 2. Quyết định nghiệp vụ đã chốt

| Chủ đề | Quyết định mục tiêu |
|---|---|
| Mô hình tổ chức | Nội bộ là chính nhưng hỗ trợ owner/cổ đông/đối tác ngoài; tenant isolation phải là mặc định. |
| Người dùng | Owner, quản trị, kế toán, sales, kỹ thuật, cổ đông, quản lý lợi nhuận, đối tác ngoài. |
| Công thức quyền | Role = **what**; organization/area/building/cashbook = **where**; override per-user = ngoại lệ. |
| Thu nhập | Khoản thu nội bộ đủ điều kiện có thể post ngay theo allowlist/rule. Khoản thu từ khách phải đi qua RPC payment atomic; không được hiểu “mọi INCOME đều tin cậy”. |
| Chi phí | Rule theo cashbook + category + amount + building/area + source. Phiếu chi thông thường có thể được maker tự duyệt trong hạn mức được cấu hình, nhưng chỉ khi dùng sổ quỹ do chính membership đó nắm giữ; mọi trường hợp force-approval bỏ qua hạn mức và luôn chờ người khác duyệt. |
| Luôn cần duyệt | Hoa hồng, thưởng, hoàn tiền/hoàn cọc, lương, chia lợi nhuận, chi phát sinh từ hợp đồng/thanh lý và các category/source được cấu hình force approval. |
| Không khớp rule | `REQUIRE_APPROVAL`, fail closed. |
| Duyệt | Duyệt hợp lệ đồng thời là xác nhận đã chi/thu; cashbook chịu tác động ngay trong cùng transaction. Khi phiếu chờ duyệt chưa chọn sổ quỹ, kế toán/owner chọn sổ được phép và bổ sung ảnh chứng từ tại bước duyệt trước khi post. |
| Approver | Kết hợp approver toàn tổ chức và approver theo cashbook/area/building. |
| Maker-checker | Mặc định creator không tự duyệt. Ngoại lệ có kiểm soát chỉ dành cho **phiếu chi thông thường** trong hạn mức tự duyệt, trên sổ quỹ maker nắm giữ và bắt buộc vào hàng hậu kiểm; không áp dụng cho force-approval. |
| Emergency | Chỉ membership loại `OWNER`; reason bắt buộc; không được âm thầm dùng như luồng thường; tạo security event. Emergency không thay thế ngoại lệ tự duyệt theo hạn mức. |
| Hóa đơn mới | Mặc định tạo ở `APPROVED`; cài đặt `auto_approve_invoice` cho phép bật/tắt. Khi tắt, hóa đơn mới ở `DRAFT` và cần duyệt. Dù bật, client không được tự gắn metadata duyệt; RPC server ghi provenance theo cấu hình. |
| Sửa hóa đơn đã duyệt | Nhân viên có quyền quản lý được sửa khi hóa đơn chưa có payment hiệu lực; sửa qua RPC versioned, bắt buộc lý do và lưu revision/audit để kế toán/owner xem trước–sau. |
| Rollback tài chính | Không “unapprove” hoặc xóa payment đã ghi sổ. “Hoàn tác payment” nghĩa là tạo một giao dịch đối ứng triệt tiêu tác động của payment gốc, giữ cả bản gốc lẫn bản hoàn tác để truy vết. |
| Cọc giữ chỗ | Khi cọc vào `PENDING_APPROVAL`, phòng được hold độc quyền 24 giờ; duyệt/post chuyển thành reservation chính thức, reject/cancel/hết hạn tự giải phóng hold. |

### Định nghĩa “nội bộ đủ điều kiện auto-post”

Không dùng một boolean client gửi lên. Chỉ auto-post khi backend xác minh tất cả điều kiện:

1. `system_source` nằm trong allowlist có version, ví dụ cặp bút toán settlement nội bộ.
2. Nguồn được tạo bởi RPC nội bộ cụ thể, không phải REST insert.
3. Hai chân cân bằng, cùng `organization_id`, cùng correlation id.
4. Chỉ dùng account `is_virtual=true` khi đó là bút toán không-tiền-thật.
5. Không có payout cho cá nhân/đối tác, không có refund/salary/commission/profit distribution.
6. Rule engine không có rule ưu tiên cao hơn ép duyệt.
7. Payload hash và idempotency key hợp lệ.

---

## 3. Phạm vi audit và threat model

### 3.1 Bề mặt đã kiểm tra

- Route guards trong `src/App.tsx`.
- Registry `src/lib/permissions.ts` và catalog `src/lib/permissionPages.ts`.
- `useMyPermissions`, `RequirePermission`, `AdminOnlyRoute`, staff/role hooks.
- RLS helpers, tenant-hardening migration, approval/recurring/termination RPC.
- Các đường ghi payment, voucher, salary, profit, refund, recurring, cancel/delete.
- ACL của functions, `SECURITY DEFINER`, Storage bucket/policies và Edge Function gates.
- Live counts và trạng thái dữ liệu tài chính.

### 3.2 Actor cần phòng thủ

| Actor | Khả năng giả định | Phải bị chặn |
|---|---|---|
| Anonymous | Có anon key công khai, gọi PostgREST/RPC/Storage trực tiếp | Mọi dữ liệu private và mọi mutation ngoài endpoint public allowlist. |
| Auth user mồ côi | Có JWT hợp lệ nhưng chưa membership | Không có tenant context, không quyền, không sentinel owner. |
| Staff tenant A | Biết UUID tenant B | SELECT/INSERT/UPDATE/DELETE/RPC/Storage của B. |
| Staff bị giới hạn scope | Có quyền module nhưng chỉ một building/cashbook | Không truy cập object ngoài scope. |
| Maker | Tạo expense | Mặc định không tự duyệt; chỉ ngoại lệ với phiếu chi thông thường trong hạn mức, sổ quỹ maker nắm giữ và có hậu kiểm. |
| Approver | Có approve nhưng không create/edit | Không sửa payload hoặc thay account trước khi duyệt. |
| Tenant owner | Full tenant control | Không thành platform super-admin; emergency phải có reason/audit. |
| Cổ đông/đối tác | Chỉ xem dữ liệu đã cấp | Không vào vận hành hoặc xem PII/financial ngoài share. |
| Client độc hại | Bỏ qua React, gọi REST/RPC song song/replay | Backend vẫn enforce permission, state, idempotency, amount. |
| Service/cron | Có service credential | Chỉ gọi internal RPC allowlist, có source identity và audit. |

### 3.3 Trust boundary

1. Browser và mọi dữ liệu do browser gửi là không tin cậy.
2. JWT chỉ chứng minh user id; JWT không tự chứng minh organization/scope nếu membership có thể đổi sau khi token phát hành.
3. `organization_id` truyền từ client chỉ là yêu cầu; server phải đối chiếu resource/membership.
4. RLS bảo vệ direct table API; RPC phải tự authorize và không dựa vào RLS ngầm khi `SECURITY DEFINER`.
5. Storage object path phải gắn org/resource và được policy kiểm tra qua DB metadata.

---

## 4. Hiện trạng live database

### 4.1 Snapshot bề mặt authorization [LIVE]

| Metric | Giá trị |
|---|---:|
| Public tables | 136 |
| Tables bật RLS | 136 |
| Tables `FORCE ROW LEVEL SECURITY` | 0 |
| RLS policies | 551 |
| Public-schema functions | 459 |
| `SECURITY DEFINER` functions | 246 |
| Functions anon có execute hiệu lực | 308 |
| `SECURITY DEFINER` + anon execute hiệu lực | **110** |
| Roles nghiệp vụ | 7 |
| Distinct `staff_id` qua assignment | 10 |
| Permission-relevant staff (`staff_id <> user_id`) | 8 |
| Distinct legacy assignment owners | 2 |
| Auth users rơi vào nhánh “orphan => owner sentinel” | **2** |

`FORCE RLS = 0` không tự là lỗ hổng với PostgREST role, nhưng nhấn mạnh rằng table owner/definer có thể bypass; vì vậy ACL và function body phải được audit riêng. Con số 10 staff ở bảng gồm self-assignment; body permission hiện hành loại `staff_id = user_id`, nên chỉ 8 principal là staff có ý nghĩa đối với nhánh này.

### 4.2 Trạng thái thu chi [LIVE]

Chỉ đếm row `deleted_at IS NULL`:

| Type | Status | Count | Thiếu `approved_by` |
|---|---|---:|---:|
| EXPENSE | APPROVED | 649 | **476** |
| INCOME | APPROVED | 1,016 | **1,015** |
| EXPENSE | UNAPPROVED | 17 | 0 |
| INCOME | UNAPPROVED | 3 | 0 |
| EXPENSE | CANCELLED | 59 | 0 |
| INCOME | CANCELLED | 90 | 0 |

Đây là snapshot `LIVE-20260712-A` tại timestamp ở đầu tài liệu, không phải backlog tĩnh. Hệ thống production vẫn phát sinh giao dịch; các lần tái kiểm trong cùng ngày cho thấy `INCOME/APPROVED` đã tăng dần từ 1,010 → 1,011 → **1,016** và số thiếu `approved_by` từ 1,009 → **1,015** (bảng trên đã cập nhật theo lần re-run mới nhất). Mỗi lần migration/cutover phải chụp lại count/hash/sum trong maintenance window, không dùng các số trên làm assertion cố định.

Ý nghĩa:

- Không được backfill `approved_by` bằng owner hoặc creator nếu không có bằng chứng; làm vậy sẽ giả mạo audit.
- Dữ liệu approved thiếu approver phải gắn provenance `LEGACY_IMPORTED`/`LEGACY_APPROVED_UNKNOWN`, không tạo decision giả.
- `UNAPPROVED` không đủ để phân biệt draft với pending approval; cần phân loại bằng nguồn, account, marker và review queue.

### 4.3 Storage [LIVE]

8 bucket đều `public=false`:

`customer-id-cards`, `customer-images`, `document-templates`, `income-expense-attachments`, `job-attachments`, `meter-images`, `payment-receipts`, `ui-references`.

Tuy nhiên private bucket **không đồng nghĩa tenant-private**. Cần tách hai nhóm policy thay vì suy rộng cho cả 8 bucket:

- Migration `20260601000200_sec_private_buckets.sql` đóng và tạo SELECT policy `TO authenticated` chỉ kiểm `bucket_id` cho đúng **7 bucket**: `customer-id-cards`, `customer-images`, `payment-receipts`, `income-expense-attachments`, `meter-images`, `job-attachments`, `ui-references`. Vì vậy một user đăng nhập bất kỳ có thể đọc object thuộc 7 bucket này ở organization khác nếu biết/list được path.
- `document-templates` không thuộc migration trên. Bucket này được tạo trong `016_document_templates.sql`; policy ban đầu giới hạn folder đầu tiên bằng `auth.uid()`. Policy SELECT hiện hành từ `20260510000012_contract_action_rpcs.sql` mở rộng sang owner hiện tại hoặc `current_visible_owner_ids()`, nên có **principal/folder scope theo owner và legacy tenant visibility**, không phải authenticated-wide chỉ theo bucket. Đây chưa phải resource scope theo template/contract cụ thể và vẫn dựa trên mô hình owner legacy, nên cũng chưa đạt organization/resource authorization mục tiêu.

Nhiều INSERT/UPDATE/DELETE policy lịch sử của các bucket khác cũng chỉ kiểm authenticated hoặc object owner, không kiểm organization/resource scope.

Catalog còn **4 policy** `room-sale-images` (`Authenticated upload/update/delete room sale images` + `Public view room sale images`) dù bucket này không nằm trong 8 bucket Supabase live (ảnh sale đang có hướng chuyển sang R2). Đáng lưu ý policy `Public view room sale images` cho **SELECT public**; nếu bucket được tạo lại nó sẽ mở đọc ảnh cho anon. Policy mồ côi không trực tiếp làm lộ object khi bucket không tồn tại, nhưng phải được inventory/cleanup để tránh bucket được tạo lại sau này và thừa hưởng policy rộng ngoài ý muốn.

### 4.4 Kết quả tái kiểm tra độc lập [LIVE/CODE]

Các số chính ở mục 4.1 đã được chạy lại trong `LIVE-20260712-A` và khớp: 136 bảng public/136 bật RLS, 551 policy, 459 function, 246 `SECURITY DEFINER`, 308 function anon-executable và 110 `SECURITY DEFINER` anon-executable. Live có 11 auth users; phép phân loại theo đúng body hiện tại của `get_my_permissions()` vẫn cho ra 2 user ở nhánh orphan. Definition/ACL live của `get_my_permissions`, `ai_copilot_perms_for`, `_internal_settlement_account`, `_termination_ensure_type`, `approve_voucher` và `unapprove_voucher` cũng khớp finding P0/P1 trong tài liệu. Storage được tái kiểm: 8 bucket đều private; 7 bucket có policy đọc authenticated-wide chỉ theo bucket, riêng `document-templates` có owner/legacy-visibility folder scope; 4 policy mồ côi `room-sale-images` vẫn còn.

Xác nhận thêm hai điểm quan trọng ở lần rà này (chạy lại `has_function_privilege` trên live):

- `_internal_settlement_account(uuid)` và `_termination_ensure_type(uuid,text,text)` **VẪN** `EXECUTE` được bởi cả `anon` và `authenticated`. Migration `20260710130500_revoke_internal_definer_grants.sql` đã thu hồi quyền `anon` cho một loạt helper definer khác nhưng **bỏ sót đúng 2 hàm P0 này** — xem mục 9.2.
- Logic fail-open orphan của `get_my_permissions()` bị **nhân bản** trong `ai_copilot_perms_for(uuid)` (`20260710200000_ai_copilot_backend.sql`), dùng ở đường `reserve_ai_usage`. Body cũng trả `{"__superadmin": true}` khi `v_perms IS NULL`. Sửa một hàm mà bỏ hàm kia thì bypass vẫn còn ở nhánh AI-copilot — xem mục 5.2.

Bằng chứng mới cần nhập vào scope triển khai:

- `src/hooks/usePayments.ts::useCreatePayment` vẫn insert payment rồi đọc/update invoice bằng request riêng, không lock/CAS và không kiểm lỗi update invoice.
- `src/hooks/useInvoices.ts::useCreateInvoice/useUpdateInvoice` tạo trực tiếp invoice `APPROVED`, ghi header/credit/items qua nhiều request; update xoá toàn bộ item rồi insert lại ngoài transaction.
- `src/hooks/useUpdatePaymentMethod.ts` đổi `income_expenses.account_id` trước rồi mới đổi `payments.payment_method`; lỗi request thứ hai tạo split-brain giữa payment và cashbook.
- `infra/cloudflare-worker/src/index.ts` chỉ gọi `/auth/v1/user` để xác minh “có đăng nhập”, sau đó cho `PUT /upload?key=...` với key tùy ý và trả `${R2_PUBLIC_BASE}/${key}`. Không có bucket allowlist, organization/resource authorization, size/MIME quota hay ownership metadata.
- `api/salary-v5-cron.js` kiểm job allowlist nhưng không kiểm request đi vào Vercel route; bất kỳ caller nào biết URL có thể kích hoạt job và server sẽ tự gắn `x-cron-secret` khi forward.

Kết luận audit hiện tại: **NO-GO cho production multi-tenant/approval cutover** và **GO WITH CHANGES cho Sprint 0** sau khi thêm containment R2/cron cùng các P0 đã biết.

---

## 5. Hiện trạng mô hình authorization

### 5.1 Identity và scope hiện tại [CODE]

```text
auth.uid()
  ├─ super_admins -> platform bypass
  ├─ staff_assignments(staff_id, user_id, role_id, building_id, area_id, permissions)
  │    ├─ roles.permissions JSONB
  │    ├─ building scope
  │    ├─ live area scope qua area_buildings
  │    └─ row null/null = full scope dưới legacy owner
  ├─ shareholders / building_shareholders
  └─ profit_managers / salary building mappings
```

Điểm mạnh:

- Migration `20260710150000_tenant_isolation_hardening.sql` đã biến zero-arg `is_admin()` thành alias của `is_super_admin()`.
- Full-scope được owner-bound trong `can_access_building`/`can_do_on_building`.
- `accessible_building_ids()` và `permitted_building_ids()` đã mở rộng area/full-scope theo owner.
- 82 policy `*_admin_all` toàn cục đã được drop.

Giới hạn cấu trúc:

- Không có `organizations`; `user_id` vừa là legacy owner, vừa audit actor tùy bảng.
- Assignment cụ thể có thể trỏ building của legacy owner khác; đây có thể là ủy quyền hợp lệ nhưng làm tenant inference mơ hồ.
- `can_access_org_entity(resource, action)` không có resource id/organization id; cần kết hợp owner graph ở từng policy.
- Role permission nằm trong JSONB không có FK tới registry permission; key typo/key cũ không được DB kiểm soát.
- `get_my_permissions()` lấy **assignment đầu tiên**, nên nhiều assignment khác role/permission không được union rõ ràng.
- Cùng một sentinel `__superadmin` đang biểu diễn platform super-admin và legacy owner UX.

### 5.2 Lỗ hổng fail-open của `get_my_permissions()` — P0

Definition cuối trong `20260701170000_shareholder_scope_split.sql`:

1. Super-admin => sentinel.
2. Staff => permission từ assignment đầu tiên.
3. Shareholder/profit manager => quyền giới hạn.
4. Nếu không có các identity trên => sentinel owner.

Nhánh 4 không kiểm user sở hữu organization/building nào. Live có 2 auth user khớp nhánh orphan. Tác động tối thiểu là bypass toàn bộ frontend `canUse`; tác động backend tùy policy/RPC cụ thể. Phải sửa thành fail closed:

```text
no active organization membership => {}
platform super-admin               => explicit platform sentinel
tenant owner                       => owner permissions scoped to selected org
```

**Bản sao fail-open phải sửa cùng lúc**: `ai_copilot_perms_for(uuid)` trong `20260710200000_ai_copilot_backend.sql` nhân bản y nguyên logic của `get_my_permissions()`, kể cả nhánh `v_perms IS NULL => '{"__superadmin": true}'`. Nó chạy trong `reserve_ai_usage` (đường AI-copilot), `GRANT` cho `service_role`. Nếu chỉ sửa `get_my_permissions` mà bỏ hàm này, orphan user vẫn được coi super-admin ở gate AI-copilot. Sprint 0 phải fix đồng thời hai hàm, **hoặc** refactor cả hai gọi chung một hàm nguồn (single source of truth) để không drift lần nữa — comment trong chính migration đã cảnh báo "phải giữ đồng bộ cả 2 nơi".

### 5.3 Frontend guards

- `ProtectedRoute`: xác thực session, không authorization.
- `RequirePermission`: `get_my_permissions()` -> `canUse(module, action)`; redirect khi deny.
- `AdminOnlyRoute`: gọi `is_admin()`; sau hardening hiện tương đương platform super-admin, nhưng tên gây hiểu nhầm.
- Sidebar hiding là UX, không phải security.
- Cache permission 5 phút (`useMyPermissions`) có thể để quyền vừa bị thu hồi còn hiển thị; backend bắt buộc fail closed. Sau mutation role/membership phải invalidate hoặc dùng realtime/version.

### 5.4 Permission registry

`src/lib/permissions.ts` khai báo khoảng 40 module và hơn 100 action. File tự ghi rõ RLS chủ yếu enforce CRUD và một số action cũ; action chi tiết mới phần lớn là frontend gate. `permissionPages.ts` còn fallback key chi tiết sang quyền legacy rộng hơn, ví dụ `contracts.terminate -> contracts.edit`.

Fallback cần có thời hạn. Khi cutover:

1. Materialize mọi permission key mới cho mọi role/member.
2. Chạy report key thiếu/key mồ côi.
3. Tắt fallback frontend.
4. Backend dùng normalized permission definitions, không dùng fallback.

---

## 6. Route inventory và route-level gate

Mọi route dưới đây có `ProtectedRoute`; action bỏ trống nghĩa là `.view`.

### 6.1 Quick access, dữ liệu, khách hàng

| Route | Gate hiện tại | Ghi chú/rủi ro |
|---|---|---|
| `/` | Auth-only | Dashboard data phải tự scope; thiếu `dashboard.view` route gate. |
| `/dashboard` | Auth-only | Như trên. |
| `/building-map` | `buildings.view` | Hợp lý nếu query RLS cùng scope. |
| `/notifications` | `notifications.view` | Notification phải recipient-scoped. |
| `/chat-zalo` | `chat_zalo.view` | Send/automation/template phải backend action riêng. |
| `/buildings`, `/buildings/:id` | `buildings.view` | Button create/edit/delete cần DB action tương ứng. |
| `/apartments`, `/apartments/:id` | `rooms.view` | Object building scope bắt buộc. |
| `/services` | `services.view` | Org-global entity phải có org id. |
| `/sale-phong` | `sale_phong.view` | Các action token/image/deposit/analytics chi tiết cần RPC/policy riêng. |
| `/assets` | `assets.view` | Nullable building rows là điểm nhạy cảm. |
| `/materials` và 3 tab con | `materials.view` | Purchase/usage/adjustment cần action/backend riêng. |
| `/leads` | `leads.view` | Convert/export không được chỉ FE. |
| `/deposits` | `deposits.view` | Convert/refund là elevated mutation. |
| `/contracts`, `/contracts/:id` | `contracts.view` | Approve/terminate/transfer/renew phải RPC state machine. |
| `/customers`, `/customers/:id` | `customers.view` | PII + Storage phải cùng object scope. |
| `/customers/new` | `customers.create` | — |
| `/customers/:id/edit` | `customers.edit` | — |
| `/customers/:id/ct01` | `customers.print` | Print là data read/export nhạy cảm. |
| `/vehicles` | `vehicles.view` | — |

### 6.2 Tài chính, công việc và báo cáo

| Route | Gate hiện tại | Ghi chú/rủi ro |
|---|---|---|
| `/meter-readings` | `meter_readings.view` | Bulk/approve RPC hiện cần hardening action. |
| `/thu-tien` | `thu_tien.view` | `collect/undo/report` cần backend; fallback legacy từ invoice payment. |
| `/invoices`, `/invoices/:id` | `invoices.view` | Approve/cancel/record_payment cần RPC riêng. |
| `/invoices/print/:id` | `invoices.print` | — |
| `/income-expense`, voucher detail | `income_expenses.view` | Financial mutation không được direct table. |
| `/income-expense/print/:id` | `income_expenses.print` | — |
| `/finance/refund-log` | `deposits.view` | Refund visibility nên là `deposits.refund`/audit read riêng. |
| `/tasks` | `tasks.view` | Complete/approve cần backend. |
| `/my-day` | Auth-only | Self scope phải backend-enforced. |
| `/reports/coverage` | `AdminOnlyRoute` | Hiện platform-super only; nếu là owner report phải đổi tenant permission. |
| `/reports/real-estate` | `reports_real_estate.view` | — |
| Các report BĐS con | action từng report | `vacant_rooms`, `expiring`, `renewals_transfers`, `occupancy`, `promotions`, `new_leases`, `terminations`, `expense_ratio`. |
| `/reports/finance` | `reports_finance.view` | Financial aggregation phải scope ở SQL/RPC, không lọc sau ở client. |
| Các report tài chính con | action từng report | `daily_cashbook`, `cash_flow`, `payment_schedule`, `overpayment`, `deposits_report`, `analysis`, `handover_report`, `collection_cycle`. |
| `/reports/finance/profit-distribution` | Auth-only, gate trong page | Cần route gate + backend shareholder/member scope. |
| `/finance/personal-wallet` | `personal_finance.view` | Self-only hoặc explicit shared scope. |
| `/finance/salary` | Auth-only, page tự rẽ | Cần `salary.view/manage_*` server-side và self-view tách biệt. |
| `/finance/my-salary` | Auth-only | Chỉ self row; không dựa vào staff id từ client. |

### 6.3 Settings/admin/account

| Route | Gate hiện tại | Ghi chú/rủi ro |
|---|---|---|
| `/admin/users` | `AdminOnlyRoute` | Platform super-admin; tenant staff lifecycle cần route/RPC riêng. |
| `/settings/general` | `settings.view` | Update yêu cầu `settings.edit`. |
| `/settings/ai-copilot` | Auth-only, internal gate | LLM proxy có entitlement/permission/quota server gate; admin config vẫn phải org/platform scoped. |
| `/settings/categories` và bank/general/floors/IE types/templates | `categories.view` | CRUD cần action cụ thể. |
| `/settings/categories/auto-debt` | `auto_debt.view` | — |
| `/settings/categories/service-quotas` | `service_quotas.view` | — |
| `/settings/meters` | `meters.view` | — |
| `/finance/cashbooks` | `cashbooks.view` | `share` và cashbook scope đặc biệt. |
| Suppliers/warehouses/asset-types | module `.view` | — |
| Asset movement/maintenance | `assets.view` | `move/maintain` chỉ FE nếu không RPC action. |
| Hotline/task-types | module `.view` | — |
| Templates/signatures | `templates.view` | — |
| `/settings/staff` | `users.view` | Create/edit/delete/manage_templates phải backend. |
| Profile/subscription/FAQ/changelog/guide | Auth-only | Profile self; subscription owner/billing; nội dung tĩnh không nhạy cảm. |

### 6.4 Public routes cần giữ allowlist hẹp

| Route | Backend boundary yêu cầu |
|---|---|
| `/c/:code` | Public code entropy/rate limit; trả DTO tối thiểu, không contract UUID traversal. |
| `/r/:token`, `/phongtrong` | Token revocation/expiry; chỉ room fields công khai; event logger rate-limit/schema limit. |
| Auth routes | Signup phải invite/admin controlled; reset token chuẩn Supabase. |

Aliases/redirects không tạo permission boundary mới; route đích phải là canonical source of truth.

---

## 7. Action-to-backend enforcement matrix

Ký hiệu:

- **B**: có backend concept/policy/RPC tương đối rõ.
- **P**: partial — CRUD/RLS rộng hơn action chi tiết hoặc còn đường bypass.
- **F**: chủ yếu frontend/catalog; chưa có backend action tương đương được chứng minh.
- **A**: auth/self special scope.

| Module | Actions trong registry | Hiện trạng | Target permission keys/backend boundary |
|---|---|:---:|---|
| `dashboard` | view, view_finance | P | `dashboard.view`, `dashboard.view_finance`; mọi aggregate nhận org context server-side. |
| `notifications` | view, delete | B | Recipient/self + admin broadcast riêng. |
| `ai_copilot` | view, ui_control | B/P | Giữ entitlement + `ai_copilot.view/ui_control`; tool call phải re-authorize từng action. |
| `chat_zalo` | view, send, manage_automation, manage_templates | P/F | RPC/Edge check mỗi action và organization channel. |
| `areas` | CRUD | B | Normalized permission + org FK. |
| `buildings` | CRUD | B | `building_id` resolver + org FK. |
| `rooms` | CRUD | B | Scope theo building. |
| `services` | CRUD | B/P | Org-global entity, không owner graph. |
| `sale_phong` | view, manage_tokens/settings/images, edit_floor_plan, manage_pass_listings, create_deposit, view_analytics | F/P | Endpoint riêng từng mutation; public token owner org. |
| `leads` | CRUD, convert, export | P/F | Convert transaction + export permission server-side. |
| `deposits` | CRUD, convert, refund, print | P/F | State-machine RPC; refund luôn approval. |
| `contracts` | CRUD, approve, renew, transfer, terminate, handover, print, export | P | RPC đã có một số guard; bỏ fallback `terminate -> edit`; enforce action chính xác. |
| `customers` | CRUD, import, print, export | P/F | Import/export backend jobs, PII audit. |
| `vehicles` | CRUD | B/P | Scope qua customer/contract/building + org. |
| `cashbooks` | CRUD, share | P | Account scope normalized; share = binding, không ACL rời mơ hồ. |
| `meter_readings` | CRUD, export | P | Bulk/approve cần can_do từng building và revoke anon. |
| `invoices` | CRUD, approve, cancel, record_payment, print, export | P | Chỉ transactional RPC cho approve/cancel/payment; direct writes bị khóa. |
| `thu_tien` | view, collect, undo, report | F/P | Map backend tới `invoice.payment.collect/reverse/report`. |
| `income_expenses` | CRUD, approve, cancel, print, export, all_buildings, restricted_create/view | P | Request/post/reverse RPC; category sensitivity; scope resolver. |
| `excess_amounts` | CRUD | P | Chỉ được tạo/consume bởi payment/refund RPC. |
| `shareholder_profit` | view, lock, unlock, distribute, manage_shareholders, export | P/F | Lock/distribute RPC; shareholder self-view DTO; distribute luôn approval. |
| `salary` | view, lock, unlock, distribute, manage_salary, export | P/F | Server state machine; payout luôn approval; self-view permission riêng. |
| `personal_finance` | CRUD | P | Self wallet scope hoặc explicit grant. |
| `assets` | CRUD, move, maintain | P/F | Object action + org/building scope. |
| `materials` | CRUD | P | Tách `purchase/use/adjust`; atomic stock RPC. |
| `asset_types`, `warehouses`, `suppliers` | CRUD | B/P | Org-scoped config. |
| `tasks` | CRUD, complete, approve | P/F | Assignee/self và approver tách biệt. |
| `task_types` | CRUD | B/P | Org config. |
| `reports_real_estate` | view, từng report, export | F/P | RPC report kiểm exact key; không chỉ parent view. |
| `reports_finance` | view, từng report, reconcile, collection_cycle, export | F/P | Exact key + cashbook/building scope; reconciliation mutation RPC. |
| `meters`, `service_quotas`, `auto_debt`, `hotline`, `categories`, `templates`, `settings` | CRUD hoặc view/edit | B/P | Org FK + normalized key. |
| `users` | CRUD, manage_templates | P | Membership lifecycle RPC; không direct assignments/profile/auth mutation. |

**Cutover gate**: mọi action `elevated` và mọi mutation phải có backend permission key chính xác. Không được giữ action “elevated” chỉ làm button gate.

---

## 8. Financial write-path audit

### 8.1 Các đường frontend chính

| Source | Thao tác hiện tại | State/tác động | Vấn đề | Target |
|---|---|---|---|---|
| `income-expenses/mutations.ts::useCreateIncomeExpense` | Direct insert voucher rồi items | Voucher dùng DB default lịch sử `APPROVED` | Không atomic; item lỗi để voucher rỗng; approval bypass | `create_financial_draft` atomic, DRAFT only; `submit_financial_request` mới chuyển sang PENDING_APPROVAL/POSTED/DENIED. |
| `useUpdateIncomeExpense` | Header update, delete items, reinsert | Comment nói chỉ UNAPPROVED nhưng query không có CAS status | Có thể mất items/partial; không DB state guard | `update_financial_draft(expected_version)` atomic. |
| `useQuickUpdateIncomeExpense` | RPC quick update | Sửa account/attachment/note | Phải cấm đổi posted payload/account | Giữ RPC nhưng state+permission+version guard. |
| `statusMutations::useApproveVoucher` | `approve_voucher` | UNAPPROVED -> APPROVED | Creator hiện được tự duyệt qua `ie.user_id=auth.uid()`; không rule request | Thay `decide_financial_approval`; maker-checker. |
| `useUnapproveVoucher` | APPROVED -> UNAPPROVED | Gỡ cash effect | Phá audit/ledger finality | Bỏ; dùng `reverse_financial_posting`. |
| `useCancelIncomeExpense` | Direct status update, rồi delete payment | Voucher/payment hai request | Partial failure; bypass state/action; mất payment | `cancel_or_reverse_voucher` atomic, giữ tombstone/event. |
| `useRestoreIncomeExpense` | RPC restore | CANCELLED -> APPROVED, có thể recreate payment | Super-admin only nhưng khôi phục tiền trực tiếp | Chỉ migration/support repair có audit; user dùng reversal mới. |
| `useBulkRecordPayment` | Loop direct payment + voucher APPROVED + item + excess | Tác động invoice/cashbook ngay | Mỗi line nhiều transaction; replay/partial/race; direct APPROVED | `record_invoice_payments_bulk` với mỗi invoice atomic, idempotency key và item result rõ. |
| `useInvoicePayments::useRecordPaymentRPC` | RPC tạo payment, sau đó client mirror voucher APPROVED/items | Payment và ledger mirror tách transaction | RPC thành công/mirror lỗi; retry/duplicate; approval bypass | RPC duy nhất tạo payment+voucher+items+credit. |
| `usePayments::useCreatePayment` | Direct payment rồi read-modify-write `invoices.paid_amount/status` | Payment và invoice là hai request; update invoice không check error | Lost update khi hai collector chạy song song; payment có thể tồn tại nhưng invoice chưa cập nhật | Xoá/khóa hook legacy; mọi caller dùng `record_invoice_payment_atomic`. |
| `useInvoices::useRecordPayment` (legacy, ~dòng 1272) | **Bản sao thứ hai** của anti-pattern trên: insert payment → SELECT invoice riêng → UPDATE `paid_amount/status/paid_date` riêng | Ba request rời | Update cuối **không check lỗi**, không CAS; lost update như `useCreatePayment` | Cùng target `record_invoice_payment_atomic`; xoá/khóa hook legacy này luôn. |
| `useInvoices::useCreateInvoice` | Direct invoice `APPROVED`, optional credit, rồi items | Header/credit/items là 2–3 transaction | Invoice rỗng/credit đã tiêu nhưng item lỗi; creator tự đặt approver metadata | `create_invoice_atomic`: invoice+credit+items cùng transaction. Mặc định server tạo `APPROVED`; cài đặt `auto_approve_invoice` cho phép tắt để tạo `DRAFT`. Server tự ghi actor/config provenance, client không tự đặt approver metadata. |
| `useInvoices::useUpdateInvoice` và `invoiceHelpers`/`useContracts` | Update header, delete items, insert lại; một số helper tự tạo invoice/items | Cho sửa cả `APPROVED` chưa thu nhưng không CAS/transaction/audit revision | Partial item loss, total/header lệch lines, duplicate invoice/event; kế toán/owner không thấy rõ nội dung trước–sau | `revise_invoice(expected_version, reason)` atomic; server recompute total. Nhân viên có `invoices.edit_approved_unpaid` được sửa invoice `APPROVED` khi `paid_amount=0` và không có payment hiệu lực; invoice giữ `APPROVED`, tăng revision, lưu snapshot/diff/actor/reason/time và vào hàng hậu kiểm cho kế toán/owner. Invoice đã từng thu rồi hoàn tác dùng correction flow riêng, không quay lại đường sửa thông thường. |
| `useUpdatePaymentMethod` | Đổi account của voucher rồi đổi payment method | Hai update tách rời | Split-brain payment/cashbook; resolver match tên có thể chọn nhầm account | `change_payment_method_atomic`, derive account từ invoice org/building và authorize cashbook. |
| `useUploadPaymentReceipt` / `useUpdateInvoiceNote` | Direct update payment/voucher/invoice metadata | Nhiều request khi mirror attachment | Metadata có thể lệch; Storage URL có thể ngoài scope | RPC metadata hẹp, state/version guard; attachment org/resource-bound. |
| `useRecordRefundRPC` | Direct EXPENSE APPROVED + item; tự tạo category | Chi hoàn thanh lý ngay | Refund phải luôn approval; non-atomic | `request_settlement_refund`. |
| `useDeletePayment` | Soft-delete voucher + hard-delete payment | Rollback collection | Mất provenance/partial | `reverse_invoice_payment`, không hard delete. |
| `useManagerSalary::useLockSalaryMonth` | Direct approve commission vouchers, lock/snapshot | Commission được auto-approve bởi người lock | Maker/rule bypass; nhiều write non-atomic | `lock_salary_period` chỉ snapshot; commission/payout request riêng. |
| `useSalaryPayout` | Direct EXPENSE voucher/items; optional payment + INCOME APPROVED; salary paid update | Chi lương/cấn phòng | Nhiều write; default approval; partial state | `request_salary_payout`, approval post atomically cùng salary/payment effects. |
| `income-expenses/specialized.ts` | Direct profit/salary EXPENSE voucher/items | DB default có thể APPROVED | Luôn cần approval nhưng bypass | `request_profit_distribution` / `request_manager_payout`. |
| `income-expenses/batch.ts` | Batch create/cancel trực tiếp | Nhiều voucher | Partial/cancel bypass | Batch RPC với item-level result + idempotency. |
| `copilot/tools/writeTools.ts` | Tạo UNAPPROVED draft | Chưa post tiền | Pattern tốt hơn nhưng AI vẫn không được tự submit/approve | AI chỉ tạo DRAFT, actor/source/audit rõ. |
| `useMeterReadings` | Có đường insert trực tiếp `status='APPROVED'`, approved_by=caller; hỗ trợ unapprove | Chỉ số là đầu vào sinh hoá đơn | Có thể sửa/duyệt input tính tiền mà không qua exact action/state machine | RPC bulk/approve immutable theo kỳ; invoice snapshot reading version. |
| `useAccounts::useCreateAccount/useUpdateAccount` | Direct INSERT/UPDATE `accounts`, gồm `initial_amount`, `initial_date`, `user_id` | Tạo hoặc hồi tố số dư đầu kỳ ngoài ledger | Thay đổi tồn quỹ không posting/approval/version/audit; đổi owner làm scope mơ hồ | `create_cashbook` với số dư 0 + `request_opening_balance_adjustment`; metadata RPC cấm sửa balance/owner. |
| `useAccounts::useLockAccount/useUnlockAccount/useDeleteAccount` | Direct đổi `lock_date` hoặc soft-delete sổ | Mở/đóng kỳ và ẩn cashbook | Không exact action/reason/CAS; có thể mở lại kỳ hoặc ẩn sổ còn số dư/posting | `lock_cashbook_period`, `unlock_cashbook_period`, `archive_cashbook`; reason, expected version, reconcile và dependency guard. |
| `GenerateInvoiceDialog::onSubmit` | Insert meter reading `APPROVED`, nuốt lỗi, sau đó gọi create invoice riêng | Chỉ số và phải thu tách transaction | Reading orphan hoặc invoice dùng chỉ số không lưu; client tự duyệt cả reading/invoice | `generate_meter_reading_and_invoice` atomic, idempotent; server pricing + reading version snapshot. |
| `invoices/useExcelInvoiceData::useSubmitExcelInvoices` | Loop từng phòng: direct reading `APPROVED` rồi create invoice | Batch lập hóa đơn theo tòa có thể thành công một phần | Retry có thể tạo kết quả trùng hoặc chỉ xử lý được một phần tòa nhà; có invoice không reading hoặc ngược lại | Chuẩn hóa giao kèo kết quả cho từng phòng + idempotency; mỗi room atomic, có batch run/reconciliation. |
| `contract-form/useContractSubmit::onSubmit` | Contract/customer/service/first invoice, nhiều phiếu cọc, flip deposit và mở commission qua chuỗi request | Kích hoạt HĐ và nhiều ledger/state effect | HĐ ACTIVE nhưng thiếu cọc/invoice; deposit chưa CONVERTED; partial rows | `submit_contract` transaction cho core graph + transactional outbox cho commission/notification/document; mọi handler idempotent. |
| `QuickDepositModal::submit` / `CreateDepositDialog::onSubmit` | Ensure type/account RPC, direct voucher rồi item; dialog đầy đủ còn có thể insert `tenants` trước | Phiếu giữ chỗ được DB default APPROVED, trigger reserve room | Tenant/voucher/item/room state có thể split; UI gate không thay backend; default approval bypass | `create_reservation_deposit` atomic, exact permission, server-resolved type/account, rule evaluation và idempotency. |

#### 8.1.1 Vòng đời status ở cấp INVOICE (bổ sung — song song approval cấp voucher)

Bảng trên tập trung vào `income_expenses` (voucher). Nhưng `invoices` có **state machine riêng** với `status` và `approved_by/approved_at`, và client đang ghi trực tiếp qua một loạt hook trong `src/hooks/useInvoices.ts` chưa được liệt kê. Approval cấp invoice phải được xử lý **tách bạch** khỏi approval cấp voucher (hóa đơn được duyệt ≠ tiền đã thu).

**Quyết định nghiệp vụ 2026-07-15:** hóa đơn mới mặc định là `APPROVED` để giữ tốc độ vận hành hiện tại. Setting tổ chức `auto_approve_invoice` cho phép bật/tắt; khi tắt, hóa đơn mới là `DRAFT` và cần `invoices.approve`. Setting chỉ quyết định outcome phía server: client không được tự đặt `approved_by/approved_at`. Mọi cách tạo hóa đơn — form đơn, batch tháng, hợp đồng, công tơ — phải đi cùng contract này thay vì tự hard-code status.

**Sửa hóa đơn `APPROVED` chưa thu:** nhân viên quản lý có permission `invoices.edit_approved_unpaid` được sửa khi và chỉ khi `paid_amount = 0`, không có payment hiệu lực và invoice chưa bị cancel/reverse. RPC phải lock invoice, kiểm lại payment ledger trong transaction, nhận `expected_version` và `reason`, ghi revision append-only gồm snapshot/diff trước–sau, actor, thời gian, source và tổng cũ/mới; sau đó tăng version và server recompute total. Invoice vẫn mang trạng thái `APPROVED` nhưng có cờ/revision hiển thị cho kế toán/owner và xuất hiện trong hàng hậu kiểm. Invoice đã từng có payment rồi được hoàn tác không được coi như “chưa từng thu”; correction phải đi flow riêng để tránh viết lại lịch sử đã đối soát.

| Hook (dòng) | Thao tác | Vấn đề | Target |
|---|---|---|---|
| `useApproveInvoice` (~928) / `useBulkApproveInvoices` (~1028) | Direct UPDATE `invoices.status='APPROVED'` + approver metadata | Client tự đặt approver; không cùng contract setting | RPC `approve_invoice`, permission `invoices.approve`; no-op/idempotent nếu đã auto-approved. |
| `useUnapproveInvoice` (~978) | APPROVED → chưa duyệt | Có thể làm mất finality, đặc biệt khi đã có payment/AR | Chỉ cho đưa về `DRAFT` qua RPC nếu **chưa từng có payment hiệu lực**, có reason/audit/revision và permission riêng; nếu đã có payment thì dùng correction/cancel/reversal phù hợp, không unapprove tự do. |
| `useCancelInvoice` (~1602) / `useForceCancelInvoice` (~1568, RPC `super_admin_force_cancel_invoice`) | Đổi status CANCELLED | Cancel bypass state/side-effect (payment, AR, cọc) | RPC cancel atomic; force-cancel chỉ support-repair có audit. |
| `useRestoreInvoice` (~1513) | CANCELLED → APPROVED | Khôi phục trực tiếp, có thể tái tạo hiệu ứng | Chỉ restore khi invariant cho phép và lưu revision/audit; trường hợp đã có tác động tiền dùng repair/reversal có kiểm soát. |
| `useCheckOverdueInvoices` (~1172) | Bulk UPDATE `status` (quá hạn) | Bulk status write không qua action riêng | RPC/job idempotent, không client bulk-write. |

#### 8.1.2 Đường ghi money-ledger phụ chưa liệt kê (gom vào Sprint 5 khi revoke direct DML)

- `src/lib/invoiceHelpers.ts:747` — sinh HĐ tháng tự động, `status = settings.auto_approve ? 'APPROVED' : 'DRAFT'` + `invoice_items` insert riêng → **non-atomic và client/helper tự quyết định status**. Target giữ setting auto-approve nhưng chuyển việc đọc setting, tạo status/provenance và insert header+items vào RPC server atomic.
- `src/hooks/useContracts.ts:651` — HĐ tháng đầu khi tạo hợp đồng, insert trực tiếp `invoices` với `status:'APPROVED'` + items → direct-approved, non-atomic và bỏ qua setting. Target dùng cùng invoice-create contract server-side; mặc định approved chỉ khi setting bật. (Đây là **insert `invoices` duy nhất** trong file; các chỗ ~1032/1261/1717 là SELECT `invoices`, còn ~1391 là UPDATE `contract_terminations` — không phải insert hoá đơn.)
- `src/hooks/useContractOperations.ts:270` — INSERT trực tiếp `excess_amounts` (row âm) để consume credit/cọc → ghi thẳng ledger cọc/thừa, không qua RPC.

Ba đường này phải nằm trong allowlist revoke direct DML ở Sprint 5 cùng nhóm invoice/payment, nếu không sẽ là lỗ hở còn lại sau khi khoá các hook chính.

#### 8.1.3 Phạm vi revoke DML phải sinh từ catalog write path, không từ danh sách tay

Các hàng mục 8.1–8.1.2 là bằng chứng tối thiểu, chưa được coi là danh sách đóng. Trước Sprint 5 phải inventory bằng AST/grep + runtime audit mọi `.insert/.update/.upsert/.delete`, REST/fetch, RPC, trigger, Edge/cron/worker chạm `accounts`, invoice/payment/credit/deposit, meter reading, voucher/items, salary/profit và room/contract state. Đặc biệt:

- Không khóa chỉ `income_expenses.approval_status`; phải khóa cả opening balance, lock/archive cashbook, invoice/meter approver metadata, totals, credit/excess và parent/child items.
- Trigger tạo side effect không biến chuỗi request client thành atomic; transaction chỉ bao phủ một statement/request.
- Gate Sprint 5 phải có generated allowlist “table/column → canonical writer”, test direct REST deny và log mọi legacy writer còn gọi; grep không thấy chuỗi `APPROVED` là cần nhưng chưa đủ.

### 8.2 Các đường SQL/RPC đặc biệt

| RPC/nguồn | Hành vi hiện tại | Nhận định/target |
|---|---|---|
| `record_invoice_payment_v2` | Payment atomic trong RPC, FE mirror voucher ngoài RPC | Mở rộng RPC thành source of truth đầy đủ; revoke direct writes. |
| `approve_voucher` | Account bắt buộc; creator/super/can_do approve | Bỏ creator bypass; resolve approval request/rule/scope; post một lần. |
| `pay_draft_fee_voucher` | Set account+attachments rồi gọi approve trong transaction | Atomic tốt; nhưng account guard chỉ `user_id=auth.uid OR is_admin/super`; không dùng shared/scope đúng. Thay bằng `authorize(cashbooks.post, account)`. |
| `generate_recurring_vouchers` | Parent auto mode tạo APPROVED hoặc UNAPPROVED child | Cron/internal helper hiện exposed quá rộng; child phải qua rule engine. `repeat_auto_approve` chỉ là input, không quyết định cuối. |
| Utility payment RPC | Tạo expense khi đóng điện/nước | Nên tạo request; source `utility`; rule/category quyết định, không direct approved. |
| Termination move-out/forfeit | Tạo invoice/payment, cặp nội bộ, refund draft hoặc receipt | Giữ một transaction nhưng tách internal balanced auto-post và external refund/receipt request. RPC wrapper phải authorize contract action. Internal helpers không callable client. |
| Cash handover | Tạo voucher bàn giao/nhận | Handover là transfer có giver/receiver acceptance; state machine + same-team/scope, không hai direct vouchers độc lập. |
| Opening adjustment | Tạo adjustment voucher | Elevated `cashbooks.adjust_balance`; reason/evidence bắt buộc, luôn approval hoặc owner policy riêng. |
| Profit lock/distribution | Lock allocation và chi | Lock dữ liệu không đồng nghĩa cash paid; distribution request luôn approval/post riêng. |

### 8.3 Invariant tài chính mục tiêu

1. Client không có quyền INSERT/UPDATE `POSTED`, `approved_by`, `approved_at`, posting totals.
2. Một business event có một `correlation_id`; mọi payment/voucher/item/posting liên quan commit hoặc rollback cùng nhau.
3. Mỗi endpoint có unique `(organization_id, operation, idempotency_key)`.
4. Mỗi approval request được post tối đa một lần (`posted_event_id UNIQUE`).
5. Posted financial payload không sửa; correction bằng giao dịch đối ứng liên kết original. Riêng invoice `APPROVED` chưa từng có payment được phép revision theo contract mục 8.1.1 vì invoice là khoản phải thu, chưa phải payment/ledger đã post.
6. Account phải cùng organization và caller có `cashbooks.post` trên account ở thời điểm post. Ngoại lệ phiếu `PENDING_APPROVAL` được phép chưa chọn account; approver/kế toán phải chọn account được phép và bổ sung ảnh chứng từ trước final post.
7. Khi maker chọn sổ quỹ lúc tạo **bất kỳ phiếu chi nào**, account đó phải thuộc tập sổ quỹ membership maker nắm giữ; maker không được chọn sổ của người khác rồi gửi chờ duyệt. Thay vào đó maker có thể để trống account cho phiếu sẽ chờ duyệt, để kế toán/owner chọn account họ được phép post ở bước final decision. Ngoại lệ maker tự duyệt chỉ áp dụng cho phiếu chi thông thường dưới hạn mức, không force-approval và bắt buộc hậu kiểm; phiếu không có account hoặc account do approver chọn không đủ điều kiện self-approve.
8. Amount/category/account/rule snapshot được lock trước decision (`FOR UPDATE`, version compare); việc approver bổ sung account/ảnh phải tạo submission version/snapshot cuối có audit trước khi quyết định.
9. Invoice `paid_amount/status` được recompute trong cùng transaction hoặc từ immutable payment ledger, không dựa vào chuỗi client.
10. Internal transfer phải net zero và hai chân cùng correlation; trigger deferred kiểm cân bằng trước commit.
11. Audit event ghi actor, effective membership, source, request id, rule version, old/new state, reason và trace id.
12. Invoice total phải được server derive/reconcile từ versioned lines; client không được tự ghi `total_amount`, `paid_amount`, `remaining_amount` như nguồn sự thật. Revision invoice approved-unpaid lưu diff/snapshot trước–sau và hàng hậu kiểm.
13. Đổi payment method/account, thêm receipt và correction metadata phải là RPC hẹp có state/version guard; không coi “chỉ sửa metadata” là an toàn để direct update.
14. Mọi posting/giao dịch đối ứng/payment/transfer/adjustment/repair phải gọi cùng một `assert_cashbook_period_open` cho **tất cả account legs** và effective date server-derived; không chỉ kiểm `income_expenses.account_id`. Archive cấm posting mới, yêu cầu zero/reconciled balance, không pending request và đã gỡ mọi default/reference hoạt động.

---

## 9. SECURITY DEFINER, ACL và RPC attack surface

### 9.1 Live facts

- 110 `SECURITY DEFINER` functions anon có `EXECUTE` hiệu lực.
- Trong đó 36 là trigger functions; việc cấp execute cho anon vẫn không cần thiết.
- 54 bodies có từ khóa write; 33 là non-trigger callable write bodies.
- Heuristic catalog tìm thấy 9 callable write bodies không có `auth.uid`, scope guard hoặc role guard trực tiếp:
  - `_internal_settlement_account(uuid)`
  - `_termination_ensure_type(uuid,text,text)`
  - `ie_recompute_commission_kind(uuid)`
  - `log_public_room_events(text,jsonb)` — đây là public endpoint có chủ đích nhưng vẫn cần token/rate/schema limits
  - `recompute_contract_deposit_paid(uuid)`
  - `recompute_ie_business_result(uuid)`
  - `recompute_invoice_for_id(uuid)`
  - `recompute_material_stock(uuid)`
  - `recompute_room_reservation(uuid)`

Heuristic không phải chứng minh khai thác; callee có thể dựa vào dữ liệu/token hoặc chỉ recompute. Nhưng default phải là revoke, rồi allowlist endpoint công khai có test.

### 9.2 Hai P0 đã xác minh từ body

| Function | Vấn đề |
|---|---|
| `_internal_settlement_account(p_user_id)` | Nhận UUID tùy ý, tìm/update hoặc insert `accounts` cho UUID đó; không auth/object guard. `SECURITY DEFINER` + anon execute. |
| `_termination_ensure_type(p_user_id,p_type,p_name)` | Nhận legacy owner UUID tùy ý, insert `income_expense_types`; không auth/object guard. `SECURITY DEFINER` + anon execute. |

**Đã có sẵn pattern revoke — chỉ thiếu đúng 2 hàm này.** Migration `20260710130500_revoke_internal_definer_grants.sql` đã thu hồi quyền `anon` cho 6 hàm definer khác, theo **hai kiểu**:

- Internal-only (revoke cả `authenticated`): `generate_recurring_vouchers`, `seed_commission_expense_types` — `REVOKE ALL ... FROM PUBLIC, anon, authenticated`.
- Chặn `anon` nhưng giữ `authenticated`: `is_user_super_admin`, `v5_building_reqs`, `v5_checklist_for_building`, `get_income_expense_history` — `REVOKE ... FROM PUBLIC, anon` rồi `GRANT EXECUTE ... TO authenticated`.

Nhưng migration **bỏ sót** `_internal_settlement_account` và `_termination_ensure_type`. Live re-check xác nhận cả hai **vẫn** `EXECUTE` được bởi `anon` **và** `authenticated`. Vì đây là helper internal-only (chỉ gọi trong RPC cha), chúng phải theo **kiểu thứ nhất** (revoke cả `authenticated`). Đây là *thêm 2 dòng vào cùng pattern có sẵn*, không phải xây mới.

Hai helper này phải trở thành internal-only:

```sql
REVOKE ALL ON FUNCTION public._internal_settlement_account(uuid)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._termination_ensure_type(uuid,text,text)       FROM PUBLIC, anon, authenticated;
-- Chỉ wrapper đã authorize gọi nội bộ; nếu Postgres ownership cho phép, đặt
-- trong schema private không exposed bởi PostgREST và grant cho service role hẹp.
```

Lưu ý: hai hàm này chỉ được gọi bên trong RPC cha `SECURITY DEFINER` (chạy dưới owner) nên REVOKE không phá luồng hợp lệ — đúng lý do migration `20260710130500` đã dùng cho các hàm kia. **Cảnh báo `CREATE OR REPLACE`**: nếu sau này hai hàm bị recreate, ACL sẽ reset về default (PUBLIC execute); phải re-REVOKE và thêm CI gate (mục 9.3 điểm 9) để bắt regress.

### 9.3 Chương trình hardening bắt buộc

1. Export catalog đầy đủ: identity args, owner, `prosecdef`, `proconfig`, ACL, dependencies, definition hash.
2. `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon` trong staging; sau đó grant allowlist theo signature.
3. Không grant trigger/helper/recompute/internal implementation cho client roles.
4. Public RPC phải có `auth.uid() IS NOT NULL`, exact action, resource org/scope, state/version checks.
5. Pin `search_path` (`pg_catalog, public` hoặc schema tối thiểu); schema-qualify object.
6. Wrapper/impl pattern: exposed wrapper `SECURITY INVOKER` hoặc narrowly-definer; impl ở private schema không exposed.
7. Không nhận `p_user_id`/`p_organization_id` làm authority. Derive actor từ `auth.uid()` và target org từ resource.
8. Grant theo signature để không bỏ sót overload.
9. CI fail nếu có function mới `SECURITY DEFINER` mà PUBLIC/anon execute, thiếu pinned search_path hoặc thiếu entry trong allowlist.
10. Test trực tiếp bằng anon/auth JWT, không chỉ test từ UI.

---

## 10. Staff lifecycle và identity management

### 10.1 Hiện trạng/rủi ro

`useProvisionStaff` gọi `supabase.auth.signUp()` trong browser, lưu session admin rồi restore sau khi signUp tự chuyển session. Rủi ro:

- session switch/race và orphan auth row nếu assignment lỗi;
- signup endpoint được dùng như admin provisioning nhưng không phải một transaction;
- browser biết/chọn password ban đầu;
- không có invite lifecycle/expiry/acceptance rõ.

`delete_staff_member` xóa `auth.users`; cascade có thể xóa profile/assignment và dữ liệu liên quan, làm mất audit identity. “Xóa nhân viên” phải là revoke membership, không xóa auth principal.

### 10.2 Target lifecycle

| Action | Backend endpoint | Hành vi |
|---|---|---|
| Invite | `invite_organization_member` Edge/RPC | Tenant admin có `members.invite`; email/username normalized; tạo invitation token hash+expiry. |
| Accept | `accept_organization_invitation` | User xác thực, membership ACTIVE, token single-use. |
| Change role/scope | `update_member_authorization` | Transaction, versioned, actor không tự nâng quyền; security event. |
| Suspend | `suspend_organization_member` | Membership SUSPENDED; revoke active sessions nếu cần; không xóa identity/audit. |
| Remove | `remove_organization_member` | Membership REVOKED; bindings closed with `valid_to`; audit retained. |
| Delete auth user | Platform break-glass only | Chỉ khi không còn legal/audit dependency; data retention review. |

Owner cuối cùng không được tự remove/suspend. Chuyển owner cần two-step acceptance và audit.

---

## 11. Kiến trúc authorization mục tiêu

### 11.0 Prerequisite PostgreSQL extensions

Pseudo-DDL bên dưới dùng `citext` và exclusion constraint GiST với equality trên UUID. Live DB/repository hiện chưa có `citext` hoặc `btree_gist`, nên migration foundation phải tạo extension idempotent trước khi tạo bảng/index:

```sql
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
```

`IF NOT EXISTS` không chuyển extension đã tồn tại sang schema mới. Catalog precheck phải xác nhận `pg_extension.extnamespace`; nếu object đang ở schema khác, dùng schema thực tế hoặc relocation được kiểm thử. Khi tạo exclusion GiST phải bảo đảm operator class UUID/range được resolve deterministically (`SET LOCAL search_path = pg_catalog,public,extensions` trong migration đã review hoặc explicit opclass). Function runtime vẫn dùng search path tối thiểu và object schema-qualified. Nếu không muốn phụ thuộc `citext`, dùng `text` + unique index trên `lower(value)` với normalize server-side.

### 11.1 Nguyên tắc

1. Deny by default.
2. Tenant boundary là cột/foreign key, không suy bằng graph mỗi request.
3. Một user có thể là member nhiều org; mọi request nhạy cảm có explicit org context.
4. Platform role tách hoàn toàn tenant role.
5. Permission key normalized và versioned.
6. Scope union trong cùng permission; explicit deny thắng allow.
7. Resource resolver lấy organization/scope từ DB row.
8. Không có “first assignment wins”.
9. Permission changes có `authorization_version` để invalidate cache/session context.
10. UI dùng permission context DTO, không nhận sentinel vô phạm vi.

### 11.2 Schema đề xuất — organization/membership

```sql
organizations (
  id uuid primary key,
  slug extensions.citext unique not null,
  name text not null,
  status text not null check (status in ('ACTIVE','SUSPENDED','CLOSED')),
  authorization_version bigint not null default 1,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null,
  updated_at timestamptz not null
)

organization_memberships (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  user_id uuid not null references auth.users(id),
  member_type text not null check (member_type in
    ('OWNER','STAFF','SHAREHOLDER','PARTNER','SERVICE')),
  status text not null check (status in ('INVITED','ACTIVE','SUSPENDED','REVOKED')),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  invited_by uuid,
  activated_at timestamptz,
  revoked_at timestamptz,
  version bigint not null default 1,
  unique (organization_id, id),
  unique (organization_id, id, user_id),
  check (valid_to is null or valid_to > valid_from)
)
```

Ràng buộc thêm:

- Membership là một **episode lịch sử**, không update/reuse row REVOKED khi user quay lại. Dùng exclusion constraint theo `tstzrange(valid_from, valid_to, '[)')` để cấm hai episode overlap cho cùng `(organization_id,user_id)`, cộng partial unique cho tối đa một episode `ACTIVE/INVITED` hiện tại. Nếu chọn mô hình một row mutable đơn giản hơn, phải có `organization_membership_events` append-only lưu toàn bộ transition; không được vừa `UNIQUE(org,user)` vừa tuyên bố giữ lịch sử bằng chính row đó.
- `valid_from` không được nullable khi dùng episode range. Range dùng `tstzrange(valid_from, COALESCE(valid_to,'infinity'), '[)')`; predicate exclusion/partial unique phải xử lý episode terminal rõ ràng. Không dùng `tstzrange(NULL,NULL)` vì nó là range vô biên và có thể làm mọi episode xung đột.
- Exclusion constraint UUID equality + range overlap cần `btree_gist`; migration phải fail precheck nếu extension chưa sẵn sàng. Constraint mẫu phải dùng range vô hạn trên `valid_to IS NULL` và predicate episode tham gia rõ ràng, sau đó test hai transaction tạo episode đồng thời.
- Deferred constraint trigger đảm bảo mỗi org ACTIVE có ít nhất một OWNER; invariant “không xóa owner cuối” enforce trong cùng RPC/transaction.
- Trigger owner-cuối phải là deferred **constraint trigger** trên cả thay đổi `organizations.status` và membership `member_type/status/valid_to/organization_id`, đồng thời lock organization row để hai transaction không cùng loại owner cuối.
- Không dùng `ON DELETE CASCADE` từ auth user tới audit/financial records.
- Invitation cho email chưa có `auth.users` phải nằm trong bảng `organization_invitations` riêng (`email_normalized`, token hash, expiry, invited_by, intended role/scope). Chỉ sau khi user xác thực và accept mới tạo membership; status `INVITED` trong membership chỉ áp dụng cho principal đã tồn tại.
- `platform_administrators` là bảng riêng, không phải role trong organization.
- Mọi bảng nghiệp vụ có `organization_id NOT NULL` và FK; child row phải cùng org với parent qua composite FK hoặc constraint trigger.
- Mọi bảng được tham chiếu cross-org phải có candidate key `UNIQUE (organization_id, id)` để tạo composite FK. FK chỉ vào `id` là chưa đủ tenant integrity.
- Mọi pseudo-table có `organization_id` ở các mục sau đều phải có FK trực tiếp tới `organizations(id)`; block rút gọn không được copy thành migration khi thiếu FK này.
- Index bắt buộc: membership `(user_id,status,organization_id)`, `(organization_id,status,member_type)`, và range GiST nếu dùng episode.

### 11.3 Schema — normalized permission/RBAC

```sql
permission_definitions (
  key text primary key,                 -- ví dụ income_expenses.approve
  resource text not null,
  action text not null,
  sensitivity text not null,            -- VIEW/MANAGE/ELEVATED/PLATFORM
  permission_domain text not null check (permission_domain in ('TENANT','PLATFORM')),
  scope_kinds text[] not null,
  is_active boolean not null default true,
  unique(resource, action)
)

organization_roles (
  id uuid primary key,
  organization_id uuid not null,
  name extensions.citext not null,
  is_system boolean not null default false,
  version bigint not null default 1,
  unique(organization_id, name),
  unique(organization_id, id)
)

role_permissions (
  organization_id uuid not null,
  role_id uuid not null,
  permission_key text not null references permission_definitions(key),
  effect text not null default 'ALLOW' check (effect in ('ALLOW','DENY')),
  primary key(organization_id, role_id, permission_key),
  foreign key (organization_id, role_id)
    references organization_roles(organization_id, id)
)

role_bindings (
  id uuid primary key,
  organization_id uuid not null,
  membership_id uuid not null,
  role_id uuid not null,
  valid_from timestamptz,
  valid_to timestamptz,
  version bigint not null default 1,
  unique(organization_id, id),
  foreign key (organization_id, membership_id)
    references organization_memberships(organization_id, id),
  foreign key (organization_id, role_id)
    references organization_roles(organization_id, id),
  check (valid_to is null or valid_from is null or valid_to > valid_from)
)
```

Composite FKs/constraint triggers phải đảm bảo role, binding và membership cùng `organization_id`. `role_permissions` phải có trigger/check từ chối mọi `permission_domain='PLATFORM'`; platform permission chỉ được gán trong schema/bảng platform riêng mà tenant admin không có DML. Index binding tối thiểu: `(membership_id,valid_to)`, `(role_id,valid_to)`, `(organization_id,membership_id)`.

### 11.4 Schema — scope

Không dùng một `scope_id` polymorphic không FK. Dùng bảng có cột typed và CHECK đúng một target:

```sql
authorization_scopes (
  id uuid primary key,
  organization_id uuid not null,
  scope_type text not null check (scope_type in
    ('ORGANIZATION','AREA','BUILDING','CASHBOOK')),
  area_id uuid,
  building_id uuid,
  cashbook_id uuid,
  unique(organization_id, id),
  foreign key (organization_id, area_id)
    references areas(organization_id, id),
  foreign key (organization_id, building_id)
    references buildings(organization_id, id),
  foreign key (organization_id, cashbook_id)
    references accounts(organization_id, id),
  check (
    (scope_type='ORGANIZATION' and area_id is null and building_id is null and cashbook_id is null)
    or (scope_type='AREA' and area_id is not null and building_id is null and cashbook_id is null)
    or (scope_type='BUILDING' and building_id is not null and area_id is null and cashbook_id is null)
    or (scope_type='CASHBOOK' and cashbook_id is not null and area_id is null and building_id is null)
  )
)

role_binding_scopes (
  organization_id uuid not null,
  role_binding_id uuid not null,
  scope_id uuid not null,
  primary key(role_binding_id, scope_id),
  foreign key (organization_id, role_binding_id)
    references role_bindings(organization_id, id),
  foreign key (organization_id, scope_id)
    references authorization_scopes(organization_id, id)
)
```

- Area -> building expansion dùng live mapping `area_buildings`, nhưng cả hai phải cùng org.
- Cashbook permission không được suy chỉ từ building permission; đây là asset scope riêng.
- Organization scope không có nghĩa platform scope.
- Scope indexes: `(organization_id, scope_type, building_id)`, area, cashbook tương ứng.
- Cần unique partial indexes để canonicalize scope, ví dụ một `ORGANIZATION` scope/org và một `(organization_id,building_id)` scope; tránh nhiều UUID biểu diễn cùng scope.
- Mỗi permission có `scope_match_mode` được định nghĩa server-side. Resource nhiều trục (ví dụ voucher có building **và** cashbook) phải khai báo rõ `ALL_REQUIRED` hoặc action-specific resolver; không được để evaluator tự chọn “building OR cashbook”. Với `cashbooks.post`, cashbook match luôn bắt buộc dù caller có building scope.
- Tên `cashbook_id` hiện FK tới bảng legacy `accounts`; trước migration phải chốt tên canonical `account_id` hoặc tạo table/domain `cashbooks` thật. Không trộn hai tên trong API/FK/audit.
- Composite FK scope chỉ tạo được sau khi parent có `organization_id` và `UNIQUE(organization_id,id)`. Các candidate key root cho areas/buildings/accounts phải hoàn thành ở Sprint 1 trước scope tables/FK Sprint 2.

### 11.5 Per-user allow/deny

```sql
member_permission_overrides (
  id uuid primary key,
  organization_id uuid not null,
  membership_id uuid not null,
  permission_key text not null references permission_definitions(key),
  effect text not null check (effect in ('ALLOW','DENY')),
  reason text not null,
  expires_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null,
  unique(organization_id, id),
  foreign key (organization_id, membership_id)
    references organization_memberships(organization_id, id)
)

member_override_scopes (
  organization_id uuid not null,
  override_id uuid not null,
  scope_id uuid not null,
  primary key(override_id, scope_id),
  foreign key (organization_id, override_id)
    references member_permission_overrides(organization_id, id),
  foreign key (organization_id, scope_id)
    references authorization_scopes(organization_id, id)
)
```

Resolution precedence (mọi statement bên dưới phải match **toàn bộ scope mode áp dụng** của permission; trùng một dimension ngẫu nhiên không được tính là match):

1. Platform emergency deny / organization suspended.
2. Active per-user `DENY` matching permission+scope.
3. Role `DENY` matching permission+scope.
4. Per-user `ALLOW` matching permission+scope.
5. Role `ALLOW` matching permission+scope.
6. Default deny.

Owner không tự động bypass platform rules, cross-org checks, audit, financial state machine hoặc maker-checker. Owner có broad tenant permissions được seed như normalized role + member type capability.

“Matching scope” được tính trên **effective resource dimensions** do resolver canonical trả về, không phải chỉ so một UUID. Sau khi materialize mọi statement active/unexpired và đánh giá scope đúng mode, nếu có **bất kỳ DENY statement áp dụng** thì deny; nếu không, có ít nhất một ALLOW statement áp dụng thì allow; còn lại deny. Override không scope chỉ hợp lệ nếu permission cho phép organization scope; không dùng empty scope để ngầm hiểu global.

Evaluator phải xác định tập dimension relevant/required cho permission từ registry server-side; ALLOW chỉ hợp lệ khi thỏa `scope_match_mode`. DENY thắng ALLOW khi deny match theo chính mode/dimension relevant đó, không phải khi tình cờ trùng dimension không tham gia action. Ví dụ `cashbooks.post` luôn yêu cầu cashbook match; building match đơn lẻ không đủ để allow hoặc deny nhầm account khác.

### 11.6 Canonical authorization API

Đề xuất hai hàm:

```text
authorize(permission_key, organization_id, resource_type, resource_id) -> boolean
assert_authorized(...) -> void / raises 42501
```

Hàm phải:

1. Yêu cầu `auth.uid()`.
2. Load ACTIVE membership trong org.
3. Resolve resource row; xác nhận resource.organization_id = input org.
4. Resolve building/area/cashbook scope từ chính resource.
5. Áp deny precedence và expiry.
6. Ghi optional decision trace cho elevated actions.
7. Không nhận owner/user id thay authority.

RLS SELECT có thể dùng set-returning helpers tối ưu như `authorized_building_ids(permission_key, org_id)`. Mutation ưu tiên RPC; RLS vẫn chặn direct REST.

Để tránh RLS recursion và privilege escalation:

- Đặt authorization tables/implementation trong schema private không expose PostgREST; application roles không DML trực tiếp.
- Helper `SECURITY DEFINER` do non-login owner riêng sở hữu, `search_path` cố định, schema-qualified, và chỉ grant wrapper allowlist.
- Function đọc membership/binding không được bị policy gọi ngược lại chính table đó; dùng owner-bypass có kiểm soát hoặc security-barrier API, kèm unit test recursion.
- Phải chốt rõ `FORCE ROW LEVEL SECURITY` cho authorization tables. Nếu bật FORCE RLS, table owner của definer function cũng chịu policy trừ role có `BYPASSRLS`, nên helper có thể recurse hoặc tự deny. Test cả cấu hình FORCE RLS; không giả định `SECURITY DEFINER` luôn vượt FORCE RLS.
- Không ghi audit đồng bộ từ `authorize()` dùng trong mọi SELECT row; chỉ trace elevated mutations hoặc sample deny ở boundary để tránh side effect trong policy.

### 11.7 Frontend permission context

Thay `get_my_permissions()` bằng DTO:

```json
{
  "organizationId": "...",
  "membershipId": "...",
  "memberType": "STAFF",
  "authorizationVersion": 42,
  "permissions": { "buildings.view": true },
  "scopes": {
    "buildings.view": { "organization": false, "buildingIds": ["..."] }
  }
}
```

Không dùng `__superadmin` cho tenant owner. Platform UI dùng context endpoint riêng và audit riêng.

`authorizationVersion` tăng trong **cùng transaction** với mọi thay đổi membership/role/permission/binding/scope/override/area membership. Cache key gồm `(user_id,organization_id,authorization_version)`; backend không tin version client gửi. Khi area-building đổi, tăng version cho org hoặc dùng `scope_version` riêng được đưa vào DTO.

Mọi mutation authorization phải đi qua routine/trigger tập trung dùng atomic `authorization_version = authorization_version + 1` và phát invalidation sau commit. Counter trên row organization có thể thành write-hot-row; đo contention và tách membership/scope version nếu cần.

---

## 12. Approval engine mục tiêu

### 12.1 State model

Không tiếp tục dùng `UNAPPROVED` cho hai nghĩa. State tài chính:

```text
DRAFT
  -> PENDING_APPROVAL
  -> POSTED                  (trực tiếp từ DRAFT khi rule AUTO_POST)
  -> DENIED                  (rule DENY; không posting)
  -> CANCELLED
PENDING_APPROVAL
  -> POSTED                  (đủ decision/quorum)
  -> REJECTED
  -> CANCELLED               (withdraw theo policy; không xóa request)
POSTED
  -> REVERSED                (qua chứng từ reversal mới; row gốc bất biến)
```

Không có transition `POSTED -> DRAFT`. `DENIED` là kết quả rule engine, khác `REJECTED` là quyết định của người duyệt. `APPROVED` là outcome của approval, còn `POSTED` là trạng thái ledger; theo quyết định nghiệp vụ hiện tại, final approval và posting xảy ra cùng transaction nên UI có thể hiển thị “Đã duyệt/đã chi”.

### 12.2 Rule schema

```sql
approval_rule_sets (
  id uuid primary key,
  organization_id uuid not null,
  transaction_domain text not null,
  version integer not null,
  status text not null check (status in ('DRAFT','ACTIVE','RETIRED')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  published_by uuid,
  published_at timestamptz,
  unique(organization_id, transaction_domain, version),
  unique(organization_id, id),
  unique(organization_id, id, version),
  check(effective_to is null or effective_to > effective_from)
)

approval_rules (
  id uuid primary key,
  organization_id uuid not null,
  rule_set_id uuid not null,
  name text not null,
  priority integer not null,
  effect text not null check (effect in ('AUTO_POST','REQUIRE_APPROVAL','DENY')),
  transaction_type text,               -- INCOME/EXPENSE/TRANSFER/ADJUSTMENT; null chỉ cho fallback
  category_id uuid,
  cashbook_id uuid,
  building_id uuid,
  area_id uuid,
  system_source text,
  amount_min numeric(18,2),
  amount_max numeric(18,2),
  is_fallback boolean not null default false,
  force_match boolean not null default false,
  active boolean not null default true,
  unique(organization_id, id),
  unique(rule_set_id, priority),
  foreign key (organization_id, rule_set_id)
    references approval_rule_sets(organization_id, id),
  check(amount_min is null or amount_min >= 0),
  check(amount_max is null or amount_max >= 0),
  check(amount_max is null or amount_min is null or amount_max >= amount_min),
  check(is_fallback or transaction_type is not null),
  check(
    not is_fallback
    or (effect='REQUIRE_APPROVAL' and transaction_type is null
        and category_id is null and cashbook_id is null and building_id is null
        and area_id is null and system_source is null
        and amount_min is null and amount_max is null and not force_match)
  )
)
```

`priority` phải unique trong rule set. `transaction_domain` phải có trên rule set để enforce invariant. Mỗi rule-set row là một version bất biến sau publish; published version không UPDATE/DELETE và request FK đúng version đã đánh giá. Mỗi version bắt buộc có đúng một `is_fallback=true`, effect `REQUIRE_APPROVAL`, không có condition và có approval steps hợp lệ. Engine đánh giá `DENY`, force-approval và conditional rules trước, rồi dùng fallback khi không rule nào khác match. Publish RPC từ chối version thiếu/nhiều fallback hoặc tạo effective-range overlap; chỉ một version hiệu lực tại một thời điểm cho mỗi org/domain. Nếu không có đúng một ACTIVE version, fallback/candidate/quorum không hợp lệ thì submission rollback, fail closed và phát alert; tuyệt đối không auto-post. Category/source đặc biệt (commission, bonus, refund, contract payout, salary, profit) được seed `REQUIRE_APPROVAL` ưu tiên cao hơn generic amount rule. Category/cashbook/building/area phải có composite same-org FK; source/transaction type dùng lookup/enum, không text tự do do client quyết định.

### 12.3 Approver/step schema

```sql
approval_rule_steps (
  id uuid primary key,
  organization_id uuid not null,
  rule_id uuid not null,
  step_no integer not null,
  min_approvals integer not null default 1,
  mode text not null check (mode in ('ANY','ALL','QUORUM')),
  unique(organization_id, id),
  unique(rule_id, step_no),
  foreign key (organization_id, rule_id)
    references approval_rules(organization_id, id),
  check(step_no > 0 and min_approvals > 0)
)

approval_step_approvers (
  id uuid primary key,
  organization_id uuid not null,
  step_id uuid not null,
  approver_type text not null check (approver_type in
    ('MEMBER','ROLE','PERMISSION','CASHBOOK_APPROVER','AREA_APPROVER','BUILDING_APPROVER')),
  membership_id uuid,
  role_id uuid,
  permission_key text,
  scope_id uuid,
  foreign key (organization_id, step_id)
    references approval_rule_steps(organization_id, id),
  foreign key (organization_id, membership_id)
    references organization_memberships(organization_id, id),
  foreign key (organization_id, role_id)
    references organization_roles(organization_id, id),
  foreign key (organization_id, scope_id)
    references authorization_scopes(organization_id, id),
  foreign key (permission_key)
    references permission_definitions(key),
  check (
    (approver_type='MEMBER' and membership_id is not null and role_id is null and permission_key is null and scope_id is null)
    or (approver_type='ROLE' and role_id is not null and membership_id is null and permission_key is null and scope_id is null)
    or (approver_type='PERMISSION' and permission_key is not null and membership_id is null and role_id is null and scope_id is null)
    or (approver_type in ('CASHBOOK_APPROVER','AREA_APPROVER','BUILDING_APPROVER')
        and scope_id is not null and membership_id is null and role_id is null and permission_key is null)
  )
)
```

Không lưu approver bằng email/name. Khi submit, engine materialize candidate rows vào `approval_request_step_candidates(organization_id,request_step_id,membership_id,generation,source_kind,source_id,eligible_at_submit,valid_to)`. Unique hiệu lực là `(organization_id,request_step_id,membership_id,generation)`; rematerialize tạo generation mới, đóng validity row cũ và không overwrite history. Khi decide vẫn re-check membership ACTIVE, maker-checker và permission/scope hiện tại. `mode='ANY'` bắt buộc `min_approvals=1`; `ALL` snapshot candidate count và yêu cầu toàn bộ; `QUORUM` yêu cầu `min_approvals <= candidate_count`. Submit fail closed nếu một step không có candidate hoặc quorum bất khả thi.

Candidate table phải có composite FK cùng org tới request step/membership. Decision thường phải FK/reference đúng candidate generation đã dùng và chỉ hợp lệ nếu actor có candidate row active ở step hiện tại; endpoint emergency là nhánh server riêng được miễn candidate nhưng vẫn gắn active step.

Nếu suspend/revoke approver làm `eligible_count < min_approvals`, request không được âm thầm hạ quorum hoặc kẹt vô hạn. Recovery policy versioned phải reassign/rematerialize bằng elevated RPC có audit, timeout/escalate, hoặc reject/cancel để resubmit; luôn lock request, tăng version và giữ candidate history.

### 12.4 Request/decision/audit schema

```sql
approval_requests (
  id uuid primary key,
  organization_id uuid not null,
  submission_no integer not null,
  subject_type text not null,            -- FINANCIAL_VOUCHER/PAYMENT/...
  subject_id uuid not null,
  state text not null check (state in ('PENDING_APPROVAL','POSTED','DENIED','REJECTED','CANCELLED')),
  maker_membership_id uuid not null,
  maker_user_id uuid not null,
  rule_set_id uuid not null,
  rule_set_version integer not null,
  matched_rule_id uuid not null,
  rule_effect text not null check (rule_effect in ('AUTO_POST','REQUIRE_APPROVAL','DENY')),
  payload_snapshot jsonb not null,
  payload_hash text not null,
  amount numeric(18,2) not null,
  category_id uuid,
  cashbook_id uuid,
  building_id uuid,
  system_source text,
  submitted_at timestamptz,
  posted_at timestamptz,
  posted_event_id uuid unique,
  version bigint not null default 1,
  unique(organization_id, id),
  unique(organization_id, subject_type, subject_id, submission_no)
)

approval_request_steps (
  id uuid primary key,
  organization_id uuid not null,
  request_id uuid not null,
  step_no integer not null,
  status text not null check (status in ('WAITING','PENDING','APPROVED','REJECTED','CANCELLED','BYPASSED')),
  mode text not null check (mode in ('ANY','ALL','QUORUM')),
  min_approvals integer not null,
  current_generation integer not null default 1,
  rule_step_snapshot jsonb not null,
  candidate_count integer not null,
  unique(organization_id, id),
  unique(organization_id, request_id, id),
  unique(request_id, step_no),
  foreign key (organization_id, request_id)
    references approval_requests(organization_id, id),
  check(step_no > 0 and min_approvals > 0 and current_generation > 0
        and candidate_count >= min_approvals)
)

approval_request_step_candidates (
  id uuid primary key,
  organization_id uuid not null,
  request_step_id uuid not null,
  membership_id uuid not null,
  generation integer not null check (generation > 0),
  source_kind text not null,
  source_id uuid,
  eligible_at_submit boolean not null,
  valid_from timestamptz not null,
  valid_to timestamptz,
  unique(organization_id, id),
  unique(organization_id, id, generation, request_step_id, membership_id),
  unique(organization_id, request_step_id, membership_id, generation),
  foreign key (organization_id, request_step_id)
    references approval_request_steps(organization_id, id),
  foreign key (organization_id, membership_id)
    references organization_memberships(organization_id, id),
  check(valid_to is null or valid_to > valid_from)
)

approval_decisions (
  id uuid primary key,
  organization_id uuid not null,
  request_id uuid not null,
  request_step_id uuid not null,
  candidate_id uuid,
  candidate_generation integer,
  actor_membership_id uuid not null,
  actor_user_id uuid not null,
  decision text not null check (decision in ('APPROVE','REJECT','EMERGENCY_APPROVE')),
  reason text,
  decided_at timestamptz not null,
  request_version bigint not null,
  foreign key (organization_id, request_id)
    references approval_requests(organization_id, id),
  foreign key (organization_id, request_id, request_step_id)
    references approval_request_steps(organization_id, request_id, id),
  foreign key (organization_id, candidate_id, candidate_generation,
               request_step_id, actor_membership_id)
    references approval_request_step_candidates
      (organization_id, id, generation, request_step_id, membership_id),
  check (
    (decision in ('APPROVE','REJECT') and candidate_id is not null and candidate_generation is not null)
    or (decision='EMERGENCY_APPROVE' and candidate_id is null and candidate_generation is null)
  ),
  check (
    decision <> 'EMERGENCY_APPROVE'
    or (reason is not null and length(btrim(reason)) >= 20)
  )
)

CREATE UNIQUE INDEX approval_decisions_one_normal_per_generation
  ON approval_decisions
    (organization_id, request_step_id, actor_user_id, candidate_generation)
  WHERE decision IN ('APPROVE','REJECT');

authorization_audit_events (
  id uuid primary key,
  organization_id uuid,
  occurred_at timestamptz not null,
  actor_user_id uuid,
  actor_membership_id uuid,
  event_type text not null,
  resource_type text,
  resource_id uuid,
  trace_id uuid,
  old_state jsonb,
  new_state jsonb,
  reason text,
  prev_hash text,
  event_hash text not null
)

CREATE UNIQUE INDEX approval_requests_one_open_subject
  ON approval_requests (organization_id, subject_type, subject_id)
  WHERE state = 'PENDING_APPROVAL';
```

`subject_type + subject_id` là polymorphic nên subject resolver server-side phải allowlist type, lock row thật, derive organization từ subject và từ chối subject không tồn tại/khác org.

`approval_requests` không unique vĩnh viễn chỉ theo subject vì subject có thể bị reject/cancel rồi sửa và resubmit. `submission_no` tăng dưới lock; partial unique đảm bảo tối đa một request OPEN (`PENDING_APPROVAL`) cho mỗi subject. Request cũ giữ nguyên terminal history. `approval_decisions` là append-only; không “đổi quyết định” bằng UPDATE.

Ràng buộc còn bắt buộc khi chuyển pseudo-DDL thành migration:

- Bind identity bằng composite FK `(organization_id,maker_membership_id,maker_user_id)` và `(organization_id,actor_membership_id,actor_user_id)` tới `organization_memberships(organization_id,id,user_id)`; không cho ghép membership của A với user id của B để né maker-checker.
- `approval_requests` phải FK tới đúng `(organization_id,rule_set_id,rule_set_version)` và matched rule cùng rule set/effect. `matched_rule_id` luôn non-null, kể cả khi match fallback `is_fallback=true`; `DENY`/fallback/auto outcome có check chéo với state và posting metadata.
- Mọi table tenant-owned trong pseudo-DDL phải có FK trực tiếp `organization_id -> organizations(id) ON DELETE RESTRICT`, kể cả role/scope/override/rule/request/step/candidate/decision/posting/audit. Các đoạn rút gọn không được dùng để miễn constraint.
- Candidate generation phải có composite FK/trigger bảo đảm `candidate_id`, `candidate_generation`, actor membership và request step đều cùng row/generation. Rematerialize chỉ một step `PENDING`: lock request+step, đóng candidate cũ, insert trọn bộ generation mới, recompute count/quorum, tăng `current_generation` và request version atomically. Decision generation cũ giữ append-only để audit nhưng **mất hiệu lực**, không carry forward. Decide lock cùng rows và chỉ nhận candidate thuộc current generation còn hiệu lực.
- Normal decision chỉ nhắm step `PENDING` và candidate eligible hiện tại. Emergency endpoint vẫn gắn active step để audit nhưng được miễn candidate bằng server branch; không cho client chọn enum emergency.
- State/metadata checks tối thiểu: `POSTED` iff có `posted_at/posted_event_id`; các terminal không-post không có posting metadata; `AUTO_POST -> POSTED`; `DENY -> DENIED`; `REQUIRE_APPROVAL` (kể cả fallback) bắt đầu `PENDING_APPROVAL`.

Composite FK ba cột ở decision là bắt buộc: hai FK độc lập tới `request_id` và `request_step_id` vẫn cho phép ghép request A với step của request B trong cùng organization. Mọi posting event cũng phải FK cùng org/request/subject thay vì chỉ giữ UUID rời.

Audit tables:

- INSERT chỉ qua definer function/internal role.
- Application roles không UPDATE/DELETE.
- FK tới user/membership dùng `ON DELETE RESTRICT` hoặc lưu immutable scalar identity snapshot; không cascade.
- Hash chain theo organization/day hoặc export định kỳ sang object store append-only để phát hiện tampering.
- Nếu dùng hash chain, serialize event bằng canonical JSON và lock một chain-head `(organization_id, chain_partition)` khi append; nếu không hai transaction đồng thời có thể cùng `prev_hash` tạo fork. Partition theo ngày phải liên kết hash đóng/mở giữa hai ngày hoặc ghi rõ chỉ bảo vệ từng partition độc lập.

### 12.5 Rule matching algorithm

Trong một transaction:

1. Lock subject/draft.
2. Validate amount/items/account/category/source và cùng organization.
3. Load ACTIVE rule set tại timestamp server.
4. Tìm mọi rule match typed conditions.
5. Áp precedence `DENY` > force `REQUIRE_APPROVAL` > priority nhỏ nhất; nếu bằng nhau, phân xử theo độ đặc hiệu bằng quy tắc xác định.
6. Nếu không conditional rule nào match => chọn rule `is_fallback=true` của chính version.
7. Tạo request và snapshot payload, matched rule, rule set version, hash trước khi tạo effect; mọi evaluation có một provenance row.
8. `DENY`: terminal `DENIED`, không tạo step/posting; `AUTO_POST`: gọi posting routine cùng transaction rồi terminal `POSTED`, không tạo step.
9. `REQUIRE_APPROVAL` (kể cả fallback): tạo steps/candidates; step thấp nhất `PENDING`, các step sau `WAITING`, request `PENDING_APPROVAL` rồi commit.

Step xử lý tuần tự. Chỉ step `PENDING` nhận normal decision. Đủ quorum thì step thành `APPROVED` và promote step `WAITING` kế tiếp; chỉ post khi không còn step `PENDING/WAITING`. Một `REJECT` hợp lệ làm active step `REJECTED`, các step sau `CANCELLED`, request `REJECTED` trong cùng transaction. `ANY` bắt buộc min=1; `ALL` snapshot min bằng candidate count; `QUORUM` kiểm bound. Escalation/reassign là event/generation có audit, không dùng một status `ESCALATED` làm mất trạng thái workflow. Emergency approve đánh active step và mọi step sau thành `BYPASSED` trước khi post trong cùng transaction; reason/audit phải ghi rõ các step/quorum bị bypass.

Không evaluate lại rule giữa chừng trừ khi request bị maker sửa; sửa payload làm invalid request cũ và submit request/version mới.

Concurrency contract:

- `submit`, `decide`, `reject`, `withdraw`, `post` đều `SELECT ... FOR UPDATE` subject và request theo cùng thứ tự khóa.
- RPC nhận `expected_request_version`; update dùng CAS và tăng version.
- Final decision tính quorum sau lock chỉ từ normal `APPROVE` rows của active step có `candidate_generation = current_generation` và candidate còn hiệu lực; decision generation cũ không approve/reject request. Insert decision và transition/post cùng transaction.
- Một unique idempotency record lưu `(organization_id, operation, key, request_hash, response_json)`. Cùng key khác payload => conflict; cùng key cùng payload => trả response cũ.
- `posted_event_id` chỉ được set bởi posting routine; posting event có unique `approval_request_id` để chống double post từ cả hai phía.
- Rejection thắng/approval thắng theo transaction lock đầu tiên; transaction sau thấy terminal state và trả kết quả idempotent/invalid transition, không ghi decision trái trạng thái.

### 12.6 Maker-checker, tự duyệt theo hạn mức và emergency

Maker-checker vẫn là mặc định: normal decision RPC reject khi `actor_membership_id = maker_membership_id` hoặc `actor_user_id = maker_user_id`, kể cả maker có nhiều role. Ngoại lệ duy nhất đã được owner chốt là **phiếu chi thông thường tự duyệt theo hạn mức**, không phải emergency.

#### Ngoại lệ tự duyệt theo hạn mức

Maker được tự duyệt/post phiếu do chính mình tạo chỉ khi backend xác minh đồng thời:

1. Rule/category/source xác định đây là phiếu chi thông thường và **không** thuộc force-approval. Hoa hồng, thưởng, hoàn tiền/hoàn cọc, lương, chia lợi nhuận, hợp đồng/thanh lý và mọi rule `REQUIRE_APPROVAL` bắt buộc bỏ qua hạn mức, luôn chờ người khác duyệt.
2. Tổng tiền không vượt hạn mức tự duyệt hiệu lực của membership/role tại thời điểm post. Hạn mức là cấu hình versioned phía server; không nhận từ client, không được chia nhỏ một business event để lách hạn mức và phải tính tổng theo correlation/batch phù hợp.
3. Nếu maker chọn account khi tạo phiếu, account đó phải thuộc tập sổ quỹ membership maker đang **nắm giữ** theo binding/scope canonical; chỉ có building scope hoặc quyền xem/sửa sổ không đủ. Quy tắc này áp dụng cho mọi phiếu chi, kể cả phiếu sẽ chờ duyệt. Maker không nắm sổ phù hợp phải để trống account để kế toán/owner chọn khi duyệt; phiếu để trống account không đủ điều kiện tự duyệt.
4. Maker có exact permissions `income_expenses.create`, `income_expenses.self_approve_within_limit` và `cashbooks.post` trên account đó; organization, kỳ sổ và mọi foreign resource đều hợp lệ.
5. Payload/version/idempotency hợp lệ và ảnh/evidence đáp ứng rule của loại phiếu. Post, quyết định self-approval và audit cùng một transaction.
6. Request được gắn `SELF_APPROVED_WITHIN_LIMIT`, hạn mức/rule version đã dùng và đưa vào hàng **hậu kiểm** cho kế toán/owner. Hậu kiểm không sửa/xóa posting gốc; nếu phát hiện sai thì tạo correction/reversal hoặc mở sự kiện điều tra.

Phiếu chờ duyệt thông thường được phép chưa chọn sổ quỹ. Ở final decision, kế toán/owner phải chọn một sổ họ có quyền post, thêm ảnh chứng từ theo UI duyệt hiện tại, rồi hệ thống tạo snapshot/version cuối và mới cho post. Việc approver chọn account không được biến request thành maker self-approval và phải được audit như thay đổi có tác động tiền.

#### Emergency owner override

Emergency owner override chỉ khi:

- membership ACTIVE + `member_type='OWNER'`;
- request đang `PENDING_APPROVAL`;
- actor có permission `approvals.emergency_override`;
- reason sau trim đạt độ dài tối thiểu, ví dụ 20 ký tự;
- optional second factor/re-auth còn mới;
- tạo `EMERGENCY_APPROVE` decision, security notification, audit event;
- metric/alert theo dõi tần suất; không dùng trong bulk action.

Emergency là endpoint riêng, không được insert vào normal decision path bằng client-supplied enum. Endpoint lock request, kiểm owner/permission/re-auth server-side, ghi event và post trong cùng transaction. Nếu request đã terminal, endpoint không tạo thêm decision.

Emergency không thay thế quorum recovery hoặc hạn mức tự duyệt. Dashboard phải cảnh báo request sắp/quá SLA hoặc quorum bất khả thi; reassign/escalate chỉ qua endpoint audited. Owner là maker không được dùng emergency để tự duyệt; nếu phiếu thỏa ngoại lệ hạn mức thì đi đúng self-approval flow, còn force-approval phải chờ approver khác.

### 12.7 Posting/ledger

Có hai lựa chọn:

1. Giữ `income_expenses` làm posted ledger trong giai đoạn chuyển tiếp, thêm immutable posting metadata.
2. Dài hạn tạo `financial_posting_events`/`financial_posting_lines` append-only và coi voucher là business document.

Khuyến nghị giai đoạn đầu chọn (1) để giảm rủi ro báo cáo, nhưng thêm:

```text
posting_id, posted_at, posted_by, approval_request_id,
correlation_id, idempotency_key, reversed_by_posting_id, source_payload_hash
```

Double-post phải được chặn tại posting source of truth, ưu tiên `financial_posting_events.approval_request_id UNIQUE NOT NULL` hoặc posting batch/header tương đương. Không unique trực tiếp `income_expenses.approval_request_id` nếu một request hợp lệ sinh nhiều legs; `approval_requests.posted_event_id UNIQUE` chỉ là guard bổ sung.

Trigger/RLS cấm sửa amount/items/account/category của row POSTED. Giai đoạn sau có thể chuyển balance view sang posting lines.

Reversal là posting mới với `reverses_posting_id UNIQUE` và số tiền/lines đối ứng được server derive từ original, không nhận amount tự do từ client. Original có thể hiển thị trạng thái REVERSED qua projection nhưng row/lines gốc không update nội dung. Chỉ một full reversal mặc định; partial reversal nếu cần phải là nghiệp vụ riêng với constraint tổng reversed không vượt original.

---

## 13. RPC boundary mục tiêu

| RPC/endpoint | Permission | Transaction invariant |
|---|---|---|
| `create_financial_draft` | `income_expenses.create` | Voucher+items cùng org; DRAFT only; account có thể null nếu sẽ chờ duyệt. |
| `update_financial_draft` | `income_expenses.edit` | Maker/scope; expected version; DRAFT only. |
| `submit_financial_request` | create/submit | Rule snapshot + request hoặc auto-post atomically; force categories luôn chờ duyệt. |
| `self_approve_financial_within_limit` | `income_expenses.self_approve_within_limit` + `cashbooks.post` | Chỉ phiếu chi thông thường dưới hạn mức, account thuộc maker, không force-approval; post once + hậu kiểm. |
| `decide_financial_approval` | `income_expenses.approve` + approver eligibility | Maker-checker; approver có thể chọn account và thêm ảnh trước snapshot cuối; row lock; final post once. |
| `emergency_approve_financial` | `approvals.emergency_override` + OWNER | Reason/re-auth; alert; post once; maker không dùng để né force-approval. |
| `cancel_financial_draft` / `withdraw_financial_request` | cancel/withdraw | Draft chỉ DRAFT; withdraw chỉ PENDING_APPROVAL và đóng request có audit. |
| `reverse_financial_posting` | `income_expenses.reverse` | Tạo chứng từ đối ứng; original immutable. |
| `create_invoice_atomic` | `invoices.create` | Invoice+items+credit atomic; server áp setting `auto_approve_invoice` (mặc định bật). |
| `revise_invoice` | `invoices.edit_approved_unpaid` hoặc `invoices.edit` | Approved-unpaid revision có lock, zero-payment check, expected version, reason, before/after audit và hậu kiểm. |
| `record_invoice_payment_atomic` | `thu_tien.collect` + cashbook post | Payment+voucher+items+credit+invoice recompute một transaction. |
| `record_invoice_payments_bulk` | `thu_tien.collect` + quyền post cashbook cho từng invoice | Per-invoice atomic, cho phép thành công một phần; trả kết quả ổn định cho từng invoice. |
| `reverse_invoice_payment` | `thu_tien.undo` | Tạo payment/posting đối ứng, không hard delete; giữ liên kết bản gốc để truy vết. |
| `request_settlement_refund` | `deposits.refund` | Luôn PENDING_APPROVAL. |
| `request_salary_payout` | `salary.distribute` | Luôn PENDING_APPROVAL; post cập nhật paid atomically. |
| `request_profit_distribution` | `shareholder_profit.distribute` | Luôn PENDING_APPROVAL. |
| `post_internal_settlement` | internal service only | Allowlisted source; balanced/net-zero; no client grant. |
| `create_cashbook` / `update_cashbook_metadata` | `cashbooks.create/edit` | Opening balance = 0; metadata CAS; không đổi owner/balance ngầm. |
| `request_opening_balance_adjustment` | `cashbooks.adjust_balance` | Reason/evidence; rule/approval; immutable posting. |
| `lock_cashbook_period` / `unlock_cashbook_period` / `archive_cashbook` | exact elevated cashbook action | CAS + reason + dependency/reconciliation guard; mọi writer gọi shared period-open assertion. |
| `generate_meter_reading_and_invoice` | `meter_readings.approve` + `invoices.create` | Reading+invoice+items/credit atomic; server pricing; idempotent. |
| `submit_contract` | `contracts.create` + dependent exact actions | Core graph/room/deposit/first invoice atomic; durable outbox intent cho commission và side effects. |
| `create_reservation_deposit` | `deposits.create` + cashbook post | Tenant/deposit voucher/item + hold phòng 24 giờ cùng transaction; rule-enforced. Duyệt/post chuyển hold thành reservation, reject/cancel/expiry giải phóng. |
| `invite/update/suspend/remove_member` | exact `users.*` | Identity+membership+binding+audit atomic. |

Client roles không được direct mutate các cột/tables thuộc state machine. RLS direct INSERT có thể chỉ cho DRAFT với trigger ép actor/org; an toàn hơn là revoke direct DML và chỉ RPC.

#### Giải thích nghiệp vụ: “hoàn tác payment bằng giao dịch đối ứng”

“Hoàn tác” **không phải** xóa payment cũ và cũng không sửa lịch sử như thể khách chưa từng trả. Hệ thống giữ payment gốc, sau đó tạo một operation mới mang số tiền đối ứng và liên kết `reverses_payment_id/reverses_posting_id` tới bản gốc. Ví dụ khách đã trả 1.000.000 đồng vào sổ A nhưng giao dịch cần hủy: bản gốc `+1.000.000` vẫn còn; operation hoàn tác ghi `-1.000.000` trên đúng account/các ledger legs, giảm lại `invoice.paid_amount` và recompute trạng thái hóa đơn trong cùng transaction. Kết quả ròng bằng 0 nhưng kế toán/owner vẫn thấy rõ ai thu, ai hoàn tác, thời gian, lý do và chứng từ.

Chỉ full reversal một lần theo mặc định; retry cùng idempotency key trả kết quả cũ. Nếu payment đã được đổi phương thức, phân bổ credit, chốt kỳ hoặc phát sinh hoàn tiền thật cho khách, RPC phải derive toàn bộ chân đối ứng từ operation gốc, kiểm kỳ/scope và đưa qua approval khi rule yêu cầu. UI nên dùng nhãn dễ hiểu **“Hủy giao dịch thu tiền (tạo bút toán hoàn tác)”**, hiển thị cảnh báo “không xóa lịch sử” trước khi xác nhận.

Tên/contract bulk phải rõ: “per-invoice savepoint/result” là **partial-success batch**, không atomic toàn batch. Nên đổi tên thành `record_invoice_payments_bulk` và trả item result ổn định, hoặc chọn all-or-nothing thật sự; không dùng hậu tố `_atomic` khi API cho phép một phần commit.

`submit_contract` là authoritative create path: lock room/reservation/deposit theo thứ tự cố định, revalidate version/availability, rồi commit contract graph, customer/service links, room state, reservation conversion, deposit vouchers/items và first invoice cùng nhau. Commission request, notification, document generation và integration được ghi thành transactional outbox trong chính transaction đó, unique `(organization_id,event_type,aggregate_id,aggregate_version)`. Worker claim bằng `FOR UPDATE SKIP LOCKED`, at-least-once; handler idempotent, retry/backoff/dead-letter có alert. “Submit thành công” bảo đảm core state + durable intent, không tuyên bố side effect ngoài transaction đã hoàn tất.

Reservation deposit tạo hold độc quyền **24 giờ tính từ thời điểm server nhận submission**. Hold có `expires_at`, subject/deposit/request id và unique exclusion/locking để một phòng không có hai hold hiệu lực. Approval/post trước hạn chuyển hold sang reservation chính thức trong cùng transaction. Reject, maker cancel hoặc job expiry giải phóng hold có audit; request được duyệt sau khi hold hết hạn phải re-lock và revalidate phòng, không tự chiếm lại phòng đã có người khác giữ. UI hiển thị trạng thái “Đang giữ — chờ duyệt cọc” và thời gian đếm ngược; job expiry idempotent và có cảnh báo khi approval SLA gần vượt 24 giờ.

---

## 14. Storage authorization mục tiêu

### 14.1 Object naming

```text
<organization_id>/<resource_type>/<resource_id>/<random_uuid>.<ext>
```

Không dùng user id folder như tenant boundary. Lưu metadata DB:

```text
storage_object_links(bucket_id, object_name, organization_id,
                     resource_type, resource_id, uploaded_by,
                     classification, created_at)
```

### 14.2 Policy model

- INSERT: caller có upload permission trên resource và path org = active org.
- SELECT/signed URL: `authorize(<resource>.view, org, resource)`; PII bucket có key riêng.
- UPDATE: hạn chế; ưu tiên immutable object + upload replacement.
- DELETE: soft unlink/retention job; exact delete permission.
- Public sale images nên tách bucket/public DTO riêng; không tái dùng customer image.
- Signed URL TTL ngắn; không log URL/token.
- File size/MIME allowlist, malware scan nếu upload từ ngoài.

### 14.3 Migration Storage

1. Inventory object path và DB references.
2. Map mỗi object tới organization/resource; unresolved vào quarantine report.
3. Copy/move path theo org, không xóa nguồn ngay.
4. Dual-read signed URL trong thời gian chuyển tiếp.
5. Thay authenticated-wide policy bằng org/resource policy.
6. Negative test user A với exact object name của B.
7. Sau retention window mới xóa path cũ.

### 14.4 Cloudflare R2 Worker — P0 bổ sung

R2 là authorization/storage boundary độc lập và hiện chưa đạt mô hình trên. `infra/cloudflare-worker/src/index.ts` xác minh JWT nhưng không lấy user id/org, không authorize resource và cho upload mọi `safeKey`; object lại nằm dưới `R2_PUBLIC_BASE`. `safeKey` chỉ chống path traversal, không chống cross-tenant overwrite/data publication.

Containment bắt buộc:

1. Chỉ allowlist bucket public thực sự (`room-sale-images`) và ép server dựng prefix/key ngẫu nhiên; cấm client chọn full key hoặc overwrite key đã tồn tại.
2. Upload nhận resource id, resolve organization/building và exact permission qua backend; không chỉ kiểm JWT tồn tại.
3. Giới hạn `Content-Length`, MIME/magic bytes, quota/rate; không tin `Content-Type`/`X-Cache-Control` client.
4. Không trả public URL cho customer ID, receipt, attachment, contract hoặc PII. Private class dùng signed capability ngắn hạn và re-authorize trước khi ký.
5. Tạo upload intent/link metadata DB trước upload (nonce, org, resource, expected key, expiry, max bytes, MIME). Không dựa vào link được tạo sau object.
6. Audit actor/org/resource/hash/size; cleanup orphan; negative test user A upload/overwrite/read key của B.
7. Rà custom domain/bucket setting: nếu R2 origin public thì endpoint `/file` allowlist không bảo vệ truy cập trực tiếp `${R2_PUBLIC_BASE}/<key>`.

---

## 15. Edge Functions

| Function | Hiện trạng | Kế hoạch |
|---|---|---|
| `admin-create-user` | Verify JWT rồi query `super_admins` bằng service role; platform-super only | Giữ cho platform admin; tạo endpoint tenant invite riêng, không mở admin API cho tenant admin. Validate body/rate/audit. |
| `llm-proxy` | JWT + entitlement + permission + rate/quota reservation | Giữ chain; mọi AI write tool phải gọi canonical RPC và re-authorize object/action. Không tin tool prompt. |
| `salary-v5-jobs` | Cron secret/service JWT/admin path, idempotent cron runs | Tách platform admin khỏi tenant owner; internal RPC grants service-only; audit organization batch. |
| `send-push` | Service role gửi target bất kỳ; user JWT chỉ self | Hợp lý; service callers allowlist, validate URL/payload; không để service key ở caller ngoài trusted infra. |
| `demo-reset` | Shared secret, service role, DB cooldown | Blast radius demo-only phải được DB chứng minh; rotate secret, constant-time compare nếu cần, không thêm generic params. |
| `api/salary-v5-cron.js` | Vercel route forward secret nhưng chưa xác thực request vào route | P0/P1: verify `Authorization: Bearer CRON_SECRET` constant-time, POST-only; không biến public request thành trusted cron request. Manual rerun dùng admin endpoint riêng. |
| Cloudflare R2 Worker | JWT-valid là đủ để upload arbitrary key; public base URL | P0: áp mô hình mục 14.4; tách public sale asset khỏi private PII. |
| `worker/index.js` Zalo VPS | Giữ service-role key + session cookies, đọc/ghi queue/data bypass RLS | Đưa vào service inventory; harden host/file permissions/encryption/rotation. Claim queue qua service-only RPC có account/source constraints và audit. |

Mọi Edge Function dùng service role phải tự xác thực/authorize trước query. CORS không phải authorization.

`send-push` không nên tin claim `role='service_role'` chỉ bằng decode payload JWT. Dù gateway hiện được kỳ vọng `verify_jwt`, code boundary an toàn phải chỉ chấp nhận service secret/token đã xác minh chắc chắn; token còn lại gọi `auth.getUser()`. Thêm deployment-config test chứng minh `verify_jwt` không bị tắt ngoài ý muốn.

---

## 16. Migration và backfill strategy

### 16.1 Nguyên tắc

- Additive trước, enforcement sau.
- Mỗi phase có precheck/postcheck/hash/count và rollback point.
- Không backfill dựa trên phỏng đoán im lặng; row mơ hồ đi `authorization_migration_exceptions`.
- Dual-write phải idempotent và có reconciliation; không kéo dài vô hạn.
- Không đổi owner/audit `user_id` hàng loạt trước khi có mapping được duyệt.
- Sau khi ledger mới post production, rollback là forward-fix/reconciliation, không xóa posting.

### 16.2 Mapping organization

Live có 2 distinct legacy `staff_assignments.user_id`, nhưng không được mặc định “2 owner = 2 organization” mà không kiểm tra:

1. Tạo `legacy_owner_organization_map(legacy_owner_id, organization_id, status, evidence)`.
2. Seed candidate organization từ distinct legacy owner có building/account/role.
3. Với building, org candidate từ `buildings.user_id`.
4. Với child có building: derive từ building, không từ audit `user_id`.
5. Contract/invoice/payment/item derive qua parent FK.
6. Cashbook/config/global entity derive từ legacy owner map, nhưng đối chiếu references.
7. Assignment trỏ building của owner khác được chuyển thành membership/binding scope explicit trong org chứa building; không tự merge hai org.
8. Row không có building và owner mơ hồ đưa exception queue.

### 16.3 Thứ tự thêm `organization_id`

1. Root: extensions prerequisite; organizations, invitations, memberships, buildings, areas, accounts, roles. Thêm `UNIQUE(organization_id,id)` cho areas/buildings/accounts ngay phase này để scope FK Sprint 2 tạo được.
2. Structure: floors, rooms, services, meters, warehouses.
3. Customer/contract roots.
4. Invoices/payments/deposits/excess.
5. Income-expenses/items/types/templates/batches.
6. Assets/materials/tasks/notifications/config.
7. Profit/salary/shareholder.
8. Audit/storage link tables.

Ban đầu nullable + index. Sau backfill và assertion zero-null/cross-org, thêm FK/NOT NULL/composite consistency constraints.

### 16.4 Backfill role/permission

1. Seed `permission_definitions` từ registry, freeze danh sách key.
2. Validate mọi JSONB key trong `roles.permissions`/`staff_assignments.permissions`.
3. Materialize legacy fallback thành true/false explicit; lưu mapping version.
4. Tạo org role và role_permissions.
5. Mỗi staff có một membership; mỗi assignment thành role binding/scope.
6. Nếu permission snapshot per-staff khác role template, tạo per-user override diff, không clone role mù.
7. Nếu nhiều assignment cùng staff có permission khác nhau, tạo exception để owner chọn; không dùng first row.
8. Seed owner role broad nhưng org-scoped; platform super-admin giữ bảng riêng.

### 16.5 Backfill approval state

| Legacy case | Target | Provenance |
|---|---|---|
| APPROVED + approved_by/at đủ | POSTED | `LEGACY_VERIFIED_METADATA`; không tạo decision nếu không có request lịch sử. |
| APPROVED thiếu approved_by | POSTED | `LEGACY_APPROVED_UNKNOWN`; audit import actor = migration service, original approver null. |
| UNAPPROVED recurring child, account null | DRAFT | `LEGACY_RECURRING_DRAFT`. |
| UNAPPROVED refund/commission/contract payout marker | PENDING_APPROVAL | Synthetic request `LEGACY_PENDING`; maker từ creator nếu có. |
| UNAPPROVED khác | Review queue | Không tự đoán; owner classify DRAFT/PENDING_APPROVAL/CANCELLED. |
| CANCELLED | CANCELLED | Giữ history; không xóa payment/voucher evidence. |

Không tạo `APPROVE` decision cho các row APPROVED thiếu approver (tại lần re-run mới nhất: 476 expense và 1,015 income — con số động, chốt lại trong maintenance window trước cutover). Có thể tạo `MIGRATION_IMPORTED` audit event với count/hash batch.

### 16.6 Dual-read/dual-write

Giai đoạn shadow:

- Legacy RLS vẫn phục vụ production.
- New organization/scope tables được backfill và update qua trigger/RPC.
- `authorize_v2` chạy shadow cùng helper cũ, ghi mismatch nhưng chưa deny.
- Approval engine chạy shadow decision cho request mới, không post kép.
- Reconciliation so row count, sum theo org/building/account/status và permission decision samples.

Cutover chỉ khi mismatch đã được phân loại và P0/P1 = 0.

### 16.7 Rollback gates

| Phase | Có thể rollback | Cách |
|---|---|---|
| Add schema nullable | Có | Stop dual-write, bỏ triggers/views; giữ tables để forensic. |
| Backfill | Có | Không xóa source; truncate/rebuild target theo batch id. |
| Shadow auth | Có | Feature flag về legacy evaluator; giữ mismatch logs. |
| RLS cutover, chưa new posting | Có hạn chế | Re-enable catalog-backed legacy policies đã snapshot; không dùng migration cũ không biết live state. |
| New approval, chưa post | Có | Pause submission, drain/cancel pending theo policy, legacy read-only. |
| New posting đã phát sinh | Không rollback dữ liệu mù | Freeze writes, reconcile, forward-fix; reversal nếu nghiệp vụ yêu cầu. |
| Drop legacy columns/policies | Chỉ sau retention | Restore từ catalog snapshot/migration backup nếu thật sự cần. |

### 16.8 Stop-the-line conditions

- Cross-org negative test đọc/ghi được 1 row.
- Org backfill còn null/unresolved trên money/PII table.
- Tổng cashbook/invoice/KQKD lệch baseline ngoài sai số 0.
- Approval request post hai lần hoặc retry tạo duplicate.
- Function anon/public grant ngoài allowlist.
- Storage object tenant B đọc được bởi tenant A.
- Audit event có thể UPDATE/DELETE bởi authenticated.

---

## 17. Kế hoạch triển khai 8 sprint

### Sprint 0 — Containment và safety harness

**Mục tiêu**: đóng P0 trước khi xây kiến trúc mới.

Deliverables:

1. Sửa `get_my_permissions` **và bản sao `ai_copilot_perms_for`**: orphan => `{}`; tenant owner phải có explicit membership/legacy owner proof tạm thời. (Lý tưởng: gộp hai hàm về một nguồn để hết drift.)
2. Đóng signup tự do/invite-only; loại `useProvisionStaff` browser signUp khỏi flow production.
3. Revoke anon/PUBLIC execute cho internal helpers; xây function ACL allowlist.
4. Fix `_internal_settlement_account`, `_termination_ensure_type` (thêm vào pattern `20260710130500`), recompute helper grants.
5. Fix `pay_draft_fee_voucher` account scope.
6. Chặn direct sensitive approval columns; tạm thời đổi create expense default fail-closed.
7. Baseline data/count/sum/catalog ACL/policy/function hashes.
8. Test harness cross-tenant, direct REST/RPC/Storage.
9. Contain R2 Worker: disable upload ngoài public-sale allowlist hoặc triển khai upload intent + resource authorization; xác minh public origin không lộ private class.
10. Khóa `api/salary-v5-cron.js`: POST + constant-time inbound cron auth; test unauthenticated không kích hoạt Edge job.
11. Contain cashbook opening/lock/archive: cấm client sửa hồi tố `initial_amount/initial_date/user_id`; tách exact action cho lock/archive và tạm require reason/audit cho đến RPC Sprint 5.
12. Contain meter/invoice/deposit/contract orchestration: không cho client tự ghi approver metadata hoặc hard-code `APPROVED`. Riêng invoice có thể mặc định `APPROVED` theo setting `auto_approve_invoice`, nhưng chỉ do RPC atomic phía server áp setting và ghi provenance; nếu chưa có RPC atomic thì feature-flag flow rủi ro hoặc ép DRAFT + reconciliation queue, không tiếp tục fail-open.

Gate: P0 exploit paths đóng; production smoke test; rollback catalog snapshot sẵn.

### Sprint 1 — Organization foundation

1. Tạo organizations, memberships, legacy map, migration exception tables.
2. Seed candidate org/membership trong staging.
3. Thêm nullable org id vào root tables.
4. Backfill building/account/role/area; kiểm cross-owner assignment.
5. Org context API và UI org selector nếu user nhiều org.

Gate: 100% root rows mapped hoặc exception được owner duyệt; không thay production RLS.

### Sprint 2 — Normalized RBAC và scope

1. Permission definitions, roles, permissions, bindings, scopes, overrides.
2. Materialize JSON fallback, migrate per-staff diff.
3. `authorize_v2` + set-returning scope helpers.
4. Shadow comparison old/new trên route/action/resource mẫu.
5. Staff UI draft mới hiển thị exact effective permission/scope/deny.

Gate: decision mismatch = 0 không giải thích; performance p95 đạt ngân sách.

### Sprint 3 — Organization backfill toàn domain và RLS v2

1. Backfill org id theo dependency graph cho toàn bộ bảng nghiệp vụ trong 136 public tables; lập allowlist cho bảng platform/public thay vì mặc định cả 136 đều tenant-owned.
2. Composite FK/check cùng org.
3. Viết RLS v2 deny-default; không OR với legacy policy rộng.
4. Shadow/staging negative tests từng table.
5. Cutover theo domain read trước, write sau.

Gate: zero null/cross-org; direct REST test matrix xanh; snapshot sums khớp.

### Sprint 4 — Approval engine và state model

1. Rule sets/rules/steps/approvers/requests/decisions/audit.
2. Rule admin UI với preview/simulation và publish version.
3. Backfill legacy states/provenance.
4. Maker-checker, policy self-approval theo hạn mức có hậu kiểm và emergency override tách riêng.
5. Generic create/update/submit/self-approve/decide/reverse RPC; approver có thể chọn account và thêm evidence qua versioned snapshot trước post.

Gate: deterministic rule simulation; no-rule=require approval; force-approval không bị hạn mức lách; account ownership/self-approval/review queue và concurrency tests xanh.

### Sprint 5 — Hợp nhất mọi financial mutation

1. Invoice create atomic áp `auto_approve_invoice`; revision `APPROVED` chưa từng thu có version/diff/audit/hậu kiểm.
2. Invoice payment single/bulk + mirror voucher atomic; bulk per-invoice partial success có item result.
3. Cancel/delete payment thành operation đối ứng, không hard-delete.
4. Salary/profit/refund/commission/utility/handover/termination/recurring đi canonical RPC.
5. Internal auto-post allowlist và balanced constraint.
6. Revoke direct DML/state columns từ client roles.
7. Hợp nhất opening balance/lock/archive cashbook, meter+invoice generation, reservation deposit hold 24 giờ và contract-create orchestration; không chỉ voucher/payment hooks.

Gate: generated writer allowlist + runtime/direct-REST audit không còn mutation state/ledger ngoài canonical writer; mọi direct `APPROVED` còn lại chỉ xuất phát từ server contract được allowlist; invoice revision/payment race, operation đối ứng, hold 24 giờ, end-to-end sums và retries xanh.

### Sprint 6 — Staff lifecycle, Storage, Edge và function hardening

1. Invite/suspend/revoke membership; bỏ hard-delete staff.
2. Storage path/org metadata migration và scoped policies.
3. Function ACL allowlist, private impl schema, pinned search path.
4. Edge Function platform/tenant auth separation.
5. Zalo VPS worker/service-role và R2 private delivery hardening; secret/session rotation runbook.
6. Permission cache version/invalidation.

Gate: anon/cross-org/PII/Storage suite xanh; SECURITY DEFINER CI checks xanh.

### Sprint 7 — Cutover, observability và cleanup

1. Canary tenant/users, shadow logs, alert dashboard.
2. Drain pending legacy writes; cutover flags.
3. Reconciliation toàn kỳ: account, invoice, payment, KQKD, salary/profit.
4. Incident runbook, break-glass, rollback/freeze procedure.
5. Sau retention mới drop fallback, legacy policies/RPC/JSON snapshots.
6. Regenerate Supabase types/docs và training owner/admin.

Gate: acceptance criteria mục 20; audit độc lập sign-off; không P0/P1 mở.

---

## 18. Test matrix

### 18.1 Identity/membership

| Case | Expected |
|---|---|
| Anonymous gọi private RPC/table | 401/42501, không side effect. |
| Auth user không membership | Empty context, mọi tenant action denied. |
| Invited chưa accept | Không access data. |
| Suspended/revoked member với token cũ | Backend deny ngay; cache không cứu được. |
| User member hai org | Request org A không nhìn org B; resource mismatch denied. |
| Tenant owner | Full tenant permission nhưng không platform APIs/org khác. |
| Platform admin | Chỉ qua audited platform context, không ngầm dùng tenant role. |

### 18.2 Scope/action

Test Cartesian tối thiểu cho mỗi elevated action:

```text
actor role {allow, deny, no-key}
x scope {org, area, building, cashbook, outside}
x resource tenant {same, other}
x channel {UI, REST table, RPC, Storage}
```

Các case bắt buộc:

- Building-specific member biết UUID building ngoài scope.
- Area member sau khi building được thêm/xóa khỏi area.
- Cashbook A approver thử duyệt request cashbook B.
- Role allow nhưng per-user deny.
- Role deny và per-user allow (deny phải thắng).
- Permission hết hạn giữa lúc mở dialog và submit.
- Resource chuyển building/org (phải cấm cross-org move hoặc re-authorize cả hai).

### 18.3 Approval/rule

1. Exact boundary `amount_min`, `amount_max` và đơn vị tiền.
2. Nhiều rule match; precedence deterministic.
3. Không rule match => PENDING_APPROVAL.
4. Commission/refund/salary/profit luôn require dù generic auto-post match.
5. Maker tự approve phiếu force-approval, phiếu vượt hạn mức, phiếu không có account hoặc account không thuộc binding maker => deny.
6. Phiếu chi thông thường dưới hạn mức + account maker nắm giữ + đủ exact permissions => self-approve/post đúng một lần, gắn rule/limit version và vào hàng hậu kiểm.
7. Chia nhỏ nhiều phiếu/correlation để lách hạn mức => deny/alert; tổng business event vượt ngưỡng phải chờ người khác duyệt.
8. Maker có hai role hoặc owner role vẫn không được normal approve ngoài ngoại lệ hạn mức đã định nghĩa.
9. Owner emergency thiếu/short reason hoặc dùng để né force-approval => deny.
10. Emergency valid => post một lần + decision + alert + audit.
11. Approver bị suspend sau submit => deny decision.
12. Payload thay sau submit => hash/version mismatch; invalidate request. Approver chọn account/thêm ảnh phải tạo snapshot/version cuối có audit trước post.
13. Hai approver click đồng thời => đúng quorum, một posting.
14. Reject và approve cạnh tranh => một terminal outcome.
15. Rule set publish trong khi request pending => request giữ snapshot version.
16. Suspend/revoke làm candidate thấp hơn quorum => escalate theo policy, không tự hạ quorum hoặc để request ở PENDING_APPROVAL mà không cảnh báo.
17. Reassign candidate => payload/rule snapshot không đổi, version tăng, candidate cũ giữ history và audit actor/reason.
18. Hai request đồng thời cùng subject => partial unique chỉ cho một PENDING_APPROVAL.
19. Hai posting path cạnh tranh => unique posting-side guard chỉ cho một posting event/batch; multi-leg hợp lệ cùng batch.
20. Rule `DENY` => request terminal DENIED, không step/decision/posting; retry cùng key trả cùng outcome.
21. `AUTO_POST` => request terminal POSTED, không step; posting failure rollback cả request/subject effect.
22. Multi-step: chỉ step thấp nhất PENDING; quorum promote đúng một next step; reject hủy các step sau.
23. Rematerialize candidate tạo generation mới, decision cũ vẫn trỏ generation cũ; emergency không cần candidate nhưng phải gắn active step.

### 18.4 Financial atomicity/idempotency

- Network timeout sau commit rồi retry cùng key => cùng response/resource.
- Tạo hóa đơn với `auto_approve_invoice` bật => server tạo invoice+items/credit atomic ở `APPROVED`, metadata cho biết auto-approved theo setting/version; client không giả actor.
- Tắt `auto_approve_invoice` => cùng create path tạo `DRAFT`; chỉ RPC approve có permission mới chuyển `APPROVED`.
- Sửa invoice `APPROVED` chưa thu => chỉ thành công khi `paid_amount=0` và không có payment hiệu lực dưới row lock; revision lưu before/after/reason/actor và vào hàng hậu kiểm.
- Payment được tạo đồng thời với revision approved-unpaid => chỉ một transaction thắng theo lock/version; không sửa invoice dựa trên kiểm tra cũ.
- Invoice đã từng có payment rồi hoàn tác => không được đi đường sửa approved-unpaid thông thường.
- Hai collector thu cùng invoice => lock/remaining check; không overpay phantom.
- Item insert failure => không còn voucher/payment orphan.
- Voucher post failure => payment/invoice rollback.
- Bulk payment một invoice lỗi => per-invoice atomic; các dòng khác có thể thành công và kết quả/retry từng dòng ổn định.
- Hoàn tác payment hai lần => lần hai trả operation cũ, không tạo thêm bút toán đối ứng; payment/posting gốc không bị xóa.
- Internal transfer một chân lỗi => toàn transaction rollback.
- Salary payout post => voucher, salary paid, optional rent payment cùng commit.
- Profit/refund approve => cashbook effect và subject status cùng commit.
- Posted voucher direct update/delete qua REST => denied.
- Direct sửa `accounts.initial_amount/initial_date/user_id`, lock/unlock/archive không exact action/reason/version => denied.
- Generate reading+invoice lỗi ở bất kỳ leg nào => không còn APPROVED reading/invoice/credit orphan; retry không duplicate.
- Reservation deposit submit => hold phòng đúng 24 giờ; concurrent deposit không tạo hai hold hiệu lực; approve chuyển reservation một lần; reject/cancel/expiry giải phóng; approve sau expiry phải revalidate availability.
- Reservation deposit/contract submit lỗi giữa tenant/contract/voucher/item/room/invoice => rollback business event hoặc tạo item result/reconciliation theo contract đã công bố, không trạng thái im lặng.

### 18.5 RLS/RPC/Storage/Edge

- Chạy `scripts/test-cross-tenant.mjs` mở rộng cho toàn domain.
- Enumerate mọi executable RPC bằng anon/auth; so allowlist.
- Call helper/recompute/trigger function trực tiếp => permission denied.
- Storage A dùng exact object name B: SELECT/signed URL/update/delete denied.
- Upload path giả org B denied.
- R2 A chọn key/prefix B hoặc private bucket class denied; overwrite existing object denied; direct public-base URL không đọc được private class.
- Edge function JWT invalid/expired, wrong org, wrong permission, service request thiếu source => denied.
- CORS origin hợp lệ nhưng no auth => vẫn denied.
- Gọi Vercel salary cron không có/sai Bearer secret => không forward và không tạo `cron_runs`.
- JWT forged claim `role=service_role` gọi `send-push` => denied.

### 18.6 Performance

- `authorize` p95 < 20 ms trong DB cho point check mục tiêu; report scope query không N+1.
- Index coverage bằng `EXPLAIN (ANALYZE, BUFFERS)` trên dữ liệu scale 10x.
- Không gọi `auth.uid()`/JSON parse subquery lặp đắt trên từng row nếu có thể init-plan/set-based.
- Permission context cache key chứa org+authorization_version.

### 18.7 Property-based tests

Vitest + fast-check:

- Deny precedence không phụ thuộc thứ tự binding.
- Scope union không bao giờ tạo resource ngoài union đầu vào.
- Rule matching deterministic với cùng snapshot.
- State machine không có đường từ POSTED về mutable state.
- Idempotency cùng key/payload tạo một effect; cùng key khác payload bị conflict.
- Internal postings tổng debit-credit/net effect theo rule bằng 0.

---

## 19. Reconciliation và observability

### 19.1 Trước/sau migration

So sánh theo `organization_id`, building, account, month, status:

- row count và sum `income_expenses.total_amount` theo type/status;
- account opening + posted income - posted expense + change/rounding semantics;
- payments sum, invoice paid/remaining/status;
- deposit/excess balances;
- KQKD item-level, loại deposit/internal;
- salary/profit paid/locked totals;
- count attachment links và unresolved objects;
- membership/role/scope effective permission samples.

Mọi batch lưu `batch_id`, query hash, before/after counts và operator id; không log PII/token.

### 19.2 Runtime metrics

- authorization deny rate theo permission/resource/channel;
- cross-org mismatch attempts;
- orphan/no-membership sessions;
- pending approval age/SLA;
- emergency override count theo owner/month;
- duplicate idempotency conflict;
- posting/reconciliation mismatch;
- function 42501/invalid transition rate;
- signed URL denied/cross-org path attempts.

Alert tức thời cho emergency override, cross-org probe, duplicate posting attempt và audit mutation attempt.

---

## 20. Tiêu chí nghiệm thu bắt buộc

1. **Explicit tenant**: mọi money/PII/business row có `organization_id NOT NULL` hoặc được chứng minh là platform/public.
2. **Orphan fail closed**: auth user không active membership nhận zero tenant permission; không sentinel owner/super-admin.
3. **Cross-tenant zero access**: ma trận direct REST/RPC/Storage/Edge giữa A và B đều deny, kể cả biết UUID/path.
4. **Backend exact action**: 100% mutation và elevated action trong catalog có server-side permission check tương ứng; frontend-only không được tính đạt.
5. **No direct posting/balance mutation**: client không thể tự insert/update trạng thái tài chính `APPROVED/POSTED`, approver metadata, payment ledger/posted items hoặc sửa opening balance/period lock/archive ngoài canonical RPC. Invoice `APPROVED` theo setting và self-approved ordinary expense chỉ được tạo/post bởi server RPC khi toàn bộ contract tương ứng đạt.
6. **State machine**: DRAFT/PENDING_APPROVAL/POSTED/DENIED/REJECTED/CANCELLED/REVERSED tách nghĩa; rule-deny khác human-reject; posted immutable, sửa bằng reversal.
7. **Rule correctness**: force categories luôn approval; no match=require; internal auto-post chỉ allowlist cân bằng.
8. **Maker-checker có ngoại lệ đóng**: mặc định maker không normal approve. Chỉ phiếu chi thông thường dưới hạn mức, trên account maker nắm giữ và có exact permissions mới được self-approve; force-approval luôn chờ người khác; self-approval bắt buộc hậu kiểm. Owner emergency cần reason/re-auth/audit/alert và không được dùng để né force-approval.
9. **Atomic/idempotent money**: payment/voucher/items/account/invoice/subject commit một lần; retry không duplicate. Payment sai được hoàn tác bằng operation đối ứng liên kết bản gốc, không hard-delete.
10. **Invoice governance**: `auto_approve_invoice` mặc định bật nhưng có thể tắt; mọi create path áp setting phía server. Invoice `APPROVED` chưa từng có payment được revision bởi đúng permission với lock/version/reason/diff/audit và hàng hậu kiểm; invoice đã có lịch sử payment không đi đường sửa này.
11. **Audit provenance**: không giả mạo approver lịch sử; decision/state/security event không UPDATE/DELETE bởi app roles.
12. **Definer/ACL hardening**: zero internal/helper/trigger function executable bởi anon/PUBLIC; public RPC đúng allowlist, search_path và guard.
13. **Storage/Edge isolation**: object và service action cùng organization/resource scope; authenticated-wide PII read không còn.
    Bao gồm Supabase Storage, Cloudflare R2/custom domain, Vercel API routes và long-running VPS workers; không chỉ `supabase/functions`.
14. **Staff lifecycle**: invite/suspend/revoke thay browser signUp/hard delete; owner cuối được bảo vệ.
15. **Data parity**: account/invoice/payment/KQKD/salary/profit reconciliation khớp baseline trước cutover.
16. **Operational readiness**: metrics, alerts, freeze/reversal/runbook, catalog snapshot và rollback gate đã diễn tập.
17. **Reservation hold**: cọc `PENDING_APPROVAL` hold phòng độc quyền 24 giờ, không double-hold; mọi approve/reject/cancel/expiry transition có lock, audit và idempotency.

---

## 21. Danh sách P0–P3 để agent audit đối chiếu

### P0 — xử lý ngay

- `get_my_permissions()` orphan => `__superadmin`. **Phải fix cùng lúc bản sao `ai_copilot_perms_for()`** (`20260710200000_ai_copilot_backend.sql`) — cùng nhánh fail-open, dùng ở `reserve_ai_usage`. Xem mục 5.2.
- Hai auth user live thuộc nhánh orphan; xác minh identity và revoke/assign đúng.
- `SECURITY DEFINER` internal helpers callable anon, đặc biệt `_internal_settlement_account`, `_termination_ensure_type` — live vẫn `anon`+`authenticated` execute; migration revoke `20260710130500` đã có pattern nhưng **bỏ sót đúng 2 hàm này**, chỉ cần thêm 2 dòng (mục 9.2).
- Direct creation/update `APPROVED` trên financial paths.
- Payment/voucher/item non-atomic cho single/bulk/refund/salary.
- Direct `accounts.initial_amount/initial_date` và cashbook lock/archive mutation ngoài state machine.
- Meter reading `APPROVED` + invoice generation tách transaction ở dialog đơn và Excel batch.
- Contract/deposit/reservation orchestration nhiều request có thể để room, contract, tenant, invoice và ledger split-brain.
- Browser staff provisioning bằng `auth.signUp` nếu flow còn reachable.
- R2 Worker cho mọi authenticated user upload arbitrary key và trả public-base URL, chưa tenant/resource scope.
- Vercel salary cron route không auth inbound nhưng tự forward trusted cron secret.

### P1 — trước tenant/approval cutover

- 110 secdef anon-executable cần classify/revoke allowlist.
- `approve_voucher` cho creator tự duyệt.
- `unapprove`/hard-delete payment phá finality.
- `pay_draft_fee_voucher` account scope không phản ánh shared/scoped permission đúng.
- Storage SELECT của 7 bucket trong `20260601000200_sec_private_buckets.sql` là `TO authenticated` chỉ theo bucket; `document-templates` là owner/legacy-visibility folder-scoped.
- `send-push` nhận diện service role bằng decode JWT claim; phải harden/verify deployment gateway.
- Write path invoice/payment legacy (`usePayments`, `useInvoices::useRecordPayment`, `invoiceHelpers`, `useContracts`, `useContractOperations`) chưa nằm sau RPC atomic — xem mục 8.1.2.
- Vòng đời status cấp invoice (`useApproveInvoice`/`useUnapproveInvoice`/`useCancelInvoice`/`useRestoreInvoice`/`useForceCancelInvoice`/`useBulkApproveInvoices`/`useCheckOverdueInvoices`) ghi trực tiếp `invoices.status`, chưa có state machine — xem mục 8.1.1.
- Action chi tiết chỉ FE + legacy fallback rộng.
- Hard-delete auth user qua `delete_staff_member`.

### P2

- Permission cache 5 phút không có version invalidation.
- First-assignment-wins permission resolution.
- JSONB permission không normalized/FK.
- Org-global resources vẫn dùng visible-owner graph.
- `AdminOnlyRoute` naming/semantics lẫn platform và tenant UX.
- Migration ledger không đáng tin so với live catalog.

### P3

- Rename audit-only `user_id` thành `created_by` sau khi cutover ổn định.
- Chuyển từ voucher-as-ledger sang append-only posting lines nếu cần accounting/audit sâu hơn.
- External tamper-evident audit sink.

---

## 22. Artifact bắt buộc trong mỗi PR triển khai

1. Threat/permission change summary.
2. Migration SQL + forward-only repair + rollback/freeze note.
3. Catalog before/after diff: tables, policies, functions, ACL, triggers.
4. Data backfill query, batch size, retry/idempotency.
5. Direct API negative tests, không chỉ component tests.
6. Financial reconciliation output nếu chạm money path.
7. `npx tsc --noEmit` và test liên quan.
8. Browser happy path + edge case + console check.
9. Không chứa PAT/password/service key/signed URL.
10. Audit sign-off cho P0/P1/elevated action.

---

## 23. Câu hỏi agent audit phải trả lời

Agent audit không được chỉ review tài liệu; phải kiểm tra live catalog và code:

1. Có còn auth user nào được coi owner chỉ vì thiếu assignment không?
2. `get_my_permissions` live definition/ACL có đúng file Git không?
3. Danh sách đầy đủ 110 secdef anon-executable là gì, cái nào thực sự exposed qua PostgREST, cái nào nested-only nhưng vẫn grant thừa?
4. Có overload nào bị bỏ sót khi revoke/grant theo signature không?
5. Mọi direct table financial write path đã được liệt kê chưa, gồm component/lib/Edge/cron/trigger?
6. RLS policy nào OR-merge làm rộng quyền ngoài policy mới?
7. Mọi nullable-building org entity có tenant filter ở cả USING và WITH CHECK không?
8. Cross-owner building assignment live là business delegation hay data anomaly?
9. Rule priority/condition có deterministic và không có gap/tie không?
10. Approval/posting có lock đúng row và unique constraint chống double post không?
11. Reversal có bảo toàn invoice/account/KQKD/deposit/excess semantics không?
12. Storage object path cũ map được bao nhiêu %, unresolved xử lý ra sao?
13. Edge Function nào dùng service role nhưng chưa tự authz?
14. Backfill approved history có vô tình tạo approver giả không?
15. Rollback có thực tế sau khi new posting phát sinh hay phải freeze/forward-fix?
16. R2 custom domain có cho đọc trực tiếp object ngoài `/file` Worker không, và bucket class nào đang public thật sự?
17. Vercel cron route có chứng minh caller là Vercel Cron trước khi gắn internal secret không?
18. Có FK/composite FK nào trong schema approval cho phép ghép request-step-decision khác subject/org không?

---

## 24. Prompt bàn giao cho agent AI audit độc lập

Sao chép nguyên khối sau cho agent audit:

```text
Bạn là security architect + PostgreSQL/Supabase auditor độc lập. Hãy audit
docs/AUTHORIZATION-PLAN.md, không mặc nhiên tin bất kỳ kết luận nào trong file.

Mục tiêu:
1) Đối chiếu code hiện tại, toàn bộ supabase/migrations, live pg_catalog,
   pg_policies, pg_proc/proacl, Storage policies/buckets và Edge Functions.
2) Tái lập route -> permission -> hook -> RPC/table -> RLS/function guard matrix.
3) Liệt kê mọi đường ghi ảnh hưởng tiền và chứng minh transaction, state,
   authorization, idempotency, maker-checker của từng đường.
4) Thử negative tests với anon, orphan auth user, staff tenant A/B, building-only,
   area-only, cashbook-only, shareholder, tenant owner và platform super-admin.
5) Review schema mục tiêu cho organization FK consistency, deny precedence,
   polymorphic scope, rule determinism, approval concurrency và immutable audit.
6) Review backfill/rollback: tìm mọi suy luận owner/org sai, dữ liệu mơ hồ,
   fake approver, split-brain dual-write và điểm không thể rollback.

Yêu cầu đầu ra:
- Findings P0/P1/P2/P3 có file/function/policy/query evidence.
- Bảng VERIFIED / NOT VERIFIED / INCORRECT cho từng live fact trong plan.
- Danh sách lỗ hổng hoặc write path plan bỏ sót.
- DDL/schema corrections cụ thể nhưng KHÔNG chạy migration.
- Test cases bổ sung và stop-the-line conditions.
- Kết luận GO / GO WITH CHANGES / NO-GO cho từng sprint.

An toàn:
- Chỉ chạy query đọc; không sửa live DB.
- Không in/log secret.
- Không coi frontend gate là authorization.
- Không coi private bucket hoặc RLS enabled là đủ nếu policy/RPC vẫn rộng.
```

---

## 25. Truy vấn read-only gợi ý cho audit

### Function ACL

```sql
SELECT p.oid::regprocedure, p.prosecdef, p.proowner::regrole,
       p.proconfig, p.proacl,
       has_function_privilege('anon', p.oid, 'EXECUTE') anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.oid::regprocedure::text;
```

### RLS và policy roles

```sql
SELECT c.oid::regclass, c.relrowsecurity, c.relforcerowsecurity,
       p.policyname, p.cmd, p.roles, p.qual, p.with_check
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
LEFT JOIN pg_policies p
  ON p.schemaname=n.nspname AND p.tablename=c.relname
WHERE n.nspname='public' AND c.relkind='r'
ORDER BY c.relname, p.policyname;
```

### Cross-organization consistency sau backfill

```sql
-- Mẫu; lặp cho mọi parent-child.
SELECT count(*)
FROM invoices i
JOIN buildings b ON b.id=i.building_id
WHERE i.organization_id IS DISTINCT FROM b.organization_id;
```

### Approval provenance

```sql
SELECT type, approval_status, count(*) AS n,
       count(*) FILTER (WHERE approval_status='APPROVED'
                         AND approved_by IS NULL) AS missing_approver
FROM income_expenses
WHERE deleted_at IS NULL
GROUP BY type, approval_status;
```

Các query này là template; agent phải điều chỉnh theo schema live và không đưa credentials vào file/log.

---

## 26. File bằng chứng chính

| File | Vai trò |
|---|---|
| `src/App.tsx` | Route và route guards. |
| `src/lib/permissions.ts` | Registry module/action, cảnh báo FE-only actions. |
| `src/lib/permissionPages.ts` | Catalog theo trang và legacy fallback. |
| `src/hooks/useMyPermissions.ts` | Permission RPC/cache/sentinel consumption. |
| `src/hooks/useStaffAssignments.ts` | Provision/update/delete staff và per-user snapshots. |
| `src/hooks/income-expenses/mutations.ts` | Generic voucher direct writes. |
| `src/hooks/income-expenses/statusMutations.ts` | Approve/unapprove/cancel/restore. |
| `src/hooks/useBulkRecordPayment.ts` | Bulk payment direct multi-write. |
| `src/hooks/useInvoicePayments.ts` | Payment RPC + client mirror voucher/refund. |
| `src/hooks/useManagerSalary.ts` | Salary lock/commission approval/payout. |
| `src/hooks/income-expenses/specialized.ts` | Profit/manager payout voucher. |
| `src/hooks/useAccounts.ts` | Opening balance, lock/unlock và archive cashbook direct writes. |
| `src/components/invoices/GenerateInvoiceDialog.tsx` | Reading APPROVED và invoice generation tách request. |
| `src/hooks/invoices/useExcelInvoiceData.ts` | Batch reading/invoice partial-success phía client. |
| `src/components/contracts/contract-form/useContractSubmit.ts` | Contract/deposit/invoice/reservation orchestration nhiều request. |
| `src/pages/phong-trong/QuickDepositModal.tsx` và `src/components/deposits/CreateDepositDialog.tsx` | Reservation deposit/voucher/item/room side effects. |
| `20260701170000_shareholder_scope_split.sql` | Effective repository definition của `get_my_permissions`. |
| `20260710150000_tenant_isolation_hardening.sql` | Cross-tenant hardening hiện có. |
| `20260703160000_approve_voucher_permission_guard.sql` | Approval guard history. |
| `20260704090000_termination_refund_single_draft_voucher.sql` | Account-required approval/refund draft. |
| `20260710120300_recurring_draft_mode.sql` | Recurring draft + atomic pay draft. |
| `20260704120000_termination_internal_ledger.sql` | Internal settlement helper/ledger. |
| `20260601000200_sec_private_buckets.sql` | Đóng 7 bucket và tạo authenticated-wide read chỉ theo bucket; không gồm `document-templates`. |
| `supabase/functions/*` | Service-role/JWT/secret trust boundaries. |
| `infra/cloudflare-worker/src/index.ts` | R2 upload/public delivery boundary; hiện auth-only, chưa resource authorization. |
| `api/salary-v5-cron.js` | Vercel cron ingress; hiện chưa verify inbound caller. |
| `worker/index.js` | Zalo worker giữ service-role/session credentials và bypass RLS. |

---

## 27. Kết luận và kế hoạch thực thi đã hiệu chỉnh

### 27.1 Phán quyết hiện tại

| Phạm vi | Phán quyết |
|---|---|
| Tiếp tục audit, sửa tài liệu, thiết kế contract và viết test/harness không ghi production | **GO WITH CHANGES** |
| Coi plan này là migration/runbook có thể áp ngay hoặc merge branch để triển khai tự động | **NO-GO** |
| Wire `submit_financial_voucher`/`decide_financial_voucher` hiện tại vào UI | **NO-GO** |
| Chuẩn bị artifact containment approval RPC đang mở | **GO — P0 ưu tiên** |
| Áp containment, migration, callable RPC, RLS/ACL/Storage hoặc behavior flip lên production | Chỉ khi owner ra lệnh riêng cho đúng tranche, sau review bằng chứng/gate |

Rà soát độc lập ngày 2026-07-14 xác nhận approval prototype hiện chưa đạt acceptance: RPC đang callable bởi `authenticated`, submit chỉ kiểm membership, tin classification client, chưa có idempotency DB đúng nghĩa, payload revalidation, audit events, resubmit contract hoặc reversal state hoàn chỉnh. `record_invoice_payment_v3` đã wire nhưng vẫn phải re-audit exact `thu_tien.collect`, same-org/scope foreign IDs và atomic idempotency. Vì vậy không được coi “0 UI caller”, “feature flag OFF” hoặc “RPC additive” là security boundary.

### 27.2 Quyết định nghiệp vụ được owner duyệt ngày 2026-07-15

Các quyết định dưới đây thay thế mọi câu mâu thuẫn ở phần thiết kế cũ:

1. **Hóa đơn mới mặc định `APPROVED`**, có setting tổ chức `auto_approve_invoice` để bật/tắt. Setting được áp phía server cho mọi create path; tắt thì tạo `DRAFT` và cần duyệt.
2. **Invoice `APPROVED` chưa từng có payment được phép sửa có kiểm soát** bởi nhân viên có permission riêng: lock + expected version + reason + revision trước/sau + audit + hàng hậu kiểm cho kế toán/owner. Invoice đã có lịch sử payment không đi đường sửa này.
3. **Payment không bị xóa để hoàn tác.** Hệ thống tạo operation/bút toán đối ứng liên kết bản gốc, recompute hóa đơn và giữ cả hai để truy vết; UI dùng nhãn “Hủy giao dịch thu tiền (tạo bút toán hoàn tác)”.
4. **Maker-checker có ngoại lệ đóng:** phiếu chi thông thường dưới hạn mức có thể được maker tự duyệt chỉ trên sổ quỹ maker nắm giữ, có exact permission và bắt buộc hậu kiểm. Force-approval (hoa hồng, thưởng, refund/cọc, lương, lợi nhuận, hợp đồng/thanh lý và rule bắt buộc khác) luôn chờ người khác, không xét hạn mức.
5. Maker chỉ được chọn sổ quỹ mình nắm giữ khi tạo bất kỳ phiếu chi nào. Nếu không có sổ phù hợp, phiếu chờ duyệt được phép để trống sổ; tại final decision, kế toán/owner chọn sổ họ được post và bổ sung ảnh chứng từ, rồi hệ thống snapshot/version/audit lại trước khi ghi tiền. Maker không được chọn sổ của người khác chỉ vì phiếu sẽ chờ duyệt; phiếu thiếu sổ không đủ điều kiện maker tự duyệt.
6. **Cọc `PENDING_APPROVAL` hold phòng độc quyền 24 giờ** theo giờ server. Approve/post chuyển thành reservation; reject/cancel/expiry giải phóng; approve sau expiry phải kiểm tra phòng lại.
7. Bulk payment dùng **per-invoice atomic/partial success có kết quả từng dòng**; retry không thu lại dòng đã thành công.
8. Điều chỉnh số dư đầu kỳ luôn qua approval; bàn giao tiền cần bên nhận xác nhận; suspend nhân viên deny backend ngay nhưng giữ identity/history; restore/force-cancel chỉ support repair; cutover theo domain; legacy mơ hồ vào review queue.
9. Con số **51 hạng mục/163 ngày chỉ là baseline inventory ban đầu**, không phải tổng chương trình hay cam kết tiến độ.

### 27.3 T1 thiết kế lại — không bắt đầu bằng reversal/wiring

```text
T1a containment exposed approval RPC
  -> T1b re-audit/harden payment v3
  -> T2 RBAC source-of-truth + dual-write + staff lifecycle + authorization version
  -> T3 approval contract v2 + rule governance + self-limit policy + reversal, chưa wire
  -> T4 direct REST/RPC/Storage + concurrency + reconciliation harness, observability/runbook
  -> T5 canonical writer theo domain, callable grant review riêng
  -> T6 RLS v2 shadow/read validation và cutover từng domain
  -> T7+ B-money canary/flip/drain/revoke từng domain
  -> T8 Storage/R2 và full SECURITY DEFINER ACL burn-down
  -> T9 retention, cleanup và legacy removal
```

**T1a — containment:** phương án mặc định để review là revoke `EXECUTE` của `submit_financial_voucher` và `decide_financial_voucher` khỏi `authenticated` vì hiện chưa có UI caller. Chỉ áp live khi owner ra lệnh riêng. Chỉ grant lại sau contract v2 và direct REST negative tests.

**T1b — payment v3:** đổi sang exact permission `thu_tien.collect`; authorize account/change/rounding/item IDs theo org/scope; idempotency operation phải unique atomically theo org+operation+subject+caller+key và payload hash; same key/different payload conflict; không lookup/trả ID xuyên tenant.

**T3 — approval contract v2:** hoàn thiện state machine/constraints, subject lock/version, immutable/revalidated snapshot, submission number/resubmit, candidate generation và ANY/ALL/QUORUM, affected-row assertions, audit events, rule lifecycle/bootstrap/publish/retire, maker self-approval limit policy, approver chọn account/evidence, posting và operation đối ứng. Chưa expose/wire production trong tranche này.

### 27.4 Cutover theo domain

Không dùng một lần `REVOKE DML` khổng lồ. Mỗi domain — invoice, payment/credit, thu-chi, cashbook, meter/invoice, deposit/contract, salary/profit — phải đi qua cùng gate:

1. Inventory mọi writer từ code/catalog/runtime và chứng minh canonical replacement.
2. Shadow/dual-path khi có thể; direct API allow/deny tests bằng JWT thật.
3. Chốt maintenance window, canary organization/transaction class và freeze procedure.
4. Chụp reconciliation pre-state, catalog/function/policy/ACL hashes và xác nhận backup/PITR/restore procedure.
5. Bật state-transition/RLS guard phía server; flip frontend dưới flag.
6. Drain writer cũ, revoke direct DML đúng domain/signature, không dựa vào grep đơn thuần.
7. Reconcile post-state, theo dõi deny rate/RPC error/idempotency conflict/approval SLA/drift và so abort threshold.
8. Nếu ledger mới đã post, không rollback bằng xóa dữ liệu: freeze, forward-fix hoặc tạo operation đối ứng có audit.

Với bảng dùng chung như `income_expenses`, có thể chặn direct `APPROVED/POSTED` trước nhưng tạm cho canonical/direct `DRAFT` có guard cho tới khi tất cả writer domain được migrate.

### 27.5 Tracker chính thức

| Tranche | Nội dung | Trạng thái |
|---|---|---|
| T0a | Inventory/dossier ban đầu | **Đã làm** |
| T0b | Independent audit + hiệu chỉnh plan + quyết định nghiệp vụ owner | **Đã làm trong tài liệu; chưa triển khai runtime** |
| T1a | Contain/harden exposed approval RPC | Chưa triển khai; cần review và lệnh owner riêng |
| T1b | Re-audit payment v3 permission/scope/idempotency | Chưa |
| T2 | RBAC synchronization, staff lifecycle, authorization-version | Chưa |
| T3 | Approval contract/rule governance/self-limit/reversal, chưa wire | Chưa |
| T4 | Authorization/API/concurrency/reconciliation harness + observability/runbook | Chưa |
| T5 | Canonical writers theo domain; invoice setting/revision; hold 24h | Chưa |
| T6 | RLS v2 shadow + per-domain read/write cutover | Chưa |
| T7+ | B-money canary/flip/drain/revoke theo domain | Chưa |
| T8 | Storage/R2 + full ACL baseline burn-down | Chưa |
| T9 | Retention, cleanup, legacy removal, types/docs/training | Chưa |

Không công bố estimate tổng mới trước khi T1–T9 được phân rã thành deliverable/dependency với schema/code inventory cập nhật. Baseline 51/163 chỉ dùng để truy nguồn inventory cũ.

### 27.6 Cửa GO tối thiểu

Chỉ được canary một tranche khi tất cả điều liên quan đều đạt:

- Approval RPC không còn membership-only/client-classification bypass; callable grant có exact permission và direct REST negative tests.
- Payment v3 dùng exact collect permission, same-org/scope validation và idempotency atomic có conflict semantics.
- RBAC legacy/v2 không còn mismatch chưa giải thích; mọi mutation quyền bump invalidation; suspend/revoke có hiệu lực backend ngay mà không xóa lịch sử.
- Approval engine revalidate payload/state/version, assert affected rows, resubmit/concurrency đúng và ghi append-only audit.
- Force-approval không thể bị lách bởi hạn mức hoặc chia nhỏ phiếu; self-approval chỉ đúng account maker nắm giữ và luôn vào hậu kiểm.
- Invoice create setting được server enforce; approved-unpaid revision không race với payment và có before/after audit/hậu kiểm.
- Payment hoàn tác tạo đúng một operation đối ứng, giữ original và reconciliation invoice/account/credit bằng nhau.
- Hold cọc 24 giờ không double-book; expiry/approval race có lock và kết quả xác định.
- Cross-tenant REST/RPC/Storage/Edge tests pass trên hai organization thật, non-null org và JWT thật.
- Mọi `SECURITY DEFINER` trong tranche có signature ACL explicit, pinned search path; baseline exposure không tăng và có burn-down plan.
- Generated Supabase types không drift; view invoker check chạy khi đụng view.
- Reconciliation pre/post khớp cho INCOME/EXPENSE, invoice/payment/credit/deposit, salary/profit, cashbook, meter/invoice và operation đối ứng.
- Dashboard, alert, abort criteria, freeze/forward-fix/incident runbook, backup/PITR và maintenance window sẵn sàng.
- Có lệnh owner rõ ràng cho **đúng tranche**; phê duyệt tài liệu không tự động là phê duyệt áp production.

### 27.7 Kết luận cuối

Không nên vá thêm action JSONB hoặc approval flag rồi gọi là hoàn thiện. Hướng đúng là explicit organization boundary, normalized authorization có đồng bộ, state machine/RPC canonical theo từng domain và approval/posting có transaction, idempotency, audit và reconciliation.

Trạng thái hiện tại vẫn là **NO-GO cho runtime cutover**. Bước triển khai đầu tiên hợp lệ là chuẩn bị/review T1a containment và T1b payment-v3 hardening; chưa wire approval prototype, chưa bắt đầu `reverse_financial_posting`, chưa revoke DML/RLS/Storage/ACL trên production nếu thiếu artifact, gate và lệnh owner riêng.
