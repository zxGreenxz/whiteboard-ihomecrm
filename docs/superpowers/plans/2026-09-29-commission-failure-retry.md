# Sửa theo dõi lỗi tạo phiếu hoa hồng sau ký

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. User has explicitly requested the correction and authorized the duplicate-check mechanism; proceed without another design approval.

**Goal:** Chỉ ghi nhận lỗi/gián đoạn tạo phiếu có bằng chứng; cho tạo lại an toàn ngay tại hợp đồng và tab Cần rà soát, không coi hợp đồng cũ chưa có phiếu là lỗi.

**Architecture:** Bằng chứng yêu cầu được lưu trước khi gửi tạo phiếu; máy chủ đối chiếu phiếu thật, kể cả thưởng qua cọc, trước khi đưa vào hàng đợi hoặc cho tạo lại. Giữ canonical writer, khóa và unique hiện hữu; lưu kết quả thành công bền vững để lỗi mất phản hồi hoặc hủy phiếu sau đó không làm sống lại một lỗi tạo giả. UI hàng đợi là việc cần xử lý, không phải phiếu/nợ/tiền đã chi.

**Tech Stack:** React, TanStack Query, Zod, Supabase PostgreSQL/PostgREST, Vitest/PGlite, Playwright.

## Global Constraints

- Đọc PROJECT_CONTRACT; đây là money + authorization + migration, cần independent review, draft PR, forward lane có backup và promote đúng SHA CI.
- Chỉ lỗi hoặc yêu cầu tạo đã ghi nhận nhưng kết quả chưa xác minh mới vào hàng đợi. Không có event = không suy lỗi; không backfill lỗi cho hợp đồng cũ; không giữ 682 mục PENDING dưới tên khác.
- Contract detail: ghi chú lỗi dưới hành động tạo hoa hồng/thưởng, kèm nút **Tạo lại** cho đúng loại lỗi. Trang **Hợp đồng & quyết toán**: tích hợp vào **Cần rà soát** hiện hữu, bỏ global banner trên cả danh sách Hợp đồng và Quyết toán; không thêm tab mới vào danh sách Hợp đồng; không xóa các hồ sơ rà soát nghiệp vụ khác.
- Trước retry máy chủ xác minh đúng org/contract/kind, live voucher và thưởng qua cọc; room id đơn lẻ không đủ vì một phòng có nhiều hợp đồng. Trả phiếu đã tồn tại, không tạo lại. Hai người/2 tab bấm đồng thời không thể tạo 2 phiếu. Không auto-retry mutation.
- Giữ quyền org/toà/tài chính, không lộ reason/amount/bank với contract-only users; trạng thái tồn tại phiếu có thể báo đã có dù không được đọc chi tiết.
- Không đổi số tiền, trạng thái duyệt/ghi sổ, công thức hoa hồng, lương hoặc tiền thuê. Không tạo phiếu 0, không tự quyết không phát sinh.
- TEST hzulujxgonszuleqticb dùng fixture; production org THẬT chỉ đọc. Rent-support v2 WIP nằm worktree khác, không kéo vào hotfix hoặc làm lệch generated types production bằng schema v2 trên TEST.
- Migration tên do scripts/tao-ten-migration.mjs cấp; deployed 20260929130117 immutable. Stage file cụ thể; generated artifacts qua generator; trailer Co-Authored-By: Codex <noreply@openai.com>.

## Root cause confirmed

`list_contract_commission_followups_v1` builds every contract × broker/sale, labels no event PENDING, and `p_unresolved_only` excludes only VOUCHER_CREATED/NOT_APPLICABLE. Thus zero history becomes hundreds of apparent problems. Pages mount a global panel, detail panel is above main content, not by issuance action. Current record-before-create protects one RPC, but a selected broker+sale batch records the second only after first succeeds, leaving a crash between calls untracked. Real voucher precedence exists and must remain.

### Task 1 — Bằng chứng lỗi và tạo lại từ máy chủ

**Files:** new migration via `node scripts/tao-ten-migration.mjs commission_failure_retry`; new `src/lib/__tests__/commissionFailureRetryMigration.test.ts`; modify `src/lib/contractCommissionFollowup.ts`, `src/hooks/useCommissionVoucher.ts` and related tests; generated types via generator only.

**Interfaces:** preserve modal's full status read for permissions/existing vouchers, but unresolved queue excludes PENDING/NOT_APPLICABLE/VOUCHER_CREATED. Provide typed queue read with actual total + org/building/contract/kind/search/period scope filters needed by Task2, and a typed tracked creation boundary returning the existing or created voucher identity. Report exact functions/types to Task2.

- [x] RED fixtures: hundreds of unattempted subjects => zero errors; FAILED with matching attempt => one; interrupted ATTEMPTED => unknown result; completed voucher after lost response => absent from error queue. Running attempt must not be immediately presented as failure; use explicit processing state/grace with no automatic mutation.
- [x] Preserve/audit attempt identity and successful completion server-side. A successful tracked attempt remains successful after later cancel/delete; cancellation is separate lifecycle and must not resurrect creation failure. Late error for older request cannot override a newer result.
- [x] Persist selected positive issuance intents before sequential batch starts, so browser loss between broker and sale remains visible. Do not invent attempts for zero/unselected kinds or merely opening/dismissing the modal. Failure to persist intent prevents sending creation.
- [x] Authoritative retry checks actual direct and deposit-linked vouchers under canonical lock. Lost response then retry returns existing ID; 2 concurrent calls yield one voucher. Keep exact payload/request identity (changed payload conflict) and no bypass of canonical auth/engine. Same room/different contract stays independent.
- [x] Use actual effective canonical writer from TEST/catalog; adapt narrowly and preserve postings. Existing status readers and callers remain compatible; old app unresolved read immediately stops counting unattempted rows when migration is installed.
- [x] Queue filters/count/pagination must agree (no first-page totals); period refers to attempted issuance timestamp in Asia/Ho_Chi_Minh, not invented historical signing cutoff. Finance redaction applies to all outputs, payloads and any new raw tables.
- [x] GREEN actual SQL tests, actual TEST JWT allowed/denied and multi-connection retry/lost-response/alias cases; mutation removing attempt predicate or duplicate guard must go red. Apply migration twice on TEST, verify ACL/volatility. Do not enable or alter rent-support writers. Commit and write full report.

### Task 2 — Ghi chú tại hợp đồng và tab Cần rà soát

**Files:** `src/components/contracts/ContractCommissionFollowupPanel.tsx`, `CommissionVoucherModal.tsx`, `ContractWorkspaceTabList.tsx`, `src/pages/contracts/ContractsPage.tsx`, `ContractsMobilePage.tsx`, `src/components/contracts/detail/ContractDetailView.tsx`, desktop/mobile detail children, `src/components/thu-tien/contract-settlement/ContractSettlementSection.tsx`, `src/hooks/useContractCommissionFollowup.ts`, adjacent component/hook tests.

**Interfaces:** consume Task1 authoritative queue/status/tracked writer; retry target is (contractId,kind). Follow exact handoff report, not guessed APIs.

- [x] RED: empty history/legacy PENDING renders no detail warning/banner; actual error renders below creation action with exact contract/kind, safe reason and Tạo lại. Existing voucher disables creation and offers verified existing identity; hidden finance data stays hidden.
- [x] Remove global panels and explanatory debt/backlog text on Contracts desktop/mobile and Settlement. User clarified exactly two placements: contract detail and the existing Cần rà soát lane of the page titled Hợp đồng & quyết toán. Do not add a third placement or new tab to Contracts list. Preserve draft/exits tabs; accurate queue loading/error/empty states belong inside the existing review lane.
- [x] Settlement errors appear within existing review lane with Tạo lại, correct kind/search/building/period filters and count. Do not add attempted amounts to payout/paid totals or manufacture SettlementRow voucher IDs. Existing review rows/actions remain.
- [x] Với durable request mới, Tạo lại gọi trực tiếp execute/reconcile bằng request_id và payload đã lưu; không buộc nhập lại hoặc thêm bước xác nhận không cần thiết. Legacy failure thiếu payload thì mở issuance UI chỉ cho loại lỗi để bổ sung đầu vào; không tự đoán account/bank. Đọc lại nguồn thật khi mở/submit, dùng Task1 action và invalidate queue sau kết quả. Không retry sibling thành công. Persist all selected intents before normal 2-kind submit.
- [x] Retain popup after direct create and draft->reopen->sign; closing modal doesn't create fictitious failure; persisted real failures survive navigation/reload. Failures reading queue show retry/load error, not 0 success.
- [x] GREEN focused component tests, typecheck, build/bundle; TEST headless E2E desktop/mobile with induced request failure and after-commit response loss, reload then retry yields one real voucher and queue clears. Console checked, fixtures cleaned. Commit/report and independent review.

Trạng thái 30/09 trên ứng viên `832b4261`: 169 focused tests, TEST JWT 23/23, hai money gates, build/bundle và scoped rereview ba finding đạt; E2E scoped STAFF headless 7 kiểm tra đạt, 0 unexpected console/network/production và dọn fixture. **Full-popup OWNER strict mới nhất đạt** với **TEST pool 2**, report **02:21:31.427–02:22:44.269 UTC ngày 30/09**, browser child exit 0: cả direct-create và draft → reopen → sign giữ popup, đóng tạo 0 commission request, errors/network/production đều rỗng, cleanup true. Cùng source và full OWNER scope, không đổi auth/timeout/schema/assertion. Composite Task 2 hoàn tất; DOCX vẫn chỉ kiểm metadata tổng hợp, chưa kiểm byte/export/download.

Giữ nguyên lịch sử đỏ: các lượt 8 HTTP 500, 3 legacy `57014` và full-popup resource trace 5 lỗi (1 HTTP 503/`PGRST002`, 4 HTTP 500/`57014`). Replay chỉ đọc 10/11 reader một lần đạt 200/206 trong 0,70–1,67 giây không phải full E2E. Bằng chứng ngày 29/09 UTC nối Realtime partition `20:19:39.069` với watcher rộng chỉ loại `pg_temp`, 5 reload log rows `20:19:39.217–.245` và PostgREST 14.5/authenticator catalog SELECT 5257 ký tự bị `57014` `20:19:47.568` rồi PGRST002. Monitor 33 scrape/RAM 426,3 MB cho tương quan paging/I/O, một mẫu thiếu; chưa quy bốn timeout ký muộn hoàn toàn cho reload hay tài nguyên.

Null pool preflight abort trước thay đổi (PATCH400/readback không đổi). Numeric lượt đầu 10→2 gặp lỗi ignored Windows runner trước browser/fixture/metrics, finally khôi phục explicit 10 (effective capacity gốc, không phải metadata null). Lượt actual sửa `fileURLToPath` giữ pool 2, GET **02:22:44.712** xác minh cùng các config khác; monitor child exit 0 **02:25:31.468**. Official log vẫn có cold Realtime startup/partition 02:21:40.654, 5 reload rows, max pool 2; cache query 2867,3/1015,0 ms tải 282 relations/810 functions không lỗi. 22 metrics đều200, browser duration max1963,333 ms. Marker replication-slot Realtime 2.138.1→2.139.0 là confound ngoài pool. Lượt strict đạt giải quyết blocker popup hiện tại theo điều kiện TEST đã ghi, không chứng minh PASS chỉ do pool, watcher đã được sửa hoặc production cần đổi pool.

Controller giữ lead. Role `postgres` không superuser/thành viên owner; managed watcher/event thuộc `supabase_admin`; [bản nháp hỗ trợ](../../audits/2026-09-30-commission-failure-retry/supabase-support-draft.md) chưa gửi, giữ đầu mối provider nhưng không chặn tiếp tục Task 3. Không thêm speculative SQL optimization hoặc thay timeout/compute/watcher/assertion; source đã review và schema/app/config production giữ nguyên. [Audit](../../audits/2026-09-30-commission-failure-retry/verification.md) tự chứa timestamp/số đo/điều kiện.

### Task 3 — Kiểm chứng và phát hành bản sửa

**Files:** focused auth/concurrency/E2E harnesses if needed, business docs if behavior warrants, generated surfaces/provenance/types through normal tooling.

Production aggregate chỉ đọc ngày 30/09 xác nhận 682 subject không có attempt/live voucher và 0 event: chúng không phải lỗi. Whole-app unit cuối trên `832b4261`, Node 24.18.0/`maxWorkers=1`, đạt 685 file/9.633 test trong 671,20 giây; lượt 9599/9600 trước vẫn là lịch sử đỏ. Blocker popup strict đã được giải quyết bằng full OWNER flow đạt với TEST pool 2; Task 3/release **PENDING**, chưa hoàn tất draft PR, production forward lane/types/gates/CI, promotion và smoke. Managed watcher chưa sửa và các timeout cũ chưa có attribution đầy đủ; không suy từ TEST config sang production. Các checkbox giữ mở.

- [ ] Verify original no-event count via read-only production aggregate; do not enumerate private customer data in logs. Full relevant tests, both money gates, schema/catalog/stable checks, meaningful mutation and actual JWT/concurrency evidence.
- [ ] Final whole-branch independent review; fetch/rebase latest main, preserve unrelated work. Draft PR attach with evidence and remaining limits, no unreviewed money changes.
- [ ] Forward schema lane dry-run+apply with backup and reviewed clean SHA; generated metadata from production after migration, full prepush and CI. Do not copy TEST v2 rent-support types into hotfix.
- [ ] Promote exact SHA, verify Vercel deployment and read-only production UI/RPC: no phantom 682 queue, correct detail/tab placement, no console errors attributable to fix. No business writes to REAL org.
- [ ] Resume rent-support Task2 fix1 original agent at checkpoint, then rebase/integrate this hotfix before remaining feature tasks. Latest user correction supersedes prior plan's PENDING backlog wording.
