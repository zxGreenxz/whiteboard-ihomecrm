# Chi tiết hợp đồng — bản mới (desktop)

Ngày chốt: 12/09/2026 · Nguồn thiết kế: `ch-nh-s-a-giao-di-n-h-p-ng/project/Chi tiết hợp đồng - bản mới.dc.html`

## 1. Vấn đề

Màn hình chi tiết hợp đồng hiện tại (desktop) chia **5 tab** — Thông tin chung / Dịch vụ / Hoá
đơn / Thanh toán / Lịch sử. Hệ quả: muốn trả lời một câu hỏi thường gặp ("khách này còn nợ gì,
đã trả gì, hợp đồng đi tới đâu rồi") phải bấm qua 3–4 tab và tự ghép số trong đầu. Thẻ bài trí
thưa (padding 24px, tiêu đề 24px) nên mỗi tab chỉ hiện được vài dòng.

Bản thiết kế mới gom tất cả về **một trang hai cột, không tab**, mật độ dày hơn, và đưa hành
động + 4 chỉ số then chốt lên một header đen dính đầu trang.

## 2. Phạm vi

**Trong phạm vi** — nhánh **desktop** của `ContractDetailView`, dùng chung bởi:

- modal toàn màn hình mở từ danh sách (`ContractDetailModal` ← `ContractsPage`)
- route sâu `/contracts/:id` (`ContractDetailPage`)

**Ngoài phạm vi** — bản mobile (`ContractDetailMobile` + 4 tab riêng của nó). Thiết kế vẽ ở khổ
1440px, bundle không có bản mobile. Mobile giữ nguyên, không đụng một dòng.

## 3. Quyết định đã chốt với chủ

| # | Câu hỏi | Chốt |
|---|---|---|
| 1 | Áp dụng ở đâu | Cả modal lẫn route, chỉ desktop |
| 2 | Nội dung bản thiết kế bỏ sót | **Giữ hết**, nhét vào bố cục mới |
| 3 | HĐ đang hoạt động mà còn nợ | Hiện **cả hai chip** |
| 4 | Ký hiệu tiền | **Bỏ ₫ trên toàn màn hình**, kể cả header và dòng tổng |
| 5 | Mật độ (`matDo` trong file thiết kế) | Núm thời-thiết-kế, không thành tuỳ chọn người dùng. Chốt cứng mức "Gọn" = `--rp: 7px` |

## 4. Bố cục

```
ContractDetailView.tsx                 GIỮ NGUYÊN VAI TRÒ
  · nạp dữ liệu (useContract, useInvoicesLegacy, 6 query phụ)
  · state 9 dialog hành động
  · quyền canUse(perms, 'contracts', …)
  · rẽ nhánh mobile / desktop
  └─ desktop: <ContractDetailDesktop … />   ← thay <ContractActionBar/> + <Tabs>

detail/desktop/
  ContractDetailDesktop.tsx   khung: nền #f4f6f8, lưới 2 cột minmax(0,1fr) /
                              minmax(0,1.12fr), gap 14px, max-w 1720px, --rp: 7px
  ContractTopBar.tsx          header #11231b dính (position: sticky, top 0, z 30)
  ContractAlertStrip.tsx      dải cảnh báo mỏng ngay dưới header
  ContractTermsCard.tsx       cột trái  · HỢP ĐỒNG & DỊCH VỤ + LỊCH SỬ HỢP ĐỒNG
  ContractTenantsCard.tsx     cột trái  · KHÁCH THUÊ
  ContractFinanceCard.tsx     cột phải  · TÀI CHÍNH
```

### 4.1 `ContractTopBar` — header đen, hai tầng

**Tầng 1** (`padding: 9px 18px`, các phần tử cao 30px):

- icon hợp đồng trong ô bo 8px nền `rgba(255,255,255,.09)`
- `"<toà> · Phòng <phòng>"` — 15px/600, trắng
- chip trạng thái HĐ: nền `rgba(34,197,94,.16)` chữ `#6ee7a8` (đang hoạt động) ·
  `rgba(255,255,255,.12)` chữ `#cfd8d3` (thanh lý / hết hạn / nháp / đã nhượng)
- chip công nợ (khi `outstandingAmount > 0`): nền `rgba(239,68,68,.18)` chữ `#fca5a5`,
  nội dung `"Còn công nợ 4.150.000"`
- dòng phụ 11.5px `rgba(255,255,255,.52)`: `"<số HĐ> · <tên đại diện> · <sđt>"`
- 8 nút hành động + gạch dọc + nút X đóng, **giữ nguyên điều kiện quyền hiện có**
  (xem §6.1)

**Tầng 2** — 4 ô ngăn bằng `border-right: 1px solid rgba(255,255,255,.08)`, nền
`rgba(0,0,0,.16)`:

| Ô | Nhãn (10.5px, uppercase, `.07em`) | Giá trị (14.5px/600) |
|---|---|---|
| 1 | Phòng · Toà nhà | `303 — 405PVB` |
| 2 | Giá thuê | `3.900.000` xanh `#6ee7a8` + `/ hàng tháng` |
| 3 | Hiệu lực | `06/09/2026 – 30/08/2027` |
| 4 | Thời hạn | `còn 351 ngày` · `đã thuê 6 / 358 ngày` + thanh tiến độ 5px |

Ô 4 dùng `flex: 1 1 300px` để nuốt chỗ thừa; ba ô đầu `flex: 0 1 180/215/235px`.

### 4.2 `ContractAlertStrip`

Gộp 4 cảnh báo đang nằm rải rác, thành dải mỏng một dòng mỗi cảnh báo, **giữ nguyên câu chữ
và link hiện có**:

1. lỗi tải query phụ (`sideLoadErrors`) — đỏ
2. sắp hết hạn ≤30 ngày và còn hiệu lực — cam
3. đã đăng ký chuyển đi (`expected_move_out_date`) — xanh dương
4. phiếu thanh lý chờ xử lý (`pendingForfeitCount` + `pendingRefundCount`) — hổ phách,
   **kéo từ `ContractSummary` sang**; đây là chỗ duy nhất trong app nhắc kế toán đi duyệt
   phiếu, mất là mất thật
5. cọc còn thiếu (`deposit_remaining > 0`) — cam, kèm nhánh `deposit_debt_mode ===
   'FIRST_INVOICE'` (xanh dương, câu chữ khác) như hiện tại

### 4.3 `ContractTermsCard` — cột trái, thẻ 1

Nền trắng, viền `#e2e5ea`, bo 10px. Đầu thẻ 10px/14px: icon `#12764a` + `HỢP ĐỒNG & DỊCH VỤ`
(12.5px/700, uppercase, `.06em`, `#33443c`).

**Thân — lưới `repeat(auto-fit, minmax(300px, 1fr))`, `gap: 1px`, nền `#eef0f3`** (kẻ chỉ
bằng khe lưới):

- **Cột "Hợp đồng"** — 8 dòng `minmax(92px, max-content) minmax(0,1fr)`:
  Số hợp đồng · Ngày ký · Bắt đầu · Kết thúc · Giá thuê (xanh `#12764a`) · Chu kỳ ·
  Tiền cọc · File hợp đồng (link "Xem bản scan", chỉ khi có `contract_file_url`)
- **Cột "Dịch vụ"**:
  - dòng "Chỉ số đầu": ⚡ `initial_electricity_reading` kWh · 💧 `initial_water_reading` m³
  - bảng dịch vụ từ `contract_services`: tên · nhãn loại · đơn giá + đơn vị, canh phải

**Khối dưới** — `LỊCH SỬ HỢP ĐỒNG`, lưới `88px minmax(0,1fr) 104px`: ngày · câu mô tả ·
nhãn màu. Xem §5.2.

**Dòng Ghi chú** (`contract.notes`) đặt cuối khối "Hợp đồng", chỉ hiện khi có.

### 4.4 `ContractTenantsCard` — cột trái, thẻ 2

Đầu thẻ: icon người + `KHÁCH THUÊ` + chip `"N người"`.

Mỗi khách một dòng `34px minmax(0,1fr) 26px`:

- avatar tròn 34px chữ viết tắt — đại diện: nền `#eef7f2` chữ `#12764a`; còn lại `#f1f3f5` / `#5a6862`
- tên 14px/600 + badge `ĐẠI DIỆN` nếu `is_representative`
- dòng meta 12.5px ngăn bằng dấu `·`: ☎ sđt · 🪪 CCCD · 🛵 biển số (hoặc "Không") · ✉ email
  (hoặc "Chưa có" màu nhạt)
- nút 👁 → `navigate('/customers/:id')`
- ghi chú khách (`cc.notes`) nếu có → dòng phụ nền hổ phách

### 4.5 `ContractFinanceCard` — cột phải

Đầu thẻ: icon ₫ + `TÀI CHÍNH` + chip bên phải (`Công nợ 4.150.000` đỏ / `Không có công nợ` xanh).

**Một bảng duy nhất**, `min-width: 700px` trong khung `overflow-x: auto`. Cột:
`Khoản mục | Kỳ / ngày | Số tiền | Đã thu | Còn nợ | (nút)` — ba cột tiền rộng 104px, canh
phải, `font-variant-numeric: tabular-nums`.

Nhóm phân cách bằng dòng `colspan=6` nền `#f1f6f3` chữ `#146e47`:

1. **TIỀN CỌC** — dòng chính "Tiền cọc theo hợp đồng" (`total_deposit` / `deposit_paid` /
   `deposit_remaining`), rồi **dòng con** cho từng phiếu thu cọc: mã phiếu (font mono) · tên sổ ·
   ngày · số tiền vào cột "Đã thu" · nút 👁. Phiếu cọc đầu kỳ (`posting_status ===
   'NOT_APPLICABLE'`) kèm chú `cọc đầu kỳ (không vào sổ quỹ)`.
2. **HOÁ ĐƠN** — mỗi hoá đơn một dòng: tên (`getInvoiceTitle`) · kỳ (§5.1) · tổng · đã thu ·
   còn nợ · nút 👁 → `/invoices/:id`. **Dòng con**: từng lần thanh toán (`invoice.payments`) —
   ngày giờ · phương thức · ghi chú · số tiền vào cột "Đã thu". Đây là chỗ tab "Thanh toán"
   được gộp vào.
3. **QUYẾT TOÁN THANH LÝ** (chỉ khi `status === 'TERMINATED'` và có `terminationInfo`) —
   nền `#fdf3f4` chữ `#9f1239`. Các dòng: Cọc tính quyết toán · Công nợ cấn trừ (− …) ·
   Phí phạt + thu thêm (− …) · **Net quyết toán (hồ sơ)**. Cột "Đã thu" của dòng Net =
   `posted_refund`; cột "Còn nợ" = lệch. Dòng chú cuối nhóm giữ nguyên cảnh báo lệch hiện có.

**`tfoot` Tổng cộng** — nền `#f7f9f8`: số hoá đơn · Σ số tiền · Σ đã thu · Σ còn nợ.

## 5. Hàm thuần (tách khỏi JSX để test được)

### 5.1 `invoicePeriodLabel.ts`

```
nhanKyHoaDon(invoice) -> string
```

**Đo trên production 12/09/2026:**

- `invoices.billing_month` NOT NULL — **1470/1470** hoá đơn còn sống đều có kỳ tháng
- `invoice_items.from_date/to_date` — **1047/1470 (71%)** hoá đơn có ít nhất một dòng mang ngày
  (1219/5450 dòng)
- Kỳ thật **bám tháng dương lịch**: `01/09 – 30/09/2026`; tháng đầu vào ở thì
  `06/09 – 30/09/2026`. Con số `06/09 – 05/10/2026` trong file thiết kế là số bịa của mockup,
  **không** phải cách hệ thống chia kỳ.

Quy tắc:

1. Có `min(from_date)` và `max(to_date)` → `"01/09 – 30/09/2026"`; cùng năm thì vế đầu bỏ năm.
2. Không có → `"09/2026"` từ `billing_month` (`"2026-09"` → `"09/2026"`).
3. Không bao giờ trả chuỗi rỗng.

### 5.2 `contractHistoryLines.ts`

```
dongLichSu(contract, history, phongTheoId) -> DongLichSu[]
DongLichSu = { id, ngay, tieuDe, moTa, nhan, mauNhan }
```

| Nguồn | Tiêu đề | Mô tả | Nhãn |
|---|---|---|---|
| `contract_extensions` | Gia hạn hợp đồng | `<old_end> → <new_end> (N tháng)`, thêm `", giá <cũ> → <mới>"` khi `rent_price_changed` | GIA HẠN — xanh `#12764a` |
| `contract_transfers` (`transfer_type` đổi khách) | Nhượng hợp đồng | `<khách cũ> → <khách mới>` | NHƯỢNG HĐ — hổ phách `#92400e` |
| `contract_transfers` (đổi phòng) | Chuyển phòng | `<phòng cũ> → <phòng mới>`, thêm giá khi `new_rent_price` khác | CHUYỂN PHÒNG — xanh dương `#1e40af` |
| `contract_terminations` | Thanh lý hợp đồng | `<loại>, net quyết toán <refund_amount>` | THANH LÝ — đỏ `#9f1239` |
| **suy ra từ `contract`** | Tạo hợp đồng | `<contract_number>, hiệu lực <start> – <end>` | TẠO MỚI — xám `#4a5a52` |

Dòng "Tạo hợp đồng" **không có bảng nào ghi** — suy ra từ chính HĐ (`created_at`,
`contract_number`, `start_date`, `end_date`), luôn nằm cuối danh sách.

Tên phòng cho dòng "Chuyển phòng": `contract_transfers` chỉ có `old_room_id`/`new_room_id`.
→ **mở rộng `useContractHistory`** join `rooms(id, name, building:buildings(name))` cho hai id
đó. Không lấy được tên thì hiện `"phòng khác"` thay vì để trống.

Sắp xếp: mới → cũ theo `created_at`, dòng "Tạo hợp đồng" chốt đáy.

### 5.3 `contractFinanceRows.ts`

```
dungBangTaiChinh({ contract, depositVouchers, invoices, terminationInfo }) -> {
  nhom: NhomTaiChinh[],   // TIEN_COC | HOA_DON | QUYET_TOAN
  tong: { soHoaDon, soTien, daThu, conNo },
}
```

Bất biến phải đúng (và được test canh):

- `tong.soTien` = Σ `soTien` của mọi **dòng chính**, gồm **cả dòng tiền cọc** và **cả dòng Net
  quyết toán**. Dòng con (phiếu thu cọc, lần thanh toán) **không** cộng vào — chúng là chi tiết
  của dòng cha, cộng vào là đếm hai lần.
- `tong.conNo` = `tong.soTien − tong.daThu`, kẹp sàn 0 ở cấp từng dòng chứ không ở tổng
- nhóm QUYẾT TOÁN chỉ xuất hiện khi `status === 'TERMINATED' && terminationInfo != null`
- hoá đơn `status === 'CANCELLED'` **vẫn** cộng vào tổng — đúng bằng hành vi hiện tại của
  `totalInvoiced`/`outstandingAmount` ở `ContractDetailView`. Dòng đó được nhuộm nhạt + gắn chữ
  `đã huỷ` để con số vẫn giải thích được. (Việc cộng hay không cộng hoá đơn đã huỷ là câu hỏi
  **nghiệp vụ về tiền**, không sửa nhân tiện trong một lần đổi giao diện — xem §8.)

**Số học lấy thẳng từ file thiết kế, dùng làm fixture test:**

| Trạng thái | Phép cộng | `tong.soTien` |
|---|---|---|
| Đang hoạt động | 3.900.000 cọc + 4.150.000 hoá đơn | 8.050.000 ✓ |
| Còn công nợ | 3.900.000 + 4.150.000 + 4.150.000 | 12.200.000 ✓ |
| Đã thanh lý | 3.900.000 + 4.150.000 + 2.828.500 net | 10.878.500 ✓ |

Ba con số bên phải là số `tfoot` in trong file thiết kế — khớp cả ba, tức quy tắc "cọc và net
quyết toán đều là dòng chính" là đọc đúng ý thiết kế, không phải tôi tự đặt.

### 5.4 `contractHeaderStats.ts`

```
chipTrangThai(status) -> { nhan, nen, chu }
thongKeHeader({ contract, daysRemaining, totalDays, daysElapsed, outstandingAmount })
```

- tiến độ kẹp `[0, 100]`; `totalDays <= 0` → 0 (không chia cho 0)
- `daysRemaining < 0` → `"quá hạn N ngày"` thay cho `"còn N ngày"`
- chip công nợ chỉ khi `outstandingAmount > 0`, độc lập hoàn toàn với chip trạng thái

## 6. Bảo toàn hành vi

### 6.1 Quyền — chép nguyên, không diễn giải lại

| Nút | Điều kiện hiện có (giữ y nguyên) |
|---|---|
| Cập nhật | `status !== 'TERMINATED' && canUse(perms,'contracts','edit')` |
| In hợp đồng | `canUse(perms,'contracts','print')` |
| QR hợp đồng | `status !== 'TERMINATED' && status !== 'DRAFT'` |
| Gia hạn | `isActive && canUse(…,'renew')` |
| Chuyển phòng | `isActive && canUse(…,'transfer')` |
| Nhượng HĐ | `isActive && canUse(…,'transfer')` |
| Đăng ký chuyển đi | `isActive && canUse(…,'terminate')` |
| Thanh lý | `isActive && canUse(…,'terminate')` |
| Xoá | `status === 'DRAFT' && canUse(…,'delete')` |

`isActive = isContractInEffect(contract.status)` — không đổi.

### 6.2 Nút đóng (X)

- **Trong modal**: `ContractDetailModal` bỏ `DialogHeader` + padding ở nhánh desktop và
  truyền `hideClose` cho `DialogContent` (prop đã có sẵn) — nếu không sẽ có **hai** nút X.
  Nhánh mobile giữ nguyên `DialogHeader` như cũ.
- **Trong route**: `ContractDetailPage` chuyển sang `MainLayout fullBleed` (prop đã có) để
  header dính chạm mép; X gọi `onBack` → `navigate('/contracts')`.

### 6.3 Tiền

Thêm `formatAmount(n)` cạnh `formatCurrency` sẵn có: `Intl.NumberFormat('vi-VN')` **không**
`style: 'currency'` → `"3.900.000"`. Toàn màn hình mới dùng `formatAmount`; `formatCurrency`
giữ nguyên cho mobile và các màn khác đang dùng.

## 7. Xoá gì

7 component chỉ `ContractDetailView` dùng, sau khi đổi thì chết hẳn (đã kiểm bằng grep toàn repo
— mobile có bộ riêng `ContractInfoTab` / `ContractInvoicesTab` / `ContractPaymentsTab` /
`ContractHistoryTab`):

```
ContractActionBar.tsx          ContractGeneralTab.tsx      ContractSummary.tsx
ContractServicesTab.tsx        ContractInvoicesTabDesktop.tsx
ContractPaymentsTabDesktop.tsx ContractHistoryTabDesktop.tsx
```

**Ràng buộc gate của repo**: cả 7 file đều nằm trong `tsconfig.strict-islands.json`. Xoá file thì
phải rút khỏi **cả** tsconfig **và** `tooling/strict-islands-baseline.json` (+ cặp `nuia` nếu có
tên) — `check-strict-islands.mjs` chặn cả hai chiều: đảo trỏ file không tồn tại là **lỗi**, mà rút
đảo khỏi baseline không chủ ý cũng là **lỗi**.

Ngược lại, mọi file `.tsx`/`.ts` **mới** phải được khai vào `tsconfig.strict-islands.json` ngay và
sạch `strict` — `check-new-modules-strict.mjs` chặn.

## 8. Cố tình KHÔNG làm

- Không đụng bản mobile.
- Không sửa cách tính `totalInvoiced` / `totalPaid` / `outstandingAmount` ở
  `ContractDetailView`. Đó là thay đổi **nghiệp vụ về tiền**, không phải việc của một lần đổi
  giao diện. Nếu muốn sửa thì làm riêng, có số đo.

  **Quan sát để lại cho sau, KHÔNG sửa trong đợt này**: `outstandingAmount` hiện cộng cả hoá đơn
  `CANCELLED`. Với HĐ có hoá đơn đã huỷ chưa thu, chip "Còn công nợ" ở header sẽ báo nợ dù thực
  tế không còn phải thu. Bản mới **không làm điều này tệ hơn** (giữ nguyên công thức) và làm nó
  **dễ thấy hơn** (dòng đã huỷ hiện rõ trong bảng thay vì trốn sau tab). Ai muốn sửa thì mở việc
  riêng, đo trước xem có bao nhiêu HĐ đang dính.
- Không đổi query key, không đổi tầng dữ liệu ngoài một chỗ: join tên phòng vào
  `useContractHistory` (§5.2).
- Không làm núm chọn mật độ cho người dùng.

## 9. Kiểm chứng

**Test đơn vị (vitest, viết trước code):**

| File | Ca phải phủ |
|---|---|
| `invoicePeriodLabel.test.ts` | đủ from/to cùng năm · khác năm · thiếu ngày → fallback tháng · `billing_month` dị dạng |
| `contractHistoryLines.test.ts` | 4 loại dòng thật · dòng "Tạo hợp đồng" suy ra · thiếu tên phòng · thứ tự mới→cũ |
| `contractFinanceRows.test.ts` | tổng khớp Σ dòng chính · dòng con không bị cộng hai lần · nhóm quyết toán chỉ khi TERMINATED · ca lệch phiếu hoàn |
| `contractHeaderStats.test.ts` | tiến độ kẹp 0–100 · `totalDays = 0` không chia cho 0 · quá hạn · hai chip cùng lúc |

**Gate phải xanh trước khi push:**

```
npx vitest run src
npm run lint
npm run typecheck:baseline
npm run gate:strict-islands
npm run gate:truoc-push
```

**Xem mắt thường**: mở `/contracts` → bấm một HĐ đang hoạt động, một HĐ còn nợ, một HĐ đã thanh
lý; rồi mở thẳng `/contracts/:id` của cùng ba HĐ đó. Chụp ảnh đối chiếu với file thiết kế.
