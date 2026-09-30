# Slice B — phản hồi hợp đồng

Nguồn: kế hoạch đã duyệt trong `plan.md`, Project Contract §3/§8/§14. Mã trong worktree `codex/thong-bao-nguoi-dung`; chưa stage/commit/push. Bảng ghi việc đã kiểm bằng test và giới hạn cần E2E hoặc nguồn server thực.

| ID | Kết quả hiện tại | Bằng chứng / còn lại |
|---|---|---|
| B01 | Schema chặn kỳ tính tiền đầu trước ngày bắt đầu hợp đồng; nêu biên ngày thực từ form tại ô ngày bắt đầu kỳ. Lý do server chính xác dùng cùng formatter khi có form data. Ranh giới bằng nhau hợp lệ. | `contractBillingBounds.test.ts` 4 pass chung B01–B02; chưa E2E RPC22023 trên môi trường demo. |
| B02 | Schema chặn kỳ tính tiền cuối sau ngày kết thúc hợp đồng; nêu biên ngày thực tại ô ngày kết thúc kỳ. Lý do server chính xác dùng cùng formatter khi có form data. Ranh giới bằng nhau hợp lệ. | `contractBillingBounds.test.ts` 4 pass chung B01–B02; chưa E2E RPC22023 trên môi trường demo. |
| B03 | `onInvalid` focus ô lỗi đầu theo thứ tự thay vì cuộn lên đầu; FormControl chung gắn `data-field-name`; nhóm custom có mốc focus. | `formErrors.test.ts` do root sở hữu và `useContractSubmit.focus.test.ts` 2 pass. Chưa E2E date/currency/select trên browser thật. |
| B04 | Thiếu khách hàng tạo lỗi đỏ tại nhóm và focus nút chọn. | DOM test `useContractSubmit.focus.test.ts` pass. |
| B05 | Lý do phòng đã có HĐ, trạng thái phòng không cho ký, bị giữ chỗ được ánh xạ chính xác tới ô phòng và yêu cầu tải lại. | `contractFeedback.test.ts`, DOM conflict focus pass. Chưa xác minh live mọi trạng thái phòng. |
| B06 | Lý do khách trùng/đại diện từ writer gắn nhóm khách. | Test ánh xạ pass; chưa E2E với danh sách khách trùng. |
| B07 | Giá thuê/cọc và giá dịch vụ từ writer gắn nhóm tương ứng; overdeposit local gắn ô tổng cọc. | Test ánh xạ pass; chưa E2E giá dịch vụ từng dòng. |
| B08 | Mẫu HĐ/hóa đơn lấy tự động từ cấu hình: lỗi đã xác minh chỉ tới Cài đặt > Mẫu tài liệu và có nút mở trang cài đặt ở tab mới, giữ form đang nhập. Không gán lỗi cho ô không tồn tại. | `contractFeedback.test.ts` pass; chưa E2E quyền vào trang cài đặt mẫu. |
| B09 | Phiếu cọc đã dùng/đổi trạng thái hiện ở nhóm cọc, và luồng cũ tải lại cọc giữ chỗ. | Test ánh xạ và test submit cũ pass; chưa E2E race cọc. |
| B10 | Cọc vượt hợp đồng chặn tại form và gắn `total_deposit`; lý do từ writer cũng ánh xạ. | Test ánh xạ pass. |
| B11 | Thiếu mode/lý do/ngày hẹn gắn từng ô; writer thiếu lý do + ngày thì chỉ cả hai ô. | Test submit và ánh xạ pass. |
| B12 | Dòng cọc hóa đơn đầu lệch chặn và hiện ngay nhóm hóa đơn đầu. | Test ánh xạ pass; chưa E2E sửa dòng cọc. |
| B13 | Local kiểm từng dòng hóa đơn đầu về đơn giá/số lượng/kỳ ngày và báo inline đúng dòng, `aria-invalid` + focus; lỗi từ writer không có row index thì hiện ở nhóm hóa đơn đầu với câu dễ hiểu. | `contractInvoiceFeedback.test.ts` và `useContractSubmit.test.ts` pass. Kỳ ngày phát sinh tự động, gợi ý sửa kỳ tính tiền phía trên; chưa E2E. |
| B14 | Tạo trực tiếp dùng marker actor theo roomID toàn cục và progress.requestKey persisted trước RPC; unknown không vượt bằng payload mới/org switch/remount. Receipt cần exact room/ID/ACTIVE + money hợp lệ; positive ID lưu trước DTO check. Callback form sở hữu một toast lỗi (stale cọc không lặp hook), giữ draft/field. Ký từ nháp dùng marker org+draft, exact requestKey readonly recovery, chỉ nhận đúng source/document/revision. | Contract create durable6 (5 RED→GREEN), signing durable6 (6 RED→GREEN), signing DOM14 gồm actualDateInput invalid/focus và pending remount; cache/doc regressions giữ. E2E chưa kiểm. |
| B15 | Intent core/khách/dịch vụ và phase trước từng writer lưu bền vững theo actor+contractID. Recovery đọc core+relations authoritative; null/mismatch unknown không saved/replay, kể cả DELETE muốn rỗng. Known delete-ack + known insert rejection chỉ tiếp tục INSERT sau positive empty read; mọi phần xong sau final exact snapshot. | Controller14 + hooks8 + form remount/footer/submit; targeted final93/93 của12file B14/B15. DELETE/INSERT vẫn không cùng transaction; E2E race chưa kiểm. |
| B16 | Hai hook live gia hạn/chuyển phòng dùng marker actor/globalcontract chung và persisted requestKey. Positive UUID giữ trước read; exact core + request event/org/operation/notice/date/room/money mới báo số HĐ/ngày/phòng và gọi success. Unknown/partial không gửi lại sau remount/org switch. Ba export legacy nhượng/thanh lý trong useContractOperations definition-only ghi unused theo rg. | Hook10 RED→GREEN + RenewDialog1 + SQL adapter6; chưa E2E, TSC/build cuối do root. |
| B17 | Thanh lý rời phòng chỉ báo đã thanh lý, không khẳng định đã hoàn/thu tiền; bỏ cọc giữ diễn giải bút toán nội bộ từ writer. Sửa người nhận trên phiếu thanh lý không còn hiện raw RPC message; lỗi giữ draft và yêu cầu đối chiếu trước duyệt/chi. | `SettlementLifecycleModal.test.tsx` hai DOM case lưu lỗi/giữ draft pass; chưa có test server payment-state riêng. |
| B18 | Bước quyết toán chặn khi truy vấn hóa đơn còn nợ hoặc credit đang tải/lỗi/không có dữ liệu. RPC credit trả null/malformed nay thành query error; số 0 thật giữ nguyên. | `TerminateDialog.workflow.test.tsx` và `contractCreditBalance.test.ts` pass. Chưa E2E lỗi nguồn dữ liệu thật. |
| B19 | Nội dung thanh lý và lý do đổi loại thiếu được báo đỏ ngay ô; nút tiếp tục vẫn bị chặn. | Workflow test pass; chưa kiểm bằng browser thật. |
| B20 | In DOCX, tạo/copy/tải QR, copy link bắt lỗi với mô tả an toàn; chỉ báo file đã chuẩn bị để tải. Clipboard được `await`; copy QR ở danh sách và xuất Excel cũng không hiện `error.message` thô. | `PrintContractDraftDialog.test.tsx` pass; chưa E2E quyền clipboard/download. |
| B21 | Luồng live `ContractImportExportDialog` giữ dòng Excel nguồn thật, stage/IDs/hash qua đóng/reload; unknown/absence/read-denied không cho nhập lại. Recovery chỉ gửi dòng rejected chắc chắn sau exact core/relations/room/customer read; dòng completed không INSERT lần hai. `useBulkCreateContracts` deprecated definition-only ghi unused. | SourceRows2 + actual DOM remount2 RED→GREEN + workflow6; typed adapter focused10/10 và hai mutation đỏ/khôi phục. Chưa E2E file thật/server. |

Nguồn bắt buộc khi lập HĐ: form giữ trạng thái query tòa/phòng/dịch vụ mặc định/sổ nhận cọc; nếu nguồn liên quan lỗi hoặc chưa tải xong thì giữ nháp, hiện nút tải lại từng nguồn và khóa lưu/ký/cập nhật. Xem trước hóa đơn báo dữ liệu chưa đầy đủ, không nói tòa “chưa cấu hình” khi dịch vụ lỗi. Hook nguồn chặn response null thay vì giả danh sách rỗng. `useContractFormState.draft.test.tsx` 4 pass, `useContractSubmit.test.ts` 14 pass, `contractSourceQueries.test.ts` 3 pass. Chưa kiểm UI trình duyệt thật; nguồn khách/phiếu cọc phụ còn cần rà E2E từng quyền.

Lệnh xác minh đã chạy:

- `npx vitest run src/lib/__tests__/contractBillingBounds.test.ts src/lib/__tests__/contractFeedback.test.ts src/lib/__tests__/contractImportOutcome.test.ts src/components/contracts/contract-form/useContractSubmit.test.ts src/components/contracts/__tests__/TerminateDialog.workflow.test.tsx src/components/contracts/__tests__/PrintContractDraftDialog.test.tsx` — 42 pass sau các test thêm.
- `npx vitest run src/lib/__tests__/contractInvoiceFeedback.test.ts src/lib/__tests__/contractCreditBalance.test.ts` — 10 pass.
- `npx vitest run src/components/contracts/contract-form/useContractSubmit.focus.test.ts` — 2 pass.
- `npx vitest run src/hooks/__tests__/useCreateContractInvalidation.test.tsx src/components/contracts/contract-form/useContractFormState.draft.test.tsx src/components/contracts/contract-form/GeneralSection.asyncSelect.test.tsx src/components/contracts/__tests__/ContractDraftFormDialog.selection.test.tsx` — 16 pass.
- `npx tsc --noEmit -p tsconfig.app.json` — sau B08/B13/B18 không báo lỗi slice B; bị chặn bởi 3 lỗi `getByRole(..., { exact })` ở `IncomeExpensePostingDialog.test.tsx:324,342,344` thuộc slice C đang sửa đồng thời (đã báo chủ sở hữu).
- `npm run build` — dừng ở `src/components/tasks/TaskCreateDialog.tsx:315` do thẻ `QueryRegion` đóng sai trong slice G đang được sửa đồng thời; chưa xác minh build cuối.

Chưa chạy E2E headless, bundle check và gate trước push; root tích hợp sẽ làm theo Contract §8. Không thay đổi quy tắc tiền/RPC/backend.

## B15 durable edit — chốt 30/09/2026

`contractEditWorkflow.ts` lưu intent core/khách/dịch vụ và phase trước từng writer theo actor + contractID. Core update cần exact ID + fields; receipt null không saved. Recovery đọc exact core và cả hai quan hệ trước tiếp tục, dùng org thật đọc từ contract để insert, không selector sau reload. Chỉ known SQL rejection sau DELETE được xác nhận + đọc lại empty mới tiếp tục INSERT thiếu; unknown DELETE/INSERT mismatch hoặc desired-empty không tự replay/clear bằng absence. Read denial sau write done không thành rollback. Mọi phần chỉ xong sau final authoritative core+relations; thay đổi form sau partial cần lưu lượt sau.

Form hydrate job/ID từ localStorage sau reload và khi mở lại; loading/readback khóa nút xuyên suốt. Nút kiểm tra intent đã gửi có thể dùng khi checkbox nợ cọc chưa hydrate, còn lượt cập nhật mới vẫn giữ rule xác nhận nợ cọc. Không sửa deposit_paid derived, không đổi backend DELETE/INSERT thành transaction giả. Known rejection đầu core zero-write giải phóng intent để sửa form; unknown giữ marker/draft.

`.superpowers/sdd/plan/tmp-b15-focused-final.json`: **7 file,51/51** assertion gồm controller14, hook writer8, submit/focus/draft-remount, footer2 và create-invalidation regression. RED additional: known-zero-write không cho sửa intent mới và unknown-delete desired-empty bị clear, đều GREEN sau sửa. Đột biến guard unknown relation replay `e68d7f625ee7 → c57d634e6843 → khôi phục e68d7f625ee7`, helper exit0/suite đỏ đúng “unknown insert + authoritative empty”. Lượt này trước conservative-empty fix, digest historical ghi đúng source đã kiểm. E2E race theo role/browser thật và TS/build tích hợp cuối do root quản lý chưa claim ở nhóm này.

## B14 / ký từ nháp — chốt 30/09/2026

`useCreateContract` giữ pending theo actor + globally unique room ID, backend tiếp tục suy tổ chức và authorize theo phòng. Namespace actor ngăn đổi org selector vượt marker mà không đổi quyền tạo. Khoá RPC chính là progress.requestKey đã persist; request chuẩn bị lại không sinh writer thứ hai sau unknown. ID hợp đồng được lưu ngay khi có positive response, rồi boundary xác nhận đúng room/status/money. Known SQL rollback zero-write cho sửa rồi gửi lại. Toast thành công chỉ nói hợp đồng đã tạo; room-name lookup best effort sau commit không làm writer thành failure.

Ký dùng khoá gửi persist theo org/draft trước RPC, DTO và exact artifact source/revision được validate. `signingErrorMessage` không trả raw Error.message và không mời retry mù. Marker hydrate khóa dialog sau remount; null/wrong request_key read không clear. `mutateAsync(undefined)` là nhánh đối chiếu đọc, không gọi sign RPC; chỉ exact pending requestKey + actual signing ID/org/draft mới clear. Snapshot matching key có thể kích hoạt read-only đối chiếu rồi tiếp tục callback một lần. Tải DOCX vẫn chỉ tạo/adopt đúng immutable artifact của signing đã ghi nhận, lỗi render không ký lại.

`.superpowers/sdd/plan/tmp-contract-durable-final.json`: **12 file,93/93** assertion sau source ổn, gồm B14/B15/hooks/DOM/core/cache/doc regressions. Tạo actor scope mutation: `d6ebbdee64b8 → f0f0bf035a66 → khôi phục d6ebbdee64b8`; signing wrong-key gate: `6d34f038acec → 70eb0767f5c3 → khôi phục 6d34f038acec`, mỗi helper exit0/suite đỏ đúng assertion. Digests là source trước khi khôi phục newline LF theo HEAD; nội dung logic không đổi ở lượt normalize. E2E signing/create/recovery theo role/browser và TS/build tích hợp do root quản lý chưa claim ở nhóm này. Không SQL/rules/live writes/stage/commit/push.

## Chốt receipt sau review độc lập B14–B16

Review copilot chỉ ra create receipt money sai và service receipt null/false/blank bị Number→0. Đã đóng2+3 RED→GREEN: create so rent/deposit với request ở **scale numeric(15,2) thực tế**, service required unit_price qua financialReadNumber. contractMoneyReceipt dùng decimal digits/BigInt để giữ SQL decimal tie away-from-zero; PGlite chứng minh0.145→0.15 và-0.145→-0.15, không reject giá server làm tròn hợp lệ. Numeric precision suite14.

Signing positive path được trả request_id cũ khi cùng intent: SQL20260929010015:291–298 kiểm intent_hash toàn nội dung rồi trả signing theo draft_id; request_id không thuộc hash. Regression oldkey1 bổ sung, signing durable7. Unknown/read-only recovery vẫn chỉ clear theo đúng pending requestKey; không dùng signing cũ giải phóng marker unknown khác.

Final bổ sung: **73/73, 9 file**, `.superpowers/sdd/plan/tmp-contract-receipt-cross-review-final.json`. B16 hook10 RED→GREEN đòi receipt/readback, giữ contractID khi read bị từ chối; callback success không chạy sau lỗi nên draft còn. Không thêm writer/backend hoặc đổi nghiệp vụ báo dọn/gia hạn/chuyển phòng.

Mutation receipt/money đỏ đúng ca và restore (helper exit0): contractMoney e81b669cd2e2→785d22908ca7→e81b669cd2e2; services75dd0fc3089f→e954563c2648→75dd0fc3089f; B16 date2ccd17420377→97541008dcfc→2ccd17420377. Ledger contracts-edit-feedback-decisions.json hiện 51 current AST calls: 37 fixed, 4 background-only, 1 already-correct, 9 unused. Quyết định theo từng call/owner đã đọc, không completion cả file useContracts.

Nguồn ổn định sau restore; TSC/build/gate tiền cuối do root. Chưa E2E đa vai trò, stale/race backend thật và download/storage/Excel thật.

## Chốt source và ledger trước tích hợp main (30/09/2026)

Nguồn B14–B21 đã đóng các finding được giao. Followup commission giữ reason/draft, blank reason đỏ/ref/focus và chỉ panel sở hữu safe inline failure; hook `handlesFeedback` tránh global duplicate. Quy tắc hoa hồng/RPC không đổi. Commission + QuickDeposit + provider ownership + business regressions: `.superpowers/sdd/plan/commission-quick-deposit-feedback-final.json`, **45/45 ở 5 file**, trước đó **8 failure RED thật**. Tích hợp feature retry hoa hồng mới của main do root xử lý khi rebase.

B21 giữ `source_row` đúng worksheet sau header ở dòng0/3, dòng trống và dòng rejected. Snapshot chỉ lưu hash intent, row/stage/IDs; marker actor/org giữ batch unknown, không lưu tên/số điện thoại/ghi chú. Existing completed contract IDs được đọc exact trước correction và không INSERT lại; customer vừa tạo được kiểm đúng org/phone trước reuse. Thiếu/không đọc được bản ghi không chứng minh rollback. `public_code` vẫn omitted theo BEFORE INSERT trigger `20260530000003`; generated Insert adapter được thu hẹp, không sinh code phía client. `payment_cycle` chỉ narrow enum đã validate ở parser, payload/fallback không đổi.

B21 source/DOM/workflow focused cuối sau adapter: `.superpowers/sdd/plan/contract-import-typed-cycle-final.json`, **3 file,10/10**, exit0. App TSC tại `.superpowers/sdd/plan/finance-import-typed-adapter-app.txt` exit0/report rỗng trước D16 và rebase. Hai mutation trong `contract-import-mutation-evidence.json`: unknown-replay `2cb87e090526→086c5b2ae722→restore2cb87e090526`; bỏ skip completed ID `2cb87e090526→ff3e602c3ec0→restore2cb87e090526`. Cả hai helper exit0, suite đỏ đúng writer count/duplicate positive ID; final restored10/10. Đây là khóa frontend cho backend chưa có retry key, không phải transaction mới.

Root đóng B17 duplicate modal cancel success (child là owner); `.superpowers/sdd/plan/late-import-owner-green.json` **88/88,5 file**. Finding B18/C27 `typeMap data??[]` đã chuyển required `financialReadRows` và inline metadata; `.superpowers/sdd/plan/settlement-types-red-2.json` **1 RED thật** → `settlement-types-green.json` **69/69**. Source ID mới đã refresh, không giữ gap đã đóng.

Ledger `contracts-edit-feedback-decisions.json` hiện **113 current AST call**, gồm **73 fixed /15 already-correct /11 background-only /14 unused**, không implementation-gap đã xác định. Quyết định mới dựa các owner đọc độc lập: paged/stat/dashboard/delete/legacy/unpaid, nháp/API, transfer-link, settlement nguồn và từng feedback của in/QR/import. Deprecated pending terminations/bulk và ba operation exports không caller live vẫn unused; không nhận là đã sửa nghiệp vụ không reachable. Ledger không completion toàn `useContracts.ts`.

`plan-finance-status.json` ghi đủ **60 mục B14–B21/C01–C28/D01–D17/E16–E20/I05–I06**, source files/callIds/evidence/giới hạn theo từng mục; phần root/agent khác merge từ ledger riêng. Browser E2E theo vai trò, race đa cửa sổ, Clipboard/Storage/download thật và gate tiền live chưa xác minh. TSC strict/build/full suite/gate sau rebase do root, không coi focused hay app check trước rebase là gate cuối.

## Sau giải tay conflict commission main45149b9b

Giữ main prepare ALL selected intents trước execute, saved-request retry exactcontract/kind/key, manager_id lưu trong intent/không client assignment, onlyKind legacy và query key kind/search/period. Main bỏ decision UI cũ; không phục hồi Không phát sinh/Lưu quyết định từ nhánh task. Test của UI cũ được adapt sang luồng live savedretry, không hạ assertions bảo vệ ID/unknown. Chỉ port strict read/oneowner safe error/receipt links/raw guard/QL ref-focus. Wrapper runFinancialPending cũ không phủ luồng retry backend đã có key bền vững.

`.superpowers/sdd/plan/commission-rebase-focused.json`: **5 file70/70 exit0**, toàn bộ maintests giữ,6 feedback case mới và actual QueryProvider savedretry owner. Sáu conflict + đúng1 provider fixture đã stage, không rebasecontinue. Ledger current commission có17 calls finance/4 calls contracts được đọc lại theo enclosing conditions; finance453,contracts115 tổng, old signatures đúng4file đã gỡ. Gate app/full/strict/lint/build sau rebase do root và reviewer chạy độc lập; E2E/liveRPC chưa kiểm.
