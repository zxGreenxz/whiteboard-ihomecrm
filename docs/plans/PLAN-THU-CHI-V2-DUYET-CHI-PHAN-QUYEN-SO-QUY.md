# Kế hoạch triển khai Thu Chi V2: Duyệt, Thu/Chi và phân quyền sổ quỹ

> **[LỊCH SỬ — ĐÃ SHIP]** Tài liệu hiện hành: `docs/he-thong/07-hoa-don-thanh-toan.md` + `08-thu-chi-so-quy.md`. Giữ làm bằng chứng, không cập nhật nữa.

| Thuộc tính | Giá trị |
|---|---|
| Baseline đã đối chiếu | `origin/main` tại `d6837dd` ngày `2026-07-22`; đối chiếu thêm live catalog cùng ngày |
| Trạng thái | Finance V2 posting/review/access **chưa triển khai**; Accounting/V5, profit-close, rollout và RBAC foundations đã land/live và là baseline bắt buộc phải bảo toàn |
| Route chính | `/income-expense` |
| Route liên quan | `/approvals`, cài đặt sổ quỹ, báo cáo lợi nhuận và chốt kỳ |
| Artifact nghiệp vụ | `/08-ke-hoach-phat-trien/quy-trinh-chi-phi/` |
| Mục tiêu cutover | Một cơ chế duy nhất: phê duyệt độc lập với ghi sổ, quyền theo từng sổ, fail closed tại server |
| Control plane rollout | Tái sử dụng `app_private.server_feature_flags`; không tạo cơ chế rollout Finance riêng |

Trong tài liệu này, **canonical** nghĩa là **nguồn chuẩn duy nhất/cơ chế chuẩn duy nhất**. Từ tiếng Anh chỉ được giữ trong tên kỹ thuật, enum, RPC hoặc tên cột; phần mô tả nghiệp vụ dùng tiếng Việt.

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
- Giai đoạn đầu, **một voucher thủ công** chỉ Thu/Chi đủ một lần và không chia qua nhiều sổ. Quy tắc này không được làm regression Invoice Collection V5: hóa đơn vẫn có thể thu một phần và multi-tender, nhưng mỗi tender sinh một voucher/posting riêng trên đúng một sổ.

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
- **Mọi Phiếu chi do hệ thống/luồng hợp đồng sinh ra đều phải commit ở Chờ duyệt trước**: chi thanh lý, hoàn cọc, commission/thưởng `STANDALONE`, lương và nghĩa vụ tương tự không được auto-approve hoặc auto-post trong transaction tạo nguồn. Earning `PAYROLL` không tạo phiếu độc lập; salary bundle tiêu thụ earning đó mới là approval subject Chờ duyệt.
- Invariant này áp theo writer class `EXPENSE_OBLIGATION`, không theo label/type client: mọi insert phải explicit `UNAPPROVED` và state theo mode (`CASHBOOK -> UNPOSTED`, `NON_CASH -> NOT_APPLICABLE`), không dựa DB default; birth context cấm `approved_*`, `posting_id`, `payment_id`, payment/posting/cash line hoặc settlement side effect. DB guard + static writer scan phải fail nếu vi phạm.
- Duyệt nghiệp vụ hợp đồng/thanh lý, tạo hợp đồng, chốt lương hoặc hoàn tất job chỉ xác nhận nguồn phát sinh; không đồng nghĩa đã duyệt/đã chi voucher tài chính. Voucher tiếp tục qua Finance approval riêng.
- Với khoản thực chi standalone như hoàn cọc/commission/thưởng, sau khi đã tạo Chờ duyệt mới được dùng action Duyệt hoặc Duyệt và Chi theo contract ngày + sổ + chứng từ. Shortcut “tạo và Chi/Duyệt ngay” trong modal nguồn phải bỏ hoặc tách thành operation kế tiếp sau khi pending đã commit.
- Ngoại lệ không phải nghĩa vụ chờ chi: tender/collection tiền thật đã được người dùng xác nhận qua writer chuyên biệt như Invoice Collection V5 vẫn theo atomic cash contract của chính nó; không dùng ngoại lệ này để auto-pay phiếu chi hệ thống.
- `ACTUAL_CASH_INCOME` chỉ được allowlist qua V5/dedicated receipt writer, đủ ngày/sổ/evidence/source reference và tạo approval+posting atomic; không caller nào được tự gắn label này để bypass birth guard. Dedicated reversal cũng không phải obligation mới.

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
- binding CUSTODIAN tự cấp capability tạo Phiếu thu và Phiếu chi trên đúng sổ đó; không cần thêm share legacy, nhưng vẫn phải là membership active và không tự có quyền duyệt;
- thấy toàn bộ phiếu ảnh hưởng tới sổ;
- thấy số dư và lịch sử sổ;
- được Thu/Chi phiếu đã duyệt;
- không tự có quyền duyệt; quyền duyệt được cấp độc lập.

**Người biết sổ (`KNOWER`)**:

- thấy tên sổ trong form tạo Phiếu thu;
- binding KNOWER tự cấp capability tạo Phiếu thu vào đúng sổ đó, không cấp tạo Phiếu chi;
- trên trang Thu Chi chỉ thấy Phiếu thu do chính mình tạo;
- không thấy số dư toàn sổ, Phiếu chi, phiếu của người khác, thống kê toàn sổ, export hoặc attachment của phiếu khác;
- không được Thu/Chi, duyệt, hủy, đảo hoặc quản trị sổ chỉ nhờ vai trò này.

Quyền được tính riêng trên từng sổ. Nếu user giữ sổ A và chỉ biết sổ B, họ thấy toàn bộ phiếu sổ A nhưng chỉ Phiếu thu do mình tạo ở sổ B.

Binding là positive grant nhưng không bypass khóa an toàn: membership suspended, tenant emergency deny và member/role DENY đang hiệu lực với scope bao phủ organization/building/area/cashbook luôn thắng.

### 2.5. Quản trị vai trò

- Chỉ actor có `cashbooks.share` trên đúng organization và đúng sổ mới được thay đổi Người giữ sổ/Người biết sổ.
- RPC quản trị phải chống self-grant, giả organization, stale revision, replay request cũ và escalation bằng REST trực tiếp.
- Normal share RPC cấm actor thay đổi role của chính mình; self-role change chỉ qua workflow owner/break-glass riêng có reason và audit.
- Thu hồi quyền có hiệu lực với request mới và được kiểm tra lại ngay trước khi RPC ghi tiền.
- `accounts.user_id` nếu còn dùng chỉ là người phụ trách hiển thị; không được dùng làm nguồn authorization duy nhất.
- Owner/admin không tự động bypass quyền giữ sổ khi post. Nếu cần break-glass phải là RPC riêng, lý do bắt buộc và audit đầy đủ.

### 2.6. Ba quyết định kinh doanh còn mở, bắt buộc chốt trước implementation

Code hiện tại không đủ bằng chứng để tự suy diễn ba chính sách dưới đây. Chúng là gate của plan, không được implement theo giả định ngầm:

1. **Owner thanh toán hoa hồng/thưởng Sale**: broker/môi giới được khuyến nghị luôn là `STANDALONE`; Sale nội bộ khuyến nghị là earning `PAYROLL`, Sale ngoài biên chế mới `STANDALONE`. Mỗi source phải có một `settlement_mode` bất biến và chỉ đúng một cash owner/P&L owner; source `PAYROLL` bị consume bởi một kỳ lương và generic posting phải fail.
2. **Mốc phát sinh và clawback commission**: phải chọn một mốc canonical trong ký hợp đồng, ngày hiệu lực/move-in, đã thu cọc hoặc đã thu kỳ đầu; đồng thời chốt khi nào hủy hợp đồng tạo clawback/reversal. Không tiếp tục mặc định `signed_date` chỉ vì code cũ đang dùng field này.
3. **Cấn tiền phòng và trả lương nhiều đợt**: phải chốt cấn tiền phòng là settlement invoice hay chỉ payroll deduction; khi lương khả dụng nhỏ hơn tiền phòng thì cấn tối đa/giữ A/R hay tạo công nợ nhân viên/âm lương; và có tiếp tục cho trả lương nhiều đợt hay one-shot. Khuyến nghị là cấn tối đa phần khả dụng, không tạo cash âm, dư tiền phòng vẫn là A/R và cho nhiều tranche nhưng tổng không vượt `cash_due`.

Cho tới khi chủ dự án xác nhận, schema phải đủ biểu diễn các lựa chọn nhưng rollout/cutover của commission và salary giữ `OFF`; test/acceptance tương ứng chỉ được finalize sau khi private decision record có actor, thời điểm, organization scope, policy version và payload hash. `OFF` sau caller drain nghĩa là source action bị khóa có thông báo, tuyệt đối không fallback về legacy writer.

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

- Thu/Chi một phần cho một voucher thủ công.
- Chia một voucher thủ công qua nhiều sổ; Invoice Collection V5 multi-tender vẫn tách một voucher/posting cho mỗi tender.
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
| Desktop/mobile Duyệt đang quick-update rồi approve bằng hai request. | `src/pages/payments/IncomeExpensePage.tsx:298`, `IncomeExpenseMobilePage.tsx:255` | Không atomic; có thể duyệt dở dang nếu request thứ hai lỗi. |
| Form hiện dùng `voucher_date` như “Ngày thực chi/thu”; attachment không bắt buộc. | `src/components/income-expenses/IncomeExpenseForm.tsx` | Chưa có `posted_on` và proof contract độc lập. |
| `create_income_expense_v1` và các fallback có thể tự tạo `APPROVED`. | `src/hooks/income-expenses/mutations.ts:46`, `scripts/authz-prepared/t5_24_ie_birth_status_policy.sql` | Writer mới/cũ không thống nhất birth state. |
| Batch, recurring và approval inbox có đường ghi riêng. | `src/hooks/income-expenses/batch.ts`, `recurring.ts`, `src/hooks/useApprovals.ts` | Sửa form lẻ không đủ; các đường phụ sẽ bypass. |
| Commission RPC hiện sinh UNAPPROVED nhưng UI vẫn gọi “Nháp” và có shortcut tạo xong gọi approve ngay/“Chi & duyệt”. | `src/hooks/useCommissionVoucher.ts:175`, `src/components/contracts/CommissionVoucherModal.tsx:57`, `src/components/thu-tien/PeriodCommissionModal.tsx:65` | Phải đổi thành Chờ duyệt và tách source create khỏi Finance approve/post; không dùng approve legacy như cash event. |
| Effective move-out hiện tạo payment CT ngay, sinh `termination.offset/revenue` thẳng APPROVED; chỉ refund là UNAPPROVED và extra receipt có thể APPROVED. | `supabase/migrations/20260709100000_settlement_invoice_kind.sql:330`, `:359`, `:378`, `:403`; `20260721135500_termination_non_cash_payment_semantics.sql:837` | Thanh lý nguồn đang vừa thay domain vừa settle Finance; phải stage funded non-cash pair + refund pending và tách actual-cash receipt. |
| Salary lock hiện duyệt commission; salary payout có rent-offset tạo receipt/payment APPROVED ngay trong transaction birth pending expense. | `src/hooks/useManagerSalary.ts:699`, `scripts/authz-prepared/prod-snapshot/PS05_misc_remaining.sql:11013`, `:11883`, `:11927` | Lock/job không được cấp Finance approval; rent offset phải stage, paid chỉ đổi theo posting. |
| Hoàn tiền hóa đơn hiện insert voucher rồi item bằng hai request, không source key/cap/idempotency; form lại hỏi ngày hoàn/sổ ngay từ source. | `src/hooks/useInvoicePayments.ts:149`, `:171`; `src/components/invoices/RecordRefundDialog.tsx:168`, `:213` | Cần refund-obligation RPC atomic, lock/cap outstanding và birth pending; account/posted_on/evidence chỉ ở Finance posting. |
| Lương điều hành canonical đã pending nhưng source dialog vẫn bắt sổ/ngày; bulk lương staff chạy nhiều mutation rời và có thể partial mà không có batch result. | `src/components/shareholders/ManagerSalaryPayoutDialog.tsx:52`, `:73`; `src/pages/finance/ManagerSalaryPage.tsx:162` | Mọi salary source chỉ tạo nghĩa vụ; batch có id/result per-row retry-safe, manager salary stamp source canonical và không nhận posting fields. |
| `accounts_with_balance` cộng phiếu `APPROVED` và migration lịch sử từng `GRANT ALL` cho anon/authenticated. | `supabase/migrations/20260704100000_accounts_is_virtual.sql:51`, `:63` | View số dư phải chuyển sang posting state/date và ACL tối thiểu. |
| P&L accrual vẫn chỉ lấy phiếu `APPROVED`. | `supabase/migrations/20260721080000_accounting_semantics_snapshot.sql:334` | Phiếu Chờ duyệt KQKD chưa vào lợi nhuận. |
| Profit close dùng `fa_monthly_pnl_accrual`. | `supabase/migrations/20260720215000_profit_close_v2_ignore_inactive_managers.sql:246` | Sửa nguồn accrual phải đồng bộ preview/lock/source hash. |
| Shared user hiện được xem toàn bộ phiếu sổ và insert. | `supabase/migrations/20260703161000_ie_select_policies_setbased.sql:61`, `20260703170000_write_policies_setbased.sql:164` | Không đáp ứng KNOWER. |
| `income_expenses.user_id` là owner/attribution nghiệp vụ, không phải người tạo; V5 có thể ghi owner vào đây. | `20260713162000_sprint5b3_v3_voucher_owner.sql:36`, `20260721100000_invoice_collection_v5.sql:1259` | KNOWER own-created và maker-withdraw cần maker user/membership server-owned riêng; không reuse `user_id`. |
| Policy theo tòa có thể OR với policy theo sổ. | `supabase/migrations/20260702150000_rls_initplan_setbased_select.sql:180` | Thêm policy hẹp mới không tự thu hẹp policy rộng cũ. |
| `account_shared_users` chỉ có quan hệ chia sẻ chung, không có access kind. | `supabase/migrations/20260516000004_account_shared_users.sql:16` | Phải drain sang nguồn quyền hiện hữu, không tạo nguồn canonical thứ ba. |
| Schema/live đã có `cashbook_possession_bindings` với `CUSTODIAN/OPERATOR`, interval/version và composite tenant FK. | `scripts/authz-prepared/prod-snapshot/PS04_rbac_org_meter_threshold.sql:192`, `:364`, `:567` | Mở rộng bảng này thêm KNOWER; không tạo `cashbook_access_bindings` authoritative song song. |
| Approval engine đã có request/decision và metadata `posting_id`. | `supabase/migrations/20260713130000_sprint4a_approval_engine_schema.sql:73`, `:174` | Không tạo engine thứ ba; phải sửa semantics POSTED hiện tại. |
| `income_expenses.posting_id/posted_at_v2` hiện chỉ là compatibility stamp do engine ghi. | `supabase/migrations/20260721120000_profit_payout_reservations_v2.sql:1293` | Không được tái sử dụng stamp này như posting event hoặc `posted_on` canonical. |
| `update_income_expense_quick` có thể đổi `account_id` của row đã APPROVED. | `supabase/migrations/20260527000005_income_expense_quick_edit.sql:26` | Đang có thể chuyển số dư giữa sổ mà không có posting/reversal. |
| Direct DML/fallback vẫn sống; script drain chỉ là prepared/comment. | `scripts/authz-prepared/T7_PREPARED_drain_legacy_dml.sql`, hooks mutations/batch/status/specialized | Cutover phải chuyển caller rồi revoke table DML. |
| Bucket chứng từ private nhưng SELECT còn bucket-wide cho authenticated. | `supabase/migrations/20260601000200_sec_private_buckets.sql:45`, `PS03_storage_shield.sql:449` | User biết object path có thể đọc proof tenant khác. |
| Org rollout có fallback sentinel cho finance rows mơ hồ. | `20260713120000_sprint3a_org_rollout_all_tables.sql` | Không được COALESCE dữ liệu tiền mơ hồ về PROD; phải exception + assert. |
| `cashbook_possession_bindings` có trong generated types nhưng source chính nằm ở prod snapshot. | `src/integrations/supabase/types.ts:2405`, `PS04_rbac_org_meter_threshold.sql:192` | Trước migration phải snapshot live catalog và giải quyết schema-source drift. |
| Accounting rollout chuẩn đã có flag/CAS/canary caps/freeze. | `PS05_misc_remaining.sql:171`, `:474`, `:586`, `20260721075000_accounting_canary_caps.sql` | Finance V2 phải tái sử dụng control plane này, không tạo config org riêng. |
| Invoice collection V5 đã là writer canonical, hỗ trợ partial invoice collection và multi-tender. | `20260721100000_invoice_collection_v5.sql:40`, `:84`, `:118`, `:1251` | Finance V2 phải adapter vào cùng transaction/idempotency và không double-count collection/payment/voucher mirror. |
| Contract create receipt đang birth `APPROVED`; `deposit_paid` lại chỉ SUM deposit voucher APPROVED trước khi chạy shortfall/debt checks. | `20260721090000_contract_create_v2.sql:195`, `:814`, `:843`, `:850` | Không được chỉ flip receipt pending. Phải có receipt-intent/actual-cash adapter và chuyển `deposit_paid` sang active posting truth trong cùng release. |
| Accounting classification đã có `PNL/DEPOSIT/CUSTOMER_CREDIT/INTERNAL` và `kqkd_amount`. | `20260721080000_accounting_semantics_snapshot.sql:78`, `:149`; `src/hooks/income-expenses/types.ts:142` | Không tạo classification truth thứ hai hoặc lấy `total_amount` thay cho phần P&L. |
| `canonical_write_operations` và `income_expense_flow_ownership` đã tồn tại. | `PS02_payment_invoice_writers.sql:83`, `PS04_rbac_org_meter_threshold.sql:224` | Lifecycle V2 phải mở rộng/tái sử dụng, không dual-reserve idempotency hoặc bỏ qua flow owner. |
| Migration `20260722140000` đã sửa UPDATE assignment theo revoke + regrant role binding. | `supabase/migrations/20260722140000_rbac_regrant_on_assignment_edit.sql:32` | Quyền Finance phải resolve qua auth graph canonical; vẫn cần preflight INSERT/backfill/override parity. |
| Repo đã vá false-positive no-op của guard bỏ cọc, nhưng điều kiện hiện vẫn là `v_status_only AND approval_status changed`; update status kèm `posting_id/posted_at_v2` có thể không vào nhánh token. | `supabase/migrations/20260722150000_fix_forfeit_guard_false_positive.sql:96`, `20260721120000_profit_payout_reservations_v2.sql:1210` | Finance V2 phải forward-fix thành mọi status change đều cần pair-transition context; no-op status-unchanged vẫn qua, generic combined update/per-leg transition phải fail. |
| Wrapper bỏ cọc mới cho thanh lý tiếp tục khi `customer.credit.apply.v1` chưa CANONICAL và chỉ trả `credit.deferred=true`. | `supabase/migrations/20260722160000_forfeit_defer_credit_when_writer_off.sql:76` | Không được biến deferred credit thành khoản đã xử lý; cần queue có owner/reconcile và adapter hoàn/cấn trừ riêng, không auto-approve/post voucher. |
| Frontend thanh lý hiện bỏ qua payload deferred, còn test migration chỉ đọc definition cũ và accounting-chain test có thể ghi đè live wrapper bằng bundle 14-file. | `src/hooks/useContractOperations.ts:204`, `src/lib/__tests__/customerCreditMigration.test.ts:8`, `scripts/test-accounting-chain.mjs:2570` | Phải cảnh báo/đưa deferred vào queue; test effective post-bundle definition và không cho test script downgrade catalog đã hotfix. |
| System source đang drift: deposit ghi `contract.create.v2` nhưng catalog có `contract.deposit`; salary canonical thiếu source, compatibility dùng `profit.manager_salary`; invoice refund/rent-offset chưa có source riêng. | `20260721090000_contract_create_v2.sql:821`, `src/lib/voucherSources.ts:30`, `PS05_misc_remaining.sql:11248`, `20260721150500_accounting_scope_narrowing.sql:836` | Chốt mapping/backfill alias một lần; source lạ/thiếu source phải fail closed, không phân loại bằng notes hoặc payer name. |
| Salary lock/payout fallback trên mọi lỗi `42501`, nên auth denial thật có thể rơi về raw DML/default APPROVED. | `src/lib/canonicalFallback.ts:18`, `src/hooks/useManagerSalary.ts:694`, `:860`, `:909` | Chỉ fallback bằng typed coexistence signal; `42501` quyền thật phải fail. Gate SHADOW yêu cầu raw salary fallback count bằng 0. |
| Có nhiều consumer SQL/TS dùng `APPROVED` như proxy tiền thật. | `rg -n "approval_status.*APPROVED" src supabase scripts` | Bắt buộc inventory và phân loại từng consumer trước cutover. |

### 4.1. Snapshot live database ngày 2026-07-22

Đây là snapshot kiểm toán, không phải số liệu cố định để hard-code. Mọi lần apply phải chụp lại cùng query/hash:

- Chưa có `income_expense_postings`, `income_expense_posting_lines`, `finance_evidence_objects`, `income_expense_recognition_adjustments` hoặc access/CAS tables Finance V2.
- Default live của `income_expenses.approval_status` vẫn là `APPROVED`; approval request state chưa có `APPROVED/WITHDRAWN/CHANGES_REQUESTED/DISPUTED`. Chỉ đổi default/state writer sau expand compatibility và adapter drain.
- `invoice.collection.v5` và `invoice.collection.reverse.v5` đang `ON`; `customer.credit.apply.v1` và `shareholder_profit.distribute.v2` vẫn ở `SHADOW` tại thời điểm audit.
- Live có 32 binding mở `CUSTODIAN`, 0 `OPERATOR`, còn 15 row `account_shared_users`. Vì target nghiệp vụ chỉ có CUSTODIAN/KNOWER, `OPERATOR` được xem là compatibility kind cần disposition; tuyệt đối không auto-map. Nếu preflight sau này xuất hiện OPERATOR, cutover dừng để business owner quyết định từng binding.
- Org thật có 15 pending KQKD tổng `132.221.200`; DEMO có 7 pending tổng `612.000`. Một phần pending org thật thuộc các kỳ đã khóa 05–07/2026 và bắt buộc disposition có phê duyệt trước khi bật profit-recognition/close canonical.
- `schema_migrations` live dừng ở `20260716170000` dù catalog đã chứa object 20260721–22 được apply out-of-band. Không được dùng migration ledger hoặc tên file làm bằng chứng object đã/chưa tồn tại.
- Accounting 14-file static manifest đã validate với SHA-256 `801ca033e12fcd767260b00f64c784ef01783125625cca1a814de8beb993c4b5`; Finance V2 phải pin dependency hash này hoặc catalog fingerprint tương đương, không sửa bundle tại chỗ.
- Post-bundle repo có `20260722150000_fix_forfeit_guard_false_positive.sql` SHA-256 `ff7e714b583a6d99f34b4168ef59ffc2ae449c897cbba09f80a9cc1135c400f9` và `20260722160000_forfeit_defer_credit_when_writer_off.sql` SHA-256 `39a9e14238870e144561ac89f6bd1387eaace225704b62731d4325f15e621cc4`; commit/ledger không chứng minh live function đã đúng. Audit read-only ngày `2026-07-22` thấy effective normalized hashes lần lượt là guard `5ce13c5a367bb5e956a1c38fc5339e94d9e099e7dca80e7d78c2fae4d026342c` và wrapper `158b183cf6849be940defb344757723875b263abae6e5065359dd0559dadcda0`, trigger đang enabled. Preflight mỗi môi trường vẫn phải tự hash `pg_get_functiondef`, kiểm trigger và đưa kết quả vào post-bundle catalog fingerprint/attestation.
- Live đã có wrapper `20260722160000` dù migration ledger chưa có cả `20260722150000/160000`; `customer.credit.apply.v1` vẫn SHADOW ở DEMO và org thật. `deferred=true` hiện được giữ trong response của `canonical_write_operations`, chưa phải một operational queue có owner/SLA. Trước Finance activation phải inventory toàn bộ response deferred + credit lots còn dư, tạo remediation queue bền vững và chứng minh không khoản nào bị coi là hoàn/cấn trừ/đã chi chỉ vì thanh lý đã hoàn tất.
- Deferred result đã được cache như completed canonical operation: retry cùng idempotency key sau khi route chuyển CANONICAL vẫn trả payload deferred, trong khi key mới không thể chạy lại termination đã hoàn tất. Queue resolver bắt buộc là operation/idempotency namespace riêng; nó phải lock open credit lots và apply/cấn trừ/hoàn đúng một lần, không gọi lại termination wrapper.
- Scope hotfix bất đối xứng: chỉ `terminate_contract_forfeit_with_credit_v1` defer implicit full-balance forfeit; `terminate_contract_move_out_with_credit_v1` vẫn fail closed khi cần apply excess credit mà route chưa CANONICAL. Tài liệu/UI/test không được mô tả thành “mọi thanh lý đều defer credit”.
- Wrapper là `SECURITY DEFINER`; live ACL hiện chỉ owner/authenticated và search path đã khóa, nhưng `CREATE OR REPLACE` chỉ giữ ACL nếu prerequisite function tồn tại. Finance manifest phải assert signature/owner/ACL/`prosecdef`/`proconfig` trước apply và replacement migration phải explicit `REVOKE ALL FROM PUBLIC, anon` + `GRANT EXECUTE` đúng role để catalog drift không mở EXECUTE mặc định.
- Authenticated vẫn còn direct DML trên các bảng tiền/access và permissive policies OR-merge; approval base tables còn đọc được ở baseline. Containment + caller drain là stop-gate trước SHADOW, không phải cleanup tùy chọn.
- Audit profit activation còn 52 lock không an toàn, gồm 42 stale và 10 hash drift. Workflow/posting/access có thể triển khai độc lập, nhưng profit close/recognition không được bật cho org thật trước khi xử lý gate này.
- RBAC live còn ít nhất một assignment hợp lệ thiếu open binding và một open binding lệch role/org. Đây là exception bắt buộc xử lý; migration regrant mới không được coi là bằng chứng toàn bộ lịch sử đã sạch.

### 4.2. Kết luận đối chiếu

Các mục tiêu nghiệp vụ trong §2 vẫn giữ nguyên. Phần phải đổi là cách triển khai: tái sử dụng nền Accounting/V5/RBAC hiện có, version hóa compatibility, và thêm stop-gate cho dữ liệu live; không dựng thêm control plane, access truth, idempotency truth hoặc classification truth song song.

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
| `UNAPPROVED/PENDING` | `NON_CASH` | `NOT_APPLICABLE` | Chờ duyệt - Không qua sổ | Có nếu contribution PNL của kỳ còn pending. |
| `UNAPPROVED/CHANGES_REQUESTED` | `NON_CASH` | `NOT_APPLICABLE` | Cần bổ sung - Không qua sổ | Có nếu contribution PNL của kỳ còn pending. |
| `UNAPPROVED/DISPUTED` | `NON_CASH` | `NOT_APPLICABLE` | Đang tranh chấp - Không qua sổ | Có nếu contribution PNL của kỳ còn pending. |
| `APPROVED` | `CASHBOOK` | `UNPOSTED` | Đã Duyệt - Chưa Thu/Chi | Không. |
| `APPROVED` | `CASHBOOK` | `POSTED` | Đã Thu/Chi | Không. |
| `APPROVED` | `CASHBOOK` | `REVERSED` | Đã hoàn tác | Không; điều chỉnh KQKD xử lý riêng. |
| `APPROVED` | `NON_CASH` | `NOT_APPLICABLE` | Đã ghi nhận, không qua sổ quỹ | Không. |
| `CANCELLED` | `CASHBOOK` | `UNPOSTED` | Đã hủy trước khi ghi sổ | Không còn là blocker ở kỳ mở; base đã khóa của kỳ cũ vẫn giữ trong snapshot và chỉ được bù bằng adjustment/reopen. |
| `CANCELLED` | `NON_CASH` | `NOT_APPLICABLE` | Đã hủy - Không qua sổ | Không còn blocker ở kỳ mở; kỳ đã khóa xử lý adjustment/reopen. |

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
| Từ chối vì không phát sinh/trùng/sai doanh nghiệp | `CANCELLED + (CASHBOOK: UNPOSTED / NON_CASH: NOT_APPLICABLE)` | Loại recognition nếu kỳ mở; nếu kỳ đã khóa phải adjustment/reopen, không sửa snapshot âm thầm. |
| Từ chối thanh toán nhưng nghĩa vụ còn thật | `UNAPPROVED + review_state=DISPUTED` | Vẫn trong P&L và block close; vào hàng đợi tranh chấp có owner/reason/deadline. |
| Giải quyết tranh chấp: chấp nhận | submission mới → `APPROVED` hoặc pending approval | Không double count recognition. |
| Giải quyết tranh chấp: hủy có bằng chứng | `CANCELLED + state theo posting mode` | Loại/điều chỉnh recognition theo kỳ. |

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
- `income_expense_postings.created_at`: timestamp audit canonical khi server ghi event; không thay cho `posted_on`. `income_expenses.posted_at_v2` hiện hữu chỉ là compatibility stamp.

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
maker_user_id      uuid null
maker_membership_id uuid null
birth_operation_id uuid null
birth_txid         xid8 null
```

Các cột mới để nullable/default inert trong expand phase; chỉ `NOT NULL` sau khi backfill, shadow reconcile và validate constraint.

Giữ các cột đã có như compatibility/provenance, không nâng chúng thành ledger truth:

- `posting_id` và `posted_at_v2` hiện có là stamp do approval engine/accounting compatibility ghi; bảo toàn để audit/backfill nhưng không FK vào posting event, không tính balance và không dùng làm `posted_on`.
- `active_posting_id_v2` là pointer server-owned tới POSTING chưa bị reverse hiện tại; null khi UNPOSTED/REVERSED/NOT_APPLICABLE.
- Timestamp audit canonical nằm ở `income_expense_postings.created_at`; ngày tiền thật là `posted_on`.
- `reversed_by_posting_id` hiện hữu chỉ là compatibility stamp; canonical history nằm trong event chain.
- `approval_request_id`, `correlation_id` tiếp tục phục vụ engine/audit; header `idempotency_key/source_payload_hash` chỉ là legacy provenance/mirror, không thay canonical lifecycle request registry.
- `maker_user_id/maker_membership_id` là actor thực sự tạo voucher, server-owned và có composite tenant FK. Không reuse `income_expenses.user_id`: baseline dùng cột đó cho owner/attribution nghiệp vụ, không phải maker.
- `birth_operation_id/birth_txid` nối exact create operation và PostgreSQL transaction đã khai sinh obligation. Client không ghi được; actual-cash allowlist/backfill có provenance kind riêng.

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
- Không thêm marker xóa trùng vào `income_expenses`: cột `income_expenses.deleted_at` hiện hữu là tombstone duy nhất cho compatibility delete guard. Source hash/version của tombstone phải nằm trong private backfill change-log/semantic audit, immutable ngoài guard, không nhận từ client và không đồng nghĩa được phép hard-delete row.
- Trong expand/legacy, `review_state` nullable để không sinh `APPROVED + PENDING` giả; chỉ set NOT NULL/default sau adapters/backfill.
- Với obligation mới, approve/post/cancel transition yêu cầu create operation đã `completed_at`, subject/source hash khớp và `birth_txid IS DISTINCT FROM pg_current_xact_id()`. Vì row chỉ nhìn thấy từ transaction khác sau commit, điều này chứng minh Chờ duyệt đã tồn tại qua một commit boundary; create→approve/post nested trong cùng RPC/transaction phải fail.

Mở rộng `app_private.canonical_write_operations` thành idempotency authority duy nhất cho create/approve/request-changes/reject/dispute/withdraw/resubmit/resolve/cancel. Không tạo `income_expense_mutation_requests` chạy song song:

```text
canonical_write_operations (mở rộng additive)
  organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  subject_id, actor_membership_id, transaction_id
  expected_review_version, expected_approval_version, expected_posting_version
  resulting_review_version, resulting_approval_version, resulting_posting_version
  outcome_kind, response_payload, created_at, completed_at
```

Yêu cầu:

- primary key hiện hữu `(organization_id, operation, subject_scope, actor_id, idempotency_key)` tiếp tục là authority; cùng tuple khác payload phải fail conflict. Cross-actor concurrency không dựa vào idempotency key mà dựa subject lock, expected version và unique posting/transition constraints;
- RPC reserve/lock operation row trước khi đổi state. Retry cùng payload trả lại `response_payload` kể cả voucher đã sang state mới;
- create có thể bắt đầu với `subject_id=null`, nhưng result phải lưu voucher id đã tạo;
- lifecycle transition và audit chỉ được append một lần; failed transaction không để request row completed giả;
- composite tenant FK, actor server-owned, revoke client DML/SELECT và retention đủ dài hơn cửa sổ retry/job replay;
- không dùng một `income_expenses.idempotency_key` mutable để thay registry này;
- `app_private.income_expense_flow_ownership` tiếp tục xác định lifecycle owner của system/V5 flow. Manual V2 RPC phải fail nếu subject thuộc writer owner khác, trừ adapter được đăng ký rõ;
- cấm dual-reserve/dual-result giữa `canonical_write_operations` và bất kỳ registry mới nào. Nếu cần schema thay thế trong tương lai phải có one-time migration và cutover toàn bộ caller trong cùng release train.

### 6.2. Posting event canonical

Tạo `income_expense_postings` làm nguồn tiền thật duy nhất:

```sql
id                       uuid primary key
organization_id          uuid not null
voucher_id               uuid null
posting_subject_kind     text not null default 'VOUCHER' check (posting_subject_kind in ('VOUCHER','SALARY_TRANCHE'))
posting_subject_id       uuid not null
direction                text not null check (direction in ('INCOME','EXPENSE'))
account_id               uuid not null
gross_amount             numeric(18,2) not null check (gross_amount > 0)
voucher_amount_snapshot  numeric(18,2) not null check (voucher_amount_snapshot >= 0)
amount_basis             text not null check (amount_basis in ('VOUCHER_TOTAL','EXTERNAL_TENDER_GROSS','SALARY_TRANCHE_CASH'))
net_cash_effect          numeric(18,2) not null
posted_on                date not null
posted_by_membership_id  uuid not null
posted_by_user_id        uuid not null
approval_request_id      uuid null
approval_version         bigint not null
event_kind               text not null check (event_kind in ('POSTING','REVERSAL'))
idempotency_key          text not null
source_kind              text not null
external_source_kind     text null
external_source_id       uuid null
external_source_line_id  uuid null
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

- manual Phiếu thu/chi dùng `amount_basis='VOUCHER_TOTAL'`: MAIN là `+/- voucher_amount_snapshot` và snapshot bằng `income_expenses.total_amount`;
- Invoice Collection V5 dùng `amount_basis='EXTERNAL_TENDER_GROSS'`: MAIN là `+tender.gross_amount` trên sổ nhận tiền, kể cả voucher retained amount bằng `0`;
- MULTI_TRANCHE salary dùng `amount_basis='SALARY_TRANCHE_CASH'`: MAIN là `-salary_settlement_tranches.amount`, `voucher_amount_snapshot=0`, parent salary voucher không đóng góp cash;
- CHANGE/ROUNDING: giữ đúng dấu/công thức legacy sau khi characterization xác nhận;
- REVERSAL: dòng đối dấu liên kết posting gốc.

Constraint bắt buộc:

- composite FK giữ voucher, account và membership trong cùng organization;
- `posting_subject_kind='VOUCHER'` bắt buộc `voucher_id=posting_subject_id`; `SALARY_TRANCHE` bắt buộc `posting_subject_id` trỏ `salary_settlement_tranches` cùng organization/bundle, parent salary voucher chỉ là lineage và không tự làm cash effect. Tranche dùng `amount_basis='SALARY_TRANCHE_CASH'`, voucher snapshot `0`, gross bằng tranche amount;
- unique `(organization_id, idempotency_key)`;
- partial unique `(organization_id, external_source_kind, external_source_id, external_source_line_id, event_kind)` khi có external source; với V5 dùng `('COLLECTION_V5', collection_id, tender_id)` để một tender chỉ có một cash lineage;
- unique `(organization_id, posting_subject_kind, posting_subject_id, posting_generation)` cho POSTING; generation tăng đơn điệu theo chính subject, không dựa nullable `voucher_id`;
- `active_posting_id_v2` chỉ dùng cho subject `VOUCHER`; `salary_settlement_tranches.active_posting_id`/state dùng cho `SALARY_TRANCHE`. Subject lock + constraint trigger bảo đảm mỗi subject tối đa một POSTING chưa bị reverse;
- `replaces_posting_id` chỉ được tham chiếu generation trước cùng subject và predecessor phải được reverse trong cùng transaction replacement;
- mỗi POSTING có tối đa một REVERSAL theo `(organization_id, posting_subject_kind, posting_subject_id, posting_generation)`; reversal phải cùng subject/tranche và không nối chéo parent/child;
- manual voucher phase đầu có `gross_amount = voucher_amount_snapshot = income_expenses.total_amount > 0`;
- V5 có `gross_amount = tender.gross_amount > 0`, còn `voucher_amount_snapshot = tender.retained_amount = income_expenses.total_amount` và được phép bằng `0`. Tender change-only vẫn tạo MAIN `+gross` cùng CHANGE `-gross`, nên `net_cash_effect=0` nhưng movement từng sổ và lineage không bị mất;
- mọi POSTING có đúng một MAIN line trị tuyệt đối bằng `gross_amount` và dấu theo direction/source contract; không bỏ MAIN chỉ vì V5 retained amount bằng zero;
- CHANGE/ROUNDING lines khớp chính xác field legacy đã characterization;
- `net_cash_effect = SUM(signed lines)`; không ép tổng lines bằng gross amount;
- mọi posting Thu/Chi thủ công yêu cầu ít nhất một evidence relation đã finalize;
- signed lines không có account chéo organization;
- event rows immutable; reversal là event/audit bù trừ, không UPDATE/DELETE posting gốc;
- phase 1 vẫn chỉ có một posting active/full amount trên từng voucher. Generation > 1 chỉ dùng cho legacy shadow delta correction hoặc workflow reversal + replacement được cấp quyền rõ, không phải partial payment của voucher; V5 partial invoice/multi-tender được biểu diễn bằng nhiều tender voucher độc lập;
- MULTI_TRANCHE salary là ngoại lệ có chủ đích, không mở partial cho manual voucher: mỗi tranche có `active_posting_id`, đúng một posting/reversal immutable qua `posting_subject_kind='SALARY_TRANCHE'`; lock bundle + tranche table giữ cumulative active amount `<= cash_due`, còn parent P&L voucher không được tính vào balance. ONE_SHOT không tạo tranche subject;
- V5 backfill/adapter lấy tender gross/retained/change/rounding từ immutable collection-tender lineage, không suy `gross_amount` từ voucher total. Thiếu tender lineage hoặc tổng line không khớp source phải vào exception và chặn posting activation;
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
  provenance_kind = UPLOAD | SYSTEM_REFERENCE
  state = UPLOAD_INTENT | FINALIZED | ATTACHED | QUARANTINED
  upload_token_hash, created_at, finalized_at

finance_evidence_system_sources
  evidence_id, organization_id
  source_kind = INVOICE_COLLECTION_V5 | CONTRACT_V2 | UTILITY | OTHER_ALLOWLISTED
  collection_id, tender_id, payment_id hoặc typed source FK tương ứng
  source_snapshot_hash, created_at

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

System writer đã có chứng từ nguồn không bắt người dùng upload lại. Adapter server-side đăng ký `SYSTEM_REFERENCE` tới source immutable, ví dụ `(invoice_payment_collections.id, invoice_payment_tenders.id, payments.id)`, lưu snapshot hash/object identity và finalize trong cùng transaction. Với trusted system writer, chính source record/hash là evidence tối thiểu kể cả khi ảnh receipt không có; manual Thu/Chi vẫn bắt buộc ảnh theo §2.2. Link source phải dùng typed/composite tenant FK và check theo `source_kind`, không dùng polymorphic UUID không kiểm chứng. `receipt_image_url` hiện hữu chỉ là dữ liệu compatibility để resolver nguồn; raw URL không được copy thành posting input hoặc trở thành authorization key.

Constraint theo provenance: `UPLOAD` yêu cầu upload intent/uploader/bucket/object/hash hợp lệ; `SYSTEM_REFERENCE` yêu cầu đúng một typed source row và immutable source snapshot. Không cho một row giả cả hai loại hoặc không có loại nào.

Phase đầu một evidence chỉ có một attach `ORIGINAL`: partial unique `evidence_id WHERE relation_kind='ORIGINAL'`. Posting RPC lock evidence rows `FOR UPDATE`, kiểm `FINALIZED`, attach và chuyển `ATTACHED` trong cùng transaction để chặn reuse đồng thời.

Với V5 multi-tender, adapter materialize một `SYSTEM_REFERENCE` evidence deterministic cho **mỗi tender** bằng unique `(organization_id, source_kind, collection_id, tender_id)`, dù nhiều tender cùng snapshot một receipt collection. Không dùng chung một evidence id cho nhiều posting và không bắt upload lại.

Riêng replacement generation do legacy delta trước CANONICAL cutover:

- client không gửi lại evidence id. Delta worker server-side tạo link `INHERITED_LEGACY_DELTA` tham chiếu link generation trước, cùng organization/voucher/posting lineage và copy immutable sha256/object snapshot;
- inherited link không chuyển ownership/state object, không cho dùng ở voucher khác và không thỏa evidence cho một posting thủ công mới;
- nếu generation trước chỉ có waiver `PRE_V2_HISTORY`, replacement được dùng waiver `PRE_V2_LEGACY_DELTA` kèm source change-log id, old/new source hash và reason; chỉ hợp lệ khi org chưa V2 và source voucher tồn tại trước cutover;
- replacement có chứng từ legacy mới thì registry/finalize như bình thường và dùng ORIGINAL mới; không được nhận raw URL;
- sau CANONICAL cutover không cho inheritance/waiver này. Mọi reversal/replacement nghiệp vụ mới phải theo evidence policy production tương ứng.

Mọi posting Thu/Chi thủ công yêu cầu ít nhất một evidence `FINALIZED`. System writer tiền thật phải tạo/finalize registry record từ receipt hoặc source reference hệ thống; waiver chỉ dành cho `PRE_V2_HISTORY/PRE_V2_LEGACY_DELTA` theo guard trên, không dùng cho giao dịch mới.

### 6.4. Quyền sổ canonical

Mở rộng `cashbook_possession_bindings` hiện hữu; không tạo bảng binding authoritative thứ hai. `account_shared_users` chỉ là nguồn legacy cần phân loại/drain:

```sql
-- bảng hiện hữu, chỉ expand domain/metadata nếu thiếu
cashbook_possession_bindings
  id, organization_id, cashbook_id, membership_id
  possession_kind check in ('CUSTODIAN','OPERATOR','KNOWER')
  valid_from, valid_to, version, granted_by, reason, created_at
```

Target nghiệp vụ user-facing chỉ có `CUSTODIAN` và `KNOWER`. `OPERATOR` là compatibility kind nội bộ của authorization baseline: không auto-map sang CUSTODIAN/KNOWER, không cấp cho user mới và không thêm vào UI. Live audit hiện có 0 binding mở OPERATOR; nếu preflight phát hiện row mới, cutover phải dừng để owner disposition từng row.

Thêm state/request tables để CAS và idempotency thực thi được:

```text
app_private.cashbook_access_states
  organization_id, cashbook_id, revision, updated_by, updated_at

app_private.cashbook_access_mutation_requests
  organization_id, idempotency_key, payload_hash
  expected_revision, resulting_revision, actor_membership_id
  result_snapshot, created_at
```

Yêu cầu:

- unique một binding mở cho `(organization_id, cashbook_id, membership_id, possession_kind)`;
- FK kép theo organization để không ghép membership/sổ chéo tenant;
- append/close binding, không update xóa lịch sử;
- RLS chỉ cho đọc phạm vi cần thiết; client không DML trực tiếp;
- mutation chỉ qua RPC có `cashbooks.share` exact scope, `expectedRevision` và idempotency key;
- normal RPC không cho actor thay đổi role của chính mình. Self-role change chỉ qua break-glass/owner workflow riêng, reason bắt buộc và audit;
- mở rộng `cashbook_possession_bindings_possession_kind_check`, candidate constraints và permission vocabulary để nhận KNOWER;
- `app_private.assert_cashbook_access_v2` là resolver duy nhất cho các action phát sinh trực tiếp từ possession. Resolver phải kiểm membership/organization/target còn active và cùng tenant, sau đó áp `EMERGENCY_DENY`, active member DENY và active role DENY từ auth graph canonical. DENY scope bao phủ target theo `ORGANIZATION/BUILDING/AREA/CASHBOOK`, không chỉ exact cashbook; mọi deny áp dụng đều thắng binding;
- sau các deny bắt buộc, binding mở là **positive grant**: CUSTODIAN được create Thu/Chi, read-all-cashbook và post; KNOWER chỉ create Thu/read-own-income. Các action possession-derived này không cần một role `ALLOW` không liên quan làm điều kiện grant thứ hai. Positive grant loại yêu cầu role ALLOW, không loại deny precedence; nếu cần chặn riêng một thành viên đã có binding, dùng member DENY canonical có scope/audit;
- KNOWER không được generic money/post/balance/export permission. Approve, share, close, reverse đặc quyền và các capability không phát sinh từ possession vẫn phải qua RBAC `ALLOW` độc lập với exact scope; possession không tự cấp các quyền đó;
- resolver và mutation binding phải bump/kiểm `organizations.authorization_version`; `staff_assignments` và `account_shared_users` chỉ là nguồn migration/compatibility, không là authority runtime;
- nếu cần tên `cashbook_access_bindings` cho compatibility, nó chỉ được là read-only view trỏ về possession table, không có DML hoặc semantics riêng.

Voucher CASHBOOK system-generated có thể birth/approve khi chưa biết sổ sẽ chi, nên cần routing thực thi riêng để không bị mồ côi và không gán `account_id` giả:

```text
app_private.finance_execution_scopes
  id, organization_id, execution_subject_kind = VOUCHER | SALARY_AUTHORIZATION
  execution_subject_id, parent_voucher_id, source_scope_kind, source_scope_id
  state = UNASSIGNED | ASSIGNED | POSTED | CANCELLED
  assigned_cashbook_id, revision, source_policy_version/hash
  claimed_by_membership_id, claim_expires_at, created_at, updated_at

app_private.finance_execution_cashbook_candidates
  organization_id, execution_scope_id, cashbook_id, source_kind/hash, created_at
```

- `VOUCHER` trỏ CASHBOOK voucher approved-unposted/ONE_SHOT child; `SALARY_AUTHORIZATION` trỏ MULTI_TRANCHE authorization đã được bundle approve. Subject + parent lineage có composite tenant FK và unique một execution scope mở;
- `account_id`/posting line vẫn là money truth khi post; `assigned_cashbook_id` chỉ routing cho payable đã duyệt/chờ duyệt và không đổi balance;
- source writer có thể persist exact candidate cashbooks từ cấu hình server, nhưng source UI không chọn ngày/sổ/evidence. Không dùng wildcard “mọi sổ trong org” hoặc suy candidates từ sổ user đang thấy;
- nếu có exact candidate mà actor là CUSTODIAN của sổ đó, page Thu Chi trả safe payable row cho actor và cho claim/assign+post với CAS. Actor chỉ thấy candidate thuộc chính binding của họ, không thấy balance/history/candidate khác;
- nếu không có candidate, execution subject vào **Chờ phân sổ** và chỉ actor có quyền `cashbooks.share` bao phủ organization/building/source scope thấy/assign được. Tái sử dụng permission canonical hiện hữu, không tạo grant key mồ côi; CUSTODIAN thường không thấy row chỉ vì cùng org;
- assign/reassign trước post dùng expected revision, source scope và audit; selected cashbook phải nằm trong candidate set hoặc assigner có `cashbooks.share` bao phủ exact cashbook + source scope. Sau active posting không reassign; sửa sai qua reversal;
- preflight/activation phải chứng minh mỗi source scope có thể sinh UNASSIGNED có ít nhất một active membership với `cashbooks.share`; nếu không, source writer fail trước birth thay vì tạo payable không owner;
- approve-and-post có thể atomically claim/assign exact cashbook + approve + post khi actor có cả approve, assign-if-needed và CUSTODIAN; birth XID vẫn phải thuộc transaction trước. Approve-only giữ execution row ASSIGNED/UNASSIGNED và không đóng mất queue thực thi;
- approval request terminal và execution queue là hai lifecycle khác nhau. Đóng approval không xóa payable đã được duyệt; cancel/reversal/salary supersession cập nhật execution state bằng dedicated adapter.
- hai bảng routing nằm trong `app_private`, revoke `PUBLIC/anon/authenticated` cả SELECT/DML; chỉ SECURITY DEFINER RPC đã scope được đọc/ghi. Direct REST, forged candidate/assignment và cross-tenant subject/cashbook phải fail.

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
- Pending live đã nằm trong kỳ khóa phải vào remediation queue có voucher, kỳ, amount, source, close run/revision và proposed disposition. Không auto-approve, auto-cancel hoặc tự chọn reopen/catch-up theo heuristic.
- Mỗi row chỉ được chuyển tiếp sau khi close owner xác nhận một trong ba hướng: nghĩa vụ hợp lệ và reopen/reclose; nghĩa vụ hợp lệ nhưng giữ snapshot cũ bằng `ADJUSTMENT_ONLY` ở kỳ mở; hoặc nghĩa vụ không hợp lệ và cancel/negative adjustment đúng audit. Kết quả được hash-lock và là precondition của profit feature activation.
- Nếu chọn catch-up cho nghĩa vụ tạo muộn, server set `recognition_source_mode=ADJUSTMENT_ONLY` trước khi tạo positive adjustment trong cùng transaction.
- Closed snapshot giữ nguyên; report current/open period cộng adjustment event, source hash và verification phải bao gồm adjustment id/payload hash/source mode.
- Không UPDATE/DELETE adjustment event; sai thì tạo event đối ứng.

### 6.7. Vòng đời reservation chi lợi nhuận

Không được tiếp tục suy ra số tiền lợi nhuận đã giữ từ enum của `approval_requests`. Baseline hiện tại, `public._profit_allocation_reserved_v2` chỉ tính request `PENDING_APPROVAL/POSTED`; khi Finance V2 đổi terminal approval thành `APPROVED`, nhánh Duyệt nhưng chưa Chi sẽ làm reservation biến mất giả và có thể cho tạo payout trùng.

Mở rộng `profit_payout_reservations` hiện hữu, không tạo reservation authority thứ hai:

```text
reservation_state = HELD | CONSUMED | RELEASED | REVERSED
state_version, state_changed_at, state_reason
consumed_posting_id, reversed_posting_id
```

Contract canonical:

- tạo payout pending giữ allocation bằng `HELD`;
- approve-only vẫn giữ `HELD`; `APPROVED + UNPOSTED` tuyệt đối không giải phóng allocation;
- post tiền chuyển `HELD -> CONSUMED` trong cùng transaction với posting. Cả `HELD` và `CONSUMED` đều được trừ khỏi allocation khả dụng;
- reject-invalid, maker withdraw hoặc cancel trước post chuyển `HELD -> RELEASED` trong cùng transaction và allocation được dùng lại;
- reversal payout đã post chuyển `CONSUMED -> REVERSED` trong cùng transaction với reversal; `REVERSED` không còn trừ allocation, giữ semantics hiện tại là hoàn lại phần lợi nhuận có thể chi;
- không cho đi lùi, skip state hoặc sửa amount/allocation/source identity. Transition dùng expected `state_version`, idempotency/payload hash và append audit/semantic event;
- `_profit_allocation_reserved_v2` hoặc replacement versioned chỉ SUM `HELD + CONSUMED`; mọi freshness/linkage/report/guard phải đọc reservation state canonical, không đọc request state như money truth;
- trước expand enum approval, inventory mọi dependent function/view/test đang đọc `approval_requests.state`, `reservation_source` hoặc `_profit_allocation_reserved_v2`, gồm payout writer, freshness/linkage guards, audit scripts và generated types;
- compatibility backfill: canonical request `PENDING_APPROVAL` -> `HELD`, compatibility `POSTED` hoặc payout lịch sử đã chứng minh cash effect -> `CONSUMED`, terminal pre-post -> `RELEASED`, reversal đã chứng minh -> `REVERSED`. Legacy `UNAPPROVED/APPROVED` chỉ map khi lineage/cash evidence xác định; row mơ hồ vào exception và chặn profit activation;
- transition reservation phải khóa allocation/reservation/voucher/request/posting theo một lock order cố định để không có cửa sổ double payout giữa approve, post, cancel và reverse.

### 6.8. Pair thanh lý bỏ cọc là một approval subject

Giữ `app_private.termination_forfeit_authorizations` làm pair authority cho hai voucher `termination.forfeit_revenue` và `termination.forfeit_offset`; không cho generic lifecycle coi chúng là hai phiếu độc lập:

- mở rộng pair authority bằng `pair_version`, `approval_request_id`, lifecycle/idempotency metadata và immutable source hash; cả hai voucher có flow owner `TERMINATION_FORFEIT_PAIR_V2`;
- đúng **một** approval request trong engine hiện hữu với subject type `TERMINATION_FORFEIT_PAIR`, subject id canonical là `revenue_voucher_id`/pair authority. Không tạo một request cho mỗi leg và không để request leg còn lại stale sau cascade;
- revenue leg giữ PNL recognition, offset leg giữ `DEPOSIT`; cả hai sinh `UNAPPROVED + PENDING + NON_CASH + NOT_APPLICABLE`, không tạo Finance cash posting/line. Pair approval sau đó mới chuyển cả hai sang APPROVED;
- final approve/cancel gọi dedicated pair adapter, khóa authorization + hai voucher theo thứ tự id, kiểm expected pair/request version rồi cấp private pair-transition context cho **cả hai** leg trong cùng transaction. Lỗi một leg/payment/invoice làm rollback toàn pair;
- forward-fix `guard_termination_forfeit_voucher_v1` phải yêu cầu pair-transition authorization bất cứ khi nào `NEW.approval_status IS DISTINCT FROM OLD.approval_status`, không phụ thuộc `v_status_only`. No-op total/header recalculation vẫn qua vì status không đổi; update status kèm `posting_id/posted_at_v2` hoặc metadata không được bypass;
- manual/generic approve/post/cancel RPC phải fail bởi flow ownership trên cả revenue lẫn offset. Pair adapter không được set Finance `posting_id`, active posting hoặc cash evidence;
- pending pair lịch sử chưa có request được backfill thành đúng một pair request từ immutable authorization snapshot. Hai request độc lập, mixed state, thiếu leg/payment lineage hoặc pair source hash mơ hồ vào exception, không auto-merge theo heuristic;
- compatibility `set_termination_forfeit_status_v1` được bọc/thay bằng pair adapter idempotent; trigger cascade chỉ là invariant enforcement, không là approval authority thứ hai.

### 6.9. Thanh lý rời phòng là bundle nguồn, không phải một cash event

Baseline effective chưa cùng semantics với bỏ cọc: `terminate_contract_move_out_impl` tạo `payments` cấn trừ ngay, sinh `termination.offset`/`termination.revenue` ở `APPROVED`, trong khi chỉ `termination.refund` là `UNAPPROVED` và extra receipt có thể `APPROVED` (`20260709100000_settlement_invoice_kind.sql:330`, `:359`, `:378`, `:403`; wrapper/classifier tại `20260721135500_termination_non_cash_payment_semantics.sql:837`). Finance V2 phải thay bằng một bundle có các approval subject tách bạch:

- source transaction thanh lý chỉ được cập nhật domain contract/room/invoice và ghi **kế hoạch quyết toán bất biến**; không materialize `payments` cấn trừ, không tạo posting/cash line và không đổi invoice thành đã thanh toán chỉ vì domain thanh lý đã hoàn tất;
- cặp `termination.revenue` + `termination.offset` sinh `UNAPPROVED + PENDING + NON_CASH + NOT_APPLICABLE`, dùng đúng một request `TERMINATION_MOVE_OUT_PAIR`. Revenue leg mang contribution PNL, offset leg mang `DEPOSIT`; generic approve/post/cancel theo từng leg bị chặn giống pair bỏ cọc;
- kế hoạch cấn trừ cần header/line canonical, ví dụ `termination_move_out_authorizations` + `termination_move_out_settlement_lines`, khóa theo organization/contract/termination/version và lưu từng invoice/amount/source hash. Mỗi line bắt buộc có `funding_kind=DEPOSIT_OFFSET|CUSTOMER_CREDIT`; `CASH_DUE` không được nằm trong pair hoặc materialize thành payment CT. Đây là planned non-cash settlement, không phải `payments` sống;
- approve pair mới atomically chuyển cả hai leg sang APPROVED và materialize các `payments` CT từ settlement lines được funding thật bởi deposit/customer-credit; lỗi một invoice/line/status/version làm rollback toàn pair. Pair không có Finance cash posting hoặc yêu cầu ngày/sổ/ảnh;
- `termination.refund`/compensation là approval subject CASHBOOK riêng, sinh `UNAPPROVED + UNPOSTED`, không account/posting/payment/evidence ở source transaction. Approve-only vẫn chưa chi; chỉ Posting dialog sau đó mới ghi tiền;
- một lần thanh lý có thể có cả pair non-cash và refund cash. UI có thể gom theo cùng termination để dễ hiểu nhưng engine phải giữ đúng hai subject: một pair request và một voucher request, không cascade approval của subject này sang subject kia;
- `termination.extra_receipt` chỉ là ngoại lệ tiền thật nếu user xác nhận đã nhận tiền và dedicated V5/collection adapter có đủ ngày thu, exact cashbook và evidence/reference hợp lệ. Nếu thiếu một điều kiện thì flow phải chọn `DEBT`/tạo khoản phải thu, tuyệt đối không sinh `APPROVED` hoặc payment cash-looking trong transaction thanh lý;
- cancel chỉ hợp lệ trước khi pair materialize. Sau approve phải dùng `reverse_termination_move_out_pair_v2` append-only để đảo CT settlement và hai leg theo đúng lineage, restore invoice đúng một lần; không delete payment, sửa leg gốc hoặc đưa pair về pending;
- reject/resubmit của pair hoặc refund không được hoàn tác contract bằng raw update. Domain reversal/reopen nếu cần là workflow riêng có audit; Finance state không bị suy từ `contract_terminations.status='COMPLETED'` hay `approved_at` của nghiệp vụ thanh lý.

### 6.10. Salary settlement là bundle, không post gross như cash

Salary phải tách nghĩa vụ P&L khỏi cách settlement để không vừa cấn tiền phòng vừa chi gross:

- một `SALARY_SETTLEMENT_BUNDLE` theo `(organization, staff, salary_period, source_revision)` giữ snapshot earning/advance/deduction/source ids và hash. Parent expense voucher là approval subject `NON_CASH + NOT_APPLICABLE` của gross salary obligation, birth Chờ duyệt và mang contribution P&L đúng một lần; cash execution luôn nằm ở child/tranche riêng;
- `cash_due`, planned rent offset và các khoản cấn trừ được server tính từ snapshot; client không gửi classification. Birth transaction phải commit parent + planned lines và mọi cash authorization/child cần cho policy đã chọn ở trạng thái chưa thực hiện; không được chờ tới approve mới khai sinh một Phiếu chi hệ thống;
- **Nhánh ONE_SHOT**: birth cùng một cash child voucher `UNAPPROVED + UNPOSTED`, `total_amount=cash_due`, contribution P&L 0. Parent + child dùng đúng một `SALARY_SETTLEMENT_BUNDLE` request; approve chuyển cả hai sang APPROVED và materialize rent offset, approve-and-post có thể post child trong cùng approval transaction vì birth đã commit ở transaction trước. Child không có request/action generic riêng;
- **Nhánh MULTI_TRANCHE**: không tạo voucher con theo từng đợt. Birth một `salary_cash_authorization` immutable với ceiling `cash_due`; bundle approval authorize ceiling đó. Mỗi lần chi sau duyệt tạo `salary_settlement_tranche` append-only `(bundle, sequence, amount, account, posted_on, evidence, posting_id, state/version/idempotency)` và posting tương ứng; transaction lock bundle + active tranches, bảo đảm cumulative active amount không vượt ceiling. Tranche là execution của obligation đã duyệt, contribution P&L 0 và không phải system expense voucher mới;
- quyết định §2.6 chọn đúng một nhánh trước implementation; không trộn hai model. Với ONE_SHOT không hỗ trợ partial. Với MULTI_TRANCHE, UI được nhập amount còn lại và bundle projection có `UNPAID/PARTIALLY_PAID/PAID/REVERSED`; generic manual voucher vẫn giữ no-partial;
- planned rent line không gọi `record_invoice_payment_v3` khi birth. Approve bundle mới materialize non-cash invoice settlement đúng một lần theo exact invoice/version; active one-shot posting hoặc tranche postings mới tăng số đã trả;
- bundle có `cash_due <= 0` không tạo voucher CASHBOOK/tranche 0 hoặc âm. Bất kể nhánh nào, rent offset không áp hai lần và invoice drift làm stale/fail;
- cash reversal và rent-offset reversal là hai append-only transition có linkage rõ; đảo cash không âm thầm restore invoice, đảo offset không giả lập tiền mặt. Parent/source snapshot và lịch sử đã duyệt bất biến;
- manager salary, staff salary và bulk payout phải gọi cùng primitive. Batch cần một envelope idempotent với deterministic per-row result; không chuỗi mutation UI để lại partial im lặng hoặc tăng `salary_monthly.paid` khi chưa có active posting.

### 6.11. Một source earning chỉ có một payout owner

- broker commission luôn được định danh bằng recipient FK/source key, không match bằng `payer_name`, alias hoặc text. Policy Sale/commission còn mở tại §2.6 phải được stamp bằng `settlement_mode=STANDALONE|PAYROLL` bất biến trước khi materialize;
- `STANDALONE` tạo đúng một Phiếu chi pending và không được salary snapshot cộng lại. `PAYROLL` chỉ là earning source, được một salary-period snapshot consume bằng unique link và không được generic approve/post;
- link `salary_earning_consumptions` có lifecycle `HELD/CONSUMED/RELEASED/CLAWED_BACK`: bundle birth giữ earning bằng HELD; approve chuyển CONSUMED; CHANGES_REQUESTED/resubmit giữ HELD; reject/cancel bundle lỗi nhưng earning còn thật chuyển RELEASED để `UNSNAPSHOTTED_SALARY_EARNING` xuất hiện lại trong cùng transaction; chỉ source earning thực sự không hợp lệ mới CLAWED_BACK có reason/lineage;
- approved bundle cần sửa phải qua `supersede_salary_settlement_bundle_v2`: reverse active cash/rent settlement nếu có, terminal ONE_SHOT child hoặc MULTI_TRANCHE authorization/execution scope, rồi release hoặc atomically transfer earning links sang replacement pending bundle. Không xóa link/parent hoặc để earning vừa không còn P&L vừa không còn blocker;
- job bonus giữ source truth hiện hữu là immutable earning ledger: `JOB` unique theo `(org, staff, job, rule_version)`, `DAY_BONUS` unique theo `(org, staff, local_date, rule_version)`. Notification chỉ là projection; complete job/award/lock không tạo voucher, approve, post hoặc paid;
- P&L chỉ nhận job/commission PAYROLL earning qua salary bundle đã snapshot để tránh double count. Close resolver phải có blocker `UNSNAPSHOTTED_SALARY_EARNING` cho earning thuộc kỳ chưa được một salary bundle consume; không được chốt lợi nhuận chỉ vì chưa chạy chốt lương/materialization;
- recognition milestone, clawback và payout ownership phải có policy version. Clawback/reversal nối source gốc, không sửa/xóa earning đã snapshot hoặc tạo khoản âm không lineage;
- P&L resolver, salary snapshot và cash writer phải chứng minh cùng một source id xuất hiện đúng một lần. Source không có settlement mode/policy version hoặc đã bị owner khác consume làm Finance activation fail closed.

## 7. Contract RPC và state machine V2

### 7.1. Private primitives duy nhất

Không để mỗi domain tự cập nhật `income_expenses`. Tất cả public RPC và system writer phải gọi các primitive private sau:

- `app_private.resolve_finance_actor_v2` — lấy `auth.uid()`, membership active, organization và trace id.
- `app_private.assert_cashbook_access_v2` — kiểm membership + emergency/member/role covering DENY trước, rồi positive grant `CUSTODIAN/KNOWER`, hiệu lực binding và exact cashbook.
- `app_private.assert_income_expense_flow_owner_v2` — kiểm `income_expense_flow_ownership`, không cho manual RPC chiếm lifecycle của V5/contract/termination/profit/system writer.
- `app_private.dispatch_finance_decision_v2` — khóa flow owner/approval subject và dispatch approve, request-change, reject, dispute, cancel, resubmit, post, approve-and-post hoặc reverse tới adapter đã đăng ký; composite system subject (salary/refund/pair/profit) không đi qua manual primitive. Unknown owner fail closed.
- `app_private.resolve_business_result_v2` — xác định `counts_in_business_result`, `kqkd_amount`, `recognition_date`; client không tự quyết định.
- `app_private.assert_system_obligation_birth_v2` — allowlist writer class/source owner và ép expense obligation birth `UNAPPROVED` với `CASHBOOK/UNPOSTED` hoặc `NON_CASH/NOT_APPLICABLE`; cấm approved/posting/payment/settlement metadata hoặc side effect trong source context.
- `app_private.assert_committed_birth_boundary_v2` — trước approve/post/cancel, khóa create operation, kiểm completed/source hash/subject và bắt current XID khác `birth_txid`; nested create→approve/post trong cùng transaction luôn fail.
- `app_private.guard_or_adjust_recognition_v2` — chặn sửa kỳ khóa hoặc tạo adjustment/reopen workflow hợp lệ.
- `app_private.create_income_expense_v2` — tạo voucher/header/items theo một contract.
- `app_private.approve_income_expense_v2` — chỉ phê duyệt.
- `app_private.post_income_expense_v2` — tạo posting event cho voucher đã duyệt.
- `app_private.approve_and_post_income_expense_v2` — duyệt + posting trong cùng transaction.
- `app_private.transition_income_expense_review_v2` — request changes/reject/dispute/resubmit theo state machine.
- `app_private.cancel_unposted_income_expense_v2` — chỉ hủy voucher chưa post.
- `app_private.reverse_income_expense_posting_v2` — tạo reversal có audit.
- `app_private.post_collection_tender_v2` / `reverse_collection_tender_v2` — private adapter để V5 tạo một posting lineage cho mỗi tender và reversal liên kết, trong cùng transaction V5.
- `app_private.register_system_evidence_v2` — tạo evidence `SYSTEM_REFERENCE` từ source-owned receipt/snapshot, không nhận raw URL từ client.
- `app_private.set_cashbook_access_v2` — append/close binding theo revision.
- `app_private.assign_finance_execution_v2` — CAS claim/assign exact cashbook cho `VOUCHER|SALARY_AUTHORIZATION` chưa post đủ, kiểm candidate/CUSTODIAN hoặc `cashbooks.share` covering source+cashbook và không chạm balance.
- `app_private.transition_profit_payout_reservation_v2` — chuyển `HELD/CONSUMED/RELEASED/REVERSED` nguyên tử cùng lifecycle/posting/reversal, không suy từ request enum.
- `app_private.transition_termination_forfeit_pair_v2` — approve/cancel đúng một pair request, khóa/cập nhật hai leg + non-cash settlement atomic và cấp pair-transition context riêng.
- `app_private.transition_termination_move_out_pair_v2` / `reverse_termination_move_out_pair_v2` — approve/cancel pre-materialization hoặc append-only reverse đúng một move-out pair request; chỉ materialize planned CT settlement có funding hợp lệ và không tạo cash posting.
- `app_private.reserve_invoice_refund_obligation_v2` / `transition_invoice_refund_reservation_v2` — khóa invoice/refundable amount, birth pending atomically và chuyển reservation `HELD/CONSUMED/RELEASED/REVERSED` cùng posting/reversal.
- `app_private.transition_salary_settlement_bundle_v2` / `supersede_salary_settlement_bundle_v2` — một request approve/reject/resubmit parent + ONE_SHOT child hoặc MULTI_TRANCHE authorization đã birth trước đó, materialize/reverse rent offset, chuyển earning HELD/CONSUMED/RELEASED/CLAWED_BACK và terminal/transfer execution artifacts nguyên tử; dedicated post/reverse cash giữ cumulative cap.
- `app_private.enqueue_deferred_customer_credit_v2` — ghi/idempotently reconcile customer-credit bị wrapper thanh lý defer; không coi queue row là đã apply/refund và không tự sinh cash posting.

Mỗi primitive phải:

- lock voucher, account, membership/binding và approval request bằng `FOR UPDATE` theo thứ tự cố định;
- kiểm quyền lại sau khi lấy lock;
- lấy actor/organization từ session, không tin field client;
- lifecycle RPC phải reserve/lock `app_private.canonical_write_operations`; posting/access/recognition dùng cùng authority hoặc unique event store tương ứng với idempotency key + payload hash, không dual-reserve;
- append audit event trong cùng transaction;
- không gọi lại public RPC;
- không có fallback raw table DML.

Các adapter Finance V2 phải bọc, không thay thế, invariants đã land của Invoice Collection V5, customer-credit lot/apply/reversal, termination non-cash trusted context, contract create V2, salary/profit payout reservation/freshness và các reversal tương ứng. Không writer nào được hạ các flow này thành raw mutation `income_expenses`.

### 7.2. Public RPC đề xuất

| RPC | Actor/quyền | Kết quả |
|---|---|---|
| `create_income_expense_v2` | CUSTODIAN tạo Thu/Chi; KNOWER chỉ tạo Thu trên exact cashbook; capability theo type | Tạo voucher hoàn chỉnh, mặc định Chờ duyệt + Unposted. |
| `approve_income_expense_v2` | `income_expenses.approve` và phạm vi approval | Decision dispatcher chuyển `UNAPPROVED → APPROVED` cho voucher hoặc composite subject; balance không đổi, adapter/source reservation cập nhật theo owner. |
| `approve_and_post_income_expense_v2` | approve + `CUSTODIAN` exact cashbook | Atomic decision dispatcher + flow-owner posting; adapter cập nhật reservation/source/paid cùng transaction. |
| `post_approved_income_expense_v2` | `CUSTODIAN` exact cashbook | Flow-owner dispatch voucher `APPROVED + UNPOSTED`; không cần quyền approve, không bypass owner guard. |
| `assign_finance_execution_cashbook_v2` | `cashbooks.share` covering source+cashbook hoặc CUSTODIAN exact candidate | CAS assign/claim voucher hoặc salary authorization execution request; không ghi tiền. |
| `list_finance_execution_queue_v2` | assigner scope hoặc CUSTODIAN exact candidate | Trả safe Chờ phân sổ/Chờ chi subject projections và capability; không trả balance/history/candidate ngoài binding. |
| `post_salary_settlement_tranche_v2` | CUSTODIAN exact assigned/candidate cashbook | Post một MULTI_TRANCHE amount không vượt remaining authorization; subject/tranche/posting/evidence atomic, không cần approval lần hai. |
| `reverse_income_expense_execution_v2` | reversal capability đúng owner/scope | Dispatch reversal về adapter gốc để posting, reservation, source paid/refunded và execution state đảo atomic. |
| `request_income_expense_changes_v2` | approver đúng scope | Giữ UNAPPROVED, set voucher CHANGES_REQUESTED và đóng request hiện tại thành CHANGES_REQUESTED với outcome/field mask. |
| `reject_invalid_income_expense_v2` | approver đúng scope | CANCELLED + terminal posting state theo mode khi chứng minh không phát sinh/trùng. |
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
type PostFinanceExecutionInput = {
  subjectKind: 'VOUCHER' | 'SALARY_AUTHORIZATION';
  subjectId: string;
  cashbookId: string;
  postedOn: string;       // YYYY-MM-DD
  evidenceIds: string[];  // id registry FINALIZED, ít nhất 1 với Thu/Chi thủ công
  amount?: number;        // chỉ MULTI_TRANCHE, server cap theo remaining authorization
  expectedExecutionRevision: number;
  expectedApprovalVersion: number;
  expectedPostingVersion: number;
  idempotencyKey: string;
};
```

Với `VOUCHER`, phase đầu không nhận `amount`; server lấy approved voucher total. Với `SALARY_AUTHORIZATION`, `amount` chỉ hợp lệ khi decision policy là MULTI_TRANCHE và không vượt remaining ceiling; đây là dedicated contract/version, không mở partial cho generic voucher.

### 7.3. Duyệt và Chi CASHBOOK nguyên tử

Thứ tự bắt buộc trong một transaction:

1. Resolve actor/membership/org.
2. Lock voucher + birth operation/execution scope; bắt current XID khác birth XID.
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
- Expand migration phải drop/recreate state check, bổ sung outcome columns và giữ one-open index chỉ trên `PENDING_APPROVAL` trước khi deploy writer mới. Constraint live hiện không có `APPROVED/WITHDRAWN/CHANGES_REQUESTED/DISPUTED`, nên không được đổi app trước schema compatibility.
- Thêm server-owned `outcome_kind`, `outcome_reason`, `closed_by_membership_id`, `closed_at`. History phân biệt REQUEST_CHANGES, INVALID_OR_DUPLICATE, DISPUTE, MAKER_WITHDRAW và approval/rejection thường thay vì suy từ một state chung.
- `WITHDRAWN` chỉ do canonical withdraw RPC set cho request `PENDING_APPROVAL`; approval inbox loại row này, history/detail hiển thị “Đã rút”, partial unique “one open subject” chỉ xét `PENDING_APPROVAL`. Withdraw từ voucher CHANGES_REQUESTED giữ request lịch sử CHANGES_REQUESTED và append withdrawal audit riêng.
- `decide_financial_request_v2(..., 'APPROVE')` không tự post.
- Request-changes/dispute/reject/withdraw phải đóng request `PENDING_APPROVAL` hiện tại sang terminal-per-request tương ứng trong cùng transaction với voucher transition; không để request cũ tiếp tục chiếm partial unique.
- `REJECTED/DENIED` phải có outcome rõ: invalid/duplicate → voucher CANCELLED; policy/payment dispute → voucher DISPUTED; không chỉ đóng request rồi để voucher pending vô hạn.
- Withdraw đóng request hiện tại thành `WITHDRAWN` nếu nó còn PENDING, hoặc giữ request CHANGES_REQUESTED bất biến rồi append audit nếu request đã terminal; resubmit chỉ sau voucher CHANGES_REQUESTED, xác nhận không còn request PENDING rồi tạo request/submission/version mới và không double count recognition. Không reopen row request cũ.
- `AUTO_POST` không được dùng cho Phiếu chi thủ công hoặc nghĩa vụ hệ thống chưa có chứng từ/ngày/sổ.
- `app_private.post_financial_request_v1` và `_post_financial_voucher` không được là đường mặc định sau final approval.
- Approval inbox trả capability `canApprove`, `canApproveAndPost`, safe cashbook options và version; không cấp quyền đọc toàn sổ.
- Historical request `CANCELLED` chỉ backfill thành `WITHDRAWN` khi provenance chứng minh maker-withdraw; row mơ hồ giữ nguyên compatibility state và vào exception. Không suy diễn chỉ từ request/voucher status.
- Live pending voucher hiện thiếu approval-request linkage phải được backfill bằng request/submission V2 mới từ immutable voucher snapshot + flow ownership, không tạo decision giả và không đổi recognition. Duplicate/open-request conflict hoặc source owner mơ hồ vào exception.
- Riêng termination forfeit dùng một request `TERMINATION_FORFEIT_PAIR` theo §6.8. Submit/decide generic theo từng voucher bị chặn; final decision dispatch sang pair adapter, và backfill không được tạo hai request cho revenue/offset legs.
- Deprecate `withdraw_financial_request_v1`; wrapper financial-voucher phải gọi atomic V2 voucher + request transition. Super-admin không có implicit override trên normal maker-withdraw path; break-glass là RPC riêng có reason/audit.
- `posting_id/posted_at_v2` do engine hiện tại ghi chỉ được dùng để nhận diện compatibility history trong backfill. Nó không chứng minh đã có Finance V2 posting event và không được làm `posted_on`.
- Trước khi writer mới có thể set request terminal `APPROVED`, reservation lifecycle §6.7 và mọi enum consumer phải được migrate trong cùng expand release. Approval-only của profit payout phải giữ reservation `HELD`; post/cancel/withdraw/reverse cập nhật reservation nguyên tử theo cash lifecycle.

## 8. Phân loại writer và birth state

Mỗi writer phải được gắn một class trước khi sửa. Không tìm-thay `APPROVED` máy móc.

| Class | Ví dụ | State tạo đích | Ghi chú |
|---|---|---|---|
| Nghĩa vụ thủ công | Người dùng tạo Phiếu chi/thu | `UNAPPROVED + UNPOSTED` | Submit ngay, không Draft. |
| Nghĩa vụ hệ thống | chi thanh lý/hoàn cọc, commission/thưởng `STANDALONE`, salary bundle, recurring/phí định kỳ | `UNAPPROVED + (CASHBOOK: UNPOSTED / NON_CASH: NOT_APPLICABLE)` | Transaction nguồn phải kết thúc ở Chờ duyệt; có thể vào KQKD trước duyệt nếu server xác định đã phát sinh. Earning `PAYROLL` là source được salary bundle consume, không phải voucher standalone. |
| Tiền thu thật đã được user xác nhận | invoice collection, quick collect, receipt cọc hợp đồng đã nhận | `APPROVED + POSTED` qua dedicated atomic writer | Ngoại lệ chỉ áp dụng cho receipt/collection thực tế có sổ/ngày/evidence hoặc source reference hợp lệ; không áp dụng cho bất kỳ Phiếu chi hệ thống nào. |
| Nghĩa vụ phi tiền mặt/nội bộ cần duyệt | termination forfeit pair, cấn trừ cần phê duyệt | Birth `UNAPPROVED + NOT_APPLICABLE`, sau duyệt `APPROVED + NOT_APPLICABLE` | Không vào balance nhưng vẫn phải qua approval; KQKD theo policy/source class riêng. |
| Import/batch | nhập hàng loạt nghĩa vụ | `UNAPPROVED + UNPOSTED` | Phase đầu không bulk auto-post. |
| Opening adjustment | điều chỉnh số dư được kiểm soát | Dedicated posting/reversal writer | Quyền, reason và audit chặt hơn thao tác thường. |
| Hoàn cọc/hoàn tiền tạo nghĩa vụ mới | refund expense từ thanh lý/hợp đồng | `UNAPPROVED + UNPOSTED` | Chỉ Chi sau approval bằng ngày/sổ/chứng từ; không tạo payment/cash line trong source transaction. |
| Reversal/sửa sai tiền đã post | hoàn tác cash event gốc | Dedicated reversal | Không sửa/xóa posting gốc hoặc biến reversal thành pending voucher mới. |

Adapter matrix bắt buộc trên baseline hiện tại:

| Writer/flow hiện hữu | Authority phải giữ | Adapter Finance V2 |
|---|---|---|
| Manual create/import/batch/recurring | Voucher lifecycle + item classification | Gọi create primitive nguyên tử, birth `UNAPPROVED + UNPOSTED`; không header/item multi-request hoặc best-effort rollback. |
| Contract create V2/deposit receipt | Contract transaction/idempotency/flow ownership, deposit shortfall/debt invariant | Mọi expense obligation sinh trong RPC hoặc modal ngay sau tạo HĐ đều birth pending. Deposit chỉ là actual-cash nếu receipt intent có ngày/sổ/evidence và dedicated adapter post atomic; `deposit_paid`/shortfall chỉ derive từ active posting, không từ APPROVED. Confirmed-receipt link nếu có chỉ là immutable lineage/evidence FK tới posting đang active. |
| Contract commission/bonus | Unique per contract/kind, recipient FK, amount calculation và policy version | Sau decision §2.6, `STANDALONE` mới tạo `UNAPPROVED + UNPOSTED`; `PAYROLL` chỉ ghi earning source để salary consume và không generic-post. Source modal không nhận ngày chi/sổ/ảnh, không create-and-pay/“Chi & duyệt”; recognition/clawback theo policy server. |
| Invoice Collection V5/reverse V5 | Collection/tender/allocation, LIFO/reversal, `canonical_write_operations` | Một posting/evidence lineage cho mỗi tender; collection/payment/voucher mirror là cùng một cash event, không ba nguồn độc lập. |
| Customer credit lot/apply/reversal | Credit lot balance, feature gate và allocation class | Giữ `CUSTOMER_CREDIT`, không đưa vào cash/P&L hoặc bypass gate bằng IE mutation. |
| Deferred customer credit khi thanh lý bỏ cọc | Credit lots, wrapper response/idempotency và feature route | Cho domain termination hoàn tất nhưng phải enqueue/reconcile khoản `deferred=true`; chưa apply/refund, không mark settled. Apply/cấn trừ là non-cash adapter; hoàn tiền thật birth một refund obligation pending `CUSTOMER_CREDIT`, chỉ post sau approval. |
| Invoice refund obligation | Invoice/version, refundable cap, V5 collection/reversal lineage | Một RPC atomic tạo pending + reservation `HELD`; không header/item hai request, không ngày/sổ/evidence ở source. Server phân loại: hoàn DEPOSIT/CUSTOMER_CREDIT không P&L; refund/contra-revenue PNL có negative contribution và block close khi pending. Approve không đổi `refunded_cash` hoặc invoice paid state; active posting/reversal mới consume/reverse reservation. V5 tender change/refund và collection reversal vẫn là actual-cash/reversal writer riêng. |
| Termination move-out non-cash pair | Termination domain, deposit caps, planned invoice settlements và source linkage | `termination.revenue/offset` cùng birth pending `NON_CASH + NOT_APPLICABLE`; source transaction chỉ ghi settlement plan. Một pair request/dedicated adapter materialize CT payments khi approve; generic per-leg action bị chặn. |
| Termination refund/compensation | Termination domain approval, contract/deposit caps và source linkage | Mọi Phiếu chi hoàn cọc/chi thanh lý sinh `UNAPPROVED + UNPOSTED`, không account/payment/posting/evidence tại source. Duyệt không chi; Posting dialog mới nhận ngày/sổ/ảnh. |
| Termination forfeit pair | Trusted context, pair authority, accounting-chain writer, authorized status transition và A/R settlement | Hai leg birth pending `NON_CASH + NOT_APPLICABLE`; một pair chỉ có một approval request/dedicated adapter, generic per-leg approve/post bị chặn; mọi status change cần pair context, no-op recalc không bị coi là transition; không backfill thành cash chỉ vì có payment row. |
| Termination extra receipt | Invoice/collection provenance và actual-cash confirmation | Chỉ post qua V5/dedicated collection adapter khi đủ ngày/sổ/evidence; nếu chưa nhận thật thì để khoản phải thu/DEBT, không auto-APPROVED trong RPC thanh lý. |
| Utility/fixed fee/recurring | Nghĩa vụ hệ thống theo kỳ | Tạo pending recognized obligation; chốt period/job không tự approve hoặc đánh dấu paid. Chỉ Finance approval + dedicated posting mới chi tiền. |
| Salary lock/job bonus | Salary snapshot, immutable job/bonus earning ledger và period lock | Lock chỉ đóng băng exact source ids/hash; không duyệt commission, không tạo voucher/cash event và không tăng `paid`. `award_job_bonus` không materialize voucher per-job; notification không phải source truth. |
| Salary payout/rent offset | Salary bundle freshness, gross/cash split, invoice balance và payout idempotency | Birth parent pending + planned settlement và ONE_SHOT child pending hoặc MULTI_TRANCHE authorization theo decision; không sinh child sau approve. Không gọi `record_invoice_payment_v3` ở birth; một bundle request approve toàn subject, active one-shot/tranche posting mới tăng `paid`, reversal theo linkage. |
| Manager/staff salary bulk | Cùng salary bundle contract và source revision | Một batch envelope idempotent trả result deterministic từng staff; không chuỗi UI mutations gây partial im lặng. Source form không nhận cashbook/ngày/evidence; các field này chỉ ở Finance posting. |
| Shareholder profit payout | Reservation, current-source freshness và payout idempotency | Tách nghĩa vụ/payout cash; map approve/post/cancel/reverse sang `HELD/CONSUMED/RELEASED/REVERSED`, không làm yếu reservation/hash checks. |
| Opening adjustment/handover/net sweep/reversal | Dedicated privileged money operation | Gọi posting/reversal primitive với reason/evidence/quyền cao hơn; refund obligation mới không đi đường này và không sửa voucher/posting gốc. |
| Copilot/service-role/cron | Cùng server authorization và idempotency | Chỉ gọi public/system RPC canonical; không direct DML hoặc chấp nhận orphan item. |

Writer bắt buộc audit:

- `src/hooks/income-expenses/mutations.ts`
- `src/hooks/income-expenses/statusMutations.ts`
- `src/hooks/income-expenses/batch.ts`
- `src/hooks/income-expenses/recurring.ts`
- `src/hooks/income-expenses/specialized.ts`
- import dialog và cron recurring;
- invoice collection/payment mirror;
- contract create/deposit receipt + `useCommissionVoucher.ts`, `CommissionVoucherModal.tsx`, `PeriodCommissionModal.tsx` và commission/thưởng;
- `useContractOperations.ts`, `TerminateDialog.tsx`, `terminate_contract_move_out*` + hoàn cọc/chi thanh lý/move-out/forfeit pair;
- invoice refund obligation, refundable reservation và projection invoice;
- deferred customer-credit queue/resolver và response UI;
- utility payment;
- `useManagerSalary.ts`, `lock_salary_month_v1`, `salary_payout_v1`, manager salary, rent-offset và job/bonus ledger;
- shareholder profit payout;
- deposit/quick deposit;
- opening adjustment;
- cash handover/net sweep;
- Copilot write tools;
- mọi service-role/cron function insert hoặc update `income_expenses`.

Gate trước khi bật SHADOW: không còn writer tạo money truth bằng cách set `approval_status='APPROVED'`, dựa vào DB default hoặc ghi trực tiếp header/items. Riêng mọi system-generated expense obligation phải chứng minh birth transaction **đã commit** ở `UNAPPROVED` trước khi bất kỳ operation approve/post kế tiếp được phép chạy, và không có posting/payment/cash line hoặc settlement side effect trong birth transaction; chỉ được ghi immutable planned-settlement rows. Static scan phải inventory mọi `INSERT income_expenses`, DB negative tests phải chặn source context giả/side effect. Legacy direct-DML/fallback caller count phải bằng 0, không để việc drain này tới contract cleanup cuối; generic `42501` không bao giờ được hiểu là coexistence fallback, chỉ structured/typed route signal mới được compatibility wrapper xử lý.

Flow-owner decision registry tối thiểu phải map `MANUAL`, `INVOICE_REFUND`, `TERMINATION_REFUND`, `CONTRACT_COMMISSION_STANDALONE`, `SALARY_BUNDLE`, `PROFIT_PAYOUT`, `UTILITY/RECURRING`, termination pairs và các source còn lại tới private lifecycle/post/reverse adapter. Mọi public approve/reject/cancel/resubmit/post RPC chỉ dispatch; adapter chịu trách nhiệm cập nhật request, composite legs/child/auth, reservation, invoice/refund, salary `paid`, profit allocation hoặc source projection cùng transaction. Owner/source lạ không được rơi về manual.

### 8.1. Inventory nguồn hệ thống bắt buộc khóa semantics

| Source/flow | Hiện trạng baseline | Đích Finance V2 và khóa chống regression |
|---|---|---|
| `contract.commission` broker/sale | RPC đã tạo `UNAPPROVED`, nhưng `CommissionVoucherModal` gọi pending là “nháp/đã chi”; `PeriodCommissionModal` có nhánh tạo rồi `approve_voucher`, `get_period_commissions` coi có voucher là `paid`, còn salary lại cộng commission theo tên recipient. | Broker và Sale phải theo decision §2.6, recipient FK + `settlement_mode` + policy version. `STANDALONE` có state voucher; `PAYROLL` dùng earning + consumption `HELD/CONSUMED/RELEASED/CLAWED_BACK` và không generic-post. Không source nào vừa vào payroll vừa có voucher trả độc lập. |
| Contract create V2 | Deposit receipt sinh `APPROVED`; `deposit_paid` dùng APPROVED để chạy shortfall/debt, còn source DB `contract.create.v2` drift với catalog `contract.deposit`. Commission/thưởng mở sau tạo HĐ. | Tách receipt intent khỏi contract domain, post atomic actual-cash khi đủ ngày/sổ/evidence; `deposit_paid`/shortfall chỉ đọc active posting. Alias/backfill source canonical; lineage link không là money truth và reversal loại posting khỏi tổng. |
| `termination.refund` | Đã birth `UNAPPROVED`, account null, nhưng code/comment/UI còn gọi Nháp và dùng `voucher_date` như ngày chi. | Giữ pending; ngày thanh lý là recognition/obligation date, không phải `posted_on`. Không chọn sổ/ảnh hoặc ghi payment cho đến Finance post. Pure deposit refund là `DEPOSIT` nên không tự giảm P&L/block close; compensation/PNL item vẫn theo effective contribution. |
| `termination.revenue` + `termination.offset` | Move-out sinh thẳng `APPROVED` và tạo các payment CT trước approval. | Birth một move-out NON_CASH pair pending + staged settlement lines; đúng một request. Approve pair mới materialize CT payment, không có cash posting; pair contribution PNL/DEPOSIT và blocker dùng cùng resolver. |
| `termination.forfeit_revenue` + `termination.forfeit_offset` | Đã birth pending và settle khi approve, nhưng guard replacement hiện còn lỗ combined status+metadata và generic request chưa pair-aware. | Giữ một `TERMINATION_FORFEIT_PAIR`, forward-fix mọi status change cần pair context, một request/subject/version; không per-leg/posting. |
| `termination.extra_receipt` | Move-out có thể sinh `APPROVED` + tiền nhận ngay khi chọn `PAID`, chưa có contract evidence Finance V2. | Chỉ actual-cash V5/dedicated adapter được post; bắt ngày, exact cashbook và evidence/reference. Không đủ thì `DEBT`, không tạo payment/voucher cash-looking. |
| Invoice refund | Hook hiện insert voucher + item bằng hai request; `recompute_invoice_for_id` trừ refund dựa `APPROVED`, form nguồn hỏi sổ/ngày. | `INVOICE_REFUND_OBLIGATION` birth pending atomic + reserve refundable due. Approve-only không giảm invoice/refunded cash; posting/reversal mới consume/reverse. Hai pending song song không reserve vượt cap; source UI không hỏi posting fields. |
| Deferred customer credit sau forfeit | Wrapper `20260722160000` cho termination chạy khi credit route SHADOW và trả `deferred=true`, nhưng chưa có queue/SLA; migration test cũ chỉ đọc definition `20260721135000`. | Inventory từ canonical response + open lots, enqueue một remediation item/source key. Không auto-approve/post. Apply credit hoặc refund pending theo dedicated writer; test effective override `20260722160000` và live function fingerprint. |
| `salary.staff` / `salary.manager` | Canonical payout tạo pending, nhưng salary lock còn auto-approve commission; salary rent-offset tạo payment/receipt ngay; fallback raw DML có thể stamp `paid` và tạo companion `APPROVED`; bulk UI có thể partial. | Một salary bundle parent pending; ONE_SHOT child cũng pending cùng birth hoặc MULTI_TRANCHE authorization immutable. Lock/job không đổi Finance state. Bulk envelope retry-safe; `paid` chỉ derive/update từ active posting/tranche, reversal giảm đúng một lần. |
| Job/bonus ledger | `award_job_bonus` tạo notification/ledger; bonus được gom vào salary snapshot. | Canonical earning source-only, không voucher lúc job/lock. Unique JOB/DAY_BONUS theo rule version; salary snapshot consume exact source id/hash một lần, không double count giữa ledger, salary obligation và P&L. |

Mỗi row system-generated mới phải có canonical `system_source` + immutable source subject/ref + unique/idempotency contract. Không dùng tên/notes để quyết định lifecycle. `src/lib/voucherSources.ts`, approval routing, P&L resolver, list/filter/export và audit script phải nhận cùng source inventory; source chưa phân loại làm Finance activation fail closed.

Mapping nguồn phải được khóa trong migration/backfill, không để alias sống song song như hai nghiệp vụ:

| Giá trị baseline/thiếu source | Giá trị đích | Quy tắc |
|---|---|---|
| Deposit DB `contract.create.v2`, catalog `contract.deposit` | `contract.deposit` | Backfill alias theo flow ownership/contract id; receipt actual-cash chỉ qua dedicated adapter. |
| Manager salary compatibility `profit.manager_salary` hoặc NULL | `salary.manager` | Stamp source + manager/period/bundle id; không suy từ tên phiếu. |
| Staff salary canonical/fallback NULL | `salary.staff` | Stamp staff/period/bundle id; fallback raw DML bị drain. |
| Rent-offset companion receipt không source | `salary.rent_offset` | Chỉ planned/materialized line của salary bundle, không standalone cash receipt. |
| Invoice refund không source | `invoice.refund` | Bắt invoice/refund reservation id; không trộn với V5 tender change hoặc collection reversal. |
| Deferred forfeit credit chỉ nằm trong response | `customer_credit.deferred_forfeit` | Queue item dùng contract/canonical-operation/open-lot refs; resolver operation riêng. |

Mỗi alias backfill phải có before/after count, amount/source hash và exception list; sau cutover writer chỉ ghi giá trị đích, `voucherSources.ts`/DB constraint cùng fail closed với source lạ.

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
  => mọi voucher/posting ảnh hưởng cashbook đó
     UNION safe approved/pending payable được assigned hoặc có exact execution candidate là cashbook đó

KNOWER(cashbook)
  => voucher.type = INCOME
     AND voucher.maker_user_id = auth.uid()
     AND voucher.account_id = cashbook

không binding
  => không row
```

Phải xét đủ `account_id`, `change_account_id`, `rounding_account_id` cho CUSTODIAN. Approved-unposted `account_id IS NULL` chỉ xuất hiện qua execution scope exact candidate/assignment; row UNASSIGNED không candidate chỉ nằm trong restricted assigner queue. KNOWER chỉ được phạm vi Phiếu thu primary account do chính họ tạo, đồng thời vẫn cần current active membership/binding trên organization/cashbook. `maker_membership_id` giữ audit nguồn; predicate không bao giờ dùng legacy `user_id` hoặc field creator từ client.

Restricted category, exact-link self-view và tenant/building permission phải được AND với cashbook predicate; không được OR làm rộng.

### 9.3. DML

- Revoke INSERT/UPDATE/DELETE trực tiếp trên `income_expenses`, `income_expense_items`, posting headers/lines/evidence links, evidence registry, `income_expense_recognition_adjustments` và `cashbook_possession_bindings` cho client; `app_private.canonical_write_operations`, `app_private.finance_execution_scopes`, `app_private.finance_execution_cashbook_candidates`, CAS request/result và control tables không grant client SELECT/DML.
- Revoke explicit/default privilege `PUBLIC/anon/authenticated` trên execution routing tables/functions; chỉ grant EXECUTE đúng definer RPC. Direct REST SELECT/INSERT/UPDATE/DELETE, cross-org subject/candidate và forged assign/claim đều có negative tests.
- Revoke client SELECT trực tiếp trên `cashbook_possession_bindings`/history/CAS state; user-facing access chỉ qua `list_my_cashbook_access_v2` hoặc admin RPC exact-scope với safe fields.
- Mọi ghi qua RPC V2.
- `USING` kiểm sổ cũ; `WITH CHECK` kiểm sổ mới nếu có mutation chuyển metadata.
- Server bỏ qua hoặc từ chối `organization_id`, `user_id/created_by`, `approved_by`, `posted_by` do client gửi.
- KNOWER gọi REST tạo EXPENSE, đổi type/account/status hoặc giả creator phải fail.

### 9.4. Read models theo capability

Không dùng một `useAccounts()` trả mọi cột cho mọi mục đích. Backend/API cần shape riêng:

Mọi shape user-facing mặc định áp `income_expenses.deleted_at IS NULL`; chỉ audit/history RPC có capability rõ mới thấy tombstone và source hash trong private audit.

- `list_cashbooks_for_income_v2`: CUSTODIAN + KNOWER; chỉ id/name và capability cần thiết.
- `list_cashbooks_for_expense_v2`: chỉ CUSTODIAN.
- `list_cashbooks_with_balance_v2`: chỉ CUSTODIAN hoặc quyền báo cáo rõ ràng.
- `get_cashbook_access_admin_v2`: chỉ actor có `cashbooks.share` exact scope; trả current revision + active assignments/eligible memberships tối thiểu, không expose binding history, audit, balance hoặc sổ khác.
- `list_finance_execution_queue_v2`: safe projection theo subject/candidate/assigner capability; base routing tables luôn private.
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

Không bật policy hẹp trước khi caller/adapters sẵn sàng, nhưng cũng không giữ leak broad ở route LEGACY/SHADOW.

| Stored mode / effective route | Read boundary | Write boundary |
|---|---|---|
| `OFF / LEGACY` | Compatibility-safe: bỏ co-staff/all-building leak; chỉ owner/shared/possession explicit theo legacy contract. Storage vẫn private/resource-linked. | Chỉ compatibility RPC/wrapper đã inventory; không thêm raw DML mới. Raw DML caller phải về 0 trước SHADOW. |
| `SHADOW / SHADOW` | Cùng safe boundary; canonical read model chạy đối chiếu, chưa là UI truth. | Writer adapters gọi canonical primitive/mirror; không còn caller direct table. |
| `CANARY / CANONICAL` cho org allowlist | CUSTODIAN/KNOWER + scoped approval/report RPC trên org canary; org khác vẫn LEGACY. | Chỉ RPC canonical, chịu finite window, operation/amount caps và release identity. |
| `ON / CANONICAL` | CUSTODIAN/KNOWER + scoped approval/report RPC. | Chỉ RPC canonical; base table DML revoked. |
| `force_freeze=true / FROZEN` | Read/reconcile an toàn. | Chặn money/access writes của feature, trừ break-glass maintenance riêng có audit. |

`force_freeze` là emergency stop **toàn feature**, không phải per-organization switch. Barrier ngắn chỉ cho DEMO/org đang backfill dùng control row riêng trong `finance_v2_backfill_runs`, được compatibility wrappers/capture guards kiểm tra; barrier này chỉ block write để chụp watermark, không quyết định LEGACY/SHADOW/CANONICAL route.

Triển khai thành hai bước:

1. **Containment/preparation:** đóng leak co-staff/building/storage và cung cấp compatibility API để app cũ không gãy.
2. **Canonical enforcement/ACL drain:** chỉ sau khi binding classified, mọi caller đã chuyển và canary xanh mới revoke DML/bật role semantics mới.

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

Migration/apply contract trên repo hiện tại:

- Không dùng `supabase db push`, `db reset` hoặc `schema_migrations` làm replay truth; live ledger đang dừng ở `20260716170000` dù catalog có object 20260721–22.
- Tạo riêng `scripts/validate-finance-v2-rollout.mjs`, `scripts/apply-finance-v2-rollout.mjs` và `scripts/audit-finance-v2-rollout.mjs` theo pattern Accounting hiện hữu: ordered stage manifest, SHA-256 từng file/toàn bundle, expected catalog fingerprint, dry-run, pre/post assertions, operator/maintenance-window/release identity và forward-only Management API apply.
- Không thêm Finance V2 vào `ACCOUNTING_MIGRATIONS`, không thay assertion bundle 14 file và không rerun accounting bundle cũ. Finance V2 là manifest riêng phụ thuộc vào catalog post-Accounting.
- Mỗi stage chỉ được đánh dấu applied khi cả catalog fingerprint, data invariants, route state và audit record khớp. File name/timestamp hoặc migration ledger không đủ.

Trước initial backfill phải bật private change capture, không dựa riêng vào `updated_at`:

```text
finance_v2_backfill_runs
  run_id, organization_id, source_snapshot_at, initial_watermark, applied_watermark
  final_watermark, state, write_barrier_state, barrier_token
  started_at, completed_at

finance_v2_backfill_change_log
  sequence_id, organization_id, source_table, source_pk
  operation = INSERT | UPDATE | DELETE
  source_version_or_hash, txid, changed_at, applied_run_id, applied_at
```

- Trigger capture được cài trong schema inert trước khi chụp snapshot đầu tiên cho voucher/items/accounts/sharing/evidence, `payments`, V5 collections/tenders/allocations, flow ownership và các source writer liên quan.
- Log phải có tombstone cho DELETE, tenant/source key và thứ tự đơn điệu; client không đọc/ghi được.
- Nếu bảng nguồn không thể gắn capture an toàn, organization phải ở org-scoped backfill write barrier suốt initial scan + delta drain; nếu wrapper/trigger chưa thể bảo đảm barrier thì emergency `force_freeze` toàn feature. Không chấp nhận “backfill nhanh rồi hy vọng không có write”.

### 10.1. Backfill voucher/posting

One-cash-effect rule cho V5:

- `payment_collection_id` và `invoice_payment_tenders.voucher_id` được phân loại trước `payment_id` hoặc voucher APPROVED.
- Mỗi tender voucher sinh đúng một posting lineage với provenance `(collection_id, tender_id, voucher_id)`. Collection event, payment row và mirror voucher là ba biểu diễn của cùng một cash event, không phải ba nguồn độc lập.
- Collection reversal tạo REVERSAL liên kết posting tender gốc; reversal expense voucher chỉ là compatibility projection, không tạo cash effect thứ hai.
- `payment_receipt_events` sau cutover phải là projection từ posting hoặc metric receipt độc lập. Không UNION collection/payment/voucher để cộng thêm cash.
- Backfill/tie-out bắt buộc unique theo collection/tender và đối chiếu gross/retained/applied/change/rounding theo V5 allocation.

Thứ tự suy nguồn:

1. Row có `posting_id` chỉ được coi là canonical khi id đó tham chiếu một posting event Finance V2 thực và toàn bộ provenance/lines nhất quán; compatibility stamp hiện hữu một mình không đủ.
2. Voucher thuộc Invoice Collection V5: derive từ collection + tender + allocation, không từ mirror status.
3. Phiếu Thu legacy có `payment_id`: chỉ dùng payment date/account/receipt khi canonical receipt semantics chứng minh `received_amount/retained_amount > 0` và row không thuộc V5.
4. Termination/trusted non-cash payment có `received_amount=0` hoặc cash components zero: `NON_CASH + NOT_APPLICABLE`, dù payment amount vẫn dùng settle A/R.
5. Voucher legacy `APPROVED`, account thật, không hủy: dùng `voucher_date` và actor/timestamp lịch sử nếu chắc chắn là cash effect.
6. Internal/virtual/non-cash khác: phân loại `NON_CASH + NOT_APPLICABLE`, không tạo cash posting.
7. Mâu thuẫn hoặc thiếu nguồn: ghi exception, không đoán.

Backfill maker/birth provenance chạy độc lập với business owner:

- `maker_user_id/maker_membership_id` chỉ derive từ immutable created-by/audit/request/actor evidence; không copy `income_expenses.user_id` theo heuristic. Nhiều candidate, thiếu membership hoặc cross-org vào exception và KNOWER/maker-withdraw fail closed;
- pending legacy đủ provenance được gắn một `LEGACY_BACKFILL_BIRTH` operation đã completed trong transaction backfill trước, cùng source hash/version; không giả XID của transaction lịch sử. Approval chỉ mở sau một transaction khác và sau khi exception bằng 0;
- voucher actual-cash/approved lịch sử giữ provenance kind riêng, không được backfill thành human maker-withdrawable hoặc obligation birth chỉ để qua guard.

Mỗi posting backfill phải sinh signed lines MAIN/CHANGE/ROUNDING đúng công thức legacy để balance khớp tuyệt đối.

Backfill lịch sử không bắt tạo ảnh giả. Dùng waiver có audit `PRE_V2_HISTORY` và chỉ cho row trước cutover.

### 10.2. Backfill quyền sổ

- `accounts.user_id` hiện tại và possession `CUSTODIAN` chắc chắn → candidate CUSTODIAN.
- possession được auto-seed kiểu “owner mọi sổ” và `account_shared_users` → candidate cần phân loại, không tự nâng.
- 32 CUSTODIAN live hiện tại là input cần verify theo từng sổ, không phải bằng chứng mọi quyền đúng; 0 OPERATOR chỉ là snapshot và phải assert lại ở preflight.
- User/org/account không khớp → exception.
- Assignment hợp lệ thiếu open role binding, binding lệch role/org, thiếu INSERT materialization hoặc override parity đều vào authorization exception; không bật access feature chỉ vì UPDATE regrant trigger đã tồn tại.
- Quản trị viên phải xác nhận 100% binding trước cutover.
- Migration report ghi nguồn, quyết định, actor và thời điểm.

Characterization/repair RBAC phải bao phủ assignment INSERT, UPDATE role/scope/permissions, DELETE/offboarding, history backfill, `member_permission_overrides` parity và `authorization_version` invalidation. Mọi repair là forward-only, có before/after fingerprint; không tự cấp rộng để “làm test xanh”.

Organization id phải derive từ account/building/authoritative parent. Row mơ hồ vào exception; không fallback về organization PROD sentinel.

Attachment backfill parse object thành liên kết `(bucket, object_name, organization_id, voucher_id/posting_id)`. Object duplicate, cross-org hoặc không parse được vào exception và chỉ uploader/service role được đọc cho tới khi xử lý.

### 10.3. Delta catch-up và high-watermark

Backfill phải repeatable/upsert đối với projection mutable, nhưng tuyệt đối không UPDATE/DELETE posting event đã sinh. Có phase bắt kịp write đang chạy:

1. Chạy initial backfill từ consistent snapshot, lưu `initial_watermark`.
2. Deploy RPC/adapters feature-off; legacy write vẫn được trigger ghi vào change log.
3. Replay INSERT/UPDATE/DELETE idempotently theo `sequence_id` tới watermark; mỗi batch lưu `applied_watermark` và chạy parity.
4. Trước bật SHADOW, đặt DEMO vào org-scoped write barrier ngắn, chụp `final_watermark`, drain đến đúng watermark, xác nhận zero unapplied/tombstone/exception rồi mới mở barrier và bật SHADOW.
5. Trong SHADOW, adapters dual-write/mirror và change-log lag phải luôn về zero; mọi bypass chỉ ghi legacy vẫn được delta worker bắt và báo alert.
6. Ngay trước CANONICAL cutover production, lặp lại `org write barrier → final watermark → drain → reconcile → CAS mode → mở barrier`; không dùng kết quả initial backfill cũ làm cutover truth.

Gate bắt buộc lưu source count/SUM/hash tại cùng snapshot với applied watermark. Delta replay cùng source version nhưng payload khác hoặc missing tombstone phải fail và vào exception, không last-write-wins âm thầm.

Contract xử lý source đã có shadow posting:

- UPDATE chỉ đổi note/metadata không ảnh hưởng cash semantics: cập nhật projection/header được phép, không chạm event/lines.
- UPDATE amount/type/account/change/rounding/posted date/status làm đổi cash effect và có thể project chắc chắn: trong một transaction khóa voucher, append REVERSAL cho active generation, append replacement POSTING generation mới với `source_kind='LEGACY_DELTA_REPLACEMENT'`, cập nhật active pointer/header mirror và đánh dấu change-log row applied.
- DELETE/cancel của row đã có cash effect: không hard-delete voucher và không chuyển thẳng `CANCELLED`. Compatibility delete guard set `income_expenses.deleted_at`, ghi source hash vào private change-log, append REVERSAL để thành `APPROVED + REVERSED`; nếu nghĩa vụ KQKD cũng bị hủy thì dùng open-period removal/recognition adjustment riêng. Row chưa từng post mới có thể thành `CANCELLED` với terminal state theo posting mode (`UNPOSTED` hoặc `NOT_APPLICABLE`).
- Backfill migration phải cài delete guard trước khi tạo shadow posting đầu tiên. DELETE row chưa có event có thể thành tombstone-only; DELETE row đã được event tham chiếu mà bypass guard phải fail bởi FK/trigger, không cascade.
- Nếu không suy ra chắc chắn old/new cash projection, kỳ sổ bị khóa, source version nhảy cóc hoặc replacement vi phạm constraint thì ghi mandatory exception, giữ unapplied log và force-freeze feature liên quan; không sửa event cũ để ép parity.
- CANONICAL cutover bị chặn nếu còn active `LEGACY_BACKFILL/LEGACY_DELTA_REPLACEMENT` generation không khớp source hash cuối hoặc còn hard-delete exception.

Compatibility read semantics cho tombstone:

- mọi list/stats/export và legacy compatibility view/RPC ở `LEGACY`, `SHADOW`, `CANONICAL` mặc định thêm `income_expenses.deleted_at IS NULL`; RLS/read adapter phải áp cùng predicate, không chỉ ẩn ở UI;
- legacy balance/cash report trong SHADOW phải loại tombstoned source theo hành vi delete cũ, còn V2 balance lấy reversal lines; hai phía phải tie-out về cùng net effect;
- audit/reversal history vẫn đọc được qua detail/history RPC riêng với capability `finance.audit` hoặc quyền reversal, hiển thị marker/source hash nhưng không đưa row trở lại totals;
- P&L delete ở kỳ mở phải void base recognition trong cùng guard; kỳ khóa giữ snapshot và tạo adjustment. Nếu không xác định delete có nghĩa “void obligation” hay chỉ lỗi nguồn, vào exception và force-freeze profit feature;
- direct legacy query/function nào không thể thêm tombstone predicate phải được bọc/replaced trước initial delete guard; không để app cũ hiển thị lại row vừa xóa.

### 10.4. Shadow/canary trên control plane hiện hữu

Không tạo `finance_v2_org_config`. Đăng ký các feature key trên `app_private.server_feature_flags`, tối thiểu:

```text
income_expense.workflow.v2
income_expense.posting.v2
cashbook.access.v2
income_expense.profit_close.v2
income_expense.read_semantics.v2
contract.commission.settlement.v2
salary.settlement.v2
```

Mode lưu là `OFF/SHADOW/CANARY/ON`; `app_private.evaluate_feature_route` trả `LEGACY/SHADOW/CANONICAL/FROZEN`. Mọi chuyển mode dùng `app_private.set_feature_route_v1` với CAS `config_version`, commit SHA, migration digest, maintenance window, approval reference, canary enrollment/caps và audit hiện có.

Mọi **canonical mutation** ở CANARY phải claim một `operation_key` qua `app_private.claim_feature_operation_v1` trong cùng transaction để `max_operation_count` luôn tiến, không chỉ money writer. Create/approve/request-changes/reject/withdraw/resubmit/access mutation/close dùng amount `0`; posting/reversal và money writer dùng canonical absolute amount để chịu cả count cap lẫn amount caps. Read-only RPC không claim. Không caller nào được tự đọc count rồi tự quyết định vượt cap.

Runbook gate không đủ để fail closed. Migration Finance V2 phải cài `app_private.assert_finance_v2_feature_activation_v1` và BEFORE trigger trên `app_private.server_feature_flags` cho toàn bộ Finance key ở trên. Guard hiện hữu `assert_accounting_feature_activation_v1` bỏ qua key ngoài allowlist Accounting, nên không được coi là bảo vệ Finance V2.

Phải cài thêm `app_private.assert_finance_v2_canary_enrollment_v1` và BEFORE INSERT/UPDATE trigger trên `app_private.server_feature_flag_canary_orgs`. Guard Accounting hiện hữu trên bảng enrollment cũng bỏ qua Finance key, nên chỉ bảo vệ mode mà không bảo vệ việc thêm org canary là chưa đủ.

Mọi INSERT/UPDATE trực tiếp hoặc `set_feature_route_v1` chuyển Finance key sang `CANARY/ON` phải bị trigger từ chối nếu thiếu feature-specific activation attestation:

- manifest digest/catalog fingerprint/release identity không khớp;
- dependency feature route chưa hợp lệ;
- còn backfill exception, unresolved binding/voucher, unapplied delta hoặc org barrier;
- direct-DML/fallback caller count chưa bằng 0, RLS/storage/view gate chưa xanh;
- posting/V5 balance parity hoặc evidence/source-lineage gate chưa xanh;
- profit key còn pending locked-period chưa disposition, unsafe locks, hash dispatcher/payout reservation gate chưa xanh.
- commission/salary key thiếu `finance_business_policy_decisions` đúng organization/policy version, decision payload/hash chưa được chủ dự án phê duyệt hoặc writer/source snapshot không stamp cùng version.

Attestation là private, immutable theo `(feature_key, config_version, organization_id nullable)` và lưu snapshot hash/counter của từng gate:

- row `organization_id IS NULL` bảo vệ chuyển mode CANARY/ON ở cấp feature;
- row có organization bảo vệ enrollment chính org đó, gồm org membership/binding exceptions, barrier/delta watermark, RLS/storage, writer drain, balance/P&L/V5 parity và profit gates liên quan;
- mọi INSERT/UPDATE Finance enrollment phải lock feature config rồi verify org attestation cùng config version/release digest, kể cả khi parent còn OFF/SHADOW; không cho pre-enroll bẩn chờ mode đổi. Đổi `feature_key` hoặc `organization_id` cũng recheck; direct table DML không bypass;
- feature guard khi chuyển sang CANARY hoặc đổi config version trong CANARY phải lock/scan toàn bộ org đã enroll và re-verify org attestation theo **target** config version trước commit; attestation cũ không được tái dùng;
- DELETE enrollment được phép để giảm blast radius nhưng phải audit; thêm lại vẫn cần attestation mới nếu config version đã đổi.

`app_private.finance_business_policy_decisions` là authority riêng cho quyết định §2.6, không phải feature flag thứ hai: immutable theo `(organization_id, policy_key, policy_version)`, payload JSON đã validate, approved_by/approved_at và content hash. Commission/salary writer phải lock/read exact decision row và stamp policy version vào source/bundle. Hai feature key domain có thể giữ OFF trong khi workflow/posting/read-safety chung CANARY/ON; sau caller drain, source UI/RPC trả “Chính sách chưa được chốt” và không chạy legacy fallback.

`force_freeze=true` luôn được phép để emergency stop; OFF/SHADOW không được nâng thành CANARY/ON và org không được enroll bằng bypass maintenance SQL nếu guard chưa pass.

Coordinator rollout phải khóa/cập nhật feature theo thứ tự cố định và kiểm dependency trước commit. `workflow/posting/access` là một **activation cohort**: thêm `app_private.set_finance_feature_cohort_v2` làm wrapper CAS nguyên tử trên chính `server_feature_flags`/enrollment hiện hữu, lock ba config theo thứ tự cố định, validate cùng release/config target rồi commit hoặc rollback cả ba. Đây không phải control plane thứ hai; direct single-key CANARY/ON cho một member cohort phải bị BEFORE guard từ chối.

- `income_expense.read_semantics.v2` phải CANARY/ON trước mọi V2 workflow write: balance/cash read chuyển sang posting state và P&L compatibility resolver đã thấy pending obligation + counter/blocker. Đây là read-safety gate, không được để workflow chạy trước rồi sửa báo cáo sau;
- cohort canonical cần schema/approval compatibility, read-safety canonical, cashbook bindings/evidence, zero-lag posting backfill và caller drain. Không tồn tại trạng thái workflow canonical nhưng posting/access/read cash còn legacy, hoặc posting canonical nhưng approval/access chưa sẵn sàng;
- V5 adapter có thể mirror posting ở SHADOW trước cohort, nhưng không được nhận posting mirror làm production truth trước read-safety và cohort activation;
- V5 collection/reverse đang ON phải tiếp tục hoạt động; adapter posting chỉ bật khi cả V5 route tương ứng và posting route đều an toàn, không tạo writer cạnh tranh;
- trước V2 workflow write đầu tiên, mọi close RPC legacy/V2 phải gọi `app_private.assert_finance_close_safe_v2`: nếu read-safety/P&L resolver chưa CANONICAL thì `income_expense.profit_close.v2` ở `FROZEN` và close bị chặn, không dùng SHADOW như một lựa chọn mở khóa. Chỉ sau khi pending locked-period, unsafe locks và hash-version gates sạch mới cho CANARY/ON;
- bất kỳ dependency trả `FROZEN` phải fail closed. Trạng thái vận hành tương đương “PAUSED” được thực thi bằng `force_freeze=true`, không bằng config table thứ hai.

V5 adapter theo effective posting route:

| Posting route | Hành vi `record/reverse_invoice_collection_v5` |
|---|---|
| `LEGACY` | Giữ writer hiện hữu và change-capture; Finance posting chưa là truth. |
| `SHADOW` | Collection/tender/payment/voucher vẫn commit như hiện tại và mirror posting/evidence trong cùng transaction để reconcile; UI/balance chưa đọc mirror. |
| `CANONICAL` | Posting/evidence cho từng tender là bắt buộc trong cùng transaction; adapter lỗi thì rollback toàn bộ collection/reversal. |
| `FROZEN` | Fail trước khi tạo collection/payment/voucher mới; read/reconcile vẫn hoạt động. |

Tạo private append-only `finance_v2_semantic_event_log` với organization, event kind, source table/id, source kind `BACKFILL|V2_WRITE`, actor, transaction/trace, created_at. Mọi primitive V2 append event trong cùng transaction; rollout checkpoint lưu baseline sequence để rollback gate phân biệt mirror backfill với semantic write thật. Client không có SELECT/DML.

Trong SHADOW:

- không hiển thị posting canonical như production truth;
- tính song song balance cũ/mới theo sổ và tháng;
- so P&L cũ/mới;
- đếm unresolved voucher/binding;
- log writer nào còn bypass;
- chỉ chuyển CANARY/ON khi mọi gate bằng 0/khớp tuyệt đối.

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
- rollback/FROZEN đã diễn tập.

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
- V5 collection/payment/tender/voucher mirror chỉ là provenance/projection; cash aggregate không SUM thêm các bảng đó ngoài posting lines;
- thời gian báo cáo dùng `posted_on` của từng event;
- không lọc bằng `approval_status`;
- replacement view chạy `security_invoker=true`, revoke `ALL` cũ và chỉ grant SELECT tối thiểu qua scoped API/view.

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

Tạo một resolver canonical duy nhất, ví dụ `app_private.effective_profit_contributions_v2`, trả mỗi contribution cùng nguồn workflow của nó:

```text
organization_id, target_period
contribution_kind = BASE_ALLOCATION | RECOGNITION_ADJUSTMENT
contribution_id, source_voucher_id
source_approval_status, source_review_state, source_version
signed_kqkd_amount, allocation_snapshot, source_payload_hash
```

- `BASE_ALLOCATION` lấy `target_period` từ allocation period và chỉ sinh row khi voucher `recognition_source_mode='BASE'`;
- `RECOGNITION_ADJUSTMENT` lấy `target_period=adjustment_period`, amount/allocation từ adjustment immutable và vẫn mang `source_voucher_id` cùng approval/review state hiện tại để close biết contribution đó còn pending hay đã duyệt;
- voucher `ADJUSTMENT_ONLY` không có base row. Positive late-recognition adjustment của nó là contribution duy nhất ở kỳ mở, nên nếu voucher còn `UNAPPROVED` thì chính kỳ `adjustment_period` bị block;
- report P&L, pending/approved-unposted counter, close preview/core, blocker drill-down và source hash phải cùng đọc resolver này. Không module nào được tự suy target period từ `recognition_date` hoặc chỉ từ allocation header;
- counter hiển thị `COUNT(DISTINCT source_voucher_id)` theo target period; amount SUM canonical signed contribution của cùng source set, không đếm một voucher nhiều lần chỉ vì có nhiều allocation row. Drill-down group theo voucher nhưng giữ child contribution ids để đối soát;
- close transaction lock/recheck voucher version và adjustment/source set tương ứng với resolver snapshot; snapshot đã khóa persist resolved state/version để verification không phụ thuộc header tương lai.

Trong đó:

- bỏ điều kiện `approval_status='APPROVED'` làm gate nhận diện KQKD;
- giữ item classes canonical đã land: `PNL`, `DEPOSIT`, `CUSTOMER_CREDIT`, `INTERNAL`. `kqkd_amount` chỉ là tổng phần PNL được server recompute; không lấy `total_amount` hoặc biến deposit/credit/internal thành lợi nhuận;
- giữ provenance/allocation của Invoice Collection V5. Approval/posting transition không được recompute hoặc làm mất `invoice_payment_allocations` lineage;
- base query chỉ lấy `counts_in_business_result=true AND recognition_source_mode='BASE'`; `ADJUSTMENT_ONLY` luôn đóng góp zero từ header;
- với kỳ mở, `CANCELLED`/`WITHDRAWN_BY_MAKER` trước close bị loại khỏi base; với kỳ đã khóa, report không recompute từ trạng thái header hiện tại mà đọc immutable close snapshot;
- dùng `kqkd_amount`, item allocation/billing month và `recognition_date` cho base; adjustment dùng server-owned signed delta/allocation snapshot;
- bao gồm cả Chờ duyệt hợp lệ và Approved, không cộng lại khi approve hoặc post;
- cancel/correction sau close giữ nguyên base lịch sử và tạo delta adjustment ở kỳ mở; late voucher chọn `ADJUSTMENT_ONLY` nên không thể vừa vào base vừa vào catch-up;
- báo cáo nhiều kỳ/toàn timeline phải ghép canonical result của từng kỳ, không chạy một filter `NOT CANCELLED` trên header hiện tại;
- close source hash Finance V2 gồm algorithm version, item class, effective contribution id/kind/target period, source voucher id/version/state/mode/allocation, V5 lineage, blocker set và adjustment payload hash; verification đối chiếu cả tổng từng kỳ lẫn tổng toàn timeline để bắt drop/double-count;
- trả metadata/counter theo approval/posting để UI gắn nhãn.

Không đổi nghĩa `current_profit_building_source_hash_v1` cho snapshot lịch sử. Tạo hash algorithm/version mới cho Finance V2 và dispatcher freshness theo `profit_close_runs.source_snapshot.algorithm_version`:

- mọi `CLOSE` hoặc `RECLOSE` **được tạo sau thời điểm `income_expense.profit_close.v2` activation** phải stamp và dùng algorithm Finance V2, kể cả initial close hoàn toàn mới;
- chỉ snapshot đã persist `algorithm_version='profit-close-v2.1'` trước activation tiếp tục được verify bằng v1;
- reopen/reclose sau activation tạo revision/snapshot mới bằng algorithm Finance V2; revision lịch sử cũ vẫn verify bằng version đã persist;
- dispatcher chọn verifier theo algorithm version của từng snapshot, không theo trạng thái hiện tại của feature hoặc loại thao tác close/reclose.

Giữ nguyên CAS, revision/reclose, unallocated integrity và payout freshness hiện hữu; mở rộng reservation theo §6.7, source set/blocker và không reset lịch sử hoặc làm payout cũ stale hàng loạt.

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
unsnapshotted_salary_earning_count
unsnapshotted_salary_earning_amount
blocking_voucher_ids hoặc drill-down token an toàn
```

Gate chặn được tính trên **effective contribution của kỳ đang chốt**, không chỉ trên allocation period của voucher:

```text
effective_contribution.target_period = kỳ đang chốt
AND effective_contribution.signed_kqkd_amount <> 0
AND source_voucher.approval_status = UNAPPROVED
AND source_voucher chưa CANCELLED
```

Áp dụng đồng nhất cho `BASE_ALLOCATION` và `RECOGNITION_ADJUSTMENT`. Vì vậy pending `ADJUSTMENT_ONLY` có positive adjustment ở kỳ mở sẽ block close kỳ mở đó; nó không lọt gate chỉ vì natural/base period đã khóa.

`APPROVED + UNPOSTED` là informational warning, không block.

`CHANGES_REQUESTED` và `DISPUTED` vẫn là blocker có owner/reason/deadline; `CANCELLED` không block và recognition đã được loại/điều chỉnh đúng quy trình.

Job/commission earning theo payroll chưa được salary bundle snapshot là blocker dữ liệu nguồn, không phải approved-unposted warning. Drill-down phải dẫn tới màn chốt/materialize lương; khi bundle birth pending, contribution chuyển sang parent voucher đúng một lần và blocker nguồn biến mất trong cùng transaction.

Preview, source hash và insert snapshot phải lock/recheck cùng source trong transaction hoặc CAS; không để voucher pending phát sinh đồng thời lọt qua.

Activation gate riêng của profit feature:

- remediation toàn bộ pending thuộc kỳ khóa đã có disposition hash-lock;
- audit 52 unsafe locks hiện tại về 0 hoặc có approved repair/reclose result;
- old/new hash dispatcher và payout freshness tests xanh;
- read-semantics + pending blocker phải CANONICAL trước workflow write đầu tiên. Workflow/posting/access cohort chỉ được CANARY/ON khi `income_expense.profit_close.v2` đang `FROZEN` và **mọi** close v1/v2 bị `assert_finance_close_safe_v2` chặn, hoặc profit-close đã CANARY/ON với các gate trên xanh; SHADOW không đủ để bảo vệ close.

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
| `APPROVED + UNPOSTED + execution=UNASSIGNED` | Đã Duyệt - Chưa Chi · Chờ phân sổ | Đã Duyệt - Chưa Thu · Chờ phân sổ |
| `APPROVED + NON_CASH + NOT_APPLICABLE` | Đã ghi nhận - Không qua sổ | Đã ghi nhận - Không qua sổ |
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
- approved-unposted chưa account chỉ hiện cho CUSTODIAN khi execution candidate/assignment chứa exact sổ họ giữ; row không candidate vào tab **Chờ phân sổ** chỉ cho assigner. Claim/reassign có revision, không biến thành balance;
- posted không cho full edit/quick-edit account/evidence;
- reversed/cancelled không được thao tác như active;
- stats Thu/Chi chỉ tổng posting active;
- hiển thị riêng Chờ duyệt và Đã Duyệt - Chưa Thu/Chi;
- termination forfeit revenue/offset hiển thị cùng pair badge/linkage và một pair action; không cho approve/post từng leg hoặc mở Posting dialog vì đây là NON_CASH;
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

Số tiền read-only bằng total đã duyệt, ngoại trừ MULTI_TRANCHE salary cho nhập tối đa remaining authorized amount. Cashbook options chỉ lấy từ execution candidates/assignment mà actor đang là CUSTODIAN; nếu actor có assign capability, chọn sổ sẽ CAS assign trong cùng post transaction. Dialog nhận `mode='POST_APPROVED' | 'APPROVE_AND_POST'`, capability, execution/approval/posting versions và idempotency key. Cùng component được dùng ở page Thu Chi và Approval inbox.

### 12.4. Approval inbox

Sửa:

- `src/hooks/useApprovals.ts`;
- `src/pages/approvals/ApprovalsPage.tsx`.

Yêu cầu:

- Approve-only không invalidate balance như một cash event;
- nút Duyệt mở lựa chọn Duyệt hoặc Thu/Chi;
- Thu/Chi chỉ enable nếu capability server trả về cho biết actor vừa approver vừa CUSTODIAN;
- voucher accountless chỉ cho Duyệt và Thu/Chi nếu server trả exact assignable/candidate cashbooks; approve-only vẫn tạo/giữ execution queue, không làm payable biến mất khi request terminal;
- approver không giữ sổ chỉ thấy Duyệt;
- inbox không mở quyền xem toàn bộ lịch sử sổ;
- request version/idempotency được truyền vào RPC.
- action Yêu cầu bổ sung/Từ chối phải bắt reason và chọn outcome hợp lệ: CHANGES_REQUESTED, DISPUTED hoặc CANCELLED-invalid; không đóng request mơ hồ.
- `TERMINATION_FORFEIT_PAIR` chỉ hiện một inbox row cho cả hai leg, chỉ có pair approve/cancel theo capability; không hiện lựa chọn Thu/Chi và không tạo request phụ cho offset leg.
- `TERMINATION_MOVE_OUT_PAIR` cũng chỉ hiện một inbox row cho revenue/offset + tổng planned CT settlement; approve/cancel pair, không hiện Thu/Chi. Phiếu `termination.refund` của cùng lần thanh lý là row riêng và vẫn có Duyệt/Duyệt và Chi.

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

Mở form/detail quản trị phải gọi `get_cashbook_access_admin_v2(cashbookId)` để lấy current revision, hai danh sách đang gán và eligible active memberships với safe fields; không đọc `cashbook_possession_bindings`/history trực tiếp. Save gọi `set_cashbook_access_v2` CAS nguyên tử bằng revision vừa đọc, không sync `account_shared_users` trực tiếp. UI ẩn/disable edit/share/lock/delete theo capability server; deep-link sang Thu Chi vẫn chịu RLS, không tin filter URL.

### 12.6. Account selector theo intent

- Form Phiếu thu: danh sách CUSTODIAN + KNOWER.
- Form Phiếu chi: chỉ CUSTODIAN hoặc account gợi ý do workflow nhưng post vẫn recheck CUSTODIAN.
- Posting dialog: chỉ cashbook actor đang là CUSTODIAN.
- Balance/list quản trị: chỉ shape có quyền xem balance.
- Không dùng `useAccounts()` chung trả toàn bộ cột cho mọi màn.

### 12.7. Màn hình nguồn hợp đồng, thanh lý, hoa hồng và lương

Các màn nguồn chỉ **khai sinh nghĩa vụ**; không được tự đóng vai Approval inbox hoặc Posting dialog:

- màn tạo hợp đồng: tiền cọc chỉ được hiển thị “Đã thu” khi dedicated receipt writer đã tạo active posting với ngày/sổ/evidence hoặc system reference hợp lệ. Nếu chưa nhận thật thì giữ receipt intent/công nợ, không tạo APPROVED giả; shortfall/debt preview dùng cùng active-posting truth;
- `CommissionVoucherModal.tsx`: đổi banner “Đã chi” thành label theo combined state; bỏ “nháp”, bỏ `useAccounts()`/Sổ quỹ và “Ngày chi” khỏi form tạo nguồn. Hiển thị ngày ghi nhận nghĩa vụ, recipient/bank metadata và settlement mode do server trả về. `STANDALONE` tạo Phiếu Chờ duyệt; `PAYROLL` chỉ ghi earning chờ kỳ lương. Một source/voucher tồn tại chưa đồng nghĩa đã chi;
- `PeriodCommissionModal.tsx` + `usePeriodFees.ts` + `get_period_commissions`: bỏ `unpaid|draft|paid` và hai nút “Lưu nháp”/“Chi & duyệt”. `STANDALONE` chỉ có “Tạo phiếu Chờ duyệt”; row pending/approved-unposted dẫn sang Thu Chi hoặc Approval inbox, row posted mới là “Đã chi”. `PAYROLL` hiển thị Earning/Đã đưa vào kỳ lương/Đã trả qua lương và không có action post riêng;
- `RecordRefundDialog.tsx` + `useInvoicePayments.ts`: source form chỉ nhận lý do/số tiền trong refundable cap, không nhận ngày hoàn/sổ/ảnh. Submit một RPC atomic tạo `INVOICE_REFUND_OBLIGATION` Chờ duyệt; UI invoice hiển thị tách “Chờ duyệt/Đã duyệt - Chưa hoàn/Đã hoàn”, không coi APPROVED là đã refund;
- `TerminateDialog.tsx`: bỏ mô tả “quyết toán ngay” cho toàn flow. Confirmation phải liệt kê rõ `pair cấn trừ - Chờ duyệt`, `phiếu hoàn khách - Chờ duyệt`, `khách trả thêm - đã thu qua collection` hoặc `còn nợ`; success response trả subject/voucher ids và deep-link an toàn sang Thu Chi. Nếu forfeit trả `credit.deferred=true`, phải cảnh báo số tiền dư còn treo, trả remediation id/status và không hiển thị đã hoàn/cấn trừ;
- `useContractOperations.ts`: domain success toast không được nói voucher đã vào doanh thu/đã chi chỉ từ status contract. Forfeit/move-out pair dùng một pair subject; refund là voucher riêng. Contract termination vẫn có audit domain riêng nhưng không cấp Finance approval;
- màn lương: “Chốt lương” chỉ LOCK exact earning ids/hash; không duyệt phiếu hoa hồng. “Tạo quyết toán lương” chỉ tạo salary bundle Chờ duyệt, hiển thị riêng gross/advance/rent planned/cash due và policy ONE_SHOT/MULTI_TRANCHE; không tăng `salary_monthly.paid`, không tạo receipt/payment rent-offset và không gọi approve ngay. Manager salary form và bulk flow không hỏi sổ/ngày/ảnh; bulk trả result từng staff. Posting dialog ONE_SHOT không cho sửa amount; MULTI_TRANCHE cho nhập amount tối đa số còn lại. Badge tiền đã trả đọc active posting/tranche/reversal, không đọc `payout_voucher_id` hoặc existence;
- màn job/thưởng: hoàn tất job hoặc `award_job_bonus` chỉ xác nhận immutable earning ledger; không tạo voucher khi complete/lock và không có action source-level “Duyệt/Chi ngay”. Salary detail phải drill-down exact JOB/DAY_BONUS source ids đã consume.

Mọi source screen phải dùng server response state/capability, không tự suy từ `approval_status`, `account_id`, voucher existence hoặc label cũ. Desktop/mobile/toast/email/deep-link dùng cùng canonical Vietnamese.

### 12.8. Quick edit và sửa sai

- Pending: chỉ sửa các field được phép, giữ audit/version.
- Approved-unposted: khóa amount, kỳ KQKD và classification; chỉ posting dialog bổ sung metadata tiền.
- Posted: không sửa account/date/evidence/amount trực tiếp.
- Sai sau posting: dùng reversal + phiếu thay thế.

## 13. Chuỗi migration/release đề xuất

Không sửa migration lịch sử. Tạo replacement migrations theo thứ tự:

1. `*_finance_v2_semantics_snapshot.sql`
   - snapshot catalog/policy/writer/consumer, migration-ledger divergence, RBAC exceptions và assertions baseline; output fingerprint phải khớp manifest apply.
2. `*_finance_v2_schema_inert_and_activation_guard.sql`
   - trong cùng transaction: seed toàn bộ Finance/domain/read-safety feature keys ở `OFF`, tạo private global/org activation + business-policy attestation, cohort CAS, `assert_finance_v2_feature_activation_v1`, `assert_finance_v2_canary_enrollment_v1` và BEFORE triggers trên cả `server_feature_flags` lẫn `server_feature_flag_canary_orgs`; sau đó tạo posting/lines/evidence/CAS/recognition-adjustment, maker/birth provenance, salary bundle/authorization/tranche tables, mở rộng possession kinds, `canonical_write_operations`, approval compatibility và profit reservation lifecycle; audit + semantic-event log, private backfill run/change-log + capture triggers, header columns nullable, indexes/FK/constraints NOT VALID. Không để tồn tại cửa sổ feature/enrollment chưa được server guard bảo vệ.
3. `*_finance_v2_containment.sql`
   - đóng co-staff/all-building/storage leak; tạo approval inbox/detail compatibility-scoped và revoke approval base-table SELECT ngay; chưa revoke money caller legacy chưa chuyển.
4. `*_finance_v2_backfill.sql`
   - consistent initial snapshot, initial watermark, backfill V5-aware posting/recognition/access candidates, pending locked-period queue, RBAC repair candidates và exception tables.
5. `*_finance_v2_writers.sql`
   - private primitives/public RPC, committed birth-XID guard, maker identity, reject/resubmit, canonical idempotency, locks, approval-only semantics và global close-safety guard trên mọi close entrypoint.
6. `*_finance_v2_system_writer_adapters.sql`
   - V5 collection/reversal (gồm change-only tender), contract, recurring/batch/import/payment/credit/utility/salary/profit/handover/termination/Copilot adapters và compatibility wrappers; commission settlement-mode writer, move-out planned-settlement pair, invoice/termination refund pending, deferred-credit resolver, salary bundle/rent-offset staging và forfeit forward-fix/one-request linkage phải land trước khi generic approval V2 bật.
7. `*_finance_v2_caller_drain_acl.sql`
   - chuyển caller cuối, fail test nếu legacy fallback chạy, revoke direct DML/base-table access và drop broad money policies; bước này phải hoàn tất trước SHADOW.
8. `*_finance_v2_delta_catchup.sql`
   - repeatable change-log replay, delete tombstones, applied/final watermark assertions và zero-lag gate; chạy lại trước mỗi mode change.
9. `*_finance_v2_shadow_reconcile.sql`
   - shadow views/RPC, parity report và bypass/delta-lag monitoring.
10. `*_finance_v2_read_models.sql`
   - balance/cash reports/P&L/close/read stats, hash dispatcher versioned và V5 projection/no-double-count guards.
11. `*_finance_v2_rls_canary.sql`
   - deploy mode-aware safe policies/read RPCs, private storage và validate bindings; chạy SHADOW/CANARY DEMO tests.
12. `*_finance_v2_cutover_readiness.sql`
   - validate constraints/defaults/not-null có thể áp an toàn dưới mode-aware compatibility, set birth default `UNAPPROVED` sau khi mọi writer đã explicit state, cài readiness assertions và vô hiệu hóa bypass v1 đã drain. Migration này **không** đổi mode hoặc enroll org.
13. `*_finance_v2_contract_cleanup.sql` — release sau, không cùng đợt đầu.

Mode transition `OFF -> SHADOW -> CANARY -> ON`, canary enrollment/remove, activation cohort và `force_freeze` là operational CAS steps có approval reference/audit riêng do `apply-finance-v2-rollout.mjs` thực hiện sau khi stage manifest đã apply. Chúng không nằm trong forward-only migration manifest. Read-semantics phải đi trước; workflow/posting/access chuyển cohort atomic. Profit-close được phép CANARY/ON sau cohort **chỉ** khi mọi close path đang FROZEN bởi server guard trong khoảng chờ, không được để legacy close tiếp tục chạy.

Mỗi migration phải có:

- precondition/assertion rõ;
- idempotent guard hợp lý;
- comments ghi semantics;
- revoke/grant explicit;
- rollback/forward-fix note;
- test static và test DB tương ứng.

Các stage trên được apply bằng Finance V2 manifest/script riêng qua Management API, không bằng CI auto-push và không ghép vào Accounting 14-file bundle.

## 14. Critical files và ownership đề xuất

### 14.1. Database/authz

| Nhóm | File/symbol cần đọc hoặc replacement |
|---|---|
| Approval schema/engine | `supabase/migrations/20260713130000_sprint4a_approval_engine_schema.sql`, `20260713130200_sprint4c_approval_rpcs.sql`, `scripts/authz-prepared/prod-snapshot/PS01_engine_approval_v2.sql` |
| Create/approve lifecycle | `scripts/authz-prepared/t5_08_ie_lifecycle_writers.sql`, `t5_21_ie_auto_approve.sql`, `t5_24_ie_birth_status_policy.sql`, `t5_26_engine_guard_inbox.sql`, `PS05_misc_remaining.sql` |
| Income expense policies | `20260702150000_rls_initplan_setbased_select.sql`, `20260703161000_ie_select_policies_setbased.sql`, `20260703170000_write_policies_setbased.sql` |
| Shared/access/RBAC | `20260516000004_account_shared_users.sql`, `20260516000005_account_shared_users_fix_recursion.sql`, `20260713120000_sprint3a_org_rollout_all_tables.sql`, `PS04_rbac_org_meter_threshold.sql`, `20260722140000_rbac_regrant_on_assignment_edit.sql` |
| Rollout/apply | `20260721070000_accounting_rollout_prerequisites.sql`, `20260721075000_accounting_canary_caps.sql`, `20260721140500_accounting_rollout_gate_v1.sql`, `scripts/apply-accounting-rollout.mjs`, `scripts/audit-accounting-rollout.mjs`, V5 activate/freeze scripts |
| Balance/view | `20260704100000_accounts_is_virtual.sql`, `20260704180000_views_security_invoker.sql`, perf/reconciliation migrations |
| Accounting semantics/V5 | `20260721080000_accounting_semantics_snapshot.sql`, `20260721090000_contract_create_v2.sql`, `20260721100000_invoice_collection_v5.sql`, `20260721102000_active_payments_reporting.sql`, `20260722120000_invoice_collection_v5_hardening.sql` |
| P&L accrual | `20260626000000_fa_accrual_pnl.sql`, `20260721080000_accounting_semantics_snapshot.sql`, KQKD item-level migrations, money aggregate RPCs |
| Profit close/payout | `20260720210000_profit_close_v2.sql`, `20260720213000_*`, `20260720215000_*`, `20260720223000_*`, `20260721110000_profit_unallocated_integrity_v3.sql`, `20260721120000_profit_payout_reservations_v2.sql` |
| Credit/termination | `20260721135000_customer_credit_application_v1.sql`, `20260721135500_termination_non_cash_payment_semantics.sql`, `20260722130000_customer_credit_apply_gate_v1.sql`, `20260722150000_fix_forfeit_guard_false_positive.sql`, `20260722160000_forfeit_defer_credit_when_writer_off.sql` |
| Recurring/system | recurring draft/rewrite migrations, invoice/payment/utility/termination/salary/profit/handover writers và `src/copilot/tools/writeTools.ts` |
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

## 15. Baseline Accounting/V5 đã land và contract tương tác

Chuỗi Accounting không còn là worktree “đang dang dở”. Bundle 14 migration được pin trong `scripts/apply-accounting-rollout.mjs` đã trở thành prerequisite catalog:

1. `20260721070000_accounting_rollout_prerequisites.sql`;
2. `20260721075000_accounting_canary_caps.sql`;
3. `20260721080000_accounting_semantics_snapshot.sql`;
4. `20260721090000_contract_create_v2.sql`;
5. `20260721100000_invoice_collection_v5.sql`;
6. `20260721102000_active_payments_reporting.sql`;
7. `20260721110000_profit_unallocated_integrity_v3.sql`;
8. `20260721120000_profit_payout_reservations_v2.sql`;
9. `20260721130000_accounting_history_repair.sql`;
10. `20260721132500_accounting_history_resolution_v1.sql`;
11. `20260721135000_customer_credit_application_v1.sql`;
12. `20260721135500_termination_non_cash_payment_semantics.sql`;
13. `20260721140500_accounting_rollout_gate_v1.sql`;
14. `20260721150500_accounting_scope_narrowing.sql`.

Post-bundle baseline cũng phải bảo toàn: `20260721140000_v5_route_planning_phase12.sql`, `20260721150000_v5_streak_recompute_alias_fix.sql`, `20260722120000_invoice_collection_v5_hardening.sql`, `20260722130000_customer_credit_apply_gate_v1.sql`, `20260722140000_rbac_regrant_on_assignment_edit.sql`, `20260722150000_fix_forfeit_guard_false_positive.sql` và `20260722160000_forfeit_defer_credit_when_writer_off.sql`. Pin file SHA/canonical function fingerprint trong Finance dependency manifest; không thêm file này vào hoặc replay Accounting 14-file bundle.

Contract tương tác bắt buộc:

- Không sửa/replay bundle 14 file để “chèn” Finance V2; dùng manifest phụ thuộc mới và catalog fingerprint.
- V5 collection/reversal tiếp tục là authority cho collection/tender/allocation/idempotency. Finance V2 posting là cash ledger được V5 adapter gọi trong cùng transaction, một lineage cho mỗi tender; không tạo collection writer cạnh tranh.
- V5 partial collection và multi-tender được giữ nguyên. Giới hạn no-partial/no-multi-cashbook chỉ áp cho một manual voucher; change-only tender dùng external tender gross, không ép gross bằng retained voucher total.
- `PNL/DEPOSIT/CUSTOMER_CREDIT/INTERNAL`, `kqkd_amount`, customer-credit lots/applications và termination non-cash là semantics đã land; Finance V2 chỉ nối workflow/posting/recognition, không tạo phân loại thay thế.
- `20260722160000` chỉ là availability fix: cho thanh lý bỏ cọc hoàn tất khi credit writer chưa CANONICAL. `deferred=true` không phải settlement; Finance V2 phải queue/reconcile khoản dư, giữ classification `CUSTOMER_CREDIT` và chỉ tạo refund cash pending hoặc non-cash apply bằng dedicated adapter sau đó.
- Termination forfeit giữ pair authority/non-cash settlement hiện hữu nhưng forward-fix guard và approval linkage: một pair request, dedicated adapter/context cho hai leg, generic per-leg approve/post bị chặn.
- Profit close giữ CAS, revision/reclose, unallocated, reservation và historical hash compatibility. Finance V2 thêm algorithm version/blocker, không overwrite v1.
- Accounting scope narrowing và RBAC regrant là prerequisite nhưng không chứng minh auth data sạch; Finance preflight vẫn phải phát hiện assignment/binding/override exception.
- `queries.ts`, `types.ts`, Thu Chi pages và payment/profit hooks phải cutover theo backend contract/versioned route; không merge UI trước schema/RPC compatibility.

## 16. Test plan bắt buộc

### 16.1. Static/migration tests

Thêm test đọc migration để khẳng định:

- có posting/evidence/CAS tables, possession extension, composite FK, active pointer/generation guard và tối đa một posting chưa reverse;
- không grant client DML lên bảng canonical;
- public RPC revoke `PUBLIC/anon` và grant đúng role;
- policy rộng cũ bị drop/rewrite;
- `accounts_with_balance` dùng posting, có `security_invoker=true`;
- approval engine không auto-post khi approve;
- approval request constraint/history hỗ trợ `APPROVED/WITHDRAWN/CHANGES_REQUESTED/DISPUTED` + outcome fields; writer mới không set `POSTED` và one-open index chỉ xét PENDING;
- mọi enum consumer của approval/profit payout đã được inventory; `profit_payout_reservations` có lifecycle `HELD/CONSUMED/RELEASED/REVERSED`, reserved amount chỉ SUM `HELD + CONSUMED` và không còn phụ thuộc request `PENDING_APPROVAL/POSTED`;
- `canonical_write_operations` giữ org/operation/subject/actor/key authority, payload-hash conflict/result snapshot/version guards và không có client access; không có dual registry;
- maker user/membership và birth operation/XID là server-owned, composite tenant-safe; transition cùng birth transaction fail và legacy ambiguous provenance vào exception;
- execution scope/candidates có tenant FK, revision/claim/idempotency và không wildcard org; approval terminal không xóa accountless payable, assign/post vẫn exact-scope;
- phase 1 chặn partial/multi-cashbook cho manual voucher, nhưng V5 partial invoice/multi-tender phải tách tender voucher/posting và không regression; V5 posting dùng tender gross + retained snapshot, kể cả change-only voucher total bằng zero. Nếu decision chọn MULTI_TRANCHE salary, tranche subject/ceiling/cumulative cap là specialized schema, không nới generic voucher;
- storage không public;
- approval base tables không grant SELECT cho authenticated;
- evidence registry/link dùng composite org FK, posting không nhận raw object path;
- evidence ORIGINAL unique; legacy delta inheritance chỉ cùng voucher lineage/pre-cutover, waiver `PRE_V2_LEGACY_DELTA` bắt source hashes và không dùng sau cutover;
- access state/request tables hỗ trợ revision + idempotency và normal RPC chặn self-role change;
- recognition adjustment có composite tenant FK, unique org/idempotency, payload hash, immutable trigger và không có client DML;
- accrual source bắt buộc phân biệt `BASE/ADJUSTMENT_ONLY`; closed period đọc snapshot thay vì current header status;
- P&L/close/counter/hash/drill-down cùng dùng effective contribution resolver; adjustment contribution lấy target period từ `adjustment_period` và giữ source voucher state/version;
- backfill change capture có INSERT/UPDATE/DELETE tombstone, run/high-watermark state; semantic-event log phân biệt BACKFILL với V2_WRITE;
- legacy cash-impacting delta dùng immutable reversal + replacement generation hoặc mandatory exception; không UPDATE/DELETE posting event;
- `income_expenses.deleted_at` predicate có trong mọi LEGACY/SHADOW/CANONICAL list/stats/export compatibility path; private source hash/audit RPC là ngoại lệ có capability;
- V5 collection/payment/mirror voucher chỉ có một cash effect: provenance unique, collection reversal nối đúng posting lineage; change-only tender vẫn có MAIN gross + CHANGE đối ứng/net zero và termination non-cash không thành cash;
- termination forfeit guard forward-fix yêu cầu pair-transition context cho mọi `approval_status IS DISTINCT FROM` giá trị cũ; no-op auto-recalc không fail, status+posting metadata/generic token/per-leg update đều không bypass;
- `termination_forfeit_authorizations` có đúng một pair request/flow owner/version; pending backfill không sinh hai request, mixed/duplicate linkage thành exception và pair adapter không tạo cash posting;
- raw `receipt_image_url` không đi thẳng vào posting; system reference evidence snapshot/finalize có hash và negative cross-tenant tests;
- `server_feature_flags` route/CAS/canary/freeze được dùng thay control-plane thứ hai; `schema_migrations` divergence không làm apply/replay sai;
- Finance feature keys được seed cùng transaction với global/org attestation, feature activation guard và canary-enrollment guard; direct DML/CAS không thể chuyển CANARY/ON hoặc thêm/đổi org canary khi gate chưa sạch, trong khi emergency `force_freeze=true` và remove enrollment để giảm blast radius vẫn khả dụng;
- read-semantics activation đi trước, workflow/posting/access chỉ qua atomic cohort CAS; mọi single-key transition fail và mọi close v1/v2 chịu close-safety guard/FROZEN khi P&L chưa ready;
- commission/salary domain key kiểm private business-policy decision organization/version/hash; OFF không fallback legacy;
- mọi CANARY canonical mutation gọi `claim_feature_operation_v1` atomically; non-money mutation claim amount 0 để ăn operation-count cap, money mutation ăn cả operation/single/total amount caps, time window và config-version rollover đều có concurrency tests;
- RBAC assignment INSERT/UPDATE/DELETE/backfill/override parity và `authorization_version` invalidation đều có test, không chỉ UPDATE regrant;
- possession-derived resolver áp emergency/member/role DENY với covering scope trước binding positive grant, không đòi unrelated role ALLOW; approve/share vẫn đòi RBAC ALLOW độc lập;
- admin cashbook read RPC yêu cầu `cashbooks.share` exact scope và không trả balance/history/audit;
- cutover gate fail nếu exception > 0.
- forward-only migration files không mutate feature mode/canary enrollment; operational CAS rollout nằm ngoài migration manifest và vẫn chịu server guards/audit.

Tên test gợi ý:

- `src/lib/__tests__/financeV2SchemaMigration.test.ts`;
- `financeV2RlsMigration.test.ts`;
- `financeV2WriterMigration.test.ts`;
- `financeV2ReadModelsMigration.test.ts`;
- `financeV2CutoverMigration.test.ts`;
- `financeV2ContractSystemWritersMigration.test.ts` — commission/bonus `STANDALONE` birth pending, `PAYROLL` source-only, không source-level approve/post;
- `financeV2SystemBirthGuard.test.ts` — scan mọi system `INSERT income_expenses`, explicit pending cho obligation và không birth payment/posting/settlement side effect;
- `financeV2CommittedBirthBoundary.test.ts` — birth operation/XID persisted, nested create→approve/post/cancel cùng transaction fail, transition transaction sau idempotent;
- `financeV2ContractDepositMigration.test.ts` — receipt intent/posting, `deposit_paid`/shortfall/debt/retry không còn dựa APPROVED;
- `financeV2SourceCatalogParity.test.ts` — DB writers/backfill, `voucherSources.ts`, approval/P&L/list/export cùng mapping và source lạ fail closed;
- `financeV2FallbackSignal.test.ts` — generic/auth `42501` không kích hoạt raw DML fallback; chỉ typed coexistence result hợp lệ trước khi drain;
- `financeV2MakerIdentity.test.ts` — maker user/membership server-owned, legacy business owner khác maker, backfill ambiguity fail closed;
- `financeV2ExecutionQueue.test.ts` — accountless payable candidate/assigner routing, claim CAS, approval-terminal survival và no-leak;
- `financeV2PostingSubject.test.ts` — voucher/tranche subject-generic generation, active pointer, reversal linkage và amount basis;
- `financeV2FlowOwnerDispatch.test.ts` — approve/reject/cancel/resubmit/post/reverse dispatch đủ owner registry, composite/source side effect atomic và unknown/manual bypass fail;
- `financeV2TerminationMoveOutMigration.test.ts` — planned settlement, move-out pair/refund/extra receipt contracts;
- `financeV2SalaryWriterMigration.test.ts` — lock/job/payout/rent-offset không auto-approve/pay;
- `financeV2CommissionProjection.test.ts` — không suy paid từ voucher existence và không còn Nháp;
- `financeV2InvoiceRefundMigration.test.ts` — atomic obligation/cap/reservation, approve không làm invoice đã hoàn;
- `financeV2SalaryBundleMigration.test.ts` — parent gross/P&L, one-request ONE_SHOT child-birth hoặc MULTI_TRANCHE ceiling/cap, rent offset và bulk idempotency;
- `financeV2JobBonusLedger.test.ts` — JOB/DAY_BONUS uniqueness và không materialize voucher ở complete/lock;
- `customerCreditMigration.test.ts` phải đọc cả `20260721135000`, gate `20260722130000` và replacement `20260722160000`, kiểm route CANONICAL/deferred, ACL/search path và response warning;
- `terminationForfeitGuardPostBundleMigration.test.ts` đọc cả `20260721135500` và replacement `20260722150000`, kèm live-catalog assertion cho effective function/trigger fingerprint;
- `forfeitCreditWrapperPostBundleMigration.test.ts` pin file SHA `39a9e14238870e144561ac89f6bd1387eaace225704b62731d4325f15e621cc4`, normalized wrapper hash `158b183cf6849be940defb344757723875b263abae6e5065359dd0559dadcda0`, route-dependent behavior và chứng minh `scripts/test-accounting-chain.mjs` không replay definition cũ lên catalog đã có hotfix.

### 16.2. DB/RPC state tests

| Case | Kỳ vọng |
|---|---|
| Tạo Phiếu chi | `UNAPPROVED + UNPOSTED`, balance không đổi. |
| Pending thuộc KQKD | Có trong P&L, block close. |
| Duyệt | `APPROVED + UNPOSTED`, balance không đổi. |
| Profit payout: approve-only | Reservation vẫn `HELD`; allocation khả dụng không tăng và payout thứ hai không reserve trùng. |
| Profit payout: post/reverse | `HELD -> CONSUMED -> REVERSED` atomic với posting/reversal; CONSUMED vẫn trừ allocation, REVERSED giải phóng lại đúng một lần. |
| Profit payout: reject/withdraw/cancel pre-post | `HELD -> RELEASED` atomic; retry không release hai lần. |
| Duyệt và Chi | Approval + posting atomic. |
| Chi sau duyệt | CUSTODIAN không có approve vẫn post được. |
| Approved-unposted accountless | Execution scope còn sống sau approval. CUSTODIAN exact candidate claim/assign+post được; không candidate chỉ assigner thấy Chờ phân sổ; concurrent claim/reassign dùng revision và không orphan/double post. |
| Approver không giữ sổ | Duyệt được, post bị chặn. |
| Thiếu ngày/sổ/ảnh | Toàn transaction fail. |
| Retry cùng key | Trả cùng result, một posting. |
| Cùng key khác payload | Fail conflict. |
| Retry approve/request-changes/reject/withdraw/resubmit | Cùng key/payload trả result snapshot cũ, không thêm transition/submission/audit; khác payload fail. |
| Hai actor cùng post | Chỉ một active posting. |
| Invoice Collection V5 partial/multi-tender | Mỗi tender một voucher/posting lineage; collection/payment/mirror không double-count; reversal nối đúng tender gốc. |
| V5 change-only tender | `gross_amount=tender.gross_amount`, `voucher_amount_snapshot=0`; MAIN +gross và CHANGE -gross cho net zero, vẫn giữ movement từng sổ/lineage; reversal đối dấu toàn bộ. |
| Contract create có deposit | Receipt intent thiếu ngày/sổ/evidence không thành actual cash; đủ contract thì một posting. `deposit_paid`, shortfall/debt và retry chỉ đọc active posting; reversal loại tiền cọc đúng một lần, lineage link không giữ số đã thu. |
| System obligation birth guard | Expense writer bỏ status/dựa default, set APPROVED, sai mode-state (`CASHBOOK/UNPOSTED`, `NON_CASH/NOT_APPLICABLE`), forged actual-cash class hoặc tạo payment/posting/settlement trong birth context đều fail/rollback. Insert pending rồi nested approve/post cùng transaction cũng fail theo `birth_txid`; operation ở transaction sau mới được transition. Allowlisted actual-cash income vẫn atomic. |
| Flow-owner lifecycle dispatch | Manual và từng system owner gọi đúng adapter cho approve/reject/cancel/resubmit/post/reverse; invoice refund/salary/pair/profit/source state đổi atomic. Unknown owner hoặc gọi manual primitive lên system subject fail, không partial transition. |
| Termination non-cash/forfeit | Payment settle A/R nhưng `received_amount=0`/cash components zero → `NON_CASH + NOT_APPLICABLE`, không có cash line; no-op recalc qua, status đổi thật bắt buộc pair-transition context. |
| Approve/cancel forfeit pair | Đúng một pair approval request; khóa/cập nhật revenue + offset + settlement atomic, retry idempotent và không tạo cash posting. |
| Generic/per-leg forfeit transition | Manual approve/post, offset-only update, status kèm `posting_id/posted_at_v2`, generic token hoặc hai request độc lập đều fail và rollback nguyên pair. |
| Backfill forfeit approval | Pending pair sạch tạo một request; mixed statuses, thiếu leg/authorization hoặc duplicate leg requests vào exception. |
| Move-out source transaction | Contract/room/domain audit cập nhật; `termination.revenue/offset` và refund đều birth pending; chỉ planned settlement rows xuất hiện, không `payments`, posting, cash line hoặc invoice paid side effect. |
| Approve/cancel move-out pair | Đúng một `TERMINATION_MOVE_OUT_PAIR` request; approve materialize chính xác từng CT settlement line + chuyển hai leg atomic, cancel không để payment treo; generic/per-leg/post action fail. |
| Move-out refund | Birth `UNAPPROVED + UNPOSTED` không account/evidence; approve-only không balance/payment; post đủ ngày/sổ/ảnh mới chi, retry một posting. Pure DEPOSIT refund không block P&L close, PNL compensation thì có. |
| Termination extra receipt | `PAID` chỉ thành cash event qua V5/dedicated adapter có ngày/sổ/evidence; thiếu evidence hoặc chọn DEBT không sinh `APPROVED`, payment hay posting cash-looking. |
| Deferred credit route SHADOW | Forfeit wrapper trả `deferred=true`, termination vẫn hoàn tất nhưng queue/remediation có owner; không tạo apply/refund/posting tự động. Retry cùng key sau route flip vẫn trả cached deferred; resolver operation/key riêng consume open lots đúng một lần. Move-out credit path vẫn fail closed nếu route chưa CANONICAL. |
| Invoice refund obligation | Hai request đồng thời không reserve vượt refundable due; birth pending atomic, approve-only không đổi invoice/refunded cash, post/reverse consume/release đúng một lần. DEPOSIT/CUSTOMER_CREDIT không P&L; PNL contra-revenue pending block đúng kỳ và không double-count khi post. |
| Contract commission/thưởng | Broker/Sale theo `settlement_mode`; mỗi source có một cash/P&L owner, retry không trùng, source modal không approve/post. `PAYROLL` bị salary consume và generic post fail; `STANDALONE` là voucher pending. |
| Chốt lương/job | Lock/snapshot/award không đổi approval của commission, không tăng `salary_monthly.paid` và không tạo cash event; JOB/DAY_BONUS consume exact một lần, obligation materialization pending/idempotent. Earning chưa snapshot block profit close thay vì biến mất khỏi P&L. |
| Salary payout có cấn tiền phòng | Birth parent gross pending + planned offset và đúng artifact nhánh ONE_SHOT/MULTI_TRANCHE, chưa payment/receipt và `paid` không đổi; một bundle request approve, post cash mới tăng paid; zero/negative, cumulative cap, stale invoice, reject/reversal và bulk retry không lệch linkage. |
| Salary reject/supersede | CHANGES giữ earning HELD; invalid bundle release earning và blocker nguồn quay lại atomic; approved bundle chỉ supersede sau cash/rent reversal, transfer/release links + terminal child/auth không làm earning biến mất hoặc trả trùng. |
| System evidence từ V5 receipt | Registry `SYSTEM_REFERENCE` snapshot/finalize bằng source id/hash; không yêu cầu upload lại và raw URL không là posting input. |
| Salary auth denial/fallback | `42501` thật fail và không raw DML/default APPROVED; chỉ typed compatibility signal trước cutover được route wrapper xử lý, sau caller drain không còn fallback. |
| Version cũ | Fail optimistic concurrency. |
| Revoke binding trong lúc chờ lock | Recheck và fail. |
| Ngày post trong kỳ khóa | Fail. |
| Nghĩa vụ tháng trước, Chi tháng sau | P&L tháng trước giữ nguyên; cash tháng sau đổi. |
| Hủy posted row | Fail; phải reversal. |
| Reversal | Row/event gốc bất biến; balance bù đúng. |
| Request changes | Vẫn UNAPPROVED/CHANGES_REQUESTED, block close, resubmit tăng version. |
| Pending legacy thiếu approval request | Backfill đúng một request PENDING từ snapshot/flow owner; không fabricate decision hoặc đổi P&L/balance. |
| Request changes rồi resubmit | Request cũ terminal CHANGES_REQUESTED + outcome; partial unique được giải phóng; đúng một request mới PENDING, không reopen row cũ. |
| Reject invalid/duplicate | CANCELLED + terminal posting state theo mode, recognition loại/điều chỉnh đúng kỳ. |
| Mark disputed | Voucher và request thành DISPUTED, vẫn recognized + block close, có owner/reason/deadline/outcome; không còn request PENDING giả. |
| Maker withdraw pending ở kỳ mở | Atomic `CANCELLED + RESOLVED + WITHDRAWN_BY_MAKER`, đóng approval request, bỏ P&L/blocker, balance không đổi. |
| Maker withdraw sau CHANGES_REQUESTED | Voucher cancelled; request CHANGES_REQUESTED cũ bất biến, withdrawal audit append đúng một lần, không sinh request giả. |
| Maker withdraw system/disputed/approved/posted/kỳ khóa | Fail; không đổi voucher, recognition, approval request hoặc audit ngoài failure trace. |
| MAIN + CHANGE + ROUNDING | `abs(MAIN)=gross_amount`, `net_cash_effect=sum(lines)`, parity đúng. |
| Cancel/reject-invalid sau close | Không làm live source của snapshot cũ biến mất; yêu cầu reopen hoặc adjustment kỳ mở. |
| Tạo muộn với recognition kỳ đã khóa | Bị chặn backdate; chỉ reopen hoặc catch-up adjustment. |
| Catch-up late recognition | Voucher là `ADJUSTMENT_ONLY`, header contribution bằng zero, positive adjustment xuất hiện đúng một lần ở kỳ mở. |
| Pending `ADJUSTMENT_ONLY` ở kỳ mở | Effective adjustment contribution mang state UNAPPROVED và block close `adjustment_period`; approve-only chuyển thành informational, không đổi amount. |
| Cancel/correct base sau close | Base kỳ khóa giữ nguyên; chỉ delta adjustment vào kỳ mở; tổng toàn timeline không drop/double-count. |
| Adjustment retry/forgery | Cùng key cùng payload trả cùng result; khác payload, direct DML, cross-org, forged amount/allocation/actor đều fail. |
| Legacy UPDATE amount/account/status sau initial backfill | Không sửa event cũ; append reversal + replacement generation nếu deterministic, active pointer/hash/tổng đúng. |
| Legacy replacement có evidence cũ | Thu và Chi đều tạo inherited evidence snapshot đúng lineage/hash; object không attach được sang voucher khác. |
| Legacy replacement của waiver backfill | Chỉ pre-cutover dùng `PRE_V2_LEGACY_DELTA` với old/new hash/change-log id; cùng payload idempotent, sau CANONICAL bị chặn. |
| Legacy DELETE/cancel sau initial backfill | Delete guard giữ voucher với `deleted_at`; row đã cash thành APPROVED+REVERSED, recognition xử lý riêng; bypass/ambiguous/locked-period thành mandatory exception, không cascade/mutate event. |
| Read sau legacy DELETE | LEGACY/SHADOW/CANONICAL list, stats, export và default detail không trả tombstone; balance net reversal, P&L open/closed đúng; audit-capable history vẫn thấy. |
| Legacy INSERT/UPDATE/DELETE trong initial backfill | Change log bắt đủ kể cả tombstone; delta replay tới final watermark cho count/SUM/hash khớp cùng snapshot. |
| Rollback SHADOW | Chỉ cho về LEGACY khi không có V2_WRITE semantic event và zero unapplied delta; mọi canonical-only state/event buộc FROZEN + forward-fix. |
| Org barrier vs global freeze | DEMO barrier chỉ chặn DEMO và cho chụp watermark; `force_freeze` làm route FROZEN cho mọi org của feature. |
| Finance activation direct DML/CAS thiếu attestation | UPDATE trực tiếp và `set_feature_route_v1` sang CANARY/ON đều fail; stale config version, sai digest hoặc counter gate khác 0 cũng fail. |
| Finance canary enrollment thiếu org attestation | Direct INSERT/UPDATE `server_feature_flag_canary_orgs`, pre-enroll khi OFF/SHADOW, đổi feature/org hoặc enroll sau config rollover đều fail; Accounting guard không được coi là guard Finance. |
| Chuyển CANARY với enrollment có sẵn | Feature guard scan mọi enrolled org theo target config version; chỉ một org thiếu/stale attestation cũng rollback mode transition. |
| Finance activation hợp lệ/emergency stop | Attestation đúng version/digest/counters mới cho CANARY/ON; `force_freeze=true` vẫn thành công khi gate bẩn để dừng khẩn cấp. |
| Finance canary enrollment hợp lệ/remove | Org attestation đúng feature/config/org mới enroll được; DELETE giảm blast radius thành công và được audit, re-add sau version change cần attestation mới. |
| Commission/salary thiếu decision policy | Domain feature giữ OFF; source RPC trả lỗi policy chưa chốt và không fallback legacy. Sai organization/version/hash hoặc source stamp cũ làm activation/write fail. |
| Single-key workflow/posting/access activation | Fail; không thể tạo trạng thái approve canonical nhưng balance/read/access legacy. Cohort CAS đúng release/config chuyển cả ba hoặc rollback cả ba. |
| Workflow activation khi read-safety/close guard chưa sẵn sàng | Fail. Read-semantics phải thấy posting + pending P&L trước; nếu profit-close chưa ready thì mọi close v1/v2 đang FROZEN mới cho cohort write. |
| CANARY non-money operation cap | Approve/request-change/access mutations claim amount 0; concurrent calls vượt `max_operation_count` bị chặn dù không có money amount. |
| Pending KQKD ở kỳ đã khóa | Không auto-approve/cancel; queue disposition phải chọn reopen/reclose, `ADJUSTMENT_ONLY` hoặc invalid-cancel có close-owner audit/hash. |
| Profit hash dispatcher | Snapshot lịch sử `profit-close-v2.1` verify bằng v1; initial CLOSE mới và mọi RECLOSE tạo sau activation đều stamp/verify bằng Finance V2 algorithm. |

### 16.3. RLS/tenant matrix

| Persona | Phải thấy/làm được | Phải bị chặn |
|---|---|---|
| CUSTODIAN sổ A | Balance/history/Thu/Chi sổ A | Sổ B nếu không binding. |
| KNOWER sổ A | Tên sổ trong form Thu, own-created INCOME | Balance, stats, export, EXPENSE, phiếu/ảnh người khác. |
| KNOWER tạo phiếu cho business owner khác | Vẫn thấy do `maker_user_id` là mình | Không suy quyền từ `income_expenses.user_id`; owner không tự thành maker. |
| CUSTODIAN/KNOWER active nhưng không có unrelated role ALLOW | Nhận đúng action possession-derived từ binding | Approve/share/close và capability ngoài binding. |
| CUSTODIAN/KNOWER có tenant emergency, active member hoặc role DENY phủ target từ org/building/area/cashbook | Không có action possession-derived trong scope bị deny | Không được binding bypass covering deny bằng UI, RPC hoặc direct API. |
| Approver-only | Approval inbox và Duyệt | Thu/Chi, balance/history toàn sổ. |
| CUSTODIAN-only | Post approved voucher | Duyệt pending. |
| CUSTODIAN exact execution candidate | Thấy safe payable/claim/post vào chính sổ | Không thấy candidates/sổ/balance khác hoặc row UNASSIGNED không candidate. |
| Cashbook assigner (`cashbooks.share`) | Thấy/assign tab Chờ phân sổ trong đúng covering source scope | Không tự post nếu không đồng thời là CUSTODIAN exact sổ. |
| CUSTODIAN + approver | Duyệt và Thu/Chi atomic | Sổ ngoài binding. |
| Không binding | Không thấy tên sổ | Direct ID/detail/stats/search. |
| User nhiều org | Chỉ org/membership đã chọn | Ghép cashbook/voucher/membership chéo org. |
| User thường | Không self-grant | Direct insert binding/share RPC không quyền. |
| Actor có share permission | Quản trị role người khác theo scope/CAS | Không tự đổi role chính mình qua normal RPC; stale/replay bị chặn. |
| Actor có share permission sổ A | Admin RPC trả revision, assignments và eligible membership safe fields của A | Binding history/audit/balance, sổ B hoặc membership ngoài scope. |
| Actor không có share permission | Không có admin access shape | Đoán cashbook id để gọi admin RPC hoặc đọc base bindings. |
| Compatibility OPERATOR | Không xuất hiện trong UI hoặc tự nhận quyền CUSTODIAN/KNOWER | Auto-map, auto-grant money permission hoặc vượt cutover khi chưa disposition. |
| Staff assignment lifecycle | INSERT/UPDATE/DELETE/backfill giữ canonical role binding/scope đúng và bump auth version | Thiếu binding, role/org mismatch, stale cache hoặc override malformed bị bỏ qua. |
| Non-approver cùng org | Chỉ dữ liệu thường được scope | REST SELECT approval request/step/candidate/decision/audit bị chặn. |
| Evidence owner A | Attach/sign proof A hợp lệ | Không tham chiếu/overwrite/finalize object org B. |
| Legacy delta worker | Inherit evidence trong đúng voucher lineage trước cutover | Client/user reuse inherited link, đổi hash, gắn voucher khác hoặc dùng waiver sau CANONICAL. |
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
- execution queue matrix assigned/exact-candidate/unassigned: badge, safe visibility, claim/assign/post capability và stale revision;
- NON_CASH/termination forfeit pair chỉ có một pair approval action, không có Thu/Chi/per-leg action;
- approve/post không đổi recognized amount;
- profit payout reservation giữ `HELD` qua approve-only, `CONSUMED` qua post và chỉ trở lại available khi `RELEASED/REVERSED`;
- POSTED không quick-edit account/evidence;
- recurring/import/batch không tự thành money truth;
- source projection cho commission không suy `paid` từ voucher existence: `STANDALONE` pending/approved-unposted/posted và `PAYROLL` earned/consumed/paid-through-salary có label/action khác nhau; toàn bộ string “Nháp/Lưu nháp/Chi & duyệt” biến mất khỏi source modal;
- termination projection gom đúng move-out/forfeit pair nhưng giữ refund thành voucher riêng; pair không có posting action, refund có posting action sau approve;
- salary projection không suy “đã trả” từ `payout_voucher_id`, request state hoặc salary lock; chỉ active posting trừ reversal mới tăng paid;
- source birth command và Finance approve/post command có idempotency namespace/operation riêng; test không cho cùng transaction/callback ẩn tự nối create -> approve/post;
- trước migration, characterization đóng đinh hiện trạng approve→balance, cash dùng `voucher_date` và shared-user visibility; sau cutover thay bằng state/access matrix mới;
- update `src/hooks/__tests__/useIncomeExpenses.property.test.ts`, bỏ property approve/unapprove round-trip về Nháp;
- mở rộng `src/lib/__tests__/profitClose.test.ts` nhưng giữ test CAS/revision/reclose/unallocated hiện hữu;
- property cho effective contribution bảo đảm BASE dùng allocation period, adjustment dùng `adjustment_period`, pending blocker/counter/hash cùng một source set và dispatcher chọn algorithm theo snapshot version;
- thêm unit/projection tests cho V5 one-tender-one-posting, multi-tender, reversal và system evidence reference.

### 16.5. E2E headless

Tạo:

- `.e2e-fleet/specs/finance-posting-flow.spec.ts`;
- `.e2e-fleet/specs/finance-cashbook-scope.spec.ts`;
- `.e2e-fleet/specs/finance-profit-close.spec.ts`;
- `.e2e-fleet/specs/finance-writers.spec.ts`.

Sửa `.e2e-fleet/specs/ie-create.spec.ts` để canonical RPC là đường duy nhất; test phải fail nếu app fallback về direct-table legacy.

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
14. System receipt/collection writer cho tiền thu thật tạo posting/evidence hợp lệ; không áp ngoại lệ này cho Phiếu chi hệ thống.
15. Reversal bù số và giữ audit.
16. Request changes đóng request cũ với outcome → maker thấy Cần bổ sung, sửa field mask và resubmit tạo đúng một request mới; disputed đóng request cũ và vào queue owner/deadline.
17. Maker rút pending ở kỳ mở → Cancelled/Resolved và bỏ blocker; system/disputed/approved/posted/kỳ khóa không rút được.
18. Late-created/cancelled-after-close không sửa snapshot cũ; BASE/ADJUSTMENT_ONLY và adjustment kỳ mở cho tổng từng kỳ/toàn timeline đúng một lần; pending ADJUSTMENT_ONLY block đúng `adjustment_period`.
19. Direct/cross-org/forged/replayed recognition adjustment bị chặn; retry hợp lệ idempotent.
20. Hai posting đồng thời dùng cùng evidence id: chỉ một attach thắng; cross-org object reference/overwrite bị chặn.
21. Retry lifecycle RPC cùng key/payload trả cùng result không lặp audit/submission; approval history hiển thị `WITHDRAWN` đúng và inbox không còn row đã rút.
22. Cashbook admin có share permission tải đúng revision + hai danh sách safe rồi CAS save; user không share/direct base read/cross-cashbook id đều bị chặn.
23. Legacy Thu/Chi delta replacement kế thừa evidence đúng lineage hoặc waiver pre-cutover có audit; cross-voucher/reuse/sau-V2 đều fail.
24. Legacy delete không hiện lại trong list/stats/export/default detail ở LEGACY/SHADOW/CANONICAL; balance/P&L đúng và audit history vẫn truy cập theo quyền.
25. V5 partial collection/multi-tender tạo đúng một posting mỗi tender, gồm change-only tender retained=0 với MAIN/CHANGE net zero; không double-count collection/payment/voucher, reversal giữ LIFO và nối đúng lineage.
26. V5 `receipt_image_url` được adapter thành system evidence snapshot; không upload lại, raw URL/cross-org source giả bị chặn.
27. Pending KQKD thuộc kỳ đã khóa chỉ được xử lý theo disposition đã phê duyệt; close v2.1 cũ vẫn pass hash v1, initial close mới và reopen/reclose tạo sau activation dùng hash Finance V2.
28. Assignment INSERT/UPDATE/DELETE/backfill/override giữ role binding/scope/auth version đúng; anomaly/mismatch làm access gate fail closed.
29. Profit payout approve-only vẫn giữ allocation; post rồi reverse giải phóng đúng một lần, không tạo được payout trùng ở bất kỳ bước trung gian nào.
30. Binding CUSTODIAN/KNOWER hoạt động không cần unrelated role ALLOW, nhưng tenant emergency/member/role covering DENY chặn ngay cả khi gọi direct API.
31. Termination có bỏ cọc tạo được pair qua no-op total recalc; inbox chỉ có một pair request, approve/cancel/retry cập nhật hai leg atomic và giữ NON_CASH. Generic per-leg/status+posting update, request trùng hoặc thiếu pair context đều fail.
32. Tạo HĐ rồi phát sinh broker/Sale commission: source có recipient FK/policy version/settlement mode; `STANDALONE` commit Chờ duyệt, `PAYROLL` chỉ là earning và generic post fail. Không balance/payment/posting, modal không có Nháp/Chi & duyệt và bảng kỳ không gọi pending là paid.
33. Thanh lý move-out có cấn cọc + hoàn khách: domain hoàn tất nhưng revenue/offset pair và refund đều pending; chưa có CT payment/cash posting. Approve pair chỉ materialize DEPOSIT/CUSTOMER_CREDIT settlement, approve refund không chi, post refund mới giảm đúng sổ.
34. Thanh lý bỏ cọc: một pair row/approval subject, không request per-leg; approve tạo CT settlement nhưng không cash posting, close blocker theo revenue contribution đúng kỳ.
35. Move-out có khách trả thêm: DEBT không cash event; PAID thiếu ảnh/sổ/ngày fail hoặc không cho chọn, đủ contract thì đi V5/dedicated collection và chỉ một posting.
36. Chốt lương chứa hoa hồng/thưởng/job: snapshot LOCKED exact source ids/hash; `PAYROLL` earning được consume đúng một lần, `STANDALONE` voucher không lọt vào gross; `paid` không đổi và không auto-approve/post.
37. Lương có cấn tiền phòng: parent gross/P&L và ONE_SHOT child hoặc MULTI_TRANCHE authorization đều birth trước approval; đúng một bundle request. Trước approve invoice chưa settle, approve offset một lần, post cash mới tăng paid; zero/negative, cumulative cap, stale invoice, retry/reversal không lệch.
38. Invoice refund: source dialog không hỏi ngày/sổ/ảnh; hai request cạnh tranh không vượt refundable cap. Approve chỉ thành Đã duyệt - Chưa hoàn, invoice/refunded cash không đổi; post/reverse đổi đúng một lần.
39. Forfeit có customer credit khi route SHADOW: thanh lý hoàn tất, UI cảnh báo số dư deferred + remediation id; không apply/refund/voucher/posting tự động. Move-out cần excess credit vẫn fail closed đúng scope.
40. Job bonus concurrency: cùng JOB/rule chỉ một earning, DAY_BONUS cùng staff/ngày/rule chỉ một earning; notification/job completion không tạo voucher hoặc paid. Kỳ bị block khi earning chưa snapshot; salary bundle consume xong tạo đúng một pending contribution.
41. Manager/staff salary bulk: batch retry trả cùng per-row result, không partial im lặng; source form không nhận posting fields và tổng cash tranche không vượt `cash_due` theo policy §2.6.
42. Move-out sau approve: `CASH_DUE` không thể materialize thành CT; reversal pair append-only restore invoice đúng một lần, không delete payment/đưa pair về pending.
43. Tạo HĐ có tiền cọc: thiếu actual-cash fields thì chỉ giữ intent/debt đúng policy; đủ ngày/sổ/evidence thì đúng một receipt posting. `deposit_paid`/shortfall/retry không đổi chỉ vì approve voucher.
44. Salary RPC trả auth denial `42501`: UI báo lỗi và không tạo raw fallback voucher/receipt/payment; typed coexistence signal hợp lệ mới đi compatibility path trước drain.
45. Source mapping parity: deposit, invoice refund, manager/staff salary, rent-offset và deferred credit hiển thị/filter/export/approval/P&L đúng canonical source; forged/unknown source fail closed.
46. Maker identity: KNOWER tạo Phiếu thu có business owner khác vẫn thấy/rút đúng điều kiện; owner không phải maker không thấy theo KNOWER và không rút được; forged maker fields/direct API fail.
47. Activation cohort: cố bật riêng workflow/posting/access bị chặn; cohort CAS thành công hoặc rollback toàn bộ, approve-only không bao giờ chạy khi balance còn đọc APPROVED legacy.
48. Close safety: trước workflow V2 write, read-semantics đã hiển thị pending; khi profit hash/locks chưa ready, mọi close legacy/V2 đều bị FROZEN và không thể chốt bỏ sót pending.
49. Accountless payable: approve-only không làm phiếu biến mất. CUSTODIAN exact candidate thấy/claim/post; assigner xử lý Chờ phân sổ; user sổ khác/direct ID không thấy, concurrent claim/reassign không double post.

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
node scripts/validate-finance-v2-rollout.mjs
node scripts/audit-finance-v2-rollout.mjs
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
- posting/evidence/audit/recognition-adjustment/semantic-event tables; possession/CAS, approval compatibility và `canonical_write_operations` extensions;
- Finance V2 validate/apply/audit manifest scripts và feature-key seeds trên control plane hiện hữu;
- V5-aware initial + delta backfill, change capture, high-watermark, pending/RBAC exceptions và shadow reconcile;
- static migration tests tương ứng.

Không sửa frontend/RLS consumer.

### Agent 2 — RPC/approval/state machine

Ownership:

- private primitives/public RPC;
- approval engine replacement, `WITHDRAWN`, withdraw state và recognition-adjustment writer;
- locks/canonical idempotency/version/audit và flow-ownership guards;
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
- profit report/verification/close, effective contribution resolver, BASE/ADJUSTMENT_ONLY formula, algorithm-version dispatcher và timeline hash;
- pending blockers và approved-unposted warnings;
- profit payout reservation lifecycle/freshness qua approve, post, cancel và reverse;
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
- Invoice Collection V5/reversal/quick collect/deposit adapters;
- invoice refund obligation/reservation + invoice projection;
- deferred customer-credit queue/UI/action + post-bundle wrapper tests;
- utility/fixed-fee obligations;
- termination move-out pair/planned settlements + refund/extra-receipt adapter;
- termination forfeit pair forward-fix;
- contract commission/thưởng settlement ownership + source UI projection;
- salary lock/job earning ledger + salary settlement bundle/rent-offset/bulk;
- profit payout;
- opening adjustment/handover/Copilot.

Mỗi domain phải khai báo writer class và test không bypass. Các bullet termination/commission/salary phải giao file ownership riêng, không chạy write agents overlap. Owner V5 không được thay collection/tender/allocation writer; chỉ nối posting/evidence primitives theo contract §15.

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
2. `feat(finance-db): add posting schema and extend cashbook possession`
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
- Nếu gate không chắc chắn hoặc còn unapplied delta, force-freeze feature liên quan và forward-fix; không downgrade.
- Giữ exception/audit/parity report để sửa forward.
- Không xóa dữ liệu backfill chỉ để làm dashboard xanh.

### 19.3. Sau khi có bất kỳ semantic write V2

Không được rollback app về semantics `APPROVED = cash` hoặc source recognition/access legacy; việc đó có thể làm sai số dư, P&L, approval history hoặc quyền sổ.

Runbook:

1. Set `force_freeze=true` cho feature liên quan để emergency-stop toàn bộ writer; nếu sự cố đã được chứng minh chỉ thuộc một org và mọi writer kiểm barrier, có thể dùng org-scoped write barrier.
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

1. Pin baseline Accounting/V5/RBAC hiện tại; không replay bundle 14 file.
2. Chạy live-catalog fingerprint, characterization tests, consumer/writer inventory, RBAC/access exceptions và pending locked-period inventory.
3. Tạo/validate Finance V2 stage manifest + digest. Mỗi stage sau được apply out-of-band bằng `apply-finance-v2-rollout.mjs` qua Management API với dry-run và pre/post audit; CI không auto-apply.
4. Apply schema inert: trong cùng transaction seed Finance feature keys OFF, cài global/org activation attestations cùng feature-mode + canary-enrollment BEFORE guards và bật private change capture trước source snapshot đầu tiên.
5. Apply containment: đóng co-staff/all-building/storage leak, bật scoped approval inbox compatibility và revoke approval base-table SELECT.
6. Chụp consistent snapshot/initial watermark, chạy initial V5-aware backfill + exception review trong khi change log bắt mọi write mới.
7. Apply RPC V2 và **toàn bộ** system-writer/legacy caller adapters feature-off; regenerate Supabase types.
8. Chuyển caller cuối, làm `ie-create` fail nếu fallback, rồi revoke direct money DML/drop broad policies. Caller count legacy phải bằng 0 trước SHADOW.
9. Replay delta idempotently; đặt DEMO vào org-scoped write barrier ngắn để chụp final watermark, drain zero-lag và reconcile rồi mới bật SHADOW.
10. Bật SHADOW cho DEMO org; giám sát mirror, V5 no-double-count, bypass log, delta lag, balance và P&L parity.
11. Deploy read models, mode-aware RLS/read shapes, frontend compatibility/canonical và chạy full DB/RLS/E2E/reconcile; chưa có V2 workflow write.
12. Đặt toàn bộ close v1/v2 vào server-enforced FROZEN, sau đó mới CAS `income_expense.read_semantics.v2` sang CANARY/ON cho DEMO; xác nhận balance đọc posting và P&L/blocker thấy pending.
13. Sau migration readiness, dùng operational cohort CAS chuyển workflow/access/posting cùng lúc sang CANARY và enroll DEMO bằng org attestation/caps; chạy nhiều kỳ, partial/multi-tender/change-only V5 và reversal. Commission/salary domain vẫn OFF nếu decision §2.6 chưa có. Không ghi mode/enrollment trong migration SQL.
14. Xử lý toàn bộ pending kỳ khóa, 52 unsafe profit locks và hash dispatcher; chỉ sau đó mới CANARY profit-close trên DEMO và mở close guard.
15. Chọn maintenance window cho org thật; đặt org-scoped write barrier, capture/drain final watermark, audit manifest/catalog/data cùng snapshot, freeze close, bật read-semantics rồi CANARY cohort với caps nhỏ. Dùng global `force_freeze` nếu không thể chứng minh mọi writer tôn trọng org barrier.
16. Khi canary xanh và approval reference đầy đủ, chuyển read-semantics rồi cohort sang ON theo dependency; profit-close chỉ ON sau gate riêng, commission/salary chỉ ON sau decision attestation.
17. Theo dõi logs, balance parity, approval queue, posting failures, profit blocker/hash, delta lag và RLS denials.
18. Sau ít nhất một chu kỳ ổn định mới contract/cleanup legacy cuối cùng.

Không push cutover nếu Vercel/app được deploy nhưng stage manifest chưa apply/audit hoặc ngược lại. UI/RPC/schema phải có compatibility gate theo effective feature route; migration ledger không thay cho catalog verification.

## 21. Acceptance criteria cuối cùng

### Nghiệp vụ/state

- [ ] Toàn bộ domain Thu Chi không còn chữ Nháp cho `UNAPPROVED`.
- [ ] Tạo voucher không làm đổi balance.
- [ ] Duyệt không làm đổi balance.
- [ ] Đã Duyệt - Chưa Chi/Thu không chặn close.
- [ ] Duyệt và Thu/Chi atomic, rollback toàn bộ khi lỗi.
- [ ] Thu/Chi sau duyệt không yêu cầu actor có quyền approve.
- [ ] Approved-unposted accountless luôn có execution scope bền vững; exact-candidate CUSTODIAN hoặc restricted assigner xử lý được, approval terminal không orphan payable và không leak sang custodian sổ khác.
- [ ] Manual voucher phase đầu không partial/multi-cashbook; V5 partial invoice/multi-tender vẫn chạy, tách một voucher/posting mỗi tender và biểu diễn change-only retained=0 bằng tender gross + MAIN/CHANGE lines.
- [ ] Posted row không sửa trực tiếp; reversal có audit.
- [ ] Approve/reject/cancel/resubmit/post/reverse mọi system/composite subject đi qua flow-owner decision dispatcher; adapter cập nhật legs/child/auth/source/reservation/paid atomic, unknown owner/manual bypass fail closed.
- [ ] Request changes/resubmit, reject-invalid và disputed resolution có transition rõ; không có UNAPPROVED bị treo vô hạn ngoài hàng đợi có owner/deadline.
- [ ] Maker withdraw chỉ áp dụng cho own human-created `UNAPPROVED + UNPOSTED + PENDING/CHANGES_REQUESTED` ở kỳ mở; transition/audit/idempotency đúng và mọi state/source khác bị chặn.
- [ ] Approval request có terminal `WITHDRAWN`, inbox/history/index semantics đúng; lifecycle retry không tạo transition/submission/audit trùng.
- [ ] Request changes/dispute đóng request cũ bằng terminal-per-request + outcome; resubmit tạo đúng một PENDING request mới và one-open constraint luôn đúng.
- [ ] Mọi expense do contract/system sinh ra commit `UNAPPROVED` trước; create HĐ, thanh lý, lock lương, hoàn tất job hoặc source modal không auto-approve/post/mark paid và không có hidden create-then-approve callback.
- [ ] Static writer scan + DB birth guard chứng minh mọi `EXPENSE_OBLIGATION` explicit UNAPPROVED với state đúng mode, có durable birth operation/XID và không dựa default/forged class. Create→approve/post cùng transaction hoặc birth payment/posting/settlement side effect đều fail; actual-cash income chỉ qua allowlist atomic.
- [ ] Contract deposit receipt không bị flip pending máy móc: receipt intent/actual-cash adapter, `deposit_paid`/shortfall/debt và retry chỉ đọc active posting. Confirmed-receipt link chỉ là lineage/evidence tới posting và reversal làm nó không còn đóng góp tiền đã thu.
- [ ] Commission broker/thưởng Sale không còn Nháp/Đã chi theo voucher existence; decision §2.6 đã có record. Mỗi source có recipient FK/policy version/settlement mode và đúng một payout/P&L owner; `PAYROLL` không generic-post, `STANDALONE` phân biệt pending/approved-unposted/posted.
- [ ] Move-out `termination.revenue/offset` và forfeit pair mỗi loại có đúng một pair request; refund/compensation là voucher request riêng. Domain termination status không cấp Finance approval.
- [ ] Move-out pair chỉ materialize settlement line funded bằng `DEPOSIT_OFFSET/CUSTOMER_CREDIT`; `CASH_DUE` không thành CT. Sau approve chỉ reversal append-only được restore invoice, không cancel/delete/đưa pair về pending.
- [ ] `termination.refund` chỉ chi qua posting sau approval; ngày thanh lý/recognition không bị dùng làm ngày chi. Pure deposit refund không làm sai P&L/blocker.
- [ ] Invoice refund birth pending atomic và reserve refundable due; approve-only không đổi invoice/refunded cash, post/reverse mới consume/release, concurrency không vượt cap; classification DEPOSIT/CUSTOMER_CREDIT/PNL cho P&L/blocker đúng một lần.
- [ ] Salary lock/job award không duyệt commission hoặc tăng paid; JOB/DAY_BONUS ledger unique và consume một lần, không voucher per-job/lock.
- [ ] Payroll earning chưa salary snapshot block close bằng `UNSNAPSHOTTED_SALARY_EARNING`; khi materialize bundle pending thì P&L chuyển đúng một lần, không vừa ledger vừa voucher.
- [ ] Salary bundle giữ parent gross/P&L; decision §2.6 chọn ONE_SHOT child birth-pending hoặc MULTI_TRANCHE authorization/tranche schema, đúng một request và không child/voucher sinh sau approve. Reject/resubmit/supersede chuyển earning + execution artifacts atomic, không drop P&L/blocker; rent-offset không settle ở birth, active cash posting mới tăng paid và cumulative settlement không vượt cap.
- [ ] Manager/staff bulk payout dùng batch envelope retry-safe với deterministic per-row result; không partial im lặng hoặc posting fields ở source form.

### Lợi nhuận

- [ ] Pending nghĩa vụ KQKD xuất hiện đúng kỳ và chỉ một lần.
- [ ] Approve/post không làm P&L nhảy lần hai.
- [ ] Close chặn đúng pending KQKD và trả drill-down.
- [ ] Approved-unposted có count/amount informational nhưng vẫn close được.
- [ ] Post sau close không làm stale snapshot.
- [ ] Late recognition/cancellation/correction của kỳ khóa chỉ qua reopen/reclose hoặc append-only adjustment ở kỳ mở; snapshot cũ không đổi âm thầm.
- [ ] `BASE/ADJUSTMENT_ONLY` loại trừ drop/double-count; tổng từng kỳ và toàn timeline khớp trước/sau late recognition, cancellation và correction.
- [ ] P&L, pending/approved-unposted counter, blocker drill-down và close hash cùng đọc effective contribution resolver; pending `ADJUSTMENT_ONLY` block đúng `adjustment_period`.
- [ ] Pending thuộc kỳ khóa có disposition close-owner đã hash-lock; không auto-approve/cancel/backdate.
- [ ] Close lịch sử `profit-close-v2.1` vẫn verify bằng hash v1; mọi initial CLOSE/RECLOSE tạo sau Finance activation dùng algorithm mới theo snapshot dispatcher.
- [ ] Profit payout reservation không phụ thuộc approval request enum: approve-only giữ `HELD`, post thành `CONSUMED`, pre-post cancel thành `RELEASED`, reversal thành `REVERSED`; không có cửa sổ double payout.

### Sổ quỹ

- [ ] Balance, cash flow, handover và reconciliation chỉ dùng posting lines active.
- [ ] Cash report dùng `posted_on`, không dùng `voucher_date`.
- [ ] Main/change/rounding/reversal parity khớp legacy ở backfill.
- [ ] Manual `abs(MAIN)=gross_amount=voucher_amount_snapshot`; V5 `gross_amount=tender.gross_amount`, voucher snapshot có thể zero, auxiliary lines khớp field nguồn và `net_cash_effect=sum(lines)`.
- [ ] Retry/concurrency không tạo double posting.
- [ ] V5 collection/payment/mirror voucher chỉ tạo một cash effect mỗi tender, kể cả change-only net zero; V5 reversal nối đúng posting gốc và không regression partial/multi-tender.
- [ ] Legacy cash-impacting UPDATE/DELETE sau backfill chỉ tạo reversal + replacement/tombstone hoặc mandatory exception; posting event/lines cũ không bị mutate/cascade.
- [ ] Legacy delta replacement có evidence inheritance/waiver audit khả thi cho cả Thu và Chi, nhưng không mở đường reuse cross-voucher hoặc waiver sau CANONICAL cutover.
- [ ] Ngày post thuộc kỳ sổ mở.

### Phân quyền

- [ ] CUSTODIAN chỉ thấy/thao tác đúng sổ được giao.
- [ ] KNOWER chỉ thấy tên sổ để tạo Thu và own-created Income.
- [ ] Own-created/withdraw/attachment dùng `maker_user_id/maker_membership_id` server-owned + current membership/binding; không dùng legacy business owner `user_id`, backfill mơ hồ vào exception.
- [ ] KNOWER không thấy balance, Expense, stats, export hoặc attachment khác.
- [ ] Approver không tự có ledger/history/post access.
- [ ] Không binding không thấy tên sổ hoặc row bằng direct API.
- [ ] Không self-grant/cross-org spoof.
- [ ] Access mutation dùng expected revision + idempotency; stale/replay và normal self-role change bị chặn.
- [ ] Cashbook admin RPC trả đúng revision + assignments/eligible safe fields cho actor có share scope; không lộ balance/history/audit hoặc sổ khác.
- [ ] Execution queue chỉ trả assigned/exact candidate cho CUSTODIAN và UNASSIGNED cho `cashbooks.share` covering source scope; mỗi source scope có ít nhất một active assigner trước activation, không wildcard org/candidate khác/balance/history/direct-ID leak.
- [ ] Revoke có hiệu lực ngay và audit đủ.
- [ ] `cashbook_possession_bindings` là binding authority duy nhất; không có `cashbook_access_bindings` writable song song.
- [ ] OPERATOR không auto-map/cấp mới/hiện UI; assignment INSERT/UPDATE/DELETE/backfill/override parity và auth-version invalidation đều sạch.
- [ ] CUSTODIAN/KNOWER binding là positive grant cho exact possession-derived actions, không cần unrelated role ALLOW; tenant emergency, active member và active role DENY với covering scope luôn thắng. Approve/share vẫn cần RBAC ALLOW riêng.
- [ ] Mọi CANARY canonical mutation (kể cả approve/request-change/access/close) claim operation count; amount caps chỉ áp money amount, retry/concurrency không bypass.
- [ ] Workflow/posting/access chỉ activate bằng cohort CAS sau read-semantics; direct single-key transition fail và không có thời điểm approve canonical trong khi balance/report/access còn legacy.

### Security/data

- [ ] Base money/access tables không có client DML.
- [ ] Generic/auth `42501` không kích hoạt compatibility raw-DML fallback; chỉ typed route signal hợp lệ trước drain, caller count fallback bằng 0 trước SHADOW.
- [ ] Policy rộng cũ bị loại; policy inventory khớp allowlist.
- [ ] Attachment private, signed URL theo resource permission.
- [ ] Evidence chỉ attach bằng finalized registry id cùng org; cross-org object reference/overwrite bị chặn.
- [ ] System evidence từ V5/source writer dùng immutable source reference/hash; raw receipt URL không là posting input hoặc authorization key.
- [ ] Evidence inherited chỉ cùng voucher posting lineage pre-cutover, giữ immutable snapshot hash; client không tạo link/waiver này.
- [ ] Recognition adjustment chỉ do canonical RPC ghi, có composite tenant FK, idempotency/payload hash, immutable trigger và negative tests cho direct/cross-org/forged write.
- [ ] `canonical_write_operations` là lifecycle idempotency authority duy nhất; semantic event/backfill/CAS control tables là private, append/immutable theo contract và không có client access.
- [ ] Approval request/step/candidate/decision/audit base tables không đọc được qua REST bởi authenticated; inbox chỉ qua scoped RPC.
- [ ] View mới `security_invoker=true` và ACL tối thiểu.
- [ ] LEGACY/SHADOW không còn co-staff/all-building/storage leak và vẫn chạy qua compatibility boundary; CANONICAL chỉ bật sau adapters/bindings/caller drain.
- [ ] Không unresolved voucher/binding/attachment exception lúc cutover.
- [ ] Initial + delta backfill bắt đủ INSERT/UPDATE/DELETE tới final watermark, zero lag và count/SUM/hash khớp cùng snapshot.
- [ ] Voucher `deleted_at` bị loại nhất quán khỏi LEGACY/SHADOW/CANONICAL list/stats/export/default detail; reversal/P&L và private audit history vẫn đúng.
- [ ] SHADOW chỉ rollback về LEGACY khi zero V2_WRITE semantic event và zero unapplied delta; nếu không phải FROZEN + forward-fix.
- [ ] Rollout chỉ dùng `server_feature_flags`/CAS/canary/freeze; không có control plane thứ hai.
- [ ] Finance feature keys được seed cùng server activation guard; direct DML và CAS sang CANARY/ON đều fail nếu attestation/digest/counter/dependency chưa sạch, còn `force_freeze=true` luôn dùng được để dừng khẩn cấp.
- [ ] Commission/salary có feature key riêng và private policy decision attestation; thiếu/sai decision giữ domain OFF, source action fail rõ ràng và không rơi về legacy writer.
- [ ] `server_feature_flag_canary_orgs` có org-specific attestation/BEFORE guard; pre-enroll/direct INSERT/UPDATE bị chặn khi gate bẩn, CANARY transition recheck mọi enrolled org theo target config version, DELETE giảm blast radius được audit.
- [ ] Forward-only migration không tự chuyển mode/enroll org; operational CAS transition và enrollment tách khỏi stage manifest, có approval reference/audit và vẫn chịu guard.
- [ ] Trước V2 workflow write, pending P&L/read-safety đã active; nếu profit-close chưa ready thì `assert_finance_close_safe_v2` chặn mọi close v1/v2 dưới FROZEN, SHADOW không được coi là đủ.
- [ ] Termination forfeit pair guard/function fingerprint live khớp post-bundle digest; mọi status change cần pair context, no-op recalc được phép, một pair chỉ có một approval request và không có cash posting.
- [ ] Wrapper `terminate_contract_forfeit_with_credit_v1`/migration `20260722160000` có file SHA, effective function hash, ACL/owner/search-path và route behavior đúng; test chain không ghi đè definition cũ. Deferred credit có queue owner/SLA/reconcile, UI cảnh báo và không bị coi là đã settlement.
- [ ] Move-out planned-settlement authority/lines có tenant FK, immutable source hash/version và không client DML; source transaction không tạo CT payment, pair approve/cancel/retry materialize/reverse atomic, generic per-leg action bị chặn.
- [ ] Source inventory `contract.commission`, invoice refund, deferred customer credit, toàn bộ `termination.*`, `salary.staff/manager` và job/bonus mapping đồng nhất giữa DB writer, `voucherSources.ts`, approval route, P&L resolver, list/filter/export và audit gate; source lạ fail closed.
- [ ] Finance V2 apply manifest/catalog fingerprint khớp; không dùng `schema_migrations`, `db push/reset` hoặc replay Accounting bundle làm truth.
- [ ] Generated Supabase types khớp schema.

### Verification

- [ ] `npm run typecheck:baseline` xanh.
- [ ] `npx tsc --noEmit -p tsconfig.app.json` không tăng lỗi.
- [ ] Vitest/DB/RLS/concurrency tests xanh.
- [ ] `node scripts/check-view-invoker.mjs` xanh.
- [ ] `node scripts/reconcile-money.mjs` xanh cho mọi kỳ canary.
- [ ] `validate-finance-v2-rollout.mjs` và `audit-finance-v2-rollout.mjs` xanh với đúng manifest digest/catalog fingerprint.
- [ ] Headless E2E desktop/mobile xanh, không console/page errors.
- [ ] Independent reviewer không còn finding High/Medium.

## 22. Checklist bàn giao cho agent triển khai tiếp theo

Agent tiếp theo phải bắt đầu bằng:

1. Đọc `CLAUDE.md`, `CLAUDE.local.md` và file plan này đầy đủ.
2. Fetch/rebase `origin/main`; kiểm tra worktree dirty và active accounting branch.
3. Chụp `git status`, HEAD, migration tail và live catalog snapshot.
4. Không tin `schema_migrations`; pin catalog fingerprint, Accounting 14-file baseline và feature states trước khi apply.
5. Không sửa code trước khi hoàn tất inventory `APPROVED`, V5 source lineage, pending locked-period và source classification.
6. Kiểm tra decision record §2.6; chưa có thì không implement/cutover commission ownership, recognition/clawback hoặc salary rent/partial policy.
7. Tạo plan execution với dependency rõ; không chạy write agents overlap.
8. Land characterization tests trước schema/cutover.
9. Dùng expand/shadow/canary/canonical/contract trên `server_feature_flags`, không big-bang hoặc config rollout thứ hai.
10. Sau mỗi migration view chạy invoker check; sau mọi money change chạy reconcile.
11. Chỉ tuyên bố hoàn tất khi browser/E2E và server negative tests đều đã chạy thật.
12. Commit file cụ thể và push theo quy trình repo.

Prompt ngắn có thể giao cho coordinator:

```text
Triển khai toàn bộ docs/plans/PLAN-THU-CHI-V2-DUYET-CHI-PHAN-QUYEN-SO-QUY.md.
Không tự quyết ba policy gate §2.6; chỉ triển khai commission/salary sau khi có decision record.
Không dùng APPROVED làm money truth; posting ledger/lines là canonical cash source.
Không dùng POSTED làm KQKD gate; recognized obligation là canonical profit source.
Mọi expense do hợp đồng/hệ thống sinh ra phải commit UNAPPROVED trước; tạo HĐ,
thanh lý, hoàn cọc, hoa hồng/thưởng, lock lương/job không được auto-approve/post/mark paid.
Tái sử dụng V5/Accounting/RBAC, cashbook_possession_bindings, canonical_write_operations
và server_feature_flags; không tạo authority/control-plane song song.
Ưu tiên khóa leak RLS/storage và direct DML, rollout expand -> shadow -> canary -> canonical -> contract.
Đọc và bảo toàn mọi thay đổi user đang có, chia agent ownership không overlap,
chạy đầy đủ migration/static/DB/RLS/concurrency/typecheck/reconcile/E2E/review,
chỉ cutover khi mọi gate trong plan xanh.
```

## 23. Trạng thái tài liệu

File này là kế hoạch triển khai tự chứa cho AI/human engineer, được refresh trên baseline `d6837dd` và live snapshot ngày `2026-07-22`. Nó khẳng định Accounting/V5/profit-close/RBAC/termination-guard/deferred-forfeit foundations đã là baseline, nhưng không khẳng định các object lõi Finance V2 posting/review/access/recognition-adjustment đã được triển khai hoặc production đã cutover. Ba policy gate tại §2.6 vẫn phải có quyết định của chủ dự án trước implementation/cutover tương ứng. Khi triển khai xong, chuyển contract bền vững vào tài liệu canonical và cập nhật/đóng plan này thay vì giữ status mơ hồ.
