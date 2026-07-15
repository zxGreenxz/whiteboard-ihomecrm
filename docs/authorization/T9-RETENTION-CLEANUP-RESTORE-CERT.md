# T9 — Retention, cleanup và final restore certification

> Trạng thái: `IN_DESIGN`
> Production apply/cleanup/flip: `BLOCKED`.
> T9 là tranche **cuối cùng** của chương trình. Không được apply bất kỳ DROP/REVOKE/purge/retention job nào lên production khi chưa thỏa **tất cả** điều kiện ở mục 1 và mục 6. Đây là planning document để owner review — phê duyệt tài liệu **không** phải phê duyệt apply.

---

## 0. Nguyên tắc chi phối T9 (đọc trước)

T9 dễ bị hiểu nhầm là "dọn dẹp cho gọn". Trong hệ CRM tài chính đang chạy production, "cleanup" ở đây **chỉ** là gỡ **schema/policy/function/flag/JSON-snapshot đã chết** sau retention, cộng với **certification restore cuối cùng**. T9 **không** xóa dữ liệu nghiệp vụ, **không** hard-delete lịch sử tiền, **không** rút gọn audit.

Bốn ràng buộc bất biến, dẫn thẳng từ mục 27 và tracker runtime:

1. **Payment/posting/ledger không bao giờ bị hard-delete** (mục 27.2 điểm 3). Mọi hoàn tác đã và vẫn phải là operation/bút toán đối ứng liên kết bản gốc ("Hủy giao dịch thu tiền (tạo bút toán hoàn tác)"), giữ cả hai để truy vết. T9 không được "dọn" các row đối ứng hay bản gốc.
2. **Legacy/history phải được giữ** (tracker: "Không có cleanup approval; phải giữ legacy/history"). T9 chỉ gỡ *đường ghi* (writer path), *policy rộng*, *cột state chết*, *fallback JSON* — sau khi chứng minh zero legacy traffic — chứ không gỡ *dữ liệu lịch sử*.
3. **Suspend ≠ delete identity** (mục 27.2 điểm 8; kế hoạch mục 12): "Xóa nhân viên" là revoke membership giữ identity/audit; hard-delete `auth.users` là platform break-glass, chỉ khi không còn legal/audit dependency và qua data-retention review. T9 không được biến retention job thành cửa xóa principal.
4. **Recovery phải `VERIFIED` trước, restore certification chốt sau.** Recovery hiện là `ONLINE_UNFROZEN / PARTIAL / BLOCKED` (ID `20260715T152622Z-online-unfrozen`). T9 vừa **phụ thuộc** một recovery đã VERIFIED để được phép drop, vừa **sản xuất** recovery/certification cuối cùng sau khi mọi thứ đã cutover.

---

## 1. Scope và dependency

- **Deliverable/tranche ID:** T9 — Retention, cleanup, legacy removal, final restore certification (types/docs/training).
- **Domain:** Toàn hệ (retention/cleanup xuyên domain: invoice, payment/credit, thu-chi, cashbook, meter/invoice, deposit/contract, salary/profit, Storage/R2, function ACL) + recovery/restore program.
- **Normative plan section:** `docs/AUTHORIZATION-PLAN.md` mục 27.3 (dòng T9 trong chuỗi tranche), 27.4 (cutover theo domain, bước 6/8), 27.5 (tracker: "T9 Retention, cleanup, legacy removal, types/docs/training — Chưa"), 27.6 (cửa GO tối thiểu); cùng §14.3 điểm 7 (Storage "sau retention window mới xóa path cũ"), §16.7 hàng "Drop legacy columns/policies — Chỉ sau retention", §17 Sprint 7 điểm 5 ("Sau retention mới drop fallback, legacy policies/RPC/JSON snapshots"). Tracker runtime: `docs/AUTHORIZATION-IMPLEMENTATION-STATUS.md` hàng T9 = `NOT_STARTED`, "Sau ít nhất 90 ngày + business cycle, zero legacy traffic, recovery set mới/restore, independent audit và owner approval theo tranche."
- **Dependencies và trạng thái (tất cả phải `VERIFIED`, hiện chưa):**
  - T0a Recovery certification — `BLOCKED` (`ONLINE_UNFROZEN/PARTIAL`). Là điều kiện được phép DROP.
  - T0b Deployment control — `PREPARED`. Cần environment `supabase-production` với required reviewer + exact commit/path/hash gate.
  - T1a Contain approval RPC — `BLOCKED`.
  - T1b Harden `record_invoice_payment_v3` — `BLOCKED` (còn là active payment path).
  - T2 RBAC source-of-truth + lifecycle/version — `BLOCKED`.
  - T3 Approval contract v2 (reversal engine cho hoàn tác) — `BLOCKED`.
  - T4a JWT/concurrency/reconciliation/observability harness — `IN_DESIGN`.
  - T5 Canonical writers theo domain — `BLOCKED` (phần lớn hook vẫn ghi trực tiếp).
  - T6a/T6b RLS v2 + cutover đọc/ghi theo domain — `BLOCKED`.
  - T7 B-money canary/flip/**drain/revoke** theo domain — `BLOCKED`. **Đây là tiền đề trực tiếp:** T9 chỉ gỡ được cái đã drain+revoke ở T7.
  - T8 Storage/R2/Edge/service ACL burn-down — `BLOCKED`.
- **In scope:**
  - Retention-clock governance: định nghĩa và chứng minh cửa "≥ 90 ngày + ≥ 1 full business cycle (đóng kỳ tháng/quý) zero legacy traffic" per artifact trước khi gỡ.
  - Legacy removal có kiểm soát, chỉ khi zero-traffic đã chứng minh: (a) drop **cột state chết** đã thay bằng contract mới; (b) drop **legacy RLS policy rộng** đã bị RLS v2 thay; (c) revoke/drop **legacy writer functions** đã bị canonical RPC thay; (d) gỡ **JSON permission fallback/shadow** sau khi RBAC v2 không còn mismatch; (e) gỡ **feature flag** đã 100% cutover; (f) gỡ **orphan Storage policy** (vd `room-sale-images` "Public view room sale images" — SELECT public) sau khi T8 xác nhận không tái tạo bucket rộng.
  - Retention **job** (soft-unlink → xóa vật lý) cho Storage/R2 orphan/old path theo §14.3, có exact delete permission và audit; **không** áp cho ledger/payment/audit.
  - Final restore certification: nâng recovery từ PARTIAL/BLOCKED lên `VERIFIED` bằng portable Auth/Storage-aware PostgreSQL dump, exhaustive R2 enumerate, independent blank restore rehearsal → sinh recovery ID mới certified phản ánh schema **sau** cleanup.
  - Regenerate Supabase types sau mọi migration đụng schema; đồng bộ docs; training owner/admin.
  - Independent audit sign-off cuối, không P0/P1 mở (Sprint 7 gate + mục 20).
- **Out of scope (cấm trong T9):**
  - Xóa/truncate/rewrite bất kỳ row nghiệp vụ, payment, bút toán đối ứng, invoice, deposit, salary/profit, audit event.
  - Hard-delete `auth.users`/membership/identity (đó là platform break-glass riêng, không phải retention job).
  - Bất kỳ behavior flip/canary mới — cutover đã hoàn tất ở T5/T6/T7; T9 không mở đường ghi mới.
  - "Drop cho gọn" khi chưa có zero-traffic proof + retention clock + recovery VERIFIED.
- **Business behavior trước thay đổi:** Sau khi T1–T8 đã `VERIFIED`, canonical RPC là đường ghi duy nhất; legacy writer đã drain/revoke ở T7 nhưng **schema/policy/function/flag/JSON-snapshot cũ vẫn tồn tại inert** trong catalog; recovery vẫn PARTIAL; types/docs có thể còn tham chiếu cấu trúc cũ.
- **Business behavior sau thay đổi:** Catalog chỉ còn canonical structure; không còn legacy writer/policy rộng/flag/JSON fallback callable; orphan Storage policy đã gỡ; retention job dọn object path cũ đã soft-unlink quá hạn; recovery set mới đã **certified/VERIFIED** với blank restore; types/docs/training cập nhật; audit độc lập sign-off. Người dùng cuối **không** thấy thay đổi hành vi — mọi flow nghiệp vụ vẫn như sau T7, chỉ sạch nợ kỹ thuật và có recovery certified.
- **Ảnh hưởng nghiệp vụ/người dùng:** Kỳ vọng **zero** thay đổi hành vi nghiệp vụ. Rủi ro chính là *gỡ nhầm* một cấu trúc vẫn còn caller ẩn → mất chức năng hoặc mất khả năng đọc lịch sử. Vì vậy mỗi lần gỡ là additive-reversible ở mức "restore từ catalog snapshot/migration backup" (§16.7 hàng cuối), không phải xóa dữ liệu.

---

## 2. Immutable release identity

Một bảng cho **mỗi cleanup batch** (không gộp mọi thứ vào một apply). Không dùng branch name, "latest", glob migration hay broad `db push` làm identity. Điền khi owner ra lệnh cho đúng batch.

- Full commit SHA: `<chưa có>`
- Exact migration path/signature: `<supabase/migrations/<timestamp>_t9_<batch>_...>` — **một** file cho **một** batch domain; DROP/REVOKE liệt kê exact signature/policy name lấy từ live catalog, không tên trần.
- Migration SHA-256: `<chưa có>`
- Generated-types SHA-256: `<chưa có — regen sau mỗi migration đụng schema; giữ comment header đầu types.ts>`
- Deployed frontend SHA: `<chưa có>`
- Recovery certification ID (`VERIFIED`): `<chưa có — recovery hiện 20260715T152622Z-online-unfrozen là PARTIAL/BLOCKED, KHÔNG hợp lệ để mở DROP gate>`
- Maintenance-window ID: `<chưa có>`
- Operator: `<chưa có>`
- Reviewer: `<chưa có>`
- Owner approval reference: `<chưa có — cần lệnh owner riêng cho đúng batch>`

> Lưu ý: final restore certification (mục 5/8) sẽ **sinh recovery ID mới**. Recovery ID dùng để *mở* DROP gate (chụp trước cleanup) khác recovery ID *chốt cuối* (chụp sau khi catalog đã sạch). Cả hai phải VERIFIED với blank restore.

---

## 3. Live precheck (chạy read-only ngay trước mỗi batch)

- UTC/local start time: `<ghi lúc chạy>`
- **Zero-legacy-traffic proof (điều kiện tiên quyết của T9):** cho mỗi artifact chuẩn bị gỡ, xuất từ PostgREST/DB logs + `pg_stat_user_functions`/audit rằng **không** có call/insert/update qua đường legacy trong **≥ 90 ngày liên tục** và **≥ 1 kỳ đóng sổ đầy đủ**. Không được suy ra zero-traffic chỉ bằng grep source.
- Exact live signatures/owners/search paths/grants: refresh từ live catalog cho mọi function/policy/column trong batch. DROP/REVOKE dùng exact identity, kể cả mọi overload (mục 27 checklist "overload nào bị bỏ sót khi revoke/grant theo signature").
- Active callers/writers: chứng minh **0** production writer còn dùng legacy path. Ví dụ đối tượng cần chứng minh 0-caller trước khi gỡ:
  - Legacy payment writer song song `record_invoice_payment_v3`: `record_invoice_payment_v2`, `record_invoice_payment_atomic` (migrations `20260528000002`, và cụm v3 `20260713160000/161000/162000`). V3 vẫn là active path (T1b `BLOCKED`) → **chưa** đủ điều kiện gỡ v2/atomic cho tới khi v3 VERIFIED và v2/atomic zero-traffic.
  - Frontend hook đã dead-path hoá ở T5: `useCreatePayment`, `useRecordPayment` (legacy `useInvoices` ~dòng 1272) và các call site `src/hooks/usePayments.ts`, `useInvoicePayments.ts`, `RecordPaymentDialog.tsx`, `CollectPaymentDialog.tsx` — xác nhận không còn import/gọi legacy trước khi gỡ.
  - Orphan Storage policy `room-sale-images` từ `20260607090200_room_sale_images_bucket.sql` (đặc biệt `Public view room sale images` = SELECT public) — xác nhận T8 đã quyết mô hình private/R2 và bucket không được tái tạo với policy rộng.
- Migration-ledger state: ledger sạch, không migration pending/drift; mỗi batch một entry.
- Pre-state table/object/count/hash: chụp count + hash các bảng ledger/payment/audit/history **sẽ được giữ nguyên** (để chứng minh cleanup không đụng chúng), và catalog hash của function/policy/column **sẽ gỡ**.
- Financial reconciliation baseline: SUM theo org/building/account/status cho INCOME/EXPENSE, invoice/payment/credit/deposit, salary/profit, cashbook, meter/invoice, operation đối ứng. Dùng `node scripts/reconcile-money.mjs` (chống cap-1000).
- Browser/runtime baseline: production smoke các flow đã cutover không console/network error.
- Monitoring healthy: dashboard/alert/deny-rate/RPC-error/idempotency-conflict telemetry online (T4a).
- Managed backup reference: Supabase managed physical backup gần nhất `COMPLETED` + recovery certification ID VERIFIED của batch mở.

---

## 4. Change contract (retention/cleanup/restore)

Vì T9 không mở đường ghi tiền mới, "contract" ở đây là **contract của cleanup operation**, không phải của money RPC.

- **Server-derived organization/actor/resources:** mọi retention job (Storage soft-unlink → delete) resolve org/resource server-side; exact delete permission (không authenticated-wide). Không client chọn key để xóa.
- **Exact permission và resource scope:** DROP/REVOKE/retention chạy dưới owner/migration identity trong maintenance window có protected environment reviewer; retention delete job có exact `storage.*delete` permission, audit actor/org/resource/hash/size (§14.4 điểm 6).
- **State/version/CAS rules:** không áp cho DROP schema (DDL). Với retention delete object: soft-unlink trước, chỉ xóa vật lý khi record retention đã quá hạn và trạng thái = `UNLINKED` (CAS trên trạng thái + `unlinked_at`), tránh xóa object còn được DB reference.
- **Lock order:** batch cleanup theo domain, không một `REVOKE DML` khổng lồ (mục 27.4); trong một batch, DROP theo thứ tự dependency (policy → function → column) để không rớt `security_invoker` hay tạo view hở.
- **Idempotency scope, canonical payload hash và conflict behavior:** migration DDL idempotent (`DROP ... IF EXISTS` theo exact signature); retention delete job idempotent theo `(object_key, retention_batch_id)` — chạy lại không double-delete và không xóa object đã bị re-link hợp lệ.
- **Atomic effects:** mỗi batch commit/rollback nguyên khối; retention delete ghi kết quả **durable từng object** (partial success, không xóa lại object đã xóa) — cùng triết lý per-line durable của bulk payment (mục 27.2 điểm 7).
- **Audit/provenance:** mọi DROP/REVOKE/retention-delete ghi append-only audit: ai, khi nào, exact signature/policy/key, lý do, batch ID, recovery ID mở gate. Audit event **không** được là đối tượng bị cleanup.
- **External outbox/side effects:** retention delete Storage/R2 là side effect ngoài DB → phải có outbox/reconcile: DB đánh dấu deleted chỉ khi object store xác nhận xóa; mismatch → abort.
- **Forward-fix/reversal behavior:** nếu gỡ nhầm một cấu trúc còn caller ẩn → **không** khôi phục bằng cách mở lại đường ghi cũ tùy tiện; freeze, forward-fix caller sang canonical, hoặc restore đúng cấu trúc từ catalog snapshot/migration backup đã VERIFIED (§16.7). Object đã xóa vật lý chỉ khôi phục từ recovery set certified.
- **Feature flag default:** không áp dụng (T9 gỡ flag, không thêm). Nếu cần cổng cho retention job, mặc định `OFF`.

---

## 5. Test evidence trước production

- **Project restore/staging ID:** `<chưa có>` — bắt buộc chạy toàn bộ cleanup trên **restore project độc lập** trước, không thử trực tiếp production.
- **Unit/property tests:** retention-clock predicate (đủ 90 ngày + kỳ đóng, zero-traffic) property-based; retention-delete idempotency/CAS; anti "xóa object còn reference".
- **Direct JWT REST/RPC matrix:** sau khi gỡ legacy function/policy, direct call tới signature đã DROP → deny/không tồn tại; canonical path vẫn allow đúng permission; **không** phát sinh anon/public grant ngoài allowlist.
- **Cross-org/foreign-resource tests:** trên hai organization thật, JWT thật, non-null org — xác nhận việc gỡ legacy policy **không** làm lộ cross-org (không rơi về "no policy = default allow"); RLS v2 vẫn deny-default.
- **Concurrent/retry/rollback-injection tests:** retry retention-delete không double-delete; inject failure giữa DB-mark và object-store-delete → reconcile về trạng thái nhất quán, không orphan/không mất object còn reference.
- `npm run typecheck:baseline`: phải không tăng lỗi so `ts-baseline.txt`.
- `npx tsc --noEmit -p tsconfig.app.json`: chạy (root `tsc --noEmit` không tính).
- Related/full Vitest: `npx vitest run` các suite payment/reconciliation/authz liên quan.
- `npm run lint` / `npm run build`: xanh.
- `node scripts/check-definer-acl.mjs`: sau DROP/REVOKE function, ACL baseline không tăng exposure, burn-down đúng hướng.
- `node scripts/check-view-invoker.mjs` (nếu đụng VIEW): bắt buộc nếu batch chạm view — GOTCHA `CREATE OR REPLACE VIEW` rớt `security_invoker=true`.
- Generated Supabase type drift: sau mỗi migration đụng schema, `npm run gen:types > src/integrations/supabase/types.ts` + thêm lại comment header; xác nhận không drift.
- Full money reconciliation: `node scripts/reconcile-money.mjs [YYYY-MM]` — pre/post delta = 0 cho tất cả domain; chứng minh cleanup **không** đụng ledger/payment/đối ứng.
- Browser happy/edge/deny và console/network: production-equivalent smoke trên restore project cho mọi domain đã cutover.
- **Final restore certification evidence (đặc thù T9):**
  - Portable Auth/Storage-aware PostgreSQL dump đọc được `auth` + mọi table (khắc phục blocker temporary CLI role hiện tại).
  - Exhaustive R2 enumerate (không chỉ `REFERENCED_OBJECTS_ONLY`) với bucket-scoped list/read credential.
  - Independent **blank-target restore rehearsal**: restore vào target trắng, verify schema/ACL/security/money/object/browser; sinh recovery ID mới certified phản ánh catalog **sau** cleanup.
  - Manifest counts/hash, 3 fault-domain replica thực (không cùng một physical disk như hiện tại), secret-scan finding đã rotation-review.
- **Reviewer verdict:** `<chưa có>` + independent audit sign-off (Sprint 7 gate / mục 20), không P0/P1 mở.

---

## 6. Canary và production gate

T9 **không** có canary hành vi nghiệp vụ (không mở đường ghi mới). "Canary" ở đây là gỡ **từng batch nhỏ nhất, theo domain**, quan sát, rồi mới batch tiếp.

- Canary organization/users: N/A cho behavior; nếu retention delete Storage chạy theo lô, bắt đầu với lô nhỏ nhất một org.
- **Transaction count cap: `0`** (default — không flip/không delete cho tới khi owner chốt count cụ thể per batch).
- **VND cap: `0`** (default — T9 không được tạo/đụng bút toán tiền; nếu bất kỳ thao tác nào chạm số tiền, cap 0 nghĩa là dừng).
- Observation interval: tối thiểu một ngày làm việc mỗi batch trước khi sang batch kế; retention delete quan sát reconcile object-store↔DB.
- Expansion approval: owner duyệt riêng từng batch mở rộng.
- Old writer drain proof: đã có từ T7; T9 chỉ gỡ khi drain proof + 90 ngày zero-traffic còn hiệu lực.
- Exact revoke/policy/signature: lấy từ live catalog tại thời điểm apply, không danh sách tay cũ.

**Default nếu owner chưa chốt:** canary count = `0`, VND cap = `0`, mọi flag = `OFF`, **không apply/không DROP/không delete**. Production apply BLOCKED cho tới khi đồng thời: (1) recovery `VERIFIED` với blank restore; (2) T1a–T8 tất cả `VERIFIED`; (3) owner cấp **exact commit SHA + migration SHA-256 + maintenance window + canary count + VND cap** cho **đúng batch**. Mặc định 0 = không flip.

---

## 7. Mandatory abort

Abort ngay batch khi có một trong các điều kiện:

- unauthorized hoặc cross-org success (đặc biệt: gỡ legacy policy khiến một row cross-org đọc/ghi được);
- financial drift khác 0 ở bất kỳ domain nào;
- duplicate payment/posting/reversal, hoặc phát hiện cleanup đã chạm một row ledger/payment/đối ứng/audit;
- orphan/split operation (DB mark deleted nhưng object store còn, hoặc ngược lại);
- unexpected legacy writer/caller còn sống trên cấu trúc định gỡ (zero-traffic proof sai);
- backup/object hash mismatch, hoặc retention delete xóa nhầm object còn được DB reference;
- canary/smoke happy path bị deny không giải thích sau khi gỡ policy/function;
- 3 RPC/retention-job failure liên tiếp hoặc >1% trong 5 phút;
- p95 >2× baseline trong 10 phút;
- mất monitoring/backup/audit telemetry;
- **recovery certification hết hiệu lực** hoặc phát hiện restore rehearsal không reproduce được catalog.

Khi abort: freeze batch, giữ evidence, **không** xóa/sửa row tiền để rollback; **không** hard-delete để "làm lại". Restore cấu trúc từ catalog snapshot/migration backup VERIFIED nếu đã lỡ DROP; forward-fix caller sang canonical; tạo compensating reversal chỉ khi nghiệp vụ yêu cầu, không phải để undo cleanup.

---

## 8. Post-apply evidence (mỗi batch + certification cuối)

- Apply start/end UTC: `<ghi>`
- Catalog/signature/grant pre/post diff: exact function/policy/column đã gỡ; xác nhận **không** đụng ledger/payment/audit signature.
- Direct API deny/allow result: signature đã DROP → không callable; canonical path allow đúng; không anon/public grant mới.
- Browser result: smoke mọi domain đã cutover, không regression/console error.
- Reconciliation delta: 0 cho toàn bộ domain tiền; object-store↔DB reconcile khớp cho retention delete.
- Runtime error/latency/deny metrics: trong ngưỡng abort.
- Hidden caller/legacy writer result: telemetry xác nhận 0 legacy caller sau gỡ.
- Observation completed at: `<≥ 1 ngày làm việc/batch>`
- **Final restore certification block (chỉ ở certification cuối):** recovery ID mới; capture cutoff UTC; managed backup reference; aggregate counts/manifest hash; trạng thái ≥3 fault-domain replica; kết quả blank restore; schema/ACL/security/money/object/browser verdict; secret-scan/rotation status; reviewer + timestamp; đường dẫn evidence **sanitized** trong repo.
- Final reviewer: `<chưa có>` + independent audit sign-off.
- Final state (`APPLIED` hoặc `VERIFIED`): T9 chỉ `VERIFIED` khi mọi batch cleanup VERIFIED **và** recovery mới certified với blank restore **và** không P0/P1 mở.
- Tracker update commit: cập nhật `AUTHORIZATION-IMPLEMENTATION-STATUS.md` hàng T9 và `EVIDENCE-INDEX.md`.

Evidence không được chứa credential, JWT, signed URL, private object path hoặc PII.

---

## 9. Mở cho owner (không tự quyết trong T9)

Xem `open_questions`. Tóm tắt: định nghĩa chính xác "1 full business cycle"; danh mục artifact được phép gỡ vs phải giữ vĩnh viễn; chính sách retention cho Storage/R2 orphan (thời hạn cụ thể); có mở lại blank-target cloud restore rehearsal hay giữ local-only; ngưỡng "no P0/P1" cho independent audit; và exact per-batch release identity.
