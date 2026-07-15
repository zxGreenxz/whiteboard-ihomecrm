# Kết luận kiểm tra

> Rà soát lại ngày 2026-07-14 trên code/migration hiện có. Đây là cập nhật tài liệu đánh giá; không ghi thử production và chưa áp migration/hotfix live.

## Phán quyết hiện tại

| Phạm vi | Kết luận |
|---|---|
| Tiếp tục rà soát, sửa dossier, viết test/harness không tác động production | **GO WITH CHANGES** |
| Merge branch và coi dossier là tài liệu sẵn sàng thi công | **NO-GO** |
| T1 hiện tại: nối `submit_financial_voucher`/`decide_financial_voucher` và làm reversal | **NO-GO** |
| Triển khai Group A theo nhãn “additive = an toàn” hiện tại | **NO-GO** |
| B-money, RLS v2, Storage, ACL toàn schema, REVOKE DML | **NO-GO** |
| Chuẩn bị/review hotfix cô lập approval RPC đang mở | **GO ngay ở mức artifact; ưu tiên P0** |
| Áp hotfix lên production | Chỉ **GO** khi owner ra lệnh rõ ràng; phương án mặc định là `REVOKE EXECUTE` vì hiện không có UI caller |

Branch chuẩn bị hiện mới hoàn tất T0: tạo dossier. Không có T1, không có migration PREPARED, chưa có thư mục `supabase/migrations-pending-window/`, và chưa có hook mới được nối.

Dossier là một inventory tốt về các write path chính, nhưng chưa phải execution plan có thể ký duyệt. Con số “51 hạng mục / 163 ngày” hiện chỉ phản ánh phần inventory ban đầu, chưa bao gồm đầy đủ RBAC synchronization, staff lifecycle, approval governance, R2/Edge, API test harness và vận hành cutover.

### Đối chiếu production read-only ngày 2026-07-14

Truy vấn catalog/data đếm tổng, không ghi dữ liệu, xác nhận:

- `submit_financial_voucher` và `decide_financial_voucher` tồn tại và role `authenticated` có `EXECUTE`.
- Có 2 active rule set và 2 rule `internal_settlement` → `AUTO_POST`.
- `emergency_approve_financial` và `reverse_financial_posting` không tồn tại.
- `income_expenses.idempotency_key` không có unique index/constraint.
- Có 0 approval request, 0 decision và 0 authorization audit event.
- `authorization_audit_events.organization_id` nullable.
- CHECK state của `approval_requests` không chứa `REVERSED`.

## 1. Chính xác hệ thống đã làm đến đâu

Đã triển khai nhưng mới ở mức nền.

### Sprint 0 — containment
Phần containment Edge/cron căn bản đã có:

Cloudflare Worker xác thực Supabase JWT.
Upload R2 hiện giới hạn namespace theo user, MIME và kích thước.
Cron salary đã có CRON_SECRET và allowlist job.
Do đó vấn đề cron unauthenticated trong plan cũ phải được đánh dấu đã xử lý, không tiếp tục tính là hạng mục mở.

### Sprint 1–2 — organization và normalized RBAC
Đã có:

organizations, memberships, roles, permission definitions, bindings, scopes, overrides.
Materialization một lần từ dữ liệu legacy.
authorize_v2 và effective_perms_v2.
Nhưng chưa hoàn thành cutover vì:

Materialization chỉ là one-shot, không có dual-write/synchronizer.
UI quản lý nhân viên vẫn cập nhật mô hình legacy.
authorization_version chưa có cơ chế bump đáng tin cậy khi role/binding/scope/override thay đổi.
Chưa có frontend cache invalidation thực sự.
Một số semantic như role-level DENY, scoped override và resource resolution chưa hoàn chỉnh.
Vì vậy không thể gọi normalized RBAC là nguồn sự thật đang vận hành.

### Sprint 3 — ranh giới tổ chức
Đã có:

organization_id trên nhiều bảng.
_autofill_org.
RESTRICTIVE organization boundary trên 28 bảng lõi.
Nhưng đây vẫn là lớp additive, chưa phải deny-default hoàn chỉnh:

Chính sách hiện cho qua các row có organization_id IS NULL.
Catalog có 155 cột organization_id, nhưng chỉ 18 cột đang NOT NULL; không phải tất cả đều cần NOT NULL, nhưng phải phân loại rõ bảng tenant/global.
_autofill_org còn fallback sang organization hard-code khi không resolve được parent/user. Điều này có thể biến lỗi resolve tenant thành gán nhầm tenant thay vì fail-closed.
Khoảng 602 policy legacy vẫn là bề mặt quyền thật.
### Sprint 4 — approval engine
Đã deploy:

9 bảng rule/request/step/candidate/decision/audit.
submit_financial_voucher.
decide_financial_voucher.
Rule evaluation và posting helper.
Hai organization hiện có rule seed.
Nhưng “schema + RPC đã có” không đồng nghĩa approval engine đã hoàn thành. Phần đang deploy chưa đạt acceptance criteria của state machine:

emergency_approve_financial không tồn tại.
reverse_financial_posting không tồn tại.
Multi-step candidate materialization chưa dùng đầy đủ approval_rule_steps và approval_step_approvers.
Idempotency hiện chưa tồn tại đúng nghĩa: p_idempotency_key được nhận nhưng không được dùng; payload_hash được tính nhưng không được so lại.
Không có revalidation payload trước posting: voucher có thể bị sửa sau submit nhưng decide vẫn post row hiện tại dựa trên snapshot/hash cũ.
submit/decide hiện không ghi bất kỳ authorization_audit_events nào.
Rule publishing/admin workflow chưa có.
Organization tạo sau này chưa có bootstrap rule set.
Approval tables hiện cho mọi member trong organization đọc, thay vì kiểm exact approval/audit permission.
authorization_audit_events.organization_id nullable và chưa có bằng chứng về immutable hash-chain enforcement.
Live hiện có 0 request, 0 decision, 0 audit event. Điều đó cho thấy chưa được dùng, không chứng minh API là inert hoặc an toàn.
### Sprint 5a — guard cột tài chính
Guard hiện chỉ chống giả mạo một số metadata:

Chặn client đặt approved_by thành người khác.
Chặn client tự ghi posting metadata.
Migration còn ghi rõ direct APPROVED với approved_by=NULL vẫn được phép tại 20260713140000_sprint5a_financial_column_guard.sql:8-13.

Do đó Sprint 5a là anti-forgery hardening, không phải approval enforcement.

### Sprint 5b–5b3 — thu tiền v3
record_invoice_payment_v3 đã được nối vào ba frontend path và giao dịch payment/invoice/voucher/items đã được gom lại.

Tuy nhiên RPC này cần được đưa trở lại phạm vi audit, không nên ghi “nền đã có — không làm lại” theo nghĩa đã đạt authorization acceptance. Các vấn đề quan trọng nằm ở phần 3 dưới đây.

### Sprint 6a — ACL
Migration Sprint 6a chỉ revoke ba helper tại 20260713150000_sprint6a_definer_hygiene.sql:6-8.

scripts/check-definer-acl.mjs là differential drift gate, không phải chứng minh toàn schema đã sạch. Live baseline vẫn có khoảng 100 SECURITY DEFINER function effective-executable qua quyền mặc định.

Vì vậy dòng “ACL definer + CI gate” trong dossier phải đổi thành:

“Đã có diff gate ngăn phát sinh exposure mới; baseline hiện hữu chưa burn-down và chưa được allowlist đầy đủ.”

## 2. P0 — stop-the-line trước T1

### P0.1 `submit_financial_voucher` không phải API inert
Nhận định ở AUTHORIZATION-PREP-DOSSIER.md:23 rằng approval RPC “0 nơi gọi từ UI” tạo cảm giác an toàn sai.

RPC được:

GRANT EXECUTE ... TO authenticated.
Chạy SECURITY DEFINER.
Chỉ kiểm caller là active member của organization.
Không kiểm exact permission như income_expenses.submit.
Nhận p_system_source và p_txn_type từ client.
Rule seed có system_source='internal_settlement' → AUTO_POST.
### Kịch bản bypass đã xác nhận từ code

Một authenticated user là active member của organization có thể gọi trực tiếp PostgREST RPC, không cần UI:

Chọn voucher thuộc organization mà họ là member.
Gửi p_system_source='internal_settlement'.
Rule AUTO_POST được chọn.
RPC gọi posting helper dưới quyền SECURITY DEFINER.
Voucher được post mà không cần exact submit permission hoặc maker-checker decision.
Helper còn gắn approved_by, posting_id và posted_at_v2, nên kết quả bypass có hình dạng giống một posting hợp lệ hơn direct APPROVED insert; guard Sprint 5a không ngăn được đường này.
Đây là blocker thực tế vì feature flag ở frontend không phải security boundary; người dùng có thể gọi /rest/v1/rpc/... trực tiếp.

### Điều kiện bắt buộc trước khi tiếp tục

Phương án khuyến nghị hiện tại là containment ngắn hạn vì dossier xác nhận chưa có UI caller:

- `REVOKE EXECUTE` của `submit_financial_voucher` và `decide_financial_voucher` khỏi `authenticated`.
- Giữ helper private; chỉ cấp lại callable grant bằng migration riêng sau khi contract v2, exact permission và direct REST negative test đã đạt.
- Chuẩn bị/review artifact ngay; chỉ áp production khi owner ra lệnh rõ ràng.

Nếu không chọn containment, hardening tại chỗ phải hoàn tất **trước wiring**:
Kiểm exact backend permission.
Resolve organization từ voucher và kiểm toàn bộ foreign resource cùng organization.
Derive system_source, transaction type, category, amount, account và building từ dữ liệu server.
Không cho public caller tự chọn classification internal_settlement.
Tách internal auto-post thành private helper hoặc RPC chỉ dành cho trusted backend.
Enforce state/version hợp lệ.
Idempotency key gắn với (organization, operation, subject, caller) và payload hash.
Same key + different payload phải fail.
Ghi immutable audit event.
Chứng minh maker-checker.
Có direct REST negative test.
Tôi không thử khai thác bằng cách ghi production.

### P0.2 Nối UI vào approval chưa tạo enforcement
Authenticated hiện vẫn có DML trực tiếp trên các bảng tiền lõi, gồm:

income_expenses
income_expense_items
invoices
invoice_items
payments
excess_amounts
accounts
meter_readings
Do guard Sprint 5a vẫn cho direct APPROVED, việc nối UI sang submit_financial_voucher chỉ tạo đường tốt trong UI, không đóng đường bypass qua REST/table DML.

T1 không được xem là hoàn thành cho đến khi có server-side state-transition enforcement:

DRAFT có thể được tạo/sửa bởi đúng permission.
Client không thể trực tiếp tạo hoặc chuyển sang POSTED/APPROVED.
Posting, approval, reversal chỉ qua canonical RPC.
RLS/trigger kiểm transition ở database, không dựa vào feature flag frontend.
## 3. `record_invoice_payment_v3` và approval contract phải được re-audit

Dossier hiện miễn trừ RPC này tại AUTHORIZATION-PREP-DOSSIER.md:21. Điều đó chưa đủ an toàn.

### 3.1 Permission bị dùng sai domain
RPC kiểm:


can_do_on_building('invoices', 'edit', building_id)
tại 20260713162000_sprint5b3_v3_voucher_owner.sql:31-34.

Trong permission catalog đã có quyền chuyên biệt thu_tien.collect. Một nhân viên có quyền sửa invoice nhưng không có quyền thu tiền vẫn có thể gọi RPC thu tiền nếu chỉ dựa vào invoices.edit.

Trước khi coi v3 là canonical writer, phải:

Dùng exact permission thu_tien.collect hoặc permission canonical tương đương.
Kiểm invoice state có cho phép thu.
Kiểm cashbook/account scope.
Kiểm building, invoice, contract, account, change account, rounding account và item types đều thuộc đúng organization/resource scope.
### 3.2 `SECURITY DEFINER` nhưng tin foreign IDs từ client
p_account_id, change_account_id, rounding_account_id và item type được nhận từ payload rồi insert dưới SECURITY DEFINER tại 20260713162000_sprint5b3_v3_voucher_owner.sql:57-79.

Không nên dựa vào RLS để bảo vệ các IDs này vì SECURITY DEFINER có thể bypass RLS. RPC phải tự resolve và validate same-org/scope trước mọi insert.

### 3.3 Idempotency không có database enforcement và có race đồng thời
Idempotency key chỉ được lưu trên income_expenses. Nếu call không tạo voucher vì thiếu account hoặc payload voucher, payment vẫn được insert nhưng không có durable idempotency record. Retry có thể tạo payment lần hai.

Nghiêm trọng hơn, income_expenses.idempotency_key hiện chỉ là cột text nullable, không có UNIQUE constraint hoặc unique index. RPC thực hiện SELECT tìm key rồi mới INSERT payment/voucher. Hai request đồng thời cùng key có thể cùng không thấy record và đều ghi payment; đây là TOCTOU race, không chỉ là lỗi retry tuần tự.

Ngoài ra cùng key nhưng payload khác hiện trả lại kết quả cũ thay vì báo conflict. Lookup key chạy toàn bảng dưới SECURITY DEFINER và xảy ra trước bước load/authorize invoice, không lọc organization, invoice/subject, operation hoặc caller. Vì vậy collision/reuse hoặc biết trước key có thể làm RPC trả về payment_id/voucher_id của operation không liên quan, kể cả khác tenant, mà không cần vượt qua kiểm tra invoices.edit của invoice đang gửi.

Cần bảng operation-idempotency riêng hoặc unique record được ghi atomically trong mọi nhánh, cùng payload hash và subject/caller/org binding. Cần test concurrent same-key/same-payload và same-key/different-payload, không chỉ retry sau commit.

### 3.4 Approval request có stale-snapshot/TOCTOU trước posting
submit_financial_voucher lưu payload_snapshot và payload_hash, nhưng payload_hash chỉ được tính rồi không được kiểm tra lại. p_idempotency_key cũng là tham số chết: có trong signature nhưng không được đọc trong thân hàm.

Trong khi request chờ duyệt, direct table DML hiện vẫn có thể sửa voucher. decide_financial_voucher sau đó gọi _post_financial_voucher trên row hiện tại mà không lock/reload và so hash với snapshot đã được người duyệt xem. Hệ quả là request có thể được duyệt cho dữ liệu A nhưng posting áp lên dữ liệu B.

Bắt buộc trước wiring:

Khóa hoặc giới hạn mutation của voucher khi đã submit.
Lock subject row trong decide/post.
Recompute canonical payload hash và so với snapshot/hash đã submit; mismatch phải fail hoặc tạo submission/version mới.
Derive classification và foreign IDs từ dữ liệu server, không đưa trường client-controlled chưa chuẩn hóa vào hash contract.
_post_financial_voucher phải kiểm expected state/version, assert đúng một affected row và từ chối re-post.

### 3.5 Audit event hiện là zero, không phải chỉ “chưa đầy đủ”
Trong submit_financial_voucher, decide_financial_voucher và _post_financial_voucher không có lệnh ghi authorization_audit_events. Vì vậy live có 0 audit event không chỉ do chưa có request; implementation hiện tại sẽ không tạo audit trail này ngay cả khi RPC được gọi.

Trước wiring phải định nghĩa event tối thiểu cho submit, rule match, auto-post, approve/reject, conflict, reversal và emergency action; event phải append-only, hash-chain được enforce và mọi organization_id phải resolve non-null cho tenant event.

### 3.6 Posting helper không kiểm transition và không assert affected row
_post_financial_voucher UPDATE income_expenses chỉ theo id + deleted_at IS NULL, không kiểm approval_status hiện tại, request/state/version tương ứng, organization hay posting_id cũ. Hàm cũng không GET DIAGNOSTICS/raise nếu UPDATE voucher ảnh hưởng 0 row; sau đó vẫn chuyển approval_requests sang POSTED và trả posting_id.

Do đó helper có thể re-post/ghi đè posting metadata hoặc tạo split-brain request POSTED trong khi voucher không được post. Contract v2 phải dùng transition predicate đầy đủ, lock row, assert đúng một row ở cả voucher/request update và fail transaction nếu invariant không đạt.

### 3.7 Resubmit sau terminal state hiện bị khóa bởi `submission_no`
approval_requests có UNIQUE (organization_id, subject_type, subject_id, submission_no) và submission_no mặc định 1. Plan yêu cầu tăng submission_no dưới lock để cho phép reject/cancel rồi sửa và resubmit, nhưng submit_financial_voucher không tính hoặc truyền submission_no.

Sau request đầu tiên chuyển REJECTED, DENIED hoặc CANCELLED, lookup “open request” không trả row nhưng INSERT lần sau vẫn dùng submission_no=1 và đụng unique constraint. Cần cấp số lần submit atomically dưới subject lock, giữ lịch sử terminal và test resubmit/concurrent resubmit.

### 3.8 Nhánh super-admin không phải member tự mâu thuẫn với composite foreign key
submit_financial_voucher cho phép super-admin vượt qua kiểm membership. Nếu caller không có membership trong organization, code lấy một membership OWNER bất kỳ làm maker_membership_id nhưng vẫn giữ maker_user_id là auth.uid() của super-admin.

approval_requests lại có composite foreign key (organization_id, maker_membership_id, maker_user_id) tới cùng một row organization_memberships. Cặp membership OWNER + user_id super-admin không khớp, nên INSERT sẽ fail cho super-admin không đồng thời là owner/member đó. Không được mượn membership của người khác để đại diện actor; contract phải định nghĩa principal/membership attribution hợp lệ cho elevated action và audit riêng.

### 3.9 Schema state không khớp reversal contract
Comment/state model khai báo có REVERSED, dossier cũng dự kiến reverse_financial_posting, nhưng CHECK của approval_requests.state chỉ cho PENDING_APPROVAL, POSTED, DENIED, REJECTED, CANCELLED. Không thể ghi REVERSED theo schema hiện tại.

Trước khi xây reversal phải chốt state model, migration constraint, allowed transitions, posting/reversal links và cách biểu diễn original immutable + compensating posting. Không nên dựng reverse RPC trên enum/check contract hiện tại.

## 4. Những điểm dossier phải sửa trước khi ký duyệt

### 4.1 Sửa giao kèo “additive = có thể áp live”
Đoạn AUTHORIZATION-PREP-DOSSIER.md:10-15 đang phân loại RPC mới là additive và có thể áp bất kỳ lúc nào.

Điều này không đúng với callable RPC:

CREATE FUNCTION SECURITY DEFINER
cộng GRANT EXECUTE TO authenticated
là mở API production ngay lập tức, dù UI có zero caller hay feature flag OFF.
Nên phân thành ba loại:

| Loại | Ví dụ | Vị trí chuẩn bị |
|---|---|---|
| Schema-only inert | Nullable column, table không grant, index | Có thể review như additive |
| Callable surface | RPC/Edge endpoint/Storage policy có grant | Không được xem inert; cần threat model + negative test + deploy approval |
| Enforcement/cutover | RLS, REVOKE DML, behavior flip | Pending-window, canary và sign-off |
Nếu mục tiêu là “chuẩn bị tất cả nhưng chưa áp live”, SQL chưa duyệt không nên nằm trong migration path mặc định. Header STATUS: PREPARED không ngăn migration runner áp file.

An toàn hơn:

Để artifact chưa duyệt ngoài supabase/migrations/.
Sau khi duyệt mới đưa thành timestamp migration thật; hoặc
Deploy schema/function với không có authenticated EXECUTE, rồi grant bằng migration riêng sau gate.
### 4.2 Sửa danh sách nền đã có
Tại AUTHORIZATION-PREP-DOSSIER.md:19-25:

Xóa claim emergency_approve_financial đã tồn tại.
Đổi “approval engine” thành “approval schema + prototype RPC chưa đạt acceptance”.
Đổi “ACL definer” thành “differential gate; baseline chưa burn-down”.
Đổi “payment v3 hoàn tất” thành “đã wire nhưng còn audit exact permission/scope/idempotency”.
Đổi “org boundary” thành “additive restrictive boundary; NULL/fallback và legacy policy chưa cutover”.
### 4.3 Không coi 51 hạng mục là closed inventory
Cần bổ sung ít nhất các workstream sau:

Approval RPC containment/hardening.
RBAC dual-write và source-of-truth cutover.
authorization_version bump/invalidation server-side.
Staff invite/suspend/revoke lifecycle.
Retire delete_staff_member hard-delete.
Rule-set bootstrap/publish/version/retire/admin UI.
Backfill và classification existing financial records.
R2/Edge organization/resource authorization.
Direct REST/RPC/Storage negative test harness.
Full SECURITY DEFINER baseline burn-down.
Expanded financial reconciliation.
Maintenance, forward-fix, backup/PITR và incident runbook.
Chưa nên đưa ra một tổng ngày công mới trước khi các track này được chia thành deliverables và dependencies.

## 5. T1 phải thiết kế lại
B-i1 tại AUTHORIZATION-PREP-DOSSIER.md:108 hiện gom quá nhiều việc và bắt đầu sai điểm.

Không nên bắt đầu bằng reverse_financial_posting + wire submit/decide.

### T1 đề nghị

#### T1a — containment
Cô lập callable approval RPC hiện tại.
Chốt exact permission keys.
Đóng client-controlled classification.
Không expose emergency approval.
#### T1b — approval contract v2
Hoàn thiện:

State machine.
Expected version/concurrency.
Idempotency + payload hash, có DB uniqueness và conflict semantics.
Subject immutability/revalidation từ submit tới post.
submission_no/resubmit atomically dưới lock.
Candidate materialization từ cấu hình thật.
Multi-step ANY/ALL/QUORUM.
Maker-checker.
Exact decide permission.
Posting affected-row assertions.
Audit event.
Immutable posted state.
Reversal links và unique constraints.
#### T1c — rule governance
Organization bootstrap.
DRAFT → publish → ACTIVE → RETIRED.
Không sửa trực tiếp ACTIVE rule.
Validation phải luôn có fallback hoặc fail-closed.
Existing open request dùng snapshot/version cũ.
Admin UI có exact permission.
Audit publish/retire.
#### T1d — reversal
Chỉ sau khi posting invariant đã đóng:

Original posting immutable.
Reversal có posting ID riêng.
Một original chỉ được reverse một lần hoặc theo state machine rõ ràng.
Reverse amount/account/item được derive từ original, không tin client.
Không hard-delete original payment/voucher.
Reconciliation chứng minh tổng ledger trung hòa.
#### T1e — shadow và test
RPC chưa được wire production.
Test qua JWT thật và direct PostgREST.
Shadow-evaluate rule trên dữ liệu hiện có.
So sánh intended decision với hành vi legacy.
Không có unexplained mismatch mới được canary.
#### T1f — wiring và enforcement
Hook sau feature flag.
Nhưng security enforcement phải ở DB.
Canary một organization hoặc một transaction class.
Có metric, alert, rollback/forward-fix và owner sign-off.
## 6. Thứ tự hiện tại trong dossier cần đổi
Đoạn AUTHORIZATION-PREP-DOSSIER.md:127-136 ghi “KHÔNG đảo — plan §27”, nhưng thực tế không khớp plan gốc:

Dossier đặt REVOKE DML trước RLS v2.
RLS v2 lại nằm sau approval/financial flips.
ACL hardening để gần cuối.
C1/C4 chưa được đưa thành prerequisite cứng.
### Thứ tự an toàn hơn
P0 containment approval RPC và re-audit payment v3.
Chốt source of truth RBAC, dual-write, staff lifecycle và authorization-version.
Xây test harness + observability + runbook trước mọi behavior flip.
Hoàn thiện approval engine nhưng giữ non-callable hoặc flag OFF.
RLS v2 shadow/read validation theo từng domain.
Group A canonical RPC theo từng domain, exact authorization và idempotency.
Wire frontend dưới flag, chạy dual-path/shadow nếu có thể.
Trong từng domain window:
Freeze writes phù hợp.
Reconcile pre-state.
Bật server-side state transition/RLS guard.
Canary.
Flip canonical writer.
Revoke direct DML của domain khi mọi writer đã drain.
Reconcile post-state.
B-money từng flow, không flip toàn bộ cùng lúc.
Storage/R2 cutover và full ACL burn-down theo tranche độc lập.
Retention period rồi mới drop legacy.
Đặc biệt, B-i5 không nên là một lần REVOKE khổng lồ sau toàn bộ B-money. Mỗi domain nên có drain/revoke gate riêng. Đối với bảng dùng chung như income_expenses, có thể cần RLS/trigger chặn POSTED transition trước, trong khi vẫn cho phép direct DRAFT đến khi writer migration hoàn tất.

## 7. Các track bị thiếu

### 7.1 RBAC synchronization
20260713110200_sprint2c_materialize_rbac.sql là materialization một lần. Trong khi đó UI staff vẫn ghi staff_assignments và legacy role data.

Cần:

Chọn nguồn sự thật.
Dual-write có transaction hoặc canonical admin RPC.
Backfill có checksum.
Shadow comparison legacy vs v2.
Mutation nào cũng bump organization authorization_version.
Cutover read path.
Retention rồi mới xóa legacy JSON/assignment semantics.
Nếu bỏ qua, quyền user thay đổi trên UI có thể không xuất hiện trong authorize_v2, hoặc quyền đã thu hồi vẫn tồn tại trong normalized binding.

### 7.2 Staff lifecycle
useStaffAssignments.ts vẫn dùng delete_staff_member, có thể xóa auth.users và cascade dữ liệu.

Target cần là:

Invite.
Accept.
Suspend.
Revoke membership/role binding.
Preserve historical ownership/audit attribution.
Không xóa identity để “thu hồi quyền”.
Tách privacy deletion khỏi authorization offboarding.
Retire hoặc khóa ACL của delete_staff_member.
Test nhân viên bị suspend mất quyền ngay nhưng lịch sử ledger vẫn còn.
### 7.3 Approval rule lifecycle
Rule hiện chỉ seed cho hai organization hiện hữu. Cần xử lý:

Organization mới.
Không có active rule set.
Rule conflict/same priority.
Effective dates.
Publish atomic.
Request đang mở khi rule mới được publish.
Emergency permission.
Admin rule editor.
Audit thay đổi rule.
Fail-closed khi rule resolution không duy nhất.
### 7.4 Storage, Edge và R2
Cả tám bucket được đánh dấu private, nhưng private=true không chứng minh tenant isolation; policy mới là enforcement.

Dossier phải bao gồm:

Direct Storage API negative tests.
Object-to-organization/resource linkage.
Key server-generated.
Signed URL/private delivery.
Copy-not-delete migration.
Dual-read.
R2 upload intent.
Organization/resource authorization trên Worker.
Loại bỏ phụ thuộc namespace chỉ theo user.
/sign lifecycle.
Orphan cleanup.
Audit upload/delete/download metadata.
infra/cloudflare-worker/src/index.ts hiện mới containment theo user, chưa phải organization/resource model mục tiêu.

## 8. Test và acceptance gate còn thiếu

### 8.1 Cross-tenant test hiện chưa chứng minh org boundary
scripts/test-cross-tenant.mjs pass, nhưng fixture:

Disable trigger.
Không tạo organization/membership đầy đủ.
Bỏ organization_id.
Policy mới cho organization_id IS NULL.
Vì vậy test chủ yếu xác minh legacy owner/building graph, chưa xác minh RLS v2.

Test mới phải:

Tạo hai organization thật.
Tạo owner/admin/staff và memberships thật.
Tạo row non-null organization.
Không disable trigger cho đường test chính.
Test qua REST với JWT thật.
Có cả expected-deny và expected-allow.
Bao phủ SELECT/INSERT/UPDATE/DELETE/RPC.
Test resource ID của tenant khác được gửi vào SECURITY DEFINER RPC.
Test stale/suspended membership.
Test NULL organization insert fail-closed trên tenant table.
### 8.2 Approval tests bắt buộc
Cần ít nhất:

Member không có submit permission.
Client giả internal_settlement.
Maker tự approve.
Candidate cũ sau khi role bị revoke.
Hai approver quyết định đồng thời.
Retry cùng key/cùng payload.
Cùng key/khác payload.
Hai request đồng thời cùng key/cùng payload chỉ tạo đúng một operation.
Collision/reuse key khác organization/invoice/caller không trả ID của operation khác.
Retry sau commit.
Sửa voucher sau submit rồi decide phải bị chặn hoặc tạo submission/version mới.
Reject/cancel rồi sửa và resubmit; concurrent resubmit chỉ cấp một submission_no mới.
Posting khi subject bị xóa/đổi state hoặc affected-row=0 phải rollback toàn bộ.
Rule publish trong khi request đang mở.
Multi-step ANY/ALL/QUORUM.
Emergency override không đủ quyền/reason.
Super-admin không có membership vẫn có attribution hợp lệ, không mượn membership OWNER của người khác.
Double reversal.
Transition POSTED→REVERSED dùng schema/state hợp lệ và giữ original immutable.
Posting khi voucher state sai.
Cross-organization voucher/account/building IDs.
Audit row không thể update/delete.
### 8.3 Reconciliation phải mở rộng
scripts/reconcile-money.mjs hiện tốt cho bài toán cap-1000 và approved INCOME theo tháng, nhưng chưa đủ làm rollout gate.

Cần đối chiếu thêm:

INCOME và EXPENSE.
Invoice total/paid/status.
Payment sum.
Excess/credit balance.
Deposits/refunds.
Salary payout.
Profit distribution.
Cashbook opening/closing balance.
Meter reading → invoice effects.
Reversal pairs.
Orphan voucher/payment/item.
Duplicate idempotency operation.
Tổng theo organization, account, month và transaction domain.
### 8.4 CI
Các script quan trọng nên có npm scripts và chạy trong CI:

Definer ACL.
View invoker.
Cross-tenant REST test.
Authorization contract tests.
Approval concurrency/idempotency tests.
Money reconciliation ở môi trường phù hợp.
Generated Supabase types drift check.
check-definer-acl phải có thêm chế độ “baseline burn-down”; pass với 100 function baseline chỉ chứng minh không tăng thêm exposure.

## 9. Operational gate trước maintenance window
Trước bất kỳ flip nào phải có artifact ký duyệt:

Danh sách chính xác table/function/policy/signature thay đổi.
Writer inventory và bằng chứng từng writer đã migrate.
Backup/PITR trạng thái healthy và restore procedure đã kiểm.
Freeze procedure.
Canary organization/flow.
Expected-deny và expected-allow queries.
Reconciliation pre/post.
Dashboard:
deny rate;
RPC errors;
approval latency;
idempotency conflicts;
cross-org denial;
reconciliation drift.
Abort thresholds.
Forward-fix procedure.
Đối với ledger đã post, “rollback” không được hiểu là xóa/revert dữ liệu. Phải dùng forward-fix hoặc reversal có audit.

## 10. Sửa tracker đề nghị

Tracker hiện tại tại AUTHORIZATION-PREP-DOSSIER.md:159-168 nên đổi thành:

| Tranche | Nội dung | Trạng thái |
|---|---|---|
| T0a | Inventory/dossier ban đầu | Đã làm |
| T0b | Sửa dossier sau independent audit | Chưa |
| T1a | Contain/harden exposed approval RPC | Chưa |
| T1b | Re-audit payment v3 exact permission/scope/idempotency | Chưa |
| T2 | RBAC synchronization + staff lifecycle + authorization-version | Chưa |
| T3 | Approval contract/rule governance/reversal, chưa wire | Chưa |
| T4 | Authorization/API/concurrency/reconciliation harness | Chưa |
| T5 | Group A canonical writers theo domain, callable grant review riêng | Chưa |
| T6 | RLS v2 shadow + per-domain read/write cutover | Chưa |
| T7+ | B-money canary/flip/drain/revoke theo domain | Chưa |
| T8 | Storage/R2 và full ACL cutover | Chưa |
| T9 | Retention, cleanup, legacy removal | Chưa |

## 11. Cửa GO tối thiểu
Chỉ chuyển từ NO-GO sang thử canary khi tất cả điều sau đạt:

Approval RPC không còn membership-only bypass.
Client không chọn được internal auto-post classification.
Payment v3 dùng exact collect permission, same-org validation và idempotency được enforce atomically ở database.
Approval posting revalidate payload/state/version, assert affected rows và không thể re-post.
Resubmit dùng submission_no mới dưới lock, không làm mất lịch sử terminal.
RBAC legacy/v2 không còn unexplained mismatch.
Staff suspend/revoke hoạt động mà không xóa identity/history.
Approval engine đạt state-machine, concurrency, idempotency và audit tests.
Direct table DML không thể bypass APPROVED/POSTED transition.
Cross-tenant REST/RPC/Storage negative tests pass.
Mọi SECURITY DEFINER function trong tranche có explicit signature ACL và pinned search path.
Generated Supabase types không drift.
Reconciliation pre-state bằng reconciliation post-state.
Dashboard, abort criteria và forward-fix runbook sẵn sàng.
Có maintenance window và lệnh owner rõ ràng cho từng enforcement tranche.
## Kết luận cuối

Branch hiện tại không thêm runtime vulnerability mới, vì diff chỉ là dossier và xóa local settings khỏi Git. Tuy nhiên, nếu dùng dossier hiện tại làm chỉ dẫn triển khai thì có nguy cơ tạo false confidence nghiêm trọng.

Điểm quan trọng nhất:

Approval RPC hiện không “inert” dù UI chưa gọi, vì đã được cấp EXECUTE cho authenticated; submit_financial_voucher kiểm membership nhưng không kiểm exact permission và tin classification do client gửi.

Do đó:

T0 đã hoàn thành.
T1 trở đi chưa bắt đầu.
Dossier chưa đủ điều kiện ký duyệt thực thi.
Không nên wire approval engine, không nên triển khai Group A theo phân loại hiện tại, và tuyệt đối chưa tiến hành enforcement/cutover.
Bước tiếp theo đúng là sửa dossier và thiết kế một tranche P0 containment/hardening riêng; chưa cần và chưa nên bắt đầu reverse_financial_posting trước khi posting contract gốc được đóng an toàn.
