# T7 termination breakdown — rereview 2, I3 only

**Spec compliance: APPROVED trong phạm vi I3. Quality: APPROVED, có một Minor ở aggregate mới.** Không còn Important trong finding được giao. Các closure ở rereview 1 được giữ nguyên; không mở lại review toàn task.

- **I3 addressed:** `supabase/migrations/20260921004455_contract_settlement_termination_breakdown.sql:153–158` lấy thành phần credit từ item của đúng voucher và loại `Hoàn tiền thừa thanh lý`, qua RLS/type join đang có. Không còn giải credit bằng số dư header. Với khấu trừ không vượt cọc, tiền thừa bằng thành phần refund-excess đó; khi vượt cọc, chỉ suy phần credit đã cấn khi còn refund-excess dương; trường hợp không chứng minh được trả NULL rồi `EXCESS_RENT_UNAVAILABLE` (`:164–176`).
- Header phiếu được kiểm độc lập với tổng quyết toán từ nguồn tại `:177`, nên header tăng không còn tự trở thành tiền thừa. Regression actual JWT đổi đồng thời voucher total và deposit item thêm 300.000, rồi yêu cầu `REFUND_TOTAL_INCONSISTENT` (`scripts/test-settlement-financial-reader-local.mjs:85–87`). Root báo assertion này RED trên logic cũ và GREEN sau fix; reviewer đã đọc assertion, không chạy lại.
- Nhánh quyền/identity không đổi trong fix này. Hash helper đã cập nhật thành `c9b51ba443c3b59cb2ef19e5746b6a40` trong guard (`migration:22`) và report; link/public hash giữ nguyên. Root báo schema/reapply, JWT và mutation PASS, phục hồi source/function; reviewer không tự đo DB.

## Minor

Aggregate `refund_item_count` ở migration `:153–158` nay JOIN `income_expense_types`, giống hệt tập được đếm thành `typed_refund_item_count` tại `:159–161`. Vì vậy điều kiện `REFUND_TYPES_UNAVAILABLE` ở `:174` trở thành so hai count luôn bằng nhau. Guard tổng tiền vẫn loại phần lớn ca loại bị thiếu có số tiền dương, nên đây không phải blocker I3, nhưng mất kiểm tra completeness độc lập khi item bị loại khỏi JOIN.

Giữ count toàn item chưa JOIN như bản trước, rồi so với count typed riêng. Đã gửi root điểm này để sửa hẹp; không yêu cầu mở rộng review hoặc lặp toàn bộ suite.

## Giới hạn

Review chỉ I3 và regression trực tiếp do aggregate mới. Chưa tự chạy positive credit/applied-credit fixture, browser hoặc shared/production apply. `shortfallMode` vẫn unknown khi chưa có nguồn cấu trúc, và ca thiếu nguồn credit vẫn unavailable theo thiết kế, không gán 0 để làm đủ giao diện.
