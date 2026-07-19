# GO-LIVE TOÀN BỘ — 2026-07-19 (hai đợt trong ngày)

Chỉ đạo owner: "tổ chức đã dừng để tập trung update toàn bộ lên và dùng luôn,
sai sót sau đó thì sửa, không bật từ từ" + "bật nốt 4 writer".

## Đợt 1 (sáng) — 11 flag money-path → ON

- Căn cứ: preflight 30-agent **157 PASS / 0 FAIL / 0 BLOCKED thật** + browser
  fleet 25 test xanh; đối soát tiền khớp tuyệt đối 2 org (real
  `3.891.819.563`, demo `17.285.000`); cách ly tenant/storage/DENY-path kín.
- `set_feature_route_v1` → **ON** (bỏ cửa sổ — tránh FROZEN khi hết hạn canary
  2026-07-20): income_expense.create_draft, invoice.create,
  invoice.record_payment (đã ON trước), salary.lock/unlock/payout,
  shareholder_profit.distribute/pay_manager, cashbook.create/archive/lock_period.
- **GAP-1 vá**: role `Quản Lý Tòa` (org thật) + `thu_tien.collect` → thu tiền
  chạy thẳng canonical (trước đó rơi fallback v3).
- **GAP-3 verified LIVE org thật**: owner lập phiếu lương 1.000đ →
  2 ứng viên duyệt (joey+nathan, toà-ảo 175f4329, building_id KHÔNG null) →
  joey APPROVE → POSTED → paid tự gạch → dọn (paid về 0). Chuỗi duyệt
  owner-maker KHÔNG kẹt.
- Merge trọn SQL tranche + hồ sơ lên `main` @ `691653d`.

## Đợt 2 (chiều) — bật nốt 4 writer cuối (t5_20)

`scripts/authz-prepared/t5_20_enable_last4.sql` (đã apply):

1. **GRANT** `create_contract_v1` / `create_reservation_deposit_v1` /
   `reverse_invoice_payment_v3` → authenticated (opening writer đã granted).
2. **Possession sổ quỹ** (mở khoá `cashbooks.post` requires_cashbook_possession):
   owner mỗi org = edge CASHBOOK (member_permission_overrides SCOPED +
   authorization_scopes + member_override_scopes) + binding **CUSTODIAN** trên
   mọi sổ live — seed **21 sổ real + 8 sổ demo** (bảng possession trước đó = 0
   dòng → mọi user 42501).
3. **create_cashbook_v1 auto-bind**: sổ mới → người phụ trách tự thành
   CUSTODIAN + edge (không cần seed tay về sau).
4. CAS 4 flag → **ON**: cashbook.opening_adjust / contract.create /
   deposit.hold / invoice.reverse_payment. **Tổng: 15/15 flag canonical ON.**

### Test sống demo (REST, org dddd) — tất cả PASS

| Writer | Kết quả |
|---|---|
| deposit.hold | hold A101 500k → 200; hold thứ 2 khác key → **55000 độc quyền**; replay key cũ → nguyên response |
| contract.create | tạo HĐ A101 → 200, room OCCUPIED, **hold được tiêu thụ** (APPROVED + link HĐ); dọn: soft-delete + room AVAILABLE |
| opening_adjust | chunha (CUSTODIAN sau seed) +1000 → 200 voucher điều chỉnh; **ketoan → 42501** (không possession); dọn: CANCELLED |
| reverse_payment | thu 20k (v4) → reverse → 200 bút toán đối ứng, paid **120k→100k đúng**, payment_reversals ghi; replay → nguyên response; key khác → **55000 "đã được hoàn tác"**; ketoan → **42501** (không thu_tien.undo) |

Tiền org thật bất biến `3.891.819.563` sau toàn bộ test.

### Frontend wiring đợt 2

- `src/lib/reservationHold.ts` (MỚI): `tryPlaceRoomHold` — đặt khoá 24h trước
  khi ghi phiếu cọc; chặn khi NGƯỜI KHÁC đang giữ; cho qua khi writer tắt /
  không quyền / chính mình giữ (idempotency key theo phòng+ngày, 23505 = mình
  đã giữ khác tiền).
- `CreateDepositDialog` + `QuickDepositModal`: gọi hold trước khi tạo phiếu cọc.
- `useDeletePayment`: mặc định **HOÀN TÁC canonical** (giữ lịch sử) thay vì
  xoá; guard phiếu cặp cũ `[THU TACH COC]` → legacy; fallback signal → legacy;
  lỗi nghiệp vụ canonical (đã hoàn tác…) hiển thị thẳng; toast phân biệt
  "Đã hoàn tác" / "Đã xoá".

### CHƯA wire frontend (writer live, UI giữ legacy — chủ đích)

- **contract.create**: writer v1 thiếu field so với form
  (deposit_paid/deposit_debt_acknowledged/initial_reading/notes/invoiceItems
  đầy đủ) — wire ngay = mất dữ liệu im lặng. Chờ tranche parity (punch-list).
- **opening_adjust**: `useCreateOpeningAdjustment` legacy là op KÉP ("chốt số &
  khoá sổ": tính chênh + set lock_date); canonical chỉ ghi phiếu chênh theo
  delta. Chuyển UI cần tách/ghép op — để T7.

## Punch-list sau go-live

1. Contract-create parity (writer 10-arg → full form) rồi wire `useCreateContract`.
2. Opening-adjust UI cutover (composite chốt-số → canonical + lock riêng).
3. Chặn phiếu-tiền-0 (finding s02e), GenerateInvoiceDialog bulk, IE recurring/batch.
4. GAP-2: bosshuy IE-create lệch 2 hệ quyền (override v3 có, legacy không).
5. T7 drain legacy sau 1 chu kỳ vận hành; T9 retention 90 ngày + audit cuối.
