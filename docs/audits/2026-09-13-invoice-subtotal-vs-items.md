# Kiểm kê chỉ đọc 13/09/2026: tạm tính hoá đơn so với tổng dòng

Câu truy vấn: `2026-09-13-invoice-subtotal-vs-items.readonly.sql` (chạy qua harness đọc, không ghi).
Mục đích: trước khi vá `create_invoice_v1` / `update_invoice_v1` (server tự cộng lại dòng), xem sổ hiện
có hoá đơn nào tạm tính ≠ Σ thành tiền dòng, hoặc dòng có `amount` ≠ đơn giá × số lượng × hệ số.

## Kết quả theo org / trạng thái / loại

| Org | Trạng thái | Loại | Số HĐ | Lệch tạm tính | Có dòng amount ≠ u×q×c |
|---|---|---|---|---|---|
| THẬT | APPROVED | MONTHLY | 12 | 0 | 0 |
| THẬT | PAID | MONTHLY | 1.252 | 0 | 4 |
| THẬT | PAID | SETTLEMENT | 89 | 3 | 68 |
| THẬT | PARTIAL_PAID | MONTHLY | 7 | 0 | 0 |
| THẬT | OVERDUE | MONTHLY | 31 | 0 | 0 |
| THẬT | OVERDUE | SETTLEMENT | 15 | 1 | 2 |
| THẬT | CANCELLED | MONTHLY | 62 | 0 | 1 |
| THẬT | CANCELLED | SETTLEMENT | 4 | 1 | 1 |
| DEMO | APPROVED | MONTHLY | 1 | 0 | 0 |

## Kết luận

1. **Hoá đơn tháng (đường đi qua `create_invoice_v1`/`update_invoice_v1`): 0/1.364 lệch tạm tính.** Lỗ hổng
   "tin tạm tính client" chưa từng bị lợi dụng trong sổ.
2. **5 dòng hoá đơn tháng có `amount` ≠ u×q×c** — đều là dạng cũ (tháng 5–6/2026): dòng điện ghi
   `unit_price 3500, quantity 1, amount = tổng` (vd INV-202606-146511: amount 294.000 = 84 kWh × 3.500),
   và một dòng nước `33.333,33 × 3 = 99.999,99` ghi `100.000` (lệch 0,01). Tạm tính vẫn đúng.
   → Guard mới chấp nhận sai số < 1 đ; client điều chỉnh đã vá để tin `amount` đã lưu (commit 79bbf770).
3. **Hoá đơn thanh lý (SETTLEMENT, writer riêng của RPC thanh lý): 5 hoá đơn tạm tính ≠ Σ dòng và 71 dòng
   amount ≠ u×q×c.** Nguyên nhân: dòng `type DISCOUNT` ("Tiền cọc hoàn trả", "Tiền phòng thừa") lưu
   `amount` dương nhưng bị TRỪ vào tạm tính (INV-2026-00263: tạm tính 1.188.600, tổng −3.127.400);
   dòng gộp "Tiền phòng + Nước + PDV" ghi đơn giá trọn tháng, amount theo ngày. Đây là ngữ nghĩa của
   writer thanh lý, KHÔNG đi qua hai hàm được vá, nên guard mới không ảnh hưởng.
   **Hệ quả cần vá riêng:** `adjust_invoice_v2` cộng dương mọi dòng → điều chỉnh hoá đơn thanh lý sẽ đổi
   dấu tổng. Client đã chặn điều chỉnh hoá đơn thanh lý (commit 79bbf770); server chưa vá.

## Định nghĩa sống trước khi vá (A2)

| Hàm | md5 `pg_get_functiondef` trên production | Khớp repo (bỏ khoảng trắng) |
|---|---|---|
| `public.create_invoice_v1(…)` | `6545b33eae9919b5249dbd505e60be2a` | có — `20260908051659_invoice_deposit_classification.sql` |
| `public.update_invoice_v1(…)` | `9ddc3b16ca488c1c1bad8210a95ae851` | có — `20260912065909_invoice_adjustment_atomic_revisions.sql` |

Migration vá: `20260913081805_invoice_writers_recompute_subtotal.sql` — thân hàm chép từ định nghĩa sống,
chèn một khối guard mỗi hàm (sai số 1 đ), chữ ký không đổi. Test: `src/lib/__tests__/invoiceWriterSubtotalGuard.test.ts`.

## Diễn tập trước khi áp (A5, 13/09/2026)

- `npm run migrate:forward -- supabase/migrations/20260913081805_invoice_writers_recompute_subtotal.sql` (dry-run,
  bọc ROLLBACK): **xanh**, digest `6f5576e18a9c90f0…`, preflight provenance/cutoff/đích đạt.
- Đã bổ sung `organization_invoice_settings(DEMO, auto_approve_invoice=true)` (trước đó thiếu → DEMO không tạo được hoá đơn).
- `scripts/test-invoice-deposit-classification.mjs`: **đỏ y hệt khi không có migration mới** — fixture của script
  tạo hoá đơn APPROVED rồi gọi `update_invoice_v1`, mà từ migration 12/09 hàm này chỉ nhận DRAFT
  (`55000 Hóa đơn đã phát hành cần điều chỉnh qua phiên bản mới`). Script đã lỗi thời, không liên quan guard mới.
- `scripts/test-accounting-chain.mjs`: **đỏ trên baseline** vì thiếu hàm legacy
  `terminate_contract_move_out(…)` trên production (P0001) — lỗi thời từ trước, không liên quan guard mới.
- Bằng chứng cho guard: `invoiceWriterSubtotalGuard.test.ts` 8/8 trên định nghĩa sống (PGlite).

## Sau khi áp (điền sau)

- Tạo hoá đơn thật ở DEMO qua app: …
- Gửi yêu cầu gian lận qua REST (tạm tính 1.500.000, dòng 5.500.000): …
