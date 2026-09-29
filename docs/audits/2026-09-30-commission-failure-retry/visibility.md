# Giới hạn số lần kiểm quyền đọc phiếu trong follow-up

Ngày 30/09/2026, base `760977254b63a9da39649142a4b6c81530324d73`. Chỉ sửa reader v2 trong migration chưa phát hành production; cùng helper quyền đọc, không sửa writer/ACL/RLS/timeout hoặc reader tiền khác.

## Nguyên nhân đã chứng minh và giới hạn

Controlled UI STAFF một tòa tại commit1961b24 tái hiện `57014` (statement timeout): direct JWT v2 sau retry HTTP500 trong18601.5282ms. Cùng lượt, browser v2 và các reader cũ income_expenses, building_fee_accounts, income_expense_types, get_period_maintenance, get_income_expense_layer_stats cũng57014 khoảng15.7–16.2giây. Phiếu đã được tạo đúng1; cleanup thành công. Không coi lượt đó là đạt, không suy mọi timeout do môi trường.

EXPLAIN VERBOSE trên TEST với NATHAN thật, `income_expenses.view` có scope10tòa, `org_wide=false`, dùng hợp đồng/phiếu có sẵn cho thấy planner inline LATERAL `visible.ok`: 5 tham chiếu helper ở projection và2tham chiếu trong aggregate lịch sử cho mỗi event. Regression PGlite với helper STABLE được instrument bằng sequence đo đúng **9 lần cho1dòng/2events**. Đây là amplification thực tế, không phải chỉ suy từ source.

Snapshot pg_stat_activity duy nhất trong lượt UI thấy một client khác chờ transactionid1.11giây, không phải v2/execute; không đủ kết luận lock là nguyên nhân. TEST PostgreSQL17.6, authenticated `statement_timeout=8s`, `jit=off`, `plan_cache_mode=auto`, `track_functions=none`. Không sửa các cấu hình đó. JIT không giải thích mẫu đo này.

## Thay đổi

Thêm CTE `page_visibility AS MATERIALIZED` sau LIMIT/OFFSET. Giữ nguyên biểu thức `can_read_finance AND live_voucher_id IS NOT NULL AND app_private.ie_supplement_can_read_v1(live_voucher_id)`, tính tối đa1lần/dòng trang rồi dùng lại cho voucher identity/status, last amount/reason và event amount/reason. Helper vẫn chạy dưới parent voucher RLS. Scope, alias thưởng qua cọc, counts trước kind/pagination, v1 projection và mọi writer giữ nguyên.

## Đo chỉ đọc

Tất cả EXPLAIN SELECT dùng BEGIN READ ONLY/ROLLBACK, claims của actual scoped actor, search_path như SECURITY DEFINER; không tạo function hoặc fixture trong phép đo. So sánh tuần tự, có hiệu ứng cache; đây không phải load benchmark.

| Trường hợp | Execution | Planning | Tham chiếu helper trong plan |
|---|---:|---:|---:|
| Installed trước sửa, single-contract |596.667ms|40.265ms|7|
| SELECT-only materialized variant |252.376ms|82.077ms|1|
| Installed sau2lần applyTEST |261.539ms|46.973ms|1|

Helper độc lập trước/sau40.008/38.421ms. Trước sửa auth/eligible~132ms, projected aggregate~592.881ms. JSON kết quả SELECT trước/variant bằng nhau. REST đọc identity cùng phiếu actual JWT đều200, trước1147ms/sau1650ms; không diễn giải latency HTTP như cải thiện chung.

`EXPLAIN (GENERIC_PLAN,VERBOSE)` với đủ10parameter cho SELECT thật: trước totalcost515.3/7helperrefs, sau511.9/1helperref. Không có JIT. Đây là generic SELECT plan, **chưa quan sát execution plan đang cache bên trong PL/pgSQL/PostgREST**. Call-count regression là bằng chứng quyết định cho giới hạn invocation, không dùng thời gian để làm assertion dễ nhiễu.

## Kiểm chứng

- RED: `npx vitest run src/lib/__tests__/commissionFailureRetryMigration.test.ts -t "evaluates live voucher authorization"` thất bại đúng `expected 9 to be 1`. Các test không được chọn không tính là pass.
- GREEN: `npx vitest run src/lib/__tests__/commissionFailureRetryMigration.test.ts src/lib/__tests__/contractCommissionFollowup.test.ts`: **31/31**, gồm21SQL và10boundary. Case mới có phiếu live nằm ngoài trang, financial history được phép và bị che; cả hai lượt chỉ1helpercall cho1dòng.
- `node scripts/test-env/thu-sql.mjs supabase/migrations/20260929154941_commission_failure_retry.sql --ghi`: **hai lần exit0**, targetTEST hzulujxgonszuleqticb, không production apply.
- `node scripts/test-commission-failure-retry.mjs --env test`: **17ca JWT/concurrency đạt, cleanuptrue**. Case mới kiểm sau canonical execute: scoped finance actor thấy đúng identity/history; actual STAFF contract-only cùngorg thấy live-state nhưng mọi identity/status/amount/reason bị che, execute/prepare403, khácorg403, raw private table403. Các ca tiền/lifecycle/concurrency cũ vẫn đạt; canonical body không đổi trong fixtures.
- `npm run typecheck:baseline`: exit0,0fingerprint. Types TEST tạm có rent-support ngoài phạm vi vẫn không stage.
- Provenance sinh bằng official generator sau stageSQL, chỉ đọc catalog production; thay generatedAt và đúng1hash, không sửa bằng tay. `npm run gate:migration-provenance` exit0; các unknown lịch sử là nợ có sẵn, không diễn giải đã rollout.
- Stable-function lock check dùng nguyên SQL từ `scripts/check-stable-fn-locks.mjs` nhưng chạy qua guarded TEST psql READ ONLY (entrypoint cũ hard-code production): **0vi phạm, exit0**; không dùng kết quả production để chứng minh TEST.
- `git diff --check`: exit0.

JWT hoàn tất trước mutation. Dùng `scripts/dot-bien.mjs`, đổi đúng `page_visibility AS MATERIALIZED` thành `page_visibility AS NOT MATERIALIZED`, targeted invocation suite đỏ `expected 9 to be 1`; helper exit0, finally khôi phục đúng hash:

```text
final/original add806a9b93a485dafb81010d375e87514938c62661bbdb391092efe386cadca
mutant         aafefca667a35bef421f61ca792fad7f0cf6b157244928bde7db4b21cc78069e
restored       add806a9b93a485dafb81010d375e87514938c62661bbdb391092efe386cadca
```

## Handoff

Không đổi API/DTO hoặc caller. Cần controller review hẹp và chạy controlled UI E2E sau fix này + helperfix76097725; **chưa tuyên bố E2E xanh hoặc mọi legacy timeout đã hết**. Refresh/realtime trên trang vẫn có thể tạo tải reader cũ; nếu còn lỗi phải giữ network gate và điều tra riêng có bằng chứng. Không tăng timeout, không bỏ500, không lặp chạy để lấy xanh. Chưa production migration/deploy.

Bằng chứng local đầy đủ dưới `.superpowers/sdd/2026-09-29-commission-failure-retry/task-1-visibility-*` (RED/GREEN/apply1/apply2/JWT/mutation/typecheck/stable-locks); raw plans chỉ đọc trong ignored `outputs/commission-failure-retry/profile-*.json`. Số liệu cần thiết đã ghi ở đây để checkout sạch vẫn review được.
