# Cấu trúc thư mục & Kiến trúc code

> Tài liệu này mô tả **cách tổ chức code & thư mục** của repo (frontend React + backend Supabase),
> tập trung vào *kiến trúc / quy ước lập trình*. Phần **dữ liệu + quy trình nghiệp vụ** theo từng
> domain nằm ở bộ tài liệu riêng [docs/he-thong/](he-thong/) — hai bộ bổ trợ cho nhau:
>
> | Bạn muốn biết… | Đọc ở đâu |
> |----------------|-----------|
> | Code nằm ở thư mục nào, theo pattern gì, hook/lib/component tổ chức ra sao | **File này** |
> | Bảng DB, enum, RPC, quy tắc nghiệp vụ, luồng từng trang | [docs/he-thong/](he-thong/) |
> | Schema DB chi tiết | [docs/DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) |
> | Mô hình phân quyền RLS/RBAC | [docs/RBAC_REFACTOR.md](RBAC_REFACTOR.md) · [docs/he-thong/01-phan-quyen-nhan-su.md](he-thong/01-phan-quyen-nhan-su.md) |

Production: <https://ptcrm.vercel.app> · Deploy thẳng từ nhánh `main` qua Vercel.

---

## 0. Bản đồ thư mục repo

```
whiteboard-ihomecrm/
├── src/                      # Frontend (531 file) — xem §1–§6
│   ├── main.tsx              # Entry: createRoot → <App/>
│   ├── App.tsx              # Routing + provider stack (§2)
│   ├── index.css            # Tailwind layers + CSS variables (design tokens)
│   ├── pages/               # 85 file — điểm vào route, theo domain (§3)
│   ├── components/          # UI theo domain + ui/ shadcn (§4)
│   ├── hooks/               # ~76 hook React Query + 6 test (§5)
│   ├── lib/                 # 47 util/validation/calculator + 26 test (§6)
│   ├── types/               # 9 file domain types thủ công (§6.3)
│   ├── integrations/supabase/  # client.ts + types.ts (auto-gen) (§6.4)
│   └── assets/             # ảnh tham chiếu UI (không bundle vào app)
├── supabase/                # Backend (207 file) — §7
│   ├── migrations/         # 186 migration .sql (timestamp prefix)
│   ├── migrations-bundle/  # 14 file gói apply thủ công
│   ├── functions/          # 3 edge function (Deno): ai-chat, ai-embeddings, admin-create-user
│   └── config.toml
├── docs/                    # Toàn bộ tài liệu (149 file)
│   ├── CODEBASE_STRUCTURE.md   # ← file này
│   ├── DATABASE_SCHEMA.md, RBAC_REFACTOR.md, MIGRATIONS_CLEANUP.md
│   ├── BUSINESS_FLOW.md, cashbook-mobile-design.md, thu-chi-va-tai-khoan.md, morong.md
│   ├── he-thong/           # Tài liệu data + nghiệp vụ 14 domain
│   ├── history/            # Phase reports + IMPLEMENTATION_PLAN (lịch sử)
│   └── resident-docs/      # Tài liệu app tham chiếu (Resident/iHomeCRM)
├── scripts/                 # 3 script .mjs seed/inspect dữ liệu
├── public/                  # favicon, robots.txt, placeholder
├── .github/workflows/       # CI: supabase-migrate.yml
├── .kiro/specs/             # Spec cũ (design/requirements/tasks) — lịch sử, để nguyên
├── draft/                   # (gitignore) file dư thừa chờ xoá — xem draft/README.md
├── index.html               # HTML entry (preload font Baloo 2)
├── vite.config.ts · tailwind.config.ts · tsconfig*.json · eslint.config.js
├── components.json          # cấu hình shadcn/ui (alias @/components, @/ui…)
├── vercel.json              # security headers + SPA rewrite
├── package.json
├── CLAUDE.md                # workflow mặc định cho Claude Code
└── README.md
```

> Các thư mục bị `.gitignore` (không lên GitHub): `node_modules/`, `dist/`, `draft/`,
> `crawl-resident/`, `dataexcel/`, `.env.local`, `CLAUDE.local.md`, `.claude/settings.local.json`.

---

## 1. Stack & công cụ

| Lớp | Công nghệ |
|-----|-----------|
| **Build/Dev** | Vite ^5.4 (`@vitejs/plugin-react-swc`) — dev server port **8080**, alias `@/ → ./src/` |
| **UI** | React 18.3 + TypeScript 5.8, JSX `react-jsx` |
| **Style** | Tailwind 3.4 + `tailwindcss-animate` + PostCSS/Autoprefixer; design tokens (CSS var HSL) trong [src/index.css](../src/index.css) + [tailwind.config.ts](../tailwind.config.ts) |
| **Component lib** | shadcn/ui (Radix UI primitives) — cấu hình [components.json](../components.json); icon `lucide-react` |
| **Server state** | TanStack Query (`@tanstack/react-query` ^5) |
| **Routing** | `react-router-dom` ^6 |
| **Form + validate** | `react-hook-form` ^7 + `zod` ^3 (qua `@hookform/resolvers`) |
| **Backend SDK** | `@supabase/supabase-js` ^2 (Postgres + Auth + Storage) |
| **Tiện ích** | `date-fns`, `recharts`, `xlsx`+`docxtemplater`+`pizzip` (Excel/Word), `qrcode`/`@zxing`/`jsqr` (QR), `sonner` (toast) |
| **Test** | Vitest ^4 + `fast-check` (property-based) |
| **Dev tooling** | ESLint 9 flat config, `lovable-tagger` (gắn `data-lovable-*` ở mode dev) |

### Lệnh thường dùng

| Lệnh | Tác dụng |
|------|---------|
| `npm run dev` | Dev server → <http://localhost:8080> |
| `npm run build` | Build production (Vite, minified) |
| `npm run build:dev` | Build mode development (không minify) |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Type-check (Vite build **không** chạy tsc) |
| `npx vitest run <path>` | Chạy test (unit + property-based) |

> **TypeScript config**: `tsconfig.json` reference `tsconfig.app.json` (app, `strict: false`, ES2020)
> và `tsconfig.node.json` (config files, `strict: true`). Alias `@/* → ./src/*` khai báo cả ở
> tsconfig + vite + components.json.

### Entry point

```
index.html (#root) → src/main.tsx (createRoot) → src/App.tsx (providers + routes)
```

### scripts/ (chạy bằng node, không thuộc bundle)

| Script | Mục đích |
|--------|---------|
| [setup-attachment-bucket.mjs](../scripts/setup-attachment-bucket.mjs) | Tạo bucket storage `income-expense-attachments` |
| [seed-meter-and-services.mjs](../scripts/seed-meter-and-services.mjs) | Seed công tơ + 3 dịch vụ chuẩn (điện/nước/PDV) từ Excel — idempotent |
| [inspect-meter-excel.mjs](../scripts/inspect-meter-excel.mjs) | Debug: in header/row của file Excel |

---

## 2. App shell, routing & guards

### Provider stack ([src/App.tsx](../src/App.tsx))

```
QueryClientProvider → TooltipProvider → ErrorBoundary → Toaster (shadcn) + Sonner → BrowserRouter → Routes
```

[ErrorBoundary](../src/components/errors/ErrorBoundary.tsx) là class component bọc toàn app
(hiển thị fallback "Đã xảy ra lỗi" + nút Về trang chủ / Tải lại).

### 3 loại route

| Loại | Ví dụ | Wrapper |
|------|-------|---------|
| **Public auth** | `/login`, `/register`, `/forgot-password`, `/reset-password` | `<PublicRoute>` (đã login → đẩy về `/`) |
| **Public portal** | `/c/:code` (mã 6 ký tự QR hợp đồng → hoá đơn) | không cần auth |
| **Protected** | mọi route còn lại | `<ProtectedRoute>` (+ guard quyền nếu cần) |
| **404** | `path="*"` | `<NotFound />` (catch-all, không redirect) |

### Route guards ([src/components/auth/](../src/components/auth/))

| Guard | File | Logic |
|-------|------|-------|
| **ProtectedRoute** | [ProtectedRoute.tsx](../src/components/auth/ProtectedRoute.tsx) | `useAuth()`; chưa login → `/login` (giữ `state.from`); lắng nghe `SIGNED_OUT` |
| **PublicRoute** | [PublicRoute.tsx](../src/components/auth/PublicRoute.tsx) | đã login → `/` |
| **AdminOnlyRoute** | [AdminOnlyRoute.tsx](../src/components/auth/AdminOnlyRoute.tsx) | `useIsAdmin()`; không phải admin → fallback |
| **RequirePermission** | [RequirePermission.tsx](../src/components/auth/RequirePermission.tsx) | `useMyPermissions()` + `can(perms, module, action)`; super admin auto-pass |

**Pattern lồng guard** (ngoài → trong): `ProtectedRoute` > (`AdminOnlyRoute` \| `RequirePermission`) > `<Page/>`.
Ví dụ: `/finance/shareholder-profit` = `ProtectedRoute > RequirePermission(module="shareholder_profit") > ShareholderProfitPage`.

**Redirect/alias** (dùng `<Navigate replace/>` để chuẩn hoá URL): `/rooms→/apartments`,
`/tenants→/customers`, `/payments→/income-expense`, `/reservations→/deposits`,
`/cash-book→/reports/finance/daily-cashbook`…

### Layout ([src/components/layout/](../src/components/layout/))

[MainLayout](../src/components/layout/MainLayout.tsx) `(title, subtitle, icon, children)` bọc các page protected:
header sticky + sidebar (desktop cố định, mobile → `Sheet` drawer) + breadcrumb tự động + nội dung.

- [Header.tsx](../src/components/layout/Header.tsx) — logo, [NotificationBell](../src/components/layout/NotificationBell.tsx), user dropdown (profile/logout)
- [Sidebar.tsx](../src/components/layout/Sidebar.tsx) — nav theo nhóm (Theo dõi nhanh · Quản lý & vận hành · Báo cáo · Cài đặt · Tài khoản), section con dùng `Collapsible` auto-open theo route
- [Breadcrumbs.tsx](../src/components/layout/Breadcrumbs.tsx) — map `route → nhãn` + nhóm cha; segment UUID hiển thị "Chi tiết"

---

## 3. Tầng Pages — điểm vào route

**Quy ước**: mỗi file `src/pages/**` ↔ 1 route; page **mỏng** (state + hooks + quản lý dialog),
UI nặng tách xuống `components/`. 5 loại page:

| Loại | Naming | Bố cục điển hình |
|------|--------|------------------|
| **Danh sách** | `XxxsPage.tsx` | `MainLayout` › StatsCards › Toolbar › Filters › Table › Pagination › các Dialog |
| **Chi tiết** | `XxxDetailPage.tsx` | `useParams(id)` › header (back + action) › grid 2–3 cột (info + summary) › Dialog |
| **Form** | `XxxFormPage.tsx` | edit nếu có `id`; submit → mutation → `navigate(-1)` |
| **In** | `XxxPrintPage.tsx` | `useEffect` → `window.print()`; inline `@media print`; font serif |
| **Hub** | `XxxPage.tsx` (settings/reports) | grid card link, không có data |

### Nhóm thư mục `src/pages/`

```
Dashboard.tsx, NotFound.tsx, NotificationsPage.tsx, TaskManagementPage.tsx, FaqPage/ChangelogPage/AppGuidePage
auth/ account/ admin/ areas/ buildings/ rooms/ building-map/ services/
leads/ deposits/ contracts/ customers/ tenants/ vehicles/
meter-readings/ invoices/ payments/ finance/ materials/ assets/
public/                         # PublicContractInvoicePage (portal QR)
settings/                       # 8 page + hub
  categories/                   # 14 danh mục con (+ CategoryCrudPage generic, PlaceholderPage)
  finance/CashbooksPage.tsx
reports/
  RealEstateReportsPage.tsx · FinanceReportsPage.tsx   # 2 hub
  real-estate/                  # 9 report BĐS (vacant, occupancy, expiring, renewals, terminations, promotions, new-leases, expense-ratio…)
  finance/                      # 8 report tài chính (daily-cashbook, cash-flow, profit-distribution, customer-debt, deposits, overpayment, payment-schedule, debt)
```

---

## 4. Tầng Components — UI theo domain

`src/components/` chia theo **domain nghiệp vụ** + thư mục `ui/` dùng chung. Số file tiêu biểu:
`ui` 46 · `invoices` 22 · `income-expenses` 20 · `customers` 20 · `contracts` 19 · `materials` 12 ·
`meter-readings` 10 · `tasks`/`shareholders`/`buildings` 9 · `rooms` 7 · `leads`/`dashboard` 6 …

### Quy ước đặt tên (lặp lại giữa các domain)

| Mẫu | Vai trò | Ví dụ |
|-----|---------|-------|
| `XxxFormDialog` | form gộp tạo+sửa trong 1 dialog (kiểu mới, ưu tiên) | [ContractFormDialog](../src/components/contracts/ContractFormDialog.tsx), [RoomFormDialog](../src/components/rooms/RoomFormDialog.tsx), [VehicleFormDialog](../src/components/vehicles/VehicleFormDialog.tsx) |
| `CreateXxxDialog` / `EditXxxDialog` / `DeleteXxxDialog` | dialog từng thao tác | [EditInvoiceDialog](../src/components/invoices/EditInvoiceDialog.tsx), [DeleteContractDialog](../src/components/contracts/DeleteContractDialog.tsx) |
| `XxxListTable` / `XxxListFilters` / `XxxListToolbar` / `XxxListMobile` | bảng + lọc + thanh công cụ + bản mobile | [ContractListTable](../src/components/contracts/ContractListTable.tsx), [InvoiceListMobile](../src/components/invoices/InvoiceListMobile.tsx) |
| `XxxStatsCards` / `XxxStatsSummary` | card thống kê đầu danh sách | [ContractStatsCards](../src/components/contracts/ContractStatsCards.tsx), [InvoiceStatsSummary](../src/components/invoices/InvoiceStatsSummary.tsx) |
| `XxxForm` / `XxxSection` / `XxxFields` | form thuần / mảng UI con / nhóm field tái dùng | [CustomerForm](../src/components/customers/CustomerForm.tsx), [BuildingAddressSection](../src/components/buildings/BuildingAddressSection.tsx), [CustomerIndividualFields](../src/components/customers/CustomerIndividualFields.tsx) |
| `Xxx<Action>Dialog` | thao tác chuyên biệt | [ExtendContractDialog](../src/components/contracts/ExtendContractDialog.tsx), [TerminateContractDialog](../src/components/contracts/TerminateContractDialog.tsx), [TransferContractDialog](../src/components/contracts/TransferContractDialog.tsx) |

### Pattern form: React Hook Form + Zod

```tsx
const form = useForm<XxxFormData>({ resolver: zodResolver(xxxFormSchema), defaultValues });
useEffect(() => { if (open) form.reset(item ? mapToForm(item) : DEFAULTS); }, [open, item]);
const onSubmit  = (data) => { /* business rules ngoài Zod → gọi mutation */ };
const onInvalid = (errs) => { /* toast lỗi cho user thấy ngay */ };
// <Form {...form}><form onSubmit={form.handleSubmit(onSubmit, onInvalid)}>…<FormField .../></form></Form>
```

- **Schema** ở [src/lib/*Validation.ts](../src/lib/) (tách khỏi component để test thuần) — xem §6.2.
- **Validate 2 tầng**: Zod (type/required) + business rule trong `onSubmit` (vd cọc đủ, chỉ 1 khách đại diện) + RLS/trigger ở DB.
- **Dialog state**: page cha giữ `open` + `selectedItem`; dialog nhận `{ open, onOpenChange, item? }`; submit xong invalidate query → bảng tự cập nhật.

### `src/components/ui/` (46 file)

- **shadcn/ui primitives**: form, input, textarea, select, command, popover, dialog, alert-dialog, sheet, table, card, badge, tabs, accordion, tooltip, dropdown-menu, calendar, sonner, toaster…
- **Tiện ích tự viết**: [currency-input](../src/components/ui/currency-input.tsx) (VND `1.000.000 đ`), [date-input](../src/components/ui/date-input.tsx), [number-input](../src/components/ui/number-input.tsx), [month-input](../src/components/ui/month-input.tsx), [searchable-select](../src/components/ui/searchable-select.tsx) (combobox gõ-để-tìm, bỏ dấu tiếng Việt), [storage-image](../src/components/ui/storage-image.tsx) (signed URL), [data-table-pagination](../src/components/ui/data-table-pagination.tsx), [EmptyState](../src/components/ui/EmptyState.tsx).

> **Ô lọc** dùng `SearchableSelect` (không dùng `Select` thường); form & phân trang vẫn dùng `Select`.

---

## 5. Tầng Hooks — data access (React Query)

`src/hooks/` (~76 file) là **lớp truy cập dữ liệu duy nhất**: gọi Supabase client qua TanStack Query.
Component **không** chứa logic DB — chỉ gọi hook rồi render theo `loading/error/data`.

**Quy ước 1 hook-file ~ 1 entity**, gồm các biến thể: `useXxx()` (list + filter), `useXxx(id)`
(single, `enabled: !!id`), `useCreateXxx` / `useUpdateXxx` / `useDeleteXxx` (soft-delete) / `useBulkXxx`.
Mỗi file thường khai báo **`XXX_SELECT` string** ở đầu để eager-load relations (tránh N+1).

### Hooks theo nhóm

| Nhóm | Hook tiêu biểu |
|------|----------------|
| Auth & context | `useAuth`, `useProfile`, `useMyContext`, `useMyPermissions`, `useIsAdmin`, `useMyBuildingScope` |
| BĐS | `useBuildings`, `useAreas`, `useFloors`, `useRooms`, `useRoomsWithContracts`, `useServices`, `useBuildingServices` |
| Khách/Lead | `useCustomers`, `useLeads`, `useLeadActivities`, `useTenants`, `useVehicles`, `useCT01Declarations` |
| Hợp đồng | `useContracts`, `useContractOperations`, `useDeposits`, `useDepositDashboard`, `useCommissionVoucher` |
| Hoá đơn/Thu tiền | `useInvoices`, `useInvoicePayments`, `useInvoiceHistory`, `useBulkRecordPayment`, `usePayments`, `useDeletePayment` |
| Chỉ số | `useMeters`, `useMeterReadings`, `useMeterReadingsHelpers` |
| Thu/chi & quỹ | `useIncomeExpenses`(+`Helpers`), `useIncomeExpenseTypes`, `useIncomeExpenseTemplates`, `useCashBook`, `useAccounts`, `useAutoDebtConfig`, `usePersonalTransactions` |
| Cổ đông | `useShareholders`, `useShareholderProfit` |
| Tài sản/Kho | `useAssets`, `useAssetWarehouses`, `useMaterials`(+`Categories`/`Purchases`/`Usages`/`Adjustments`) |
| Công việc | `useJobs`, `useJobTypes`, `useJobGroups`, `useStaffAssignments` |
| Báo cáo/Dashboard | `useDashboard`, `useReports`, `useAccrualReport` |
| Cấu hình/khác | `useSettings`, `useRoles`, `useStaffUsers`, `useAdminUsers`, `useSubscription`, `useNotifications`, `useScheduledNotifications`, `useHotlines`, `useDocumentTemplates`, `useSignedUrl`, `usePagination`, `use-toast`, `use-mobile` |

### Hook cross-cutting (RBAC & tiện ích)

| Hook | Vai trò |
|------|---------|
| [useMyContext](../src/hooks/useMyContext.ts) | RPC `get_my_context()` → `{ isSuper, isStaff, ownerId, defaultAreaId }` (staff thấy context của mình dù RLS chặn query trực tiếp); cache 5′ |
| [useMyPermissions](../src/hooks/useMyPermissions.ts) | RPC `get_my_permissions()` → `{ module: { action: bool } }`; super admin = `{ __superadmin: true }`; helper `can()` gate UI |
| [useIsAdmin](../src/hooks/useIsAdmin.ts) | RPC `is_admin()`; mở khoá UI cấp admin |
| [useMyBuildingScope](../src/hooks/useMyBuildingScope.ts) | tập tòa được giao; `canManageBuilding(id)` ẩn/hiện nút theo từng dòng |
| [useSignedUrl](../src/hooks/useSignedUrl.ts) | path private → signed URL (tự refresh trước hạn); dùng helper [storage.ts](../src/lib/storage.ts) |
| [usePagination](../src/hooks/usePagination.ts) | state thuần (page/pageSize/offset) → query hook gọi `.range()` |

> **Helper thuần** trong hooks (`useIncomeExpensesHelpers`, `useMeterReadingsHelpers`) tách pure function
> để test không cần Supabase — có `__tests__/*.property.test.ts`.

**Error handling**: hầu hết mutation map lỗi qua [friendlyError()](../src/lib/friendlyError.ts) (Postgres code → tiếng Việt) rồi `toast.error`.

---

## 6. Tầng Lib, Types & Integration

### 6.1 `src/lib/` — validation, calculator, helper, util (47 file + 26 test)

| Nhóm | File tiêu biểu |
|------|----------------|
| **Validation (Zod)** | [contractValidation](../src/lib/contractValidation.ts), [invoiceValidation](../src/lib/invoiceValidation.ts), [customerValidation](../src/lib/customerValidation.ts), [buildingValidation](../src/lib/buildingValidation.ts), [roomValidation](../src/lib/roomValidation.ts), [meterReadingValidation](../src/lib/meterReadingValidation.ts), [incomeExpenseValidation](../src/lib/incomeExpenseValidation.ts), [vehicleValidation](../src/lib/vehicleValidation.ts), [jobValidation](../src/lib/jobValidation.ts), [ct01Validation](../src/lib/ct01Validation.ts) — mỗi file `export type XxxFormData = z.infer<…>` |
| **Calculator (pure)** | [prorateCalculation](../src/lib/prorateCalculation.ts) (chia theo ngày), [accrualAllocation](../src/lib/accrualAllocation.ts) (phân bổ theo tháng, cumulative rounding), [recurring](../src/lib/recurring.ts) (kỳ tái diễn WEEK/MONTH/QUARTER/YEAR), [shareholderProfit](../src/lib/shareholderProfit.ts), [invoiceUtils](../src/lib/invoiceUtils.ts) |
| **Helper (domain)** | [invoiceHelpers](../src/lib/invoiceHelpers.ts), [contractHelpers](../src/lib/contractCustomerHelpers.ts) (`contractCustomerHelpers.ts`), [contractServicePricing](../src/lib/contractServicePricing.ts), [leadHelpers](../src/lib/leadHelpers.ts), [ct01Helpers](../src/lib/ct01Helpers.ts), [firstInvoiceBuilder](../src/lib/firstInvoiceBuilder.ts), Excel: [excelHelpers](../src/lib/excelHelpers.ts)/[contractExcelHelpers](../src/lib/contractExcelHelpers.ts)/[customerExcelHelpers](../src/lib/customerExcelHelpers.ts)/[vehicleExcelHelpers](../src/lib/vehicleExcelHelpers.ts) |
| **Util chung** | [utils](../src/lib/utils.ts) (`cn`, format), [textMatch](../src/lib/textMatch.ts) (so khớp bỏ dấu Việt), [monthPeriod](../src/lib/monthPeriod.ts) (`<input type=month>` ↔ DATE), [codeGenerator](../src/lib/codeGenerator.ts) (mã DC/HD/INV/BBBG), [storage](../src/lib/storage.ts)+[storageKey](../src/lib/storageKey.ts), [friendlyError](../src/lib/friendlyError.ts), [permissions](../src/lib/permissions.ts) (registry nhóm × module cho PermissionMatrix), [qrDecoder](../src/lib/qrDecoder.ts)/[cccdQrParser](../src/lib/cccdQrParser.ts), [contractTemplateEngine](../src/lib/contractTemplateEngine.ts)/[invoiceTemplateEngine](../src/lib/invoiceTemplateEngine.ts) (render mẫu in) |
| **Test** | [src/lib/__tests__/](../src/lib/__tests__/) — 26 file, phần lớn `*.property.test.ts` (fast-check kiểm bất biến: tổng bảo toàn, không âm…) |

**Quy ước ngày tháng** (tránh bug timezone GMT+7): dùng cắt chuỗi `dateStr.slice(0,7)` / `Date.UTC(...)`,
**không** `new Date('YYYY-MM-DD')` — thể hiện rõ trong `monthPeriod.ts` & `accrualAllocation.ts`.

### 6.2 `src/types/` — domain types thủ công (9 file)

[contract.ts](../src/types/contract.ts), [invoice.ts](../src/types/invoice.ts), [customer.ts](../src/types/customer.ts),
[room.ts](../src/types/room.ts), [building.ts](../src/types/building.ts), [vehicle.ts](../src/types/vehicle.ts),
[material.ts](../src/types/material.ts), [jobs.ts](../src/types/jobs.ts), [jobTypes.ts](../src/types/jobTypes.ts).

Quy ước: `XxxStatus` (union string enum), `XxxWithRelations` (base + joins), `XxxFilters`, `XxxStats`.
Đây là tầng *semantic* — khác với types *structural* sinh tự động ở mục dưới.

### 6.3 `src/integrations/supabase/`

- [client.ts](../src/integrations/supabase/client.ts) — `createClient<Database>(URL, ANON_KEY, { auth: persistSession + autoRefresh })`, singleton dùng toàn app.
- [types.ts](../src/integrations/supabase/types.ts) — **auto-gen** từ `supabase gen types typescript` (Row/Insert/Update/Functions/Relationships); **không sửa tay**, regen sau migration.

---

## 7. Backend — Supabase

### 7.1 Migrations ([supabase/migrations/](../supabase/migrations/), 186 file)

- **Đặt tên**: `001`–`009` (core: extensions, enum, bảng nền, trigger, seed) → `012`–`035` (tính năng domain) →
  series `20250130/0601/0701/0703/0710` (reimplementation: meter, invoice, customer, building+room, lease) →
  series `20260426`–`20260603` (feature 2026: cashbooks, recurring thu/chi, cổ đông…) + **RBAC refactor** (`20260527`–`20260528`).
- **Soft delete**: cột `deleted_at TIMESTAMPTZ NULL`, mọi SELECT lọc `deleted_at IS NULL`.
- **Audit**: `user_id` (creator, set bằng trigger), `created_at`, `updated_at`.
- [migrations-bundle/](../supabase/migrations-bundle/) (14 file) = gói SQL apply thủ công; xem [docs/MIGRATIONS_CLEANUP.md](MIGRATIONS_CLEANUP.md).

### 7.2 RLS / RBAC

Chi tiết ở [docs/RBAC_REFACTOR.md](RBAC_REFACTOR.md) & [docs/he-thong/01](he-thong/01-phan-quyen-nhan-su.md). Tóm tắt:

```
auth.uid() → staff_assignments[role_id, building_id] → roles.permissions{module:{action:bool}}
           → helper can_access_building() / can_do_on_building() → bảng theo building scope
```

4 cấp: **Super admin** (bypass) · **Admin** (`__superadmin` hoặc role "Admin") · **Staff full-scope**
(`building_id IS NULL`) · **Staff theo tòa** (`building_id = X`). Helper trong DB:
`can_access_building()`, `can_do_on_building(table, action, building_id)`, `building_of_contract/invoice/payment()`.

> FE chỉ *gate UI* (ẩn nút) qua `useMyPermissions`/`useMyBuildingScope`; **DB RLS mới là chốt chặn thật**.
> RPC hợp đồng (renew/transfer/terminate) bọc wrapper kiểm quyền, logic gốc ở `*_impl`, revoke `anon`.

### 7.3 Edge functions ([supabase/functions/](../supabase/functions/), Deno)

| Function | Mục đích |
|----------|---------|
| [ai-chat](../supabase/functions/ai-chat/index.ts) | Chat AI assistant (OpenAI) — `{ message, conversation_id? }` |
| [ai-embeddings](../supabase/functions/ai-embeddings/index.ts) | Sinh embedding cho knowledge base |
| [admin-create-user](../supabase/functions/admin-create-user/index.ts) | Admin tạo user (auth + staff_assignments) |

### 7.4 RPC (gọi từ client thay vì INSERT/UPDATE trực tiếp)

`get_my_context()`, `get_my_permissions()`, `is_admin()`, `get_my_assignments()`,
`get_invoice_statistics_v2(...)`, `create_contract_action(...)`, `soft_delete_customer_rpc(...)`,
`delete_staff_member_rpc(...)`… — encapsulate logic phức tạp + `SECURITY DEFINER`.

### 7.5 Storage

7 bucket **private**; hiển thị ảnh **phải** qua `StorageImage`/`useSignedUrl` (không `<img src={publicUrl}>`).
Tên file qua [storageKey.sanitizeStorageFileName()](../src/lib/storageKey.ts) để tránh lỗi "Invalid key".

### 7.6 CI/CD

- [.github/workflows/supabase-migrate.yml](../.github/workflows/supabase-migrate.yml) — push migration vào `main` → CLI `supabase db push`.
- [vercel.json](../vercel.json) — security headers (HSTS, X-Frame-Options…) + SPA rewrite về `/index.html`.
- Frontend deploy tự động qua Vercel khi push `main`.

---

## 8. Quy ước nhanh (cheatsheet)

| Chủ đề | Quy ước |
|--------|---------|
| **Alias** | `@/` → `src/` |
| **Đặt tên** | Component/Page PascalCase; hook `useXxx`; validation `xxxValidation.ts`; helper `xxxHelpers.ts` |
| **Data flow** | Component → `useXxx()` (React Query) → `supabase` client → Postgres (RLS) |
| **Form** | `react-hook-form` + `zodResolver`; schema ở `src/lib/*Validation.ts` |
| **Phân quyền** | FE gate bằng `useMyPermissions`/`useMyBuildingScope`; DB enforce bằng RLS |
| **Soft delete** | `deleted_at IS NULL` ở mọi query |
| **Tiền tệ** | `CurrencyInput` + `formatCurrency` (VND) |
| **Ảnh private** | `StorageImage` / `useSignedUrl` |
| **Lỗi** | `friendlyError()` → `sonner` toast |
| **Ngày** | cắt chuỗi / `Date.UTC`, tránh `new Date(isoString)` |
| **Mã PT thanh toán** | giữ nguyên `TM/TT/TK` (không dịch, không icon) |
| **HĐ EXTENDED** | đối xử như `ACTIVE` ở mọi check (`isContractInEffect()`) |

## 9. Liên kết tài liệu

- [docs/he-thong/](he-thong/) — dữ liệu + nghiệp vụ 14 domain (bắt đầu ở [00-tong-quan](he-thong/00-tong-quan.md), luồng tổng [99](he-thong/99-quy-trinh-tong.md))
- [docs/DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) · [docs/RBAC_REFACTOR.md](RBAC_REFACTOR.md) · [docs/MIGRATIONS_CLEANUP.md](MIGRATIONS_CLEANUP.md)
- [docs/BUSINESS_FLOW.md](BUSINESS_FLOW.md) · [docs/history/](history/) (phase reports, kế hoạch cũ)
- [docs/resident-docs/](resident-docs/) — tài liệu app tham chiếu
- [CLAUDE.md](../CLAUDE.md) — workflow mặc định khi dùng Claude Code trên repo
