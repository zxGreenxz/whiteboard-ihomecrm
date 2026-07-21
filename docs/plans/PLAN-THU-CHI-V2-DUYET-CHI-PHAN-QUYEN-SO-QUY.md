# Kế hoạch triển khai Thu Chi V2: Duyệt, Thu/Chi và phân quyền sổ quỹ

| Thuộc tính | Giá trị |
|---|---|
| Baseline đã đối chiếu | `origin/main` tại `bba7bd3` ngày `2026-07-21` |
| Trạng thái | Kế hoạch bàn giao; **chưa triển khai code/schema production** |
| Route chính | `/payments/income-expenses` |
| Route liên quan | `/approvals`, cài đặt sổ quỹ, báo cáo lợi nhuận và chốt kỳ |
| Artifact nghiệp vụ | `/08-ke-hoach-phat-trien/quy-trinh-chi-phi/` |
| Mục tiêu cutover | Một cơ chế duy nhất: phê duyệt độc lập với ghi sổ, quyền theo từng sổ, fail closed tại server |

## 1. Tóm tắt điều hành

Hệ thống hiện dùng `income_expenses.approval_status = 'APPROVED'` cho hai nghĩa khác nhau:

1. khoản thu/chi đã được người có thẩm quyền duyệt;
2. tiền đã thực sự được ghi vào hoặc ra khỏi sổ quỹ.

Sự gộp nghĩa này làm nút Duyệt đồng thời thay đổi tồn quỹ, làm báo cáo tiền thật phụ thuộc trạng thái workflow, và khiến nhiều writer/report dùng `APPROVED` như một proxy không chính xác. Song song đó, RLS hiện cho phép một số user nhìn thấy sổ của đồng nghiệp hoặc toàn bộ giao dịch theo phạm vi tòa nhà; danh sách `account_shared_users` cũng đang cấp quyền rộng hơn nghiệp vụ mới.

Thu Chi V2 phải tách bốn trục độc lập:

- **Ghi nhận KQKD:** khoản thu/chi thuộc kỳ lợi nhuận nào.
- **Phê duyệt:** khoản đó đã được phép thực hiện hay chưa.
- **Ghi sổ:** tiền đã thực sự Thu/Chi hay chưa và từ sổ nào.
- **Phân quyền sổ:** user được thấy và thao tác sổ/giao dịch nào.

Không được sửa riêng UI hoặc đổi một badge. Đây là migration cross-cutting qua schema, RLS, RPC, approval engine, số dư sổ quỹ, báo cáo, chốt kỳ, phiếu hệ thống, batch, recurring, import, desktop/mobile và test dữ liệu tiền.

## 2. Quyết định nghiệp vụ bắt buộc

### 2.1. Trạng thái và cách gọi

- Bỏ hoàn toàn khái niệm **Nháp** trong Thu Chi.
- `UNAPPROVED + review_state=PENDING` hiển thị **Chờ duyệt**; tuyệt đối không gọi Nháp.
- `CHANGES_REQUESTED` và `DISPUTED` là substate xử lý riêng, hiển thị **Cần bổ sung** hoặc **Đang tranh chấp**, không quay lại khái niệm Nháp.
- `APPROVED + UNPOSTED` với phiếu chi hiển thị **Đã Duyệt - Chưa Chi**.
- `APPROVED + UNPOSTED` với phiếu thu hiển thị **Đã Duyệt - Chưa Thu**.
- Chỉ `POSTED` mới hiển thị **Đã Chi** hoặc **Đã Thu** và thay đổi số dư sổ quỹ.
- Giai đoạn đầu chỉ hỗ trợ Thu/Chi **đủ một lần**; không thanh toán một phần và không chia một phiếu qua nhiều sổ.

### 2.2. Duyệt và Thu/Chi

- Người có `income_expenses.approve` bấm Duyệt trên phiếu Chờ duyệt thấy hai lựa chọn:
  - **Duyệt:** chỉ chuyển trạng thái phê duyệt, không thay đổi sổ quỹ.
  - **Thu/Chi:** phê duyệt và ghi sổ trong cùng một transaction.
- Nhánh Thu/Chi chỉ được thực hiện khi actor đồng thời là **Người giữ sổ** của sổ được chọn.
- Mọi lần Chi thủ công bắt buộc đủ:
  - ngày chi;
  - sổ quỹ;
  - hình ảnh chứng từ.
- Với Phiếu thu, dùng cùng contract `ngày thu + sổ quỹ + hình ảnh/chứng từ thu` để giữ mô hình đối xứng.
- Nếu post thất bại, nhánh Duyệt và Thu/Chi phải rollback toàn bộ; không để phiếu ở trạng thái duyệt dở dang.
- Phiếu đã duyệt có thể được một Người giữ sổ khác Thu/Chi sau; người này không cần quyền duyệt.

### 2.3. Lợi nhuận và chốt kỳ

- Nghĩa vụ KQKD hợp lệ được đưa vào báo cáo theo kỳ áp dụng dù đang Chờ duyệt.
- Báo cáo phải hiện số phiếu và số tiền Chờ duyệt của kỳ.
- Còn phiếu Chờ duyệt thuộc KQKD thì server từ chối chốt kỳ.
- Phiếu **Đã Duyệt - Chưa Chi/Thu** không chặn chốt vì dữ liệu lợi nhuận đã đầy đủ; đây là khoản phải trả/phải thu đang chờ thực hiện.
- Màn hình chốt vẫn hiển thị số lượng và tổng tiền Đã Duyệt - Chưa Chi/Thu như cảnh báo thông tin.
- Thu/Chi sau khi khóa kỳ không thay đổi snapshot lợi nhuận đã chốt.
- `posted_on` phải thuộc kỳ sổ quỹ đang mở; không backdate tiền thật vào kỳ sổ quỹ đã khóa.

### 2.4. Hai vai trò trên từng sổ quỹ

**Người giữ sổ (`CUSTODIAN`)**:

- thấy sổ trong form Phiếu thu và Phiếu chi;
- tạo Thu/Chi vào sổ theo quyền nghiệp vụ;
- thấy toàn bộ phiếu ảnh hưởng tới sổ;
- thấy số dư và lịch sử sổ;
- được Thu/Chi phiếu đã duyệt;
- không tự có quyền duyệt; quyền duyệt được cấp độc lập.

**Người biết sổ (`KNOWER`)**:

- thấy tên sổ trong form tạo Phiếu thu;
- chỉ tạo được Phiếu thu vào sổ đó;
- trên trang Thu Chi chỉ thấy Phiếu thu do chính mình tạo;
- không thấy số dư toàn sổ, Phiếu chi, phiếu của người khác, thống kê toàn sổ, export hoặc attachment của phiếu khác;
- không được Thu/Chi, duyệt, hủy, đảo hoặc quản trị sổ chỉ nhờ vai trò này.

Quyền được tính riêng trên từng sổ. Nếu user giữ sổ A và chỉ biết sổ B, họ thấy toàn bộ phiếu sổ A nhưng chỉ Phiếu thu do mình tạo ở sổ B.

### 2.5. Quản trị vai trò

- Chỉ actor có `cashbooks.share` trên đúng organization và đúng sổ mới được thay đổi Người giữ sổ/Người biết sổ.
- RPC quản trị phải chống self-grant, giả organization, stale revision, replay request cũ và escalation bằng REST trực tiếp.
- Normal share RPC cấm actor thay đổi role của chính mình; self-role change chỉ qua workflow owner/break-glass riêng có reason và audit.
- Thu hồi quyền có hiệu lực với request mới và được kiểm tra lại ngay trước khi RPC ghi tiền.
- `accounts.user_id` nếu còn dùng chỉ là người phụ trách hiển thị; không được dùng làm nguồn authorization duy nhất.
- Owner/admin không tự động bypass quyền giữ sổ khi post. Nếu cần break-glass phải là RPC riêng, lý do bắt buộc và audit đầy đủ.

## 3. Phạm vi và ngoài phạm vi

### 3.1. Trong phạm vi

- Schema và backfill trạng thái phê duyệt/ghi sổ.
- Bảng quyền sổ canonical và migration dữ liệu chia sẻ cũ.
- RLS/ACL cho `accounts`, `income_expenses`, items, stats, attachment và các view liên quan.
- RPC tạo, duyệt, duyệt và Thu/Chi, Thu/Chi sau duyệt, hủy và đảo.
- Approval inbox và approval engine.
- Page Thu Chi desktop/mobile, filter, badge, detail, form, quick edit và batch detail.
- Cài đặt sổ quỹ desktop/mobile.
- Số dư sổ, dòng tiền, đối soát, bàn giao tiền và báo cáo tiền thật.
- P&L dồn tích, báo cáo Thu Chi, verification và chốt lợi nhuận.
- Batch, recurring, import và tất cả writer hệ thống tạo `income_expenses`.
- Supabase types, test DB/RLS/concurrency, Vitest, typecheck, reconcile và E2E.

### 3.2. Ngoài phạm vi giai đoạn đầu

- Thu/Chi một phần.
- Chia một phiếu qua nhiều sổ.
- Sửa trực tiếp phiếu đã `POSTED`.
- Backdate posting vào kỳ sổ đã khóa.
- Tự động nâng toàn bộ `account_shared_users` cũ thành Người giữ sổ.
- Xóa approval engine hiện có trước khi mọi consumer đã cutover và số tiền đã đối chiếu.

## 4. Hiện trạng đã kiểm chứng trong codebase

| Hiện trạng | File/symbol tiêu biểu | Hệ quả |
|---|---|---|
| Badge `APPROVED` đang là “Đã vào sổ”. | `src/components/income-expenses/VoucherStatusBadge.tsx:7` | Không thể biểu diễn Đã Duyệt - Chưa Chi. |
| Lớp CASH và query sổ lọc `approval_status='APPROVED'`. | `src/hooks/income-expenses/queries.ts:193`, `src/hooks/useCashBook.ts:45` | Duyệt đang bị coi như tiền thật. |
| Form/filter vẫn gọi `UNAPPROVED` là Nháp. | `src/components/income-expenses/IncomeExpenseForm.tsx:535`, `IncomeExpenseFilters.tsx:252`, `IncomeExpenseFilterPanel.tsx:39` | UI chưa dùng canonical Vietnamese mới. |
| Desktop Duyệt đang quick-update rồi approve bằng hai request. | `src/pages/payments/IncomeExpensePage.tsx:288` | Không atomic; có thể duyệt dở dang nếu request thứ hai lỗi. |
| Form hiện dùng `voucher_date` như “Ngày thực chi/thu”; attachment không bắt buộc. | `src/components/income-expenses/IncomeExpenseForm.tsx` | Chưa có `posted_on` và proof contract độc lập. |
| `create_income_expense_v1` và các fallback có thể tự tạo `APPROVED`. | `src/hooks/income-expenses/mutations.ts:46`, `scripts/authz-prepared/t5_24_ie_birth_status_policy.sql` | Writer mới/cũ không thống nhất birth state. |
| Batch, recurring và approval inbox có đường ghi riêng. | `src/hooks/income-expenses/batch.ts`, `recurring.ts`, `src/hooks/useApprovals.ts` | Sửa form lẻ không đủ; các đường phụ sẽ bypass. |
| `accounts_with_balance` cộng phiếu `APPROVED`. | `supabase/migrations/20260704100000_accounts_is_virtual.sql:33` | View số dư phải chuyển sang posting state/date. |
| P&L accrual chỉ lấy phiếu `APPROVED`. | `supabase/migrations/20260626000000_fa_accrual_pnl.sql:79` | Phiếu Chờ duyệt KQKD chưa vào lợi nhuận. |
| Profit close dùng `fa_monthly_pnl_accrual`. | `supabase/migrations/20260720215000_profit_close_v2_ignore_inactive_managers.sql:246` | Sửa nguồn accrual phải đồng bộ preview/lock/source hash. |
| Shared user hiện được xem toàn bộ phiếu sổ và insert. | `supabase/migrations/20260703161000_ie_select_policies_setbased.sql:61`, `20260703170000_write_policies_setbased.sql:164` | Không đáp ứng KNOWER. |
| Policy theo tòa có thể OR với policy theo sổ. | `supabase/migrations/20260702150000_rls_initplan_setbased_select.sql:180` | Thêm policy hẹp mới không tự thu hẹp policy rộng cũ. |
| `account_shared_users` chỉ có quan hệ chia sẻ chung, không có access kind. | `supabase/migrations/20260516000004_account_shared_users.sql:16` | Cần nguồn quyền canonical mới. |
| Schema đã có `cashbook_possession_bindings` với `CUSTODIAN/OPERATOR`. | `scripts/authz-prepared/prod-snapshot/PS04_rbac_org_meter_threshold.sql:192` | Có thể tái sử dụng dữ liệu custodian nhưng chưa biểu diễn KNOWER. |
| Approval engine đã có request/decision và metadata `posting_id`. | `supabase/migrations/20260713130000_sprint4a_approval_engine_schema.sql:73`, `:174` | Không tạo engine thứ ba; phải sửa semantics POSTED hiện tại. |
| `update_income_expense_quick` có thể đổi `account_id` của row đã APPROVED. | `supabase/migrations/20260527000005_income_expense_quick_edit.sql:26` | Đang có thể chuyển số dư giữa sổ mà không có posting/reversal. |
| Direct DML/fallback vẫn sống; script drain chỉ là prepared/comment. | `scripts/authz-prepared/T7_PREPARED_drain_legacy_dml.sql`, hooks mutations/batch/status/specialized | Cutover phải chuyển caller rồi revoke table DML. |
| Bucket chứng từ private nhưng SELECT còn bucket-wide cho authenticated. | `supabase/migrations/20260601000200_sec_private_buckets.sql:45`, `PS03_storage_shield.sql:449` | User biết object path có thể đọc proof tenant khác. |
| View balance từng có `GRANT ALL` cho anon/authenticated. | `20260704100000_accounts_is_virtual.sql:63` | Replacement view phải revoke explicit và chạy invoker check. |
| Org rollout có fallback sentinel cho finance rows mơ hồ. | `20260713120000_sprint3a_org_rollout_all_tables.sql` | Không được COALESCE dữ liệu tiền mơ hồ về PROD; phải exception + assert. |
| `cashbook_possession_bindings` có trong generated types nhưng source chính nằm ở prod snapshot. | `src/integrations/supabase/types.ts:2266`, `PS04_rbac_org_meter_threshold.sql:192` | Trước migration phải snapshot live catalog và giải quyết schema-source drift. |
| Có nhiều consumer SQL/TS dùng `APPROVED` như proxy tiền thật. | `rg -n "approval_status.*APPROVED" src supabase scripts` | Bắt buộc inventory và phân loại từng consumer trước cutover. |

## 5. Thuật ngữ và mô hình trạng thái đích

### 5.1. Các trục độc lập

| Trục | Giá trị | Ý nghĩa |
|---|---|---|
| `approval_status` | `UNAPPROVED`, `APPROVED`, `CANCELLED` | Quyết định workflow/phê duyệt. |
| `review_state` | `PENDING`, `CHANGES_REQUESTED`, `DISPUTED`, `RESOLVED` | Trạng thái xử lý khi chưa thể approve/cancel ngay. |
| `posting_mode` | `CASHBOOK`, `NON_CASH` | Phiếu có yêu cầu thay đổi sổ quỹ hay chỉ là bút toán/nghiệp vụ không tiền. |
| `income_expense_postings` + `posting_status` | `UNPOSTED`, `POSTED`, `REVERSED`, `NOT_APPLICABLE` | Posting event là nguồn tiền thật; trạng thái trên voucher là header/aggregate được writer server duy trì. |
| KQKD | `counts_in_business_result`, `kqkd_amount`, kỳ áp dụng/item allocation | Phiếu có được ghi nhận vào lợi nhuận và ở kỳ nào. |

### 5.2. Ma trận trạng thái hợp lệ

| Approval | Posting mode | Posting status | Hiển thị | Chặn chốt KQKD |
|---|---|---|---|---|
| `UNAPPROVED/PENDING` | `CASHBOOK` | `UNPOSTED` | Chờ duyệt | Có nếu phiếu thuộc KQKD của kỳ. |
| `UNAPPROVED/CHANGES_REQUESTED` | `CASHBOOK` | `UNPOSTED` | Cần bổ sung | Có nếu phiếu thuộc KQKD của kỳ. |
| `UNAPPROVED/DISPUTED` | `CASHBOOK` | `UNPOSTED` | Đang tranh chấp | Có nếu phiếu thuộc KQKD của kỳ. |
| `APPROVED` | `CASHBOOK` | `UNPOSTED` | Đã Duyệt - Chưa Thu/Chi | Không. |
| `APPROVED` | `CASHBOOK` | `POSTED` | Đã Thu/Chi | Không. |
| `APPROVED` | `CASHBOOK` | `REVERSED` | Đã hoàn tác | Không; điều chỉnh KQKD xử lý riêng. |
| `APPROVED` | `NON_CASH` | `NOT_APPLICABLE` | Đã ghi nhận, không qua sổ quỹ | Không. |
| `CANCELLED` | `CASHBOOK` | `UNPOSTED` | Đã hủy trước khi ghi sổ | Không còn là blocker ở kỳ mở; base đã khóa của kỳ cũ vẫn giữ trong snapshot và chỉ được bù bằng adjustment/reopen. |

Không cho phép:

- `UNAPPROVED + POSTED`;
- `CANCELLED + POSTED`;
- chuyển voucher đã POSTED hoặc NON_CASH đã ghi nhận sang CANCELLED trực tiếp; phải dùng reversal/adjustment;
- `CASHBOOK + NOT_APPLICABLE`;
- `NON_CASH + POSTED`;
- `POSTED` mà thiếu ngày, sổ, actor, evidence hoặc posting id.

### 5.3. Từ chối, trả sửa và tranh chấp

Không để decision `REJECTED/DENIED` treo dưới nhãn Chờ duyệt vĩnh viễn. Mapping bắt buộc:

| Quyết định | Voucher state | KQKD/close |
|---|---|---|
| Yêu cầu bổ sung | `UNAPPROVED + review_state=CHANGES_REQUESTED` | Vẫn là nghĩa vụ chưa giải quyết; block close nếu thuộc kỳ. Creator sửa field được mở rồi resubmit submission/version mới. |
| Từ chối vì không phát sinh/trùng/sai doanh nghiệp | `CANCELLED + UNPOSTED` | Loại recognition nếu kỳ mở; nếu kỳ đã khóa phải adjustment/reopen, không sửa snapshot âm thầm. |
| Từ chối thanh toán nhưng nghĩa vụ còn thật | `UNAPPROVED + review_state=DISPUTED` | Vẫn trong P&L và block close; vào hàng đợi tranh chấp có owner/reason/deadline. |
| Giải quyết tranh chấp: chấp nhận | submission mới → `APPROVED` hoặc pending approval | Không double count recognition. |
| Giải quyết tranh chấp: hủy có bằng chứng | `CANCELLED + UNPOSTED` | Loại/điều chỉnh recognition theo kỳ. |

Cần RPC riêng: request changes, reject-invalid, mark-disputed, withdraw, resubmit và resolve dispute. Close preview phải trả riêng `changes_requested_count`/`disputed_count` trong blocker list.

Contract `withdraw` phải chốt cứng, không dùng chung nghĩa mơ hồ với cancel:

- chỉ original human maker đang active trong đúng organization được rút voucher do chính mình tạo;
- chỉ cho `UNAPPROVED + UNPOSTED` với `review_state=PENDING/CHANGES_REQUESTED`; không cho rút `APPROVED`, `DISPUTED`, voucher system-generated hoặc voucher đã có posting;
- chỉ thực hiện khi kỳ recognition còn mở. Nếu kỳ đã khóa, RPC fail và chuyển sang workflow approver/close-owner dùng reopen hoặc recognition adjustment; maker không tự tạo adjustment;
- transition nguyên tử thành `CANCELLED + UNPOSTED`, `review_state=RESOLVED`, `cancellation_kind=WITHDRAWN_BY_MAKER`; nếu còn request `PENDING_APPROVAL` thì đóng thành `WITHDRAWN`, còn request đã terminal `CHANGES_REQUESTED` phải giữ bất biến; tăng version và ghi withdrawal audit/idempotency result;
- sau commit voucher bị loại khỏi P&L kỳ mở và blocker close, balance vẫn không đổi; retry cùng key không tạo thêm transition/audit.

Approve hoặc terminal cancel phải set `review_state=RESOLVED`; resubmit tạo submission/version mới và đưa về `PENDING`.

### 5.4. Nguyên tắc ngày

- `voucher_date`: ngày nghiệp vụ/đề nghị và là fallback xác định kỳ KQKD khi không có billing month/item period.
- `posted_on`: tên cột vật lý canonical cho ngày tiền thực tế vào/ra sổ; UI gọi là Ngày Thu/Chi.
- `created_at`: thời điểm hệ thống tạo row.
- `approved_at`: thời điểm phê duyệt.
- `posted_at_v2`: timestamp audit khi server ghi sổ; không thay cho `posted_on`.

## 6. Mô hình dữ liệu mục tiêu

### 6.1. Bổ sung trên `income_expenses`

Thêm additive trước, chưa cutover ngay:

```sql
posting_mode       text null
posting_status     text null
active_posting_id_v2 uuid null
recognition_date   date null
recognition_source_mode text null
review_state       text null
review_owner_membership_id uuid null
review_reason      text null
review_deadline    timestamptz null
change_field_mask  jsonb null
review_version     bigint not null default 1
approval_version   bigint not null default 1
posting_version    bigint not null default 1
cancellation_kind  text null
legacy_source_deleted_at timestamptz null
legacy_source_delete_hash text null
```

Các cột mới để nullable/default inert trong expand phase; chỉ `NOT NULL` sau khi backfill, shadow reconcile và validate constraint.

Giữ và chuẩn hóa các cột đã có:

- `posting_id` mirror event `POSTING` gốc để tương thích consumer cũ và vẫn giữ sau reversal/replacement.
- `active_posting_id_v2` là pointer server-owned tới POSTING chưa bị reverse hiện tại; null khi UNPOSTED/REVERSED/NOT_APPLICABLE.
- `posted_at_v2` mirror server timestamp của event POSTING gốc.
- `reversed_by_posting_id` chỉ là compatibility mirror của terminal/latest REVERSAL; canonical history nằm trong event chain.
- `approval_request_id`, `correlation_id` tiếp tục phục vụ engine/audit; header `idempotency_key/source_payload_hash` chỉ là legacy provenance/mirror, không thay canonical lifecycle request registry.

Constraint header đích:

- `posting_status` thuộc `UNPOSTED/POSTED/REVERSED/NOT_APPLICABLE`.
- `posting_mode` thuộc `CASHBOOK/NON_CASH`.
- `recognition_source_mode` thuộc `BASE/ADJUSTMENT_ONLY`, do server quyết định và không nhận từ client.
- `POSTED` yêu cầu `approval_status='APPROVED'`, đúng một active POSTING qua `active_posting_id_v2`; có thể có generation lịch sử đã reverse.
- `REVERSED` yêu cầu không còn active pointer và generation cuối đã có REVERSAL liên kết.
- `UNPOSTED` không có POSTING; metadata legacy mâu thuẫn phải vào exception.
- `NOT_APPLICABLE` chỉ dùng với `NON_CASH` và không có account ảnh hưởng tiền.
- Giai đoạn đầu mỗi voucher có tối đa một posting đang hiệu lực.
- Sau backfill/cutover: `APPROVED/CANCELLED => review_state='RESOLVED'`; `UNAPPROVED` chỉ `PENDING/CHANGES_REQUESTED/DISPUTED`.
- `CHANGES_REQUESTED` yêu cầu reason + field mask; `DISPUTED` yêu cầu owner + reason + deadline.
- `ADJUSTMENT_ONLY` không bao giờ được đóng góp từ voucher base; `BASE` không được đổi mode sau khi kỳ đã khóa nếu chưa reopen/reclose có audit.
- `legacy_source_deleted_at` chỉ do compatibility delete guard set trước cutover; marker/hash immutable ngoài guard, không nhận từ client và không đồng nghĩa được phép hard-delete row.
- Trong expand/legacy, `review_state` nullable để không sinh `APPROVED + PENDING` giả; chỉ set NOT NULL/default sau adapters/backfill.

Tạo private lifecycle idempotency registry dùng chung cho create/approve/request-changes/reject/dispute/withdraw/resubmit/resolve/cancel:

```text
income_expense_mutation_requests
  organization_id, idempotency_key, operation_kind, payload_hash
  subject_id, expected_review_version, expected_approval_version
  actor_membership_id, actor_user_id
  resulting_subject_id, resulting_review_version, resulting_approval_version
  result_snapshot, created_at, completed_at
```

Yêu cầu:

- unique `(organization_id, idempotency_key)`; key dùng lại khác operation/subject/payload phải fail conflict;
- RPC reserve/lock request row trước khi đổi state. Retry cùng payload trả lại `result_snapshot` kể cả voucher đã sang state mới;
- create có thể bắt đầu với `subject_id=null`, nhưng result phải lưu voucher id đã tạo;
- lifecycle transition và audit chỉ được append một lần; failed transaction không để request row completed giả;
- composite tenant FK, actor server-owned, revoke client DML/SELECT và retention đủ dài hơn cửa sổ retry/job replay;
- không dùng một `income_expenses.idempotency_key` mutable để thay registry này.

### 6.2. Posting event canonical

Tạo `income_expense_postings` làm nguồn tiền thật duy nhất:

```sql
id                       uuid primary key
organization_id          uuid not null
voucher_id               uuid not null
direction                text not null check (direction in ('INCOME','EXPENSE'))
account_id               uuid not null
gross_amount             numeric(18,2) not null check (gross_amount > 0)
net_cash_effect          numeric(18,2) not null
posted_on                date not null
posted_by_membership_id  uuid not null
posted_by_user_id        uuid not null
approval_request_id      uuid null
approval_version         bigint not null
event_kind               text not null check (event_kind in ('POSTING','REVERSAL'))
idempotency_key          text not null
source_kind              text not null
posting_generation       bigint not null
replaces_posting_id      uuid null
reversal_of_id           uuid null
source_version_or_hash   text null
evidence_waiver          text null
legacy_provenance        jsonb null
created_at               timestamptz not null
reversal_reason          text null
```

Tạo `income_expense_posting_lines` để biểu diễn mọi sổ bị ảnh hưởng mà không nhồi công thức vào view:

```sql
id               uuid primary key
organization_id  uuid not null
posting_id       uuid not null
account_id       uuid not null
line_kind        text not null check (line_kind in ('MAIN','CHANGE','ROUNDING','REVERSAL'))
signed_amount    numeric(18,2) not null check (signed_amount <> 0)
created_at       timestamptz not null
```

Quy ước signed line:

- MAIN Phiếu thu: `+total_amount`;
- MAIN Phiếu chi: `-total_amount`;
- CHANGE/ROUNDING: giữ đúng dấu/công thức legacy sau khi characterization xác nhận;
- REVERSAL: dòng đối dấu liên kết posting gốc.

Constraint bắt buộc:

- composite FK giữ voucher, account và membership trong cùng organization;
- unique `(organization_id, idempotency_key)`;
- unique `(organization_id, voucher_id, posting_generation)` cho POSTING; generation tăng đơn điệu;
- `active_posting_id_v2` có composite FK tới đúng organization/voucher; voucher lock + constraint trigger bảo đảm tối đa một POSTING chưa bị reverse;
- `replaces_posting_id` chỉ được tham chiếu generation trước cùng organization/voucher và predecessor phải được reverse trong cùng transaction replacement;
- mỗi POSTING có tối đa một REVERSAL và reversal phải tham chiếu đúng organization/voucher;
- phase đầu `gross_amount = income_expenses.total_amount`;
- MAIN line có trị tuyệt đối đúng bằng `gross_amount` và dấu theo INCOME/EXPENSE;
- CHANGE/ROUNDING lines khớp chính xác field legacy đã characterization;
- `net_cash_effect = SUM(signed lines)`; không ép tổng lines bằng gross amount;
- mọi posting Thu/Chi thủ công yêu cầu ít nhất một evidence relation đã finalize;
- signed lines không có account chéo organization;
- event rows immutable; reversal là event/audit bù trừ, không UPDATE/DELETE posting gốc;
- phase 1 vẫn chỉ có một posting active/full amount. Generation > 1 chỉ dùng cho legacy shadow delta correction hoặc workflow reversal + replacement được cấp quyền rõ, không phải partial payment;
- client không INSERT/UPDATE/DELETE trực tiếp;
- backfill lịch sử dùng `source_kind='LEGACY_BACKFILL'` + waiver `PRE_V2_HISTORY`; deterministic replacement trước cutover dùng `LEGACY_DELTA_REPLACEMENT` + inherited evidence hoặc waiver `PRE_V2_LEGACY_DELTA` có source hashes. Không tạo URL ảnh giả.

`accounts_with_balance`, cash flow, handover và reconciliation phải SUM toàn bộ signed lines của POSTING/REVERSAL hợp lệ; header `posting_status` cho biết net state của voucher, không đọc `approval_status` để tính tiền.

### 6.3. Registry chứng từ canonical

Không nhận object path/JSON tùy ý từ client. Tạo:

```text
finance_evidence_objects
  id, organization_id, bucket_id, object_name
  uploader_membership_id, uploader_user_id
  sha256, byte_size, mime_type
  state = UPLOAD_INTENT | FINALIZED | ATTACHED | QUARANTINED
  upload_token_hash, created_at, finalized_at

income_expense_posting_evidence
  id, organization_id, posting_id, evidence_id
  relation_kind = ORIGINAL | INHERITED_LEGACY_DELTA
  inherited_from_link_id, evidence_snapshot_hash, created_at
```

Flow upload:

1. `create_finance_evidence_upload_intent_v2` kiểm membership/org và trả path ngẫu nhiên chứa organization + membership + UUID.
2. Client upload đúng path/token.
3. `finalize_finance_evidence_v2` kiểm object tồn tại, owner metadata, size/mime/hash và cùng organization.
4. Posting RPC chỉ nhận `evidenceIds`; server attach bằng composite FK.
5. Evidence tenant khác, object chưa finalize, path bị overwrite hoặc reuse trái contract phải fail.

Phase đầu một evidence chỉ có một attach `ORIGINAL`: partial unique `evidence_id WHERE relation_kind='ORIGINAL'`. Posting RPC lock evidence rows `FOR UPDATE`, kiểm `FINALIZED`, attach và chuyển `ATTACHED` trong cùng transaction để chặn reuse đồng thời.

Riêng replacement generation do legacy delta trước V2 cutover:

- client không gửi lại evidence id. Delta worker server-side tạo link `INHERITED_LEGACY_DELTA` tham chiếu link generation trước, cùng organization/voucher/posting lineage và copy immutable sha256/object snapshot;
- inherited link không chuyển ownership/state object, không cho dùng ở voucher khác và không thỏa evidence cho một posting thủ công mới;
- nếu generation trước chỉ có waiver `PRE_V2_HISTORY`, replacement được dùng waiver `PRE_V2_LEGACY_DELTA` kèm source change-log id, old/new source hash và reason; chỉ hợp lệ khi org chưa V2 và source voucher tồn tại trước cutover;
- replacement có chứng từ legacy mới thì registry/finalize như bình thường và dùng ORIGINAL mới; không được nhận raw URL;
- sau V2 cutover không cho inheritance/waiver này. Mọi reversal/replacement nghiệp vụ mới phải theo evidence policy production tương ứng.

Mọi posting Thu/Chi thủ công yêu cầu ít nhất một evidence `FINALIZED`. System writer tiền thật phải tạo/finalize registry record từ receipt/chứng từ hệ thống; waiver chỉ dành cho `PRE_V2_HISTORY/PRE_V2_LEGACY_DELTA` theo guard trên, không dùng cho giao dịch mới.

### 6.4. Bảng quyền canonical

Tạo `cashbook_access_bindings` thay vì tiếp tục mở rộng `account_shared_users`:

```sql
id                 uuid primary key
organization_id    uuid not null
cashbook_id         uuid not null
membership_id       uuid not null
access_kind         text not null check (access_kind in ('CUSTODIAN','KNOWER'))
valid_from          timestamptz not null
valid_to            timestamptz null
created_by          uuid not null
created_at          timestamptz not null
revoked_by          uuid null
revoked_at          timestamptz null
reason              text null
source_kind         text not null
source_id           uuid null
```

Thêm state/request tables để CAS và idempotency thực thi được:

```text
cashbook_access_states
  organization_id, cashbook_id, revision, updated_by, updated_at

cashbook_access_mutation_requests
  organization_id, idempotency_key, payload_hash
  expected_revision, resulting_revision, actor_membership_id
  result_snapshot, created_at
```

Yêu cầu:

- unique một binding mở cho `(organization_id, cashbook_id, membership_id, access_kind)`;
- FK kép theo organization để không ghép membership/sổ chéo tenant;
- append/close binding, không update xóa lịch sử;
- RLS chỉ cho đọc phạm vi cần thiết; client không DML trực tiếp;
- mutation chỉ qua RPC có `cashbooks.share` exact scope, `expectedRevision` và idempotency key;
- normal RPC không cho actor thay đổi role của chính mình. Self-role change chỉ qua break-glass/owner workflow riêng, reason bắt buộc và audit.

### 6.5. Dữ liệu migration và ngoại lệ

Tạo bảng private hoặc report staging cho các row không thể phân loại chắc chắn:

- `app_private.income_expense_v2_backfill_exceptions`;
- `app_private.cashbook_access_v2_backfill_exceptions`.

Cutover bị chặn nếu còn exception chưa disposition. Không được mặc định nâng `account_shared_users` thành `CUSTODIAN`.

### 6.6. Điều chỉnh recognition cho kỳ đã khóa

Tạo `income_expense_recognition_adjustments` append-only:

```text
id, organization_id, voucher_id
original_period, adjustment_period
signed_amount, allocation_snapshot
adjustment_kind = LATE_RECOGNITION | CANCELLATION | CORRECTION
reason, idempotency_key, source_payload_hash
created_by_membership_id, created_by_user_id, created_at
related_close_run_id, related_revision_id
```

`recognition_source_mode` có contract loại trừ double count:

- `BASE`: voucher là nguồn base bình thường trong kỳ mở. Khi kỳ được close, contribution và allocation của voucher được đóng băng trong close snapshot; trạng thái `CANCELLED` về sau không được làm base lịch sử biến mất.
- `ADJUSTMENT_ONLY`: voucher header đóng góp đúng `0` vào mọi base query. Chỉ adjustment event mang hiệu ứng KQKD; dùng cho nghĩa vụ tạo muộn có natural period đã khóa khi doanh nghiệp chọn catch-up thay vì reopen.
- Reopen/reclose và catch-up là hai nhánh loại trừ nhau cho cùng expected revision/idempotency operation. Không được vừa đưa voucher về `BASE` trong kỳ gốc vừa giữ positive `LATE_RECOGNITION` adjustment.

Quy tắc dữ liệu và quyền:

- composite FK `(organization_id, voucher_id)` và các FK tới close run/revision phải cùng tenant;
- unique `(organization_id, idempotency_key)` kèm payload hash; cùng key khác payload fail conflict;
- client không cung cấp `signed_amount`, allocation, actor, organization hoặc source mode. RPC khóa voucher/close state rồi tự tính delta từ canonical source snapshots;
- `adjustment_period` phải là kỳ đang mở và actor phải có quyền close/adjust đúng scope; maker/KNOWER/CUSTODIAN thông thường không có quyền này chỉ vì họ thấy voucher hoặc sổ;
- bảng append-only có trigger chặn `UPDATE/DELETE`, revoke toàn bộ client DML và chỉ cho private primitive/RPC canonical insert;
- RLS/ACL đọc chỉ qua report/drill-down có capability và tenant scope; không expose REST row thô cho authenticated nếu không có nhu cầu;
- reject direct REST insert, cross-org voucher/close reference, forged actor/allocation/amount và concurrent duplicate trong negative tests.

Quy tắc vòng đời:

- Khi kỳ recognition còn mở, voucher/items có thể được sửa/hủy theo writer và version guard.
- Khi kỳ đã khóa, `recognition_date`, amount, KQKD flag và allocation của voucher bất biến.
- Reject-invalid/cancel sau close không được chỉ set CANCELLED rồi làm live accrual biến mất. Phải:
  - reopen/reclose kỳ có audit; hoặc
  - tạo adjustment event ở kỳ đang mở tham chiếu voucher/kỳ gốc.
- Nghĩa vụ tạo muộn nhưng thuộc kỳ đã khóa cũng phải chọn reopen/reclose hoặc catch-up adjustment ở kỳ mở; không backdate âm thầm.
- Nếu chọn catch-up cho nghĩa vụ tạo muộn, server set `recognition_source_mode=ADJUSTMENT_ONLY` trước khi tạo positive adjustment trong cùng transaction.
- Closed snapshot giữ nguyên; report current/open period cộng adjustment event, source hash và verification phải bao gồm adjustment id/payload hash/source mode.
- Không UPDATE/DELETE adjustment event; sai thì tạo event đối ứng.

## 7. Contract RPC và state machine V2

### 7.1. Private primitives duy nhất

Không để mỗi domain tự cập nhật `income_expenses`. Tất cả public RPC và system writer phải gọi các primitive private sau:

- `app_private.resolve_finance_actor_v2` — lấy `auth.uid()`, membership active, organization và trace id.
- `app_private.assert_cashbook_access_v2` — kiểm `CUSTODIAN/KNOWER`, hiệu lực binding và exact cashbook.
- `app_private.resolve_business_result_v2` — xác định `counts_in_business_result`, `kqkd_amount`, `recognition_date`; client không tự quyết định.
- `app_private.guard_or_adjust_recognition_v2` — chặn sửa kỳ khóa hoặc tạo adjustment/reopen workflow hợp lệ.
- `app_private.create_income_expense_v2` — tạo voucher/header/items theo một contract.
- `app_private.approve_income_expense_v2` — chỉ phê duyệt.
- `app_private.post_income_expense_v2` — tạo posting event cho voucher đã duyệt.
- `app_private.approve_and_post_income_expense_v2` — duyệt + posting trong cùng transaction.
- `app_private.transition_income_expense_review_v2` — request changes/reject/dispute/resubmit theo state machine.
- `app_private.cancel_unposted_income_expense_v2` — chỉ hủy voucher chưa post.
- `app_private.reverse_income_expense_posting_v2` — tạo reversal có audit.
- `app_private.set_cashbook_access_v2` — append/close binding theo revision.

Mỗi primitive phải:

- lock voucher, account, membership/binding và approval request bằng `FOR UPDATE` theo thứ tự cố định;
- kiểm quyền lại sau khi lấy lock;
- lấy actor/organization từ session, không tin field client;
- lifecycle RPC phải reserve/lock `income_expense_mutation_requests`; posting/access/recognition dùng registry hoặc unique event store tương ứng với idempotency key + payload hash;
- append audit event trong cùng transaction;
- không gọi lại public RPC;
- không có fallback raw table DML.

### 7.2. Public RPC đề xuất

| RPC | Actor/quyền | Kết quả |
|---|---|---|
| `create_income_expense_v2` | `income_expenses.create`; account theo intent/role | Tạo voucher hoàn chỉnh, mặc định Chờ duyệt + Unposted. |
| `approve_income_expense_v2` | `income_expenses.approve` và phạm vi approval | Chỉ `UNAPPROVED → APPROVED`; balance không đổi. |
| `approve_and_post_income_expense_v2` | approve + `CUSTODIAN` exact cashbook | Atomic approve + active posting. |
| `post_approved_income_expense_v2` | `CUSTODIAN` exact cashbook | Post voucher `APPROVED + UNPOSTED`; không cần quyền approve. |
| `request_income_expense_changes_v2` | approver đúng scope | Giữ UNAPPROVED, set voucher CHANGES_REQUESTED và đóng request hiện tại thành CHANGES_REQUESTED với outcome/field mask. |
| `reject_invalid_income_expense_v2` | approver đúng scope | CANCELLED + UNPOSTED khi chứng minh không phát sinh/trùng. |
| `mark_income_expense_disputed_v2` | approver đúng scope | Giữ recognition, set voucher + request DISPUTED và blocker/outcome metadata. |
| `withdraw_income_expense_v2` | original human maker, đúng org, kỳ mở | Chỉ `UNAPPROVED + UNPOSTED + PENDING/CHANGES_REQUESTED` → `CANCELLED + RESOLVED`, kind `WITHDRAWN_BY_MAKER`; system/disputed/approved/locked-period fail. |
| `resubmit_income_expense_v2` | maker đúng scope | Tạo submission/version mới sau khi sửa. |
| `resolve_income_expense_dispute_v2` | owner/kế toán được giao | Chấp nhận nghĩa vụ hoặc hủy/điều chỉnh có bằng chứng. |
| `adjust_closed_income_expense_recognition_v2` | quyền close/adjust đúng scope | Server tính delta, chọn BASE/ADJUSTMENT_ONLY đúng contract và tạo idempotent catch-up/cancellation/correction event ở kỳ mở hoặc yêu cầu reopen. |
| `cancel_unposted_income_expense_v2` | quyền hủy đúng scope | Hủy voucher chưa post, có reason/audit. |
| `reverse_posted_income_expense_v2` | quyền reversal + `CUSTODIAN` | Tạo reversal ở kỳ sổ mở; không sửa/xóa posting gốc. |
| `list_my_cashbook_access_v2` | authenticated membership | Trả danh sách safe theo intent, không lộ balance cho KNOWER. |
| `get_cashbook_access_admin_v2` | `cashbooks.share` trên exact cashbook/org | Trả cashbook id/name, current revision, hai danh sách CUSTODIAN/KNOWER và eligible active memberships với field tối thiểu; không trả balance/history/audit. |
| `set_cashbook_access_v2` | `cashbooks.share` exact scope | Cập nhật hai danh sách bằng expected revision + idempotency; normal RPC không đổi role của chính actor. |
| `list_income_expenses_v2` | server scoped | Danh sách đã áp role, restricted, org/building và pagination. |
| `get_income_expense_stats_v2` | server scoped | Tổng theo đúng cùng predicate với list. |
| `get_income_expense_detail_v2` | server scoped | Detail/attachment shape an toàn. |

Payload Thu/Chi tối thiểu:

```ts
type PostVoucherInput = {
  voucherId: string;
  cashbookId: string;
  postedOn: string;       // YYYY-MM-DD
  evidenceIds: string[];  // id registry FINALIZED, ít nhất 1 với Thu/Chi thủ công
  expectedApprovalVersion: number;
  expectedPostingVersion: number;
  idempotencyKey: string;
};
```

Phase đầu không nhận `amount` từ UI; server lấy `voucher.total_amount`. Khi mở partial payment phải dùng RPC/version migration khác.

### 7.3. Duyệt và Chi nguyên tử

Thứ tự bắt buộc trong một transaction:

1. Resolve actor/membership/org.
2. Lock voucher.
3. Kiểm voucher `UNAPPROVED + UNPOSTED`, version và chưa hủy.
4. Kiểm actor có quyền approve trong đúng scope.
5. Lock cashbook và binding.
6. Kiểm `CUSTODIAN` còn active.
7. Kiểm ngày sổ đang mở, evidence và amount server-owned.
8. Ghi approval decision/header.
9. Tạo posting event.
10. Cập nhật header mirror/version.
11. Ghi audit và commit.

Bất kỳ lỗi nào từ bước 1–10 đều rollback toàn bộ.

### 7.4. Approval engine hiện có

Không tạo engine thứ ba. Replacement migration phải sửa semantics:

- constraint `approval_requests.state` phải hỗ trợ `PENDING_APPROVAL`, terminal-per-request `APPROVED`, `WITHDRAWN`, `CHANGES_REQUESTED`, `DISPUTED`, `DENIED`, `REJECTED`, `CANCELLED`, `REVERSED` và compatibility value `POSTED`; `POSTED` chỉ giữ để đọc/backfill lịch sử và writer mới không được set.
- Thêm server-owned `outcome_kind`, `outcome_reason`, `closed_by_membership_id`, `closed_at`. History phân biệt REQUEST_CHANGES, INVALID_OR_DUPLICATE, DISPUTE, MAKER_WITHDRAW và approval/rejection thường thay vì suy từ một state chung.
- `WITHDRAWN` chỉ do canonical withdraw RPC set cho request `PENDING_APPROVAL`; approval inbox loại row này, history/detail hiển thị “Đã rút”, partial unique “one open subject” chỉ xét `PENDING_APPROVAL`. Withdraw từ voucher CHANGES_REQUESTED giữ request lịch sử CHANGES_REQUESTED và append withdrawal audit riêng.
- `decide_financial_request_v2(..., 'APPROVE')` không tự post.
- Request-changes/dispute/reject/withdraw phải đóng request `PENDING_APPROVAL` hiện tại sang terminal-per-request tương ứng trong cùng transaction với voucher transition; không để request cũ tiếp tục chiếm partial unique.
- `REJECTED/DENIED` phải có outcome rõ: invalid/duplicate → voucher CANCELLED; policy/payment dispute → voucher DISPUTED; không chỉ đóng request rồi để voucher pending vô hạn.
- Withdraw đóng request hiện tại thành `WITHDRAWN` nếu nó còn PENDING, hoặc giữ request CHANGES_REQUESTED bất biến rồi append audit nếu request đã terminal; resubmit chỉ sau voucher CHANGES_REQUESTED, xác nhận không còn request PENDING rồi tạo request/submission/version mới và không double count recognition. Không reopen row request cũ.
- `AUTO_POST` không được dùng cho Phiếu chi thủ công hoặc nghĩa vụ hệ thống chưa có chứng từ/ngày/sổ.
- `app_private.post_financial_request_v1` và `_post_financial_voucher` không được là đường mặc định sau final approval.
- Approval inbox trả capability `canApprove`, `canApproveAndPost`, safe cashbook options và version; không cấp quyền đọc toàn sổ.

## 8. Phân loại writer và birth state

Mỗi writer phải được gắn một class trước khi sửa. Không tìm-thay `APPROVED` máy móc.

| Class | Ví dụ | State tạo đích | Ghi chú |
|---|---|---|---|
| Nghĩa vụ thủ công | Người dùng tạo Phiếu chi/thu | `UNAPPROVED + UNPOSTED` | Submit ngay, không Draft. |
| Nghĩa vụ hệ thống | recurring expense, lương, hoa hồng, phí định kỳ | `UNAPPROVED + UNPOSTED` | Có thể vào KQKD trước duyệt nếu server xác định đã phát sinh. |
| Tiền thật đã được user xác nhận | invoice collection, quick collect, utility payment | `APPROVED + POSTED` qua dedicated atomic writer | Vẫn phải có sổ/ngày/evidence hoặc receipt reference system-owned hợp lệ. |
| Phi tiền mặt/nội bộ | cấn trừ, internal ledger, nguồn không làm đổi sổ | `APPROVED + NOT_APPLICABLE` | Không được đưa vào balance; KQKD theo policy riêng. |
| Import/batch | nhập hàng loạt nghĩa vụ | `UNAPPROVED + UNPOSTED` | Phase đầu không bulk auto-post. |
| Opening adjustment | điều chỉnh số dư được kiểm soát | Dedicated posting/reversal writer | Quyền, reason và audit chặt hơn thao tác thường. |
| Refund/reversal | hoàn tiền/sửa sai | Dedicated posting hoặc reversal | Không sửa/xóa posting gốc. |

Writer bắt buộc audit:

- `src/hooks/income-expenses/mutations.ts`
- `src/hooks/income-expenses/statusMutations.ts`
- `src/hooks/income-expenses/batch.ts`
- `src/hooks/income-expenses/recurring.ts`
- `src/hooks/income-expenses/specialized.ts`
- import dialog và cron recurring;
- invoice collection/payment mirror;
- refund/termination;
- utility payment;
- salary/manager salary;
- commission;
- shareholder profit payout;
- deposit/quick deposit;
- opening adjustment;
- cash handover/net sweep;
- Copilot write tools;
- mọi service-role/cron function insert hoặc update `income_expenses`.

Gate review: không còn writer tạo money truth bằng cách set `approval_status='APPROVED'` hoặc dựa vào DB default.

## 9. RLS, ACL và bảo vệ attachment

### 9.1. Nguyên tắc policy

PostgreSQL OR các permissive policy. Vì vậy không được thêm policy hẹp trong khi giữ policy rộng cũ. Migration phải inventory, drop và thay toàn bộ policy liên quan theo allowlist.

Các policy cần xem xét/drop tiêu biểu:

- `accounts_select_staff` và helper co-staff visibility;
- `income_expenses_select_rbac`;
- `income_expenses_select_fund_member`;
- `income_expenses_select_all_buildings`;
- `income_expenses_insert_shared`;
- insert/update policies chỉ kiểm building nhưng không kiểm cashbook;
- direct DML policy trên `account_shared_users`;
- policy shareholder/salary/profit-manager có thể vô tình mở cả sổ thay vì exact-linked row.

Approval tables hiện cũng không được để authenticated đọc trực tiếp toàn org. Phải revoke table SELECT/DML trên:

- `approval_requests`;
- `approval_request_steps`;
- `approval_request_step_candidates`;
- `approval_decisions`;
- rule/rule-set/approver tables;
- `authorization_audit_events`.

Approval inbox/detail chỉ qua capability-scoped RPC; `payload_snapshot`, candidate list và actor data không được lộ qua REST base table.

### 9.2. Predicate đọc page Thu Chi

Server trả union per cashbook:

```text
CUSTODIAN(cashbook)
  => mọi voucher ảnh hưởng cashbook đó

KNOWER(cashbook)
  => voucher.type = INCOME
     AND voucher.created_by = auth.uid()
     AND voucher.account_id = cashbook

không binding
  => không row
```

Phải xét đủ `account_id`, `change_account_id`, `rounding_account_id` cho CUSTODIAN. KNOWER chỉ được phạm vi Phiếu thu primary account do chính họ tạo.

Restricted category, exact-link self-view và tenant/building permission phải được AND với cashbook predicate; không được OR làm rộng.

### 9.3. DML

- Revoke INSERT/UPDATE/DELETE trực tiếp trên `income_expenses`, `income_expense_items`, `income_expense_mutation_requests`, posting headers/lines/evidence links, evidence registry, `income_expense_recognition_adjustments` và `cashbook_access_bindings` cho client; private request/result tables cũng không grant client SELECT.
- Mọi ghi qua RPC V2.
- `USING` kiểm sổ cũ; `WITH CHECK` kiểm sổ mới nếu có mutation chuyển metadata.
- Server bỏ qua hoặc từ chối `organization_id`, `user_id/created_by`, `approved_by`, `posted_by` do client gửi.
- KNOWER gọi REST tạo EXPENSE, đổi type/account/status hoặc giả creator phải fail.

### 9.4. Read models theo capability

Không dùng một `useAccounts()` trả mọi cột cho mọi mục đích. Backend/API cần shape riêng:

Mọi shape user-facing mặc định loại `legacy_source_deleted_at IS NOT NULL`; chỉ audit/history RPC có capability rõ mới thấy tombstone.

- `list_cashbooks_for_income_v2`: CUSTODIAN + KNOWER; chỉ id/name và capability cần thiết.
- `list_cashbooks_for_expense_v2`: chỉ CUSTODIAN.
- `list_cashbooks_with_balance_v2`: chỉ CUSTODIAN hoặc quyền báo cáo rõ ràng.
- `get_cashbook_access_admin_v2`: chỉ actor có `cashbooks.share` exact scope; trả current revision + active assignments/eligible memberships tối thiểu, không expose binding history, audit, balance hoặc sổ khác.
- `list_income_expenses_v2`: scoped rows.
- `get_income_expense_stats_v2`: cùng predicate và cùng snapshot với list.
- `export_income_expenses_v2`: permission export + scoped rows; KNOWER không export toàn sổ.
- `list_my_pending_approvals_v2`: chỉ request actor đủ capability ở current generation.
- `get_approval_request_detail_v2`: payload tối thiểu theo subject/scope, không trả candidate/audit toàn org.

### 9.5. Attachment/storage

- Bucket chứng từ không public.
- Không dựa vào URL đoán được trong JSON.
- Posting RPC không nhận raw object name/URL; chỉ nhận evidence id đã FINALIZED trong registry cùng organization.
- Upload path/token do server cấp; finalize kiểm owner metadata, hash, size, MIME và chống overwrite/reuse trái phép.
- Signed URL chỉ phát sau khi server kiểm quyền trên voucher/posting.
- KNOWER chỉ đọc attachment của Phiếu thu do mình tạo.
- Evidence posting tách khỏi attachment mô tả voucher nếu cần; POSTED không cho quick-edit evidence âm thầm.

### 9.6. Truth table theo rollout mode

Không bật policy hẹp trước khi caller/adapters sẵn sàng, nhưng cũng không giữ leak broad trong LEGACY/SHADOW.

| Mode | Read boundary | Write boundary |
|---|---|---|
| `LEGACY` | Compatibility-safe: bỏ co-staff/all-building leak; chỉ owner/shared/possession explicit theo legacy contract. Storage vẫn private/resource-linked. | Chỉ compatibility RPC/wrapper đã inventory; không thêm raw DML mới. |
| `SHADOW` | Cùng safe boundary; V2 read model chạy đối chiếu, chưa là UI truth. | Writer adapters gọi canonical primitive hoặc mirror event; raw DML caller phải giảm về 0 trước V2. |
| `V2` | CUSTODIAN/KNOWER + scoped approval/report RPC. | Chỉ RPC V2; base table DML revoked. |
| `PAUSED` | Read/reconcile an toàn. | Chặn money/access writes, trừ break-glass maintenance có audit. |

Triển khai thành hai bước:

1. **Containment/preparation:** đóng leak co-staff/building/storage và cung cấp compatibility API để app cũ không gãy.
2. **V2 enforcement/ACL drain:** chỉ sau khi binding classified, mọi caller đã chuyển và canary xanh mới revoke DML/bật role semantics V2.

Ngay ở containment, phải tạo `list_my_pending_approvals_compat_v2`/detail scoped tương thích rồi revoke SELECT trực tiếp trên toàn bộ approval base tables. Việc này độc lập với money-writer drain và không được trì hoãn tới ACL cutover.

## 10. Backfill và cutover dữ liệu

### 10.0. Preflight/live catalog freeze

Trước migration phải snapshot database đích, không chỉ tin repo:

- `pg_policies` cho accounts/IE/items/sharing và các bảng liên quan;
- table/view/procedure ACL;
- `reloptions` của mọi view;
- function definitions/signatures của writer, approval và report;
- check constraints, indexes và composite FK thực tế;
- row count/SUM theo org/account/type/status/source;
- inventory `account_shared_users`, possession bindings và attachment objects.

Nếu live catalog khác semantics snapshot đã review, dừng rollout và cập nhật migration. Không apply theo tên policy/hàm đã lệch.

Trước initial backfill phải bật private change capture, không dựa riêng vào `updated_at`:

```text
finance_v2_backfill_runs
  run_id, source_snapshot_at, initial_watermark, applied_watermark
  final_watermark, state, started_at, completed_at

finance_v2_backfill_change_log
  sequence_id, organization_id, source_table, source_pk
  operation = INSERT | UPDATE | DELETE
  source_version_or_hash, txid, changed_at, applied_run_id, applied_at
```

- Trigger capture được cài trong schema inert trước khi chụp snapshot đầu tiên cho voucher/items/accounts/sharing/evidence và các source writer liên quan.
- Log phải có tombstone cho DELETE, tenant/source key và thứ tự đơn điệu; client không đọc/ghi được.
- Nếu bảng nguồn không thể gắn capture an toàn, organization phải `PAUSED` suốt initial scan + delta drain; không chấp nhận “backfill nhanh rồi hy vọng không có write”.

### 10.1. Backfill voucher/posting

Thứ tự suy nguồn:

1. Row có canonical `posting_id/posted_at_v2` và dữ liệu nhất quán.
2. Phiếu Thu có `payment_id`: dùng payment date/account/receipt thực.
3. Voucher legacy `APPROVED`, account thật, không hủy: dùng `voucher_date` và actor/timestamp lịch sử nếu chắc chắn là cash effect.
4. Internal/virtual/non-cash: phân loại `NON_CASH + NOT_APPLICABLE`, không tạo cash posting.
5. Mâu thuẫn hoặc thiếu nguồn: ghi exception, không đoán.

Mỗi posting backfill phải sinh signed lines MAIN/CHANGE/ROUNDING đúng công thức legacy để balance khớp tuyệt đối.

Backfill lịch sử không bắt tạo ảnh giả. Dùng waiver có audit `PRE_V2_HISTORY` và chỉ cho row trước cutover.

### 10.2. Backfill quyền sổ

- `accounts.user_id` hiện tại và possession `CUSTODIAN` chắc chắn → candidate CUSTODIAN.
- possession được auto-seed kiểu “owner mọi sổ” và `account_shared_users` → candidate cần phân loại, không tự nâng.
- User/org/account không khớp → exception.
- Quản trị viên phải xác nhận 100% binding trước cutover.
- Migration report ghi nguồn, quyết định, actor và thời điểm.

Organization id phải derive từ account/building/authoritative parent. Row mơ hồ vào exception; không fallback về organization PROD sentinel.

Attachment backfill parse object thành liên kết `(bucket, object_name, organization_id, voucher_id/posting_id)`. Object duplicate, cross-org hoặc không parse được vào exception và chỉ uploader/service role được đọc cho tới khi xử lý.

### 10.3. Delta catch-up và high-watermark

Backfill phải repeatable/upsert đối với projection mutable, nhưng tuyệt đối không UPDATE/DELETE posting event đã sinh. Có phase bắt kịp write đang chạy:

1. Chạy initial backfill từ consistent snapshot, lưu `initial_watermark`.
2. Deploy RPC/adapters feature-off; legacy write vẫn được trigger ghi vào change log.
3. Replay INSERT/UPDATE/DELETE idempotently theo `sequence_id` tới watermark; mỗi batch lưu `applied_watermark` và chạy parity.
4. Trước bật SHADOW, chuyển DEMO org sang `PAUSED` trong một barrier ngắn, chụp `final_watermark`, drain đến đúng watermark, xác nhận zero unapplied/tombstone/exception rồi mới bật SHADOW.
5. Trong SHADOW, adapters dual-write/mirror và change-log lag phải luôn về zero; mọi bypass chỉ ghi legacy vẫn được delta worker bắt và báo alert.
6. Ngay trước V2 cutover production, lặp lại `PAUSED → final watermark → drain → reconcile → CAS mode`; không dùng kết quả initial backfill cũ làm cutover truth.

Gate bắt buộc lưu source count/SUM/hash tại cùng snapshot với applied watermark. Delta replay cùng source version nhưng payload khác hoặc missing tombstone phải fail và vào exception, không last-write-wins âm thầm.

Contract xử lý source đã có shadow posting:

- UPDATE chỉ đổi note/metadata không ảnh hưởng cash semantics: cập nhật projection/header được phép, không chạm event/lines.
- UPDATE amount/type/account/change/rounding/posted date/status làm đổi cash effect và có thể project chắc chắn: trong một transaction khóa voucher, append REVERSAL cho active generation, append replacement POSTING generation mới với `source_kind='LEGACY_DELTA_REPLACEMENT'`, cập nhật active pointer/header mirror và đánh dấu change-log row applied.
- DELETE/cancel của row đã có cash effect: không hard-delete voucher và không chuyển thẳng `CANCELLED`. Compatibility delete guard ghi `legacy_source_deleted` tombstone, append REVERSAL để thành `APPROVED + REVERSED`; nếu nghĩa vụ KQKD cũng bị hủy thì dùng open-period removal/recognition adjustment riêng. Row chưa từng post mới có thể thành `CANCELLED + UNPOSTED`.
- Backfill migration phải cài delete guard trước khi tạo shadow posting đầu tiên. DELETE row chưa có event có thể thành tombstone-only; DELETE row đã được event tham chiếu mà bypass guard phải fail bởi FK/trigger, không cascade.
- Nếu không suy ra chắc chắn old/new cash projection, kỳ sổ bị khóa, source version nhảy cóc hoặc replacement vi phạm constraint thì ghi mandatory exception, giữ unapplied log và chuyển org `PAUSED`; không sửa event cũ để ép parity.
- V2 cutover bị chặn nếu còn active `LEGACY_BACKFILL/LEGACY_DELTA_REPLACEMENT` generation không khớp source hash cuối hoặc còn hard-delete exception.

Compatibility read semantics cho tombstone:

- mọi list/stats/export và legacy compatibility view/RPC ở `LEGACY`, `SHADOW`, `V2` mặc định thêm `legacy_source_deleted_at IS NULL`; RLS/read adapter phải áp cùng predicate, không chỉ ẩn ở UI;
- legacy balance/cash report trong SHADOW phải loại tombstoned source theo hành vi delete cũ, còn V2 balance lấy reversal lines; hai phía phải tie-out về cùng net effect;
- audit/reversal history vẫn đọc được qua detail/history RPC riêng với capability `finance.audit` hoặc quyền reversal, hiển thị marker/source hash nhưng không đưa row trở lại totals;
- P&L delete ở kỳ mở phải void base recognition trong cùng guard; kỳ khóa giữ snapshot và tạo adjustment. Nếu không xác định delete có nghĩa “void obligation” hay chỉ lỗi nguồn, vào exception và PAUSED;
- direct legacy query/function nào không thể thêm tombstone predicate phải được bọc/replaced trước initial delete guard; không để app cũ hiển thị lại row vừa xóa.

### 10.4. Shadow mode

Tạo `finance_v2_org_config`:

```text
LEGACY  = hành vi cũ
SHADOW  = writer cũ còn active, V2 mirror để đối chiếu
V2      = writer/read/RLS mới
PAUSED  = chặn money write, vẫn cho đọc/reconcile
```

Tạo private append-only `finance_v2_semantic_event_log` với organization, event kind, source table/id, source kind `BACKFILL|V2_WRITE`, actor, transaction/trace, created_at. Mọi primitive V2 append event trong cùng transaction; rollout checkpoint lưu baseline sequence để rollback gate phân biệt mirror backfill với semantic write thật. Client không có SELECT/DML.

Trong SHADOW:

- không hiển thị posting V2 như production truth;
- tính song song balance cũ/mới theo sổ và tháng;
- so P&L cũ/mới;
- đếm unresolved voucher/binding;
- log writer nào còn bypass;
- chỉ chuyển V2 khi mọi gate bằng 0/khớp tuyệt đối.

### 10.5. Cutover gate

- zero unresolved cash-impacting voucher;
- zero unclassified cashbook binding;
- zero unapplied change-log row tới final watermark và delta lag bằng 0;
- shadow balance khớp từng sổ/từng tháng;
- P&L tie-out, không double count khi approve/post;
- approval inbox không còn auto-post;
- tất cả direct DML/fallback v1 đã bị loại;
- RLS negative tests xanh;
- view `security_invoker` xanh;
- typecheck/tests/E2E/reconcile xanh;
- rollback/PAUSED đã diễn tập.

## 11. Read models, số dư, báo cáo và chốt kỳ

### 11.1. Ba nhóm consumer phải phân loại

Mỗi reference `APPROVED` phải được gắn một trong ba nhãn trong inventory:

1. **CASH_TRUTH:** số dư, dòng tiền, “đã trả/đã thu”, handover, reconciliation → đọc posting active và `posted_on`.
2. **WORKFLOW:** hàng chờ, approve/reject, quyền action → đọc `approval_status`/approval engine.
3. **PROFIT_RECOGNITION:** P&L, allocation, close → đọc recognized obligation/KQKD và `recognition_date`, không phụ thuộc posting.

Không merge PR cutover nếu còn hit `APPROVED` chưa được phân loại.

### 11.2. Số dư sổ quỹ

`accounts_with_balance` và mọi RPC sổ dùng công thức canonical:

```text
initial_amount
+ SUM(posting_lines.signed_amount theo account)
```

Điều kiện cash event:

- event/line cùng organization/account và qua composite FK;
- chỉ event `POSTING/REVERSAL` được tạo bởi writer canonical;
- reversal đóng góp signed lines đối dấu, không xóa posting gốc;
- thời gian báo cáo dùng `posted_on` của từng event;
- không lọc bằng `approval_status`.

Consumer bắt buộc audit:

- `src/hooks/useCashBook.ts`;
- `accounts_with_balance`;
- daily cashbook/cash flow;
- cashbook reconciliation;
- cash handover/net sweep;
- refund log;
- opening adjustment;
- invoice/utility “đã thu/đã trả”;
- dashboard cash KPIs;
- export và stats.

### 11.3. P&L dồn tích

Sửa replacement function của `fa_accrual_allocations`/`fa_monthly_pnl_accrual` theo công thức canonical theo từng kỳ:

```text
result(period) =
  nếu period đã khóa: immutable close snapshot của period
  nếu period đang mở: SUM(active BASE voucher allocations có base period = period)
                      + SUM(recognition adjustments có adjustment_period = period)
```

Trong đó:

- bỏ điều kiện `approval_status='APPROVED'` làm gate nhận diện KQKD;
- base query chỉ lấy `counts_in_business_result=true AND recognition_source_mode='BASE'`; `ADJUSTMENT_ONLY` luôn đóng góp zero từ header;
- với kỳ mở, `CANCELLED`/`WITHDRAWN_BY_MAKER` trước close bị loại khỏi base; với kỳ đã khóa, report không recompute từ trạng thái header hiện tại mà đọc immutable close snapshot;
- dùng `kqkd_amount`, item allocation/billing month và `recognition_date` cho base; adjustment dùng server-owned signed delta/allocation snapshot;
- bao gồm cả Chờ duyệt hợp lệ và Approved, không cộng lại khi approve hoặc post;
- cancel/correction sau close giữ nguyên base lịch sử và tạo delta adjustment ở kỳ mở; late voucher chọn `ADJUSTMENT_ONLY` nên không thể vừa vào base vừa vào catch-up;
- báo cáo nhiều kỳ/toàn timeline phải ghép canonical result của từng kỳ, không chạy một filter `NOT CANCELLED` trên header hiện tại;
- close source hash gồm base voucher id/version/mode/allocation và adjustment id/payload hash; verification đối chiếu cả tổng từng kỳ lẫn tổng toàn timeline để bắt drop/double-count;
- trả metadata/counter theo approval/posting để UI gắn nhãn.

Sửa đồng bộ:

- `fa_type_breakdown_accrual`;
- profit distribution desktop/mobile;
- finance analysis Expense/P&L;
- verification source totals/hash;
- mọi report profitability đang lọc `APPROVED`.

### 11.4. Chốt lợi nhuận

`profit_close_preview_v2`/`_profit_close_preview_core_v2`/`profit_close_v2` phải trả thêm:

```text
pending_kqkd_count
pending_kqkd_amount
approved_unposted_count
approved_unposted_amount
changes_requested_count
disputed_count
blocking_voucher_ids hoặc drill-down token an toàn
```

Gate chặn chỉ khi:

```text
approval_status = UNAPPROVED
AND counts_in_business_result = true
AND voucher có allocation thuộc kỳ đang chốt
AND voucher chưa CANCELLED
```

`APPROVED + UNPOSTED` là informational warning, không block.

`CHANGES_REQUESTED` và `DISPUTED` vẫn là blocker có owner/reason/deadline; `CANCELLED` không block và recognition đã được loại/điều chỉnh đúng quy trình.

Preview, source hash và insert snapshot phải lock/recheck cùng source trong transaction hoặc CAS; không để voucher pending phát sinh đồng thời lọt qua.

## 12. Kế hoạch frontend

### 12.1. Contract và helper dùng chung

Sửa trước mọi UI:

- `src/hooks/income-expenses/types.ts` — thêm approval/posting/recognition, version và capability.
- `src/lib/voucherSources.ts` — `voucherLayer()` chỉ trả CASH khi có posting active.
- Tạo helper pure `getVoucherDisplayState()` và `getVoucherActions()`.
- Filter tách `approvalStatus` và `postingStatus`; không dùng một status giả tổng hợp cho query server.
- Query keys bao gồm organization, access intent và version contract.

Mapping visible:

| Điều kiện | Phiếu chi | Phiếu thu |
|---|---|---|
| `UNAPPROVED + CHANGES_REQUESTED` | Cần bổ sung | Cần bổ sung |
| `UNAPPROVED + DISPUTED` | Đang tranh chấp | Đang tranh chấp |
| `UNAPPROVED + PENDING + UNPOSTED` | Chờ duyệt | Chờ duyệt |
| `APPROVED + UNPOSTED` | Đã Duyệt - Chưa Chi | Đã Duyệt - Chưa Thu |
| active posting | Đã Chi | Đã Thu |
| reversed | Đã hoàn tác | Đã hoàn tác |
| cancelled | Đã hủy | Đã hủy |

### 12.2. Trang Thu Chi desktop/mobile

Files chính:

- `src/pages/payments/IncomeExpensePage.tsx`;
- `src/pages/payments/IncomeExpenseMobilePage.tsx`;
- `src/components/income-expenses/IncomeExpenseList*.tsx`;
- detail desktop/mobile;
- stats desktop/mobile;
- filters/panel/chips;
- `VoucherStatusBadge.tsx`;
- `VoucherDetailPage.tsx`.

Yêu cầu UI:

- xóa toàn bộ chữ Nháp trong domain Thu Chi;
- pending có action Duyệt chỉ khi capability cho phép;
- CHANGES_REQUESTED có badge/field mask/reason và action sửa + resubmit cho maker;
- DISPUTED có queue riêng, owner/deadline/reason và action resolve theo quyền;
- approved-unposted có action Thu/Chi cho CUSTODIAN;
- posted không cho full edit/quick-edit account/evidence;
- reversed/cancelled không được thao tác như active;
- stats Thu/Chi chỉ tổng posting active;
- hiển thị riêng Chờ duyệt và Đã Duyệt - Chưa Thu/Chi;
- list, totals, pagination, search và export dùng cùng server predicate;
- không fetch tất cả rồi lọc theo role ở client.

### 12.3. Posting dialog dùng chung

Tạo component mới, ví dụ:

- `src/components/income-expenses/IncomeExpensePostingDialog.tsx`;
- `src/lib/incomeExpensePostingValidation.ts`;
- unit/property tests tương ứng.

Form chỉ có ba trường người dùng nhập ở phase đầu:

- ngày Thu/Chi;
- sổ quỹ;
- hình ảnh/chứng từ.

Số tiền read-only bằng total đã duyệt. Dialog nhận `mode='POST_APPROVED' | 'APPROVE_AND_POST'`, capability, versions và idempotency key. Cùng component được dùng ở page Thu Chi và Approval inbox.

### 12.4. Approval inbox

Sửa:

- `src/hooks/useApprovals.ts`;
- `src/pages/approvals/ApprovalsPage.tsx`.

Yêu cầu:

- Approve-only không invalidate balance như một cash event;
- nút Duyệt mở lựa chọn Duyệt hoặc Thu/Chi;
- Thu/Chi chỉ enable nếu capability server trả về cho biết actor vừa approver vừa CUSTODIAN;
- approver không giữ sổ chỉ thấy Duyệt;
- inbox không mở quyền xem toàn bộ lịch sử sổ;
- request version/idempotency được truyền vào RPC.
- action Yêu cầu bổ sung/Từ chối phải bắt reason và chọn outcome hợp lệ: CHANGES_REQUESTED, DISPUTED hoặc CANCELLED-invalid; không đóng request mơ hồ.

### 12.5. Cài đặt sổ quỹ

Sửa:

- `src/components/cashbooks/CashbookForm.tsx`;
- `CashbookDetailDialog.tsx`;
- list desktop/mobile;
- `src/pages/settings/finance/CashbooksMobilePage.tsx`;
- `src/hooks/useAccounts.ts` hoặc hooks V2 mới.

UI có hai danh sách rõ ràng:

- **Người giữ sổ quỹ**;
- **Người biết sổ**.

Mở form/detail quản trị phải gọi `get_cashbook_access_admin_v2(cashbookId)` để lấy current revision, hai danh sách đang gán và eligible active memberships với safe fields; không đọc `cashbook_access_bindings`/history trực tiếp. Save gọi `set_cashbook_access_v2` CAS nguyên tử bằng revision vừa đọc, không sync `account_shared_users` trực tiếp. UI ẩn/disable edit/share/lock/delete theo capability server; deep-link sang Thu Chi vẫn chịu RLS, không tin filter URL.

### 12.6. Account selector theo intent

- Form Phiếu thu: danh sách CUSTODIAN + KNOWER.
- Form Phiếu chi: chỉ CUSTODIAN hoặc account gợi ý do workflow nhưng post vẫn recheck CUSTODIAN.
- Posting dialog: chỉ cashbook actor đang là CUSTODIAN.
- Balance/list quản trị: chỉ shape có quyền xem balance.
- Không dùng `useAccounts()` chung trả toàn bộ cột cho mọi màn.

### 12.7. Quick edit và sửa sai

- Pending: chỉ sửa các field được phép, giữ audit/version.
- Approved-unposted: khóa amount, kỳ KQKD và classification; chỉ posting dialog bổ sung metadata tiền.
- Posted: không sửa account/date/evidence/amount trực tiếp.
- Sai sau posting: dùng reversal + phiếu thay thế.

## 13. Chuỗi migration/release đề xuất

Không sửa migration lịch sử. Tạo replacement migrations theo thứ tự:

1. `*_finance_v2_semantics_snapshot.sql`
   - snapshot catalog/policy/writer/consumer và assertions baseline.
2. `*_finance_v2_schema_inert.sql`
   - config rollout, posting/lines/evidence/access/CAS/recognition-adjustment/lifecycle-request tables, audit + semantic-event log, private backfill run/change-log + capture triggers, header columns nullable, indexes/FK/constraints NOT VALID.
3. `*_finance_v2_containment.sql`
   - đóng co-staff/all-building/storage leak; tạo approval inbox/detail compatibility-scoped và revoke approval base-table SELECT ngay; chưa revoke money caller legacy chưa chuyển.
4. `*_finance_v2_backfill.sql`
   - consistent initial snapshot, initial watermark, backfill posting/recognition/access candidates và exception tables.
5. `*_finance_v2_writers.sql`
   - private primitives/public RPC, reject/resubmit, idempotency, locks, approval-only semantics.
6. `*_finance_v2_system_writer_adapters.sql`
   - recurring/batch/import/payment/utility/salary/profit/handover/termination adapters và compatibility wrappers.
7. `*_finance_v2_delta_catchup.sql`
   - repeatable change-log replay, delete tombstones, applied/final watermark assertions và zero-lag gate; chạy lại trước mỗi mode change.
8. `*_finance_v2_shadow_reconcile.sql`
   - shadow views/RPC, parity report và bypass/delta-lag monitoring.
9. `*_finance_v2_read_models.sql`
   - balance/cash reports/P&L/close/read stats.
10. `*_finance_v2_rls_prepare.sql`
   - deploy mode-aware safe policies/read RPCs và private storage; chạy SHADOW/DEMO tests.
11. `*_finance_v2_acl_cutover.sql`
   - sau khi mọi caller đã chuyển: drop remaining broad money policies, revoke direct DML và validate bindings; approval base SELECT đã bị revoke từ containment.
12. `*_finance_v2_cutover.sql`
   - validate constraints, defaults/not-null, disable v1 bypass, org mode V2.
13. `*_finance_v2_contract_cleanup.sql` — release sau, không cùng đợt đầu.

Mỗi migration phải có:

- precondition/assertion rõ;
- idempotent guard hợp lý;
- comments ghi semantics;
- revoke/grant explicit;
- rollback/forward-fix note;
- test static và test DB tương ứng.

## 14. Critical files và ownership đề xuất

### 14.1. Database/authz

| Nhóm | File/symbol cần đọc hoặc replacement |
|---|---|
| Approval schema/engine | `supabase/migrations/20260713130000_sprint4a_approval_engine_schema.sql`, `20260713130200_sprint4c_approval_rpcs.sql`, `scripts/authz-prepared/prod-snapshot/PS01_engine_approval_v2.sql` |
| Create/approve lifecycle | `scripts/authz-prepared/t5_08_ie_lifecycle_writers.sql`, `t5_21_ie_auto_approve.sql`, `t5_24_ie_birth_status_policy.sql`, `t5_26_engine_guard_inbox.sql`, `PS05_misc_remaining.sql` |
| Income expense policies | `20260702150000_rls_initplan_setbased_select.sql`, `20260703161000_ie_select_policies_setbased.sql`, `20260703170000_write_policies_setbased.sql` |
| Shared/access | `20260516000004_account_shared_users.sql`, `20260516000005_account_shared_users_fix_recursion.sql`, `20260713120000_sprint3a_org_rollout_all_tables.sql`, `cashbook_possession_bindings` definitions |
| Balance/view | `20260704100000_accounts_is_virtual.sql`, `20260704180000_views_security_invoker.sql`, perf/reconciliation migrations |
| P&L accrual | `20260626000000_fa_accrual_pnl.sql`, KQKD item-level migrations, money aggregate RPCs |
| Profit close | `20260720210000_profit_close_v2.sql`, `20260720213000_*`, `20260720215000_*`, `20260720223000_*` |
| Recurring/system | recurring draft/rewrite migrations, invoice/payment/utility/termination/salary/profit/handover writers |
| Storage | payment receipt/attachment bucket migrations và signed URL functions |

### 14.2. Frontend core Thu Chi

| Nhóm | Files |
|---|---|
| Types/query/mutations | `src/hooks/income-expenses/types.ts`, `queries.ts`, `mutations.ts`, `statusMutations.ts`, `batch.ts`, `recurring.ts`, `specialized.ts` |
| State helper | `src/lib/voucherSources.ts`, helper combined-state mới |
| Desktop/mobile page | `src/pages/payments/IncomeExpensePage.tsx`, `IncomeExpenseMobilePage.tsx`, `VoucherDetailPage.tsx` |
| Components | `src/components/income-expenses/*` |
| Validation | `src/lib/incomeExpenseValidation.ts`, posting validation mới |
| Approval inbox | `src/hooks/useApprovals.ts`, `src/pages/approvals/ApprovalsPage.tsx` |

### 14.3. Cashbook/access

- `src/hooks/useAccounts.ts`;
- `src/hooks/useCashBook.ts`;
- `src/components/cashbooks/*`;
- `src/pages/settings/finance/CashbooksMobilePage.tsx` và desktop route tương ứng;
- Daily Cashbook, Cash Flow, reconciliation và handover pages/hooks.

### 14.4. Profit/reporting

- `src/hooks/useAccrualReport.ts`;
- `src/hooks/useShareholderProfit.ts`;
- `src/lib/profitClose.ts`;
- `src/components/shareholders/ProfitLockTab.tsx`;
- `src/pages/reports/finance/ProfitDistributionReport.tsx`;
- `src/pages/reports/finance/ProfitDistributionMobile.tsx`;
- `src/components/finance-analysis/ExpenseTab.tsx`;
- `src/hooks/reports/financeReports.ts`;
- `src/hooks/reports/realEstateReports.ts`;
- verification/dashboard consumers.

### 14.5. Secondary money consumers/writers

- `src/hooks/useUtilityBills.ts`;
- `src/hooks/useInvoicePayments.ts`, `usePayments.ts`, `useQuickCollect.ts`, `useInvoices.ts`;
- `src/hooks/useManagerSalary.ts`;
- `src/components/thu-tien/*`;
- invoice/deposit/contract components;
- `src/copilot/tools/writeTools.ts`;
- refund/termination/opening adjustment/cash handover domains.

### 14.6. Quy tắc ownership

- Không chạy hai write-capable agent trên cùng file/domain.
- Backend contract/types phải land trước UI.
- Cash/P&L workstreams tách owner vì semantics đối lập: cash đọc POSTED, P&L đọc recognized obligation.
- Secondary writers chỉ bắt đầu sau khi primitives/RPC V2 ổn định.
- Reviewer cuối quét toàn repo, không chỉ diff.

## 15. Đồng bộ với chuỗi kế toán đang dang dở

Tại thời điểm lập plan, một worktree/branch kế toán khác có thay đổi chưa commit chạm trực tiếp các file và migration Finance V2. Agent triển khai phải:

1. yêu cầu/tạo commit riêng cho chuỗi thay đổi đó;
2. rebase Finance V2 lên baseline mới;
3. port có chủ đích, không copy/cherry-pick mù;
4. chạy lại semantics snapshot và inventory sau rebase.

Các migration được quan sát cần đánh giá trước Finance V2:

- `20260721070000_accounting_rollout_prerequisites.sql`;
- `20260721075000_accounting_canary_caps.sql`;
- `20260721080000_accounting_semantics_snapshot.sql`;
- `20260721100000_invoice_collection_v5.sql`;
- `20260721102000_active_payments_reporting.sql`;
- `20260721110000_profit_unallocated_integrity_v3.sql`;
- `20260721120000_profit_payout_reservations_v2.sql`;
- `20260721130000_accounting_history_repair.sql`;
- `20260721132500_accounting_history_resolution_v1.sql`;
- `20260721135500_termination_non_cash_payment_semantics.sql`;
- `20260721140000_accounting_rollout_gate_v1.sql`.

Nguyên tắc merge:

- history repair/resolution phải chạy trước posting backfill;
- invoice collection phải tạo posting V2 thay vì direct APPROVED;
- profit payout phải tách nghĩa vụ và lần Chi thực tế;
- termination non-cash phải map `NON_CASH + NOT_APPLICABLE`;
- các changes ở `queries.ts`, `types.ts`, `IncomeExpensePage.tsx`, payment/profit hooks phải được merge sau khi contract V2 chốt.

## 16. Test plan bắt buộc

### 16.1. Static/migration tests

Thêm test đọc migration để khẳng định:

- có posting/access tables, composite FK, active pointer/generation guard và tối đa một posting chưa reverse;
- không grant client DML lên bảng canonical;
- public RPC revoke `PUBLIC/anon` và grant đúng role;
- policy rộng cũ bị drop/rewrite;
- `accounts_with_balance` dùng posting, có `security_invoker=true`;
- approval engine không auto-post khi approve;
- approval request constraint/history hỗ trợ `APPROVED/WITHDRAWN/CHANGES_REQUESTED/DISPUTED` + outcome fields; writer mới không set `POSTED` và one-open index chỉ xét PENDING;
- lifecycle mutation registry có org/key uniqueness, payload hash/result snapshot và không có client access;
- phase 1 chặn partial/multi-cashbook;
- storage không public;
- approval base tables không grant SELECT cho authenticated;
- evidence registry/link dùng composite org FK, posting không nhận raw object path;
- evidence ORIGINAL unique; legacy delta inheritance chỉ cùng voucher lineage/pre-cutover, waiver `PRE_V2_LEGACY_DELTA` bắt source hashes và không dùng sau cutover;
- access state/request tables hỗ trợ revision + idempotency và normal RPC chặn self-role change;
- recognition adjustment có composite tenant FK, unique org/idempotency, payload hash, immutable trigger và không có client DML;
- accrual source bắt buộc phân biệt `BASE/ADJUSTMENT_ONLY`; closed period đọc snapshot thay vì current header status;
- backfill change capture có INSERT/UPDATE/DELETE tombstone, run/high-watermark state; semantic-event log phân biệt BACKFILL với V2_WRITE;
- legacy cash-impacting delta dùng immutable reversal + replacement generation hoặc mandatory exception; không UPDATE/DELETE posting event;
- tombstone marker/predicate có trong mọi LEGACY/SHADOW/V2 list/stats/export compatibility path; audit RPC là ngoại lệ có capability;
- admin cashbook read RPC yêu cầu `cashbooks.share` exact scope và không trả balance/history/audit;
- cutover gate fail nếu exception > 0.

Tên test gợi ý:

- `src/lib/__tests__/financeV2SchemaMigration.test.ts`;
- `financeV2RlsMigration.test.ts`;
- `financeV2WriterMigration.test.ts`;
- `financeV2ReadModelsMigration.test.ts`;
- `financeV2CutoverMigration.test.ts`.

### 16.2. DB/RPC state tests

| Case | Kỳ vọng |
|---|---|
| Tạo Phiếu chi | `UNAPPROVED + UNPOSTED`, balance không đổi. |
| Pending thuộc KQKD | Có trong P&L, block close. |
| Duyệt | `APPROVED + UNPOSTED`, balance không đổi. |
| Duyệt và Chi | Approval + posting atomic. |
| Chi sau duyệt | CUSTODIAN không có approve vẫn post được. |
| Approver không giữ sổ | Duyệt được, post bị chặn. |
| Thiếu ngày/sổ/ảnh | Toàn transaction fail. |
| Retry cùng key | Trả cùng result, một posting. |
| Cùng key khác payload | Fail conflict. |
| Retry approve/request-changes/reject/withdraw/resubmit | Cùng key/payload trả result snapshot cũ, không thêm transition/submission/audit; khác payload fail. |
| Hai actor cùng post | Chỉ một active posting. |
| Version cũ | Fail optimistic concurrency. |
| Revoke binding trong lúc chờ lock | Recheck và fail. |
| Ngày post trong kỳ khóa | Fail. |
| Nghĩa vụ tháng trước, Chi tháng sau | P&L tháng trước giữ nguyên; cash tháng sau đổi. |
| Hủy posted row | Fail; phải reversal. |
| Reversal | Row/event gốc bất biến; balance bù đúng. |
| Request changes | Vẫn UNAPPROVED/CHANGES_REQUESTED, block close, resubmit tăng version. |
| Request changes rồi resubmit | Request cũ terminal CHANGES_REQUESTED + outcome; partial unique được giải phóng; đúng một request mới PENDING, không reopen row cũ. |
| Reject invalid/duplicate | CANCELLED + UNPOSTED, recognition loại/điều chỉnh đúng kỳ. |
| Mark disputed | Voucher và request thành DISPUTED, vẫn recognized + block close, có owner/reason/deadline/outcome; không còn request PENDING giả. |
| Maker withdraw pending ở kỳ mở | Atomic `CANCELLED + RESOLVED + WITHDRAWN_BY_MAKER`, đóng approval request, bỏ P&L/blocker, balance không đổi. |
| Maker withdraw sau CHANGES_REQUESTED | Voucher cancelled; request CHANGES_REQUESTED cũ bất biến, withdrawal audit append đúng một lần, không sinh request giả. |
| Maker withdraw system/disputed/approved/posted/kỳ khóa | Fail; không đổi voucher, recognition, approval request hoặc audit ngoài failure trace. |
| MAIN + CHANGE + ROUNDING | `abs(MAIN)=gross_amount`, `net_cash_effect=sum(lines)`, parity đúng. |
| Cancel/reject-invalid sau close | Không làm live source của snapshot cũ biến mất; yêu cầu reopen hoặc adjustment kỳ mở. |
| Tạo muộn với recognition kỳ đã khóa | Bị chặn backdate; chỉ reopen hoặc catch-up adjustment. |
| Catch-up late recognition | Voucher là `ADJUSTMENT_ONLY`, header contribution bằng zero, positive adjustment xuất hiện đúng một lần ở kỳ mở. |
| Cancel/correct base sau close | Base kỳ khóa giữ nguyên; chỉ delta adjustment vào kỳ mở; tổng toàn timeline không drop/double-count. |
| Adjustment retry/forgery | Cùng key cùng payload trả cùng result; khác payload, direct DML, cross-org, forged amount/allocation/actor đều fail. |
| Legacy UPDATE amount/account/status sau initial backfill | Không sửa event cũ; append reversal + replacement generation nếu deterministic, active pointer/hash/tổng đúng. |
| Legacy replacement có evidence cũ | Thu và Chi đều tạo inherited evidence snapshot đúng lineage/hash; object không attach được sang voucher khác. |
| Legacy replacement của waiver backfill | Chỉ pre-cutover dùng `PRE_V2_LEGACY_DELTA` với old/new hash/change-log id; cùng payload idempotent, sau V2 bị chặn. |
| Legacy DELETE/cancel sau initial backfill | Delete guard giữ voucher/tombstone; row đã cash thành APPROVED+REVERSED, recognition xử lý riêng; bypass/ambiguous/locked-period thành mandatory exception, không cascade/mutate event. |
| Read sau legacy DELETE | LEGACY/SHADOW/V2 list, stats, export và default detail không trả tombstone; balance net reversal, P&L open/closed đúng; audit-capable history vẫn thấy. |
| Legacy INSERT/UPDATE/DELETE trong initial backfill | Change log bắt đủ kể cả tombstone; delta replay tới final watermark cho count/SUM/hash khớp cùng snapshot. |
| Rollback SHADOW | Chỉ cho về LEGACY khi không có V2_WRITE semantic event và zero unapplied delta; mọi V2-only state/event buộc PAUSED + forward-fix. |

### 16.3. RLS/tenant matrix

| Persona | Phải thấy/làm được | Phải bị chặn |
|---|---|---|
| CUSTODIAN sổ A | Balance/history/Thu/Chi sổ A | Sổ B nếu không binding. |
| KNOWER sổ A | Tên sổ trong form Thu, own-created INCOME | Balance, stats, export, EXPENSE, phiếu/ảnh người khác. |
| Approver-only | Approval inbox và Duyệt | Thu/Chi, balance/history toàn sổ. |
| CUSTODIAN-only | Post approved voucher | Duyệt pending. |
| CUSTODIAN + approver | Duyệt và Thu/Chi atomic | Sổ ngoài binding. |
| Không binding | Không thấy tên sổ | Direct ID/detail/stats/search. |
| User nhiều org | Chỉ org/membership đã chọn | Ghép cashbook/voucher/membership chéo org. |
| User thường | Không self-grant | Direct insert binding/share RPC không quyền. |
| Actor có share permission | Quản trị role người khác theo scope/CAS | Không tự đổi role chính mình qua normal RPC; stale/replay bị chặn. |
| Actor có share permission sổ A | Admin RPC trả revision, assignments và eligible membership safe fields của A | Binding history/audit/balance, sổ B hoặc membership ngoài scope. |
| Actor không có share permission | Không có admin access shape | Đoán cashbook id để gọi admin RPC hoặc đọc base bindings. |
| Non-approver cùng org | Chỉ dữ liệu thường được scope | REST SELECT approval request/step/candidate/decision/audit bị chặn. |
| Evidence owner A | Attach/sign proof A hợp lệ | Không tham chiếu/overwrite/finalize object org B. |
| Legacy delta worker | Inherit evidence trong đúng voucher lineage trước cutover | Client/user reuse inherited link, đổi hash, gắn voucher khác hoặc dùng waiver sau V2. |
| User thường với tombstone id | Không thấy trong list/stats/default detail | Đoán id/filter/export để đọc soft-deleted row; chỉ audit capability được history. |
| Close/adjust actor | Tạo adjustment qua scoped RPC ở kỳ mở | Không direct DML, không ghép voucher/close run org khác. |
| User không có quyền adjust | Xem report theo capability nếu được cấp | Không insert/list raw adjustment hoặc đoán adjustment id. |

Test cả REST, RPC, view, search, count, pagination, export và signed URL; không chỉ test UI.

### 16.4. Unit/property tests frontend

- combined state → label/action đúng cho mọi tổ hợp;
- review state → badge/action/queue đúng cho PENDING, CHANGES_REQUESTED, DISPUTED, RESOLVED;
- `voucherLayer` chỉ CASH khi posting active;
- stats chỉ cộng posting, có counter pending/unposted;
- validation bắt ngày/account/ít nhất một ảnh;
- action matrix approver-only/custodian-only/both/knower;
- approve/post không đổi recognized amount;
- POSTED không quick-edit account/evidence;
- recurring/import/batch không tự thành money truth;
- update `src/hooks/__tests__/useIncomeExpenses.property.test.ts`;
- mở rộng `src/lib/__tests__/profitClose.test.ts`.

### 16.5. E2E headless

Tạo:

- `.e2e-fleet/specs/finance-posting-flow.spec.ts`;
- `.e2e-fleet/specs/finance-cashbook-scope.spec.ts`;
- `.e2e-fleet/specs/finance-profit-close.spec.ts`;
- `.e2e-fleet/specs/finance-writers.spec.ts`.

Case bắt buộc:

1. Tạo phiếu → Chờ duyệt, balance không đổi.
2. Approver-only Duyệt → Đã Duyệt - Chưa Chi, balance không đổi.
3. CUSTODIAN-only Chi phiếu đã duyệt.
4. CUSTODIAN + approver Duyệt và Chi với đủ ba field.
5. Thiếu field/permission/lock/version → rollback.
6. Double-click/retry → một posting.
7. Desktop/mobile parity về nhãn/action/tổng.
8. Cash report dùng `posted_on` khác `voucher_date`.
9. KNOWER chỉ thấy own Income, không balance/Expense/ảnh khác.
10. Direct URL/ID/filter không leak.
11. P&L gồm pending obligation; approve/post không double count.
12. Close bị chặn bởi pending KQKD, không chặn approved-unposted.
13. Recurring/import/batch tạo Unposted.
14. System writer tiền thật tạo posting hợp lệ.
15. Reversal bù số và giữ audit.
16. Request changes đóng request cũ với outcome → maker thấy Cần bổ sung, sửa field mask và resubmit tạo đúng một request mới; disputed đóng request cũ và vào queue owner/deadline.
17. Maker rút pending ở kỳ mở → Cancelled/Resolved và bỏ blocker; system/disputed/approved/posted/kỳ khóa không rút được.
18. Late-created/cancelled-after-close không sửa snapshot cũ; BASE/ADJUSTMENT_ONLY và adjustment kỳ mở cho tổng từng kỳ/toàn timeline đúng một lần.
19. Direct/cross-org/forged/replayed recognition adjustment bị chặn; retry hợp lệ idempotent.
20. Hai posting đồng thời dùng cùng evidence id: chỉ một attach thắng; cross-org object reference/overwrite bị chặn.
21. Retry lifecycle RPC cùng key/payload trả cùng result không lặp audit/submission; approval history hiển thị `WITHDRAWN` đúng và inbox không còn row đã rút.
22. Cashbook admin có share permission tải đúng revision + hai danh sách safe rồi CAS save; user không share/direct base read/cross-cashbook id đều bị chặn.
23. Legacy Thu/Chi delta replacement kế thừa evidence đúng lineage hoặc waiver pre-cutover có audit; cross-voucher/reuse/sau-V2 đều fail.
24. Legacy delete không hiện lại trong list/stats/export/default detail ở LEGACY/SHADOW/V2; balance/P&L đúng và audit history vẫn truy cập theo quyền.

Mọi E2E:

- chỉ ghi org DEMO `dddd0000-…0001`;
- cleanup fixture cuối test;
- kiểm console/page errors;
- chạy desktop và mobile;
- không dùng org thật để ghi.

### 16.6. Verification commands

```bash
npm run typecheck:baseline
npx tsc --noEmit -p tsconfig.app.json
npx vitest run <các test liên quan>
node scripts/check-view-invoker.mjs
node scripts/reconcile-money.mjs YYYY-MM
cd .e2e-fleet && FLEET_WORKERS=8 npx playwright test specs/finance-*.spec.ts
```

Sau migration schema:

```bash
npm run gen:types > src/integrations/supabase/types.ts
```

Thêm lại comment header đầu file types theo convention repo. Không dùng `as any` để che types trôi.

## 17. Chia việc cho các agent AI

### Agent 0 — Coordinator/architect

- Rebase baseline và khóa contract.
- Tạo inventory tất cả hit `APPROVED` với classification CASH/WORKFLOW/PROFIT.
- Chốt source classification và migration dependency.
- Không viết code domain nếu agent khác đang sở hữu file.

### Agent 1 — Schema/posting/backfill

Ownership:

- migrations schema inert;
- posting/access/config/audit/recognition-adjustment/lifecycle-request/semantic-event tables và immutability constraints;
- initial + delta backfill, change capture, high-watermark, exception/shadow reconcile;
- static migration tests tương ứng.

Không sửa frontend/RLS consumer.

### Agent 2 — RPC/approval/state machine

Ownership:

- private primitives/public RPC;
- approval engine replacement, `WITHDRAWN`, withdraw state và recognition-adjustment writer;
- locks/lifecycle idempotency registry/version/audit;
- DB concurrency/state tests.

Phụ thuộc Agent 1.

### Agent 3 — RLS/read shapes/storage

Ownership:

- policy inventory/drop/rewrite;
- safe list/detail/stats/account APIs;
- storage private/signed URL;
- negative tenant/RLS tests.

Phụ thuộc schema/RPC contract, không overlap migrations Agent 2.

### Agent 4 — Cash/read models

Ownership:

- `accounts_with_balance`;
- cashbook hooks/reports/reconcile/handover;
- CASH consumers;
- money reconciliation tests.

### Agent 5 — Profit/close

Ownership:

- accrual/KQKD read models;
- profit report/verification/close, BASE/ADJUSTMENT_ONLY formula và timeline hash;
- pending blockers và approved-unposted warnings;
- profit tests.

Không dùng `POSTED` làm P&L gate.

### Agent 6 — Thu Chi UI

Ownership:

- types/helpers sau contract land;
- pages/components Thu Chi desktop/mobile;
- posting dialog, badge, filter, stats, detail;
- UI/unit/property tests.

### Agent 7 — Cashbook settings + approval inbox

Ownership:

- account intent hooks;
- cashbook role settings/list/detail;
- Approval inbox và capability UI;
- E2E permission/action.

Chỉ bắt đầu sau Agent 3/6 contracts.

### Agent 8 — Secondary writers

Chia nhỏ theo domain, không để một agent sửa mọi file:

- batch/import/recurring;
- invoice/quick collect/deposit;
- utility/refund/termination;
- salary/commission/profit payout;
- opening adjustment/handover/Copilot.

Mỗi domain phải khai báo writer class và test không bypass.

### Agent 9 — Independent reviewer

- Review schema, state transition, RLS, migration safety và money semantics.
- Quét toàn repo, findings trước summary.
- Không chấp nhận:
  - money truth còn dựa `APPROVED`;
  - P&L bị đổi sang `POSTED`;
  - policy rộng OR-merge;
  - direct DML/fallback v1;
  - UI-only permission;
  - thiếu negative/concurrency/reconcile test.

## 18. Commit series đề xuất

1. `test(finance): characterize approval cashbook and profit semantics`
2. `feat(finance-db): add posting and cashbook access schema`
3. `feat(finance-db): backfill and shadow reconciliation`
4. `feat(finance-db): add canonical approval and posting writers`
5. `fix(finance-authz): enforce cashbook-scoped RLS and private evidence`
6. `feat(finance-report): move cash truth to postings`
7. `feat(finance-profit): include pending obligations and lock gate`
8. `feat(income-expense): add approve and post workflow`
9. `feat(cashbooks): split custodian and knower access`
10. `fix(finance-writers): migrate batch recurring and system writers`
11. `test(finance): complete RLS concurrency reconciliation and E2E`
12. `chore(finance): cut over V2 and disable legacy bypasses`

Mỗi commit phải stage file cụ thể, không `git add -A`, có trailer Codex nếu Codex thực hiện.

## 19. Rollback và xử lý sự cố

### 19.1. Trước khi có V2 write

- Schema additive/inert có thể rollback bằng drop object mới nếu chưa có dữ liệu V2.
- LEGACY writer/read giữ nguyên.
- Không drop cột/RPC/view cũ.

### 19.2. Trong SHADOW

- Chỉ được chuyển org `SHADOW → LEGACY` khi semantic-event gate xác nhận **không có bất kỳ V2-only write nào sau baseline** và compatibility projection biểu diễn được toàn bộ state hiện tại.
- V2-only bao gồm: Approved-Unposted theo semantics mới; POSTING/REVERSAL mới; CHANGES_REQUESTED/DISPUTED/WITHDRAWN/resubmit V2; recognition adjustment hoặc `ADJUSTMENT_ONLY`; access-role mutation chỉ có ở binding V2; evidence relation chỉ gắn với event V2; và mọi system-writer result không có legacy equivalent.
- Backfill mirror thuần túy không tự chặn rollback, nhưng mọi non-backfill semantic event phải được đếm trong durable `finance_v2_semantic_event_log`/rollout checkpoint; không suy luận chỉ từ số posting.
- Nếu gate không chắc chắn hoặc còn unapplied delta, chuyển `PAUSED` và forward-fix; không downgrade.
- Giữ exception/audit/parity report để sửa forward.
- Không xóa dữ liệu backfill chỉ để làm dashboard xanh.

### 19.3. Sau khi có bất kỳ semantic write V2

Không được rollback app về semantics `APPROVED = cash` hoặc source recognition/access legacy; việc đó có thể làm sai số dư, P&L, approval history hoặc quyền sổ.

Runbook:

1. Chuyển org/system sang `PAUSED` để chặn money write.
2. Giữ read model posting V2.
3. Khoanh request/writer/policy gây lỗi bằng trace/idempotency/audit.
4. Reconcile per account/month.
5. Forward-fix migration/RPC.
6. Dùng reversal/compensating event nếu tiền đã post sai.
7. Chỉ mở lại writer sau khi gate xanh.

Không bao giờ:

- xóa posting/audit;
- sửa trực tiếp amount/date/account của posting;
- restore policy SELECT/storage rộng;
- fallback org mơ hồ về PROD;
- re-enable raw DML ngoài maintenance break-glass đã phê duyệt.

### 19.4. Snapshot rollback assets

Trước cutover lưu hash-locked:

- old view definitions;
- old policy/ACL catalog;
- RPC signatures/definitions;
- old/new balances theo sổ;
- exception counts;
- app version và migration version.

## 20. Release plan

1. Chốt và land các thay đổi kế toán active liên quan; rebase baseline.
2. Chạy live-catalog snapshot, characterization tests và consumer/writer inventory.
3. Deploy schema inert và bật private change capture trước source snapshot đầu tiên.
4. Deploy containment: đóng co-staff/all-building/storage leak, bật scoped approval inbox compatibility và revoke approval base-table SELECT.
5. Chụp consistent snapshot/initial watermark, chạy initial backfill + exception review trong khi change log bắt mọi write mới.
6. Deploy RPC V2 và **toàn bộ** system-writer/legacy caller adapters feature-off.
7. Replay delta idempotently; `PAUSED` DEMO ngắn để chụp final watermark, drain zero-lag và reconcile rồi mới bật SHADOW.
8. Bật SHADOW cho DEMO org; giám sát dual-write, bypass log, delta lag và parity.
9. Deploy read models cash/P&L/close và frontend compatibility/V2.
10. Deploy mode-aware RLS/read shapes; chưa ACL-drain caller chưa chuyển.
11. Chuyển DEMO org sang V2, chạy DB/RLS/E2E/reconcile nhiều kỳ.
12. Khi caller count legacy = 0, chạy ACL cutover: revoke direct money DML và drop remaining broad money policies.
13. Chọn maintenance window cho org thật; `PAUSED`, capture/drain final watermark, reconcile cùng snapshot rồi chuyển `PAUSED → V2` bằng CAS.
14. Theo dõi logs, balance parity, approval queue, posting failures, delta lag và RLS denials.
15. Sau ít nhất một chu kỳ ổn định mới contract/cleanup legacy cuối cùng.

Không push cutover nếu Vercel/app được deploy nhưng migration chưa apply hoặc ngược lại. UI/RPC/schema phải có compatibility gate theo org mode.

## 21. Acceptance criteria cuối cùng

### Nghiệp vụ/state

- [ ] Toàn bộ domain Thu Chi không còn chữ Nháp cho `UNAPPROVED`.
- [ ] Tạo voucher không làm đổi balance.
- [ ] Duyệt không làm đổi balance.
- [ ] Đã Duyệt - Chưa Chi/Thu không chặn close.
- [ ] Duyệt và Thu/Chi atomic, rollback toàn bộ khi lỗi.
- [ ] Thu/Chi sau duyệt không yêu cầu actor có quyền approve.
- [ ] Phase đầu không partial/multi-cashbook.
- [ ] Posted row không sửa trực tiếp; reversal có audit.
- [ ] Request changes/resubmit, reject-invalid và disputed resolution có transition rõ; không có UNAPPROVED bị treo vô hạn ngoài hàng đợi có owner/deadline.
- [ ] Maker withdraw chỉ áp dụng cho own human-created `UNAPPROVED + UNPOSTED + PENDING/CHANGES_REQUESTED` ở kỳ mở; transition/audit/idempotency đúng và mọi state/source khác bị chặn.
- [ ] Approval request có terminal `WITHDRAWN`, inbox/history/index semantics đúng; lifecycle retry không tạo transition/submission/audit trùng.
- [ ] Request changes/dispute đóng request cũ bằng terminal-per-request + outcome; resubmit tạo đúng một PENDING request mới và one-open constraint luôn đúng.

### Lợi nhuận

- [ ] Pending nghĩa vụ KQKD xuất hiện đúng kỳ và chỉ một lần.
- [ ] Approve/post không làm P&L nhảy lần hai.
- [ ] Close chặn đúng pending KQKD và trả drill-down.
- [ ] Approved-unposted có count/amount informational nhưng vẫn close được.
- [ ] Post sau close không làm stale snapshot.
- [ ] Late recognition/cancellation/correction của kỳ khóa chỉ qua reopen/reclose hoặc append-only adjustment ở kỳ mở; snapshot cũ không đổi âm thầm.
- [ ] `BASE/ADJUSTMENT_ONLY` loại trừ drop/double-count; tổng từng kỳ và toàn timeline khớp trước/sau late recognition, cancellation và correction.

### Sổ quỹ

- [ ] Balance, cash flow, handover và reconciliation chỉ dùng posting lines active.
- [ ] Cash report dùng `posted_on`, không dùng `voucher_date`.
- [ ] Main/change/rounding/reversal parity khớp legacy ở backfill.
- [ ] `abs(MAIN)=gross_amount`, auxiliary lines khớp field nguồn và `net_cash_effect=sum(lines)`.
- [ ] Retry/concurrency không tạo double posting.
- [ ] Legacy cash-impacting UPDATE/DELETE sau backfill chỉ tạo reversal + replacement/tombstone hoặc mandatory exception; posting event/lines cũ không bị mutate/cascade.
- [ ] Legacy delta replacement có evidence inheritance/waiver audit khả thi cho cả Thu và Chi, nhưng không mở đường reuse cross-voucher hoặc waiver sau V2.
- [ ] Ngày post thuộc kỳ sổ mở.

### Phân quyền

- [ ] CUSTODIAN chỉ thấy/thao tác đúng sổ được giao.
- [ ] KNOWER chỉ thấy tên sổ để tạo Thu và own-created Income.
- [ ] KNOWER không thấy balance, Expense, stats, export hoặc attachment khác.
- [ ] Approver không tự có ledger/history/post access.
- [ ] Không binding không thấy tên sổ hoặc row bằng direct API.
- [ ] Không self-grant/cross-org spoof.
- [ ] Access mutation dùng expected revision + idempotency; stale/replay và normal self-role change bị chặn.
- [ ] Cashbook admin RPC trả đúng revision + assignments/eligible safe fields cho actor có share scope; không lộ balance/history/audit hoặc sổ khác.
- [ ] Revoke có hiệu lực ngay và audit đủ.

### Security/data

- [ ] Base money/access tables không có client DML.
- [ ] Policy rộng cũ bị loại; policy inventory khớp allowlist.
- [ ] Attachment private, signed URL theo resource permission.
- [ ] Evidence chỉ attach bằng finalized registry id cùng org; cross-org object reference/overwrite bị chặn.
- [ ] Evidence inherited chỉ cùng voucher posting lineage pre-cutover, giữ immutable snapshot hash; client không tạo link/waiver này.
- [ ] Recognition adjustment chỉ do canonical RPC ghi, có composite tenant FK, idempotency/payload hash, immutable trigger và negative tests cho direct/cross-org/forged write.
- [ ] Lifecycle mutation request/semantic event/backfill control tables là private, append/immutable theo contract và không có client access.
- [ ] Approval request/step/candidate/decision/audit base tables không đọc được qua REST bởi authenticated; inbox chỉ qua scoped RPC.
- [ ] View mới `security_invoker=true` và ACL tối thiểu.
- [ ] LEGACY/SHADOW không còn co-staff/all-building/storage leak và vẫn chạy qua compatibility boundary; V2 chỉ bật sau adapters/bindings.
- [ ] Không unresolved voucher/binding/attachment exception lúc cutover.
- [ ] Initial + delta backfill bắt đủ INSERT/UPDATE/DELETE tới final watermark, zero lag và count/SUM/hash khớp cùng snapshot.
- [ ] Tombstoned voucher bị loại nhất quán khỏi LEGACY/SHADOW/V2 list/stats/export/default detail; reversal/P&L và audit history vẫn đúng.
- [ ] SHADOW chỉ rollback về LEGACY khi zero V2_WRITE semantic event và zero unapplied delta; nếu không phải PAUSED + forward-fix.
- [ ] Generated Supabase types khớp schema.

### Verification

- [ ] `npm run typecheck:baseline` xanh.
- [ ] `npx tsc --noEmit -p tsconfig.app.json` không tăng lỗi.
- [ ] Vitest/DB/RLS/concurrency tests xanh.
- [ ] `node scripts/check-view-invoker.mjs` xanh.
- [ ] `node scripts/reconcile-money.mjs` xanh cho mọi kỳ canary.
- [ ] Headless E2E desktop/mobile xanh, không console/page errors.
- [ ] Independent reviewer không còn finding High/Medium.

## 22. Checklist bàn giao cho agent triển khai tiếp theo

Agent tiếp theo phải bắt đầu bằng:

1. Đọc `AGENTS.md` và file plan này đầy đủ.
2. Fetch/rebase `origin/main`; kiểm tra worktree dirty và active accounting branch.
3. Chụp `git status`, HEAD, migration tail và live catalog snapshot.
4. Không sửa code trước khi hoàn tất inventory `APPROVED` và source classification.
5. Tạo plan execution với dependency rõ; không chạy write agents overlap.
6. Land characterization tests trước schema/cutover.
7. Dùng expand/shadow/contract, không big-bang.
8. Sau mỗi migration view chạy invoker check; sau mọi money change chạy reconcile.
9. Chỉ tuyên bố hoàn tất khi browser/E2E và server negative tests đều đã chạy thật.
10. Commit file cụ thể và push theo quy trình repo.

Prompt ngắn có thể giao cho coordinator:

```text
Triển khai toàn bộ docs/plans/PLAN-THU-CHI-V2-DUYET-CHI-PHAN-QUYEN-SO-QUY.md.
Không dùng APPROVED làm money truth; posting ledger/lines là canonical cash source.
Không dùng POSTED làm KQKD gate; recognized obligation là canonical profit source.
Ưu tiên khóa leak RLS/storage và direct DML, rollout expand -> shadow -> V2 -> contract.
Đọc và bảo toàn mọi thay đổi user đang có, chia agent ownership không overlap,
chạy đầy đủ migration/static/DB/RLS/concurrency/typecheck/reconcile/E2E/review,
chỉ cutover khi mọi gate trong plan xanh.
```

## 23. Trạng thái tài liệu

File này là kế hoạch triển khai tự chứa cho AI/human engineer. Nó không khẳng định Finance V2 đã được code, migration đã apply hoặc production đã cutover. Khi triển khai xong, chuyển các contract bền vững vào tài liệu canonical và cập nhật/đóng plan này thay vì giữ status mơ hồ.
