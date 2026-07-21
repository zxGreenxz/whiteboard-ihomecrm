# Plan sửa chuỗi hợp đồng - thanh toán - lợi nhuận (2026-07-21)

## Mục tiêu

Sửa xuyên suốt luồng:

`Tạo hợp đồng -> hóa đơn đầu -> thu/đảo tiền -> cọc/credit -> KQKD -> chốt/chia lợi nhuận`

Không vá số tổng ở giao diện. Nguồn đúng phải là bút toán có semantic kế toán rõ ràng,
được ghi trong transaction và có thể đối soát lại từ dữ liệu gốc.

## Invariant bắt buộc

1. Tiền cọc và credit của khách là nợ phải trả, không vào KQKD.
2. Semantic kế toán được snapshot trên từng dòng sổ cái; đổi tên/đổi danh mục sau này
   không làm lịch sử cash và accrual trôi nhau.
3. Một phòng chỉ có tối đa một hợp đồng `ACTIVE`.
4. Tạo hợp đồng, khách thuê, dịch vụ, cọc, hóa đơn đầu và invoice items phải cùng
   thành công hoặc cùng rollback.
5. Một collection thanh toán chứa toàn bộ dòng TM/TK/TT và được ghi atomically.
6. Server tự tính phần doanh thu, cọc, credit, tiền thối và làm tròn; client không
   được gửi bút toán tùy ý.
7. `sum(tender) = applied_to_invoice + returned_change + customer_credit`.
8. Reversal phải đảo đúng account và đúng semantic từng dòng; không hard-delete lịch sử.
9. Lỗi quyền `42501` luôn fail-closed, không được fallback sang writer yếu hơn.
10. Profit close phải thỏa `distributable = allocated + unallocated`; phần chưa phân bổ
    phải hiển thị và có disposition rõ ràng.
11. Legacy change có hai đời dữ liệu: metadata-era lưu `payments.amount` là retained;
    chỉ gross-era còn phiếu chi live tên `Tiền thối hóa đơn...` mới được trừ change.
12. Chi lợi nhuận cổ đông chỉ được dùng sổ tiền thật; cả RPC, trigger sửa nhanh và UI
    đều phải loại `accounts.is_virtual = true`.

## Các tranche triển khai

### T1 - Semantic kế toán và constraint nền

- Thêm `invoice_items.accounting_class`.
- Thêm `income_expense_items.accounting_class` và snapshot từ loại thu/chi lúc ghi.
- Sửa `kqkd_amount`, cash/accrual và recompute cọc dùng snapshot thay vì
  `income_expense_types.is_deposit` hiện tại.
- Thêm unique partial index một hợp đồng `ACTIVE` trên một phòng.
- Backfill các dòng cọc chắc chắn; dòng mơ hồ đưa vào exception queue.

### T2 - Contract create V2

- `create_contract_v2(p_payload jsonb, p_idempotency_key text)`.
- Lock room/hold/voucher; validate organization, customer, service, template, account.
- Bắt buộc đúng một khách đại diện.
- Cọc mồ côi phải truyền ID rõ ràng; không auto-link theo phòng/chuỗi thời gian.
- Server tự tính `deposit_paid`, shortfall và mode `DEBT/FIRST_INVOICE`.
- First invoice được tạo cùng transaction, discount không được ăn vào cọc.
- Billing period được phân bổ theo từng tháng dương lịch; ngày phát hành/hạn trả hợp lệ.

### T3 - Invoice collection V5

- Tạo collection, tender lines, allocation lines, credit lots/applications.
- Một RPC nhận toàn bộ phương thức thanh toán.
- Lock invoice và kiểm optimistic version/paid amount.
- Chỉ cho thu invoice `APPROVED/PARTIAL_PAID/OVERDUE`.
- Credit là phần tăng thêm, ghi đúng một lần và ngoài KQKD.
- Compatibility wrapper v3/v4 gọi lõi V5; không còn logic tiền riêng.

### T4 - Reversal V5 và state machine

- Reversal `ACTIVE -> REVERSED` đúng một lần.
- Dùng ngày reversal và account gốc.
- Đảo revenue/cọc/credit theo allocation gốc.
- Chặn reversal khi credit lot đã được sử dụng, trừ khi unwind cùng transaction.
- Payment summary chỉ cộng collection còn `ACTIVE`.

### T5 - Báo cáo và profit close

- KQKD dùng accounting snapshot; credit/cọc không vào doanh thu.
- Verification tách Thu/Chi, RPC lỗi thành trạng thái `UNAVAILABLE`, không báo xanh.
- Dùng server aggregate/fetch-all, không cộng âm thầm tối đa 1.000 dòng.
- Hiển thị `shareholder_percent_total`, `allocated` và `unallocated_profit`.
- Phần chưa phân bổ phải chọn `RETAINED_EARNINGS` hoặc `CARRY_FORWARD` có lý do.
- Payout phải reserve một allocation đã khóa và không vượt outstanding.

### T6 - Backfill và đối soát

- Reclassify payment-linked vouchers theo allocation server, giữ audit trước/sau.
- Sửa credit trùng bằng compensating entry, không xóa lịch sử.
- Backfill reversal có account suy ra chắc chắn; phần mơ hồ vào exception queue.
- Đánh dấu snapshot profit cũ stale; không tự reclose hoặc tự chia lại tiền.
- Backfill `received_amount/change_amount/credit_amount/rounding_amount` cho payment
  legacy từ semantic đã chuẩn hóa, không sửa lại `payments.amount` lịch sử.
- Dòng gross-era không ghép duy nhất phải vào exception queue; không được đoán và tự sửa.

## Kết quả kiểm tra trước rollout

- L03: hóa đơn `4.816.667`, cọc `2.000.000`, KQKD đúng `2.816.667`.
- Production có 101 payment returned-change metadata-era, tổng change `7.463.600`;
  retained vẫn bằng `payments.amount`, không bị trừ change lần hai.
- 43 phiếu change gross-era của org thật đã được cleanup cũ soft-delete; không còn dòng
  gross-era live xác nhận được trên org thật. Các fixture reversal tên `Hoàn tác thu tiền`
  bị loại khỏi pairing dù dùng chung category `Tiền thối`.
- Compatibility reversal của V5 dùng ngày Việt Nam hiện tại, giữ lại ngày đã commit khi
  replay; true legacy payment vẫn đi writer legacy.
- Payout sổ ảo bị chặn trước effect và bị chặn cả khi đổi account trên phiếu chờ duyệt.
- Validator 13 migration rollback, audit production rollback và chuỗi accounting DEMO đều PASS.
- Vitest `src`: 89 file, 994 test PASS; build PASS; typecheck baseline không tăng lỗi.
- `reconcile-money` chưa chứng minh được cap-1000 vì kỳ lớn nhất hiện chỉ có 347 phiếu.

## Test matrix

- Unit/property: proration nhiều tháng, discount/cọc, semantic snapshot, allocation,
  credit delta, state transition, stable idempotency.
- SQL integration DEMO: rollback sau từng bước, hai creator cùng phòng, hai collector
  đồng thời, multi-line atomic, reverse mixed revenue/deposit/credit.
- Authz: `42501` không fallback, cross-org/account/type bị từ chối.
- Report: cash/accrual tie-out riêng Thu/Chi, RPC unavailable, fixture >1.000 dòng.
- Profit: tỷ lệ <100, retained/carry-forward, payout reservation và concurrent request.
- E2E headless: tạo HĐ -> invoice đầu -> thu nhiều phương thức -> xem báo cáo -> reverse.

## Rollout production

1. Commit migration source trước, rồi apply đủ 13 file trong một transaction bằng
   `node scripts/apply-accounting-rollout.mjs`; không chạy từng migration rời.
2. Rollout này chỉ dành cho production catalog đã có authz foundation; không dùng
   cho fresh reset/bare database và không thay thế foundation migrations.
3. Chạy audit read-only, `check-view-invoker` và đối soát tiền trước khi bật flag.
4. Regenerate Supabase types từ live DB.
5. Canary trên org DEMO, chạy reconcile và E2E headless; org thật vẫn legacy.
6. Bật writer mới cho org thật chỉ sau khi canary và đối soát không lệch.
7. Thu hồi RPC/DML legacy sau khi client mới đã deploy ổn định.
8. Chỉ reclose kỳ cũ sau khi owner xem chênh lệch và xác nhận lý do.
