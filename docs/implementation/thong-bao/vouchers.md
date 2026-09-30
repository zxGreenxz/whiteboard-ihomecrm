# Phiếu thu chi — C01–C28

Triển khai trong worktree `codex/thong-bao-nguoi-dung`, không sửa SQL, không gọi dữ liệu nghiệp vụ, không stage/commit/push. Nguồn phạm vi: `plan.md`. Các trạng thái dưới đây nói về mã và kiểm thử cục bộ; **chưa xác minh E2E Preview theo vai trò/desktop/mobile**, chưa chạy gate tiền/build cuối cùng của toàn nhánh.

## Quy ước bằng chứng

- **F**: `src/lib/voucherFeedback.ts`, `voucherErrorRules.ts`, `src/lib/__tests__/voucherFeedback.test.ts`.
- **H**: `src/hooks/income-expenses/__tests__/voucherFeedbackHooks.test.ts`; test hooks bắt raw error/timeout, trạng thái, biên nhận partial và no-op.
- **DOM**: `IncomeExpenseFormRevise.test.tsx`, `IncomeExpenseBatchValidation.test.tsx`, `IncomeExpensePostingDialog.test.tsx` trong `src/components/income-expenses/__tests__/`.
- **P**: `src/pages/payments/IncomeExpensePage.tsx`, `IncomeExpenseMobilePage.tsx`, `src/pages/approvals/ApprovalsPage.tsx`.
- **Q**: `queries.ts`, `financeV2Mutations.ts` trong `src/hooks/income-expenses/`, `useCustodianCashbooksV2.test.tsx`; UI dùng `QueryRegion` chung.

| ID | Trước → sau | Mã/bằng chứng | Trạng thái và phần còn xác minh |
|---|---|---|---|
| C01 | Tạo phiếu báo chung đã thu/chi → đọc receipt: chờ duyệt/chưa ghi thu chi/POSTED; thiếu receipt báo chưa xác nhận | mutations.ts, F, H | Đã triển khai; chờ E2E tạo theo role/route |
| C02 | RPC toast rồi console, transport có thể im → một onError; giữ draft; timeout/receipt thiếu khóa gửi lại đến khi đối chiếu | mutations.ts, IncomeExpenseForm/BatchForm, H/DOM | Đã triển khai luồng phiếu; QL hoa hồng sau revise thuộc D17 còn làm tiếp |
| C03 | Tòa nhà báo căn hộ, Sổ quỹ báo tài khoản; select bỏ qua focus → đúng “Chọn toà nhà cho phiếu.” / “Chọn sổ quỹ ghi nhận phiếu.” / “Chọn ngày trên phiếu.”; focus control đầu | incomeExpenseValidation.ts, Form, shared formErrors; DOM đỏ→xanh | Đã kiểm DOM; server field mapping chưa nối mọi rule vào form.setError |
| C04 | Ô giá/ngày từng dòng chỉ toast hoặc không thấy → aria-invalid, viền đỏ, thông báo sát ô, name items.N.field, focus theo thứ tự DOM | Form, BatchForm, DOM | Đã kiểm lỗi dòng/ngày và header; chờ mobile thực tế |
| C05 | Lặp hữu hạn có thể 0/thiếu lý do → số nguyên1–240 và thông báo bật Lặp vô hạn nếu cần | incomeExpenseValidation.ts, F 7 biên | Đã kiểm số0/1/240/241/thập phân và vô hạn |
| C06 | Duyệt nói tiền đã đổi → “Đã duyệt phiếu. Chưa ghi nhận thu/chi vào sổ quỹ.” khi receipt APPROVED | financeV2Mutations.ts, statusMutations.ts, F/H | SQL owned dispatcher đã đối chiếu approvalStatus; legacy chỉ nói xem trạng thái |
| C07 | “posting”/lỗi kỹ thuật → “Đã ghi nhận thu/chi vào sổ quỹ.” chỉ khi receipt POSTED | financeV2Mutations.ts, F/H | Thiếu state throw TypeError vào cơ chế unknown; chờ E2E |
| C08 | “atomic” → “Đã duyệt phiếu và ghi nhận thu/chi vào sổ quỹ.” khi POSTED | financeV2Mutations.ts, F | Đã triển khai |
| C09 | Duyệt quorum báo xong → state PENDING_APPROVAL báo info còn bước; APPROVED/POSTED phân biệt | useApprovals.ts, ApprovalsPage, H | Unknown state không đóng như thành công; request khóa sau timeout; chờ E2E quorum |
| C10 | Từ chối/thu hồi tự suy phiếu về nháp → theo REJECTED/CANCELLED/WITHDRAWN; trạng thái lạ yêu cầu tải lại | useApprovals.ts, F | Đã triển khai; cần E2E withdrawal thực tế |
| C11 | Lý do thiếu nút bị khóa im → bấm thấy đỏ và focus, không gửi RPC | Form (revise/KQKD), P (hủy/đổi sổ duyệt/từ chối), DOM | Form revise đã đỏ→xanh; các dialog page cần E2E |
| C12 | approval_version kỹ thuật hoặc mất nháp → “Phiếu vừa được người khác thay đổi…” giữ draft, cần tải lại | incomeExpenseRevision.ts, Form, financeV2Mutations.ts, F + revision tests | Đã triển khai |
| C13 | canonical frozen lộ kỹ thuật → không hỗ trợ bỏ duyệt; kiểm phiếu trước Hủy/Tạo bản sao | statusMutations.ts, F | Đã unit/mã; E2E route |
| C14 | Hoàn tác nói luôn tiền tăng → “Đã hoàn tác lần thu/chi… phiếu chưa bị huỷ.” | financeV2Mutations.ts, P, F | Dialog giữ lỗi/lý do; unknown khóa; E2E INCOME/EXPENSE |
| C15 | Hủy suy chiều số dư → mô tả phiếu hủy và cập nhật sổ quỹ, không tự suy chiều | flexMutations.ts, incomeVoucherCancel.ts, statusMutations.ts, P | Đã triển khai; đọc lại path specialized trong D/E |
| C16 | Reverse xong hoặc hủy xong nhưng payment lỗi báo như chưa làm → VoucherPartialError mang completedIds, mô tả bước đã xong, chặn retry toàn thao tác | statusMutations.ts, P, H 2 ca | Đã đỏ→xanh/giữ receipts |
| C17 | Hủy lại vẫn success → changed:false info không có thay đổi mới | flexMutations.ts, incomeVoucherCancel.ts, statusMutations.ts, H | Đã kiểm |
| C18 | Khôi phục tự đoán trạng thái → exact ID + approval state đọc lại; không đọc được giữ durable unknown, không bấm khôi phục lại | statusMutations.ts readStatusReceipt | financeDurableWriters đã kiểm null/readfail/status lạ và remount lock; DOM/E2E khôi phục riêng chưa kiểm |
| C19 | Bỏ kiểm vẫn “đã kiểm” → readback verified_at; không đọc được thì chặn toggle lại | statusMutations.ts, IncomeExpenseVerifyDialog, H | H đọc state null và readfail đã kiểm; chờ DOM/E2E |
| C20 | Ghi chú/KQKD changed:false success → info; thiếu returned business_result_accounting không tự suy “loại khỏi” | annotateMutations.ts, forfeitKqkd.ts, H | Đã triển khai; bổ sung chứng từ supplements có test riêng hiện có |
| C21 | Tạo0 phiếu định kỳ nói thành công → info không có phiếu mới; positive nói số lượng + kiểm trạng thái | recurring.ts, H | Đã kiểm0; chờ E2E sinh định kỳ |
| C22 | Excel partial mơ hồ → dòng Excel gốc, count, thông báo từng dòng, link IDs/code thành công; không nhập lại dòng đã tạo | batch.ts, IncomeExpenseImportDialog, H | Test timeout và partial known rejection giữ ID/dòng thật sau reload; zero-write known failure cho sửa file; chưa E2E Excel |
| C23 | Phiếu tổng rollback không chắc bị báo thất bại đơn giản → giữ batchId/childIds/count đã hủy, khóa tạo lại batch và link từng receipt | batch.ts, BatchForm, H | Tạo dòng1 rồi dòng2+compensation timeout đã kiểm |
| C24 | Hủy/đổi sổ batch toast rải rác → một tổng kết count/failedIds; payment chỉ xử lý các phiếu hủy thành công; đổi sổ giữ completedIds khi lỗi giữa chừng | batch.ts, P | Hook durable batchID/org, exact per-row receipts + requestKey; tests partial/readfail/remount; browser dialog/E2E chưa kiểm |
| C25 | Intent/finalize raw → tên file và thao tác người dùng; đính/gỡ đã xong nhưng kiểm chứng từ lỗi báo partial, không xóa file đã gắn | financeV2Mutations.ts; postingEvidencePartial.test.tsx 2 đỏ→xanh; PostingDialog DOM | Legacy SettlementLifecycleModal được báo API partial cho agent contracts nối catch/khóa |
| C26 | Thiếu chứng từ không focus → đỏ, role alert và focus nút Thêm chứng từ | PostingDialog, incomeExpensePostingValidation.ts, DOM | Đã kiểm DOM |
| C27 | Access/evidence lỗi → null/[] giả → throw giữ raw code; alert thử tải lại, không cho ghi thu/chi khi thiếu dữ liệu | Q, PostingDialog, Form, P, useCustodianCashbooksV2.test.tsx | List/stat/page đã QueryRegion; chưa rà hết query trong mọi detail component |
| C28 | Yêu cầu user sửa idempotency/version/subject nội bộ → “Chưa tải đủ thông tin… tải lại phiếu”; unknown financial không gợi gửi lại mù | incomeExpensePostingValidation.ts, voucherErrorRules.ts, F | Đã triển khai |

## Kiểm thử đã chạy

- RED trước sửa: nhãn/focus Form; lý do revise; dòng batch; partial đính ảnh rồi adopt fail.
- Lượt toàn nhóm lúc 01:45 giờ máy: `npx vitest run src/hooks/income-expenses src/components/income-expenses src/lib/__tests__/incomeExpenseValidation.property.test.ts src/lib/__tests__/incomeExpensePostingValidation.test.ts src/lib/__tests__/incomeExpenseRevision.test.ts src/lib/__tests__/voucherFeedback.test.ts --reporter=json --outputFile=tmp-vouchers-full-results.json`: **27 file, 208/208 test đạt**. Báo cáo trong temp của worktree, không cần commit.
- Có thay đổi sau lượt này: QueryRegion Approvals + khóa request chưa rõ kết quả; partial revise→approve trên desktop/mobile; các guard malformed response. Phải rerun test/typecheck trước tích hợp.
- `npx tsc --noEmit -p tsconfig.app.json` trước các sửa cuối đã exit0; ba lỗi ByRoleOptions.exact đã gỡ. Root đang chạy typecheck toàn nhánh cho mã cuối.
- Chưa chạy E2E, build, reconcile-money-v1/v2, gate trước push ở nhóm này. Các phép đột biến focused bên dưới đã đạt; không coi đó là gate tích hợp toàn nhánh.

## Giới hạn và giao tiếp liên nhóm

`VoucherPartialError` exported từ `src/lib/voucherFeedback.ts` có `completedIds`, `batchId?`, `cause?`. `useAttachPostingEvidence` / `useRemovePostingAttachment` nay throw lỗi này sau annotate thành công nhưng adopt thất bại, và đã invalidate caches. Agent contracts nhận nhiệm vụ giữ draft/khóa trong SettlementLifecycleModal.

Các hook tài chính còn lại (`specialized.ts`, invoices/payments/deposits/salary/profit/reporting) thuộc D/E, tiếp tục sau C. Chưa coi mọi query con của trang chi tiết thu chi đã được phủ chỉ vì trang danh sách có QueryRegion. Không thay backend/giao thức ghi tiền, không tự retry thao tác chưa xác nhận.

## Bằng chứng chốt residual finance (30/09/2026)

- `.superpowers/sdd/plan/tmp-finance-final-focused.json`: 6 file, **118/118** assertion (durable writers 70, invoice-related read 8, CreateDeposit DOM 8, status business regressions 19, IssuedInvoiceEditor 8, FixedFees DOM 5). Sau đó C22 thêm 2 case, `.superpowers/sdd/plan/tmp-finance-partial-final.json`: 3 file, **92/92** assertion (durable 70, voucher hooks 17, FixedFees 5).
- `invoicePaymentReadFeedback` **59**, `financeDirectoryReadFeedback` **17** và `financialReadFeedback` **33** assertion đạt ở các lượt focused riêng. Không cộng chúng thành số unique toàn nhánh.
- C09/C10 dùng namespace actor theo request ID toàn inbox, giữ quyền multi-org/legacy org null. V2 approve/post inbox dùng target-org thật từ row; metadata frontend được bỏ trước RPC. C15–C19 và specialized cancel dùng chung durable actor namespace theo voucherID; canonical SQL `RETURNS void` chỉ xong sau exact-target readback. Readfail/receipt null không thành rollback.
- C20 KQKD cần exact ID/changed/flag server; C21 recurring cần exact stop receipt hoặc child/parent IDs. Unknown giữ marker; không tự phát lại writer, không thêm retry key giả vào RPC chưa hỗ trợ.
- C22 compat không có backend request key/domain uniqueness: khóa unresolved import theo actor/org và lưu snapshot vị trí dòng thật + IDs/failedRows/unconfirmedRows, không lưu tên người/ghi chú/file. Partial có bất kỳ ID đã tạo giữ khóa qua reload; tất cả rejected chắc chắn và zero-write cho sửa file. Hai dòng giống nhau vẫn có thể là hai phiếu hợp lệ.
- Đột biến `scripts/dot-bien.mjs` bỏ validator cancellation: `3855f326f2e0 → 51b78b881f86 → khôi phục 3855f326f2e0`; bulk invoice predicate: `a602ed602757 → ae8cb73ca2c1 → khôi phục a602ed602757`. C22 current branch bỏ giữ partial: `dcd38fc5e434 → 94af6751f537 → khôi phục dcd38fc5e434`. Mỗi helper exit0, suite đỏ đúng assertion được chỉ định, digest khôi phục.
- `finance-feedback-decisions.json` chốt từng call AST hiện tại (423 call/66 file), kèm owner/dòng/source excerpt + evidence. Không suy cả file hoàn tất. Root đã xử lý specialized payout durable và ThuTien/print/closure read boundary; bằng chứng source/test được cập nhật ở ledger từng call, không còn gap implementation đã xác định trong 423 calls.

Chưa kiểm E2E Preview theo vai trò/desktop/mobile/quorum và file Excel/Storage thật. Root chạy typecheck/build/tích hợp riêng; kết quả focused này không thay các gate đó. Không sửa SQL/quyền/nghiệp vụ, không stage/commit/push.

Cập nhật tích hợp root 12:20: ThuTien/print/closure read boundary đã sửa strict exact target/date/array/money, 15 read cases (14 RED→GREEN), nhóm6suites43/43; specialized payout đã dùng persistent requestKey/org binding. Ledger finance refreshed theo source hiện tại và từng call ID, 423 call không còn implementation-gap đã xác định. Giới hạn E2E vẫn giữ, không gọi nó là lỗi implementation còn lại.

## Chốt owner và call inventory (30/09/2026)

Finance ledger hiện446 exact AST calls (358 fixed,16 already-correct,40 background-only,32 unused), checker0 stale/missing. Mỗi quyết định nêu owner/condition và receipt/partial/query source evidence; C01–C28 mapping nằm `plan-finance-status.json`, không tự completion cả file hoặc mọi detail query. Root đã đóng duplicate success của SettlementLifecycleModal: chỉ child cancel hook phát kết quả; actualDOM RED expected1/got2 → late-import-owner-green88/88. TypeMap nguồn quyết toán không còn null→emptyMap, root69/69 và ID mới refresh.

C22 nguồn nhập phiếu giữ row/IDs/unknown actor-org marker theo evidence92focused và mutation đã ghi ở trên; B21 hợp đồng dùng helper domain riêng trên cùng persistentFinancialWorkflow, không invent uniqueness hay đổi backend atomic. C24 batch một summary theo actual completed/failed IDs, không hủy payment từ phiếu failed. Safe UI partial hiển thị IDs qua reload; một notification owner vẫn cho phép inline draft error. E2E/quorum/SQL concurrency/gate tiền/bundle và full integration sau main rebase thuộc root, chưa xác minh ở agent này.
