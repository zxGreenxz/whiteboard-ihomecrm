# Kế hoạch đánh giá và tối ưu toàn hệ thống iHomeCRM

> Kế hoạch này chuyển [`docs/prompts/PROMPT-HOI-DONG-PHAN-TICH-THUC-TE.md`](../prompts/PROMPT-HOI-DONG-PHAN-TICH-THUC-TE.md) thành một chương trình kiểm định có thể thực thi cho iHomeCRM. Đây là **kế hoạch điều tra và ra quyết định**, chưa phải báo cáo bug và không tự cho phép sửa code hoặc dữ liệu production.

## 1. Mục tiêu và quyết định cần đạt

### 1.1. Câu hỏi trung tâm

> Hệ thống hiện tại có điểm nào có thể làm sai tiền, sai trạng thái nghiệp vụ, lộ dữ liệu, mất dữ liệu, chạy không ổn định hoặc khiến vận hành thất bại âm thầm; và thứ tự tối ưu nào tạo giá trị cao nhất với rủi ro triển khai thấp nhất?

### 1.2. Mục tiêu kinh doanh

1. Bảo đảm các luồng tiền và trạng thái cốt lõi đúng, có thể đối chiếu và không ghi nửa chừng.
2. Bảo đảm người dùng chỉ đọc/ghi đúng tenant, toà nhà và quyền thao tác được giao.
3. Giảm phụ thuộc vào thao tác thủ công, trí nhớ và scheduler chạy trong trình duyệt.
4. Làm lỗi hiện rõ, có thể retry hoặc điều tra; không biến lỗi thành danh sách rỗng hay toast thành công giả.
5. Tối ưu hiệu năng theo số đo thực tế, không tối ưu cảm tính.
6. Hình thành backlog triển khai có thứ tự, dependency, rollback và tiêu chí nghiệm thu rõ ràng.

### 1.3. Kết quả phải đủ để ra các quyết định

- Có cần chặn release hoặc chặn một đường ghi nào không?
- Luồng nào cần containment trước khi sửa triệt để?
- Logic nào phải chuyển từ client sang transaction/RPC phía database?
- Dữ liệu lịch sử nào có khả năng sai và cần đo/reconcile?
- Điểm nào nên sửa cục bộ, điểm nào cần hardening toàn lớp bug?
- Tự động hoá nào có ROI vận hành cao nhất?
- Nợ kỹ thuật nào thực sự làm tăng xác suất lỗi nghiệp vụ và nên ưu tiên?

## 2. Cấu hình phiên hội đồng đề xuất

```text
CENTRAL_QUESTION = Hệ thống hiện tại có điểm nào có thể làm sai tiền, sai trạng thái nghiệp vụ, lộ/mất dữ liệu, suy giảm hiệu năng hoặc khiến vận hành thất bại âm thầm; và nên tối ưu theo thứ tự nào?
SCOPE            = Lead/cọc → hợp đồng → chỉ số → hoá đơn → thu tiền → phiếu thu chi/sổ quỹ → bàn giao/đối soát → lương/lợi nhuận; kèm RBAC/RLS, báo cáo, Storage, Edge Function, Vercel Cron và worker
BUSINESS_GOAL    = Số liệu đúng, ghi nguyên tử/idempotent, đúng quyền, lỗi quan sát được, vận hành ít thao tác tay và hệ thống chịu được tăng trưởng dữ liệu
MODE             = PROPOSE
DEPTH            = SYSTEM_WIDE
TIMEBOX          = 10-15 ngày làm việc cho kiểm định; triển khai tách thành các đợt sau phê duyệt
LIVE_DB_ACCESS   = AVAILABLE_READ_ONLY
OUTPUT_PATH      = docs/hoi-dong-phan-tich-YYYY-MM-DD.md
SPECIAL_CONCERNS = Dòng tiền nguyên tử; canonical ledger; cọc và doanh thu; migration drift; SECURITY DEFINER/RLS; silent failure; timezone Việt Nam; cap 1000 dòng; concurrency; idempotency cron/worker; hiệu năng frontend và query
```

`MODE = PROPOSE` được chọn vì yêu cầu là đánh giá và lập kế hoạch tối ưu. Hội đồng không sửa implementation hay dữ liệu production trong phiên kiểm định. Sau khi duyệt backlog mới mở phiên `IMPLEMENT_AFTER_APPROVAL` riêng cho từng đợt.

## 3. Phạm vi, mức ưu tiên và phần loại trừ

### 3.1. Phạm vi theo tầng

| Tầng | Thành phần cần kiểm định | Mục tiêu |
|---|---|---|
| Giao diện | `src/pages/`, `src/components/`, route guards, mobile/PWA | Đường thao tác thật, validation, feedback, accessibility, số bước |
| Data client | `src/hooks/`, React Query cache, Supabase calls | Error handling, pagination, cache key, invalidation, retry, double-submit |
| Nghiệp vụ thuần | `src/lib/`, Zod, calculator, property tests | Công thức, rounding, timezone, invariant và TS/SQL parity |
| Database | Tables, constraints, FK, RLS, RPC, trigger, view, index | Source of truth, atomicity, concurrency, authorization, drift |
| Job và tích hợp | `supabase/functions/`, `api/`, `worker/`, `vercel.json`, Storage/R2 | Service-role boundary, idempotency, retry, lịch chạy và quan sát lỗi |
| Báo cáo | Dashboard, tài chính, công nợ, lương, lợi nhuận | Canonical source, cap 1.000 dòng, số tổng, snapshot và kỳ khoá |
| Delivery | Git, migrations, generated types, Vercel deployment | Working tree/HEAD/deploy/live DB drift và khả năng rollback |

### 3.2. Phân tầng luồng để tránh “system-wide nhưng nông”

**Tier A — điều tra sâu, bắt buộc truy vết end-to-end**

1. Thu tiền hoá đơn, thu một phần, tiền thừa, hoàn tác, tiền thối và cấn trừ.
2. Cọc giữ chỗ → hợp đồng → cọc gộp hoá đơn → hoàn/bỏ cọc/thanh lý.
3. Chỉ số → hoá đơn → công nợ → báo cáo doanh thu/KQKD.
4. Phiếu thu chi → sổ quỹ → bàn giao → đối soát/chốt kỳ.
5. Lương/thưởng/chia lợi nhuận → phiếu chi và báo cáo.
6. RBAC/RLS/`SECURITY DEFINER` trên tất cả object nằm trên năm luồng trên.

**Tier B — điều tra theo bug class và giao cắt**

- Lead/khách/phòng/hợp đồng và các state transition.
- Kho vật tư, tài sản, công việc/sự cố khi có side effect tiền hoặc trạng thái.
- Dashboard, export, notification, cron, Zalo worker, Storage/R2.
- Mobile/offline, cache, realtime, accessibility và hiệu năng.

**Tier C — rà nhanh, chỉ nâng lên điều tra sâu khi có tín hiệu**

- Trang cài đặt/danh mục ít dùng, UI polish và dead code không chạm luồng thật.
- Tài liệu lịch sử chỉ dùng để sinh giả thuyết, không dùng làm bằng chứng kết luận.

### 3.3. Loại trừ trong phiên đánh giá

- Không mutation production, không RPC ghi, không thao tác Auth/Storage tạo hoặc xoá dữ liệu.
- Không apply migration, regenerate types, sửa code, refactor hay “tiện tay vá lỗi”.
- Không benchmark bằng `EXPLAIN ANALYZE` trên production nếu chưa có phê duyệt riêng.
- Không kết luận production từ migration, generated types hoặc tài liệu mà chưa đối chiếu live DB/runtime.
- Không đánh giá lại từng pixel; UI chỉ được ưu tiên khi ảnh hưởng correctness, tốc độ vận hành, mobile hoặc accessibility.

## 4. Nguyên tắc bằng chứng và quản trị hiện trường

1. Mọi claim đáng kể phải gắn `FACT`, `INFERENCE`, `HYPOTHESIS` hoặc `UNKNOWN`.
2. P0/P1 chỉ được xác nhận sau khi ít nhất hai vai trò kiểm tra độc lập.
3. Dùng thứ tự nguồn: runtime production → live DB → working tree → HEAD/deploy → migration/types → docs.
4. Báo cáo cũ như `docs/AUDIT-TOAN-TRANG-2026-07-08.md` và `docs/hoi-dong-co-van-2026-07-03.md` chỉ là **risk register đầu vào**. Mỗi finding phải tái kiểm chứng; không copy severity hoặc trạng thái cũ.
5. Working tree hiện có nhiều thay đổi của người dùng. Khi chạy phiên thật phải snapshot lại bằng Git, không reset/stash/checkout và không trộn chúng vào kết luận production.
6. Query live DB chỉ đọc, có scope thời gian/toà/tenant và timeout phù hợp; output chỉ dùng aggregate hoặc ID đã rút gọn.
7. Không ghi PAT, JWT, service-role key, password, connection string hay PII vào terminal log và báo cáo.

## 5. Cơ cấu hội đồng và phân công

| Vai trò | Trách nhiệm chính | Đầu ra độc lập |
|---|---|---|
| Chủ tọa/Master Agent | Scope, evidence ledger, mâu thuẫn, severity, quyết định | Hồ sơ phiên, decision log, báo cáo tổng hợp |
| COO/Product Operations | SOP thực tế, khối lượng, thao tác tay, bottleneck | Bản đồ tác vụ theo ngày/tháng và chi phí vận hành |
| Chuyên gia BĐS cho thuê | Vòng đời lead/cọc/HĐ/phòng/move-out | State machine, impossible states, edge cases |
| Kế toán trưởng | Canonical ledger, cọc/doanh thu, kỳ, đối chiếu | Invariant tiền, ví dụ số, SQL aggregate |
| Architect/Postgres Lead | Call graph, transaction, concurrency, drift, index | Bản đồ kỹ thuật và phương án kiến trúc tối thiểu |
| Security Auditor | RLS/RBAC/RPC/Storage/service-role | Ma trận actor × object × action và finding quyền |
| Frontend/UX Lead | Form, lỗi, cache, mobile, accessibility, hiệu năng | Journey, failure-state matrix, UX/perf baseline |
| QA/Data Quality/SRE | Phản ví dụ, live anomaly, test/observability | Test matrix, reproducer, anomaly queries |

Mỗi vai trò lập dossier riêng trước khi hội đồng tổng hợp. Với đề xuất lớn như “chuyển toàn bộ sang RPC”, “tạo cron billing” hoặc “refactor data model”, Chủ tọa chỉ định một devil's advocate đánh giá chi phí drift, rollback và compatibility.

## 6. Quy trình thực hiện theo cổng kiểm soát

### Giai đoạn 0 — Khởi động và đóng băng hiện trường (0,5 ngày)

**Việc làm**

- Đọc `AGENTS.md`, `CLAUDE.md`, `AI_RULES.md` và instruction lồng liên quan.
- Ghi timestamp `Asia/Ho_Chi_Minh`, branch, HEAD, `git status --short`, diff summary và commit gần nhất.
- Xác định production deployment hash; nếu không xác định được, ghi `UNKNOWN`.
- Ghi khả năng truy cập code, browser, tài khoản test, live DB metadata/data và log hạ tầng.
- Chốt scope, exclusions, ngân sách query và tiêu chuẩn dừng.

**Cổng G0:** Có hồ sơ phiên đầy đủ và không có thao tác làm thay đổi hiện trường.

### Giai đoạn 1 — Baseline sức khoẻ có số đo (0,5-1 ngày)

**Baseline code và delivery**

- Chạy type-check thật: `npx tsc --noEmit -p tsconfig.app.json` và baseline gate `npm run typecheck:baseline`.
- Chạy `npx vitest run`; tách lỗi mới khỏi lỗi có sẵn.
- Chạy build, đo chunk/bundle warning; không coi build xanh là type-check xanh.
- Thống kê `as any`, `@ts-ignore`, `select('*')`, query không check `.error`, `catch` trả `[]/{}`, mutation nhiều `await`, `SECURITY DEFINER`, view và cron entry.
- Lập bảng migration trong repo, types generated, object live và deployed commit để dò drift.

**Baseline runtime và dữ liệu**

- Đo Web Vitals hoặc ít nhất navigation/load/network waterfall ở các route Tier A trên desktop và mobile.
- Đo số request, payload, query lặp, lỗi console/network và thời gian hoàn thành thao tác.
- Đo row count/status distribution trên bảng lõi; xác định bảng đã/sắp vượt cap PostgREST.

**Cổng G1:** Có baseline tái lập được. Chưa kết luận finding từ số đếm tĩnh đơn lẻ.

### Giai đoạn 2 — Khảo sát độc lập và lập risk register (1-2 ngày)

Mỗi chuyên gia trả một dossier gồm file/object cần đọc, call graph sơ bộ, 3-7 giả thuyết, bằng chứng thiếu và query/test phân xử. Chủ tọa gộp query trùng nhưng giữ nguyên kết luận độc lập.

Risk register ban đầu phải bao phủ:

- tiền ghi nhiều bước, retry tạo trùng, lost update và mirror client-side;
- hai nguồn sự thật giữa payment, invoice, ledger, deposit và report;
- RLS/RPC thiếu scope, grant rộng, `search_path`, view invoker và service-role;
- migration/function/type drift;
- cap 1.000 dòng, aggregate client-side và query không ổn định;
- silent read/write failure, cache stale, double-submit;
- timezone, cuối tháng, rounding và period lock;
- cron/worker chạy trùng, bỏ lịch, retry hoặc không có audit record;
- dữ liệu legacy/orphan/duplicate/impossible state.

**Cổng G2:** Risk register có test phân xử cho từng giả thuyết; chưa đưa hypothesis vào danh sách bug.

### Giai đoạn 3 — Dựng bản đồ end-to-end (2-3 ngày)

Với từng luồng Tier A, dựng chuỗi có trích dẫn:

```text
Actor/quyền
  → route/page/dialog
  → default + Zod/RHF validation
  → hook/query/mutation/cache key
  → table call hoặc RPC
  → RLS/RBAC/SECURITY DEFINER
  → transaction/trigger/lock
  → bảng/view/source of truth
  → invalidation/toast/error state
  → báo cáo/cron/downstream
```

Mỗi mũi tên phải đánh dấu client/server, sync/async, transaction boundary, source/mirror/cache, side effect, retry và nơi có thể nuốt lỗi.

**Cổng G3:** Ít nhất sáu luồng Tier A có bản đồ hoàn chỉnh và đã search toàn repo để tìm mọi caller/callee quan trọng.

### Giai đoạn 4 — Kiểm chứng code, live DB và runtime (3-5 ngày)

Thực hiện theo thứ tự rủi ro:

1. Tiền/cọc/ledger/kỳ kế toán.
2. Authorization và dữ liệu xuyên tenant/toà.
3. State transition, atomicity, concurrency và idempotency.
4. Silent failure, mobile và error recovery.
5. Hiệu năng query/frontend và automation.

Mỗi claim đi qua vòng đối kháng: người đề xuất → phản biện nghiệp vụ/kế toán → phản biện kỹ thuật/bảo mật → QA phân xử → Chủ tọa chốt `CONFIRMED/PARTIAL/REJECTED/OPEN`.

**Cổng G4:** P0/P1 có reproducer/query, blast radius, hai người kiểm tra và confidence không thấp.

### Giai đoạn 5 — Phân tích tối ưu và thiết kế phương án (1-2 ngày)

Mỗi finding đã xác nhận phải có tối thiểu hai phương án khi thay đổi đáng kể:

- **Phương án tối thiểu:** phục hồi correctness với blast radius nhỏ.
- **Phương án hardening/chiến lược:** chặn cả lớp bug hoặc giảm chi phí vận hành dài hạn.

So sánh theo correctness, security, performance, effort, migration risk, compatibility, observability và rollback. Không dùng refactor lớn để thay cho containment cần làm ngay.

**Cổng G5:** Backlog đã tách containment, fix, reconciliation, hardening, UX/performance và refactor.

### Giai đoạn 6 — Báo cáo, phản biện cuối và phê duyệt (1 ngày)

- Xuất báo cáo theo đầy đủ format của master prompt.
- Tổ chức review 60-90 phút, tập trung P0/P1, disagreement và `UNKNOWN`.
- Chủ hệ thống duyệt riêng: chặn đường ghi, migration, data reconciliation và thay đổi workflow.
- Chỉ sau phê duyệt mới lập phiên triển khai theo wave ở Mục 11.

**Cổng G6:** Có decision log: `APPROVE`, `INVESTIGATE_MORE`, `DEFER` hoặc `REJECT` cho từng action lớn.

## 7. Ma trận điều tra theo luồng

| Luồng | Câu hỏi bắt buộc | Invariant/kiểm tra trọng tâm |
|---|---|---|
| Lead → cọc → HĐ | Có model legacy/song song? Convert có atomic? Phòng được giữ/mở đúng lúc? | Một cọc thật có nguồn canonical; phòng không vừa RESERVED vừa có HĐ xung đột |
| HĐ → chỉ số → hoá đơn | Baseline chỉ số nào được dùng? Kỳ/giá/định mức lấy tại thời điểm nào? | Consumption không âm; không bỏ chỉ số hợp lệ; một HĐ/phòng/kỳ không có HĐ trùng ngoài chủ ý |
| Hoá đơn → payment | Thu một phần, retry, overpayment, rounding, hoàn tác chạy thế nào? | `paid = payment hợp lệ - đảo/thối`; retry cùng key không tạo thêm payment |
| Payment → ledger | Payment và phiếu có cùng transaction? Item bảo toàn tổng? | Mỗi payment tiền thật có đúng số ledger leg theo thiết kế; tổng item = tổng phiếu |
| Cọc/doanh thu/cấn trừ | Nhận diện bằng cột hay chuỗi? Báo cáo nào tính khoản nào? | Cọc không vào doanh thu; CT không phồng tiền mặt; `kqkd_amount` bảo toàn phân loại |
| Sổ → bàn giao → đối soát | Hai chân tài khoản, trạng thái duyệt và as-of có nhất quán? | Số dư = đầu + thu - chi đủ các leg; snapshot không đổi sau khoá hoặc có adjustment/audit |
| Lương/lợi nhuận | Compute ở đâu? Payout có idempotent? Chốt tháng có khoá? | Một payout không tạo hai phiếu; phân bổ = pool trong sai số cho phép |
| RBAC/RLS | Caller nào đọc/ghi object nào? RPC có tự guard scope? | Mọi record scoped chỉ actor hợp lệ truy cập; anon chỉ gọi RPC public chủ ý |
| Cron/worker | Ai chạy, lock/dedup ở đâu, lỡ lịch xử lý thế nào? | Cùng kỳ/job key chạy lại không tạo side effect mới; có run/error record |
| UI/cache | Lỗi có hiện thật? Data sau mutation có mới? Mobile có chống double tap? | Không success toast khi ghi chưa hoàn tất; error khác empty; cache key bao đủ filter/scope |
| Hiệu năng | Query/payload/chunk nào chiếm phần lớn? Có over-fetch/N+1/cap? | Tổng server-side không phụ thuộc trang đầu; latency/payload có baseline trước-sau |

## 8. Gói truy vấn live DB read-only

Các query phải đặt trong file SQL tạm ngoài vùng commit hoặc thư mục audit được phê duyệt, chạy bằng `node scripts/query-sql.mjs <file.sql>`. Không sửa script để hard-code credential.

### 8.1. Metadata pack

- Columns, type, default, generated, check, FK và `ON DELETE` của bảng Tier A.
- `pg_get_functiondef`, signature, volatility, `prosecdef`, config `search_path` và grants của RPC liên quan.
- Trigger event, timing, function và thứ tự tên trigger.
- RLS enabled/forced, policy command/roles/qual/with-check.
- View definition, owner và `security_invoker`.
- Index/unique/partial predicate trên FK, idempotency key và các filter nóng.

### 8.2. Data-quality pack

- Row count và status distribution theo khoảng thời gian/toà phù hợp.
- Orphan, duplicate, soft-deleted record vẫn được aggregate và impossible state.
- Hợp đồng hiệu lực chồng khoảng trên cùng phòng.
- Invoice/payment/ledger/deposit không đối ứng hoặc đối ứng nhiều lần.
- Cron run trùng, run thiếu, queue kẹt và error chưa xử lý.

### 8.3. Financial invariant pack

- `invoice.paid_amount` so với tổng payment hợp lệ trừ đảo/thối.
- Payment tiền thật so với voucher/ledger liên quan.
- Tổng `income_expense_items` so với tổng voucher và `kqkd_amount`.
- Cọc thực thu theo item APPROVED/chưa xoá so với nghĩa vụ và `deposit_paid`.
- Số dư account tính lại từ tất cả leg so với view/snapshot.
- Số liệu dashboard/report so với aggregate SQL không cap.
- Mutation backdate trong kỳ đã chốt và độ lệch snapshot nếu có.

Kết quả chỉ ghi số anomaly, tổng tiền và timestamp; không dump thông tin khách hàng.

## 9. Kế hoạch runtime và test phân xử

### 9.1. Ma trận actor

- Super admin.
- Tenant admin/owner.
- Staff full scope.
- Staff chỉ một toà hoặc một khu, có/không có action permission.
- Kế toán/nhân viên thu tiền nếu role hiện hành có phân biệt.
- Cổ đông hoặc profit manager.
- Anon trên route public.

### 9.2. Kịch bản Tier A

| Nhóm | Kịch bản tối thiểu |
|---|---|
| Happy path | Tạo/đọc/cập nhật bằng dữ liệu test được duyệt, kiểm UI → DB → report |
| Tiền | Thu đủ, thu một phần, nhiều lần cùng ngày, backdate, overpayment, rounding, cấn trừ, hoàn tác |
| Failure | Mạng rớt trước/sau RPC, một bước con lỗi, retry, refresh giữa thao tác |
| Concurrency | Hai actor thao tác cùng invoice/account/job; double click trên mobile |
| Scope | Đúng/sai toà, object ID đoán được, RPC gọi trực tiếp, anon/authenticated |
| Lifecycle | Soft delete/cancel/restore; gia hạn/chuyển phòng/thanh lý; dữ liệu legacy/null |
| Time | Trước 07:00 Việt Nam, cuối tháng, tháng 2, qua năm và backdate kỳ khoá |
| Scale | Dữ liệu >1.000, trang cuối, filter đổi nhanh, export toàn bộ |
| UX | Loading/error/empty riêng biệt, focus/keyboard, overflow 360px, console/network error |
| Job | Chạy lại cùng key, hai scheduler cùng lúc, timeout, job lỡ lịch, queue retry |

Runtime production chỉ dùng đường đọc hoặc thao tác không mutation. Kịch bản ghi phải chạy trên local/staging hoặc bộ dữ liệu test đã được chủ hệ thống duyệt riêng.

### 9.3. Lớp test cần sinh từ finding

- Unit cho helper/validation/state transition thuần.
- Property-based cho bảo toàn tổng, phân bổ, rounding, kỳ và tính đơn điệu.
- SQL invariant cho ledger, RLS, constraint, trigger và race-sensitive logic.
- Integration cho RPC transaction, idempotency và rollback.
- Browser E2E desktop/mobile cho luồng người dùng và lỗi mạng.
- Contract/parity test giữa TypeScript và SQL khi cùng biểu diễn một công thức.

## 10. Phương pháp đánh giá cơ hội tối ưu

### 10.1. Không gộp mọi “tối ưu” thành hiệu năng

Mỗi cơ hội được phân một hoặc nhiều loại:

1. Correctness/financial integrity.
2. Security/privacy.
3. Reliability/recovery.
4. Operational automation.
5. UX/mobile/accessibility.
6. Query/runtime performance.
7. Delivery/migration quality.
8. Maintainability/dead-code/type safety.

### 10.2. Điểm ưu tiên

Chấm từng action trên thang 1-5:

- `I` — tác động nếu xảy ra.
- `L` — khả năng xảy ra/tần suất.
- `B` — blast radius.
- `U` — mức khó phát hiện trước khi gây hậu quả.
- `V` — giá trị vận hành/giờ công tiết kiệm.
- `E` — effort.
- `M` — migration/implementation risk.
- `C` — confidence của bằng chứng (`HIGH=3`, `MEDIUM=2`, `LOW=1`).

Điểm dùng để sắp thứ tự trong cùng severity:

```text
Priority score = ((I × L × B) + U + V) × C / (E + M)
```

Severity vẫn theo P0-P3 của master prompt. Công thức không được dùng để hạ một P0 có bằng chứng; nó chỉ giúp xếp thứ tự các action tương đương và phải kèm judgement của hội đồng.

### 10.3. Chỉ số baseline và acceptance target

Không đặt mục tiêu số tuỳ ý trước khi đo. Báo cáo phải có baseline và đề xuất target cho:

- thời gian và số thao tác hoàn thành thu tiền, ghi chỉ số, tạo hoá đơn, phiếu thu chi;
- p50/p95 route load và mutation latency ở staging/runtime cho phép;
- số request, payload và bundle/chunk theo route;
- tỷ lệ query lỗi bị hiển thị thành empty/success giả;
- số aggregate client-side có nguy cơ cap;
- số RPC nhạy cảm thiếu đủ guard/grant/search path;
- số thao tác tiền nhiều bước ngoài transaction;
- số cron/job không có idempotency/run log;
- anomaly count và tổng tiền lệch theo từng invariant;
- type-check regression và test coverage của invariant Tier A.

## 11. Lộ trình triển khai sau khi báo cáo được duyệt

Đây là khung triển khai, không phải phê duyệt thay đổi.

### Wave 0 — Containment và release gate (0-2 ngày tuỳ finding)

- Feature flag/chặn đường ghi hoặc release blocker cho P0.
- Query đo anomaly và dashboard theo dõi tạm thời.
- Hướng dẫn vận hành workaround có thời hạn.
- Không backfill dữ liệu.

**Exit:** Không tiếp tục phát sinh hậu quả mới; rollback containment đã thử.

### Wave 1 — Correctness và Security (1-2 sprint)

- Sửa tối thiểu các P0/P1 đã xác nhận.
- Transaction, lock và idempotency cho đường tiền.
- RLS/RPC/view hardening và test cross-tenant.
- Regression test cho từng root cause.

**Exit:** Invariant xanh trên staging; type gate/test/build xanh; E2E happy + edge path xanh; không còn P0 mở.

### Wave 2 — Data reconciliation (phiên riêng, duyệt riêng)

- Query dry-run và lượng hoá từng loại dữ liệu sai.
- Backup/export kiểm soát, mapping rule, script idempotent và rollback/compensation.
- Chạy thử staging/bản sao, peer review kế toán, rồi mới xin phê duyệt production.
- Post-check bằng cùng invariant độc lập.

**Exit:** Pre/post totals được kế toán ký xác nhận; audit trail đầy đủ; không lộ PII.

### Wave 3 — Reliability và Observability (1-2 sprint)

- Period lock, audit event, anomaly ledger, run/error table.
- Chuẩn hoá throw/retry/error boundary và trạng thái lỗi UI.
- Cron/worker dedup, lock, retry/backoff, watchdog và cảnh báo.
- Migration/type/view drift gate trong CI.

**Exit:** Có thể phát hiện, truy nguyên và phục hồi các failure mode Tier A.

### Wave 4 — UX, Automation và Performance (2-4 sprint theo ROI)

- Giảm thao tác thủ công ở quy trình tần suất cao.
- Mobile-first cho tác vụ hiện trường.
- Server-side aggregate/pagination, sửa N+1/over-fetch và cache key.
- Tự động hoá billing/reminder/chốt định kỳ sau khi correctness ổn định.
- Đo lại baseline trước-sau; không chấp nhận tối ưu không có số đo.

**Exit:** Đạt target đã duyệt mà không làm sai invariant/quyền.

### Wave 5 — Strategic refactor và dọn nợ nền

- Loại model legacy/dead code sau khi chứng minh không còn consumer.
- Giảm `as any`, chuẩn hoá generated types và source of truth.
- Hợp nhất logic TS/SQL, component/dialog trùng và design token nếu có giá trị.

**Exit:** Bề mặt bảo trì giảm, compatibility/rollback rõ và không trộn với data repair.

## 12. Mẫu action card bắt buộc

Mỗi action trong backlog phải có:

```markdown
### ACT-xxx — Tên hành động
- Liên kết finding: F-xxx
- Lớp: Containment | Correctness | Reconciliation | Hardening | UX/Perf | Refactor
- Owner role:
- Dependency:
- Thay đổi tối thiểu:
- Phương án bị bác bỏ và lý do:
- Dữ liệu lịch sử bị ảnh hưởng:
- Effort / migration risk:
- Rollout:
- Rollback/compensation:
- Test bắt buộc:
- Acceptance criteria có thể đo:
- Observability sau deploy:
```

Không action nào được vào triển khai nếu thiếu rollback và acceptance criteria. Data reconciliation không được gộp chung migration sửa code.

## 13. Lịch thực hiện đề xuất

| Ngày | Trọng tâm | Đầu ra |
|---|---|---|
| 1 | G0-G1: hồ sơ, Git/deploy/access, baseline code/test/build | Header hiện trường + baseline |
| 2-3 | Dossier độc lập, metadata DB, risk register | Dossier 8 vai trò + query/test queue |
| 4-6 | E2E Tier A: lead/cọc/HĐ/chỉ số/HĐ/payment/ledger | Flow maps + evidence ledger |
| 7-8 | Sổ/bàn giao/đối soát/lương/LN và invariant tiền | SQL results + ví dụ số |
| 9 | RLS/RPC/view/Storage/worker/cron | Ma trận quyền + reliability findings |
| 10 | UI/mobile/cache/silent failure/performance | UX/perf baseline + findings |
| 11-12 | Runtime/test phân xử, concurrency và scale | Reproducer + verdict |
| 13 | Tranh luận đối kháng và xếp hạng | Finding table + rejected/open |
| 14 | Thiết kế action/rollback/acceptance | Backlog theo wave |
| 15 | Review cuối và xuất báo cáo | Báo cáo + decision log |

Có thể rút còn 10 ngày bằng cách chạy các dossier độc lập song song, nhưng không được rút ngắn bước kiểm chứng P0/P1 hoặc bỏ đối chiếu live DB.

## 14. Bộ đầu ra

| Đầu ra | Đường dẫn đề xuất |
|---|---|
| Báo cáo hội đồng chính | `docs/hoi-dong-phan-tich-YYYY-MM-DD.md` |
| Evidence ledger đã ẩn danh | `docs/audit/evidence-YYYY-MM-DD.md` |
| SQL read-only dùng để tái kiểm tra | `docs/audit/sql/YYYY-MM-DD/` |
| Test matrix | `docs/audit/test-matrix-YYYY-MM-DD.md` |
| Backlog hành động | `docs/audit/action-backlog-YYYY-MM-DD.md` |
| Decision log/phê duyệt | `docs/audit/decision-log-YYYY-MM-DD.md` |

Nếu không muốn tăng số file, có thể gộp tất cả vào báo cáo chính; tuy nhiên SQL dài nên giữ riêng và trích evidence digest trong báo cáo.

## 15. Tiêu chuẩn hoàn tất phiên đánh giá

- [ ] Hồ sơ Git/deploy/live DB/runtime được snapshot cùng timestamp.
- [ ] Tài liệu cũ chỉ được dùng làm giả thuyết và các finding quan trọng đã tái kiểm chứng.
- [ ] Sáu luồng Tier A có flow map và transaction/source-of-truth boundary.
- [ ] Mọi P0/P1 có reproducer/query, hai vai trò xác minh và confidence MEDIUM/HIGH.
- [ ] Kết luận tiền có invariant và ví dụ số; kết luận quyền có policy/grant/body/scope evidence.
- [ ] Đã kiểm tra drift giữa working tree, HEAD/deploy, live DB, migration và types.
- [ ] Có rejected hypotheses, minority opinion và `OPEN/UNKNOWN`.
- [ ] Backlog tách containment, fix, reconciliation, hardening, UX/performance và refactor.
- [ ] Mỗi action có owner, dependency, effort, risk, rollout, rollback và acceptance criteria.
- [ ] Không có mutation production, secret hoặc PII trong output.
- [ ] Không tuyên bố runtime hoạt động nếu chưa kiểm chứng bằng browser/test phù hợp.

## 16. Bước khởi động ngay sau khi duyệt kế hoạch

1. Xác nhận cấu hình ở Mục 2 và người có quyền quyết định nghiệp vụ/kế toán.
2. Mở phiên audit mới ở `MODE = PROPOSE`; thực hiện Giai đoạn 0 trước mọi phân tích sâu.
3. Tái kiểm chứng các P0/P1 từ hai báo cáo tháng 7 như hypothesis ưu tiên, đồng thời vẫn khảo sát độc lập để tránh confirmation bias.
4. Sau G2, gửi risk register và danh sách SQL read-only dự kiến để rà mức tải/PII.
5. Chỉ công bố finding sau G4; chỉ bắt đầu sửa khi action tương ứng được phê duyệt rõ ràng.

---

**Nguyên tắc điều hành cuối:** tối ưu theo thứ tự **chặn hậu quả → phục hồi đúng → đo và reconcile dữ liệu → làm cho không thể tái diễn → giảm thao tác/tăng tốc → refactor**. Không lấy UI đẹp, benchmark nhanh hoặc refactor lớn để che một hệ thống chưa bảo toàn đúng tiền, quyền và trạng thái.
