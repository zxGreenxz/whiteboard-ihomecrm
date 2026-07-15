# Authorization tranche `T4a` — `JWT / concurrency / reconciliation / observability harness`

> Trạng thái: `IN_DESIGN`
> Production mutation: **không được phép**. T4a mặc định **không** ghi production DB (chỉ script + test + CI đọc). Nếu tranche thêm bất kỳ DB object nào (monitoring view/RPC read-only) thì object đó bị chặn cho tới khi đủ mọi trường release-identity bên dưới, recovery `VERIFIED`, và có lệnh owner riêng.
> Recovery hiện tại: `20260715T152622Z-online-unfrozen` = `ONLINE_UNFROZEN / PARTIAL / BLOCKED`. Production gate chương trình: **NO-GO**.

## 1. Scope và dependency

- **Deliverable/tranche ID:** T4a — authorization/API/concurrency/reconciliation harness + observability/runbook/CI. (AUTHORIZATION-IMPLEMENTATION-STATUS.md hàng T4a: `IN_DESIGN`; AUTHORIZATION-PLAN.md §27.5 tracker hàng T4 và §27.3 bước `-> T4`.)
- **Domain:** Test/verification tooling và observability cho toàn bộ chương trình authorization — không phải một domain tiền cụ thể. Là **gate cung cấp bằng chứng** mà T1a, T1b, T2, T3, T5, T6, T7+ đều phụ thuộc.
- **Normative plan section:** AUTHORIZATION-PLAN.md §27.3 (thứ tự T1a→T1b→T2→T3→**T4**→T5…), §27.4 (per-domain cutover gate, các bước 2/4/7 đòi direct API test + reconciliation), §27.6 (cửa GO tối thiểu: “Cross-tenant REST/RPC/Storage/Edge tests pass trên hai organization thật, non-null org và JWT thật”; “Reconciliation pre/post khớp cho INCOME/EXPENSE, invoice/payment/credit/deposit, salary/profit, cashbook, meter/invoice và operation đối ứng”; “Dashboard, alert, abort criteria, freeze/forward-fix/incident runbook … sẵn sàng”).
- **Dependencies và trạng thái:**
  - T0a recovery `BLOCKED` — **không** chặn việc *viết* harness (harness đọc/không ghi production), nhưng chặn mọi thứ T4a *chứng minh* để mở production gate. Có thể bắt đầu song song sau T0 (theo tracker: “Bắt đầu song song sau T0”).
  - Một staging/restore project (§5 template “Project restore/staging ID”) là **prerequisite bắt buộc** để chạy concurrency/rollback-injection và direct REST/RPC deny mà không đụng dữ liệu tiền thật. Hiện chưa có blank-target restore trong phạm vi (recovery gate BLOCKED).
  - T4a không phụ thuộc T2/T3 để tồn tại, nhưng ma trận acceptance của T4a phải bao trùm contract của T1b (`thu_tien.collect`, idempotency atomic, bulk per-invoice) và T3 (approval state/CAS/reversal) để những tranche đó có bằng chứng khi tới lượt.
- **In scope:**
  1. **Fixture hai tổ chức thật** (non-null `organization_id`) + tiện ích mint **JWT authenticated thật** để gọi qua PostgREST/RPC HTTP (không chỉ `SET LOCAL ROLE` + `set_config('request.jwt.claims', …)` như hiện tại).
  2. **Direct REST/RPC negative+positive matrix**: allow-in-scope / deny-cross-org / deny-missing-permission cho các RPC an ninh trọng yếu đã tồn tại: `record_invoice_payment_v3`, `submit_financial_voucher`, `decide_financial_voucher`, `generate_invoices_for_building_v2`, `get_income_expense_history`, `get_income_expense_layer_stats`, `can_access_building`, `can_do_on_building`.
  3. **Concurrency/retry/rollback-injection harness**: same idempotency key song song (một effect), bulk per-invoice atomic/partial-success, deposit 24h exclusive hold no-double-hold, reversal anti-double-reversal — dưới dạng test chạy trên staging.
  4. **Full-domain money reconciliation** mở rộng `scripts/reconcile-money.mjs` (hiện chỉ phủ **một** chỉ tiêu: Tổng THU `income_expenses type='INCOME' AND approval_status='APPROVED' AND deleted_at IS NULL`) ra: EXPENSE; invoice/payment/credit/excess; deposit; salary/profit; cashbook balance (hiện chỉ là info-line qua `accounts_with_balance`); meter→invoice; và operation đối ứng (reversal).
  5. **Writer map** machine-readable: mọi frontend hook + SQL/RPC ghi tiền theo domain, gắn commit SHA (nền cho “drain writer cũ” §27.4 bước 6).
  6. **Observability/runbook/CI**: alert thresholds, freeze/forward-fix/incident runbook, và wiring CI để `check-definer-acl`, `check-view-invoker`, `reconcile-money`, `test-cross-tenant` chạy như gate (hôm nay **không** workflow nào gọi chúng — chỉ có `supabase-migrate.yml`).
- **Out of scope:** không sửa RLS/policy, không revoke DML, không wire approval prototype, không flip feature flag, không mutate dữ liệu tiền production. Không tạo `.sql` dưới `supabase/migrations/`. Bất kỳ monitoring view/RPC read-only nào (nếu owner muốn) tách sang sub-tranche riêng với migration + hash + gate.
- **Business behavior trước thay đổi:** xem §2.

## 2. Business behavior trước và sau

| Chủ đề | Trước T4a (hiện trạng đã đọc từ repo) | Sau T4a |
|---|---|---|
| Cross-tenant isolation test | `scripts/test-cross-tenant.mjs`: dựng 2 tenant tổng hợp (X/Y) trong `BEGIN…ROLLBACK`, giả dạng principal bằng `SET LOCAL ROLE authenticated` + `set_config('request.jwt.claims', json_build_object('sub',…,'role','authenticated'), true)`. Phủ 3 principal (OWNER X, ADMIN role `Admin`, FULL-SCOPE staff `building_id`/`area_id` NULL). Khẳng định 0 dòng Y trên `buildings/rooms/contracts/income_expenses`, `get_income_expense_history(Y)`=0, `generate_invoices_for_building_v2(Y)` bị “Access denied”, `can_access_building(Y)`/`can_do_on_building('invoices','create',Y)`=false. **Chạy qua Management API `/database/query` dưới PAT — KHÔNG qua PostgREST HTTP với JWT thật.** | Bổ sung đường **JWT thật qua PostgREST/RPC HTTP** trên hai organization có `organization_id` non-null, mở rộng subject sang payment/approval/storage RPC; giữ nguyên đường `ROLLBACK` cũ làm lớp nhanh. |
| Money reconciliation | `scripts/reconcile-money.mjs`: 3 nguồn độc lập (A=SQL SUM qua Management API; B=RPC `get_income_expense_layer_stats` invoker qua JWT+RLS = `cash_income+internal_income+pending_income`; C=phân trang FE replicate `src/lib/supabaseFetchAll.ts`, `.range(from,from+999)` order `voucher_date desc, id asc`). Chốt bug cap-1000 PostgREST. **Chỉ một chỉ tiêu (Tổng THU đã duyệt).** Có DATASET GUARD exit 3 nếu kỳ ≤1000 dòng; cashbook balance chỉ info-line (`accounts_with_balance`, không tính PASS/FAIL). Hai script Excel-vs-cashbook chuyên biệt: `doi-chieu-thu-tien.mjs` (sổ TKHIEP), `doi-chieu-nabubu-hienthu.mjs` (sổ Hiển Thu). | Reconciliation A/B/C mở rộng cho toàn bộ domain tiền ở §27.6, mỗi domain có ≥2 nguồn độc lập + phán quyết delta=0; cashbook balance nâng từ info-line thành gate. |
| ACL drift | `scripts/check-definer-acl.mjs`: baseline `definer-acl-baseline.json` 100 signature anon-executable SECURITY DEFINER (`generated: 2026-07-13`), exit 1 nếu có signature MỚI ngoài allowlist. | Giữ nguyên cơ chế; **thêm burn-down tracking** (baseline chỉ chống tăng, không chứng minh 100 signature an toàn — theo STATUS “Baseline khoảng 100 … chỉ chứng minh exposure không tăng”). |
| View invoker | `scripts/check-view-invoker.mjs`: quét mọi view `public` thiếu `security_invoker=true`, exit 1 nếu hở. | Giữ nguyên; wire thành CI gate bắt buộc sau migration đụng view. |
| Concurrency/idempotency/reversal/deposit-hold test | **Không tồn tại** (0 file test khớp `concurren|idempoten|reconcil|reversal|deposit hold` dưới `src/**/*.test.ts`). | Có harness chạy trên staging chứng minh atomic/one-effect/no-double theo contract T1b/T3. |
| CI enforcement | **Không** workflow nào chạy 4 script harness; chỉ `supabase-migrate.yml` (workflow_dispatch, apply migration theo hash). | 4 script + typecheck baseline + related Vitest chạy như CI gate; kết quả là artifact bằng chứng cho từng tranche. |
| Observability/runbook | Không có dashboard/alert/abort-threshold/runbook định danh trong repo. | Có: alert thresholds khớp abort §7, freeze/forward-fix/incident runbook, backup/PITR/maintenance reference. |

- **Ảnh hưởng nghiệp vụ/người dùng:** **không đổi hành vi runtime cho người dùng cuối**. T4a chỉ thêm khả năng *chứng minh* an toàn trước khi các tranche khác chạm production. Rủi ro chính là false-confidence: một harness phủ thiếu (ví dụ reconcile chỉ một chỉ tiêu, cross-tenant không đi JWT HTTP thật) có thể mở gate sai. Vì vậy T4a phải fail-closed và INCONCLUSIVE rõ ràng (đã có tiền lệ đúng trong `reconcile-money.mjs` exit 3).

## 3. Immutable release identity

T4a chủ yếu là **repo artifact** (scripts + tests + CI workflow + runbook docs); release identity là **full commit SHA**. Nếu owner cho phép một sub-tranche thêm DB object read-only (ví dụ monitoring view), object đó phải mang đầy đủ các trường dưới; mặc định **không có DB object** nào trong T4a.

- Full commit SHA: `<chưa chốt — owner cung cấp exact 40-hex; workflow supabase-migrate.yml yêu cầu ^[0-9a-f]{40}$>`
- Exact migration path/signature: `<không áp dụng — T4a mặc định không có migration. Nếu có monitoring object: supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql khớp regex workflow>`
- Migration SHA-256: `<không áp dụng / owner cung cấp lowercase 64-hex nếu có object>`
- Generated-types SHA-256: `<không áp dụng — không đổi schema → src/integrations/supabase/types.ts không drift; nếu thêm RPC/view phải regen>`
- Deployed frontend SHA: `<không áp dụng — không đổi frontend runtime>`
- Recovery certification ID (`VERIFIED`): `<chưa có — hiện 20260715T152622Z-online-unfrozen = PARTIAL/BLOCKED>`
- Maintenance-window ID: `<không cần cho harness read-only; bắt buộc nếu áp bất kỳ DB object>`
- Operator: `<owner cung cấp>`
- Reviewer: `<owner cung cấp>`
- Owner approval reference: `<chưa có — phê duyệt tài liệu KHÔNG phải phê duyệt áp production>`

Không dùng branch name, “latest”, glob migration hoặc broad `db push` làm release identity.

## 4. Live precheck (chạy read-only ngay trước khi prepare/commit harness)

- UTC/local start time: `<ghi tại thời điểm chạy>`
- Exact live signatures/owners/search paths/grants: refresh live catalog cho các RPC trong ma trận §5 (`record_invoice_payment_v3`, `submit_financial_voucher`, `decide_financial_voucher`, `generate_invoices_for_building_v2`, `get_income_expense_history`, `get_income_expense_layer_stats`, `can_access_building`, `can_do_on_building`) — signature/argtype/`prosecdef`/search_path/grant phải khớp giả định test, nếu lệch thì cập nhật test trước.
- Active callers/writers: sinh writer map từ code (đã xác nhận có payment hook: `useBulkRecordPayment.ts`, `useInvoicePayments.ts`, `usePayments.ts`, `useQuickCollect.ts`, `useInvoices.ts`, `useCollectionReport.ts`, `useManagerSalary.ts`) + catalog + PostgREST/DB logs; gắn commit SHA.
- Migration-ledger state: xác nhận không có migration T4a nào bị đặt nhầm vào `supabase/migrations/` (path auto-deploy).
- Pre-state table/object/count/hash: chụp count các bảng harness đọc trên staging (`income_expenses`, `invoices`, `payments`/tương đương, deposit, cashbook `accounts_with_balance`) để so trước/sau khi chạy concurrency (delta phải = 0 ngoài dữ liệu test tổng hợp trong ROLLBACK/staging).
- Financial reconciliation baseline: chạy `node scripts/reconcile-money.mjs` (kỳ auto) và ghi verdict A===B===C hoặc INCONCLUSIVE; đây là mốc “trước”.
- Browser/runtime baseline: smoke các flow thu tiền/duyệt phiếu hiện có để phân biệt regression do môi trường vs do harness.
- Monitoring healthy: xác nhận có thể quan sát RPC error rate/latency (nền cho abort §7).
- Managed backup reference: 7/7 Supabase physical backup `COMPLETED` (STATUS recovery gate) — chỉ là metadata phòng thủ, **không** thay restore rehearsal.

## 5. Change contract (harness = read-only + additive)

- **Server-derived organization/actor/resources:** harness KHÔNG derive quyền — nó *xác minh* rằng server derive đúng. Fixture cấp cho mỗi principal một identity thật (JWT `sub`, membership tổ chức non-null) và assert rằng RPC dùng org/actor **server-side**, không tin tham số client.
- **Exact permission và resource scope kiểm thử:**
  - `record_invoice_payment_v3`: allow chỉ khi có exact `thu_tien.collect` trong scope; deny nếu chỉ có `invoices.edit` (theo T1b contract), deny cross-org account/change/rounding/item/room/contract/owner.
  - `submit_financial_voucher(uuid,text,text,text)` / `decide_financial_voucher(uuid,text,text,bigint)`: sau khi T1a revoke, direct JWT client phải **deny (no EXECUTE)** và không side effect; harness là bằng chứng âm bản cho T1a.
  - `generate_invoices_for_building_v2(building,period,type)`: deny cross-tenant (đã có trong test-cross-tenant qua `/database/query`; T4a thêm đường JWT HTTP thật).
  - `get_income_expense_history`, `get_income_expense_layer_stats`, `can_access_building`, `can_do_on_building`: cross-org = 0 dòng / false.
- **State/version/CAS rules kiểm thử:** cho T3 khi tới lượt — approval state machine, `expected_version` CAS, snapshot immutable/revalidated, affected-row assertions. T4a chuẩn bị khung test; không wire engine.
- **Lock order:** harness quan sát/khẳng định lock order công bố của T1b (`lock invoice → related money rows`) không deadlock dưới đồng thời; không tự định nghĩa lock order production.
- **Idempotency scope, canonical payload hash và conflict behavior:** test khẳng định T1b contract — unique theo `org + operation + subject + caller + key` + canonical payload hash; same key+same payload → một effect + cùng response; same key+different payload → conflict xác định, không effect mới; retry sau commit/mất kết nối → original response.
- **Atomic effects:** rollback-injection ở từng bước phải rollback toàn operation (payment + invoice + voucher/items + credit/excess); bulk atomic theo từng invoice với partial success + kết quả từng dòng durable (retry không thu lại dòng đã thành công).
- **Audit/provenance:** test khẳng định audit append-only (actor/org/subject/key/payload hash/response/timestamps) và **không** chứa PII/secret trong exception/notice.
- **External outbox/side effects:** harness không phát side effect production; mọi mutation nằm trong `BEGIN…ROLLBACK` hoặc staging.
- **Forward-fix/reversal behavior:** test khẳng định hoàn tác = một operation đối ứng liên kết bản gốc (“Hủy giao dịch thu tiền (tạo bút toán hoàn tác)”), anti-double-reversal, giữ cả hai bản để truy vết — không hard-delete.
- **Feature flag default:** không áp dụng (không có flag runtime). CI gate mặc định **bật ở mức cảnh báo** cho tới khi owner chốt biến chúng thành blocking, để tránh chặn nhầm dev flow trước khi baseline ổn định.

## 6. Test evidence plan trước production

- **Project restore/staging ID:** `<bắt buộc — chưa có; concurrency/rollback-injection/idempotency phải chạy trên restore/staging, KHÔNG production>`
- **Unit/property tests:** thêm fast-check property cho canonical payload hash (bất biến thứ tự field/không đổi tiền) và cho phân trang recover đủ tổng (đã có tiền lệ ở nguồn C).
- **Direct JWT REST/RPC matrix:** allow-in-scope / deny-cross-org / deny-missing-permission cho 8 RPC ở §5, qua **PostgREST HTTP với JWT thật** (điểm mới so với `test-cross-tenant.mjs` hiện chạy qua Management API `/database/query`).
- **Cross-org/foreign-resource tests:** hai organization non-null org; giữ 3 principal hiện có (OWNER/ADMIN/FULL-SCOPE staff) và bổ sung principal có/không có `thu_tien.collect`.
- **Concurrent/retry/rollback-injection tests:** same key song song → một effect; bulk atomic/partial; deposit 24h hold không double-book (server-time `expires_at`); reversal không double.
- **`npm run typecheck:baseline`:** phải PASS (không tăng lỗi so `ts-baseline.txt`).
- **`npx tsc --noEmit -p tsconfig.app.json`:** ghi kết quả (root `tsc --noEmit` không check gì — theo CLAUDE.md).
- **Related/full Vitest:** `npx vitest run <path harness test>`; repo hiện có 63 file `*.test.ts` — thêm nhóm concurrency/idempotency/reconciliation (hiện 0).
- **`npm run lint` / `npm run build`:** ghi kết quả.
- **`node scripts/check-definer-acl.mjs`:** PASS (khớp baseline 100 signature) — hoặc `--update` có chủ ý nếu owner thêm public endpoint thật.
- **`node scripts/check-view-invoker.mjs` (nếu đụng VIEW):** chỉ khi sub-tranche thêm monitoring view; mặc định T4a không đụng view.
- **Generated Supabase type drift:** mặc định 0 (không đổi schema). Nếu thêm RPC/view: `npm run gen:types` + header comment, so hash.
- **Full money reconciliation (nếu đụng tiền):** T4a không đụng tiền; nhưng deliverable của T4a *là* mở rộng reconcile-money ra full domain — chạy và ghi verdict cho từng chỉ tiêu (INCOME/EXPENSE, invoice/payment/credit/deposit, salary/profit, cashbook, meter/invoice, reversal), mỗi cái delta=0 hoặc INCONCLUSIVE rõ ràng.
- **Browser happy/edge/deny và console/network:** smoke để phân biệt regression môi trường; không kỳ vọng thay đổi UI.
- **Reviewer verdict:** `<owner-designated reviewer; chưa có>`

## 7. Canary và production gate

- Canary organization/users: `<không áp dụng cho harness read-only; = 0 mặc định>`
- Transaction count cap: **`0`** (default — do not flip).
- VND cap: **`0` VND** (default — do not flip).
- Observation interval: `<owner cung cấp nếu sau này áp monitoring object>`
- Expansion approval: `<owner, per-tranche>`
- Old writer drain proof: N/A cho T4a (T4a *sinh ra* writer map để các tranche sau drain).
- Exact revoke/policy/signature: N/A (T4a không revoke gì).

Default nếu chưa được owner chốt: canary count = `0`, VND cap = `0`, flag = `OFF`, không apply/flip. **Production apply BLOCKED cho tới khi:** recovery `VERIFIED` **và** owner cung cấp exact commit SHA, migration SHA-256 (nếu có object), maintenance window, canary count/VND cap (default 0 = không flip). Với T4a thuần harness, “apply” = merge scripts/CI/runbook; kể cả merge cũng cần review vì kết quả của nó mở gate cho tranche tiền.

## 8. Mandatory abort

Abort/không-báo-xanh ngay khi có một trong các điều kiện:

- direct JWT test cho **unauthorized hoặc cross-org success** (bất kỳ dòng Y đọc được, `can_access_building(Y)`/`can_do_on_building(...,Y)`=true, hoặc `generate_invoices_for_building_v2(Y)` không bị chặn);
- **financial reconciliation drift ≠ 0** trên bất kỳ chỉ tiêu (A≠B, hoặc C<A cap-1000, hoặc C>A trùng dòng);
- **duplicate payment/posting/reversal** dưới concurrency (same key ra >1 effect; bulk retry thu lại dòng đã thành công; reversal đôi);
- **orphan/split operation** (rollback-injection để lại effect một phần);
- **unexpected legacy writer** xuất hiện trong writer map ngoài inventory;
- backup/object hash mismatch;
- canary happy path bị deny không giải thích (nếu có canary — mặc định 0);
- 3 RPC failure liên tiếp hoặc >1% trong 5 phút trên staging harness;
- p95 latency >2× baseline trong 10 phút;
- mất monitoring/backup/audit telemetry;
- **harness INCONCLUSIVE** (ví dụ `reconcile-money` exit 3 vì kỳ ≤1000 dòng, hoặc staging chưa sẵn): không được coi là PASS, không được dùng làm bằng chứng mở gate.

Khi abort: dừng chứng nhận tranche, freeze việc mở gate, giữ evidence; không xóa/sửa row tiền để “rollback”. Reconcile, forward-fix và tạo compensating reversal khi cần. Với harness, abort nghĩa là: không đánh dấu tranche phụ thuộc là có-bằng-chứng cho tới khi harness xanh thật.

## 9. Post-apply evidence

- Apply start/end UTC: `<ghi khi merge harness / nếu áp monitoring object>`
- Catalog/signature/grant pre/post diff: cho 8 RPC ở §5 (kỳ vọng không đổi — T4a không revoke/grant); `check-definer-acl` diff = 0 added.
- Direct API deny/allow result: bảng ma trận JWT thật (allow-in-scope / deny-cross-org / deny-missing-permission) — kết quả thực, sanitized (không JWT/credential).
- Browser result: smoke không regression/console error.
- Reconciliation delta: verdict per-domain (mỗi chỉ tiêu delta=0 hoặc INCONCLUSIVE ghi rõ).
- Runtime error/latency/deny metrics: từ dashboard/alert mới.
- Hidden caller/legacy writer result: writer map machine-readable + kết quả log-scan.
- Observation completed at: `<owner-defined>`
- Final reviewer: `<owner-designated>`
- Final state (`APPLIED` hoặc `VERIFIED`): giữ ở **`PREPARED`** cho tới khi có staging chạy đủ concurrency/reconciliation/direct-JWT và reviewer duyệt; chỉ `VERIFIED` khi đủ evidence định danh (STATUS quy tắc cập nhật).
- Tracker update commit: `<cập nhật AUTHORIZATION-IMPLEMENTATION-STATUS.md hàng T4a + §27.5 hàng T4>`

Evidence không được chứa credential, JWT, signed URL, private object path hoặc PII. PAT/JWT không in ra console/log/commit (đã là kỷ luật trong cả 4 script harness hiện có).
