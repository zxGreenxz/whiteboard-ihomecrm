# T7 termination breakdown — rereview 3

**Spec compliance: APPROVED. Quality: APPROVED.** Minor typed-count của rereview 2 đã khép; không còn finding mở trong chuỗi review scoped này.

- `supabase/migrations/20260921004455_contract_settlement_termination_breakdown.sql:153–159` đếm toàn bộ item chưa JOIN riêng với item có type đọc được; điều kiện `REFUND_TYPES_UNAVAILABLE` tại `:172` có thể phát hiện mất type độc lập với tổng tiền. Công thức credit và kiểm tổng độc lập của I3 được giữ nguyên.
- Regression actual JWT tại `scripts/test-settlement-financial-reader-local.mjs:85–87` thêm item 0 đồng có category không có trong tập JOIN và yêu cầu unavailable. Fixture này kiểm missing category bằng ID tổng hợp; không gọi nó là một lần chứng minh category RLS hidden riêng. Root báo RED trước sửa, GREEN sau sửa cùng schema/mutation PASS; reviewer không lặp suite.
- Guard helper ghim hash mới `a7e62c0b18de2e41dad077dc71e0c3cf` tại migration `:22`. Chỉ đọc delta được giao, không sửa mã hay ghi DB. Giới hạn shared/production apply và browser của các review trước giữ nguyên.
