# Khách hàng · Lead (Khách hẹn) · Người thuê · Phương tiện · Tờ khai CT01

> Domain "đầu vào con người" của hệ thống: từ **khách tiềm năng (lead/khách hẹn)** đi qua phễu sale → **đặt cọc** → trở thành **khách hàng (customer)** đứng tên trên **hợp đồng**, kèm hồ sơ phương tiện và tờ khai cư trú CT01. Đây là gốc của mọi liên kết người-trong-hệ-thống: hợp đồng, cọc, hoá đơn, công việc (issue) đều tham chiếu ngược về các bảng ở đây.

---

## 1. Tổng quan & vai trò nghiệp vụ

Domain này quản lý **danh tính con người** ở 3 giai đoạn vòng đời và 2 hồ sơ phụ trợ:

| Giai đoạn / Hồ sơ | Bảng | Vai trò |
|---|---|---|
| Khách tiềm năng (phễu sale) | `leads`, `lead_activities` | Theo dõi lead từ lúc tiếp cận đến khi chốt/loại, có chấm điểm (lead_score) và nhật ký hoạt động |
| Khách hàng (hồ sơ chính thức) | `customers` | Hồ sơ đầy đủ (CCCD, địa chỉ, ngân hàng, ảnh giấy tờ); đứng tên hợp đồng |
| Người thuê (legacy) | `tenants` | Bảng cũ; vẫn được hợp đồng/cọc/hoá đơn FK tới; UI `/tenants` đã redirect sang `/customers` |
| Phương tiện | `vehicles` | Xe gắn với khách/hợp đồng/phòng (phí gửi xe, vé xe) |
| Tờ khai cư trú | `ct01_declarations` | Mẫu CT01 (thay đổi thông tin cư trú) in cho công an phường |
| Junction đại diện HĐ | `contract_customers`, `contract_tenants` | Nối nhiều khách/người thuê vào 1 hợp đồng, đánh dấu ai là **đại diện** |

**Điểm cốt lõi cần nhớ — quan hệ customers vs tenants (lịch sử kỹ thuật):**

- Ban đầu hệ thống dùng `tenants` làm hồ sơ người thuê. Hợp đồng (`contracts.tenant_id`), cọc (`deposits.tenant_id`), hoá đơn/thu chi (`income_expenses.tenant_id`), công việc (`issues.reported_by_tenant_id`) đều FK tới `tenants`.
- Sau này refactor sang `customers` làm hồ sơ chuẩn (45 cột, đầy đủ giấy tờ/địa chỉ/tổ chức). Liên kết khách ↔ hợp đồng chuyển sang junction `contract_customers` (xem [useContracts.ts](src/hooks/useContracts.ts) — `contracts.tenant_id` để NULL trên row mới, link thật nằm ở `contract_customers`).
- UI hợp nhất về "Khách hàng": route `/tenants` → `Navigate` sang `/customers`, `/tenants/:id` → `/customers/:id` (xem [App.tsx](src/App.tsx) `TenantToCustomerRedirect`). `TenantsPage` vẫn tồn tại nhưng tiêu đề hiển thị "Quản lý Khách hàng" và nút "Xem" trỏ tới `/customers/:id`.
- **Hệ quả tài liệu hoá:** `tenants` là *legacy nhưng còn sống* (nhiều FK đang trỏ vào). `customers` là *hồ sơ chính của UI hiện tại*. Hai bảng KHÔNG đồng bộ tự động; chúng tồn tại song song.

**Hai trục trạng thái của customers (đừng nhầm):**

- `status` (`customer_status`: `PROSPECT / ACTIVE / INACTIVE / BLACKLIST`) — trục cũ, mặc định `PROSPECT`, gần như không dùng trong UI hiện tại.
- `status_v2` (`customer_status_v2`: `RENTING / MOVED_OUT / WALK_IN`) — **trục đang dùng** cho tab lọc và mọi truy vấn ([CustomerStatusTabs.tsx](src/components/customers/CustomerStatusTabs.tsx)). Khách tạo mới luôn set `status_v2 = 'RENTING'` ([useCustomers.ts](src/hooks/useCustomers.ts)).

---

## 2. Cấu trúc dữ liệu

### 2.1. `leads` — Khách hẹn / khách tiềm năng

**Mục đích:** lưu khách tiềm năng và tiến trình phễu sale, có chấm điểm tự động.

Cột chủ chốt (xem `node .tmp/schema/cols.mjs leads`):

- **Định danh & liên hệ:** `customer_name` (NOT NULL), `phone` (NOT NULL), `email`, `notes`.
- **Phễu sale:** `status` (`lead_status`, default `B1_LEAD`), `source` (`lead_source`), `lead_score` (int, default 0 — do trigger tính), `lost_reason` (lý do thất bại), `conversion_date`.
- **Nhu cầu thuê:** `budget_min`/`budget_max` (numeric), `move_in_date`, `num_occupants` (default 1), `preferred_room_type`, `appointment_date` (lịch hẹn xem nhà).
- **Theo dõi:** `last_contact_date`, `next_follow_up_date`, `assigned_staff_id` (nhân viên phụ trách).
- **Nguồn giới thiệu:** `referrer_name`, `ctv_name` (cộng tác viên), `finder_name`.
- **Liên kết kết quả:** `deposit_id` (cọc sinh ra khi convert), `contract_id` (HĐ nếu đã ký), `building_id`, `room_id` (căn hộ quan tâm).
- **Hệ thống:** `user_id` (owner/tenant), `id/created_at/updated_at`, `deleted_at` (soft delete).

**Enum:** `lead_status` = `B1_LEAD → B2_APPOINTMENT → B3_CONSULTATION → CONVERTED / FAILED`; `lead_source` = `FACEBOOK, ZALO, PHONE, REFERRAL, WALK_IN, WEBSITE, OTHER`.

**FK đi ra:** `assigned_staff_id → profiles`, `building_id → buildings`, `room_id → rooms`, `contract_id → contracts`, `deposit_id → deposits`.
**Được tham chiếu bởi:** `lead_activities.lead_id`.

### 2.2. `lead_activities` — Nhật ký hoạt động lead

**Mục đích:** lịch sử tương tác với từng lead (gọi điện, hẹn, đổi trạng thái…).

Cột chủ chốt: `lead_id` (NOT NULL), `activity_type` (varchar — không phải enum, giá trị do FE chuẩn hoá: `CALL/EMAIL/SMS/ZALO/MEETING/VIEWED_ROOM/NOTE/STATUS_CHANGE/FOLLOW_UP/CREATED` định nghĩa trong [leadHelpers.ts](src/lib/leadHelpers.ts) `LEAD_ACTIVITY_TYPES`), `description`, `old_value`/`new_value` (jsonb — dùng để log đổi trạng thái), `performed_by`, `scheduled_at`/`completed_at`, `notes`. `user_id` để RLS.

**FK đi ra:** `lead_id → leads`.

### 2.3. `customers` — Hồ sơ khách hàng (chính)

**Mục đích:** hồ sơ pháp lý đầy đủ của khách (cá nhân hoặc tổ chức) để ký hợp đồng, xuất CT01.

Cột chủ chốt (45 cột — chỉ nêu nhóm có ý nghĩa nghiệp vụ):

- **Loại & tên:** `customer_type` (`INDIVIDUAL/ORGANIZATION`, default INDIVIDUAL), `full_name` (NOT NULL — với tổ chức để rỗng), `company_name`, `representative` (người đại diện tổ chức).
- **Liên hệ:** `phone` (NOT NULL), `email`.
- **Giấy tờ tuỳ thân:** `id_type` (`CCCD/CMND/PASSPORT/OTHER`, default CCCD), `id_number`, `id_issue_date`, `id_issue_place`, `id_images` (jsonb `{front, back}` — ảnh CCCD), `fingerprint_code` (mã vân tay).
- **Nhân khẩu:** `date_of_birth`, `gender`, `is_foreign` (khách nước ngoài).
- **Địa chỉ:** `province/district/ward/detailed_address`, `current_residence` (chỗ ở hiện tại), `permanent_address` (thường trú), `headquarters_address` (trụ sở tổ chức).
- **Tài chính/nghề:** `bank_account_number`, `bank_name`, `occupation`, `workplace`.
- **Liên hệ phụ:** `contact_person`/`contact_person_phone`, `advisor`/`advisor_phone` (người tư vấn), `emergency_contact_name/_phone/_relationship` (liên hệ khẩn cấp).
- **Trạng thái:** `status` (cũ — `customer_status`), **`status_v2`** (đang dùng — `customer_status_v2`, default RENTING).
- **Khác:** `customer_group`, `notes`, `avatar_url`, `business_registration_url` (giấy phép KD), `vehicles` (jsonb — danh sách xe nhập kèm khi tạo, KHÔNG phải bảng `vehicles`).
- **Hệ thống:** `user_id`, `id/created_at/updated_at`, `deleted_at` (soft delete).

**Enum:** `customer_type`, `id_type`, `customer_status`, `customer_status_v2`.

**Được tham chiếu bởi:** `contract_customers.customer_id`, `ct01_declarations.customer_id`, `vehicles.customer_id`.

### 2.4. `tenants` — Người thuê (legacy, còn FK sống)

**Mục đích:** hồ sơ người thuê đời cũ. Vẫn là đích FK của nhiều bảng vận hành.

Cột chủ chốt: `full_name` (NOT NULL), `phone` (NOT NULL), `email`, `id_number`/`id_type`, `date_of_birth`, `gender`, `permanent_address`, `status` (`tenant_status`: `PROSPECT/DEPOSITED/ACTIVE/INACTIVE/BLACKLIST`), `emergency_contact_*`, `avatar_url`, `id_images` (jsonb), `notes`. `user_id`, soft delete qua `deleted_at`.

> Lưu ý: enum DB `tenant_status` chỉ có `PROSPECT/DEPOSITED/ACTIVE/INACTIVE/BLACKLIST`, nhưng `TenantsPage` còn render tab `MOVED_OUT`/`BLACKLISTED` (giá trị không khớp enum → count luôn 0). Đây là tàn dư UI cũ.

**Được tham chiếu bởi:** `contracts.tenant_id`, `deposits.tenant_id`, `income_expenses.tenant_id`, `issues.reported_by_tenant_id`, `contract_tenants.tenant_id`, `contract_transfers.old_tenant_id`/`new_tenant_id`, `vehicles.tenant_id`.

### 2.5. `vehicles` — Phương tiện

**Mục đích:** quản lý xe của khách (chủ yếu xe máy), phí gửi xe, vé xe theo phòng/HĐ.

Cột chủ chốt: `vehicle_type` (NOT NULL — `MOTORBIKE/CAR/BICYCLE/OTHER/ELECTRIC_BIKE`), `vehicle_name` (dòng xe), `brand`/`model`/`color`, `license_plate` (biển số), `owner_name`, `ticket_number` (số vé xe), `parking_fee` (numeric, default 0), `images` (jsonb)/`image_url`, `notes`. Liên kết: `customer_id`, `tenant_id`, `contract_id`, `building_id`, `room_id`. `user_id`, soft delete `deleted_at`.

**Enum:** `vehicle_type`.
**FK đi ra:** `customer_id → customers`, `tenant_id → tenants`, `contract_id → contracts`, `building_id → buildings`, `room_id → rooms`.

> UI `VehiclesPage` hiện **ẩn bộ lọc loại xe và ghim cứng `vehicle_type = 'MOTORBIKE'`** (xem [VehiclesPage.tsx](src/pages/vehicles/VehiclesPage.tsx) `EMPTY_FILTERS` + `handleFiltersChange`).

### 2.6. `ct01_declarations` — Tờ khai thay đổi thông tin cư trú (CT01)

**Mục đích:** lưu nội dung tờ khai CT01 để in nộp công an, lập từ hồ sơ một khách.

Cột chủ chốt: `customer_id` (NOT NULL), `registration_authority` (cơ quan đăng ký — NOT NULL), khối thông tin người khai (`full_name/date_of_birth/gender/id_number` NOT NULL, `phone/email`), khối địa chỉ (`permanent_address/temporary_address/current_address`), `occupation_workplace`, khối chủ hộ (`household_head_name/_relationship/_id_number`), `request_content` (nội dung đề nghị), `family_members` (jsonb — danh sách thành viên cùng khai). `user_id`, `id/created_at/updated_at` (KHÔNG có soft delete).

**FK đi ra:** `customer_id → customers`.

### 2.7. `contract_customers` & `contract_tenants` — Junction đại diện hợp đồng

**Mục đích:** một hợp đồng có thể có nhiều khách/người thuê; junction đánh dấu ai là **đại diện** (`is_representative`).

- `contract_customers`: `contract_id` + `customer_id` (cả hai NOT NULL), `is_representative` (default false), `notes`. → đây là **link chính** giữa khách và hợp đồng trong code hiện tại.
- `contract_tenants`: `contract_id` + `tenant_id`, `is_representative`, `move_in_date` (ngày dọn vào của người thuê đó), `notes`. → junction legacy, đi với bảng `tenants`. Trong frontend hầu như chỉ xuất hiện trong type generated; logic chính dùng `contract_customers`.

**FK đi ra:** `contract_id → contracts`; `customer_id → customers` / `tenant_id → tenants`.

---

## 3. Sơ đồ quan hệ dữ liệu

```mermaid
erDiagram
    leads ||--o{ lead_activities : "ghi nhật ký"
    leads }o--o| deposits : "convert sinh cọc (deposit_id)"
    leads }o--o| contracts : "đã ký (contract_id)"
    leads }o--o| rooms : "căn quan tâm"

    customers ||--o{ contract_customers : "đứng tên HĐ"
    customers ||--o{ vehicles : "sở hữu xe"
    customers ||--o{ ct01_declarations : "khai cư trú"
    contracts ||--o{ contract_customers : "gồm nhiều khách"

    tenants ||--o{ contract_tenants : "legacy link HĐ"
    tenants ||--o{ vehicles : "legacy chủ xe"
    contracts ||--o{ contract_tenants : "legacy"
    tenants }o--o{ contracts : "tenant_id (legacy FK)"

    vehicles }o--o| rooms : "gửi tại phòng"
    vehicles }o--o| contracts : "thuộc HĐ"

    leads {
        uuid id
        text customer_name
        text phone
        lead_status status
        lead_source source
        int lead_score
        uuid deposit_id
        uuid contract_id
    }
    customers {
        uuid id
        customer_type customer_type
        text full_name
        customer_status_v2 status_v2
        jsonb id_images
    }
    contract_customers {
        uuid contract_id
        uuid customer_id
        bool is_representative
    }
    vehicles {
        uuid id
        vehicle_type vehicle_type
        text license_plate
        numeric parking_fee
    }
```

Phễu chuyển đổi tổng quát (lead → cọc → khách + HĐ):

```mermaid
flowchart TD
    L["leads (khách hẹn)<br/>status = B1_LEAD"] -->|"B2_APPOINTMENT<br/>B3_CONSULTATION"| L2["Đang tư vấn"]
    L2 -->|"ConvertLeadDialog"| D["deposits (cọc)<br/>+ tenant mới (status DEPOSITED)"]
    D -->|"set status = CONVERTED"| L3["leads.status = CONVERTED"]
    L2 -->|"không chốt"| F["leads.status = FAILED<br/>+ lost_reason"]
    D -.->|"ký hợp đồng (domain HĐ)"| C["contracts<br/>+ contract_customers"]
    C --> CU["customers đứng tên<br/>(is_representative)"]
```

---

## 4. Quy tắc nghiệp vụ & tự động hoá

### 4.1. Chấm điểm lead — trigger `update_lead_score` + RPC `calculate_lead_score`

Định nghĩa trong [029_missing_features.sql](supabase/migrations/029_missing_features.sql).

- **Trigger `trigger_update_lead_score`** chạy **BEFORE INSERT OR UPDATE** trên `leads`, gọi `update_lead_score()`, gán thẳng `NEW.lead_score`. Nghĩa là mọi lần tạo/sửa lead, điểm được tính lại tự động, FE không cần gửi `lead_score`.
- **Thang điểm (tối đa 100):**
  - Ngân sách: có `budget_max` +30, chỉ có `budget_min` +15.
  - Lịch hẹn: `appointment_date` tương lai +25, quá khứ +10.
  - Nguồn: REFERRAL 20 / WALK_IN 18 / WEBSITE 15 / FACEBOOK·ZALO 12 / PHONE 10 / OTHER 5 (trong SQL trigger).
  - Tiến trình: CONVERTED +20, B3 +15, B2 +10, B1 +5, FAILED +0.
  - Email +5; `move_in_date` trong 30 ngày +5.
- **RPC `calculate_lead_score(lead_id)`** (read-only) tính lại điểm từ record đã có — dùng cho backfill (`UPDATE leads SET lead_score = calculate_lead_score(id)` ở cuối migration).
- **Lưu ý lệch FE/DB:** [leadHelpers.ts](src/lib/leadHelpers.ts) `calculateLeadScore()` có thang **status hơi khác** (statusScore tối đa 15, CONVERTED=15) so với SQL (status tối đa 20). FE dùng bản này chỉ để **hiển thị** breakdown/màu/nhãn; điểm lưu DB luôn theo trigger. Khi cần con số "thật" lấy `leads.lead_score`.

### 4.2. Một đại diện duy nhất mỗi HĐ — trigger `check_contract_representative`

Định nghĩa trong [20250710000001_lease_contract_management.sql](supabase/migrations/20250710000001_lease_contract_management.sql).

- Trigger `ensure_single_representative` chạy **BEFORE INSERT OR UPDATE** trên `contract_customers`. Khi `NEW.is_representative = true`, nó **tự bỏ cờ đại diện của mọi row khác cùng `contract_id`**.
- **Bất biến:** mỗi hợp đồng có tối đa một `contract_customers.is_representative = true`. (Không ép buộc *ít nhất một* — nếu không tick ai thì không có đại diện.)
- `contract_tenants` cũng có cột `is_representative` nhưng không thấy trigger tương ứng cho bảng legacy này.

### 4.3. Soft delete khách — RPC `soft_delete_customer`

Định nghĩa trong [20250702000002_soft_delete_customer_rpc.sql](supabase/migrations/20250702000002_soft_delete_customer_rpc.sql).

- `SECURITY DEFINER`, chỉ set `deleted_at = NOW()` khi `user_id = auth.uid()` và row chưa bị xoá; nếu không khớp → `RAISE EXCEPTION 'Customer not found or not authorized'`.
- FE gọi qua `useDeleteCustomer` ([useCustomers.ts](src/hooks/useCustomers.ts)) → `supabase.rpc('soft_delete_customer', { p_customer_id })`.
- **Bất biến:** mọi truy vấn khách trong UI đều `.is("deleted_at", null)` ⇒ khách "đã xoá" biến mất khỏi danh sách nhưng KHÔNG mất khỏi DB (giữ tham chiếu HĐ/hoá đơn).
- Lead, tenant, vehicle cũng soft-delete nhưng **không qua RPC** — chỉ `update({ deleted_at })` trực tiếp (xem `useDeleteLead`, `useDeleteTenant`, `useDeleteVehicle`).

### 4.4. RLS scope cho staff — `customer_in_my_scope` & `staff_in_building`

Định nghĩa trong [20260518000051_staff_building_scope_writes.sql](supabase/migrations/20260518000051_staff_building_scope_writes.sql).

- **`customer_in_my_scope(_owner, _customer_id)`** trả `true` khi: caller là owner / admin / staff "tất cả tòa" (`staff_assignments.building_id IS NULL`); HOẶC khách **chưa có hợp đồng còn sống** (fallback để không khoá việc tạo/sửa khách mới); HOẶC có **ít nhất một HĐ còn sống** của khách nằm ở tòa caller được giao.
- Policy `customers_staff_update`/`customers_staff_delete` = `staff_can('customers','edit'/'delete')` **AND** `customer_in_my_scope(...)`. INSERT chỉ cần `staff_can('customers','create')`.
- `vehicles` siết theo `staff_in_building(user_id, building_id)`; `contracts` siết theo building của `rooms.building_id`.
- **Hệ quả với FE:** danh sách (`SELECT`) mở cho mọi staff cùng owner, nhưng nút Sửa/Xoá có thể bị RLS chặn nếu ngoài scope. `useMyBuildingScope`/`hasAnyScope` được `VehiclesPage` dùng để ẩn nút "Thêm phương tiện" khi staff không có scope nào.
- `lead_activities` dùng RLS đơn giản hơn: chỉ `user_id = auth.uid()` cho mọi thao tác (xem [029_missing_features.sql](supabase/migrations/029_missing_features.sql)).

### 4.5. Liên kết khách ↔ hợp đồng được tạo ở domain Hợp đồng

Khi tạo HĐ ([useContracts.ts](src/hooks/useContracts.ts)): insert `contracts` (để `tenant_id` NULL), rồi batch insert `contract_customers` (mỗi khách 1 row, đánh dấu đại diện). Trang chi tiết khách đọc ngược lại junction này để hiện danh sách HĐ. `create_tenant_transfer` ([014_contract_transfers.sql](supabase/migrations/014_contract_transfers.sql)) là helper legacy đổi `tenants` trên HĐ (ghi `contract_transfers` với `old/new_tenant_id`), không thuộc luồng customers mới.

---

## 5. Quy trình theo từng trang (page)

### 5.1. `/leads` — [LeadsPage.tsx](src/pages/leads/LeadsPage.tsx)

**Mục đích:** bảng Kanban 5 cột theo `lead_status`, theo dõi phễu sale.

**Dữ liệu:** `useLeads()` ([useLeads.ts](src/hooks/useLeads.ts)) — select `leads` + embed `building`, `room(+building)`, sort `created_at` desc. (Lưu ý: hook **không** lọc `deleted_at`, dù delete là soft.) Lọc client-side theo tên/SĐT/email/căn/tòa; chia cột bằng `getLeadsByStatus`.

**Thao tác từng-bước:**

1. **Tạo lead** → `CreateLeadDialog` → `useCreateLead` insert kèm `user_id` → trigger tính `lead_score` → invalidate `["leads"]`.
2. **Sửa** → `EditLeadDialog` → `useUpdateLead` (re-tính điểm qua trigger).
3. **Xem chi tiết** → `LeadDetailDialog` (hiển thị breakdown điểm + timeline `useLeadActivities`).
4. **Convert** → `ConvertLeadDialog` (xem flow dưới).
5. **Xoá** → `confirm()` → `useDeleteLead` set `deleted_at`.
6. **Xuất Excel** → `ExportExcelDialog exportType="leads"`.

**Convert lead → cọc** ([ConvertLeadDialog.tsx](src/components/leads/ConvertLeadDialog.tsx)):

```mermaid
flowchart TD
    A["Mở ConvertLeadDialog"] --> B{"Tạo khách mới?"}
    B -->|"Có"| C["useCreateTenant<br/>status = DEPOSITED"]
    B -->|"Không"| D["Chọn tenant có sẵn<br/>(useTenantsLegacy)"]
    C --> E["useCreateDeposit<br/>(tenant_id, room_id, amount,<br/>deposit_date, hold_until_date, PENDING)"]
    D --> E
    E --> F["useConvertLeadToDeposit<br/>set leads.status = CONVERTED"]
    F --> G["đóng dialog, invalidate"]
```

- **Validate (zod `convertSchema`):** `room_id` bắt buộc, `amount >= 0`, `deposit_date` & `hold_until_date` bắt buộc.
- **Edge case:** không chọn/không tạo tenant → throw `"Phải chọn hoặc tạo khách hàng"`. Lưu ý convert tạo **tenant** (bảng legacy) + **deposit**, KHÔNG tạo bản ghi `customers`; `useConvertLeadToDeposit` hiện chỉ đổi `status`, **không** gắn `deposit_id` ngược lại lead.

### 5.2. `/customers` — [CustomersPage.tsx](src/pages/customers/CustomersPage.tsx)

**Mục đích:** danh sách khách hàng có tab trạng thái, thẻ thống kê, lọc vị trí, phân trang, import/export.

**Dữ liệu:**
- `useCustomers(effectiveFilters, {page,pageSize})` — lọc `status_v2` theo tab; `statFilter` (ALL/INDIVIDUAL/ORGANIZATION/FOREIGN); search `full_name/phone/email/id_number`; lọc building/room qua `contract_customers`; phân trang `range`. Sau khi lấy trang, **enrich** thêm tòa/phòng hiện tại từ HĐ còn-hiệu-lực (`isContractInEffect`).
- `useCustomerStats(statsFilters)` — đếm total/individual/organization/foreign.

**Thao tác:**
1. **Đổi tab** (`RENTING/MOVED_OUT/WALK_IN`) → reset statFilter & page=1.
2. **Click thẻ thống kê** → set `statFilter`.
3. **Thêm** → điều hướng `/customers/new`.
4. **Xem** → `CustomerDetailModal`; **Sửa** → `/customers/:id/edit`; **Xoá** → `DeleteCustomerDialog`.
5. **Import** → `CustomerImportExportDialog`; mỗi dòng `useCreateCustomer.mutateAsync` (mặc định INDIVIDUAL), tải ảnh CCCD từ URL cột L (`uploadIdImagesFromUrls`) rồi update `id_images`; gom kết quả thành công/thất bại; map mã lỗi PG (`23505`→trùng SĐT/CCCD, `23514`→SĐT sai định dạng, `22008`→ngày sai).
6. **Export** → `exportCustomers`.

> **Lưu ý lọc vị trí bị vô hiệu:** `resolveCustomerIdsByLocation` hiện trả `[]` ngay (biến `contractIds` luôn rỗng) ⇒ chọn building/room sẽ ra **0 khách**. Đây là điểm cần biết khi đọc/đối chiếu hành vi.

### 5.3. `/customers/new` & `/customers/:id/edit` — [CustomerFormPage.tsx](src/pages/customers/CustomerFormPage.tsx)

**Mục đích:** tạo/sửa hồ sơ khách qua `CustomerForm`.

- Edit: `useCustomer(id)` nạp default values; build `id_images` chỉ khi là object (mảng `[]` legacy → undefined để zod không reject).
- Validate: `customerSchema` (discriminatedUnion theo `customer_type` — [customerValidation.ts](src/lib/customerValidation.ts)): INDIVIDUAL cần `full_name`; ORGANIZATION cần `company_name`; cả hai cần `phone` khớp `^[0-9]{10,11}$`, email hợp lệ nếu nhập.
- Submit: `useCreateCustomer` (set `status_v2='RENTING'`, tách `vehicles` inline insert sang bảng `vehicles`) hoặc `useUpdateCustomer`; thành công → `navigate('/customers')`.
- Edge case: lỗi `23505` → toast "SĐT hoặc CCCD đã tồn tại".

### 5.4. `/customers/:id` — [CustomerDetailPage.tsx](src/pages/customers/CustomerDetailPage.tsx)

**Mục đích:** trang chi tiết khách (thông tin cá nhân, ảnh CCCD, địa chỉ, phương tiện, hợp đồng, liên hệ khẩn cấp, ghi chú).

- Dữ liệu: `useCustomer(id)`; `useVehicles({customer_id:id})`; query riêng `customer-contracts` đọc `contract_customers` → embed `contract(+room+building)`, lọc bỏ HĐ `deleted_at`.
- Ảnh CCCD render bằng `StorageImage` (bucket private + signed URL — đúng quy ước bảo mật).
- Thao tác: Sao chép thông tin (clipboard), Sửa, **Mẫu CT01** (`/customers/:id/ct01`), Xoá (`DeleteCustomerDialog` → `soft_delete_customer`). Badge HĐ map trạng thái (ACTIVE/EXTENDED/TRANSFERRED/TERMINATED/EXPIRED/DRAFT), cờ "Đại diện" lấy từ `is_representative`.

### 5.5. `/customers/:id/ct01` — [CT01FormPage.tsx](src/pages/customers/CT01FormPage.tsx)

**Mục đích:** lập + in tờ khai CT01 từ hồ sơ khách.

- Dữ liệu: `useCustomer(id)` (đổ sẵn vào form), `useCreateCT01Declaration`.
- Validate `ct01Schema` ([ct01Validation.ts](src/lib/ct01Validation.ts)): bắt buộc `registration_authority`, `full_name`, `date_of_birth`, `gender`, `id_number`; `family_members` mặc định `[]`.
- Bước: submit → `createDeclaration.mutateAsync({customerId, data})` lưu vào `ct01_declarations` → set `printData` → `setTimeout(window.print,100)` in `CT01PrintLayout`. Nút "Chỉ in" in lại không lưu thêm.
- Edge case: không có khách → "Không tìm thấy khách hàng".

### 5.6. `/tenants` (legacy) — [TenantsPage.tsx](src/pages/tenants/TenantsPage.tsx)

**Mục đích:** trang người-thuê cũ; route `/tenants` đã `Navigate` → `/customers`, nên page chỉ truy cập nội bộ/legacy.

- Dữ liệu: `useTenants({status}, {page,pageSize})` — lọc `tenants` theo `status`, `.is(deleted_at,null)`, phân trang.
- Thao tác: Thêm (`CreateTenantDialog`), Sửa (`EditTenantDialog`), Xoá (`DeleteTenantDialog` → `useDeleteTenant` soft delete), Xem → `/customers/:id`.
- Edge case: tab `MOVED_OUT`/`BLACKLISTED` không khớp enum `tenant_status` → count = 0.

### 5.7. `/vehicles` — [VehiclesPage.tsx](src/pages/vehicles/VehiclesPage.tsx)

**Mục đích:** danh sách phương tiện (đang ghim cứng `MOTORBIKE`), tìm kiếm, lọc, phân trang.

- Dữ liệu: `useVehicles(filters, {page,pageSize})` ([useVehicles.ts](src/hooks/useVehicles.ts)) — embed `customer/building/room`, `.is(deleted_at,null)`. Search ghép biển số/tên xe/owner + `customer_id.in.(…)` từ khách khớp tên (vì PostgREST `.or()` không OR xuyên bảng embed).
- Thao tác: Thêm/Sửa (`VehicleFormDialog`), Xoá (`DeleteVehicleDialog` → `useDeleteVehicle` soft delete), lọc (mobile drawer `VehicleFilterPanel`).
- RLS/UI: `useMyBuildingScope().hasAnyScope` ẩn nút "Thêm" khi staff không có scope (khớp policy `vehicles_staff_*` + `staff_in_building`).

---

## 6. Liên kết sang domain khác (vào / ra)

**Ra (domain này tham chiếu sang nơi khác):**

- `leads.building_id/room_id` → **Toà nhà & Căn hộ**: căn hộ khách quan tâm.
- `leads.deposit_id` → **Đặt cọc**; `leads.contract_id` → **Hợp đồng**: kết quả convert/ký.
- `leads.assigned_staff_id` → **Người dùng/Nhân sự** (`profiles`).
- `vehicles.building_id/room_id` → **Toà nhà & Căn hộ**: nơi gửi xe; `vehicles.contract_id` → **Hợp đồng**.
- `contract_customers.contract_id` / `contract_tenants.contract_id` → **Hợp đồng**.

**Vào (domain khác trỏ về đây):**

- **Hợp đồng** ↔ `customers` qua `contract_customers` (link chính, có đại diện) và `contracts.tenant_id` → `tenants` (legacy). `contract_transfers.old/new_tenant_id` → `tenants` khi chuyển nhượng.
- **Đặt cọc** (`deposits.tenant_id`) → `tenants`: cọc gắn người thuê; convert lead tạo deposit + tenant.
- **Hoá đơn / Thu chi** (`income_expenses.tenant_id`) → `tenants`: dòng tiền gắn người thuê.
- **Công việc / Sự cố** (`issues.reported_by_tenant_id`) → `tenants`: ai báo sự cố.

**Lý do liên kết:** domain này là **nguồn danh tính** của hệ thống — mọi nghiệp vụ vận hành (ký HĐ, thu cọc, xuất hoá đơn, ghi nhận chỉ số, mở công việc) đều phải quy về một con người/tổ chức cụ thể, hoặc ở dạng hồ sơ chuẩn (`customers`) hoặc ở dạng legacy còn FK sống (`tenants`).
