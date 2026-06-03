# Hiểu rõ toàn bộ Resident — IA, Modules, Gap Analysis & Roadmap

> **Nguồn dữ liệu**
> - Crawl `app.resident.vn` đã đăng nhập (sidebar + 44 route đã thử) → [crawl-resident/data-sitemap/](crawl-resident/data-sitemap/)
> - Crawl `docs.resident.vn` (23 module guide) → [crawl-resident/data-docs/](crawl-resident/data-docs/)
> - Crawl chi tiết Thu chi & Cashbooks (đã làm trước) → [crawl-resident/data/](crawl-resident/data/), [crawl-resident/data-deep/](crawl-resident/data-deep/), [crawl-resident/data-full/](crawl-resident/data-full/)
> - Sitemap routes hiện có ở crm: 89 route (xem [src/App.tsx](src/App.tsx))
>
> **Mục đích**: làm bản đồ tổng quát — mỗi module có 1 mục, mỗi mục ghi rõ Resident có gì, crm hiện có gì, gap, mức độ ưu tiên.

---

## 1. Information Architecture của Resident

Sidebar Resident chia làm 4 nhóm cố định + 2 mục đỉnh:

```
┌─ ĐỈNH ──────────────────────────────────┐
│  🏠  Bảng tin (Dashboard)               │  /
│  🗺   Sơ đồ căn hộ                       │  /apartment-layout
├─ VẬN HÀNH ───────────────────────────────┤
│  Danh mục dữ liệu                       │
│    ├─ Tòa nhà                           │  /apartments
│    ├─ Căn hộ                            │  /rooms
│    └─ Giường                            │  /beds
│  Khách hàng                             │
│    ├─ Khách hẹn (Lead)                  │  /leads
│    ├─ Đặt cọc                           │  /reservations
│    ├─ Hợp đồng                          │  /contracts
│  Tài chính                              │
│    ├─ Ghi chỉ số                        │  /meter-readings (nested?)
│    ├─ Hóa đơn                           │  /invoices
│    └─ Thu chi                           │  /income-expenses
│  Thông báo                              │  /notifications
│  Công việc                              │  /tasks  /tasks/all
├─ BÁO CÁO ────────────────────────────────┤
│  Báo cáo bất động sản                   │  (group)
│  Báo cáo tài chính                      │  (group)
├─ CÀI ĐẶT ────────────────────────────────┤
│  Cài đặt chung                          │  /general-setting
│  Danh mục khác                          │
│    ├─ Tài chính                         │
│    │   ├─ Tài khoản                     │  /setting/finance/cashbooks
│    │   ├─ Loại thu chi                  │  /setting/finance/income-expense-types
│    │   ├─ Đồng hồ công tơ               │  /setting/finance/meters
│    │   ├─ Định mức dịch vụ              │  (chưa map URL)
│    │   ├─ Hóa đơn điện tử               │  (chưa map URL)
│    │   └─ Gạch nợ tự động               │  (chưa map URL)
│    ├─ Tài sản                           │
│    └─ Quản lý hotline                   │
│  Mẫu biểu                               │
│  Nhân viên                              │
└──────────────────────────────────────────┘
```

> Group + URL có dấu `(chưa map)` là route Resident render dynamic, không lộ ra `<a href>` từ sidebar — cần click vào group rồi capture URL từ thanh địa chỉ. **Để Phase A.2 (deep-discovery)** làm sau.

---

## 2. Bảng module-by-module

Format: `Tên module · URL Resident · cột chính/feature · crm tương đương · gap · ưu tiên`.

Quy ước **Mức độ ưu tiên**:
- 🟢 **DONE** — đã có tương đương đủ tốt
- 🟡 **PARTIAL** — đã có nhưng thiếu / lệch
- 🔴 **MISSING** — chưa có

### 2.1. Bảng tin (Dashboard) — `/` 🟡

**Resident**: dashboard tổng hợp số căn hộ trống/đầy, khách hẹn mới, hợp đồng sắp hết hạn, doanh thu/chi 12 tháng, danh sách công việc cần làm. API count rất cao (17 calls). Crawl không capture được nội dung text vì page heavy-JS.

**crm hiện có**: [src/pages/Dashboard.tsx](src/pages/Dashboard.tsx) — đã có placeholder.

**Gap**: chưa biết widget nào còn thiếu — cần crawl sâu hơn.

---

### 2.2. Sơ đồ căn hộ (Apartment layout) — `/apartment-layout` 🟢

**Resident**: render tòa nhà → tầng → căn hộ với heat-map trạng thái (đang ở / trống / đặt cọc / hết hợp đồng…). H1 trong crawl: "Tòa nhà: 102/30 LÊ VĂN THỌ", "TẦNG 1..N".

**crm**: [src/pages/building-map/BuildingMapPage.tsx](src/pages/building-map/BuildingMapPage.tsx) — đã có.

**Gap**: cần đối chiếu UX (filter theo tòa, color legend).

---

### 2.3. Tòa nhà — `/apartments` 🟢

**Cột Resident**: Mã · Thao tác · **Tên tòa nhà · Địa chỉ · Số căn hộ · Ngày TT · Hoạt động** · (legacy thêm) Sử dụng/Tên dịch vụ/Đơn giá.

**crm**: [BuildingsPage](src/pages/buildings/BuildingsPage.tsx) — đã có.

**Gap nhỏ**: cần check cột "Ngày TT" (ngày thanh toán?) và "Sử dụng" có hiển thị chưa.

---

### 2.4. Căn hộ — `/rooms` 🟢

**Cột Resident**: Mã · Thao tác · Tên căn hộ · Loại căn hộ · Giá thuê · Đặt cọc · Diện tích · Trạng thái · Hoạt động.

**crm**: [RoomsPage](src/pages/rooms/RoomsPage.tsx).

---

### 2.5. Giường — `/beds` 🟢

**Cột**: Mã · Thao tác · Tên giường · Giá thuê · Đặt cọc · Trạng thái · Hoạt động.

**crm**: [BedsPage](src/pages/beds/BedsPage.tsx).

---

### 2.6. Khách hẹn (Leads) — `/leads` 🟢

**Cột**: Mã khách hẹn · Trạng thái · Thao tác · Khách hàng · Tòa nhà · Người giới thiệu · CTV · Người tìm khách.

**Filter URL params**: `?leadStatus=new` / `success`.

**crm**: [LeadsPage](src/pages/leads/LeadsPage.tsx).

**Gap**: kiểm cột "Người giới thiệu", "CTV", "Người tìm khách" — cộng tác viên đặc trưng môi giới BĐS.

---

### 2.7. Đặt cọc — `/reservations` 🟡

**Cột**: Mã đặt cọc · Trạng thái · Thao tác · Căn hộ · Khách hàng · CTV · Giá thuê · Đặt cọc · **Ngày cọc · Ngày vào ở**.

**Filter**: `?reservationStatus=2` (Khách vào thuê).

**crm**: [DepositsPage](src/pages/deposits/DepositsPage.tsx).

**Gap**: tên route khác (`/deposits` vs `/reservations`) — cần đối chiếu.

---

### 2.8. Hợp đồng — `/contracts` 🟢

**Cột**: Mã hợp đồng · Trạng thái · Thao tác · Vị trí · Khách hàng · Giá thuê · Tiền cọc · Ngày bắt đầu · Ngày kết thúc · Người tạo.

**crm**: [ContractsPage](src/pages/contracts/ContractsPage.tsx) + ContractDetail.

---

### 2.9. Hóa đơn — `/invoices` 🟡

**Cột Resident**: Mã · Thao tác · **Hóa đơn · Khách hàng · Tiền thuê · Tiền dịch vụ · Tổng tiền · Đã thanh toán · Còn nợ · Nợ cộng dồn · Hạn TT · Người tạo**.

**Filter**: `?month=04-2026`.

**crm**: [InvoicesPage](src/pages/invoices/InvoicesPage.tsx).

**Gap quan trọng**:
- Cột **"Nợ cộng dồn"** (cumulative debt) — kiểm xem có chưa.
- Filter theo tháng (`?month=MM-YYYY`).
- Trạng thái thanh toán (đã/chưa/quá hạn).

---

### 2.10. Thu chi — `/income-expenses` 🟢 ✓ (đã hoàn thiện)

Đã build kỹ ở các turn trước. Có:
- 3 thẻ stats Thu/Chi/Thu-Chi
- Filter inline + panel "Lọc dữ liệu" (Sheet)
- Bảng list với border nhẹ giống Resident
- Form Phiếu thu/chi (cascade tòa→phòng→giường, hạng mục, attachment, receive bank)
- DetailDialog Resident-style + lightbox
- Mobile UI: stats compact, voucher cards, FAB speed-dial
- Workflow: phiếu mặc định APPROVED, có thể CANCELLED (không xoá cứng)
- Trạng thái lock theo cashbook

**Còn thiếu (Phase 2)**:
- Cài đặt lặp lại (chu kỳ — repeatCycle): tạo phiếu định kỳ tự động
- Liên kết hoá đơn (auto-generate phiếu khi thanh toán hoá đơn)
- Nút **In phiếu** (template print)
- Cột "Người tạo" — đã thêm `creator_name` (commit 4e46ce4)

---

### 2.11. Tài khoản (Cashbooks) — `/setting/finance/cashbooks` 🟢 ✓

Đã build kỹ:
- Bảng list + cột Số dư đầu kỳ / Tồn quỹ
- Form thêm 3 loại (Tiền mặt / Ngân hàng / Ví điện tử) với super-refine validation
- Khoá sổ + trigger DB chặn voucher
- DetailDialog Resident-style "THÔNG TIN SỔ QUỸ" + nút "Xem thu chi" deep-link
- Mobile UI: account cards với icon theo loại, FAB
- Currency dynamic balance qua view `accounts_with_balance`

---

### 2.12. Loại thu chi — `/setting/finance/income-expense-types` 🟢

**Cột**: Mã · Thao tác · Loại thu/chi · Phân loại · Mô tả · Mặc định?

**crm**: [IncomeExpenseTypesPage](src/pages/settings/IncomeExpenseTypesPage.tsx) + [categories/IncomeExpenseTypesPage](src/pages/settings/categories/IncomeExpenseTypesPage.tsx).

**Gap**: hai trang trùng nhau — cần dọn về 1.

---

### 2.13. Đồng hồ công tơ — `/setting/finance/meters` 🟡

**Cột Resident**: Mã · Thao tác · Tòa nhà · Căn hộ · Tên đồng hồ · **Chỉ số đầu · Chỉ số chốt gần nhất · Phân loại · Hoạt động · Mặc định**.

**crm**: [MetersPage](src/pages/settings/MetersPage.tsx).

**Gap**: cột "Chỉ số chốt gần nhất" — cần tính & hiển thị.

---

### 2.14. Ghi chỉ số — (URL chưa map, suy đoán `/meter-readings`) 🟡

Resident có module riêng để **ghi chỉ số định kỳ** (điện/nước theo tháng).

**crm**: [MeterReadingsPage](src/pages/meter-readings/MeterReadingsPage.tsx) — đã có.

**Gap**: cần đối chiếu UX (mass-input theo tòa, copy chỉ số tháng trước).

---

### 2.15. Định mức dịch vụ 🟡
Resident có cấu hình ngưỡng tiêu thụ → giá bậc thang. crm: [ServiceQuotasPage](src/pages/settings/categories/ServiceQuotasPage.tsx). **Cần đối chiếu** tính năng.

---

### 2.16. Hóa đơn điện tử 🔴

Resident: tích hợp phát hành HĐ điện tử. crm chưa có.

---

### 2.17. Gạch nợ tự động 🟡

Resident: tự động đối soát biên lai chuyển khoản → gạch nợ hoá đơn. crm: [AutoDebtPage](src/pages/settings/categories/AutoDebtPage.tsx) (placeholder?).

---

### 2.18. Tài sản 🟡

Resident: nhập kho/xuất kho/bảo trì tài sản. crm: [AssetsPage](src/pages/assets/AssetsPage.tsx) + [AssetTypesPage](src/pages/settings/categories/AssetTypesPage.tsx) + [AssetMovementsPage](src/pages/settings/categories/AssetMovementsPage.tsx) + [AssetMaintenancePage](src/pages/settings/categories/AssetMaintenancePage.tsx). **Đã có**, cần đối chiếu UX.

---

### 2.19. Hotline 🟡
crm: [HotlinesPage](src/pages/settings/categories/HotlinesPage.tsx).

---

### 2.20. Mẫu biểu 🟡
Template in hợp đồng/hoá đơn. crm: [TemplatesPage](src/pages/settings/TemplatesPage.tsx).

---

### 2.21. Nhân viên 🟢
crm: [StaffPage](src/pages/settings/StaffPage.tsx).

---

### 2.22. Thông báo — `/notifications` 🟢

**Cột**: Mã · Thao tác · Nội dung thông báo · Số khách hàng nhận · Hình thức gửi · Thời gian · Trạng thái.

**crm**: [NotificationsPage](src/pages/NotificationsPage.tsx).

---

### 2.23. Công việc — `/tasks` & `/tasks/all` 🟢

**Cột**: Mã · Thao tác · Công việc · Vị trí · Loại công việc · Hạn hoàn thành · Người thực hiện · Trạng thái.

**crm**: [TaskManagementPage](src/pages/TaskManagementPage.tsx) + [TaskTypesPage](src/pages/settings/categories/TaskTypesPage.tsx). Vừa được làm lại theo commit 3c3692a.

---

### 2.24. Báo cáo bất động sản 🟢
crm có 9 sub-page trong [src/pages/reports/real-estate/](src/pages/reports/real-estate/).
**Resident URL chính xác chưa map** — sidebar group dynamic.

---

### 2.25. Báo cáo tài chính 🟢
crm có 9 sub-page trong [src/pages/reports/finance/](src/pages/reports/finance/).

---

### 2.26. Cài đặt chung — `/general-setting` 🟡

crm: [GeneralSettingsPage](src/pages/settings/GeneralSettingsPage.tsx) (URL khác: `/settings/general`).

**Gap**: thống nhất URL `/general-setting` ↔ `/settings/general`.

---

### 2.27. Tài khoản cá nhân + Gói cước 🟡
Resident: `/account/profile` & `/account/subscription` (chưa public — redirect 404 trong crawl).
crm: đã có route + page.

---

### 2.28. Changelog — `/changelog` 🟢
crm: [ChangelogPage](src/pages/ChangelogPage.tsx).

---

### 2.29. FAQ 🟢
crm: [FaqPage](src/pages/FaqPage.tsx).

---

## 3. Gap Analysis tóm tắt

| # | Module | Status | Việc cần làm | Effort |
|---|---|---|---|---|
| 1 | Dashboard | 🟡 | Crawl widget Resident → bổ sung KPI cards | M |
| 2 | Sơ đồ tòa nhà | 🟢 | Đối chiếu UX color legend | S |
| 3 | Tòa nhà / Căn hộ / Giường | 🟢 | OK | — |
| 4 | Khách hẹn (lead) | 🟢 | Bổ sung "Người giới thiệu / CTV" | S |
| 5 | Đặt cọc | 🟡 | Đổi route `/deposits` → `/reservations` (alias) | S |
| 6 | Hợp đồng | 🟢 | OK | — |
| 7 | Hóa đơn | 🟡 | Cột "Nợ cộng dồn", filter `?month=` | M |
| 8 | Thu chi | 🟢✓ | Còn cài đặt lặp lại + nút In phiếu | M |
| 9 | Tài khoản (Cashbook) | 🟢✓ | OK | — |
| 10 | Loại thu chi | 🟢 | Dọn 2 page trùng | S |
| 11 | Đồng hồ công tơ | 🟡 | Cột "Chỉ số chốt gần nhất" | M |
| 12 | Ghi chỉ số | 🟡 | Mass-input theo tòa | L |
| 13 | Định mức dịch vụ | 🟡 | UX bậc thang | M |
| 14 | Hóa đơn điện tử | 🔴 | Tích hợp provider | XL |
| 15 | Gạch nợ tự động | 🟡 | Engine match biên lai → hoá đơn | XL |
| 16 | Tài sản | 🟡 | Đối chiếu workflow | M |
| 17 | Hotline | 🟡 | Đối chiếu | S |
| 18 | Mẫu biểu | 🟡 | Editor mẫu in | M |
| 19 | Nhân viên | 🟢 | OK | — |
| 20 | Thông báo | 🟢 | OK | — |
| 21 | Công việc | 🟢 | OK | — |
| 22 | Báo cáo BĐS (9 trang) | 🟢 | Đối chiếu chart từng trang | M |
| 23 | Báo cáo tài chính (9 trang) | 🟢 | Đối chiếu chart từng trang | M |
| 24 | Cài đặt chung | 🟡 | Thống nhất URL | S |

**Effort**: S = ½ ngày, M = 1–2 ngày, L = 3–5 ngày, XL = 1–2 tuần.

---

## 4. Roadmap đề xuất (ưu tiên)

> **Gợi ý**: build từng module theo nguyên tắc "Crawl chi tiết → Doc 1 page → Build → QA Playwright → Commit". Mỗi turn user chỉ approve 1 module để không dồn quá nhiều thay đổi.

### Sprint 1 — Polish các module 🟡 cận hoàn thiện (≈ 5 ngày)
1. **Hóa đơn**: cột "Nợ cộng dồn" + filter `?month=` + status badge.
2. **Khách hẹn**: thêm cột Người giới thiệu / CTV.
3. **Đặt cọc**: alias route + đối chiếu cột.
4. **Đồng hồ công tơ**: cột "Chỉ số chốt gần nhất".
5. **Loại thu chi**: dọn page trùng.
6. **Cài đặt chung**: thống nhất URL.

### Sprint 2 — Tinh chỉnh Dashboard + Báo cáo (≈ 4 ngày)
7. **Crawl Dashboard chi tiết** → bổ sung widget chính (Doanh thu 12 tháng, KPI Hợp đồng sắp hết).
8. **Đối chiếu 9 trang Báo cáo BĐS + 9 trang Báo cáo Tài chính** từng trang một.

### Sprint 3 — Phase 2 Thu chi & Cashbook (≈ 3 ngày)
9. **Cài đặt lặp lại** phiếu thu chi (cron-like UI: tuần / tháng / năm; auto-generate trigger DB).
10. **Nút In phiếu** Thu chi & Hoá đơn (template engine cơ bản).

### Sprint 4 — Tài sản & Định mức dịch vụ (≈ 5 ngày)
11. Đối chiếu workflow Tài sản: Nhập kho / Xuất kho / Bảo trì.
12. Định mức dịch vụ: UX bậc thang số liệu.

### Sprint 5 — Hai module 🔴 nặng (≈ 3 tuần)
13. **Hóa đơn điện tử** (XL) — chỉ làm khi có yêu cầu kinh doanh rõ.
14. **Gạch nợ tự động** (XL) — engine match biên lai.

---

## 5. Quy trình build mỗi module (rút từ kinh nghiệm Thu chi & Cashbook)

```
1. Crawl chi tiết
   - Sitemap + screenshot trang chính (data-sitemap/<module>/screen.png)
   - Click vào dialog Thêm/Sửa, capture HTML + text + API JSON
   - Đo border/padding/font qua getComputedStyle (data-borders pattern)
   - Đọc docs.resident.vn/<module>.md (nếu có)
2. Doc 1 page riêng
   - File: <module>-resident.md cấu trúc:
     · Bố cục trang + screenshot tham chiếu
     · Cột bảng / API endpoints / schema
     · Form fields + validation
     · So sánh với crm hiện tại (gap table)
3. Migration DB (nếu cần field mới)
4. Hooks (TanStack Query) — list/detail/create/update/delete
5. UI desktop trước, mobile sau (useIsMobile switch)
6. QA
   - npx tsc --noEmit
   - Playwright smoke 2 viewport (desktop + iPhone 12 Pro)
   - Manual: tạo / sửa / xoá / filter / pagination
7. Commit có Co-Authored-By
8. Apply migration trên Supabase Studio rồi smoke lần cuối
```

---

## 6. Phụ lục — Routes Resident hợp lệ

> Đã verify status 200 không redirect:

| Route | Module |
|---|---|
| `/` | Bảng tin |
| `/apartment-layout` | Sơ đồ căn hộ |
| `/notifications` | Thông báo |
| `/tasks`, `/tasks/all` | Công việc |
| `/general-setting` | Cài đặt chung |
| `/apartments` | Tòa nhà |
| `/rooms` | Căn hộ |
| `/beds` | Giường |
| `/leads` | Khách hẹn |
| `/reservations` | Đặt cọc |
| `/contracts` | Hợp đồng |
| `/invoices?month=MM-YYYY` | Hóa đơn |
| `/income-expenses` | Thu chi |
| `/setting/finance/cashbooks` | Tài khoản |
| `/setting/finance/income-expense-types` | Loại thu chi |
| `/setting/finance/meters` | Đồng hồ công tơ |
| `/changelog` | Changelog |

> Còn nhiều route group dynamic (Báo cáo, Mẫu biểu, Tài sản, Định mức…) — cần Phase A.2 click-discover.

---

## 7. Trạng thái tiến độ

- ✅ Phase A.1 — Crawl shallow site + docs (xong)
- ⏳ Phase A.2 — Click-discover các group dynamic (chưa)
- ⏳ Phase B — Doc chi tiết từng module + gap analysis (đang)
- ⏳ Phase C — Build module-by-module theo roadmap

---

**Bản này là bản gốc. Mỗi sprint sau cập nhật cột "Status" trong §2 và §3.**
