# Hoá đơn, cọc, phí và báo cáo tài chính

Triển khai nhánh `codex/thong-bao-nguoi-dung`; chỉ mã frontend, không SQL hoặc dữ liệu thật. Bảng này mô tả mã hiện có và giới hạn kiểm chứng. Chưa E2E Preview theo vai trò/desktop/mobile, chưa gate tiền/build cuối. Review độc lập đang do agent contracts thực hiện, các findings đã sửa được ghi bên dưới.

## D01–D17

| ID | Trước → sau | Địa điểm chính | Bằng chứng / giới hạn |
|---|---|---|---|
| D01 | Tạo/sửa báo chung, legacy header/items lỗi dễ tạo lại; form không focus → receipt có mã; InvoicePartialError giữ invoiceId/bước đã ghi; GenerateInvoice giữ draft/link và khóa tạo lại; ô chung desktop/mobile đỏ, thông báo sát ô và focus | useInvoices.ts; invoiceFeedback.ts; GenerateInvoiceDialog; EditInvoiceDialog; invoice-entry/* | invoiceFeedback3; InvoiceEntry.feedback2 DOM; insertGuiOrganizationId28; EditInvoiceDialog snapshot đạt. Cần E2E duplicate/legacy fallback/server field mapping từng RPC |
| D02 | SQL unique index lộ kỹ thuật → hợp đồng đã có hoá đơn kỳ này, mở hoá đơn hiện có/chọn kỳ khác; kiểm tra trùng lỗi không cho tiếp | invoiceFeedback.ts; GenerateInvoiceDialog | exact rule nguồn index, query trước tạo giữ raw error. Chưa DOM duplicate live |
| D03 | Duyệt/bỏ/hủy/khôi phục tự đoán state → feedback theo invoice/status/noop; thiếu state đọc lại; timeout khóa invoice ID đến khi đối chiếu. Bulk hủy có completedIds/failure ID/lý do/unknown, không báo tất cả thành công | useInvoices.ts; InvoicesPage; invoiceFeedback | helper3 và hooks cũ; cần DOM từng lifecycle. Không đổi writer/fallback tiền |
| D04 | Ghi chỉ số lỗi chung/console → tiếng Việt theo thao tác; tạo hoá đơn nhận biết chỉ số đã ghi nhưng hoá đơn lỗi hoặc ngược lại | useInvoices; GenerateInvoiceDialog; useExcelInvoiceData | Excel partial3; ghi riêng/bulk lỗi được phản hồi. Form MeterReading thuộc slice F |
| D05 | Thu xong mô tả chung/đoán nợ0 → biên nhận V5 collection_id/invoice_id bắt buộc, applied_amount và remaining từ máy chủ; thiếu remaining yêu cầu tải lại | collectionFeedback; useInvoicePayments | collectionFeedback, collectionActualChange6. Đối chiếu SQL 20260721100000_invoice_collection_v5.sql:1433–1443 |
| D06 | Tiền/sổ nhận/sổ thối toast hoặc nút im → errors từng dòng, aria-invalid/focus; giữ draft/khóa khi unknown | RecordPaymentDialog; BulkRecordPaymentDialog; collectionFeedback | RecordPayment.feedback3; bulk receiving/permission suites. Server field mapping không tự đoán chỉ theo SQLSTATE |
| D07 | “credit/không hợp đồng” kỹ thuật → hoá đơn chưa gắn hợp đồng nên không thể giữ tiền dư kỳ sau | collectionFeedback | exact hai local validation reasons; nguyên tắc tiền giữ nguyên |
| D08 | Không kiểm tra được gần đây vẫn mời thu tiếp → inline báo chưa đối chiếu, chặn request tiền | RecordPaymentDialog; BulkRecordPaymentDialog | DOM single/bulk precheck regression; không có nút “Vẫn thu tiếp” ở nhánh lỗi đọc |
| D09 | Bulk báo đếm chung và có thể chọn lại dòng đã thu → giữ invoiceId/lý do từng dòng, unknown và thành công khóa khỏi vòng gửi sau; lỗi storage trước giao dịch dừng an toàn | useBulkRecordPayment; BulkRecordPaymentDialog | bulk receiving/permissions + collectionActualChange; cần E2E partial nhiều invoice |
| D10 | Excel tạo hoá đơn và chỉ số partial khó đối chiếu → từng phòng giữ invoiceId, readingSaved, error, outcomeUnknown; khóa khoá kỳ+hợp đồng đã ghi; một kết quả tổng, giữ dialog | useExcelInvoiceData; ExcelInvoiceDialog | useSubmitExcelInvoices.feedback3, insertGui; InvoicePartialError legacy giữ ID trong result. Cần E2E file Excel |
| D11 | Lập yêu cầu hoàn tiền báo như đã chi → đọc refundVoucherId thực, phân biệt chờ duyệt/đã ghi sổ; form ngày/tiền/sổ focus, unknown giữ form khóa | useInvoicePayments; RecordRefundDialog; createdVoucherReceipt | createdVoucherReceipt4; RecordRefund.feedback5 DOM giữ invalid raw/date/focus/partial, durable writers giữ refund ID/requestKey qua reload |
| D12 | CRUD cọc raw Error.message → reservationErrorMessage theo reason đã xác minh, giữ raw mã lỗi; schema response tạo/sửa malformed là unknown | useDeposits; reservationIdentityRpc | reservationIdentityRpc suite; query summary malformed regression |
| D13 | Cọc đã tạo nhưng kỳ hạn/thưởng lỗi báo thất bại chung → lưu reservationId/phiếu cọc/phiếu thưởng, thông báo bước thiếu, liên kết và khóa tạo cọc lại | CreateDepositDialog; useRoomReservations; useReservationHoldDeadlines; useSaleBonus | CreateDeposit.feedback8 DOM gồm partial receipt IDs và invalid -10/abc2/1.5 không writer. silent child hooks tránh toast thành công rải rác |
| D14 | Xử lý/hoàn cọc lỗi số tiền/ngày/sổ không vào ô → validation tiếng Việt, đỏ/focus, giữ form/unknown guard | ReservationSettlementDialog; ReservationRefundDialog; reservationSettlementForm/Rpc | ReservationSettlementDialogs13, RPC tests; lỗi gốc không bị bọc mất code |
| D15 | Danh mục sổ lỗi nhìn như không có sổ → retry riêng, khóa hoàn/xử lý khi thiếu nguồn | hai dialog cọc; PendingRefundList; SettlementDetails; CreateDepositDialog | 3 DOM regression trong suite13, query phòng/sổ CreateDeposit đã nhận full query |
| D16 | Kỳ hạn giữ chỗ ô số/ngày đỏ/ref/focus; manual save chặn shared invalid draft trước writer, giữ ngày raw31/02 và không dùng state cũ. Nhánh bỏ hết kỳ hạn vẫn gửi null chủ ý. | HoldDeadlineDialog; useReservationHoldDeadlines | DOM4 mới, 3 RED→GREEN (hai ngày stale + tiền âm→null); focused3files25/25. Chưa browser E2E |
| D17 | Hoa hồng broker tạo xong, Sale/QL lỗi mất ID và success giả → giữ completedKinds/receipt IDs, chỉ cho bước chưa tạo tiếp khi known failure; unknown khóa; QL assign thiếu báo partial | CommissionVoucherModal; useCommissionVoucher/Manager; contractCommissionFollowup; useSaleBonus | Commission9 DOM gồm partial timeout. SaleBonus status và created response malformed chặn, financialReadFeedback17. Thiếu QL trên modal vẫn cần kiểm E2E focus selector |

## E16–E20 và E05 đối soát

| ID | Trước → sau | Địa điểm chính | Bằng chứng / giới hạn |
|---|---|---|---|
| E16 | Tạo phiếu điện/nước/phí luôn “đã chi” → readCreatedVoucherReceipt(id/code/approval/posting), chỉ POSTED mới nói ghi chi; readback lỗi giữ ID/unknown; phiếu nháp chưa POSTED không tự đóng như đã chi | useUtilityBills, usePeriodFees, useUtilityPayState, usePeriodFeeState; createdVoucherReceipt | helper4; đối chiếu status thật chưa E2E vai trò/quorum |
| E17 | Đồng hồ/ảnh/phí raw hoặc im → lỗi theo thao tác, tên ảnh, giữ draft; số tiền0 bấm thấy đỏ/focus cùng dòng ở desktop/mobile; sửa phiếu có amount/kỳ validation | UtilityEnContent; PeriodFeePanel/Sheet/EditModal; useUtilityPayState/usePeriodFeeState | PeriodFeeDeferred13 đạt, NaN/Infinity ở manual handler không RPC; FixedFees.feedback5 DOM giữ raw invalid/focus. Upload/browser vẫn chưa E2E |
| E18 | Lưu dự kiến/bật áp dụng không onError → lỗi rõ, trạng thái điều khiển từ kết quả máy chủ không lật lạc quan khi lỗi | usePeriodFeeState; usePeriodFees | code review, PeriodFeeDeferred; query trạng thái paid/draft malformed không thành chưa đóng |
| E19 | Sinh0 phiếu success/phiếu tổng lọc bỏ dòng dở → no-op info; receipt sinh phí bắt buộc số lượng/IDs; partial giữ link/khóa tạo lại; bảo trì validate toàn bộ dòng trước gửi, một tổng kết | SpecialFeeBatchDialog; PeriodFeePanel/Sheet; useSpecialFeeBatch; useMaintenanceBatch; batch.ts silent option | feeFeedback5; PeriodFeeDeferred11; C batch regressions. Cần DOM full SpecialFee/maintenance và E2E |
| E20 | Giá công bố lỗi chung, số/ngày thiếu không vào ô → field amount/month + focus, lỗi theo phí; config/query lỗi không hiện giá rỗng | FixedFeesPage; useFeeConfigMatrix/useSpecialFeePrices; feeFeedback | Phần FixedFees đã triển khai; **SpendEnginePage/useSpendEngine và quy tắc/trần còn giao root/agent khác, không đánh dấu hoàn tất toàn ID** |
| E05 | Đối soát trống bị Number(..)||0, raw response cast + local unknown mất khi đóng → số thực tế bắt buộc (0 hợp lệ), focus; receipt id/status/diff số thật; unknown giữ khóa account+ngày qua đóng/mở dialog; chờ xác nhận khác đã chốt | BanGiaoReport/ReconcileDialog; useReconciliations | reconciliationFeedback3 (2 đỏ→xanh); confirm/cancel hiện không có caller nhưng đã validate trạng thái/ID. Cần DOM/E2E |

E01–E15 thuộc root/audit_other; E21–E23 thuộc contracts. Không gộp trạng thái hoàn tất của các phần đó vào tài liệu này.

## I05–I10 và danh mục liên quan

| ID | Trước → sau | Địa điểm | Kiểm chứng |
|---|---|---|---|
| I05 | Thu chi list/stats/batch lỗi có vẻ rỗng → QueryRegion theo nguồn; detail batch tải mới/đủ nguồn mới mở | IncomeExpensePage/Mobile; query hooks; BatchDetail desktop/mobile | C tests27files208 trước sửa cuối; BatchDetailRead2; C24 thêm reason/partial dialog2 |
| I06 | Hóa đơn/cọc desktop/mobile stats/fetch lỗi có thể hiện0 → full query state, label/retry, chặn khối phụ thuộc; tổng cọc malformed không zero | InvoicesPage/InvoicesMobile/InvoiceStatsSummary; DepositsPage/Mobile; useDeposits | QueryRegion shared đã test; financialReadFeedback17. Deposits desktop chặn cả body phụ thuộc; chưa chia nhỏ mỗi card độc lập |
| I07 | In biên bản chạy trước query phụ; query in lỗi thành notfound; lịch sử thối/thu phụ lỗi thiếu nguồn → chặn in và kết quả khi thiếu nguồn, retry; khóa hoàn tác khi eligibility chưa xác minh; lý do đỏ/focus | CashbookClosureRecord; InvoicePrintPage; ChangeBreakdownDialog; PaymentsSummaryDialog; useDeletePayment | ClosureRecord.feedback2 đỏ→xanh; DeletePayment9; PaymentsSummary.feedback7 DOM fail-closed nguồn phụ/receipt/undo; invoiceRelatedRead8 bắt required arrays/money |
| I08 | Phần lợi nhuận/cổ đông/lương | root/audit_other | Không thuộc claim của tài liệu này |
| I09 | Tổng/list lịch thu/dư/cọc/sổ/dòng tiền/bàn giao lỗi trộn empty → QueryRegion đầy đủ query + bộ lọc nguồn, không xuất số thiếu | PaymentScheduleReport; OverpaymentReport; DepositsReport; CashFlowReport; DailyCashbookReport; BanGiaoReport/BanGiaoCycleReport; financeReports.ts | 5 finance report hooks inline meta; summaryNumber strict. Chưa E2E export/chart từng trang |
| I10 | Tab phân tích lỗi một nguồn vẫn tính0 → chặn tab cần nguồn đó; toàn bộ số bắt buộc null/empty/malformed và RPC null throw thay vì0/[]; 0 thật hợp lệ | finance-analysis Overview/Operations/Profit/Expense/TypeBreakdown (Revenue dùng TypeBreakdown); FinancialAnalysisReport; useFinancialAnalysis; financialReadValidation | financialReadFeedback17; 2 malformed hook tests đỏ→xanh. Hiện chặn cả tab khi nguồn cần lỗi, chưa chia mỗi chart độc lập |
| I14 | Danh mục dùng cho form lỗi bị [] → query full và khóa submit trước giao dịch | GenerateInvoice, CreateDeposit, Reservation dialogs, batch detail, Commission checking | Bổ sung kiểm lỗi computePreviousDebt/getContractDiscountSlot, công tơ/chỉ số, duplicate invoice; chưa E2E tất cả selector |

## Lượt kiểm thử và phần chưa xác minh

- Dải cục bộ đầu: 98 assertion đạt; 1 suite load lỗi do đường import component đã sửa. Commission/Reservation/PeriodFee sau sửa import: 33/33 đạt.
- InvoiceEntry.feedback + ChangeCollectionMethodDialog: 11/11; kiểm focus từng dòng cả desktop/mobile và thiếu lý do.
- collectionActualChange6 + PeriodFeeDeferred11: 17/17 sau sửa mock receipt V5 đúng SQL và thông báo sổ TM/TK/TT.
- financialReadFeedback17: malformed report/deposit/fee/SaleBonus không biến thành số0 hoặc chưa thưởng.
- InvoiceFeedback3; Excel partial3; reconciliation3; closure print2; BatchReason2, BatchDetailRead2 đã chạy đạt tại từng lượt.
- Root đang fullsrc Vitest/typecheck; không coi kết quả lượt cũ là gate cuối. Chưa build/gate nghiệp vụ/E2E. Không staging/commit/push.
- CreateDeposit partial (8), refund (5), PaymentsSummary (7), FixedFees (5) và upload payment receipt partial hooks (2 đỏ→xanh) đã có regression. Hold deadline DOM riêng, receipt state theo vai trò, Storage/file/export thật chưa kiểm. Review độc lập tiếp tục và sẽ có ghi nhận sửa finding.

## Chốt source/test residual finance (30/09/2026)

`finance-feedback-decisions.json` ghi từng call hiện tại, gồm fixed/already-correct/background-only/unused và implementation-gap còn đang giao root. Legacy `usePayments`, `usePayment`, `useCreatePayment`, `usePaymentsSummary` chỉ có định nghĩa theo non-test rg callers; toast generic/raw của chúng ghi unused, không tự nhận là đã sửa. Active `useUploadPaymentReceipt` được dùng ở PaymentsSummary: durable actor/payment ID, uploaded/attached receipt ghi trước bước voucher, exact metadata readback; partial giữ ID qua remount và không upload lần hai.

Invoice lifecycle/refund/reversal cần exact subject ID + state/mode do server trả hoặc exact readback; marker actor/org và requestKey lưu trước writer. Nil/unknown không bị đoán thành rollback. Invoice-related voucher items/payments cần arrays và finite money, QueryRegion nhận lỗi thay tổng 0. Null deposit_target giữ đúng nghĩa null; blank/NaN/Infinity reject. FixedFees và manual period/utility handlers giữ draft invalid, focus và chặn finite-invalid trước writer.

Bằng chứng focused cuối: **118/118** ở `.superpowers/sdd/plan/tmp-finance-final-focused.json`; sau C22 partial known rejection mới, **92/92** ở `.superpowers/sdd/plan/tmp-finance-partial-final.json`. Bộ query `invoicePaymentReadFeedback` **59**, directory **17**, financial read **33**, PaymentsSummary DOM **7**, PeriodFeeDeferredData **13**, RecordRefund DOM **5** và bulkCancelInvoice **4** đạt ở các lượt riêng. Các bộ có trùng nhau, không cộng làm toàn-suite. Đột biến invoice cancellation, voucher receipt và C22 đều suite đỏ đúng gate/hash khôi phục; digest chi tiết nằm trong `vouchers.md`.

E2E Preview theo vai trò/desktop/mobile, quorum, Storage/file Excel/export/print thật chưa kiểm. I08 payout durable và ThuTien/print/closure strict read đã root/agent khác xử lý với source/test evidence được cập nhật ở từng call; thiếu E2E vẫn ghi riêng, không gọi đó là source defect. Typecheck/build/gate tiền và review tích hợp do root quản lý; không tăng TS baseline, không stage/commit/push.

Cập nhật tích hợp root 12:20: ThuTien/print/closure read boundary đã sửa strict exact target/date/array/money, 15 read cases (14 RED→GREEN), nhóm6suites43/43; specialized payout đã dùng persistent requestKey/org binding. Ledger finance refreshed theo source hiện tại và từng call ID, 423 call không còn implementation-gap đã xác định. Giới hạn E2E vẫn giữ, không gọi nó là lỗi implementation còn lại.

Review độc lập root I08/receiving/threshold đã chốt ở [finance-independent-review.md](finance-independent-review.md):121/121 focused,20 RED→GREEN cho 6 boundary; không đổi default nullable cấu hình hoặc SQL/rules. Finance ledger 423 call/66 file đối chiếu AST nguồn cuối:0 stale/missing ID, chỉ cập nhật1 số dòng. B14–B16 ledger riêng 51 call; không gộp completion theo filename. Gate tích hợp cuối do root.

## Inventory và source cuối trước rebase main (30/09/2026)

`finance-feedback-decisions.json` hiện **446 current AST call**, **358 fixed /16 already-correct /40 background-only /32 unused**; exact checker **0 stale/missing,0 shifted**. Bổ sung từng call đã đọc ở PeriodFeePanel/Sheet/SpecialFeeBatch, reservation feedback owner, CollectDrawer6 và reconciliations3; không đánh hoàn tất file. Confirm/cancel reconciliation non-test source chỉ có định nghĩa nên unused dù receipt boundary có validate, không claim live durable recovery hai hook đó.

QuickDeposit dùng silent reservation child và safe inline owner, bốn trường thiếu hiện đỏ/ref/focus. CurrencyInput giữ raw âm/chữ/số lẻ, validator manual chặn writer; hold deadline/customer/book source không mất draft. Commission followup safe inline permission/transport failure, required reason click validation và hook metadata one-owner. `.superpowers/sdd/plan/commission-quick-deposit-feedback-final.json`: **45/45 ở5file**, **8 RED→GREEN**.

D16 sau rà source phát hiện ngày invalid còn giữ state hợp lệ cũ và tiền âm bị Number(v)||0 thànhnull. Chỉ thêm `validateInputDrafts(root.current)` ở manual save `!xoaHet`; clear-all giữ chính xác thao tác gửi null. `.superpowers/sdd/plan/hold-deadline-input-red-2.json`: **3 failure thật/1 pass**; `hold-deadline-input-final.json`: **25/25 ở3file**, gồm DOM4 mới/CreateDeposit8/ReservationSettlement13. Những lượt fixture matcher thiếu dependency được giữ report, không dùng làm evidence nghiệp vụ; final dùng native DOM value/aria/activeElement assertions.

Các mục C/D/E16–E20/I05–I06 có callIds và source/test descriptor riêng trong `plan-finance-status.json`; Spend/quy tắc/trần/salary/payout/ThuTien related source giữ root/other evidence, không mở rộng claim theo tên file. Focused finance118 và partial92 là lượt cũ có report, không cộng với focused mới để gọi toàn bộ suite. Root giải rebase và chạy lại app/strict/fullsrc/build/gates trên source tích hợp. Chưa E2E TEST/DEMO theo role/mobile/desktop, SQL/RLS concurrency/live money, upload/print/export thật. Không đổi RPC/rules/backend hay ghi dữ liệu thật trong lượt này.
