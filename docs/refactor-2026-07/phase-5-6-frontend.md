# Phase 5 & 6 — Dọn dẹp Frontend (an toàn, giá-trị-cao)

## Phase 5 — Gate dialog useQuery + dọn console.log

**Commit:** `dacfd0c` · **Loại:** FE

### Đã làm
- **Gate `enabled: open`** cho dialog LUÔN-MOUNTED (điều khiển bằng prop `open`,
  render vô điều kiện): `CreateAssetDialog` (categories, suppliers),
  `EditAssetDialog` (categories, suppliers), `AssetMaintenanceDialog` (profiles).
  Trước đây các query này fetch NGAY khi trang cha mount dù dialog đóng. Đã xác nhận
  cả 3 render tại `AssetsPage.tsx` dạng `<XxxDialog open={...} />` (không phải
  `{open && <...>}`) → gate là thắng thật.
- Xoá 3 `console.log`: `InvoiceListTable` (thừa, đã có toast); `VehiclesPage`
  export/import stub → đổi thành `toast.info(...đang phát triển)` để nút có phản hồi.

### KHÔNG làm (chuyển backlog — rủi ro cao, giá-trị-hiển-thị thấp)
`queryKeys` registry tập trung + rework `useRealtimeDataSync` (invalidate theo
prefix thay list liệt kê tay). Cụm này đụng **cache invalidation trên trang tiền
user reconcile** → cần lưới test dày trước. Tạo registry mà chưa hook nào dùng chỉ
là code chết. Xem RISK-REGISTER §"Backlog".

### Verify
tsc baseline=106; 0 console.log còn trong src; vite build xanh.

### Reviewer cần soi
- Các dialog khác đã kiểm và ĐÃ gate đúng (`RoomDetailDialog`, `PaymentsSummaryDialog`,
  `SuperAdminForceDeleteDialog`, `IncomeExpenseDetailDialog`, phần lớn
  `GenerateInvoiceDialog`). `GenerateInvoiceDialog` dòng existingInvoice gate theo
  `watchedContractId + billingMonth` (không theo `open`) — an toàn vì form rỗng khi
  đóng, nhưng thêm `open` sẽ chặt hơn (chưa làm).

---

## Phase 6 — Gom formatCurrency/formatVND về lib/utils + thống nhất viewport

**Commit:** `6a0c122` · **Loại:** FE · **File chính:** `src/lib/utils.ts`,
`src/lib/__tests__/currencyFormat.test.ts`

### Vì sao
3 formatter export + ~45 file tự định nghĩa formatter local. RỦI RO chính: app hiển
thị tiền kiểu **"1.500.000 đ"** (chữ đ thường), KHÔNG phải "₫" của Intl — thay bừa
sẽ đổi text UI hàng loạt user không yêu cầu.

### Đã làm
1. **`lib/utils`**: giữ `formatCurrency` (kiểu "₫" Intl, dùng cho báo cáo tài chính)
   + thêm `formatVND` (kiểu "1.500.000 đ", dùng cho phiếu/hoá đơn/sổ quỹ, xử lý
   null→"0 đ"). **Snapshot test cứng** các cạnh (0/âm/tỷ/lẻ/null) — đổi hành vi
   formatter GÃY TEST trước khi đổi text UI.
2. Gỡ `formatVND` local ở 7 file (in phiếu, sổ quỹ, chi tiết phiếu, QR bank) + xoá
   export trùng `IncomeExpenseStats.formatVND` → import từ utils. **Output khớp
   HỆT** (snapshot-verified).
3. Gỡ `formatCurrency` local (Intl VND, khớp hệt canonical) ở 5 report:
   DailyCashbook, Deposits, Overpayment, ProfitDistribution, ExpenseRatio (giữ
   `formatCurrencyShort` riêng).
4. **Viewport**: `HomeRoute` có bản `matchMedia` inline HỆT `usePhoneViewport` →
   dùng thẳng hook. GIỮ `useIsMobile` vs `usePhoneViewport` riêng — khác hành vi
   thật (`useIsMobile` init undefined→false gây nháy desktop 1 frame;
   `usePhoneViewport` init đồng bộ, không nháy), KHÔNG gộp được.

### GOTCHA đã gặp (bài học cho reviewer)
Script `awk` chèn `import` vào GIỮA import block đa-dòng của `PayViaBankAppSheet.tsx`
→ syntax error → **tsc bail sớm chỉ báo 5 lỗi** (giả tưởng "giảm 106→5"). Cờ đỏ:
cú giảm lỗi đột ngột = nghi hỏng file, KHÔNG phải thắng. Đã sửa, xác nhận lại 106.

### Verify
- Snapshot formatter: `formatCurrency(1500000)="1.500.000 ₫"`, `formatVND(1500000)=
  "1.500.000 đ"`, `formatVND(null)="0 đ"` — 2 test pass.
- tsc baseline=106; vite build xanh.
- **Playwright production**: `/income-expense` hiển thị "4.286.508.529 đ",
  "134.418.658 đ"... — vẫn kiểu "đ", **KHÔNG có ký hiệu ₫ sai**, 0 lỗi console →
  consolidation không đổi text UI.

### Backlog (chưa làm hết)
6 report còn `formatCurrency` local component-scoped (đa dòng): ExpiringContracts,
NewLeases, Promotions, RenewalsTransfers, Terminations, VacantRooms. Output đã
snapshot nên gom tiếp an toàn, chỉ là công cơ học đa-dòng.

### Reviewer cần soi
- Xác nhận `invoiceTemplateEngine.formatCurrencyVND` KHÔNG bị đụng — đó là
  implementation thủ công riêng cho template docx (chèn dấu chấm tay, khác Intl),
  cố ý để nguyên.
- Chạy `npx vitest run src/lib/__tests__/currencyFormat.test.ts` để tự xác nhận
  output không đổi.
