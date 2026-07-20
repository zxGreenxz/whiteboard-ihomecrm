# Kế hoạch triển khai Trung tâm Báo cáo Tài chính & Hiệu quả kinh doanh

| Thuộc tính | Giá trị |
|---|---|
| Baseline code | `HEAD c736a29` |
| Ngày đối chiếu | `2026-07-20` |
| Trạng thái | Kế hoạch triển khai; chưa phải mô tả tính năng đã hoàn tất |
| Route mục tiêu | `/reports/finance/profit-distribution` |
| Route legacy còn hoạt động | `/reports/finance/analysis` |

## Tóm tắt điều hành

Kế hoạch này hợp nhất trải nghiệm báo cáo nhưng **không hợp nhất số liệu bằng cách viết lại KQKD**. Báo cáo Doanh thu & Chi phí hiện tại vẫn là baseline cần bảo toàn; 5 tab phân tích cũ được tái sử dụng hoặc giữ ở route legacy cho đến khi từng destination mới đạt parity. Cutover chỉ diễn ra sau khi các gate về số tiền, lỗi query, quyền/self-view, tenant scope, restricted data, cohort hóa đơn và snapshot đều xanh.

Trạng thái đích là một shell dùng chung trên desktop/mobile, một nguồn filter có kiểu rõ ràng, các leaf-view lazy-load theo quyền, aggregate tài chính được bảo vệ server-side và mọi số liệu lịch sử đều công khai nguồn thời gian. Không hiển thị tab placeholder, không đổi lỗi tải dữ liệu thành số 0 và không dựng snapshot quá khứ giả định.

## Đã kiểm chứng trong codebase

| Hiện trạng đã kiểm chứng | File/dòng/symbol | Hệ quả cho kế hoạch |
|---|---|---|
| Hai route đang render hai page độc lập: Profit Hub không có route-level report guard; Analysis có `RequirePermission(reports_finance.analysis)`. | `src/App.tsx:371` (`ProfitHubPage`), `src/App.tsx:379` (`FinancialAnalysisReport`) | Chưa được redirect Analysis cho đến khi có destination tương đương và guard tương thích. |
| Profit Hub tính `canReport` từ `reports_finance.profit_distribution`; self-view cổ đông lại phụ thuộc `me && canReport`. | `src/pages/reports/finance/ProfitHubPage.tsx:33`, `src/pages/reports/finance/ProfitHubPage.tsx:44`, `src/pages/reports/finance/ProfitHubMobile.tsx:61` | Đây là regression có sẵn đối với cổ đông thuần; phải tách quyền self-view khỏi quyền xem báo cáo KQKD. |
| Analysis hiện có đúng 5 tab: Tổng quan, Doanh thu, Chi phí, Lợi nhuận, Vận hành. | `src/pages/reports/finance/FinancialAnalysisReport.tsx:23`, `src/pages/reports/finance/FinancialAnalysisReport.tsx:131` | Feature matrix cutover phải chỉ rõ destination cho cả 5 tab, không chỉ tab Tổng quan. |
| Analysis chủ động nạp cả tòa ảo; P&L/type breakdown hiện cũng cho tòa ảo đi vào tập kết quả. | `src/pages/reports/finance/FinancialAnalysisReport.tsx:48`, `supabase/migrations/20260611140000_financial_analysis_rpcs.sql:13`, `supabase/migrations/20260611140000_financial_analysis_rpcs.sql:44` | Báo cáo chính mới phải physical-only ở server; tòa ảo chỉ đi qua query kiểm tra riêng. |
| Occupancy v2 đã có RPC snapshot hiện tại và upcoming vacancy, kèm hook và script kiểm thử SQL. | `supabase/migrations/20260710180000_occupancy_v2_rpcs.sql:42`, `supabase/migrations/20260710180000_occupancy_v2_rpcs.sql:133`, `src/hooks/reports/useOccupancyDashboard.ts:72`, `scripts/test-occupancy-v2.mjs:1` | Tái sử dụng định nghĩa 5 nhóm hiện tại; snapshot lịch sử mới phải giữ đúng partition này. |
| Test trong phạm vi hiện tại chủ yếu là pure utils/permission; chưa có route/component/RPC coverage cho trung tâm tài chính. | `src/components/finance-analysis/__tests__/utils.test.ts:1`, `src/lib/__tests__/permissionPages.test.ts:1`, `src/lib/__tests__/accrualAllocation.property.test.ts:1` | Phase 0 phải thêm characterization, route, component, SQL/ACL và cross-tenant tests trước cutover. |
| Nhiều query tài chính hiện fail-open hoặc trả dữ liệu một phần: accrual trả `EMPTY`, list/stats trả rỗng/0, verification chỉ log lỗi; Analysis có throw nhưng vẫn ép numeric lỗi/null về 0. | `src/hooks/useAccrualReport.ts:238`, `src/hooks/income-expenses/queries.ts:368`, `src/hooks/income-expenses/queries.ts:583`, `src/hooks/useProfitVerification.ts:101`, `src/hooks/useFinancialAnalysis.ts:37`, `src/hooks/useFinancialAnalysis.ts:66` | Error contract phải được harden trước khi dùng các card làm nguồn quyết định. |
| `canUse` đã áp fallback legacy từ action chi tiết về `reports_finance.view`; model navigation hiện chỉ nhận một cặp module/action. | `src/lib/permissionPages.ts:517`, `src/lib/permissionPages.ts:520`, `src/lib/permissionPages.ts:651`, `src/components/layout/Sidebar.tsx:48`, `src/pages/home/launcherTiles.ts:38` | Shell và navigation cần helper `anyOf` nhưng vẫn giữ đúng fallback legacy và explicit deny. |
| Migration 13/07 chỉ cấp cổ đông thuần `shareholder_profit.view`; `authorize_v2` được ghi rõ là SHADOW/INERT và không grant client. | `supabase/migrations/20260713090000_sprint0_fail_closed_permissions.sql:71`, `supabase/migrations/20260713110300_sprint2d_authorize_v2.sql:1` | Không được giả định Authz v2 đang bảo vệ RPC; RPC mới phải tự enforce quyền báo cáo, org và building scope. |
| `get_my_permissions()` chọn một assignment bằng `LIMIT 1`, còn `can_access_building()` có thể chấp nhận assignment khác; một user có thể có nhiều active organization. | `supabase/migrations/20260713090000_sprint0_fail_closed_permissions.sql:83`, `supabase/migrations/20260710150000_tenant_isolation_hardening.sql:79`, `supabase/migrations/20260713100000_sprint1_organization_foundation.sql:68` | Filter phải có selected organization và RPC phải bind action/membership/building trong cùng assignment, không ghép hai helper độc lập. |
| Cùng một org có thể có nhiều assignment full-scope/area/building chồng lấn; unique index cũ không ngăn nhiều row có `building_id NULL`. | `supabase/migrations/20250101000008_create_roles_and_staff_assignments.sql:40`, `supabase/migrations/20250101000008_create_roles_and_staff_assignments.sql:49` | Exact-scope helper phải có specificity/deny precedence xác định, không OR mọi permission tùy ý. |
| Restricted policy hiện hành ẩn voucher restricted khỏi cả row và total; trả exact `restricted_delta` sẽ là thay đổi confidentiality có thể suy luận số tiền. | `supabase/migrations/20260613000000_ie_restricted_categories.sql:10`, `supabase/migrations/20260613000000_ie_restricted_categories.sql:39`, `src/lib/permissionPages.ts:358` | Mặc định giữ strict mode; redacted aggregate chỉ sau owner/security approval và inference tests. |
| `invoices.total_amount` gồm `previous_debt`; khi target invoice chuyển `PAID`, trigger có thể mark source invoice paid mà không tạo cash event mới. | `src/hooks/useInvoices.ts:591`, `supabase/migrations/20260527000051_invoice_previous_debt.sql:63`, `supabase/migrations/20260611140000_financial_analysis_rpcs.sql:322` | Cohort cần component/payment-allocation ledger; lọc kind/status và dedupe source ID thôi chưa đủ. |

## Mục lục

0. Blocker và cutover gates
1. Hiện trạng và flow mục tiêu
2. Kiến trúc thông tin, điều hướng và quyền
3. Phạm vi dữ liệu và bộ lọc chung
4. Quy tắc tòa ảo
5. Nội dung, công thức và data contract từng tab
6. Nguồn số liệu, RPC, security và error contract
7. Snapshot lịch sử phòng/hợp đồng
8. Trình bày, biểu đồ và accessibility
9. Định nghĩa, độ mới và giới hạn
10. Export
11. Kế hoạch theo phase
12. Critical files
13. Test plan
14. Verification
15. Acceptance criteria
16. Ngoài phạm vi

# 0. Blocker và cutover gates

Không bắt đầu redirect hoặc xóa implementation cũ chỉ vì shell mới đã render được. Mỗi gate dưới đây phải có bằng chứng test/đối soát lưu cùng PR triển khai.

| Gate bắt buộc | Điều kiện qua gate | Nếu chưa đạt |
|---|---|---|
| Parity P&L | Doanh thu, Chi phí, LN và breakdown tie-out với `ProfitDistributionReport`, `fa_monthly_pnl[_accrual]` và verification ở cả `ACCRUAL`/`VOUCHER_DATE`, gồm deposit, override, no-item, invoice month, tòa vật lý và policy restricted đã được phê duyệt. | Dừng cutover; sửa nguồn/contract, không bù số ở UI. |
| Query failure không thành 0 | Hook trả typed error; UI phân biệt loading/error/retry/empty; verification lỗi hoặc thiếu nguồn hiển thị `Không thể đối soát`, không bao giờ màu xanh. | Không dùng card/tab đó làm headline hoặc export. |
| Permission và self-view | Matrix legacy fallback, explicit action, pure shareholder, manager, salary-only và URL trực tiếp đều xanh trên desktop/mobile. | Giữ route/tab cũ; không thay navigation. |
| Organization/assignment binding | Mỗi request có `organizationId` rõ ràng; permission/membership/building cùng org, overlap dùng specificity + global deny-wins, gồm cross-org và same-org overlapping-assignment tests. | Không phát hành RPC/shell mới cho user multi-org. |
| Restricted category semantics | Owner/security chọn một contract: giữ strict confidentiality hiện tại, hoặc cho phép redacted aggregate sau inference review. Export giữ cùng contract và vẫn cần `reports_finance.export`. | Mặc định fail closed; không phát hành breakdown/detail/export mới. |
| Invoice cohort | Cohort chính chỉ `kind='MONTHLY'` và status đã phát hành/phải thu; `DRAFT`/`PENDING_APPROVAL` và `SETTLEMENT` tách riêng; billed principal, payment allocation, deposit source và carry-forward cascade đã được định nghĩa/test. | Không gọi KPI là billed/collection rate chính thức. |
| Snapshot capture | Capture-run atomic, `organization_id NOT NULL`, provisional replace-set không stale, finalized immutable; cutoff bị lỡ thành `MISSED`, không backfill từ bảng mutable. | Chỉ hiển thị Occupancy v2 live; lịch sử ghi `Chưa có snapshot`. |
| Feature matrix 5 tab | Mỗi chức năng của 5 tab Analysis cũ có destination mới, permission, mobile behavior, error state và export tương đương hoặc quyết định bỏ có phê duyệt. | Giữ `/reports/finance/analysis` render nội dung cũ hoặc compatibility leaf. |
| Cutover route | Tất cả gate trên xanh và deep-link/back-forward/direct URL đã test. | **Không redirect** `/reports/finance/analysis`; tuyệt đối không expose tab placeholder. |

---

Trang `/reports/finance/profit-distribution` hiện là **baseline vận hành** cho Doanh thu — Chi phí vì nó bám đúng logic KQKD, dồn tích, loại cọc, trạng thái duyệt và có đối soát. Đây là điểm đối chiếu đã kiểm chứng, nhưng quyền truy cập, restricted category và hợp đồng lỗi vẫn phải được kiểm tra ở server. Bức tranh quản trị đang bị chia thành nhiều nơi: báo cáo chi tiết ở `profit-distribution`, phân tích 5 tab ở `/reports/finance/analysis`, lấp đầy ở báo cáo bất động sản, còn công nợ/thu tiền ở luồng hóa đơn. Chủ doanh nghiệp phải tự ghép các con số để biết tòa nào đang hiệu quả, phòng trống đang ảnh hưởng ra sao và việc gì cần xử lý trước.

Mục tiêu là biến URL hiện tại thành **một trung tâm Báo cáo tài chính & Hiệu quả kinh doanh**, dùng lại toàn bộ logic đã có thay vì tạo hệ thống phân tích thứ ba. Báo cáo Doanh thu & Chi phí hiện tại được giữ nguyên về định nghĩa và trở thành một tab con. Các tab mới phục vụ đồng thời chủ doanh nghiệp, quản lý vận hành và kế toán, nhưng trình bày theo ngôn ngữ dễ hiểu, có công thức/nguồn dữ liệu/giới hạn rõ ràng.

Các quyết định nghiệp vụ đã thống nhất:

- Mô hình chính: **thuê tòa rồi cho thuê lại phòng**.
- Tất cả khoản đã được phân loại vào **KQKD** đều thuộc báo cáo chính.
- Cơ sở mặc định: **dồn tích theo kỳ áp dụng**; vẫn có chế độ **theo ngày phiếu để đối chiếu**.
- Chi phí thuê chủ nhà hiện được nhập bằng phiếu **“Tiền nhà” theo từng tòa**.
- Hóa đơn chủ yếu lập theo tháng và thu trong tháng.
- Chưa có quy trình chốt sổ tài chính độc lập; không được coi tab “Chốt LN tháng” của cổ đông là khóa sổ kế toán.
- “Kho Văn Phòng Chung” là tòa ảo có chi phí chưa xác minh: mặc định loại hoàn toàn khỏi báo cáo chính. Khi bật nút gạt chỉ hiện khu vực kiểm tra riêng, **không cộng vào tổng**.
- Giai đoạn đầu không dùng các ngưỡng tài chính tùy ý để gắn nhãn tốt/xấu/nguy hiểm. Chỉ thống kê, so sánh, giải thích biến động và nêu sự kiện cần chú ý dựa trên dữ kiện.
- Bắt đầu lưu snapshot phòng/tình trạng/giá/hợp đồng từ khi triển khai; tuyệt đối không dựng lại dữ liệu quá khứ giả định.
- Ưu tiên triển khai sâu trước: **(1) lợi nhuận và điểm hòa vốn/lấp đầy hòa vốn từng tòa, (2) lấp đầy & phòng trống**.
- Điểm hòa vốn đã chốt theo mô hình hai lớp: KQKD toàn tòa và riêng doanh thu phòng; chi phí được mapping cố định/biến đổi theo từng loại; hiện đồng thời công suất hiện tại/lý thuyết và tháng chọn/bình quân 3 tháng.

---

# 1. So sánh flow hiện tại và flow mục tiêu

## 1.1. Flow dữ liệu/nghiệp vụ hiện tại

1. Quản lý tạo phòng, hợp đồng và giá thuê.
2. Hệ thống lập hóa đơn tháng; thu tiền tạo payment/phiếu thu liên kết hóa đơn.
3. Kế toán nhập phiếu chi, trong đó “Tiền nhà” là chi phí thuê chủ nhà theo từng tòa.
4. Phiếu được duyệt và xác định phần KQKD; item cọc được loại theo `kqkd_amount` trừ khi có override.
5. `/reports/finance/profit-distribution` hiển thị chi tiết Thu — Chi:
   - ngày phiếu dùng aggregate `get_income_expense_layer_stats` cho số tổng;
   - dồn tích phân bổ theo `billing_month` hoặc kỳ áp dụng;
   - bảng chi tiết có thể bị giới hạn số dòng nhưng số tổng không lấy từ bảng;
   - `ProfitVerificationBar` đối chiếu với SQL tài chính.
6. `/reports/finance/analysis` có sẵn KPI, biểu đồ và 5 tab phân tích, nhưng là một trang riêng, đang cho tòa ảo tham gia P&L tổng và có một số nhận định theo ngưỡng tùy ý.
7. Lấp đầy/phòng trống chính xác hơn nằm ở `occupancy_snapshot_v2`, tách khỏi luồng tài chính.
8. Sau cùng, module cổ đông chốt và phân phối lợi nhuận; logic này đã loại tòa ảo và phải được giữ nguyên.

## 1.2. Điểm chưa phù hợp với quy trình điều hành

- Có hai trung tâm gần trùng nhau (`profit-distribution` và `analysis`).
- “Kho Văn Phòng Chung” có thể làm sai cảm nhận về tổng chi phí/lợi nhuận công ty.
- Tổng quan, lợi nhuận từng tòa, phòng trống, công nợ và chi tiết chứng từ chưa tạo thành một đường drill-down liên tục.
- Tab phân tích hiện dùng từ “tiền mặt” cho cơ sở ngày phiếu, trong khi ngày phiếu không đồng nghĩa ngày thực thu/thực chi.
- Một số biểu đồ có hai trục Y, màu hạng mục đổi theo thứ hạng và thiếu bảng dữ liệu tương đương.
- `buildInsights` đang dùng ngưỡng cố định như biên LN 20%, lấp đầy 85%, thu hồi 90%; các ngưỡng này chưa được người dùng phê duyệt.
- Lịch sử lấp đầy hiện suy từ hợp đồng nhưng dùng tồn kho phòng hiện tại làm mẫu số; không đủ để khẳng định vacancy-days/lost rent lịch sử.
- “Top 10 khoản chi” hiện chỉ xếp trong tối đa 100 phiếu đã tải, không chắc là top thật.
- Lỗi query ở một số màn có thể bị biểu diễn giống dữ liệu rỗng/0, không phù hợp với số liệu tài chính.
- Quyền restricted category của aggregate và detail chưa cùng một hợp đồng; một số RPC `SECURITY DEFINER` hiện không tự kiểm tra quyền báo cáo/building scope.
- SQL và client chưa đồng nhất với kỳ bất thường: period một phía NULL hoặc `end < start` có thể được SQL phân bổ nhưng bị client loại khỏi kết quả.
- `fa_snapshot_kpis`/occupancy hiện là ảnh chụp live; nếu đặt cạnh P&L của tháng cũ sẽ trộn hai mốc thời gian.
- `fa_invoice_collection` đang trộn cohort `MONTHLY`, trạng thái chưa phát hành và `SETTLEMENT`; carry-forward từ `previous_debt_sources` có nguy cơ đếm đôi.
- `buildInsights` còn các ngưỡng cứng và `useFinancialAnalysis` có thể ép giá trị lỗi/null thành 0, làm mất dấu chất lượng dữ liệu.

## 1.3. Flow mục tiêu

1. Người dùng vào một URL duy nhất: `/reports/finance/profit-distribution`.
2. Chọn tháng, tòa vật lý và cơ sở ghi nhận ở thanh lọc chung.
3. Mở `Tổng quan kinh doanh` để thấy bức tranh công ty và danh sách dữ kiện cần xem.
4. Drill-down sang:
   - `Doanh thu & Chi phí` để truy chứng từ theo logic hiện tại;
   - `Hiệu quả tòa nhà` để xem dòng Doanh thu → Tiền thuê chủ nhà → Chi phí khác → Lợi nhuận;
   - `Lấp đầy & Phòng trống` để xem phòng có khách, phòng available, cơ hội theo giá niêm yết và HĐ sắp hết;
   - `Thu tiền & Công nợ`, `Cơ cấu Thu & Chi`, `Xu hướng & So sánh` để giải thích nguyên nhân.
5. `Nhận định theo dữ liệu` chỉ liệt kê sự kiện và biến động có chứng cứ, kèm liên kết tới màn xử lý; không chấm điểm tùy ý.
6. Nếu cần kiểm tra tòa ảo, bật nút gạt để mở một khối dữ liệu riêng. Mọi tổng chính và nhận định vẫn giữ nguyên.
7. Snapshot tháng được tích lũy từ thời điểm triển khai. Khi đủ lịch sử và có mục tiêu kinh doanh do người dùng xác nhận, mới bổ sung đánh giá theo ngưỡng.
8. Module cổ đông/chốt lợi nhuận tiếp tục chạy như hiện tại, không bị báo cáo quản trị mới thay đổi công thức.

---

# 2. Kiến trúc thông tin và điều hướng

## 2.1. Một route chuẩn, không duy trì hai trung tâm phân tích

Giữ route chuẩn:

```text
/reports/finance/profit-distribution
```

`ProfitHubPage` tiếp tục là shell kiểm tra quyền vì route này còn phục vụ cổ đông/quản lý không có toàn bộ quyền báo cáo.

Bên trong shell chia thành hai nhóm hiển thị:

### Nhóm `Báo cáo tài chính`

Các tab con theo thứ tự:

1. `Tổng quan kinh doanh`
2. `Doanh thu & Chi phí`
3. `Hiệu quả tòa nhà`
4. `Lấp đầy & Phòng trống`
5. `Thu tiền & Công nợ`
6. `Cơ cấu Thu & Chi`
7. `Xu hướng & So sánh`
8. `Nhận định & Dữ liệu`

`Doanh thu & Chi phí` render lại đúng `ProfitDistributionReport`/`ProfitDistributionMobile`; không viết một bảng Thu — Chi mới.

Registry chỉ đưa vào UI những leaf đã hoàn thành hoặc compatibility leaf đang hoạt động. Không tạo tab placeholder “đang phát triển”. Mỗi leaf nặng được `lazy()`/`Suspense` riêng; leaf không active hoặc không có quyền không được mount và không được bắn query nền.

### Nhóm `Cổ đông & Phân phối`

Giữ nguyên các view hiện có và điều kiện quyền:

- phần của cổ đông đang đăng nhập;
- tổng quan phân phối;
- chốt LN tháng;
- cổ đông & tỷ lệ;
- lương của quản lý.

Giữ nguyên easter egg 3 lần nhấp cho các tab nhạy cảm trên desktop. URL trực tiếp không được vượt qua trạng thái ẩn hoặc quyền.

## 2.2. Quyền truy cập

- `reports_finance.profit_distribution`: xem tab `Doanh thu & Chi phí`.
- `reports_finance.analysis`: xem 7 tab phân tích còn lại.
- `reports_finance.export`: được xuất file của các tab phân tích.
- `shareholder_profit.view` cùng quan hệ `useMyShareholder` là điều kiện self-view cổ đông; không phụ thuộc `reports_finance.profit_distribution`.
- Các quyền `shareholder_profit.lock/distribute/manage_shareholders` và manager salary giữ nguyên phạm vi hiện tại.
- Route gốc không thêm `RequirePermission` chung vì sẽ làm hỏng self-view cổ đông/quản lý; danh sách leaf-view phải được dựng sau khi quyền tải xong.
- Người dùng chỉ có `analysis` vẫn vào được trung tâm nhưng không thấy báo cáo chi tiết nếu thiếu `profit_distribution`.
- Người dùng chỉ có `profit_distribution` chỉ thấy `Doanh thu & Chi phí` trong nhóm báo cáo.

Legacy check frontend tiếp tục gọi `canUse`, không đọc JSON permission thô, vì action `analysis`/`profit_distribution` hiện có fallback về `reports_finance.view` khi key chi tiết chưa tồn tại và explicit `false` phải thắng fallback. Tuy nhiên `get_my_permissions()` hiện chọn một assignment nên không đủ cả cho navigation multi-org lẫn data authorization.

Thêm nguồn org-scoped kiểu `list_my_finance_scopes()` trả các organization/action hợp lệ. Sidebar/launcher dùng `permissionAnyOf` trên union này để hiện entry nếu **bất kỳ org** nào có quyền; leaf chỉ dùng action của selected org. RPC dùng helper exact-scope kiểm tra permission + active membership + building trong **cùng organization/assignment**. Không ghép global `canUse` với `can_access_building` để quyết định dữ liệu.

Quy tắc dữ liệu hạn chế:

- Contract mặc định giữ confidentiality hiện tại: người thiếu `income_expenses.restricted_view` không nhận row, label, detail, số tiền restricted hoặc tín hiệu data-dependent rằng hidden row có tồn tại. Payload luôn dùng scope chung `AUTHORIZED_ONLY` dựa trên permission; KPI cần toàn bộ KQKD/hòa vốn chuyển sang unavailable thay vì tự nhận là tổng đầy đủ.
- Chỉ khi owner/security phê duyệt **redacted aggregate** sau inference test, RPC definer mới được trả tổng đầy đủ và một bucket `Hạng mục hạn chế`/`restricted_delta`, tuyệt đối không trả tên hay voucher.
- Drill-down chứng từ vẫn theo RLS/quyền chi tiết hiện hành.
- Export cần thêm `reports_finance.export` và giữ nguyên redaction; quyền export không được mở rộng quyền đọc dữ liệu.

`restricted_delta` có thể làm lộ hoàn toàn số tiền khi chỉ có một voucher/type restricted. Đây là thay đổi so với contract hiện hành, không được gọi là parity. Phase 0 phải test singleton/difference inference và lưu quyết định policy; nếu chưa có phê duyệt thì dùng strict mode ở trên.

Ma trận mặc định sau khi permission tải xong:

| Persona hiệu lực | View mặc định |
|---|---|
| Cổ đông thuần có self-view | `shareholder-self` |
| Quản lý chỉ có salary self-view | `manager-salary` |
| Có `analysis` | `business-overview` |
| Chỉ có `profit_distribution` | `income-expense` |
| Quản lý phân phối không có hai quyền báo cáo | `distribution-overview` |

Nếu một user khớp nhiều dòng, self-view hiện hữu được ưu tiên trước analytics; mọi thay đổi thứ tự mặc định khác phải được chốt bằng route/permission test.

Hai dòng `analysis`/`profit_distribution` trong matrix chỉ được đánh giá sau khi selected organization đã có org-bound permission result; entry trung tâm dựa trên union từ `list_my_finance_scopes()`, không dựa riêng vào global `canUse`.

## 2.3. Deep link

Dùng query parameter `tab` làm nguồn sự thật cho leaf-view:

```text
?tab=business-overview
?tab=income-expense
?tab=building-performance
?tab=occupancy-vacancy
?tab=collections-debt
?tab=revenue-cost-structure
?tab=trends-comparison
?tab=data-insights
```

Với user có nhiều organization, query phải có thêm `org=<uuid>`; thiếu hoặc không hợp lệ thì hiển thị organization picker trước khi resolve tab/data. Không dùng một deep link không có org để suy đoán hoặc gộp số liệu giữa tenant.

Các view cổ đông có ID riêng, ví dụ `distribution-overview`, `shareholder-self`, `profit-lock`, `shareholder-config`, `manager-salary`.

Quy tắc:

- đổi tab dùng history bình thường để Back/Forward hoạt động;
- tab không tồn tại/không có quyền/đang bị ẩn được thay bằng view mặc định hợp lệ bằng `replace`;
- không mount thoáng qua nội dung không có quyền;
- người có quyền `analysis` mặc định vào `Tổng quan kinh doanh`;
- người chỉ có `profit_distribution` mặc định vào `Doanh thu & Chi phí`;
- các mặc định self-view hiện có của cổ đông/quản lý được bảo toàn.

## 2.4. Xử lý route `/reports/finance/analysis`

- **Trước cutover:** giữ guard `reports_finance.analysis` và tiếp tục render nội dung cũ, hoặc nhúng chính nội dung đó thành `legacy-analysis` compatibility leaf trong hub. Không fork thêm một implementation analytics.
- Tạo feature matrix ánh xạ đủ 5 tab cũ sang destination mới; chỉ leaf đã đạt parity mới thay destination cũ.
- **Sau khi toàn bộ cutover gates xanh:** route cũ mới redirect tới:

```text
/reports/finance/profit-distribution?tab=business-overview
```

- Redirect `/report/finance/analysis` theo cùng đường và vẫn giữ guard hiệu lực.
- Sau cutover, `FinancialAnalysisReport.tsx` chỉ còn compatibility redirect hoặc được loại khỏi lazy import; trước cutover nó vẫn là nguồn nội dung hợp lệ.
- Sidebar, trang danh mục báo cáo, breadcrumb và launcher đổi thành một entry `Trung tâm tài chính`; hiển thị khi `list_my_finance_scopes()` cho biết ít nhất một active organization có `analysis` hoặc `profit_distribution`.

---

# 3. Phạm vi dữ liệu và bộ lọc chung

## 3.1. Bộ lọc

Tạo `FinanceCommandCenterFilters`/context dùng chung cho các tab phân tích. Contract canonical dùng giá trị có nghĩa thay vì boolean mơ hồ:

- `organizationId: uuid` bắt buộc cho mọi query thuộc nhóm `Báo cáo tài chính`; không có chế độ gộp nhiều organization. Các self-view cổ đông/quản lý giữ scope quan hệ riêng hiện hành;
- `month: YYYY-MM` trong state/query, chỉ format `MM-yyyy` khi hiển thị;
- `buildingIds: [] | [uuid]` ở UI hiện tại: rỗng là mọi tòa vật lý được phép **trong organization đã chọn**, một ID là một tòa; RPC vẫn nhận `uuid[]` để không khóa thiết kế tương lai;
- `basis: "ACCRUAL" | "VOUCHER_DATE"`;
- nút gạt kiểm tra tòa ảo.

Dùng key canonical mới để desktop/mobile cùng một nguồn sự thật:

```text
flt:rpt-fin-command:organizationId
flt:rpt-fin-command:month
flt:rpt-fin-command:buildingIds
flt:rpt-fin-command:basis
```

Khi key mới chưa tồn tại, one-time migration theo thứ tự:

1. key của route đang mở;
2. `flt:rpt-profit-dist:*` desktop;
3. `flt:rpt-profit-dist-mb:*` mobile;
4. `flt:rpt-fin-analysis:*`;
5. organization duy nhất user có quyền, nếu có đúng một;
6. mặc định tháng hiện tại + `ACCRUAL`.

Nếu user có nhiều active organization mà URL/persisted value không hợp lệ, shell phải yêu cầu chọn organization trước khi mount leaf hoặc bắn query. Deep link dùng `org=<uuid>`; đổi org xóa building/room selection, hủy query cũ và nạp lại permission theo org. Không lấy organization đầu tiên từ `get_my_permissions()`/`LIMIT 1` làm mặc định ngầm.

Chuyển object tháng mobile sang `YYYY-MM`, đổi boolean accrual thành enum, giao persisted building IDs với danh sách physical được phép trong org đã chọn và xóa key cũ sau khi ghi canonical thành công. Mobile hiện có thao tác chọn nhiều tòa ở một số flow, trong khi `BuildingFilterSelect` desktop là single-select; command center giai đoạn này khóa UI ở 0/1 và phải ghi rõ nếu quyết định mở lại multi-select.

`ProfitDistributionReport` được chuyển dần sang nhận filter có kiểm soát, nhưng vẫn giữ fallback nội bộ trong giai đoạn refactor để giảm rủi ro. Một context/state điều khiển dữ liệu, còn cách trình bày filter khác theo viewport: desktop dùng thanh chung; mobile cho leaf hiện tại render header phù hợp nhưng đọc/ghi cùng context. Không render hai bộ lọc chung độc lập. Các tùy chọn đặc thù như loại phiếu, phòng, “chỉ KQKD”, ẩn dòng… vẫn thuộc riêng tab này.

Các KPI chính luôn là KQKD. Nếu người dùng tắt “chỉ KQKD” trong tab chi tiết, UI phải nói rõ đây là chế độ đối chiếu tất cả phiếu và không làm thay đổi KPI của các tab quản trị.

## 3.2. Phạm vi tòa vật lý

- Tòa chính được xác định bằng `buildings.is_virtual = false`, không bao giờ so tên.
- Selector chính chỉ chứa tòa vật lý.
- `[]` ở UI có nghĩa “tất cả tòa vật lý được phép trong organization/assignment đã chọn”, nhưng trước khi gọi RPC phải resolve thành danh sách ID cụ thể hoặc dùng RPC mới có điều kiện org-bound + `is_virtual=false` bắt buộc.
- Không truyền mảng rỗng vào RPC nếu RPC hiểu rỗng/NULL là “tất cả”. Nếu người dùng không có tòa vật lý, disable query và hiển thị trạng thái không có phạm vi được cấp.
- ID tòa ảo cũ còn trong sessionStorage phải bị loại khỏi effective selection.
- ID không còn thuộc organization/same-assignment scope hiện tại phải bị loại; nếu selected ID bị loại thì fallback về `[]`, không âm thầm gọi RPC với ID stale.
- Chỉ số phòng/hợp đồng/lấp đầy luôn physical-only, bất kể trạng thái nút gạt.

## 3.3. Room filter của báo cáo chi tiết

State/query hiện hỗ trợ `room_id` nhưng selector desktop chỉ có `Tất cả phòng`. Trong lúc harden tab cũ:

- nạp danh sách phòng theo tòa vật lý đã chọn;
- ghi rõ đây là “lọc phiếu gắn trực tiếp với phòng”, không phải lợi nhuận đầy đủ của phòng;
- xóa persisted room ID không còn nằm trong scope;
- không suy ra room profitability từ filter này vì chi phí cấp tòa chưa được phân bổ.

---

# 4. Quy tắc “Kho Văn Phòng Chung”

## 4.1. Ý nghĩa nút gạt

Không đặt tên `Tính Kho Văn Phòng Chung` vì quyết định hiện tại là chỉ xem riêng. Dùng:

```text
Hiện Kho Văn Phòng Chung (chỉ kiểm tra)
```

Mô tả:

```text
Hiện riêng các khoản của tòa ảo để kiểm tra. Không cộng vào tổng, xếp hạng,
lấp đầy, so sánh hoặc nhận định.
```

Khối mở ra có tiêu đề:

```text
Dữ liệu tòa ảo — chỉ để kiểm tra
```

Và cảnh báo:

```text
Các khoản này có thể gồm chi phí chưa được xác minh. Dữ liệu luôn tách khỏi
báo cáo chính cho đến khi có quy trình làm sạch và quyết định mới.
```

## 4.2. Hành vi bất biến

Nút gạt mặc định `false`. Khi bật:

- query chính giữ nguyên key, params và kết quả;
- KPI tổng, bảng xếp hạng, biểu đồ, lấp đầy, nhận định và export chính không thay đổi;
- chạy query riêng chỉ với `buildings.is_virtual=true`;
- hiển thị riêng doanh thu KQKD, chi phí KQKD, chênh lệch, số phiếu, số đã/chưa xác minh và danh sách phiếu phân trang;
- không tạo bất kỳ chỉ số phòng/hợp đồng nào cho tòa ảo;
- có export riêng `kiem-tra-toa-ao-*`, không thêm sheet tòa ảo vào workbook chính.

Persist theo user bằng `profiles.ui_preferences`, qua `useUiPreferences`/`useSetUiPreference`, key phẳng tương thích convention hiện có:

```text
finance_command_show_virtual_inspection
```

Không lưu vào URL và không dùng sessionStorage để tránh người dùng khác trên cùng máy thừa hưởng.

## 4.3. Cách truy vấn an toàn

Không thêm cờ “include both” vào query chính. Dùng hai đường dữ liệu bất giao nhau:

- primary: server bắt buộc `is_virtual=false`;
- inspection: RPC riêng bắt buộc `is_virtual=true`.

Không lọc theo chuỗi `Kho Văn Phòng Chung`/`Chung` ở SQL, TypeScript, test hoặc export.

Các writer chốt/phân phối lợi nhuận cũng phải từ chối building ID ảo ở server, không chỉ dựa vào danh sách đã lọc ở client. Harden source trong `scripts/authz-prepared/t5_16_profit_lock_writers.sql`, phát hành bằng migration mới và thêm test trực tiếp gọi writer với ID ảo.

---

# 5. Nội dung và công thức từng tab

## 5.1. `Tổng quan kinh doanh`

Mục đích: một màn đầu tiên dễ đọc cho chủ doanh nghiệp.

### KPI tài chính

- Doanh thu KQKD.
- Chi phí KQKD.
- Lợi nhuận ròng = Doanh thu − Chi phí.
- Biên lợi nhuận = Lợi nhuận ròng / Doanh thu × 100; doanh thu 0 hiển thị `—`.
- Tỷ lệ chi phí = Chi phí / Doanh thu × 100; doanh thu 0 hiển thị `—`.
- So tháng trước (MoM) và cùng kỳ năm trước (YoY): luôn hiện chênh lệch tuyệt đối; chỉ hiện % khi kỳ gốc khác 0.

### KPI vận hành

- Tổng phòng vật lý.
- Phòng có khách.
- Phòng đã giữ chỗ.
- Phòng available.
- Tỷ lệ lấp đầy có trọng số = Σ occupied / Σ total.
- Tỷ lệ đã cam kết = Σ(occupied + reserved) / Σ total.
- Giá trị cơ hội phòng available hiện tại = tổng giá niêm yết tháng của phòng `available`.
- Hóa đơn phải thu và phân bố tuổi nợ.

Từ ngữ bắt buộc cho `missed_revenue`:

```text
Giá trị cho thuê niêm yết của phòng đang available/tháng
```

Không gọi là “thiệt hại” hoặc “doanh thu đã mất”.

### Drill-down

Mỗi KPI có link tới tab chi tiết phù hợp. Tổng quan chỉ hiển thị 3–5 quan sát quan trọng nhất, không sao chép toàn bộ tab `Nhận định & Dữ liệu`.

## 5.2. `Doanh thu & Chi phí`

Giữ nguyên:

- cách tạo dòng và nhóm hóa đơn;
- cách tách thanh lý;
- thứ tự 9 chi phí cố định;
- placeholder thiếu phiếu;
- ẩn loại đặc biệt;
- dialog chứng từ/hóa đơn/tạo phiếu;
- `ProfitVerificationBar`;
- tổng server-side độc lập với giới hạn bảng.

Chỉ thay đổi:

- tích hợp navigation/filter shell;
- phạm vi mặc định physical-only;
- copy `TIỀN MẶT` thành `Theo ngày phiếu — đối chiếu`;
- hoàn thiện room selector;
- trạng thái lỗi rõ ràng;
- test parity desktop/mobile.

Không tính headline total từ 1.000 dòng chi tiết. Nếu bảng bị cap, tiếp tục cảnh báo và giữ số tổng từ nguồn aggregate.

## 5.3. `Hiệu quả tòa nhà` — ưu tiên số 1

Mỗi tòa vật lý có một dòng/waterfall dễ hiểu:

```text
Doanh thu KQKD
− Tiền thuê chủ nhà đã ghi nhận
− Chi phí KQKD khác
= Lợi nhuận ròng
```

Cột/KPI:

- doanh thu;
- tiền thuê chủ nhà;
- chi phí KQKD khác;
- tổng chi phí;
- lợi nhuận ròng;
- biên lợi nhuận;
- tỷ lệ tiền thuê/Doanh thu;
- tỷ lệ tổng chi phí/Doanh thu;
- lợi nhuận ròng / số phòng vật lý hiện tại;
- lấp đầy hiện tại;
- số phòng available;
- giá trị cơ hội available;
- chênh lệch LN MoM và YoY.

Chú thích bắt buộc:

```text
LN/phòng hiện tại = lợi nhuận của tòa trong kỳ chia số phòng vật lý hiện tại.
Đây không phải lợi nhuận thực tế của từng phòng và chưa phân bổ chi phí chung.
```

### Mapping tài chính bền vững cho “Tiền nhà” và hòa vốn

`income_expense_types.category` đang là text tự do; `FIXED_EXPENSE_CATEGORIES` chỉ là matcher tương thích dữ liệu cũ. Không được dùng khớp tên làm chuẩn kế toán lâu dài.

Bổ sung mapping phân tích nullable cho từng loại Thu/Chi, chuẩn hóa tên là `finance_reporting_role`, kèm `confirmed_at/confirmed_by`. Mapping không thay đổi việc một khoản có thuộc KQKD hay không; nó chỉ giải thích vai trò của khoản đó trong mô hình hiệu quả/hòa vốn.

Mapping phải có lịch sử hiệu lực để kết quả tái lập được: ưu tiên bảng assignment có `organization_id`, `income_expense_type_id`, `finance_reporting_role`, `effective_from`, `effective_to`, `confirmed_at`, `confirmed_by` và ràng buộc không chồng lấn. Với dồn tích, chọn assignment theo tháng được ghi nhận; với ngày phiếu, chọn theo ngày phiếu. Nếu sản phẩm cố ý dùng một cột hiện tại và cho phép hồi tố, phải ghi rõ đó là **restatement** của các kỳ mở và hiển thị thời điểm mapping thay đổi; không được ngầm coi là lịch sử bất biến.

Vai trò doanh thu:

- `ROOM_RENT_REVENUE` — doanh thu tiền phòng;
- `OTHER_OPERATING_REVENUE` — doanh thu vận hành khác;
- `PASS_THROUGH_REVENUE` — khoản thu hộ;
- `OUTSIDE_BREAK_EVEN_MODEL` — vẫn nằm trong KQKD thực tế nhưng chưa thể đưa vào mô hình hòa vốn.

Vai trò chi phí:

- `LANDLORD_RENT_FIXED` — tiền thuê chủ nhà, là chi phí cố định;
- `OTHER_FIXED_COST` — chi phí cố định khác;
- `ROOM_VARIABLE_COST` — chi phí biến đổi theo hoạt động cho thuê phòng;
- `OTHER_VARIABLE_COST` — chi phí biến đổi của doanh thu vận hành khác;
- `PASS_THROUGH_EXPENSE` — khoản chi hộ;
- `OUTSIDE_BREAK_EVEN_MODEL` — vẫn nằm trong KQKD thực tế nhưng chưa thể đưa vào mô hình hòa vốn.

Quy tắc rollout:

- Matcher `tien_nha` hiện có chỉ dùng để tạo mapping **đề xuất** `LANDLORD_RENT_FIXED`; admin phải xác nhận trong form loại Thu/Chi.
- Tạo màn/bảng cấu hình mapping có lọc “chưa phân loại”, giải thích từng vai trò và hiển thị giá trị KQKD gần đây bị ảnh hưởng.
- Nếu một tòa/tháng không có phiếu `LANDLORD_RENT_FIXED`, hiển thị `Chưa ghi nhận phiếu Tiền nhà`; không coi chi phí là 0.
- Mức bao phủ mapping phải tính cả **số tiền** và số loại phiếu, không chỉ số lượng type.
- Bất biến tie-out theo từng side và basis: mỗi VND KQKD phải thuộc đúng một role đã xác nhận, `OUTSIDE_BREAK_EVEN_MODEL` hoặc `UNMAPPED`; tổng các bucket đó phải bằng aggregate KQKD, không làm tròn trước khi đối chiếu.
- Tất cả con số KQKD thực tế vẫn hiển thị đầy đủ. Riêng doanh thu/tỷ lệ hòa vốn chỉ hiển thị khi 100% giá trị thuộc cửa sổ tính đã được mapping, không có giá trị `OUTSIDE_BREAK_EVEN_MODEL`, tiền nhà không bị thiếu và dữ liệu công suất phòng hợp lệ. Nếu chưa đủ, hiển thị nguyên nhân và link tới mapping/chứng từ thay vì trả 0 hoặc một tỷ lệ tạm đoán.

### Điểm hòa vốn và lấp đầy hòa vốn từng tòa — yêu cầu trọng tâm

Hiển thị trực tiếp trong `Hiệu quả tòa nhà`, đồng thời có card tóm tắt ở `Tổng quan kinh doanh`. Mỗi tòa có **hai lớp** để không ép doanh thu dịch vụ thành số phòng.

#### Lớp 1 — Hòa vốn KQKD toàn tòa

Luôn hiện số thực tế, không cần giả định:

```text
Doanh thu KQKD thực tế = toàn bộ doanh thu KQKD của tòa
Chi phí KQKD thực tế   = toàn bộ chi phí KQKD của tòa
Khoảng cách đến điểm 0 = Chi phí − Doanh thu
```

- Nếu khoảng cách > 0: tòa còn thiếu đúng số VND đó để lợi nhuận KQKD bằng 0 tại trạng thái hiện tại.
- Nếu khoảng cách <= 0: hiển thị phần vượt điểm 0, không gắn nhãn tốt/xấu.
- Chỉ số này luôn gồm mọi KQKD, kể cả thu/chi hộ và khoản ngoài mô hình.

Khi mapping đầy đủ, tính thêm **doanh thu KQKD hòa vốn theo cơ cấu hiện tại**:

```text
R_core   = doanh thu phòng + doanh thu vận hành khác
V_core   = chi phí biến đổi phòng + chi phí biến đổi khác
CMR_core = (R_core − V_core) / R_core
F        = tiền thuê chủ nhà + chi phí cố định khác
C_pass   = thu hộ − chi hộ
R_core_BE  = MAX(0, (F − C_pass) / CMR_core)
R_total_BE = R_core_BE + thu hộ
```

`R_total_BE` là mức tổng doanh thu KQKD cần đạt nếu giữ nguyên cơ cấu doanh thu, tỷ lệ chi phí biến đổi và quy mô thu/chi hộ của cửa sổ tham chiếu. Không gọi đây là dự báo chắc chắn. Nếu `R_core <= 0`, `CMR_core <= 0`, mapping thiếu hoặc có khoản ngoài mô hình thì hiển thị `Chưa đủ dữ liệu để tính doanh thu hòa vốn` cùng lý do.

#### Lớp 2 — Hòa vốn từ doanh thu phòng và quy đổi ra lấp đầy

Không cộng doanh thu dịch vụ vào “số phòng”. Trước hết tính phần đóng góp ngoài tiền phòng, rồi mới xác định doanh thu phòng cần có:

```text
R_room       = doanh thu ROOM_RENT_REVENUE
V_room       = chi phí ROOM_VARIABLE_COST
CMR_room     = (R_room − V_room) / R_room
C_non_room   = (doanh thu vận hành khác − chi phí biến đổi khác)
             + (thu hộ − chi hộ)
R_room_BE    = MAX(0, (F − C_non_room) / CMR_room)
```

Nếu `F − C_non_room <= 0`, doanh thu ngoài phòng đã đủ bù chi phí cố định trong mô hình và mức doanh thu phòng hòa vốn là 0. Nếu `R_room <= 0` hoặc `CMR_room <= 0`, không suy ra tỷ lệ lấp đầy.

Quy đổi `R_room_BE` theo hai mức công suất mà người dùng đã chọn:

```text
Capacity_current = Σ giá niêm yết của phòng occupied + reserved + available
Capacity_blocked = Σ giá niêm yết của phòng maintenance + unavailable
Capacity_theory  = Capacity_current + Capacity_blocked

BE_occupancy_current = R_room_BE / Capacity_current × 100
BE_occupancy_theory  = R_room_BE / Capacity_theory × 100
```

Tên hiển thị phải là **“Lấp đầy hòa vốn theo công suất giá niêm yết”**, vì đây là tỷ lệ doanh thu theo giá chứ không phải tỷ lệ đếm số phòng thuần túy. Bên cạnh đó vẫn hiển thị riêng occupancy theo số phòng từ `occupancy_snapshot_v2`.

Hai góc nhìn công suất:

- `Công suất khai thác hiện tại`: chỉ occupied/reserved/available — năng lực có thể khai thác trong trạng thái hiện tại.
- `Công suất lý thuyết`: thêm maintenance/unavailable — cho biết nếu toàn bộ phòng được đưa trở lại khai thác.
- Hiển thị `Capacity_blocked` và số phòng bị chặn, nhưng không mặc định coi toàn bộ maintenance/unavailable có thể mở lại ngay.

Diễn giải khi vượt công suất:

- `BE_occupancy_current > 100%`: hiển thị tỷ lệ thật (ví dụ 118%), số VND còn thiếu khi dùng 100% công suất hiện tại và câu `Không thể hòa vốn chỉ bằng công suất đang khai thác theo giả định hiện tại`.
- Nếu current >100% nhưng theory <=100%: nêu riêng phần công suất đang bị chặn; không tự kết luận phải mở lại phòng.
- Nếu theory >100%: nêu `Ngay cả công suất lý thuyết cũng chưa đủ theo cấu trúc giá/chi phí hiện tại`; người dùng cần xem giá thuê, chi phí cố định, biên đóng góp và doanh thu ngoài phòng.
- Không tô đỏ/xanh dựa trên ngưỡng tùy ý; trạng thái >100% chỉ là điều kiện toán học.

#### Hai cửa sổ tính song song

Mỗi tòa hiển thị:

1. `Tháng đang chọn` — bám đúng dồn tích/ngày phiếu của filter; tháng hiện tại có nhãn đang mở.
2. `Tham chiếu bình quân 3 tháng` — làm mượt tháng có chứng từ bất thường.

Không lấy trung bình của các tỷ lệ phần trăm. Tính từ tổng đầu vào:

```text
CMR_core_3m = (ΣR_core − ΣV_core) / ΣR_core
CMR_room_3m = (ΣR_room − ΣV_room) / ΣR_room
F_3m        = ΣF / số tháng hợp lệ
C_non_room_3m = ΣC_non_room / số tháng hợp lệ
R_room_BE_3m  = MAX(0, (F_3m − C_non_room_3m) / CMR_room_3m)
```

- Cửa sổ 3 tháng kết thúc ở tháng được chọn.
- Phải đủ cả 3 tháng và mỗi tháng phải có mapping/phiếu Tiền nhà hợp lệ; nếu thiếu, ghi rõ tháng thiếu thay vì coi là 0.
- Cả kịch bản tháng và 3 tháng đều quy đổi trên công suất của **tháng đang chọn**, để trả lời “với tòa hiện có thì cần khai thác bao nhiêu”.
- Với tháng hiện tại dùng dữ liệu phòng live từ Occupancy v2. Với tháng đã có finalized snapshot dùng công suất snapshot cuối tháng. Với tháng lịch sử trước ngày bắt đầu snapshot, vẫn hiện hòa vốn doanh thu nhưng không quy đổi ra tỷ lệ lấp đầy.

#### Giới hạn và dữ liệu chất lượng

- Giá niêm yết NULL/âm/0 phải được đếm và nêu; không âm thầm coi là công suất hợp lệ. Giá âm dùng 0 theo quy tắc occupancy hiện tại nhưng vẫn tạo notice dữ liệu.
- Phải hiển thị `Mức khai thác doanh thu phòng = doanh thu phòng ghi nhận / Capacity_current`, đặt cạnh lấp đầy hòa vốn để so cùng đơn vị; không dùng occupancy theo số phòng làm phép trừ trực tiếp với tỷ lệ theo giá.
- Thu/chi hộ được giữ thành cặp đóng góp riêng; chênh lệch thu hộ − chi hộ phải hiển thị, không giả định luôn bằng 0.
- Không hiển thị “số phòng cần để hòa vốn” vì giá phòng không đồng nhất và chưa có quy tắc chọn mix phòng.
- Mọi card có drill-down tới mapping loại Thu/Chi, chứng từ Tiền nhà, cơ cấu chi phí và danh sách phòng bị chặn.

## 5.4. `Lấp đầy & Phòng trống` — ưu tiên số 2

### Snapshot hiện tại

Nguồn chính cho **hiện tại**: `occupancy_snapshot_v2` và `occupancy_upcoming_vacancy_v2`. Đây là phân loại live, không phải lịch sử đã chốt.

Hiển thị:

- total/occupied/reserved/maintenance/unavailable/available;
- occupancy và committed occupancy có trọng số;
- cơ hội giá niêm yết của phòng available;
- giá thuê hợp đồng active trung bình;
- danh sách phòng available theo tòa và giá niêm yết;
- hợp đồng sắp kết thúc hiệu lực trong 30/60 ngày, đã tính gia hạn approved/completed.

Phòng maintenance/unavailable không được gọi là phòng trống có thể bán.

### Lịch sử và mốc thời gian

- Snapshot tháng mới là nguồn lịch sử chuẩn kể từ khi triển khai.
- `fa_occupancy_monthly` cũ chỉ được đặt ở khu vực `Ước tính tham chiếu từ hợp đồng`, có chú thích mẫu số dùng tồn kho hiện tại.
- Không nối dữ liệu ước tính và snapshot thành một đường biểu đồ giả liền mạch.
- Tháng chưa có snapshot hiển thị `Chưa có snapshot`, không scaffold thành 0.
- Không tính vacancy-days hoặc lost rent lịch sử.
- Tháng đang mở dùng live/provisional và phải gắn nhãn; tháng đã chọn trong quá khứ chỉ dùng finalized snapshot hoặc nhãn `Ước tính` rõ ràng.
- Không ghép occupancy/aging hiện tại với P&L của tháng lịch sử để tạo một KPI có vẻ cùng kỳ; mọi card phải hiển thị `as_of`/freshness tương ứng.

## 5.5. `Thu tiền & Công nợ`

Nguồn đích: `fa_invoice_collection_v2`; `fa_snapshot_kpis` chỉ cho KPI live; `get_invoice_statistics_v2` không dùng làm cohort chính nếu chưa chứng minh cùng semantics. `fa_invoice_collection(text,text,uuid[])` cũ chỉ là baseline cần retire, không còn là source của tab mới.

Hiển thị:

- billed principal của billing cohort tháng chọn, chỉ `kind = 'MONTHLY'` và allowlist hiện hành `APPROVED`, `PARTIAL_PAID`, `PAID`, `OVERDUE`;
- collected principal đã được payment allocation gắn vào current-period charges của cohort đó;
- remaining principal = billed principal − collected principal;
- tỷ lệ thu chỉ khi allocation coverage đầy đủ;
- số lượng hóa đơn theo trạng thái;
- tuổi nợ: chưa đến hạn, 1–30, 31–60, 61–90, >90 ngày;
- tiền cọc đang giữ, tách khỏi doanh thu.

`DRAFT`/`PENDING_APPROVAL` và `kind = 'SETTLEMENT'` phải nằm ở card/section riêng, không vào billed/collection rate chính. Không dùng thẳng `invoices.total_amount`, `paid_amount` hoặc `remaining_amount`: `total_amount` hiện gồm `previous_debt`, còn trigger cascade có thể đánh dấu source invoice `PAID` mà không tạo một cash event mới.

Data contract bắt buộc trước khi phát hành KPI:

1. Tách canonical components của invoice: `current_charge_amount`, carried invoice debt, carried deposit debt và settlement amount; tổng component phải reconcile với invoice total/rounding hoặc row bị đánh dấu anomaly.
2. Main cohort billed chỉ dùng `current_charge_amount` của hóa đơn tháng; carried debt/deposit không được billed lại trong cohort mới.
3. Mỗi payment cần allocation immutable tới component/source. Policy phân bổ partial payment phải được business phê duyệt và versioned; khuyến nghị oldest carried invoice debt → current charges → deposit debt, nhưng không suy đoán policy cho lịch sử.
4. Cascade tất toán source invoice là debt-link settlement, không phải payment/cash mới. Một source invoice chỉ xuất hiện ở billed cohort gốc; carry target chỉ tham chiếu source ID/amount và không làm tăng billed principal.
5. Deposit source tách khỏi revenue/collection; `SETTLEMENT` có cohort riêng.
6. Payment lịch sử chưa có allocation trả `allocation_unknown`; có thể hiện tổng paid chưa phân bổ, nhưng collected principal/tỷ lệ cohort là unavailable thay vì phân bổ giả.

Luôn tách hai chỉ số: **cohort-to-date** (payment allocations của hóa đơn tháng đó đến hiện tại) và **cash received in month** (cash event có `payment_date` trong tháng, không tính cascade); chỉ số thứ hai cần RPC server-side riêng.

Aging, cọc đang giữ và giá thuê active từ `fa_snapshot_kpis` phải có nhãn `Hiện tại` cùng `as_of`; chúng không đổi theo tháng cohort. Muốn xem aging tại cuối một tháng cũ phải có snapshot/as-of RPC riêng, không tái sử dụng số live.

Chú thích bắt buộc:

```text
Thu theo kỳ hóa đơn cho biết các hóa đơn của tháng đã được thu bao nhiêu đến hiện tại.
Đây không phải tổng tiền thực nhận trong chính tháng đó.
```

Không gọi `fa_invoice_collection` là dòng tiền theo ngày. Nếu sau này cần actual cash-in theo `payments.payment_date`, phải thêm RPC server-side riêng; không dùng browser aggregation dễ dính cap-1000.

## 5.6. `Cơ cấu Thu & Chi`

Tái sử dụng `TypeBreakdownSection`, `RevenueTab`, `ExpenseTab`:

- cơ cấu doanh thu theo hạng mục;
- cơ cấu chi phí theo hạng mục;
- tỷ trọng và so tháng trước;
- xu hướng 12 tháng;
- số tiền/số phiếu chưa có hạng mục;
- bảng chi tiết và export.

Thay “Top 10” client-side bằng RPC xếp hạng trên toàn bộ tập dữ liệu được phép, xếp hạng trước khi `LIMIT`. Trong dồn tích, số tiền xếp hạng là phần được ghi nhận trong kỳ, không phải toàn bộ giá trị phiếu.

## 5.7. `Xu hướng & So sánh`

- Doanh thu, Chi phí, Lợi nhuận: cùng một trục tiền.
- Biên lợi nhuận: biểu đồ % riêng.
- Tỷ lệ chi phí: biểu đồ % riêng.
- Bảng MoM và YoY gồm giá trị hiện tại, kỳ so sánh, chênh lệch tuyệt đối, chênh lệch % khi xác định được.
- Xu hướng cơ cấu hạng mục.
- Số hợp đồng mới/gia hạn/chấm dứt theo tháng.
- Từ khi có snapshot: xu hướng inventory/occupancy authoritative; trước đó chỉ hiện nguồn ước tính có nhãn.

Không dùng dual-axis.

## 5.8. `Nhận định & Dữ liệu`

Thay `buildInsights` theo ngưỡng bằng danh sách quan sát factual. Mỗi quan sát gồm:

- sự kiện/biến động;
- giá trị hiện tại;
- giá trị so sánh;
- chênh lệch tuyệt đối và % nếu hợp lệ;
- tháng, scope, cơ sở ghi nhận;
- nguồn dữ liệu;
- giới hạn diễn giải;
- link tới tab/chức năng xử lý.

Các quan sát hợp lệ ở giai đoạn đầu:

- tòa có lợi nhuận âm (mốc 0 là định nghĩa toán học, không phải target tùy ý);
- doanh thu/chi phí/LN thay đổi so tháng trước/cùng kỳ;
- tòa chưa ghi nhận phiếu Tiền nhà;
- phòng available và giá trị niêm yết tương ứng;
- hợp đồng sắp hết theo ngày;
- công nợ còn tồn, sắp xếp theo ngày quá hạn và số tiền;
- phiếu chưa có hạng mục;
- kỳ phân bổ sai/thiếu;
- tháng hiện tại chưa kết thúc;
- snapshot chưa đủ hoặc đang provisional;
- query/source chưa cập nhật hoặc lỗi.

Thứ tự ưu tiên:

1. lỗi/thiếu dữ liệu ảnh hưởng tính đúng;
2. nghĩa vụ có ngày đến hạn/quá hạn;
3. sự kiện có tác động tiền, giảm dần theo giá trị tuyệt đối;
4. biến động so sánh;
5. thông tin vận hành còn lại.

Không dùng `red/amber/green`, “an toàn”, “nguy hiểm”, “tốt/xấu” hoặc điểm tổng hợp. Nếu không có quan sát bổ sung, ghi:

```text
Không có quan sát bổ sung từ phạm vi dữ liệu đang hiển thị.
```

### Ngưỡng còn tồn tại trong implementation cần loại khỏi factual observation

Phase 4 phải xóa hoặc chuyển thành cấu hình có phê duyệt, không chỉ đổi câu chữ:

- biên lợi nhuận `20%`;
- lấp đầy `70%` và `85%`;
- thu hồi `90%`;
- tỷ lệ chưa phân loại `10%`;
- doanh thu giảm `-10%`.

Cho đến khi có target/version/effective date được phê duyệt, các giá trị trên chỉ được lưu trong characterization để chứng minh đã loại bỏ, không được dùng làm severity, health label hay màu trạng thái.

---

# 6. Nguồn số liệu và RPC

## 6.1. Nguồn hiện có phải tái sử dụng

- `get_income_expense_layer_stats`: tổng ngày phiếu của báo cáo chi tiết.
- `fa_accrual_allocations`, `fa_monthly_pnl_accrual`: dồn tích KQKD.
- `fa_monthly_pnl`: KQKD theo ngày phiếu.
- `fa_type_breakdown` / `_accrual`: cơ cấu.
- `fa_occupancy_monthly`: lịch sử ước tính.
- `occupancy_snapshot_v2`: snapshot hiện tại authoritative.
- `occupancy_upcoming_vacancy_v2`: hợp đồng sắp hết hiệu lực.
- `fa_lease_events`: biến động hợp đồng.
- `fa_invoice_collection_v2`/`fa_cash_received`: nguồn đích sau component/payment-allocation hardening; `fa_invoice_collection` cũ chỉ dùng characterization trước khi retire.
- `fa_snapshot_kpis`: tuổi nợ, giá thuê active, cọc và KPI **live/current**, không phải nguồn as-of cho tháng lịch sử.
- `ProfitVerificationBar` / `useProfitVerification`: đối soát.

Không tạo phép tính JS mới nếu SQL/pure utility hiện có đã định nghĩa cùng chỉ số.

## 6.2. Đồng nhất logic P&L

Trước khi dùng analytics làm tổng quan chính:

1. Viết characterization test cho `ProfitDistributionReport` hiện tại.
2. Đối chiếu nhiều tháng/tòa giữa:
   - headline dồn tích hiện tại;
   - `fa_monthly_pnl_accrual`;
   - `ProfitVerificationBar`.
3. Đối chiếu ngày phiếu giữa headline và `get_income_expense_layer_stats`/`fa_monthly_pnl`.
4. Nếu có lệch, dừng hợp nhất và sửa nguồn gốc; không “chỉnh số” ở UI.
5. Sau khi parity xanh, các tab quản trị dùng `fa_*`; tab chi tiết vẫn giữ nguồn aggregate hiện tại.
6. Khóa parity cho period bất thường giữa SQL và client:
   - `end < start` giữ hành vi baseline là ghi nhận tại tháng bắt đầu và trả anomaly flag;
   - chỉ có một đầu kỳ thì fallback về tháng ngày phiếu và trả anomaly flag;
   - client không được lọc bỏ các dòng này trước transform.
7. Nếu nghiệp vụ muốn đổi cách xử lý anomaly, thực hiện bằng migration/versioned rule kèm đối soát trước/sau; không sửa riêng trong React.

## 6.3. RPC mới/được harden

Tạo migration dựa trên **định nghĩa có hiệu lực mới nhất** trong migration KQKD item-level, không copy nhầm bản June cũ.

### Contract bảo mật và dữ liệu bắt buộc

`authorize_v2` trong branch hiện là SHADOW/INERT, không grant cho client; không RPC nào trong kế hoạch được giả định nó đã enforce quyền. Mỗi entry point phải tự:

1. yêu cầu session hợp lệ;
2. nhận `p_organization_id` rõ ràng rồi xác nhận caller có active membership; không chọn org bằng `LIMIT 1` và không gộp `my_org_ids()`;
3. gọi một helper mới kiểu `can_use_finance_scope(p_organization_id, p_action, p_building_ids, p_virtual_mode)` để kiểm tra report permission, legacy fallback/explicit deny, membership và building scope trong cùng organization/assignment;
4. xác nhận mọi building thuộc `p_organization_id` và cùng assignment đã cấp action; bắt buộc `is_virtual=false` cho luồng chính, `true` cho inspection, và từ chối ID ngoài scope thay vì mở rộng thành “all”;
5. áp restricted-category/redaction và export permission ở server, không chỉ ẩn component.

Không ghép kết quả global `get_my_permissions()` với `can_access_building()` độc lập: hiện hai helper có thể chọn hai assignment khác nhau. Super admin cũng phải truyền organization đích để query key/audit log không mơ hồ.

### Quy tắc overlap assignment (deterministic)

Trong cùng `organization_id`, helper thu thập mọi assignment áp dụng cho từng building theo thứ tự cụ thể giảm dần: **building-specific > area-specific > full-scope**. Sau đó áp dụng:

- bất kỳ explicit `false` nào cho action ở assignment áp dụng đều thắng mọi `true` (deny-wins toàn tập, kể cả tier rộng/hẹp);
- nếu không có explicit decision cho action, mới fallback sang `reports_finance.view`, cũng theo deny-wins;
- nếu chỉ có `true`, chọn kết quả theo assignment cụ thể nhất; nhiều assignment cùng tier vẫn không dùng role/created_at làm tie-break ngầm;
- `buildingIds: []` được resolve thành tập từng building được phép sau khi áp precedence; request có ID cụ thể mà chỉ một ID bị deny/ngoài scope thì reject toàn request, không trả partial im lặng.

Kết quả helper trả `allowed_building_ids`, `denied_reasons` và permission provenance để audit/test. Test phải bao phủ full-scope allow + building deny, area allow + building allow/deny, duplicate full-scope rows, explicit detailed deny + legacy view allow, và ngược lại.

Chọn security mode theo loại dữ liệu, không dùng một mặc định cho mọi RPC:

| Nhóm RPC | Security mode mặc định | Điều kiện |
|---|---|---|
| Aggregate headline/P&L/hòa vốn/data-quality/virtual summary | Theo restricted policy | Strict mode ưu tiên invoker/filtered aggregate và đánh dấu partial; chỉ dùng `SECURITY DEFINER` để trả redacted aggregate đầy đủ khi policy đã duyệt. Definer luôn fixed `search_path`, fully-qualified, revoke `PUBLIC`, grant tối thiểu và tự check exact org/assignment/building. |
| Ranked voucher và detail drill-down | `SECURITY INVOKER` | Giữ RLS hiện hành; nếu aggregate toàn population cần restricted amount thì tách aggregate và detail thành hai RPC, không bypass RLS trong cùng payload. |
| Snapshot history facade | `SECURITY DEFINER`, không direct table SELECT | Ẩn manifest/count toàn org; chỉ trả aggregate trên detail đã lọc bằng exact org/assignment/building helper. RLS vẫn bật làm defense-in-depth. |
| Capture/cron nội bộ | `SECURITY DEFINER`, không grant client | Fixed `search_path`, organization bắt buộc, audit run và khóa finalized. |

Mọi `SECURITY DEFINER` phải qua `scripts/check-definer-acl.mjs`, test cross-tenant và test user thiếu từng action. Payload RPC được parse/validate ở runtime trước khi vào React: UUID, enum basis, `YYYY-MM`, finite number và nullable field. Generated type nullable không được ép bằng `as`; nhãn `Không có hạng mục` chỉ là presentation fallback, không thay đổi nullability của row.

### Retire đường cũ `fa_invoice_collection`

Migration hiện tại tạo `fa_invoice_collection(text, text, uuid[])` là `SECURITY DEFINER` và grant trực tiếp cho mọi `authenticated`; signature này không được để sống song song sau cutover:

1. Phase 0 tạo org-bound `fa_invoice_collection_compat(p_organization_id, ...)` chỉ để giữ màn legacy, gắn `legacy_semantics=true`, không export/headline; đồng thời thay signature cũ bằng wrapper **fail-closed** reject `NULL`/empty/mixed-org IDs và require exact-scope `reports_finance.analysis`.
2. Cập nhật `useFaInvoiceCollection` trong `useFinancialAnalysis` và route legacy để gọi compat với selected org + physical IDs, query key có org; sau khi caller mới chạy ổn, không còn browser call signature cũ.
3. Revoke `EXECUTE` trên signature cũ khỏi `PUBLIC`, `anon`, `authenticated` (hoặc drop wrapper ngay nếu release deploy atomic). Nếu cần compatibility window cho client cũ, window phải ngắn, có telemetry và wrapper vẫn fail-closed; không giữ function body cũ.
4. Phase 3 tạo/chuyển tab sang `fa_invoice_collection_v2` + `fa_cash_received` với component/payment allocation semantics, sau đó drop compat và thêm direct-call regression test cho old/compat signatures với null/empty/mixed-org/no-action/virtual IDs.

Không đánh dấu cohort chính “đã kiểm chứng” chỉ vì wrapper cũ trả số; mọi export/headline dùng RPC v2 sau khi allocation coverage đạt gate.

### `fa_building_performance`

Server aggregate theo tháng × tòa vật lý:

- selected organization, month/basis và requested building IDs;
- revenue;
- landlord_rent theo `finance_reporting_role` có hiệu lực tại kỳ ghi nhận;
- other_expense;
- total_expense;
- net;
- counts/coverage của phiếu Tiền nhà;
- `visibility_scope` (`FULL_ACCESS`, `AUTHORIZED_ONLY`, `REDACTED_AGGREGATE`) và availability reason không phụ thuộc việc có bao nhiêu hidden row;
- last source update.

Hỗ trợ dồn tích và ngày phiếu theo đúng quy tắc hiện hành; nhận organization rõ ràng, dùng exact-scope helper và bắt buộc `is_virtual=false`.

### `fa_building_break_even`

Server-side aggregate hòa vốn theo từng tòa để tránh cap-1000 và bảo đảm cùng allocation với P&L:

- nhận selected organization, tháng kết thúc, basis và danh sách tòa vật lý được phép;
- trả riêng đầu vào tháng chọn và tổng đầu vào cửa sổ 3 tháng: `R_room`, `R_other`, `R_pass`, `F_landlord`, `F_other`, `V_room`, `V_other`, `E_pass`, `unmapped_amount`, `outside_model_amount`;
- trả coverage mapping, số tháng hợp lệ, tháng thiếu Tiền nhà, thời điểm nguồn mới nhất;
- không che giấu giá trị unmapped/outside-model trong P&L; chỉ đánh dấu mô hình hòa vốn không đủ điều kiện;
- công suất phòng lấy từ classification Occupancy v2/live kết hợp `rooms.listed_rent` trong RPC server-side, hoặc từ snapshot finalized theo quy tắc kỳ báo cáo; Occupancy v2 hiện không tự cung cấp đủ rent capacity. RPC trả `capacity_current`, `capacity_blocked`, `capacity_theory`, số phòng từng nhóm và số phòng có giá không hợp lệ;
- công thức hòa vốn được triển khai một lần trong SQL hoặc pure utility đã test; UI không tự suy lại từ detail rows;
- tuân theo restricted policy: strict mode trả unavailable nếu hòa vốn cần phần bị ẩn; redacted-aggregate mode chỉ hoạt động sau phê duyệt. Cả hai dùng exact org/assignment scope, `is_virtual=false` và requested IDs chỉ thu hẹp quyền.

### `fa_ranked_kqkd_vouchers`

- xếp hạng trên toàn bộ population trước `LIMIT`;
- có selected organization, side, kỳ, tòa, basis, limit có clamp;
- dồn tích trả recognized amount trong kỳ;
- physical-only cho báo cáo chính;
- không lấy top từ 100 dòng browser;
- ưu tiên `SECURITY INVOKER` để giữ RLS detail; restricted rows không được lộ qua label/description/export.

### `fa_invoice_collection_v2` và `fa_cash_received`

- nhận organization, tháng/cohort và building IDs; dùng exact-scope helper;
- cohort v2 chỉ lấy `MONTHLY` với allowlist `APPROVED`/`PARTIAL_PAID`/`PAID`/`OVERDUE` và current-charge principal, trả riêng carried invoice debt, carried deposit debt, settlement và allocation coverage;
- collected/remaining principal tính từ immutable payment allocations; cascade status update không được tính là cash;
- row lịch sử thiếu component/allocation trả `allocation_unknown`, không tự phân bổ từ `paid_amount`;
- cash-received RPC tổng hợp cash event theo `payment_date`, có source/payment ID để chống duplicate và tách khỏi cohort-to-date;
- clamp/rounding phải reconcile về invoice/payment ledger; anomaly trả count/amount thay vì bị làm tròn mất dấu.

### `fa_finance_data_quality`

Trả factual count/amount/timestamp, không trả severity:

- mọi count/amount được scope theo selected organization + same-assignment buildings;

- phiếu chưa có hạng mục;
- phiếu KQKD không có item;
- item có kỳ end < start;
- phiếu gắn hóa đơn có `billing_month` sai/thiếu;
- hóa đơn có component/carry không reconcile hoặc payment chưa có allocation;
- tòa thiếu phiếu Tiền nhà tháng chọn;
- số type và số tiền KQKD chưa xác nhận `finance_reporting_role`;
- số tiền thuộc `OUTSIDE_BREAK_EVEN_MODEL`;
- tháng/cửa sổ không đủ điều kiện tính hòa vốn và lý do cụ thể;
- phòng có giá niêm yết NULL/0/âm ảnh hưởng công suất;
- source update gần nhất;
- snapshot đầu/cuối và số tháng finalized;
- tháng chọn còn mở hay đã qua tháng;
- không tiết lộ tên hạng mục/chứng từ restricted trong payload data-quality.

### `fa_virtual_inspection_summary`

RPC riêng nhận selected organization và bắt buộc `is_virtual=true`:

- P&L KQKD theo basis;
- số phiếu/tổng theo ngày phiếu;
- approved/unapproved;
- verified/unverified (`verified_at`);
- source update;
- không trả chỉ số vật lý.

RPC này vẫn yêu cầu quyền phân tích, selected organization và virtual-building access từ cùng assignment; nó không được tái sử dụng một aggregate definer hiện hành nếu aggregate đó thiếu check quyền báo cáo.

Danh sách voucher tòa ảo dùng query phân trang hoặc RPC detail riêng, không dùng list để tính tổng.

## 6.4. Xử lý lỗi

Harden đồng thời `useAccrualMonthReport`, income-expense list/stats, `useProfitVerification` và `useFinancialAnalysis`; không hook nào được đổi lỗi thành `EMPTY`, `[]`, `{ total: 0 }` hoặc payload thành công một phần mà không gắn trạng thái.

Contract hook nên là query result có `data` chỉ khi toàn bộ nguồn bắt buộc hợp lệ, kèm typed `error/sourceFailures`. Verification thiếu một nguồn hiển thị `Không thể đối soát`, không bao giờ badge xanh. Parser số từ RPC giữ `null` là `null`, từ chối `NaN`/`Infinity`/chuỗi không hợp lệ và chỉ format 0 khi server thực sự trả 0.

Mỗi card/tab có ba trạng thái tách biệt:

- loading;
- lỗi tải dữ liệu + nút thử lại;
- tải thành công nhưng thật sự không có dữ liệu.

Query virtual chỉ `enabled=true` khi nút gạt bật. Primary và virtual có query key riêng.

---

# 7. Snapshot lịch sử phòng và hợp đồng

## 7.1. Vì sao cần snapshot

Hợp đồng có thể cho biết tháng nào có giao thoa, nhưng không lưu chính xác tồn kho phòng, trạng thái và giá niêm yết ở cuối mỗi tháng. Nếu phòng được thêm/xóa/chuyển trạng thái, mẫu số lịch sử bị sai. Vì vậy chỉ snapshot từ bây giờ mới tạo nền dữ liệu đáng tin cho đánh giá sau này.

## 7.2. Manifest `finance_month_snapshot_runs`

Mỗi organization/tháng có một capture run authoritative; detail không tự mang trạng thái finalized riêng lẻ. Trường chính:

- `id`;
- `organization_id NOT NULL`;
- `snapshot_month` (ngày đầu tháng đại diện);
- `as_of_date`, `as_of_timestamp`, `scheduled_for`, `captured_at`, `finalized_at`;
- `status` (`PROVISIONAL`, `FINALIZED`, `MISSED`);
- `capture_version`, `source_timezone = 'Asia/Ho_Chi_Minh'`;
- `is_late`, `late_reason`;
- `room_count`, `contract_count`, validation/count summary;
- timestamps và actor/source (`ROLLOUT`, `CRON`, `MONITOR`).

Khóa duy nhất: `(organization_id, snapshot_month)`. Khi `status` là `FINALIZED` hoặc `MISSED`, row manifest và toàn bộ detail liên quan là immutable ở cả function lẫn database guard; không có `ON CONFLICT UPDATE` xuyên qua trạng thái này. `MISSED` nghĩa là hệ thống không có ảnh chụp authoritative cho tháng đó.

## 7.3. Detail phòng và hợp đồng

`finance_room_month_snapshots` dùng khóa `(snapshot_run_id, room_id)` và lưu `organization_id NOT NULL`, building/room name snapshot, trạng thái phòng, giá niêm yết, occupancy group và active-contract count. Detail tham chiếu `as_of_timestamp` của manifest; classification tái sử dụng đúng định nghĩa `occupancy_snapshot_v2`, gồm cả `OCCUPIED` mồ côi hợp đồng đi vào `unavailable`.

`finance_contract_month_snapshots` dùng khóa `(snapshot_run_id, contract_id)` và lưu organization/building/room snapshot, contract number/status/rent, start/end/actual_end, effective end đã tính extension approved/completed. Tách bảng hợp đồng để không mất dữ liệu khi có bất thường nhiều active contract trên một phòng.

Cả hai bảng tham chiếu manifest bằng foreign key. `organization_id`, `snapshot_month` và building scope có thể denormalize để RLS/query hiệu quả, nhưng phải có constraint/trigger bảo đảm khớp manifest. Không dùng khóa `(organization_id, snapshot_month, entity_id)` làm cơ chế upsert chính vì entity đã bị xóa/chuyển scope sẽ để lại row stale.

## 7.4. Capture atomic replace-set

Tạo function nội bộ `capture_finance_month_snapshot(p_organization_id, p_as_of_timestamp, p_finalize)`:

1. lấy advisory/row lock theo organization + month và từ chối ngay nếu run đã `FINALIZED`/`MISSED`;
2. tạo hoặc khóa manifest provisional trong transaction;
3. xóa toàn bộ room/contract detail của run provisional;
4. insert lại **toàn bộ tập physical tại thời điểm function chạy** theo organization; ghi `as_of_timestamp = captured_at`, không giả vờ query được trạng thái lịch sử từ bảng mutable;
5. kiểm tra room partition đủ 5 nhóm, count/detail integrity, organization/building scope và contract anomalies;
6. cập nhật counts/version/freshness; chỉ chuyển sang `FINALIZED` khi capture thật sự chạy trong cutoff window của tháng và mọi validation đạt;
7. rollback toàn transaction nếu bất kỳ bước nào lỗi, để không có snapshot nửa vời.

Function là `SECURITY DEFINER`, fixed `search_path`, fully-qualified relations, không grant cho `authenticated`/`anon`; chỉ cron/internal operator được gọi. Wrapper cron lặp qua organization đang active bằng nguồn nội bộ đáng tin, không nhận danh sách organization từ browser.

Khi rollout, capture một provisional run của tháng hiện tại với ngày thực tế và lưu nó làm baseline từ thời điểm triển khai. Không chạy vòng lặp backfill lịch sử; UI ghi rõ provisional không phải số cuối tháng.

## 7.5. Lịch chạy, missed cutoff và độ trễ

- Lịch được định nghĩa theo `Asia/Ho_Chi_Minh`; wrapper tự tính local date thay vì dựa vào timezone session của `pg_cron`.
- Chạy hằng ngày tại một cutoff window cố định gần cuối ngày Việt Nam để replace provisional bằng trạng thái **thực tế tại `captured_at`**; lần nằm trong cutoff cuối tháng mới được finalize.
- Job có tên ổn định, unschedule trước khi schedule lại. Monitor job phát hiện cutoff bị bỏ lỡ nhưng không dùng dữ liệu hiện tại để tái dựng quá khứ.
- Nếu bỏ lỡ cutoff cuối tháng, transaction chuyển manifest sang `MISSED`, xóa detail provisional cũ và để validation counts NULL; UI trả unavailable. Manual confirmation không thể biến room/status/rent mutable hiện tại thành ảnh chụp quá khứ.
- Catch-up chỉ được capture provisional của **thời điểm hiện tại** cho tháng đang mở, với `is_late=true`; không được gắn nó cho tháng đã lỡ. Backfill chỉ khả thi ở phase sau nếu có append-only room/status/rent/contract event history.
- Retry cùng một scheduled date là idempotent khi còn provisional; retry `FINALIZED`/`MISSED` chỉ đọc/verify, không viết lại.

## 7.6. RLS và đọc lịch sử

- Bật RLS cho manifest và hai bảng detail; `organization_id` luôn `NOT NULL`.
- Revoke direct SELECT/INSERT/UPDATE/DELETE của `authenticated`/`anon` trên cả ba bảng; manifest/count/validation chỉ dành cho capture và history facade.
- `room_count`/`contract_count` toàn organization là metadata validation nội bộ. Client chỉ nhận count tính lại trên detail đã qua exact organization/assignment/building scope.
- RPC `fa_room_inventory_history` là `SECURITY DEFINER` facade theo contract mục 6.3, requested IDs chỉ thu hẹp scope; direct table access phải fail trong test.
- RPC trả total và 5 nhóm trạng thái, weighted occupancy, committed occupancy, listed-rent opportunity, `as_of_date`, `as_of_timestamp`, `captured_at`, status/version và late flag.
- Chỉ dùng finalized month-end cho lịch sử chính. Provisional chỉ phục vụ tháng đang mở và luôn có nhãn.
- Tháng thiếu, `MISSED` hoặc snapshot không qua validation không được trả row 0 giả; trả trạng thái unavailable cùng lý do.

## 7.7. Không khóa P&L trong giai đoạn này

Vì người dùng chưa có quy trình chốt sổ:

- P&L lịch sử tiếp tục phản ánh dữ liệu KQKD mới nhất;
- hiển thị timestamp nguồn và nhãn `Tháng hiện tại chưa kết thúc`;
- không đồng nhất `Chốt LN tháng` với khóa sổ kế toán;
- thiết kế period close/versioned financial snapshot là phase riêng sau khi quy trình kế toán được xác nhận.

---

# 8. Trình bày, biểu đồ và khả năng truy cập

## 8.1. Reuse component

Tiếp tục dùng và nâng cấp:

- `ChartCard`;
- `KpiCard`;
- `DeltaBadge`;
- `TypeBreakdownSection`;
- `ExportButtons`;
- shadcn `Tabs`, `Switch`, `Table`, `Select`;
- Recharts hiện có.

Không tạo một bộ chart card thứ hai.

## 8.2. Quy tắc biểu đồ

- Không dual-axis.
- Revenue/Expense/Net dùng một trục tiền.
- Margin, expense ratio, collection rate là chart % riêng đặt thẳng hàng bên dưới.
- Mỗi chart có tooltip hover/focus, tên series, kỳ, giá trị đầy đủ và basis.
- Từ 2 series trở lên luôn có legend.
- Mọi chart có `Biểu đồ | Bảng dữ liệu` hoặc bảng tương đương mở rộng.
- Heatmap dương/âm có text/icon, không chỉ màu.
- Grid/axis recessive; data mark mảnh, line 2px, marker đủ lớn.

## 8.3. Màu ổn định

- Metric cố định có token cố định: revenue, expense, net, billed, collected, occupied, reserved, available, maintenance, unavailable.
- Màu hạng mục dựa trên stable type/category ID trong registry, không dựa rank hiện tại.
- Không dùng modulo để quay vòng màu; quá capacity thì gom `Khác`, dùng table hoặc small multiples.
- Tòa nhà chỉ dùng multi-line khi người dùng chọn ít tòa trong capacity; nếu nhiều, dùng small multiples/table.
- Chạy automated contrast check và visual/component test cho light/dark trước khi ship; không đánh giá màu chỉ bằng mắt.

## 8.4. Accessibility và responsive

- Chart là figure có title/description và `aria-describedby` liên kết definition/limitation.
- Table có caption/scope header và keyboard focus rõ.
- Status không truyền bằng màu duy nhất.
- Kiểm tra forced colors/print.
- Mobile giữ shell riêng hiện tại; không nhét 8 icon vào bottom bar.
- Bottom navigation mobile giữ các destination cấp cao (`Báo cáo`, `Phân phối`, `Của tôi` theo quyền); trong `Báo cáo` dùng sheet/picker `Chế độ xem` để chọn 8 tab con.
- `Doanh thu & Chi phí` mobile tiếp tục render `ProfitDistributionMobile`.
- KPI thành 1–2 cột; bảng dày có card summary và nút `Xem bảng`; legend đặt dưới; giới hạn số line cùng lúc.

---

# 9. Định nghĩa, độ mới và giới hạn hiển thị

Mỗi card/chart/table có thể mở phần `Cách tính & nguồn dữ liệu` gồm:

- định nghĩa;
- công thức;
- basis;
- scope;
- nguồn RPC;
- `Cập nhật nguồn gần nhất` lấy từ `updated_at`/max source timestamp thực tế;
- `Tạo báo cáo lúc`;
- limitation.

Các disclosure bắt buộc:

- `Tháng hiện tại chưa kết thúc; số liệu có thể tiếp tục thay đổi.`
- `Theo ngày phiếu dùng để đối chiếu; không đồng nghĩa ngày thực nhận/thực chi.`
- `Lịch sử lấp đầy ước tính dùng giao thoa hợp đồng và tồn kho hiện tại.`
- `Snapshot chuẩn chỉ có từ tháng hệ thống bắt đầu ghi nhận; không backfill quá khứ.`
- `Giá trị phòng available dùng giá niêm yết hiện tại/tháng; không phải doanh thu đã mất.`
- `LN/phòng hiện tại không phải lợi nhuận từng phòng và chưa phân bổ chi phí chung.`
- `Chỉ số chính chỉ gồm tòa vật lý; tòa ảo luôn tách riêng.`
- `generated_at` của RPC chỉ là thời điểm chạy query, không được trình bày như thời điểm dữ liệu nguồn thay đổi.

---

# 10. Export

Phase đầu hỗ trợ XLSX và CSV thật; không quảng cáo PDF nếu chưa có implementation.

Workbook chính gồm:

1. `Thong tin` — organization ID/name, kỳ, basis, building scope, thời điểm tạo, source freshness, `virtual_included=false`.
2. Sheet dữ liệu của tab.
3. `Dinh nghia` — công thức và limitation.
4. `Chat luong du lieu` — factual notices.

Quy tắc:

- export aggregate/query đầy đủ, không chỉ trang đang render;
- bảng xếp hạng dùng RPC server-ranked;
- CSV lặp metadata quan trọng trên mỗi row hoặc có file metadata đi kèm;
- export tòa ảo là workbook riêng `kiem-tra-toa-ao-*`, `inspection_only=true`;
- kiểm tra `reports_finance.export` ở caller vì `ExportButtons` hiện không tự gate;
- sửa CSV quoting để xử lý dấu nháy kép, comma và newline đầy đủ.

---

# 11. Kế hoạch triển khai theo phase

## Phase 0 — Baseline và characterization

Mục tiêu: khóa hành vi đúng trước khi refactor.

- Test headline tổng không phụ thuộc 1.000 dòng detail.
- Test dồn tích mặc định, KQKD mặc định, deposit/override/no-item/invoice billing month.
- Test grouping hóa đơn, thanh lý và hidden rows không đổi tổng.
- Test parity desktop/mobile cho phần biến đổi dữ liệu dùng chung.
- Sửa regression self-view cổ đông thuần và khóa matrix permission/default/easter egg bằng test.
- Harden fail-open: accrual/list/stats/verification/analysis phải trả lỗi typed, không giả rỗng/0.
- Khóa parity period anomaly (`end < start`, một phía NULL) giữa SQL và client.
- Chốt strict-vs-redacted restricted contract bằng singleton/difference inference review; mặc định strict cho đến khi được phê duyệt.
- Thiết kế `list_my_finance_scopes()` và exact-scope helper gắn action + membership + building vào cùng organization, với specificity/global deny-wins cho assignment chồng lấn; thêm cross-org và same-org overlap regression tests.
- Characterize invoice cohort hiện tại; chốt billed components và partial-payment allocation policy. Ẩn collection rate chính thức cho dữ liệu chưa có allocation coverage.
- Thêm org-bound query prerequisite tối thiểu cho route legacy (một org thì auto, nhiều org thì block/chọn), rồi replace/revoke old `fa_invoice_collection` ACL bằng fail-closed compat wrapper.
- Harden shareholder/profit-lock writers để server từ chối building ảo, giữ nguyên quyền chốt/phân phối hiện có.
- Bổ sung `scripts/gen-supabase-types.mjs` và package command tương ứng trước migration đầu tiên để bước generate types UTF-8 là executable, không phải placeholder tài liệu.
- Chạy đối soát thực tế một tháng đóng tương đối ổn định và tháng hiện tại; lưu baseline P&L, permission scope và Occupancy v2 current làm artifact của PR.

## Phase 1 — Hợp nhất route, filter và physical scope

- Tạo registry leaf-view thuần hàm, kiểm tra org-scoped permission và fallback URL.
- Gắn command center vào `ProfitHubPage`/`ProfitHubMobile`.
- Đưa 5 tab cũ vào compatibility leaf hoặc tiếp tục render route legacy; **chưa redirect** route analysis.
- Tách filter shell khỏi `FinancialAnalysisReport`.
- Thêm organization selector/query `org`, clear scope khi đổi org và không mount data leaf trước khi org-bound permission sẵn sàng.
- Chuyển primary building selector sang physical-only.
- Tích hợp nút gạt audit tòa ảo, mặc định off và query riêng.
- Sửa thuật ngữ `tiền mặt` → `theo ngày phiếu`.
- Thêm error/retry/empty states.

## Phase 2 — Hai ưu tiên kinh doanh

### 2A. Hiệu quả tòa nhà và hòa vốn lấp đầy

- Thêm assignment `finance_reporting_role` có effective date, metadata xác nhận và UI mapping cho từng loại Thu/Chi.
- Đề xuất `Tiền nhà` là `LANDLORD_RENT_FIXED`, nhưng yêu cầu admin xác nhận.
- Tạo/harden RPC `fa_building_performance` và `fa_building_break_even`.
- Tạo tab waterfall, bảng so sánh và card hòa vốn trực tiếp theo từng tòa.
- Hiện hai lớp: hòa vốn KQKD toàn tòa và hòa vốn doanh thu phòng/lấp đầy theo giá.
- Hiện song song tháng chọn và bình quân 3 tháng; current capacity và theoretical capacity.
- Thêm notice thiếu phiếu Tiền nhà, mapping chưa đủ, chi phí ngoài mô hình, giá phòng không hợp lệ và trường hợp cần >100% công suất.
- Drill-down về mapping, tab Thu — Chi, cơ cấu chi phí và danh sách phòng bị chặn.

### 2B. Lấp đầy & phòng trống

- Dùng Occupancy v2 cho hiện tại và upcoming vacancy.
- Tạo manifest run + hai bảng detail snapshot, capture replace-set atomic, RLS, cron và history RPC.
- Capture provisional hiện tại, không backfill; missed month-end được ghi `MISSED`, không manual-finalize từ bảng mutable.
- Tạo tab lấp đầy và phân biệt authoritative snapshot với estimate cũ.

## Phase 3 — Hoàn thiện các tab còn lại

- Refactor Overview từ `OverviewTab`.
- Tách collections/aging khỏi `OperationsTab`; bổ sung canonical invoice components/payment allocations và RPC cohort/cash-in đúng semantics.
- Hợp nhất `RevenueTab`/`ExpenseTab` qua `TypeBreakdownSection`.
- Thêm RPC ranked voucher đúng toàn tập.
- Tách các dual-axis chart trong `ExpenseTab`, `ProfitTab`, `OperationsTab`.
- Chuyển trend/profit matrix sang `Xu hướng & So sánh`.

## Phase 4 — Nhận định factual, data quality, export, accessibility

- Thay `Insight.severity` và `buildInsights` bằng observation model không ngưỡng.
- Thêm RPC data quality/freshness.
- Thêm definition/limitation/table view cho chart.
- Stable palette + automated contrast/visual checks light/dark.
- Export metadata-rich và virtual export riêng.
- Hoàn thiện mobile view picker và card/table responsive.

## Cutover sau Phase 4 — Chỉ khi toàn bộ gate xanh

- Hoàn tất feature matrix của đủ 5 tab Analysis cũ trên desktop/mobile, gồm error state và export.
- Chạy money parity, permission/self-view, restricted redaction, cohort, cross-tenant và snapshot immutability suites.
- Redirect `/reports/finance/analysis` và alias `/report/finance/analysis` nhưng vẫn giữ guard; dùng feature flag/rollback path trong ít nhất một release.
- Chỉ loại `FinancialAnalysisReport.tsx` khỏi lazy import sau khi production smoke test và telemetry không có regression.

## Phase 5 — Đánh giá sau khi có lịch sử

Chỉ bắt đầu sau khi có ít nhất 6–12 snapshot tháng và người dùng xác nhận mục tiêu:

- định nghĩa target toàn công ty/từng tòa;
- version/effective date cho target;
- cân nhắc chốt kỳ tài chính riêng;
- thêm đánh giá so target và baseline riêng của tòa;
- tuyệt đối không hồi tố target hoặc snapshot giả cho quá khứ.

---

# 12. Critical files

## Shell, route, navigation

- `src/App.tsx`
- `src/pages/reports/finance/ProfitHubPage.tsx`
- `src/pages/reports/finance/ProfitHubMobile.tsx`
- `src/pages/reports/finance/FinancialAnalysisReport.tsx`
- `src/components/layout/Sidebar.tsx`
- `src/components/layout/Breadcrumbs.tsx`
- `src/pages/reports/FinanceReportsPage.tsx`
- `src/pages/home/launcherTiles.ts`
- `src/lib/permissionPages.ts`
- `src/lib/permissions.ts`
- `src/components/auth/RequirePermission.tsx`

## Báo cáo đúng hiện tại

- `src/pages/reports/finance/ProfitDistributionReport.tsx`
- `src/pages/reports/finance/ProfitDistributionMobile.tsx`
- `src/hooks/useAccrualReport.ts`
- `src/hooks/useProfitVerification.ts`
- `src/components/reports/ProfitVerificationBar.tsx`
- `src/components/reports/ExportButtons.tsx`
- `src/hooks/income-expenses/queries.ts`
- `src/hooks/useShareholderProfit.ts`
- `src/hooks/useInvoices.ts`
- `src/hooks/useInvoicePayments.ts`
- `src/hooks/useBulkRecordPayment.ts`

## Analytics tái sử dụng/refactor

- `src/hooks/useFinancialAnalysis.ts`
- `src/components/finance-analysis/types.ts`
- `src/components/finance-analysis/utils.ts`
- `src/components/finance-analysis/OverviewTab.tsx`
- `src/components/finance-analysis/RevenueTab.tsx`
- `src/components/finance-analysis/OperationsTab.tsx`
- `src/components/finance-analysis/ProfitTab.tsx`
- `src/components/finance-analysis/ExpenseTab.tsx`
- `src/components/finance-analysis/TypeBreakdownSection.tsx`
- `src/components/finance-analysis/InsightsPanel.tsx`
- `src/components/finance-analysis/ChartCard.tsx`
- `src/components/finance-analysis/KpiCard.tsx`
- `src/components/finance-analysis/DeltaBadge.tsx`

## Mapping, preference và occupancy

- `src/lib/fixedExpenseCategories.ts`
- `src/lib/feeCategories.ts`
- `src/components/income-expense-types/IncomeExpenseTypeForm.tsx`
- `src/components/income-expense-types/EditIncomeExpenseTypeDialog.tsx`
- `src/hooks/useUiPreferences.ts`
- `src/hooks/usePersistedState.ts`
- `src/hooks/useBuildings.ts`
- `src/components/buildings/BuildingFilterSelect.tsx`
- `src/hooks/reports/useOccupancyDashboard.ts`
- `src/hooks/reports/realEstateReports.ts`
- `src/pages/reports/real-estate/OccupancyReport.tsx`
- `src/lib/accrualAllocation.ts`

## Database

Thêm migration mới (tên timestamp khi triển khai) cho:

- org-scoped `list_my_finance_scopes` plus finance command-center RPC scope/building performance/ranking/data quality/virtual inspection;
- effective-dated `finance_reporting_role` assignment;
- canonical invoice components/payment allocations, cohort v2 và cash-received RPC;
- `finance_month_snapshot_runs`, room/contract details, RLS, capture function, cron và history RPC.

Các định nghĩa hiện hành cần tham chiếu:

- `supabase/migrations/20250101000008_create_roles_and_staff_assignments.sql`
- `supabase/migrations/20260702120000_kqkd_item_level.sql`
- `supabase/migrations/20260611140000_financial_analysis_rpcs.sql`
- `supabase/migrations/20260527000051_invoice_previous_debt.sql`
- `supabase/migrations/20260626000000_fa_accrual_pnl.sql`
- `supabase/migrations/20260704140000_layer_stats_pending_split.sql`
- `supabase/migrations/20260709100000_settlement_invoice_kind.sql`
- `supabase/migrations/20260710150000_tenant_isolation_hardening.sql`
- `supabase/migrations/20260710180000_occupancy_v2_rpcs.sql`
- `supabase/migrations/20260603000011_recurring_vouchers_cron.sql`
- `supabase/migrations/20260713090000_sprint0_fail_closed_permissions.sql`
- `supabase/migrations/20260713100000_sprint1_organization_foundation.sql`
- `supabase/migrations/20260713110100_sprint2b_seed_permission_definitions.sql`
- `supabase/migrations/20260713110300_sprint2d_authorize_v2.sql`
- `supabase/migrations/20260713121000_sprint3b_org_autofill_and_boundary.sql`
- `supabase/migrations/20260713150000_sprint6a_definer_hygiene.sql`
- `scripts/authz-prepared/t5_16_profit_lock_writers.sql`

Verification/support scripts cần dùng hoặc bổ sung:

- `scripts/check-definer-acl.mjs`
- `scripts/check-view-invoker.mjs`
- `scripts/test-cross-tenant.mjs`
- `scripts/test-occupancy-v2.mjs`
- `scripts/reconcile-money.mjs`
- `scripts/gen-supabase-types.mjs` — bổ sung wrapper UTF-8 an toàn, không dùng shell redirection để ghi generated types.

Không sửa migration cũ đã apply; luôn tạo migration mới.

---

# 13. Test plan

## Unit/pure tests

- margin/ratio/delta và trường hợp mẫu số 0;
- weighted occupancy/committed occupancy;
- physical scope loại mọi `is_virtual=true`;
- bật audit không đổi object tổng chính;
- stable color không đổi khi thứ hạng/filter thay đổi;
- overflow hạng mục vào `Khác`;
- factual observation ordering và không có severity/health language;
- mapping từng vai trò Thu/Chi, effective-date lookup, khoảng hiệu lực không chồng lấn, coverage theo số tiền, tie-out role + outside + unmapped, thiếu mapping và missing-voucher state;
- allocation anomaly `end < start`/một phía NULL giữ cùng kết quả giữa SQL và client;
- invoice cohort status/kind allowlist, component split, partial-payment allocation, deposit source, cascade settlement và `previous_debt_sources` dedupe;
- công thức `CMR_core`, `CMR_room`, `R_core_BE`, `R_room_BE` và trường hợp mẫu số <=0;
- thu/chi hộ có chênh lệch, doanh thu ngoài phòng đủ bù fixed cost và break-even bằng 0;
- current/theory capacity, blocked capacity, giá NULL/0/âm và tỷ lệ hòa vốn >100%;
- bình quân 3 tháng tính từ tổng đầu vào, không average tỷ lệ, và thiếu một tháng làm mô hình unavailable;
- hòa vốn doanh thu vẫn có thể hiện khi tháng lịch sử thiếu snapshot, nhưng không được quy đổi lấp đầy;
- month scaffold tài chính khác với missing snapshot (snapshot thiếu không thành 0).

## Route/permission tests

- chỉ `profit_distribution`;
- chỉ `analysis`;
- có cả hai;
- shareholder self-view;
- manager lock/distribute/config;
- manager-salary-only;
- tab lạ/không quyền/tab secret;
- trước cutover, legacy analysis vẫn render compatibility content và giữ guard;
- sau cutover, redirect legacy vẫn giữ guard và có rollback flag;
- user multi-org phải chọn org trước khi leaf/query mount; deep link org sai không fallback sang org khác;
- navigation hiện nếu ít nhất một org có action, nhưng đổi org phải thay đúng tập leaf/action;
- desktop/mobile dùng cùng leaf ID.

## SQL/RPC tests

- primary RPC không trả tòa ảo;
- virtual RPC không trả tòa vật lý;
- profit-lock/distribution writer từ chối building ảo dù gọi trực tiếp ngoài UI;
- tổng P&L/type breakdown tie-out theo mỗi basis;
- KQKD dùng `kqkd_amount`, item cọc/override/no-item đúng;
- accrual giữ invoice month và phân bổ kỳ;
- ranked voucher xếp toàn population trước limit;
- RPC hòa vốn tie-out với P&L cho toàn bộ KQKD và với breakdown theo role;
- cửa sổ tháng/3 tháng dùng đúng accrual allocation hoặc voucher-date basis;
- RPC hòa vốn từ chối tỷ lệ khi mapping/phiếu Tiền nhà/công suất không đầy đủ;
- current/theory capacity phân hoạch đúng 5 nhóm Occupancy v2;
- user bị giới hạn không thấy tòa/org khác;
- permission ở org A không thể kết hợp building assignment ở org B; selected org bắt buộc và exact-scope helper được dùng ở mọi RPC;
- same-org full/area/building assignments chồng lấn áp global deny-wins, specificity/provenance ổn định và `[]` resolve đúng allowed set;
- strict restricted mode không nhận row/label/amount hay existence signal restricted và dùng generic authorized-only/unavailable; redacted aggregate chỉ chạy sau approval, có singleton/difference inference test và không lộ label/detail;
- thiếu report action, membership, selected org hoặc building scope đều bị server từ chối ở cả definer/invoker path;
- `SECURITY DEFINER` không grant `PUBLIC`, fixed search path và qua ACL checker;
- old `fa_invoice_collection(text,text,uuid[])` không còn EXECUTE; compat/v2 direct-call null/empty/mixed-org/no-action/virtual đều fail closed;
- snapshot provisional replace-set loại row phòng/hợp đồng đã biến mất;
- snapshot retry idempotent;
- snapshot không có tòa ảo;
- 5 occupancy groups tạo partition đủ total;
- finalized rerun không duplicate và không thể update/delete detail;
- capture lỗi rollback toàn bộ run; missed cutoff thành `MISSED` không detail/count giả, catch-up không dựng lại tháng cũ từ mutable tables;
- direct SELECT manifest/detail bị từ chối, history facade chỉ trả count theo building scope;
- tháng trước ngày rollout không có row;
- cron không phụ thuộc `auth.uid()`.

## Component tests

- copy/definition/limitation đúng;
- lỗi query không hiển thị 0 giả;
- RPC null/invalid numeric hiển thị unavailable hoặc lỗi, không bị ép thành 0;
- verification thiếu một nguồn không bao giờ hiển thị xanh;
- audit switch default off và query disabled;
- primary export không đổi khi audit bật;
- export audit riêng;
- chart có table alternative/legend/accessible name;
- `Theo ngày phiếu` không bị gọi là payment-date cash.

---

# 14. Verification end-to-end

## Lệnh bắt buộc

Sau migration đổi schema:

```bash
node scripts/gen-supabase-types.mjs
```

Lệnh này chỉ chạy sau khi deliverable Phase 0 `scripts/gen-supabase-types.mjs` đã tồn tại; nếu chưa có thì dừng verify, không thay bằng shell redirect. Wrapper phải chạy `npm run --silent gen:types`, kiểm tra output hợp lệ và ghi `src/integrations/supabase/types.ts` bằng Node `fs` với UTF-8, đồng thời giữ comment header theo convention repo.

Kiểm tra security/schema:

```bash
node scripts/check-definer-acl.mjs
node scripts/check-view-invoker.mjs
node scripts/test-cross-tenant.mjs
node scripts/test-occupancy-v2.mjs
```

Dù migration dự kiến ưu tiên function/table thay vì view, vẫn chạy cả hai ACL/view checker ở lượt verify cuối để bắt thay đổi ngoài dự kiến. Các script DB phải chạy trên test project có seed persona/org/building tương ứng, không chạy mù trên production.

Đối soát tiền cho tháng hiện tại và ít nhất một tháng cũ:

```bash
node scripts/reconcile-money.mjs 2026-07
node scripts/reconcile-money.mjs 2026-06
```

Test/type/build:

```bash
npx vitest run src/components/finance-analysis/__tests__/utils.test.ts src/lib/__tests__/permissionPages.test.ts src/lib/__tests__/accrualAllocation.property.test.ts src/lib/__tests__/shareholderProfit.test.ts
npx vitest run src/pages/reports/finance/__tests__
npx vitest run src/lib/__tests__/financeReportingRole.test.ts src/lib/__tests__/financeInvoiceCohort.test.ts
npm run typecheck:baseline
npm run build
git diff --check
```

Hai file pure test và thư mục route/component test ở trên là deliverable phải được tạo trong PR triển khai. `npm run typecheck:baseline` là gate TypeScript hiện tại vì raw `npx tsc --noEmit -p tsconfig.app.json` còn lỗi baseline ngoài phạm vi; chỉ chuyển raw `tsc` thành gate sau khi triage baseline, nhưng PR không được thêm lỗi mới. Kiểm tra palette/light/dark bằng component/browser tests và contrast tooling của repo, không phụ thuộc validator ngoài codebase.

## Browser/Playwright MCP

Đăng nhập tài khoản test và kiểm tra trực tiếp:

1. Mở URL canonical, xác nhận selected organization và default theo quyền; user multi-org không bắn query trước khi chọn org.
2. So số Doanh thu/Chi phí/LN của `Tổng quan` với tab `Doanh thu & Chi phí` ở cùng tháng/tòa/basis.
3. Chuyển dồn tích ↔ ngày phiếu và kiểm tra copy/nguồn/đối soát.
4. Bật tòa ảo:
   - tổng chính không đổi;
   - thứ hạng tòa không đổi;
   - occupancy không đổi;
   - nhận định không đổi;
   - chỉ panel kiểm tra xuất hiện.
5. Kiểm tra tòa có/thiếu phiếu Tiền nhà và waterfall.
6. Kiểm tra room statuses, available opportunity và hợp đồng có extension.
7. Kiểm tra billing cohort, current-charge/carry/deposit allocation, aging live và cash-in không bị trộn.
8. Kiểm tra tab/org URL bằng reload/Back/Forward, org không quyền và cross-assignment không rò dữ liệu.
9. Kiểm tra easter egg và self-view cổ đông/quản lý không regression.
10. Kiểm tra mobile widths, safe-area, view picker và bảng/card.
11. Kiểm tra light/dark, keyboard, tooltip và table alternative.
12. Kiểm tra restricted strict/redacted mode bằng persona thiếu `restricted_view`, gồm trường hợp chỉ có một khoản restricted.
13. Xem console errors và network/RPC failures ở từng tab.

Sau mỗi lỗi: sửa → chạy lại test liên quan → browser re-test. Không commit/push cho tới khi toàn bộ critical scenarios xanh.

---

# 15. Acceptance criteria

- Trước cutover không redirect sớm; sau khi mọi gate xanh chỉ còn một trung tâm analytics được duy trì tại URL canonical và route legacy là redirect có guard.
- Báo cáo `Doanh thu & Chi phí` hiện tại vẫn cho cùng kết quả với baseline đã khóa.
- Mọi RPC mới tự kiểm tra session và gắn report action + active membership + building scope vào cùng selected organization; overlapping assignments áp deterministic specificity/global deny-wins. Không dựa vào `authorize_v2` shadow, `get_my_permissions()` global hoặc frontend guard.
- Restricted contract được owner/security phê duyệt: strict mode không lộ amount/existence signal và dùng generic authorized-only/unavailable; redacted aggregate nếu được chọn phải qua inference tests. Detail/export không lộ tên/chứng từ và export cần `reports_finance.export`.
- Mọi KPI chính physical-only; không có name-based exclusion.
- Nút tòa ảo mặc định off và không thể thay đổi bất kỳ tổng chính nào khi bật.
- Lợi nhuận từng tòa giải thích được Doanh thu → Tiền nhà → Chi phí khác → LN và nêu rõ thiếu dữ liệu.
- Mỗi tòa hiện trực tiếp hòa vốn KQKD và hòa vốn tiền phòng/lấp đầy theo giá cho tháng chọn và tham chiếu 3 tháng.
- Hòa vốn tách fixed/variable/pass-through bằng mapping đã xác nhận, có effective date và tie-out đúng với KQKD; thiếu mapping/phiếu Tiền nhà hoặc mẫu số không hợp lệ thì trả unavailable cùng lý do, không xuất tỷ lệ giả.
- Lấp đầy hòa vốn hiện cả current/theory capacity, blocked capacity và giải thích toán học khi vượt 100%.
- Phòng trống chỉ tính nhóm `available`; maintenance/unavailable/reserved được tách đúng.
- Không gọi current listed-rent opportunity là lost revenue thực tế.
- Cohort chính chỉ gồm current-charge principal của hóa đơn tháng đã phát hành/phải thu; carried invoice/deposit debt, cascade settlement và payment allocation không bị đếm đôi. Dữ liệu thiếu allocation trả unavailable; không gọi invoice-cohort collection là tiền thực nhận trong tháng.
- `useFinancialAnalysis`/route legacy không còn gọi old `fa_invoice_collection`; signature cũ bị revoke/drop và direct-call regression test xanh.
- Không còn nhận định dùng ngưỡng 20/70/85/90, 10% hoặc -10% chưa được duyệt hay thông báo “an toàn”.
- Snapshot bắt đầu từ ngày rollout, có manifest, replace-set atomic, `PROVISIONAL`/`FINALIZED`/`MISSED` rõ ràng, finalized immutable và không backfill/catch-up giả từ bảng mutable; snapshot tables không cho client direct SELECT.
- Chart không dual-axis, màu ổn định, có legend/table/accessibility.
- Lỗi dữ liệu khác biệt rõ với số 0 hợp lệ.
- KPI có thể ở trạng thái unavailable với nguyên nhân cụ thể; không bắt buộc mọi tòa/tháng phải có một tỷ lệ để lấp UI.
- Export ghi rõ kỳ, basis, scope, freshness, định nghĩa và `virtual_included=false`.
- Quyền cổ đông, quản lý, profit lock và salary self-view không thay đổi; profit writer từ chối building ảo ở server.
- `npm run typecheck:baseline`, build, targeted tests, ACL/view/cross-tenant checks và `git diff --check` đều xanh; không có lỗi TypeScript mới so baseline.

---

# 16. Ngoài phạm vi hiện tại

Không đưa vào báo cáo như số liệu thật cho đến khi có mô hình dữ liệu/quy tắc được phê duyệt:

- vacancy-days và lost rent lịch sử;
- occupied room-days;
- lợi nhuận đầy đủ từng phòng;
- phân bổ shared overhead về tòa;
- utility margin authoritative;
- liên kết maintenance/job/asset cost với P&L;
- mô hình hòa vốn nâng cao dùng room-days, mix phòng tối ưu, giá theo mùa, dự báo/độ nhạy hoặc giả định chi phí step-fixed; phiên bản hiện tại chỉ dùng mapping cố định/biến đổi đã xác nhận và công suất giá niêm yết;
- CapEx/OpEx, khấu hao;
- budget vs actual;
- CAC/LTV/churn;
- định giá tài sản/yield/cap rate;
- composite business score;
- khóa sổ kế toán và versioned financial statements.

Các mục này là phase sau, không được mô phỏng bằng công thức gần đúng trong UI hiện tại.
