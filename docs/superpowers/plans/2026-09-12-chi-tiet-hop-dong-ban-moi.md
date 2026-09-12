# Chi tiết hợp đồng — bản mới (desktop) · Kế hoạch thi công

> **Cho người thi công:** dùng `superpowers:executing-plans`. Mỗi bước là một ô tick.
> Spec: [`docs/superpowers/specs/2026-09-12-chi-tiet-hop-dong-ban-moi-design.md`](../specs/2026-09-12-chi-tiet-hop-dong-ban-moi-design.md)

**Mục tiêu:** Thay nhánh desktop của màn chi tiết hợp đồng từ 5 tab sang một trang hai cột
không tab, theo file thiết kế handoff, không mất thông tin nào đang có.

**Cách làm:** Tách toàn bộ phép tính ra 4 module hàm thuần có test trước (TDD), rồi mới dựng
6 component chỉ lo trình bày. `ContractDetailView` giữ nguyên vai trò nạp dữ liệu / state
dialog / quyền; chỉ đổi thứ nó render ở nhánh desktop.

**Công nghệ:** React 18 + TypeScript, Tailwind (giá trị tuỳ ý `bg-[#11231b]`), lucide-react,
TanStack Query, vitest.

## Ràng buộc toàn cục

- Tiền hiển thị **không có ký hiệu ₫** ở mọi chỗ trên màn hình mới.
- Mật độ dòng chốt cứng `--rp: 7px` (mức "Gọn"), không làm tuỳ chọn người dùng.
- **Không đụng** bản mobile (`ContractDetailMobile` + 4 tab riêng của nó).
- **Không đổi** công thức `totalInvoiced` / `totalPaid` / `outstandingAmount`.
- Mọi file `.ts`/`.tsx` **mới** phải khai vào `tsconfig.strict-islands.json` và sạch `strict`
  (gate `new-modules-strict` chặn). Xoá file thì phải rút khỏi **cả** tsconfig **và**
  `tooling/strict-islands-baseline.json` (+ cặp `nuia` nếu có tên).
- Chỉ `git add` đúng file của mình — cây làm việc đang bẩn vì phiên khác. Cấm `git add -A`.
- Icon lấy từ `lucide-react`, không nhúng SVG thủ công.

## Bản đồ file

**Tạo mới** — tất cả dưới `src/components/contracts/detail/desktop/`:

| File | Trách nhiệm |
|---|---|
| `invoicePeriodLabel.ts` | nhãn "Kỳ / ngày" của một hoá đơn |
| `contractHeaderStats.ts` | chip trạng thái + chip công nợ + 4 ô chỉ số header |
| `contractHistoryLines.ts` | 3 bảng lịch sử + HĐ gốc → danh sách dòng chữ |
| `contractFinanceRows.ts` | cọc + hoá đơn + quyết toán → nhóm dòng + tổng |
| `ui.tsx` | mảnh dùng chung: `Card`, `CardHead`, `KvRow`, `SectionLabel` |
| `ContractTopBar.tsx` | header đen dính hai tầng |
| `ContractAlertStrip.tsx` | dải cảnh báo mỏng |
| `ContractTermsCard.tsx` | thẻ HỢP ĐỒNG & DỊCH VỤ + LỊCH SỬ |
| `ContractTenantsCard.tsx` | thẻ KHÁCH THUÊ |
| `ContractFinanceCard.tsx` | thẻ TÀI CHÍNH |
| `ContractDetailDesktop.tsx` | khung hai cột, ráp 5 mảnh trên |

Test đặt cạnh: `desktop/__tests__/<ten>.test.ts`.

**Sửa:**

- `src/components/contracts/detail/formatCurrency.ts` — thêm `formatAmount`
- `src/hooks/contracts/useContractDetailData.ts` — `useContractHistory` join tên phòng
- `src/components/contracts/detail/ContractDetailView.tsx` — nhánh desktop
- `src/components/contracts/ContractDetailModal.tsx` — bỏ header + padding ở desktop, `hideClose`
- `src/pages/contracts/ContractDetailPage.tsx` — `MainLayout fullBleed`
- `tsconfig.strict-islands.json`, `tsconfig.strict-islands-nuia.json`,
  `tooling/strict-islands-baseline.json`, `tooling/strict-islands-nuia-baseline.json`

**Xoá** (7 file, chỉ `ContractDetailView` dùng):
`ContractActionBar.tsx` · `ContractGeneralTab.tsx` · `ContractSummary.tsx` ·
`ContractServicesTab.tsx` · `ContractInvoicesTabDesktop.tsx` ·
`ContractPaymentsTabDesktop.tsx` · `ContractHistoryTabDesktop.tsx`

---

### Task 1 — `formatAmount` + `invoicePeriodLabel`

**Files:** sửa `detail/formatCurrency.ts`; tạo `desktop/invoicePeriodLabel.ts` +
`desktop/__tests__/invoicePeriodLabel.test.ts`

**Produces:**
```ts
formatAmount(n: number): string                    // "3.900.000", không ₫
nhanKyHoaDon(inv: { billing_month?: string | null;
  invoice_items?: Array<{ from_date?: string | null; to_date?: string | null }> | null
}): string
```

- [ ] **B1.** Viết test trước: cùng năm → `"01/09 – 30/09/2026"`; khác năm →
      `"06/12/2025 – 05/01/2026"`; không dòng nào có ngày → `"09/2026"`;
      `billing_month` dị dạng → trả nguyên chuỗi; rỗng hết → `"—"`.
- [ ] **B2.** Chạy `npx vitest run src/components/contracts/detail/desktop` → phải ĐỎ vì
      chưa có module.
- [ ] **B3.** Viết `invoicePeriodLabel.ts` + `formatAmount`.
- [ ] **B4.** Chạy lại → XANH.

### Task 2 — `contractHeaderStats`

**Files:** tạo `desktop/contractHeaderStats.ts` + test

**Produces:**
```ts
type ChipTrangThai = { nhan: string; lop: string };
chipTrangThai(status: string): ChipTrangThai
tienDoHopDong(totalDays: number, daysElapsed: number): number   // 0..100
nhanThoiHan(daysRemaining: number): string
```

- [ ] **B1.** Test: 5 status có nhãn riêng, status lạ → hiện nguyên chuỗi;
      `tienDoHopDong(0, 5) === 0` (không chia cho 0); `tienDoHopDong(100, -3) === 0`;
      `tienDoHopDong(100, 999) === 100`; `nhanThoiHan(-4)` chứa `"quá hạn"`.
- [ ] **B2.** Chạy → ĐỎ. **B3.** Viết module. **B4.** Chạy → XANH.

### Task 3 — `contractHistoryLines` + join tên phòng

**Files:** tạo `desktop/contractHistoryLines.ts` + test; sửa
`src/hooks/contracts/useContractDetailData.ts`

**Produces:**
```ts
type DongLichSu = { id: string; ngay: string; tieuDe: string; moTa: string;
                    nhan: string; lopNhan: string };
dungDongLichSu(args: {
  contract: { id: string; contract_number: string | null; created_at?: string | null;
              signed_date?: string | null; start_date: string; end_date: string };
  history: ContractHistoryItem[];
}): DongLichSu[]
```

Tên phòng đọc từ `item.details.old_room_label` / `new_room_label` — hook nhét sẵn (B5).

- [ ] **B1.** Test: 4 loại dòng thật (gia hạn / nhượng / chuyển phòng / thanh lý) + dòng
      "Tạo hợp đồng" suy ra luôn nằm cuối; thiếu tên phòng → `"phòng khác"`; thứ tự mới→cũ.
- [ ] **B2.** Chạy → ĐỎ. **B3.** Viết module. **B4.** Chạy → XANH.
- [ ] **B5.** Sửa `useContractHistory`: sau khi lấy 3 bảng, gom `old_room_id`/`new_room_id`
      của `contract_transfers`, query `rooms(id, name, building:buildings(name))` cho các id
      đó, rồi **nhét nhãn vào `details`** của từng dòng transfer
      (`details.old_room_label = "201 — 405PVB"`).

      **Vì sao nhét vào `details` chứ không đổi kiểu trả về:** hook trả
      `ContractHistoryItem[]`, và bản **mobile** cũng dùng đúng mảng đó
      (`ContractDetailView` truyền `history={contractHistory}` xuống
      `ContractDetailMobile`). Đổi sang trả object là ép sửa cả mobile — trái ràng buộc
      "không đụng mobile". `details` là `Record<string, any>` nên thêm khoá không đổi kiểu,
      không đổi query key, mobile không thấy gì khác.

### Task 4 — `contractFinanceRows`

**Files:** tạo `desktop/contractFinanceRows.ts` + test

**Produces:**
```ts
type DongTien = { id: string; ten: string; ky: string; soTien: number | null;
                  daThu: number | null; conNo: number | null;
                  laDongCon: boolean; daHuy?: boolean; moPhieu?: string | null };
type NhomTien = { khoa: 'TIEN_COC' | 'HOA_DON' | 'QUYET_TOAN'; tieuDe: string;
                  dong: DongTien[] };
dungBangTaiChinh(args): { nhom: NhomTien[];
  tong: { soHoaDon: number; soTien: number; daThu: number; conNo: number } }
```

- [ ] **B1.** Test dùng đúng ba fixture số học trong spec §5.3:
      8.050.000 / 12.200.000 / 10.878.500. Thêm ca: dòng con không cộng vào tổng;
      nhóm QUYẾT_TOÁN vắng khi chưa thanh lý; hoá đơn CANCELLED vẫn cộng và có
      `daHuy: true`.
- [ ] **B2.** Chạy → ĐỎ. **B3.** Viết module. **B4.** Chạy → XANH.
- [ ] **B5.** Commit Task 1–4 (4 module + 4 test + hook).

### Task 5 — 6 component trình bày

**Files:** tạo `desktop/ui.tsx`, `ContractTopBar.tsx`, `ContractAlertStrip.tsx`,
`ContractTermsCard.tsx`, `ContractTenantsCard.tsx`, `ContractFinanceCard.tsx`,
`ContractDetailDesktop.tsx`

**Consumes:** toàn bộ Task 1–4.

- [ ] **B1.** `ui.tsx` — `Card` (nền trắng, viền `#e2e5ea`, bo 10px), `CardHead`
      (icon + nhãn 12.5px/700 uppercase `.06em` màu `#33443c`), `KvRow`, `SectionLabel`.
- [ ] **B2.** `ContractTopBar.tsx` theo spec §4.1 — hai tầng, **chép nguyên bảng quyền §6.1**.
- [ ] **B3.** `ContractAlertStrip.tsx` theo §4.2 — 5 cảnh báo, giữ nguyên câu chữ và link.
- [ ] **B4.** `ContractTermsCard.tsx` theo §4.3. **B5.** `ContractTenantsCard.tsx` theo §4.4.
- [ ] **B6.** `ContractFinanceCard.tsx` theo §4.5. **B7.** `ContractDetailDesktop.tsx` ráp lại.
- [ ] **B8.** `npx tsc --noEmit -p tsconfig.app.json` sạch.

### Task 6 — Nối dây, xoá file chết, cập nhật đảo strict

- [ ] **B1.** `ContractDetailView.tsx`: nhánh desktop trả `<ContractDetailDesktop …/>`;
      gỡ import `Tabs`/`Alert`/`ContractActionBar` và 5 tab desktop.
- [ ] **B2.** `ContractDetailModal.tsx`: desktop → bỏ `DialogHeader`, bỏ padding, thêm
      `hideClose`; mobile giữ nguyên.
- [ ] **B3.** `ContractDetailPage.tsx`: desktop → `MainLayout fullBleed`.
- [ ] **B4.** `git rm` 7 file chết.
- [ ] **B5.** Cập nhật 4 file đảo strict: thêm 10 file mới vào
      `tsconfig.strict-islands.json`, rút 7 file khỏi tsconfig + baseline (và 2 file khỏi
      cặp `nuia`).
- [ ] **B6.** `npm run gate:strict-islands` → xanh.

### Task 7 — Gate, phát hành

- [ ] **B1.** `npx vitest run src` · `npm run lint` · `npm run typecheck:baseline`.
- [ ] **B1b.** **Xem màn hình thật** (Contract §8: đổi UX phải chạy được và soát console):
      `npm run dev`, đăng nhập tài khoản test, mở `/contracts` → bấm một HĐ đang hoạt động,
      một HĐ đã thanh lý; rồi mở thẳng `/contracts/:id`. Chụp ảnh, đọc console — **0 lỗi**.
      Dùng Playwright MCP theo CLAUDE.md (kiểm từng màn hình), không cần viết spec fleet mới:
      `.e2e-fleet` hiện không có spec nào mở màn chi tiết HĐ, và CI cũng không chạy thư mục đó.
- [ ] **B2.** Stage đúng file rồi `npm run gate:truoc-push`.
- [ ] **B3.** Commit `feat(contracts): …`, trailer `Co-Authored-By: Claude <noreply@anthropic.com>`.
- [ ] **B4.** `git merge-base --is-ancestor origin/main HEAD` rồi `git push origin HEAD:main`.
- [ ] **B5.** Chờ CI: `npm run promote:production -- --sha <sha>`; đủ xanh thì `--apply`.
- [ ] **B6.** Kiểm Vercel thật sự build xong (state READY) trước khi tuyên bố đã lên.
