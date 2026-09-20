# T2 — authenticated settlement reader

Status: DONE_WITH_CONCERNS (integration/release gates remain; no shared schema applied).

## Implementation / RPC contract

Migration allocated by `node scripts/tao-ten-migration.mjs contract_settlement_authenticated_reader`:
`supabase/migrations/20260920175511_contract_settlement_authenticated_reader.sql`.

`public.read_contract_settlement_page_v1(p_organization_id uuid, p_building_ids uuid[], p_cursor text DEFAULT NULL, p_revision text DEFAULT NULL, p_limit integer DEFAULT 250) RETURNS jsonb`.
Output `{rows: SettlementRow[], nextCursor: string|null, revision: string, asOf: string}`. Limit 1..1000; app uses250. Cursor is last rowKey; deterministic prefix+UUID ordering. SQL builds the complete scoped set in one statement, hashes its content plus actor/org, then slices the page. Following requests must provide the initial revision; change returns PT409/HTTP409. This detects cross-request content drift; it is NOT a multi-request transactional snapshot. Totals use all successfully read pages with the exact same client predicates as returned rows. Later page failure, duplicate keys, invalid cursor, scope mismatch or unavailable snapshot suppress totals. Safe-integer overflow throws rather than rounding money.

STABLE SECURITY DEFINER, search_path `pg_catalog, public, app_private`. Local catalog ACL after migration: `{postgres=X/postgres,authenticated=X/postgres}`; PUBLIC/anon/service_role revoked. Requires auth.uid, ACTIVE valid membership and ACTIVE organization; every requested building must be same org/nondeleted, pass building_org_visible_v1 and can_access_building OR ie_all_buildings_scope. Explicit restricted-item and demo actor deny predicates preserved for vouchers; sandbox/demo building policy helper retained. This is deliberately building-scoped, not fund-only access. Read scope does not imply write capability.

Read voucher-first: broker/sale (including legacy duplicate history), legacy broker item classification matching existing audited commission reader, termination.refund and reservation.refund. No date restriction on SQL vouchers. Optional blank names/banks/notes/systemSource/fingerprints normalize to NULL; identity/code are never invented. Runtime fixture verifies blank notes/payer/banks/systemSource become NULL. Source candidates queried separately with the same authorized scope. No notes parsing. Snapshot money/state/all versions/owner/posting evidence come from the same SQL statement. Net-paid uses actual posting rows, active evidence validates linked voucher+org; approved does not mean paid. Action readiness remains loading for T3 to replace from the shared policy snapshot.

Source links: private Sale deposit claims work without a contract; ambiguous multi-claim result is one unverified voucher, not arbitrary first result. Refund obligation joins termination→contract→room→building. Unique legacy termination fallback requires one matching termination AND one matching refund voucher; ambiguous histories remain unverified. Latest obligation is a source only when no obligation/history voucher is known, including cancelled history. Approved termination without obligation remains unknown-basis source. Reservation LATER uses settlement + canonical refunded helper, and no historical refund link; source ref carries sourceVoucherId/settlementId, creation remains unavailable.

Broker source amount reuses `app_private.commission_rate_for_v1` (published effective version, org_today, tenure months), not old buildings.commission_tiers JSON. Missing published rate remains NULL. Creation always unavailable/SOURCE_ADAPTER_REQUIRED pending T6/T6R's authenticated source adapter. No automatic Sale candidates: controller confirmed there is no stored uncreated reward request; room notes/cap are not a payable obligation. Existing Sale vouchers and private claims are complete. T6 owns user-initiated proposal source+amount validation; no new request table invented.

Hook API: `useContractSettlement(scope, selection?, enabled?)` returns rows/totals/loading/error (Vietnamese)/errorCode/partial/pagination/selectionDetail/revision/asOf/capabilities/refresh():Promise<void>. Query keys include org/actor/scopeRevision/normalized building IDs/period/mode/full filters. Existing AuthCacheSync clears business queries on principal changes. Scope/permission revision produces separate key. No placeholderData from previous scope. Source identity excludes mutable obligation version/link metadata, and a source selection can resolve its unique newly-created voucher; multiple matches remain unavailable. Payments integration should use mode=all and filters={period} to get the complete all-state dataset.

## Refresh dependency map

Every table below invalidates the same `contract-settlement/<org>/<actor>` prefix, thereby refreshing rows/source eligibility/basis/versions/posting totals together. T3 action snapshots and T7 timeline must consume their own shared invalidation in integration; this task does not claim to implement those readers.

| Tables | Settlement dependency | Refresh |
| --- | --- | --- |
| contracts, rooms, buildings | source scope/date/metadata/rent/tenure | realtime +30s poll/focus/manual |
| contract_customers, customers | representative actual customer | realtime subscription +30s fallback |
| contract_terminations | termination source/date | realtime +30s fallback |
| contract_transfers | timeline-adjacent relation change, conservative invalidation | realtime +30s fallback |
| income_expenses | vouchers, source absence/link, full state/version/recipient | realtime +30s fallback |
| income_expense_items, income_expense_types | legacy broker classification | realtime subscription +30s fallback |
| termination_refund_obligations | authoritative refund basis/link/version | realtime subscription +30s fallback |
| income_expense_postings | verified paid status and actual net | realtime subscription +30s fallback |
| reservation_deposit_settlements, reservation_settlement_vouchers | reservation source/link/remaining | realtime subscription +30s fallback |
| invoices | conservative invalidation for integration of source facts; not directly queried by this SQL | realtime +30s fallback |
| organization_memberships | active membership invalidation | realtime subscription +30s fallback + scoped key revision |
| app_private.sale_bonus_claims, income_expense_flow_ownership, commission_tier_versions | private source links/owner/published basis | no public realtime; 30s poll, focus, explicit refresh after writer |

Local publication contains income_expenses/invoices/buildings/items/contracts/terminations/transfers/customers/rooms/reservation settlements. It does NOT contain contract_customers, income_expense_types, obligations, postings, reservation links or memberships. Subscription is acceleration only; `refetchInterval:30000`, refetchOnWindowFocus:'always', explicit awaited refresh cover unpublished tables. Local post-mutation read proves revision change and new authenticated read path; browser timer/focus execution is still integration/E2E gate, not claimed here. No publication mutation made.

## Verification evidence

- RED: `npx vitest run src/lib/__tests__/contractSettlementReader.test.ts` failed because new reader module did not exist. Six tests written first for complete1001, later-page failure/no totals, duplicate, revision, period boundary, scoped keys.
- GREEN final: `npx vitest run src/lib/__tests__/contractSettlementReader.test.ts src/lib/__tests__/contractSettlement.test.ts`:49/49 passing (9 reader +40 domain), no skipped tests. Later added known denied-detail/foreign-org unavailable detail and stable source identity tests.
- `npx tsc --noEmit -p tsconfig.app.json`: exit0, no diagnostics.
- `npm run gate:rpc-cast`:0 casts, baseline0.
- `node scripts/check-test-matrix.mjs`:734 test files/11 suites/no orphan. Local operator harness is documented in matrix notes, not falsely registered as a CI test suite (the matrix intentionally inventories *.test/spec files). Unit test is app-unit owned.
- `git diff --check`: no whitespace errors.
- `node scripts/test-contract-settlement-reader-local.mjs`: authenticated PostgREST16.3/PG17.10, own random local org/actor/scoped building+permission metadata, cleanup in finally. Existing review fixture untouched. Permission definitions are not seeded by baseline; temporary buildings.view row uses exact migration20260713110100 metadata and is removed if harness inserted it. No service-role RPC, no remote endpoint option.
- Final local result: **1001 vouchers +3 sources /5 pages**, exact SQL voucher ID set and header total **10010**. **Read3517ms; read+assert4690ms**. 1000 Sale rows share a contract with explicit legacy-duplicate flag (without this flag the real unique constraint correctly rejects the fixture); one private deposit Sale has contractNULL. Sources: broker unknown tier(NULL), refund obligation123, reservation LATER100. Real posting evidence amount10 and date2026-08-31; approved-unposted/cancelled/noncash/reversed states retained. Outsider/wrong org/wrong building/SUSPENDED member all403; arbitrary stale and concurrent amount change return409. Setup/check/cleanup occur only in existing disposable loopback runtime.
- SQL migration applied repeatedly locally, idempotent CREATE OR REPLACE+ACL; no row locking or writer statements inside RPC.
- Mutation via `scripts/dot-bien.mjs`: removing building permission guard, hash a161a67d4062→febabefd0097, actual JWT test red `200 !== 403`, restored original hash and reapplied restored local SQL. Removing partial-total suppression, hash18025a5d7ccc→82c877da07aa, unit suite red, restored hash. Both helper exit0. Subsequent additions preserved guards and successful final runtime.

## Remaining gates / concerns

- Full-set JSON/revision recalculation every page is correctness-first and measured only locally. Production-sized all-year dataset cost remains unmeasured; no production performance claim.
- `node scripts/check-stable-fn-locks.mjs` could not run its live catalog check: **Không tìm thấy PAT**. Local actual STABLE authenticated PostgREST execution passed, but does not replace shared catalog gate.
- No generated-type hand edits. New RPC uses a narrow named typed facade with boundary parsing. Controller owns type generation/provenance/surface artifacts after all schema tasks, gate:truoc-push, build/bundle, full regression, shared role/sandbox/restricted-data matrix, reconcile v1/v2, E2E and independent review.
- T3 must attach real action policy/readiness; T6/T6R real source creation capability is intentionally unavailable. No writes/actions activated by this task.
- No schema applied to shared Supabase, no deployment/PR/release claims. The main-source report and SQL cover runtime local fixture, not production parity of every policy/data combination.

## Files

- src/lib/contractSettlementReader.ts
- src/lib/contractSettlementRepository.ts
- src/hooks/useContractSettlement.ts
- src/lib/__tests__/contractSettlementReader.test.ts
- supabase/migrations/20260920175511_contract_settlement_authenticated_reader.sql
- scripts/test-contract-settlement-reader-local.mjs
- tooling/test-matrix.json (operator harness note)
- .superpowers/sdd/2026-09-20-hop-dong-quyet-toan/task-2-report.md

No edits to generated types, root-owned plan, Payments UI/CSS, or existing review fixtures.

## T2 — fix round1 (base07979e21)

Hai finding Important của task-2-review.md đã sửa trong reader/client contract, không đổi SQL/hook hoặc schema:

- `mode=backlog` không cắt theo tháng header; phiếu pending phát sinh01/09 vẫn hiện khi header08 và vào tổng pending. Header chỉ dùng đánh dấu tồn cũ qua filter nghiệp vụ.
- `SettlementReadScope.dateBasis` bắt buộc `business | posting`, là thành phần riêng trong query key. Business dùng sourceEventDate/voucherDate (nguồn dùng eventDate). Posting chỉ dùng postedOn khi cash POSTED và getSettlementDisplayState xác minh active posting ID/net/date. Period predicate chạy trước cùng list+totals. Ngày là calendar date từ backend, không chuyển bằng Date/UTC ở client.
- Posting cohort loại source chưa có cash posting và phiếu biết chắc unposted/noncash/reversed. Unknown snapshot hoặc cash POSTED thiếu/mâu thuẫn bằng chứng vẫn giữ dòng, partial=true/totals=null. Không lấy ngày nguồn để giả định tháng đã chi.

TDD: thêm4 test và mở rộng key test trước sửa; `npx vitest run src/lib/__tests__/contractSettlementReader.test.ts` RED4/13 (backlog mất phiếu, posting kỳ sai, unverified detail mất dòng, key không phân biệt basis). GREEN13/13 sau sửa. Test boundary: nguồn31/08, postedOn01/09; chạy cả basis và cả tháng08/09, kiểm list và effectiveNetPaid; source/unposted/noncash có ngày nghiệp vụ01/09 vẫn bị loại khỏi posting filter; denied/loading/mismatched posting evidence vẫn hiện/no totals.

Mutation `scripts/dot-bien.mjs`: đổi postedOn về sourceEventDate/voucherDate, dadc9d4bcd84→3a6054e1f101, suite đỏ đúng test posting boundary; đổi backlog exemption về chỉ all, dadc9d4bcd84→a05b6f55cb51, suite đỏ đúng test backlog. Cả hai exit0 và khôi phục digest dadc9d4bcd84. Không rerun SQL harness hay broad suite vì không đổi SQL.

Files round1: src/lib/contractSettlementReader.ts, src/lib/__tests__/contractSettlementReader.test.ts, report này. Các gate tích hợp/release đã nêu ở trên giữ nguyên.

Round1 typecheck: npx tsc --noEmit -p tsconfig.app.json exit1 vì lỗi T8A ngoài scope tại ContractSettlementPayments.test.tsx:48 (TS2769: exact không thuộc ByRoleOptions). Không có diagnostic ở reader/test đã sửa. Đã báo controller, không sửa file root-owned. git diff --check đạt.
