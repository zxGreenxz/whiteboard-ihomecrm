# Database Schema — whiteboard-ihomecrm

> **Nguồn**: dump trực tiếp từ Supabase (project `tryymsxyyckgbrmmvozx`) ngày 2026-05-28.
> Đây là **tham chiếu chính thức** về cấu trúc database. Khi viết code mới, query mới, hoặc migration mới — đọc file này trước.

## Mục lục

1. [Tổng quan](#1-tổng-quan)
2. [Enum types](#2-enum-types)
3. [Domain → Tables](#3-domain--tables)
4. [Bảng chi tiết](#4-bảng-chi-tiết)
5. [Helper functions (RBAC)](#5-helper-functions-rbac)
6. [RPCs công khai](#6-rpcs-công-khai-frontend-gọi)
7. [Triggers tổng hợp](#7-triggers-tổng-hợp)
8. [Views](#8-views)
9. [Quan hệ tổng (FK graph)](#9-quan-hệ-tổng-fk-graph)
10. [Mô hình phân quyền (RBAC)](#10-mô-hình-phân-quyền-rbac)

---

## 1. Tổng quan

| Hạng mục | Số lượng |
|---|---|
| Tables | 82 |
| Tables có RLS | 82 |
| Columns | 1242 |
| Foreign keys | 142 |
| Enums | 31 |
| Functions (RPC + trigger fn) | 252 |
| Triggers | 150 |
| RLS policies | 467 |
| Indexes | 437 |
| Views | 5 |

**Mô hình phân quyền**: pure RBAC (xem [RBAC_REFACTOR.md](RBAC_REFACTOR.md)).
- Access control qua `staff_assignments` (staff_id → role + building_id scope) + `super_admins`.
- Cột `user_id` trên data tables = audit-only (set tự động bởi trigger), không tham gia quyết định quyền.
- RLS policies tên `*_rbac` dùng helper `can_access_building` / `can_do_on_building` / `can_access_org_entity`.

## 2. Enum types

Tổng **31 enum** trong schema public:

| Enum | Giá trị |
|---|---|
| `ai_message_role` | `user`, `assistant`, `system` |
| `asset_condition` | `NEW`, `GOOD`, `FAIR`, `POOR`, `BROKEN` |
| `bed_status` | `AVAILABLE`, `OCCUPIED`, `RESERVED`, `MAINTENANCE`, `UNAVAILABLE` |
| `building_status` | `ACTIVE`, `INACTIVE`, `MAINTENANCE` |
| `building_type` | `APARTMENT`, `DORMITORY`, `HOUSE`, `OFFICE`, `SLEEPBOX`, `HOMESTAY` |
| `contract_status` | `DRAFT`, `ACTIVE`, `EXTENDED`, `TRANSFERRED`, `TERMINATED`, `EXPIRED` |
| `customer_status` | `PROSPECT`, `ACTIVE`, `INACTIVE`, `BLACKLIST` |
| `customer_status_v2` | `RENTING`, `MOVED_OUT`, `WALK_IN` |
| `customer_type` | `INDIVIDUAL`, `ORGANIZATION` |
| `deposit_status` | `PENDING`, `CONFIRMED`, `CONVERTED`, `REFUNDED`, `FORFEITED` |
| `expense_category` | `MAINTENANCE`, `REPAIR`, `UTILITIES`, `SALARY`, `SUPPLIES`, `OTHER` |
| `fee_type` | `TIEN_PHI_DICH_VU`, `TIEN_DIEN`, `TIEN_NUOC`, `TIEN_PHI_KHAC`, `TIEN_VE_SINH` |
| `id_type` | `CCCD`, `CMND`, `PASSPORT`, `OTHER` |
| `invoice_item_type` | `RENT`, `SERVICE`, `PENALTY`, `DISCOUNT`, `OTHER` |
| `invoice_status` | `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `PAID`, `PARTIAL_PAID`, `OVERDUE`, `CANCELLED` |
| `issue_priority` | `LOW`, `MEDIUM`, `HIGH`, `URGENT` |
| `issue_status` | `NEW`, `ASSIGNED`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`, `CANCELLED` |
| `lead_source` | `FACEBOOK`, `ZALO`, `PHONE`, `REFERRAL`, `WALK_IN`, `WEBSITE`, `OTHER` |
| `lead_status` | `B1_LEAD`, `B2_APPOINTMENT`, `B3_CONSULTATION`, `CONVERTED`, `FAILED` |
| `meter_type` | `ELECTRICITY`, `WATER`, `GAS`, `OTHER` |
| `notification_channel` | `IN_APP`, `EMAIL`, `SMS`, `ZALO`, `PUSH` |
| `notification_status` | `PENDING`, `SENT`, `FAILED`, `CANCELLED`, `READ` |
| `notification_type` | `NEW_INVOICE`, `PAYMENT_REMINDER`, `OVERDUE_INVOICE`, `CONTRACT_EXPIRING`, `ISSUE_RESOLVED`, `GENERAL_ANNOUNCEMENT`, `CUSTOM` |
| `payment_cycle` | `MONTHLY`, `QUARTERLY`, `SEMI_ANNUAL`, `ANNUAL` |
| `payment_method` | `TM`, `TK`, `TT` |
| `pricing_type` | `DON_GIA_CO_DINH_THANG`, `DON_GIA_CO_DINH_DONG_HO`, `DON_GIA_BIEN_DONG`, `DON_GIA_THEO_NGUOI`, `DON_GIA_THEO_PHONG` |
| `room_status` | `AVAILABLE`, `OCCUPIED`, `RESERVED`, `MAINTENANCE`, `UNAVAILABLE` |
| `service_type` | `FIXED`, `PER_PERSON`, `PER_ROOM`, `METER_READING` |
| `template_category` | `CONTRACT_NEW`, `CONTRACT_TERMINATION`, `CONTRACT_EXTENSION`, `CONTRACT_TRANSFER`, `INVOICE`, `RECEIPT`, `HANDOVER` |
| `tenant_status` | `PROSPECT`, `DEPOSITED`, `ACTIVE`, `INACTIVE`, `BLACKLIST` |
| `vehicle_type` | `MOTORBIKE`, `CAR`, `BICYCLE`, `OTHER`, `ELECTRIC_BIKE` |

## 3. Domain → Tables

Phân loại theo nghiệp vụ:

### I. Phân quyền & Auth

- **`profiles`** (3 rows, 18 cols)
- **`roles`** (0 rows, 8 cols)
- **`user_roles`** (0 rows, 5 cols, 1 FK)
- **`super_admins`** (1 rows, 3 cols)
- **`staff_assignments`** (17 rows, 7 cols, 2 FK)
- **`subscription_plans`** (0 rows, 11 cols)
- **`user_subscriptions`** (0 rows, 8 cols, 1 FK)
- **`departments`** (0 rows, 11 cols, 1 FK)

### II. Cấu trúc bất động sản

- **`areas`** (1 rows, 9 cols)
- **`buildings`** (21 rows, 25 cols, 5 FK)
- **`floors`** (0 rows, 9 cols, 1 FK)
- **`rooms`** (262 rows, 18 cols, 3 FK)
- **`beds`** (0 rows, 11 cols, 1 FK)
- **`building_services`** (188 rows, 7 cols, 2 FK)

### III. Khách hàng & Hợp đồng

- **`customers`** (420 rows, 46 cols)
- **`tenants`** (0 rows, 20 cols)
- **`contracts`** (269 rows, 30 cols, 6 FK)
- **`contract_customers`** (426 rows, 7 cols, 2 FK)
- **`contract_tenants`** (0 rows, 8 cols, 2 FK)
- **`contract_services`** (43 rows, 7 cols, 2 FK)
- **`contract_extensions`** (0 rows, 22 cols, 2 FK)
- **`contract_terminations`** (6 rows, 32 cols, 1 FK)
- **`contract_transfers`** (1 rows, 32 cols, 7 FK)
- **`deposits`** (0 rows, 17 cols, 4 FK)
- **`excess_amounts`** (8 rows, 8 cols, 3 FK)
- **`leads`** (0 rows, 31 cols, 6 FK)
- **`lead_activities`** (0 rows, 12 cols, 1 FK)
- **`ct01_declarations`** (1 rows, 21 cols, 1 FK)
- **`vehicles`** (227 rows, 22 cols, 5 FK)

### IV. Hoá đơn & Thanh toán

- **`invoices`** (269 rows, 32 cols, 5 FK)
- **`invoice_items`** (1015 rows, 15 cols, 2 FK)
- **`payments`** (295 rows, 11 cols, 1 FK)
- **`invoice_audit_log`** (2317 rows, 11 cols, 1 FK)
- **`invoice_generation_settings`** (0 rows, 9 cols)

### V. Sổ quỹ & Thu chi

- **`accounts`** (41 rows, 16 cols)
- **`account_shared_users`** (15 rows, 5 cols, 1 FK)
- **`income_expenses`** (576 rows, 38 cols, 11 FK)
- **`income_expense_items`** (576 rows, 11 cols, 2 FK)
- **`income_expense_types`** (54 rows, 9 cols)
- **`income_expense_templates`** (0 rows, 12 cols)
- **`income_expense_batches`** (19 rows, 10 cols)
- **`income_expense_batch_items`** (90 rows, 3 cols, 2 FK)
- **`expenses`** (0 rows, 13 cols, 2 FK)
- **`auto_debt_config`** (0 rows, 8 cols, 1 FK)

### VI. Dịch vụ & Đồng hồ

- **`services`** (31 rows, 17 cols, 1 FK)
- **`service_quotas`** (0 rows, 7 cols)
- **`service_quota_tiers`** (0 rows, 7 cols, 1 FK)
- **`meters`** (261 rows, 19 cols, 3 FK)
- **`meter_readings`** (524 rows, 23 cols, 5 FK)

### VII. Tài sản & Bảo trì

- **`assets`** (585 rows, 17 cols, 4 FK)
- **`asset_categories`** (0 rows, 6 cols)
- **`asset_warehouses`** (0 rows, 7 cols, 1 FK)
- **`asset_handovers`** (0 rows, 10 cols, 1 FK)
- **`asset_maintenance`** (0 rows, 10 cols, 2 FK)
- **`asset_movements`** (0 rows, 11 cols, 3 FK)
- **`suppliers`** (0 rows, 9 cols)

### VIII. Task & Issue

- **`issues`** (0 rows, 35 cols, 11 FK)
- **`issue_categories`** (0 rows, 8 cols)
- **`issue_comments`** (0 rows, 6 cols, 1 FK)
- **`issue_phase_history`** (0 rows, 12 cols, 4 FK)
- **`issue_status_history`** (0 rows, 8 cols, 1 FK)
- **`jobs`** (28 rows, 26 cols, 5 FK)
- **`job_groups`** (0 rows, 8 cols)
- **`job_types`** (7 rows, 15 cols, 2 FK)
- **`task_flows`** (0 rows, 9 cols, 1 FK)
- **`task_phases`** (0 rows, 19 cols, 1 FK)
- **`task_types`** (0 rows, 7 cols)
- **`phase_transitions`** (0 rows, 11 cols, 2 FK)
- **`sla_configs`** (0 rows, 8 cols)

### IX. Notification & Template

- **`notifications`** (25 rows, 17 cols, 2 FK)
- **`notification_logs`** (0 rows, 11 cols, 1 FK)
- **`notification_templates`** (0 rows, 12 cols)
- **`document_templates`** (6 rows, 18 cols)
- **`signature_templates`** (0 rows, 12 cols)
- **`hotlines`** (0 rows, 8 cols)

### X. AI & System

- **`ai_conversations`** (0 rows, 14 cols)
- **`ai_messages`** (0 rows, 10 cols, 1 FK)
- **`ai_memory_embeddings`** (0 rows, 13 cols, 2 FK)
- **`ai_usage_stats`** (0 rows, 11 cols)
- **`scheduled_jobs`** (0 rows, 10 cols)
- **`code_sequences`** (0 rows, 12 cols)
- **`settings`** (2 rows, 6 cols)

## 4. Bảng chi tiết

Cho mỗi bảng: columns + FKs + RLS policies + triggers.

### I. Phân quyền & Auth

#### `profiles`

*3 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | - |
| 2 | `full_name` | text | NO | - |
| 3 | `phone` | text | YES | - |
| 4 | `email` | text | YES | - |
| 5 | `avatar_url` | text | YES | - |
| 6 | `company_name` | text | YES | - |
| 7 | `address` | text | YES | - |
| 8 | `default_payment_due_days` | integer | YES | `5` |
| 9 | `timezone` | text | YES | `'Asia/Ho_Chi_Minh'::text` |
| 10 | `language` | text | YES | `'vi'::text` |
| 11 | `subscription_plan` | text | YES | `'trial'::text` |
| 12 | `subscription_expires_at` | timestamp with time zone | YES | - |
| 13 | `created_at` | timestamp with time zone | NO | `now()` |
| 14 | `updated_at` | timestamp with time zone | NO | `now()` |
| 15 | `department` | text | YES | - |
| 16 | `job_title` | text | YES | - |
| 17 | `employee_code` | text | YES | - |
| 18 | `is_active` | boolean | NO | `true` |

**RLS Policies**:

- **SELECT**: `Users can view own profile`, `profiles_select_via_staff_assignments`
- **INSERT**: `profiles_admin_insert`
- **UPDATE**: `profiles_admin_update`
- **ALL**: `profiles_admin_all`, `profiles_super_admin_all`

**Triggers**:

- `set_profiles_updated_at (BEFORE)` on UPDATE


#### `roles`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | character varying | NO | - |
| 4 | `description` | text | YES | - |
| 5 | `permissions` | jsonb | YES | `'[]'::jsonb` |
| 6 | `is_system` | boolean | YES | `false` |
| 7 | `created_at` | timestamp without time zone | YES | `now()` |
| 8 | `updated_at` | timestamp without time zone | YES | `now()` |

**RLS Policies**:

- **SELECT**: `Users can view roles in their organization`, `roles_select_staff`
- **ALL**: `Users can manage their own roles`, `roles_admin_all`, `roles_super_admin_all`


#### `user_roles`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `role_id` | uuid | NO | - |
| 4 | `assigned_by` | uuid | YES | - |
| 5 | `created_at` | timestamp without time zone | YES | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `role_id` | `roles` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `Users can view user_roles`
- **ALL**: `Users can manage user_roles`, `user_roles_admin_all`, `user_roles_super_admin_all`


#### `super_admins`

*1 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `user_id` | uuid | NO | - |
| 2 | `note` | text | YES | - |
| 3 | `created_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **SELECT**: `super_admins_select`
- **ALL**: `super_admins_modify`


#### `staff_assignments`

*17 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `staff_id` | uuid | NO | - |
| 3 | `role_id` | uuid | NO | - |
| 4 | `building_id` | uuid | YES | - |
| 5 | `user_id` | uuid | NO | - |
| 6 | `created_at` | timestamp with time zone | NO | `now()` |
| 7 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `building_id` | `buildings` | `id` | CASCADE |
| `role_id` | `roles` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `staff_assignments_select`
- **INSERT**: `staff_assignments_insert`
- **UPDATE**: `staff_assignments_update`
- **DELETE**: `staff_assignments_delete`
- **ALL**: `staff_assignments_admin_all`, `staff_assignments_super_admin_all`


#### `subscription_plans`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `name` | text | NO | - |
| 3 | `description` | text | YES | - |
| 4 | `price` | numeric | NO | - |
| 5 | `duration_months` | integer | NO | - |
| 6 | `max_rooms` | integer | YES | - |
| 7 | `max_buildings` | integer | YES | - |
| 8 | `features` | jsonb | YES | `'[]'::jsonb` |
| 9 | `is_active` | boolean | YES | `true` |
| 10 | `created_at` | timestamp with time zone | NO | `now()` |
| 11 | `updated_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **SELECT**: `subscription_plans_select`
- **ALL**: `subscription_plans_admin_all`, `subscription_plans_super_admin_all`


#### `user_subscriptions`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `plan_id` | uuid | NO | - |
| 4 | `start_date` | date | NO | - |
| 5 | `end_date` | date | NO | - |
| 6 | `status` | text | YES | `'active'::text` |
| 7 | `created_at` | timestamp with time zone | NO | `now()` |
| 8 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `plan_id` | `subscription_plans` | `id` | RESTRICT |

**RLS Policies**:

- **SELECT**: `user_subscriptions_select`
- **INSERT**: `user_subscriptions_insert`
- **UPDATE**: `user_subscriptions_update`
- **DELETE**: `user_subscriptions_delete`
- **ALL**: `user_subscriptions_admin_all`, `user_subscriptions_super_admin_all`


#### `departments`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `code` | text | NO | - |
| 4 | `name` | text | NO | - |
| 5 | `description` | text | YES | - |
| 6 | `manager_id` | uuid | YES | - |
| 7 | `phone` | text | YES | - |
| 8 | `email` | text | YES | - |
| 9 | `is_active` | boolean | YES | `true` |
| 10 | `created_at` | timestamp with time zone | NO | `now()` |
| 11 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `manager_id` | `profiles` | `id` | NO ACTION |

**RLS Policies**:

- **ALL**: `Users can manage own departments`, `departments_admin_all`, `departments_super_admin_all`


### II. Cấu trúc bất động sản

#### `areas`

*1 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `code` | text | YES | - |
| 5 | `description` | text | YES | - |
| 6 | `status` | text | NO | `'ACTIVE'::text` |
| 7 | `created_at` | timestamp with time zone | NO | `now()` |
| 8 | `updated_at` | timestamp with time zone | NO | `now()` |
| 9 | `deleted_at` | timestamp with time zone | YES | - |

**RLS Policies**:

- **SELECT**: `areas_select_rbac`
- **INSERT**: `areas_insert_rbac`
- **UPDATE**: `areas_update_rbac`
- **DELETE**: `areas_delete_rbac`
- **ALL**: `areas_admin_all`, `areas_super_admin_all`

**Triggers**:

- `areas_set_user_id_audit (BEFORE)` on INSERT
- `set_areas_updated_at (BEFORE)` on UPDATE


#### `buildings`

*21 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 4 | `name` | text | NO | - |
| 5 | `code` | text | YES | - |
| 6 | `type` | USER-DEFINED | NO | `'APARTMENT'::building_type` |
| 7 | `status` | USER-DEFINED | NO | `'ACTIVE'::building_status` |
| 8 | `province` | text | NO | - |
| 9 | `district` | text | NO | - |
| 10 | `ward` | text | NO | - |
| 11 | `street_address` | text | YES | - |
| 12 | `total_floors` | integer | YES | `1` |
| 13 | `total_rooms` | integer | YES | `0` |
| 14 | `description` | text | YES | - |
| 15 | `images` | jsonb | YES | `'[]'::jsonb` |
| 16 | `amenities` | jsonb | YES | `'[]'::jsonb` |
| 17 | `created_at` | timestamp with time zone | NO | `now()` |
| 18 | `updated_at` | timestamp with time zone | NO | `now()` |
| 19 | `deleted_at` | timestamp with time zone | YES | - |
| 20 | `area_id` | uuid | YES | - |
| 21 | `contract_template_id` | uuid | YES | - |
| 22 | `invoice_template_id` | uuid | YES | - |
| 23 | `commission_tiers` | jsonb | NO | `'[{"max_months": 6, "min_months": 5, "rate_percent` |
| 24 | `is_virtual` | boolean | NO | `false` |
| 25 | `default_account_id_tt` | uuid | YES | - |
| 26 | `default_account_id_tk` | uuid | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `area_id` | `areas` | `id` | SET NULL |
| `contract_template_id` | `document_templates` | `id` | SET NULL |
| `default_account_id_tk` | `accounts` | `id` | SET NULL |
| `default_account_id_tt` | `accounts` | `id` | SET NULL |
| `invoice_template_id` | `document_templates` | `id` | SET NULL |

**RLS Policies**:

- **SELECT**: `buildings_select_rbac`
- **INSERT**: `buildings_insert_rbac`
- **UPDATE**: `buildings_update_rbac`
- **DELETE**: `buildings_delete_rbac`
- **ALL**: `buildings_admin_all`, `buildings_super_admin_all`

**Triggers**:

- `buildings_set_user_id_audit (BEFORE)` on INSERT
- `set_buildings_updated_at (BEFORE)` on UPDATE


#### `floors`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `building_id` | uuid | NO | - |
| 3 | `floor_number` | integer | NO | - |
| 4 | `name` | text | YES | - |
| 5 | `description` | text | YES | - |
| 6 | `status` | text | YES | `'active'::text` |
| 7 | `user_id` | uuid | NO | - |
| 8 | `created_at` | timestamp with time zone | NO | `now()` |
| 9 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `building_id` | `buildings` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `floors_select_rbac`
- **INSERT**: `floors_insert_rbac`
- **UPDATE**: `floors_update_rbac`
- **DELETE**: `floors_delete_rbac`
- **ALL**: `floors_admin_all`, `floors_super_admin_all`

**Triggers**:

- `floors_set_user_id_audit (BEFORE)` on INSERT


#### `rooms`

*262 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `building_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `code` | text | YES | - |
| 5 | `floor` | integer | NO | `1` |
| 6 | `status` | USER-DEFINED | NO | `'AVAILABLE'::room_status` |
| 7 | `area` | numeric | YES | - |
| 8 | `max_occupants` | integer | YES | `1` |
| 9 | `rent_price` | numeric | NO | - |
| 10 | `deposit_amount` | numeric | NO | - |
| 11 | `description` | text | YES | - |
| 12 | `images` | jsonb | YES | `'[]'::jsonb` |
| 13 | `amenities` | jsonb | YES | `'[]'::jsonb` |
| 14 | `created_at` | timestamp with time zone | NO | `now()` |
| 15 | `updated_at` | timestamp with time zone | NO | `now()` |
| 16 | `deleted_at` | timestamp with time zone | YES | - |
| 17 | `invoice_template_id` | uuid | YES | - |
| 18 | `lease_template_id` | uuid | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `building_id` | `buildings` | `id` | CASCADE |
| `invoice_template_id` | `document_templates` | `id` | SET NULL |
| `lease_template_id` | `document_templates` | `id` | SET NULL |

**RLS Policies**:

- **SELECT**: `rooms_select_rbac`
- **INSERT**: `rooms_insert_rbac`
- **UPDATE**: `rooms_update_rbac`
- **DELETE**: `rooms_delete_rbac`
- **ALL**: `rooms_admin_all`, `rooms_super_admin_all`

**Triggers**:

- `set_rooms_updated_at (BEFORE)` on UPDATE
- `update_building_total_rooms_on_room_change (AFTER)` on DELETE/INSERT/UPDATE


#### `beds`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `room_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `code` | text | YES | - |
| 5 | `status` | USER-DEFINED | NO | `'AVAILABLE'::bed_status` |
| 6 | `rent_price` | numeric | NO | - |
| 7 | `deposit_amount` | numeric | NO | - |
| 8 | `description` | text | YES | - |
| 9 | `created_at` | timestamp with time zone | NO | `now()` |
| 10 | `updated_at` | timestamp with time zone | NO | `now()` |
| 11 | `deleted_at` | timestamp with time zone | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `room_id` | `rooms` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `beds_select_rbac`
- **INSERT**: `beds_insert_rbac`
- **UPDATE**: `beds_update_rbac`
- **DELETE**: `beds_delete_rbac`
- **ALL**: `beds_admin_all`, `beds_super_admin_all`

**Triggers**:

- `set_beds_updated_at (BEFORE)` on UPDATE


#### `building_services`

*188 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `building_id` | uuid | NO | - |
| 3 | `service_id` | uuid | NO | - |
| 4 | `is_active` | boolean | NO | `true` |
| 5 | `unit_price_override` | numeric | YES | - |
| 6 | `created_at` | timestamp with time zone | NO | `now()` |
| 7 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `building_id` | `buildings` | `id` | CASCADE |
| `service_id` | `services` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `building_services_select_rbac`
- **INSERT**: `building_services_insert_rbac`
- **UPDATE**: `building_services_update_rbac`
- **DELETE**: `building_services_delete_rbac`
- **ALL**: `building_services_admin_all`, `building_services_super_admin_all`

**Triggers**:

- `update_building_services_updated_at (BEFORE)` on UPDATE


### III. Khách hàng & Hợp đồng

#### `customers`

*420 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `customer_type` | USER-DEFINED | YES | `'INDIVIDUAL'::customer_type` |
| 4 | `full_name` | text | NO | - |
| 5 | `phone` | text | NO | - |
| 6 | `email` | text | YES | - |
| 7 | `date_of_birth` | date | YES | - |
| 8 | `gender` | text | YES | - |
| 9 | `id_type` | USER-DEFINED | YES | `'CCCD'::id_type` |
| 10 | `id_number` | text | YES | - |
| 11 | `id_issue_date` | date | YES | - |
| 12 | `id_issue_place` | text | YES | - |
| 13 | `province` | text | YES | - |
| 14 | `district` | text | YES | - |
| 15 | `ward` | text | YES | - |
| 16 | `detailed_address` | text | YES | - |
| 17 | `current_residence` | text | YES | - |
| 18 | `permanent_address` | text | YES | - |
| 19 | `bank_account_number` | text | YES | - |
| 20 | `bank_name` | text | YES | - |
| 21 | `occupation` | text | YES | - |
| 22 | `workplace` | text | YES | - |
| 23 | `contact_person` | text | YES | - |
| 24 | `contact_person_phone` | text | YES | - |
| 25 | `advisor` | text | YES | - |
| 26 | `advisor_phone` | text | YES | - |
| 27 | `emergency_contact_name` | text | YES | - |
| 28 | `emergency_contact_phone` | text | YES | - |
| 29 | `emergency_contact_relationship` | text | YES | - |
| 30 | `fingerprint_code` | text | YES | - |
| 31 | `customer_group` | text | YES | - |
| 32 | `is_foreign` | boolean | YES | `false` |
| 33 | `status` | USER-DEFINED | YES | `'PROSPECT'::customer_status` |
| 34 | `notes` | text | YES | - |
| 35 | `avatar_url` | text | YES | - |
| 36 | `id_images` | jsonb | YES | `'{}'::jsonb` |
| 37 | `vehicles` | jsonb | YES | `'[]'::jsonb` |
| 38 | `created_at` | timestamp with time zone | NO | `now()` |
| 39 | `updated_at` | timestamp with time zone | NO | `now()` |
| 40 | `deleted_at` | timestamp with time zone | YES | - |
| 41 | `status_v2` | USER-DEFINED | YES | `'RENTING'::customer_status_v2` |
| 42 | `company_name` | text | YES | - |
| 43 | `tax_code` | text | YES | - |
| 44 | `representative` | text | YES | - |
| 45 | `business_registration_url` | text | YES | - |
| 46 | `headquarters_address` | text | YES | - |

**RLS Policies**:

- **SELECT**: `customers_select_rbac`
- **INSERT**: `customers_insert_rbac`
- **UPDATE**: `customers_update_rbac`
- **DELETE**: `customers_delete_rbac`
- **ALL**: `customers_admin_all`, `customers_super_admin_all`

**Triggers**:

- `customers_set_user_id_audit (BEFORE)` on INSERT
- `update_customers_updated_at (BEFORE)` on UPDATE


#### `tenants`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `full_name` | text | NO | - |
| 4 | `id_number` | text | YES | - |
| 5 | `id_type` | USER-DEFINED | YES | `'CCCD'::id_type` |
| 6 | `date_of_birth` | date | YES | - |
| 7 | `gender` | text | YES | - |
| 8 | `phone` | text | NO | - |
| 9 | `email` | text | YES | - |
| 10 | `permanent_address` | text | YES | - |
| 11 | `status` | USER-DEFINED | YES | `'PROSPECT'::tenant_status` |
| 12 | `emergency_contact_name` | text | YES | - |
| 13 | `emergency_contact_phone` | text | YES | - |
| 14 | `emergency_contact_relationship` | text | YES | - |
| 15 | `notes` | text | YES | - |
| 16 | `avatar_url` | text | YES | - |
| 17 | `id_images` | jsonb | YES | `'[]'::jsonb` |
| 18 | `created_at` | timestamp with time zone | NO | `now()` |
| 19 | `updated_at` | timestamp with time zone | NO | `now()` |
| 20 | `deleted_at` | timestamp with time zone | YES | - |

**RLS Policies**:

- **SELECT**: `tenants_select_rbac`
- **INSERT**: `tenants_insert_rbac`
- **UPDATE**: `tenants_update_rbac`
- **DELETE**: `tenants_delete_rbac`
- **ALL**: `tenants_admin_all`, `tenants_super_admin_all`

**Triggers**:

- `set_tenants_updated_at (BEFORE)` on UPDATE
- `tenants_set_user_id_audit (BEFORE)` on INSERT


#### `contracts`

*269 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `tenant_id` | uuid | YES | - |
| 4 | `room_id` | uuid | YES | - |
| 5 | `bed_id` | uuid | YES | - |
| 6 | `contract_number` | text | YES | - |
| 7 | `status` | USER-DEFINED | NO | `'DRAFT'::contract_status` |
| 8 | `signed_date` | date | NO | - |
| 9 | `start_date` | date | NO | - |
| 10 | `end_date` | date | NO | - |
| 11 | `actual_end_date` | date | YES | - |
| 12 | `rent_price` | numeric | NO | - |
| 13 | `payment_cycle` | USER-DEFINED | YES | `'MONTHLY'::payment_cycle` |
| 14 | `total_deposit` | numeric | NO | `0` |
| 15 | `deposit_paid` | numeric | YES | `0` |
| 16 | `deposit_remaining` | numeric | YES | - |
| 17 | `discounts` | jsonb | YES | `'[]'::jsonb` |
| 18 | `initial_electricity_reading` | numeric | YES | - |
| 19 | `initial_water_reading` | numeric | YES | - |
| 20 | `notes` | text | YES | - |
| 21 | `contract_file_url` | text | YES | - |
| 22 | `parent_contract_id` | uuid | YES | - |
| 23 | `created_at` | timestamp with time zone | NO | `now()` |
| 24 | `updated_at` | timestamp with time zone | NO | `now()` |
| 25 | `deleted_at` | timestamp with time zone | YES | - |
| 26 | `contract_template_id` | uuid | YES | - |
| 27 | `invoice_template_id` | uuid | YES | - |
| 28 | `expected_move_out_date` | date | YES | - |
| 29 | `start_billing_date` | date | YES | - |
| 30 | `end_billing_date` | date | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `bed_id` | `beds` | `id` | RESTRICT |
| `contract_template_id` | `document_templates` | `id` | SET NULL |
| `invoice_template_id` | `document_templates` | `id` | SET NULL |
| `parent_contract_id` | `contracts` | `id` | NO ACTION |
| `room_id` | `rooms` | `id` | RESTRICT |
| `tenant_id` | `tenants` | `id` | SET NULL |

**RLS Policies**:

- **SELECT**: `contracts_select_rbac`
- **INSERT**: `contracts_insert_rbac`
- **UPDATE**: `contracts_update_rbac`
- **DELETE**: `contracts_delete_rbac`
- **ALL**: `contracts_admin_all`, `contracts_super_admin_all`

**Triggers**:

- `contracts_set_user_id_audit (BEFORE)` on INSERT
- `generate_contract_number_trigger (BEFORE)` on INSERT
- `set_contracts_updated_at (BEFORE)` on UPDATE
- `trigger_auto_calculate_deposit_paid (BEFORE)` on INSERT
- `trigger_update_room_bed_status (AFTER)` on INSERT/UPDATE
- `update_asset_status_on_contract_change_trigger (AFTER)` on INSERT/UPDATE


#### `contract_customers`

*426 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `contract_id` | uuid | NO | - |
| 3 | `customer_id` | uuid | NO | - |
| 4 | `is_representative` | boolean | NO | `false` |
| 5 | `created_at` | timestamp with time zone | NO | `now()` |
| 6 | `updated_at` | timestamp with time zone | NO | `now()` |
| 7 | `notes` | text | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `contract_id` | `contracts` | `id` | CASCADE |
| `customer_id` | `customers` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `contract_customers_select_rbac`
- **INSERT**: `contract_customers_insert_rbac`
- **UPDATE**: `contract_customers_update_rbac`
- **DELETE**: `contract_customers_delete_rbac`
- **ALL**: `contract_customers_admin_all`, `contract_customers_super_admin_all`

**Triggers**:

- `ensure_single_representative (BEFORE)` on INSERT/UPDATE
- `update_contract_customers_updated_at (BEFORE)` on UPDATE


#### `contract_tenants`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `contract_id` | uuid | NO | - |
| 3 | `tenant_id` | uuid | NO | - |
| 4 | `is_representative` | boolean | NO | `false` |
| 5 | `move_in_date` | date | YES | - |
| 6 | `notes` | text | YES | - |
| 7 | `created_at` | timestamp with time zone | NO | `now()` |
| 8 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `contract_id` | `contracts` | `id` | CASCADE |
| `tenant_id` | `tenants` | `id` | RESTRICT |

**RLS Policies**:

- **SELECT**: `contract_tenants_select_rbac`
- **INSERT**: `contract_tenants_insert_rbac`
- **UPDATE**: `contract_tenants_update_rbac`
- **DELETE**: `contract_tenants_delete_rbac`
- **ALL**: `contract_tenants_admin_all`, `contract_tenants_super_admin_all`


#### `contract_services`

*43 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `contract_id` | uuid | NO | - |
| 3 | `service_id` | uuid | NO | - |
| 4 | `unit_price` | numeric | NO | - |
| 5 | `initial_reading` | numeric | YES | - |
| 6 | `created_at` | timestamp with time zone | NO | `now()` |
| 7 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `contract_id` | `contracts` | `id` | CASCADE |
| `service_id` | `services` | `id` | RESTRICT |

**RLS Policies**:

- **SELECT**: `contract_services_select_rbac`
- **INSERT**: `contract_services_insert_rbac`
- **UPDATE**: `contract_services_update_rbac`
- **DELETE**: `contract_services_delete_rbac`
- **ALL**: `contract_services_admin_all`, `contract_services_super_admin_all`

**Triggers**:

- `set_contract_services_updated_at (BEFORE)` on UPDATE


#### `contract_extensions`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `contract_id` | uuid | NO | - |
| 4 | `extension_date` | date | NO | `CURRENT_DATE` |
| 5 | `extension_type` | text | NO | - |
| 6 | `old_end_date` | date | NO | - |
| 7 | `extension_months` | integer | NO | - |
| 8 | `new_end_date` | date | NO | - |
| 9 | `new_rent_price` | numeric | YES | - |
| 10 | `rent_price_changed` | boolean | YES | `false` |
| 11 | `new_deposit` | numeric | YES | - |
| 12 | `additional_deposit_required` | numeric | YES | `0` |
| 13 | `deposit_changed` | boolean | YES | `false` |
| 14 | `services_changed` | boolean | YES | `false` |
| 15 | `new_services` | jsonb | YES | `'[]'::jsonb` |
| 16 | `new_contract_id` | uuid | YES | - |
| 17 | `status` | text | NO | `'DRAFT'::text` |
| 18 | `approved_by` | uuid | YES | - |
| 19 | `approved_at` | timestamp with time zone | YES | - |
| 20 | `notes` | text | YES | - |
| 21 | `created_at` | timestamp with time zone | NO | `now()` |
| 22 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `contract_id` | `contracts` | `id` | RESTRICT |
| `new_contract_id` | `contracts` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `contract_extensions_select_rbac`
- **INSERT**: `contract_extensions_insert_rbac`
- **UPDATE**: `contract_extensions_update_rbac`
- **DELETE**: `contract_extensions_delete_rbac`
- **ALL**: `contract_extensions_admin_all`, `contract_extensions_super_admin_all`

**Triggers**:

- `contract_extensions_set_user_id_audit (BEFORE)` on INSERT
- `trigger_apply_contract_extension_update (BEFORE)` on UPDATE


#### `contract_terminations`

*6 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `contract_id` | uuid | NO | - |
| 4 | `termination_date` | date | NO | `CURRENT_DATE` |
| 5 | `actual_move_out_date` | date | NO | - |
| 6 | `notice_date` | date | YES | - |
| 7 | `termination_type` | text | NO | - |
| 8 | `outstanding_debt` | numeric | YES | `0` |
| 9 | `prorated_days` | integer | YES | `0` |
| 10 | `prorated_rent` | numeric | YES | `0` |
| 11 | `prorated_services` | numeric | YES | `0` |
| 12 | `early_termination_fee` | numeric | YES | `0` |
| 13 | `notice_violation_fee` | numeric | YES | `0` |
| 14 | `damage_fee` | numeric | YES | `0` |
| 15 | `damage_description` | text | YES | - |
| 16 | `damage_images` | jsonb | YES | `'[]'::jsonb` |
| 17 | `cleaning_fee` | numeric | YES | `0` |
| 18 | `other_fees` | numeric | YES | `0` |
| 19 | `other_fees_description` | text | YES | - |
| 20 | `total_deposit` | numeric | NO | - |
| 21 | `total_deductions` | numeric | YES | - |
| 22 | `refund_amount` | numeric | YES | - |
| 23 | `refund_method` | USER-DEFINED | YES | - |
| 24 | `refund_date` | date | YES | - |
| 25 | `refund_receipt_url` | text | YES | - |
| 26 | `status` | text | NO | `'DRAFT'::text` |
| 27 | `approved_by` | uuid | YES | - |
| 28 | `approved_at` | timestamp with time zone | YES | - |
| 29 | `notes` | text | YES | - |
| 30 | `internal_notes` | text | YES | - |
| 31 | `created_at` | timestamp with time zone | NO | `now()` |
| 32 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `contract_id` | `contracts` | `id` | RESTRICT |

**RLS Policies**:

- **SELECT**: `contract_terminations_select_rbac`
- **INSERT**: `contract_terminations_insert_rbac`
- **UPDATE**: `contract_terminations_update_rbac`
- **DELETE**: `contract_terminations_delete_rbac`
- **ALL**: `contract_terminations_admin_all`, `contract_terminations_super_admin_all`

**Triggers**:

- `contract_terminations_set_user_id_audit (BEFORE)` on INSERT
- `trigger_auto_calculate_termination_financials (BEFORE)` on INSERT/UPDATE
- `trigger_update_contract_on_termination (BEFORE)` on UPDATE


#### `contract_transfers`

*1 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `contract_id` | uuid | NO | - |
| 4 | `transfer_type` | text | NO | - |
| 5 | `transfer_date` | date | NO | `CURRENT_DATE` |
| 6 | `old_tenant_id` | uuid | YES | - |
| 7 | `new_tenant_id` | uuid | YES | - |
| 8 | `transfer_fee` | numeric | YES | `0` |
| 9 | `old_room_id` | uuid | YES | - |
| 10 | `new_room_id` | uuid | YES | - |
| 11 | `old_bed_id` | uuid | YES | - |
| 12 | `new_bed_id` | uuid | YES | - |
| 13 | `new_rent_price` | numeric | YES | - |
| 14 | `new_deposit` | numeric | YES | - |
| 15 | `move_out_date` | date | YES | - |
| 16 | `move_in_date` | date | YES | - |
| 17 | `new_start_date` | date | YES | - |
| 18 | `new_end_date` | date | YES | - |
| 19 | `new_services` | jsonb | YES | `'[]'::jsonb` |
| 20 | `deposit_transfer_type` | text | YES | - |
| 21 | `old_tenant_deposit_refund` | numeric | YES | `0` |
| 22 | `new_tenant_deposit_paid` | numeric | YES | `0` |
| 23 | `old_tenant_outstanding` | numeric | YES | `0` |
| 24 | `old_tenant_settlement_amount` | numeric | YES | `0` |
| 25 | `old_tenant_settlement_date` | date | YES | - |
| 26 | `status` | text | NO | `'DRAFT'::text` |
| 27 | `reason` | text | YES | - |
| 28 | `notes` | text | YES | - |
| 29 | `approved_by` | uuid | YES | - |
| 30 | `approved_at` | timestamp with time zone | YES | - |
| 31 | `created_at` | timestamp with time zone | NO | `now()` |
| 32 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `contract_id` | `contracts` | `id` | RESTRICT |
| `new_bed_id` | `beds` | `id` | NO ACTION |
| `new_room_id` | `rooms` | `id` | NO ACTION |
| `new_tenant_id` | `tenants` | `id` | NO ACTION |
| `old_bed_id` | `beds` | `id` | NO ACTION |
| `old_room_id` | `rooms` | `id` | NO ACTION |
| `old_tenant_id` | `tenants` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `contract_transfers_select_rbac`
- **INSERT**: `contract_transfers_insert_rbac`
- **UPDATE**: `contract_transfers_update_rbac`
- **DELETE**: `contract_transfers_delete_rbac`
- **ALL**: `contract_transfers_admin_all`, `contract_transfers_super_admin_all`

**Triggers**:

- `contract_transfers_set_user_id_audit (BEFORE)` on INSERT
- `trigger_apply_contract_transfer (BEFORE)` on UPDATE
- `trigger_auto_calculate_transfer_outstanding (BEFORE)` on INSERT/UPDATE


#### `deposits`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `tenant_id` | uuid | NO | - |
| 4 | `room_id` | uuid | YES | - |
| 5 | `bed_id` | uuid | YES | - |
| 6 | `contract_id` | uuid | YES | - |
| 7 | `amount` | numeric | NO | - |
| 8 | `deposit_date` | date | NO | `CURRENT_DATE` |
| 9 | `status` | USER-DEFINED | NO | `'PENDING'::deposit_status` |
| 10 | `hold_until` | date | YES | - |
| 11 | `notes` | text | YES | - |
| 12 | `receipt_image_url` | text | YES | - |
| 13 | `created_at` | timestamp with time zone | NO | `now()` |
| 14 | `updated_at` | timestamp with time zone | NO | `now()` |
| 15 | `deleted_at` | timestamp with time zone | YES | - |
| 16 | `code` | text | YES | - |
| 17 | `ctv_name` | text | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `bed_id` | `beds` | `id` | RESTRICT |
| `contract_id` | `contracts` | `id` | SET NULL |
| `room_id` | `rooms` | `id` | RESTRICT |
| `tenant_id` | `tenants` | `id` | RESTRICT |

**RLS Policies**:

- **SELECT**: `deposits_select_rbac`
- **INSERT**: `deposits_insert_rbac`
- **UPDATE**: `deposits_update_rbac`
- **DELETE**: `deposits_delete_rbac`
- **ALL**: `deposits_admin_all`, `deposits_super_admin_all`

**Triggers**:

- `deposits_set_user_id_audit (BEFORE)` on INSERT
- `set_deposits_updated_at (BEFORE)` on UPDATE
- `trg_deposits_set_code (BEFORE)` on INSERT


#### `excess_amounts`

*8 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `contract_id` | uuid | NO | - |
| 4 | `amount` | numeric | NO | - |
| 5 | `description` | text | YES | - |
| 6 | `source_invoice_id` | uuid | YES | - |
| 7 | `source_payment_id` | uuid | YES | - |
| 8 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `contract_id` | `contracts` | `id` | RESTRICT |
| `source_invoice_id` | `invoices` | `id` | SET NULL |
| `source_payment_id` | `payments` | `id` | SET NULL |

**RLS Policies**:

- **SELECT**: `excess_amounts_select_rbac`
- **INSERT**: `excess_amounts_insert_rbac`
- **UPDATE**: `excess_amounts_update_rbac`
- **DELETE**: `excess_amounts_delete_rbac`
- **ALL**: `excess_amounts_admin_all`, `excess_amounts_super_admin_all`

**Triggers**:

- `excess_amounts_set_user_id_audit (BEFORE)` on INSERT


#### `leads`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `customer_name` | text | NO | - |
| 4 | `phone` | text | NO | - |
| 5 | `email` | text | YES | - |
| 6 | `source` | USER-DEFINED | YES | - |
| 7 | `building_id` | uuid | YES | - |
| 8 | `room_id` | uuid | YES | - |
| 9 | `appointment_date` | timestamp with time zone | YES | - |
| 10 | `assigned_staff_id` | uuid | YES | - |
| 11 | `status` | USER-DEFINED | YES | `'B1_LEAD'::lead_status` |
| 12 | `deposit_id` | uuid | YES | - |
| 13 | `contract_id` | uuid | YES | - |
| 14 | `notes` | text | YES | - |
| 15 | `created_at` | timestamp with time zone | NO | `now()` |
| 16 | `updated_at` | timestamp with time zone | NO | `now()` |
| 17 | `lead_score` | integer | YES | `0` |
| 18 | `budget_min` | numeric | YES | - |
| 19 | `budget_max` | numeric | YES | - |
| 20 | `move_in_date` | date | YES | - |
| 21 | `num_occupants` | integer | YES | `1` |
| 22 | `preferred_room_type` | character varying | YES | - |
| 23 | `last_contact_date` | timestamp without time zone | YES | - |
| 24 | `next_follow_up_date` | date | YES | - |
| 25 | `lost_reason` | text | YES | - |
| 26 | `conversion_date` | timestamp without time zone | YES | - |
| 27 | `bed_id` | uuid | YES | - |
| 28 | `deleted_at` | timestamp without time zone | YES | - |
| 29 | `referrer_name` | text | YES | - |
| 30 | `ctv_name` | text | YES | - |
| 31 | `finder_name` | text | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `assigned_staff_id` | `profiles` | `id` | NO ACTION |
| `bed_id` | `beds` | `id` | NO ACTION |
| `building_id` | `buildings` | `id` | NO ACTION |
| `contract_id` | `contracts` | `id` | NO ACTION |
| `deposit_id` | `deposits` | `id` | NO ACTION |
| `room_id` | `rooms` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `leads_select_rbac`
- **INSERT**: `leads_insert_rbac`
- **UPDATE**: `leads_update_rbac`
- **DELETE**: `leads_delete_rbac`
- **ALL**: `leads_admin_all`, `leads_super_admin_all`

**Triggers**:

- `leads_set_user_id_audit (BEFORE)` on INSERT
- `set_leads_updated_at (BEFORE)` on UPDATE
- `trigger_update_lead_score (BEFORE)` on INSERT/UPDATE


#### `lead_activities`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `lead_id` | uuid | NO | - |
| 4 | `activity_type` | character varying | NO | - |
| 5 | `description` | text | YES | - |
| 6 | `old_value` | jsonb | YES | - |
| 7 | `new_value` | jsonb | YES | - |
| 8 | `performed_by` | uuid | YES | - |
| 9 | `scheduled_at` | timestamp without time zone | YES | - |
| 10 | `completed_at` | timestamp without time zone | YES | - |
| 11 | `notes` | text | YES | - |
| 12 | `created_at` | timestamp without time zone | YES | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `lead_id` | `leads` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `lead_activities_select_rbac`
- **INSERT**: `lead_activities_insert_rbac`
- **UPDATE**: `lead_activities_update_rbac`
- **DELETE**: `lead_activities_delete_rbac`
- **ALL**: `lead_activities_admin_all`, `lead_activities_super_admin_all`

**Triggers**:

- `lead_activities_set_user_id_audit (BEFORE)` on INSERT


#### `ct01_declarations`

*1 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `customer_id` | uuid | NO | - |
| 4 | `registration_authority` | text | NO | - |
| 5 | `full_name` | text | NO | - |
| 6 | `date_of_birth` | date | NO | - |
| 7 | `gender` | text | NO | - |
| 8 | `id_number` | text | NO | - |
| 9 | `phone` | text | YES | - |
| 10 | `email` | text | YES | - |
| 11 | `permanent_address` | text | YES | - |
| 12 | `temporary_address` | text | YES | - |
| 13 | `current_address` | text | YES | - |
| 14 | `occupation_workplace` | text | YES | - |
| 15 | `household_head_name` | text | YES | - |
| 16 | `household_head_relationship` | text | YES | - |
| 17 | `household_head_id_number` | text | YES | - |
| 18 | `request_content` | text | YES | - |
| 19 | `family_members` | jsonb | YES | `'[]'::jsonb` |
| 20 | `created_at` | timestamp with time zone | NO | `now()` |
| 21 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `customer_id` | `customers` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `ct01_declarations_select_rbac`
- **INSERT**: `ct01_declarations_insert_rbac`
- **UPDATE**: `ct01_declarations_update_rbac`
- **DELETE**: `ct01_declarations_delete_rbac`
- **ALL**: `ct01_declarations_super_admin_all`

**Triggers**:

- `ct01_declarations_set_user_id_audit (BEFORE)` on INSERT
- `update_ct01_updated_at (BEFORE)` on UPDATE


#### `vehicles`

*227 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `tenant_id` | uuid | YES | - |
| 4 | `contract_id` | uuid | YES | - |
| 5 | `vehicle_type` | USER-DEFINED | NO | - |
| 6 | `brand` | text | YES | - |
| 7 | `model` | text | YES | - |
| 8 | `license_plate` | text | YES | - |
| 9 | `color` | text | YES | - |
| 10 | `parking_fee` | numeric | YES | `0` |
| 11 | `notes` | text | YES | - |
| 12 | `images` | jsonb | YES | `'[]'::jsonb` |
| 13 | `created_at` | timestamp with time zone | NO | `now()` |
| 14 | `updated_at` | timestamp with time zone | NO | `now()` |
| 15 | `deleted_at` | timestamp with time zone | YES | - |
| 16 | `customer_id` | uuid | YES | - |
| 17 | `vehicle_name` | text | YES | - |
| 18 | `owner_name` | text | YES | - |
| 19 | `ticket_number` | text | YES | - |
| 20 | `building_id` | uuid | YES | - |
| 21 | `room_id` | uuid | YES | - |
| 22 | `image_url` | text | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `building_id` | `buildings` | `id` | SET NULL |
| `contract_id` | `contracts` | `id` | SET NULL |
| `customer_id` | `customers` | `id` | SET NULL |
| `room_id` | `rooms` | `id` | SET NULL |
| `tenant_id` | `tenants` | `id` | RESTRICT |

**RLS Policies**:

- **SELECT**: `vehicles_select_rbac`
- **INSERT**: `vehicles_insert_rbac`
- **UPDATE**: `vehicles_update_rbac`
- **DELETE**: `vehicles_delete_rbac`
- **ALL**: `vehicles_admin_all`, `vehicles_super_admin_all`

**Triggers**:

- `set_vehicles_updated_at (BEFORE)` on UPDATE
- `vehicles_set_user_id_audit (BEFORE)` on INSERT


### IV. Hoá đơn & Thanh toán

#### `invoices`

*269 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `contract_id` | uuid | NO | - |
| 4 | `building_id` | uuid | NO | - |
| 5 | `room_id` | uuid | NO | - |
| 6 | `bed_id` | uuid | YES | - |
| 7 | `invoice_number` | text | YES | - |
| 8 | `billing_month` | text | NO | - |
| 9 | `issue_date` | date | NO | `CURRENT_DATE` |
| 10 | `due_date` | date | NO | - |
| 11 | `paid_date` | date | YES | - |
| 12 | `status` | USER-DEFINED | NO | `'DRAFT'::invoice_status` |
| 13 | `subtotal` | numeric | NO | `0` |
| 14 | `discount_amount` | numeric | NO | `0` |
| 15 | `tax_percent` | numeric | NO | `0` |
| 16 | `tax_amount` | numeric | NO | `0` |
| 17 | `total_amount` | numeric | NO | `0` |
| 18 | `prepaid_amount` | numeric | NO | `0` |
| 19 | `paid_amount` | numeric | NO | `0` |
| 20 | `remaining_amount` | numeric | YES | - |
| 21 | `previous_debt` | numeric | NO | `0` |
| 22 | `notes` | text | YES | - |
| 23 | `template_id` | uuid | YES | - |
| 24 | `approved_at` | timestamp with time zone | YES | - |
| 25 | `approved_by` | uuid | YES | - |
| 26 | `created_at` | timestamp with time zone | NO | `now()` |
| 27 | `updated_at` | timestamp with time zone | NO | `now()` |
| 28 | `deleted_at` | timestamp with time zone | YES | - |
| 29 | `creator_name` | text | YES | - |
| 30 | `discount_notes` | text | YES | - |
| 31 | `electricity_prev_overridden` | boolean | NO | `false` |
| 32 | `previous_debt_sources` | jsonb | NO | `'[]'::jsonb` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `bed_id` | `beds` | `id` | SET NULL |
| `building_id` | `buildings` | `id` | RESTRICT |
| `contract_id` | `contracts` | `id` | RESTRICT |
| `room_id` | `rooms` | `id` | RESTRICT |
| `template_id` | `document_templates` | `id` | SET NULL |

**RLS Policies**:

- **SELECT**: `invoices_select_rbac`
- **INSERT**: `invoices_insert_rbac`
- **UPDATE**: `invoices_update_rbac`
- **DELETE**: `invoices_delete_rbac`
- **ALL**: `invoices_admin_all`, `invoices_super_admin_all`

**Triggers**:

- `generate_invoice_number_v2_trigger (BEFORE)` on INSERT
- `invoices_audit_trigger (AFTER)` on DELETE/INSERT/UPDATE
- `invoices_set_user_id_audit (BEFORE)` on INSERT
- `set_invoices_updated_at (BEFORE)` on UPDATE
- `trg_settle_previous_debt (AFTER)` on UPDATE


#### `invoice_items`

*1015 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `invoice_id` | uuid | NO | - |
| 3 | `service_id` | uuid | YES | - |
| 4 | `type` | USER-DEFINED | NO | - |
| 5 | `description` | text | NO | - |
| 6 | `unit_price` | numeric | NO | `0` |
| 7 | `quantity` | numeric | NO | `1` |
| 8 | `coefficient` | numeric | NO | `1` |
| 9 | `amount` | numeric | NO | `0` |
| 10 | `previous_reading` | numeric | YES | - |
| 11 | `current_reading` | numeric | YES | - |
| 12 | `from_date` | date | YES | - |
| 13 | `to_date` | date | YES | - |
| 14 | `sort_order` | integer | NO | `0` |
| 15 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `invoice_id` | `invoices` | `id` | CASCADE |
| `service_id` | `services` | `id` | SET NULL |

**RLS Policies**:

- **SELECT**: `invoice_items_select_rbac`
- **INSERT**: `invoice_items_insert_rbac`
- **UPDATE**: `invoice_items_update_rbac`
- **DELETE**: `invoice_items_delete_rbac`
- **ALL**: `invoice_items_admin_all`, `invoice_items_super_admin_all`

**Triggers**:

- `invoice_items_audit_trigger (AFTER)` on DELETE/INSERT/UPDATE


#### `payments`

*295 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `invoice_id` | uuid | NO | - |
| 4 | `receipt_number` | text | YES | - |
| 5 | `amount` | numeric | NO | - |
| 6 | `payment_method` | USER-DEFINED | NO | `'TM'::payment_method` |
| 7 | `payment_date` | date | NO | `CURRENT_DATE` |
| 8 | `notes` | text | YES | - |
| 9 | `receipt_image_url` | text | YES | - |
| 10 | `created_at` | timestamp with time zone | NO | `now()` |
| 11 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `invoice_id` | `invoices` | `id` | RESTRICT |

**RLS Policies**:

- **SELECT**: `payments_select_rbac`
- **INSERT**: `payments_insert_rbac`
- **UPDATE**: `payments_update_rbac`
- **DELETE**: `payments_delete_rbac`
- **ALL**: `payments_admin_all`, `payments_super_admin_all`

**Triggers**:

- `payments_audit_trigger (AFTER)` on DELETE/INSERT/UPDATE
- `payments_set_user_id_audit (BEFORE)` on INSERT
- `set_payments_updated_at (BEFORE)` on UPDATE
- `trg_payments_recompute_invoice (AFTER)` on DELETE/INSERT/UPDATE


#### `invoice_audit_log`

*2317 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `invoice_id` | uuid | NO | - |
| 3 | `entity` | text | NO | - |
| 4 | `entity_id` | uuid | NO | - |
| 5 | `action` | text | NO | - |
| 6 | `actor_id` | uuid | YES | - |
| 7 | `actor_name` | text | YES | - |
| 8 | `before` | jsonb | YES | - |
| 9 | `after` | jsonb | YES | - |
| 10 | `changed_fields` | ARRAY | YES | - |
| 11 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `invoice_id` | `invoices` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `invoice_audit_log_select_visible`


#### `invoice_generation_settings`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `auto_generate_enabled` | boolean | YES | `false` |
| 4 | `generation_day` | integer | YES | `1` |
| 5 | `due_days` | integer | YES | `5` |
| 6 | `include_previous_debt` | boolean | YES | `true` |
| 7 | `auto_approve` | boolean | YES | `false` |
| 8 | `created_at` | timestamp without time zone | YES | `now()` |
| 9 | `updated_at` | timestamp without time zone | YES | `now()` |

**RLS Policies**:

- **SELECT**: `invoice_generation_settings_select_rbac`
- **INSERT**: `invoice_generation_settings_insert_rbac`
- **UPDATE**: `invoice_generation_settings_update_rbac`
- **DELETE**: `invoice_generation_settings_delete_rbac`
- **ALL**: `invoice_generation_settings_admin_all`, `invoice_generation_settings_super_admin_all`

**Triggers**:

- `invoice_generation_settings_set_user_id_audit (BEFORE)` on INSERT


### V. Sổ quỹ & Thu chi

#### `accounts`

*41 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 5 | `bank_name` | text | YES | - |
| 6 | `account_number` | text | YES | - |
| 7 | `is_default` | boolean | NO | `false` |
| 8 | `created_at` | timestamp with time zone | NO | `now()` |
| 9 | `updated_at` | timestamp with time zone | NO | `now()` |
| 10 | `deleted_at` | timestamp with time zone | YES | - |
| 11 | `code` | text | NO | - |
| 12 | `description` | text | YES | - |
| 13 | `bank_account_holder` | text | YES | - |
| 14 | `initial_amount` | numeric | NO | `0` |
| 15 | `initial_date` | date | NO | `CURRENT_DATE` |
| 16 | `lock_date` | date | YES | - |
| 17 | `branch` | text | YES | - |

**RLS Policies**:

- **SELECT**: `accounts_select`, `accounts_select_shared`, `accounts_select_staff`
- **INSERT**: `accounts_insert`, `accounts_staff_insert`
- **UPDATE**: `accounts_staff_update`, `accounts_update`
- **DELETE**: `accounts_delete`, `accounts_staff_delete`
- **ALL**: `accounts_admin_all`, `accounts_super_admin_all`

**Triggers**:

- `trg_accounts_set_code (BEFORE)` on INSERT


#### `account_shared_users`

*15 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `account_id` | uuid | NO | - |
| 3 | `user_id` | uuid | NO | - |
| 4 | `created_by` | uuid | YES | - |
| 5 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `account_id` | `accounts` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `account_shared_users_select`
- **INSERT**: `account_shared_users_insert`
- **DELETE**: `account_shared_users_delete`
- **ALL**: `account_shared_users_admin_all`


#### `income_expenses`

*576 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `code` | text | YES | - |
| 4 | `type` | text | NO | - |
| 5 | `name` | text | NO | - |
| 6 | `building_id` | uuid | NO | - |
| 7 | `room_id` | uuid | YES | - |
| 8 | `bed_id` | uuid | YES | - |
| 9 | `tenant_id` | uuid | YES | - |
| 10 | `voucher_date` | date | NO | - |
| 11 | `total_amount` | numeric | NO | `0` |
| 12 | `approval_status` | text | NO | `'APPROVED'::text` |
| 13 | `approved_by` | uuid | YES | - |
| 14 | `approved_at` | timestamp with time zone | YES | - |
| 15 | `notes` | text | YES | - |
| 16 | `created_at` | timestamp with time zone | NO | `now()` |
| 17 | `updated_at` | timestamp with time zone | NO | `now()` |
| 18 | `deleted_at` | timestamp with time zone | YES | - |
| 19 | `payer_name` | text | YES | - |
| 20 | `account_id` | uuid | YES | - |
| 21 | `contract_id` | uuid | YES | - |
| 22 | `attachments` | jsonb | NO | `'[]'::jsonb` |
| 23 | `business_result_accounting` | boolean | NO | `false` |
| 24 | `receive_bank_name` | text | YES | - |
| 25 | `receive_bank_account` | text | YES | - |
| 26 | `creator_name` | text | YES | - |
| 27 | `invoice_id` | uuid | YES | - |
| 28 | `repeat_cycle` | text | YES | `'NONE'::text` |
| 29 | `repeat_infinity` | boolean | NO | `false` |
| 30 | `repeat_count` | integer | NO | `0` |
| 31 | `repeat_remaining` | integer | NO | `0` |
| 32 | `repeat_next_date` | date | YES | - |
| 33 | `repeat_parent_id` | uuid | YES | - |
| 34 | `payment_id` | uuid | YES | - |
| 35 | `change_amount` | numeric | NO | `0` |
| 36 | `change_account_id` | uuid | YES | - |
| 37 | `rounding_amount` | numeric | YES | `0` |
| 38 | `rounding_account_id` | uuid | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `account_id` | `accounts` | `id` | SET NULL |
| `bed_id` | `beds` | `id` | SET NULL |
| `building_id` | `buildings` | `id` | RESTRICT |
| `change_account_id` | `accounts` | `id` | SET NULL |
| `contract_id` | `contracts` | `id` | SET NULL |
| `invoice_id` | `invoices` | `id` | SET NULL |
| `payment_id` | `payments` | `id` | SET NULL |
| `repeat_parent_id` | `income_expenses` | `id` | SET NULL |
| `room_id` | `rooms` | `id` | SET NULL |
| `rounding_account_id` | `accounts` | `id` | NO ACTION |
| `tenant_id` | `tenants` | `id` | SET NULL |

**RLS Policies**:

- **SELECT**: `income_expenses_select_rbac`, `income_expenses_select_shared`
- **INSERT**: `income_expenses_insert_rbac`, `income_expenses_insert_shared`
- **UPDATE**: `income_expenses_update_rbac`
- **DELETE**: `income_expenses_delete_rbac`
- **ALL**: `income_expenses_admin_all`, `income_expenses_super_admin_all`

**Triggers**:

- `income_expenses_set_user_id_audit (BEFORE)` on INSERT
- `set_income_expenses_updated_at (BEFORE)` on UPDATE
- `trg_ie_check_lock_del (BEFORE)` on DELETE
- `trg_ie_check_lock_ins (BEFORE)` on INSERT
- `trg_ie_check_lock_upd (BEFORE)` on UPDATE
- `trg_voucher_recompute_invoice (AFTER)` on DELETE/INSERT/UPDATE
- `trigger_auto_generate_voucher_code (BEFORE)` on INSERT


#### `income_expense_items`

*576 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `income_expense_id` | uuid | NO | - |
| 3 | `income_expense_type_id` | uuid | NO | - |
| 4 | `description` | text | YES | - |
| 5 | `quantity` | integer | NO | `1` |
| 6 | `unit_price` | numeric | NO | `0` |
| 7 | `amount` | numeric | YES | - |
| 8 | `notes` | text | YES | - |
| 9 | `created_at` | timestamp with time zone | NO | `now()` |
| 10 | `start_date` | date | YES | - |
| 11 | `end_date` | date | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `income_expense_id` | `income_expenses` | `id` | CASCADE |
| `income_expense_type_id` | `income_expense_types` | `id` | RESTRICT |

**RLS Policies**:

- **SELECT**: `income_expense_items_select_rbac`
- **INSERT**: `income_expense_items_insert_rbac`
- **UPDATE**: `income_expense_items_update_rbac`
- **DELETE**: `income_expense_items_delete_rbac`
- **ALL**: `income_expense_items_admin_all`, `income_expense_items_super_admin_all`

**Triggers**:

- `trg_voucher_item_recompute_invoice (AFTER)` on DELETE/INSERT/UPDATE
- `trigger_auto_calc_item_amount (BEFORE)` on INSERT/UPDATE
- `trigger_auto_recalc_total_amount (AFTER)` on DELETE/INSERT/UPDATE


#### `income_expense_types`

*54 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `name` | text | NO | - |
| 3 | `type` | text | NO | - |
| 4 | `description` | text | YES | - |
| 5 | `is_default` | boolean | YES | `false` |
| 6 | `user_id` | uuid | NO | - |
| 7 | `created_at` | timestamp with time zone | NO | `now()` |
| 8 | `updated_at` | timestamp with time zone | NO | `now()` |
| 9 | `category` | text | YES | - |

**RLS Policies**:

- **SELECT**: `income_expense_types_select_rbac`
- **INSERT**: `income_expense_types_insert_rbac`
- **UPDATE**: `income_expense_types_update_rbac`
- **DELETE**: `income_expense_types_delete_rbac`

**Triggers**:

- `income_expense_types_set_user_id_audit (BEFORE)` on INSERT


#### `income_expense_templates`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `code` | text | YES | - |
| 4 | `name` | text | NO | - |
| 5 | `description` | text | YES | - |
| 6 | `template_file_url` | text | YES | - |
| 7 | `is_default` | boolean | NO | `false` |
| 8 | `is_income_template` | boolean | NO | `false` |
| 9 | `field_mappings` | jsonb | YES | - |
| 10 | `created_at` | timestamp with time zone | NO | `now()` |
| 11 | `updated_at` | timestamp with time zone | NO | `now()` |
| 12 | `deleted_at` | timestamp with time zone | YES | - |

**RLS Policies**:

- **SELECT**: `income_expense_templates_select_rbac`
- **INSERT**: `income_expense_templates_insert_rbac`
- **UPDATE**: `income_expense_templates_update_rbac`
- **DELETE**: `income_expense_templates_delete_rbac`
- **ALL**: `income_expense_templates_admin_all`, `income_expense_templates_super_admin_all`

**Triggers**:

- `income_expense_templates_set_user_id_audit (BEFORE)` on INSERT
- `set_income_expense_templates_updated_at (BEFORE)` on UPDATE
- `trigger_generate_template_code (BEFORE)` on INSERT


#### `income_expense_batches`

*19 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `type` | text | NO | - |
| 5 | `payer_name` | text | YES | - |
| 6 | `attachments` | jsonb | NO | `'[]'::jsonb` |
| 7 | `notes` | text | YES | - |
| 8 | `created_at` | timestamp with time zone | NO | `now()` |
| 9 | `updated_at` | timestamp with time zone | NO | `now()` |
| 10 | `deleted_at` | timestamp with time zone | YES | - |

**RLS Policies**:

- **SELECT**: `income_expense_batches_select_rbac`
- **INSERT**: `income_expense_batches_insert_rbac`
- **UPDATE**: `income_expense_batches_update_rbac`
- **DELETE**: `income_expense_batches_delete_rbac`
- **ALL**: `income_expense_batches_super_admin_all`

**Triggers**:

- `income_expense_batches_set_user_id_audit (BEFORE)` on INSERT
- `trg_ie_batches_updated_at (BEFORE)` on UPDATE


#### `income_expense_batch_items`

*90 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `batch_id` | uuid | NO | - |
| 2 | `income_expense_id` | uuid | NO | - |
| 3 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `batch_id` | `income_expense_batches` | `id` | CASCADE |
| `income_expense_id` | `income_expenses` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `income_expense_batch_items_select_rbac`
- **INSERT**: `income_expense_batch_items_insert_rbac`
- **UPDATE**: `income_expense_batch_items_update_rbac`
- **DELETE**: `income_expense_batch_items_delete_rbac`
- **ALL**: `income_expense_batch_items_super_admin_all`


#### `expenses`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `category` | USER-DEFINED | NO | - |
| 4 | `description` | text | NO | - |
| 5 | `amount` | numeric | NO | - |
| 6 | `expense_date` | date | NO | `CURRENT_DATE` |
| 7 | `building_id` | uuid | YES | - |
| 8 | `room_id` | uuid | YES | - |
| 9 | `notes` | text | YES | - |
| 10 | `receipt_image_url` | text | YES | - |
| 11 | `created_at` | timestamp with time zone | NO | `now()` |
| 12 | `updated_at` | timestamp with time zone | NO | `now()` |
| 13 | `deleted_at` | timestamp with time zone | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `building_id` | `buildings` | `id` | SET NULL |
| `room_id` | `rooms` | `id` | SET NULL |

**RLS Policies**:

- **SELECT**: `expenses_select_rbac`
- **INSERT**: `expenses_insert_rbac`
- **UPDATE**: `expenses_update_rbac`
- **DELETE**: `expenses_delete_rbac`
- **ALL**: `expenses_admin_all`, `expenses_super_admin_all`

**Triggers**:

- `expenses_set_user_id_audit (BEFORE)` on INSERT
- `set_expenses_updated_at (BEFORE)` on UPDATE


#### `auto_debt_config`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `building_id` | uuid | YES | - |
| 3 | `is_enabled` | boolean | YES | `false` |
| 4 | `bank_account` | text | YES | - |
| 5 | `matching_rules` | jsonb | YES | `'{}'::jsonb` |
| 6 | `user_id` | uuid | NO | - |
| 7 | `created_at` | timestamp with time zone | NO | `now()` |
| 8 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `building_id` | `buildings` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `auto_debt_config_select_rbac`
- **INSERT**: `auto_debt_config_insert_rbac`
- **UPDATE**: `auto_debt_config_update_rbac`
- **DELETE**: `auto_debt_config_delete_rbac`
- **ALL**: `auto_debt_config_admin_all`, `auto_debt_config_super_admin_all`

**Triggers**:

- `auto_debt_config_set_user_id_audit (BEFORE)` on INSERT


### VI. Dịch vụ & Đồng hồ

#### `services`

*31 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `code` | text | YES | - |
| 5 | `type` | USER-DEFINED | NO | - |
| 6 | `unit_price` | numeric | NO | `0` |
| 7 | `unit` | text | YES | - |
| 8 | `is_default` | boolean | YES | `false` |
| 9 | `is_mandatory` | boolean | YES | `false` |
| 10 | `description` | text | YES | - |
| 11 | `created_at` | timestamp with time zone | NO | `now()` |
| 12 | `updated_at` | timestamp with time zone | NO | `now()` |
| 13 | `deleted_at` | timestamp with time zone | YES | - |
| 14 | `fee_type` | USER-DEFINED | YES | - |
| 15 | `pricing_type` | USER-DEFINED | YES | - |
| 16 | `tax_rate` | numeric | YES | `0` |
| 18 | `quota_id` | uuid | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `quota_id` | `service_quotas` | `id` | SET NULL |

**RLS Policies**:

- **SELECT**: `services_select_rbac`
- **INSERT**: `services_insert_rbac`
- **UPDATE**: `services_update_rbac`
- **DELETE**: `services_delete_rbac`
- **ALL**: `services_admin_all`, `services_super_admin_all`

**Triggers**:

- `services_set_user_id_audit (BEFORE)` on INSERT
- `set_services_updated_at (BEFORE)` on UPDATE


#### `service_quotas`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `description` | text | YES | - |
| 5 | `deleted_at` | timestamp with time zone | YES | - |
| 6 | `created_at` | timestamp with time zone | NO | `now()` |
| 7 | `updated_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **SELECT**: `service_quotas_select_rbac`
- **INSERT**: `service_quotas_insert_rbac`
- **UPDATE**: `service_quotas_update_rbac`
- **DELETE**: `service_quotas_delete_rbac`
- **ALL**: `service_quotas_admin_all`, `service_quotas_super_admin_all`

**Triggers**:

- `service_quotas_set_user_id_audit (BEFORE)` on INSERT


#### `service_quota_tiers`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `quota_id` | uuid | NO | - |
| 3 | `tier_number` | integer | NO | - |
| 4 | `from_value` | numeric | NO | `0` |
| 5 | `to_value` | numeric | YES | - |
| 6 | `unit_price` | numeric | NO | `0` |
| 7 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `quota_id` | `service_quotas` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `service_quota_tiers_select_rbac`
- **INSERT**: `service_quota_tiers_insert_rbac`
- **UPDATE**: `service_quota_tiers_update_rbac`
- **DELETE**: `service_quota_tiers_delete_rbac`
- **ALL**: `service_quota_tiers_super_admin_all`


#### `meters`

*261 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `code` | text | NO | - |
| 4 | `building_id` | uuid | NO | - |
| 5 | `room_id` | uuid | YES | - |
| 6 | `service_id` | uuid | NO | - |
| 7 | `meter_type` | USER-DEFINED | NO | - |
| 8 | `name` | text | YES | - |
| 9 | `initial_reading` | numeric | YES | `0` |
| 10 | `status` | text | NO | `'ACTIVE'::text` |
| 11 | `installation_date` | date | YES | - |
| 12 | `location_note` | text | YES | - |
| 13 | `manufacturer` | text | YES | - |
| 14 | `model` | text | YES | - |
| 15 | `serial_number` | text | YES | - |
| 16 | `notes` | text | YES | - |
| 17 | `created_at` | timestamp with time zone | NO | `now()` |
| 18 | `updated_at` | timestamp with time zone | NO | `now()` |
| 19 | `deleted_at` | timestamp with time zone | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `building_id` | `buildings` | `id` | CASCADE |
| `room_id` | `rooms` | `id` | SET NULL |
| `service_id` | `services` | `id` | RESTRICT |

**RLS Policies**:

- **SELECT**: `meters_select_rbac`
- **INSERT**: `meters_insert_rbac`
- **UPDATE**: `meters_update_rbac`
- **DELETE**: `meters_delete_rbac`
- **ALL**: `meters_admin_all`, `meters_super_admin_all`

**Triggers**:

- `meters_set_user_id_audit (BEFORE)` on INSERT
- `trigger_auto_generate_meter_name (BEFORE)` on INSERT
- `trigger_update_meters_updated_at (BEFORE)` on UPDATE


#### `meter_readings`

*524 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `meter_id` | uuid | YES | - |
| 4 | `reading_code` | text | YES | - |
| 5 | `contract_id` | uuid | YES | - |
| 6 | `service_id` | uuid | YES | - |
| 7 | `building_id` | uuid | YES | - |
| 8 | `room_id` | uuid | YES | - |
| 9 | `meter_type` | USER-DEFINED | NO | - |
| 10 | `settlement_month` | text | YES | - |
| 11 | `reading_date` | date | NO | - |
| 12 | `previous_reading` | numeric | NO | `0` |
| 13 | `current_reading` | numeric | NO | - |
| 14 | `consumption` | numeric | YES | - |
| 15 | `status` | text | NO | `'UNAPPROVED'::text` |
| 16 | `approved_by` | uuid | YES | - |
| 17 | `approved_at` | timestamp with time zone | YES | - |
| 18 | `recorded_by` | uuid | YES | - |
| 19 | `notes` | text | YES | - |
| 20 | `meter_image_url` | text | YES | - |
| 21 | `created_at` | timestamp with time zone | NO | `now()` |
| 22 | `updated_at` | timestamp with time zone | NO | `now()` |
| 23 | `deleted_at` | timestamp with time zone | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `building_id` | `buildings` | `id` | CASCADE |
| `contract_id` | `contracts` | `id` | CASCADE |
| `meter_id` | `meters` | `id` | CASCADE |
| `room_id` | `rooms` | `id` | CASCADE |
| `service_id` | `services` | `id` | RESTRICT |

**RLS Policies**:

- **SELECT**: `meter_readings_select_rbac`
- **INSERT**: `meter_readings_insert_rbac`
- **UPDATE**: `meter_readings_update_rbac`
- **DELETE**: `meter_readings_delete_rbac`
- **ALL**: `meter_readings_admin_all`, `meter_readings_super_admin_all`

**Triggers**:

- `meter_readings_set_user_id_audit (BEFORE)` on INSERT
- `trigger_auto_generate_reading_code (BEFORE)` on INSERT
- `trigger_auto_populate_meter_reading_fields (BEFORE)` on INSERT
- `trigger_auto_populate_previous_reading (BEFORE)` on INSERT
- `trigger_update_meter_reading_updated_at (BEFORE)` on UPDATE


### VII. Tài sản & Bảo trì

#### `assets`

*585 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `code` | text | YES | - |
| 4 | `name` | text | NO | - |
| 5 | `category_id` | uuid | YES | - |
| 6 | `supplier_id` | uuid | YES | - |
| 7 | `purchase_date` | date | YES | - |
| 8 | `purchase_price` | numeric | YES | - |
| 9 | `condition` | USER-DEFINED | YES | `'GOOD'::asset_condition` |
| 10 | `quantity` | integer | YES | `1` |
| 11 | `building_id` | uuid | YES | - |
| 12 | `room_id` | uuid | YES | - |
| 13 | `description` | text | YES | - |
| 14 | `images` | jsonb | YES | `'[]'::jsonb` |
| 15 | `created_at` | timestamp with time zone | NO | `now()` |
| 16 | `updated_at` | timestamp with time zone | NO | `now()` |
| 17 | `deleted_at` | timestamp with time zone | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `building_id` | `buildings` | `id` | NO ACTION |
| `category_id` | `asset_categories` | `id` | NO ACTION |
| `room_id` | `rooms` | `id` | NO ACTION |
| `supplier_id` | `suppliers` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `assets_select_rbac`
- **INSERT**: `assets_insert_rbac`
- **UPDATE**: `assets_update_rbac`
- **DELETE**: `assets_delete_rbac`
- **ALL**: `assets_admin_all`, `assets_super_admin_all`

**Triggers**:

- `assets_set_user_id_audit (BEFORE)` on INSERT
- `set_assets_updated_at (BEFORE)` on UPDATE


#### `asset_categories`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `description` | text | YES | - |
| 5 | `created_at` | timestamp with time zone | NO | `now()` |
| 6 | `updated_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **SELECT**: `asset_categories_select_rbac`
- **INSERT**: `asset_categories_insert_rbac`
- **UPDATE**: `asset_categories_update_rbac`
- **DELETE**: `asset_categories_delete_rbac`
- **ALL**: `asset_categories_admin_all`, `asset_categories_super_admin_all`

**Triggers**:

- `asset_categories_set_user_id_audit (BEFORE)` on INSERT
- `set_asset_categories_updated_at (BEFORE)` on UPDATE


#### `asset_warehouses`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `name` | text | NO | - |
| 3 | `location` | text | YES | - |
| 4 | `building_id` | uuid | YES | - |
| 5 | `user_id` | uuid | NO | - |
| 6 | `created_at` | timestamp with time zone | NO | `now()` |
| 7 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `building_id` | `buildings` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `asset_warehouses_select_rbac`
- **INSERT**: `asset_warehouses_insert_rbac`
- **UPDATE**: `asset_warehouses_update_rbac`
- **DELETE**: `asset_warehouses_delete_rbac`
- **ALL**: `asset_warehouses_admin_all`, `asset_warehouses_super_admin_all`

**Triggers**:

- `asset_warehouses_set_user_id_audit (BEFORE)` on INSERT


#### `asset_handovers`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `contract_id` | uuid | NO | - |
| 4 | `type` | text | NO | - |
| 5 | `handover_date` | date | NO | - |
| 6 | `items` | jsonb | NO | - |
| 7 | `landlord_signature` | text | YES | - |
| 8 | `tenant_signature` | text | YES | - |
| 9 | `notes` | text | YES | - |
| 10 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `contract_id` | `contracts` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `asset_handovers_select_rbac`
- **INSERT**: `asset_handovers_insert_rbac`
- **UPDATE**: `asset_handovers_update_rbac`
- **DELETE**: `asset_handovers_delete_rbac`
- **ALL**: `asset_handovers_admin_all`, `asset_handovers_super_admin_all`

**Triggers**:

- `asset_handovers_set_user_id_audit (BEFORE)` on INSERT


#### `asset_maintenance`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `asset_id` | uuid | NO | - |
| 4 | `issue_description` | text | NO | - |
| 5 | `maintenance_date` | date | NO | - |
| 6 | `cost` | numeric | YES | - |
| 7 | `assigned_to` | uuid | YES | - |
| 8 | `status` | text | YES | `'PENDING'::text` |
| 9 | `notes` | text | YES | - |
| 10 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `asset_id` | `assets` | `id` | NO ACTION |
| `assigned_to` | `profiles` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `asset_maintenance_select_rbac`
- **INSERT**: `asset_maintenance_insert_rbac`
- **UPDATE**: `asset_maintenance_update_rbac`
- **DELETE**: `asset_maintenance_delete_rbac`
- **ALL**: `asset_maintenance_admin_all`, `asset_maintenance_super_admin_all`

**Triggers**:

- `asset_maintenance_set_user_id_audit (BEFORE)` on INSERT


#### `asset_movements`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `asset_id` | uuid | NO | - |
| 4 | `from_location` | text | YES | - |
| 5 | `to_location` | text | YES | - |
| 6 | `from_room_id` | uuid | YES | - |
| 7 | `to_room_id` | uuid | YES | - |
| 8 | `quantity` | integer | NO | - |
| 9 | `movement_date` | date | NO | - |
| 10 | `reason` | text | YES | - |
| 11 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `asset_id` | `assets` | `id` | NO ACTION |
| `from_room_id` | `rooms` | `id` | NO ACTION |
| `to_room_id` | `rooms` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `asset_movements_select_rbac`
- **INSERT**: `asset_movements_insert_rbac`
- **UPDATE**: `asset_movements_update_rbac`
- **DELETE**: `asset_movements_delete_rbac`
- **ALL**: `asset_movements_admin_all`, `asset_movements_super_admin_all`

**Triggers**:

- `asset_movements_set_user_id_audit (BEFORE)` on INSERT


#### `suppliers`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `phone` | text | YES | - |
| 5 | `email` | text | YES | - |
| 6 | `address` | text | YES | - |
| 7 | `created_at` | timestamp with time zone | NO | `now()` |
| 8 | `updated_at` | timestamp with time zone | NO | `now()` |
| 9 | `deleted_at` | timestamp with time zone | YES | - |

**RLS Policies**:

- **SELECT**: `suppliers_select_rbac`
- **INSERT**: `suppliers_insert_rbac`
- **UPDATE**: `suppliers_update_rbac`
- **DELETE**: `suppliers_delete_rbac`
- **ALL**: `suppliers_admin_all`, `suppliers_super_admin_all`

**Triggers**:

- `set_suppliers_updated_at (BEFORE)` on UPDATE
- `suppliers_set_user_id_audit (BEFORE)` on INSERT


### VIII. Task & Issue

#### `issues`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `title` | text | NO | - |
| 4 | `description` | text | NO | - |
| 5 | `category_id` | uuid | YES | - |
| 6 | `priority` | USER-DEFINED | YES | `'MEDIUM'::issue_priority` |
| 7 | `status` | USER-DEFINED | YES | `'NEW'::issue_status` |
| 8 | `building_id` | uuid | YES | - |
| 9 | `room_id` | uuid | YES | - |
| 10 | `contract_id` | uuid | YES | - |
| 11 | `reported_by_tenant_id` | uuid | YES | - |
| 12 | `reported_by_staff_id` | uuid | YES | - |
| 13 | `assigned_to` | uuid | YES | - |
| 14 | `assigned_at` | timestamp with time zone | YES | - |
| 15 | `due_date` | timestamp with time zone | YES | - |
| 16 | `resolved_at` | timestamp with time zone | YES | - |
| 17 | `closed_at` | timestamp with time zone | YES | - |
| 18 | `estimated_cost` | numeric | YES | - |
| 19 | `actual_cost` | numeric | YES | - |
| 20 | `images` | jsonb | YES | `'[]'::jsonb` |
| 21 | `attachments` | jsonb | YES | `'[]'::jsonb` |
| 22 | `rating` | integer | YES | - |
| 23 | `feedback` | text | YES | - |
| 24 | `created_at` | timestamp with time zone | NO | `now()` |
| 25 | `updated_at` | timestamp with time zone | NO | `now()` |
| 26 | `job_type_id` | uuid | YES | - |
| 27 | `flow_id` | uuid | YES | - |
| 28 | `current_phase_id` | uuid | YES | - |
| 29 | `department_id` | uuid | YES | - |
| 30 | `sla_due_date` | timestamp without time zone | YES | - |
| 31 | `sla_response_time_minutes` | integer | YES | - |
| 32 | `sla_resolution_time_minutes` | integer | YES | - |
| 33 | `first_response_at` | timestamp without time zone | YES | - |
| 34 | `sla_breached` | boolean | YES | `false` |
| 35 | `sla_response_breached` | boolean | YES | `false` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `assigned_to` | `profiles` | `id` | NO ACTION |
| `building_id` | `buildings` | `id` | NO ACTION |
| `category_id` | `issue_categories` | `id` | NO ACTION |
| `contract_id` | `contracts` | `id` | NO ACTION |
| `current_phase_id` | `task_phases` | `id` | NO ACTION |
| `department_id` | `departments` | `id` | NO ACTION |
| `flow_id` | `task_flows` | `id` | NO ACTION |
| `job_type_id` | `job_types` | `id` | NO ACTION |
| `reported_by_staff_id` | `profiles` | `id` | NO ACTION |
| `reported_by_tenant_id` | `tenants` | `id` | NO ACTION |
| `room_id` | `rooms` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `issues_select_rbac`
- **INSERT**: `issues_insert_rbac`
- **UPDATE**: `issues_update_rbac`
- **DELETE**: `issues_delete_rbac`
- **ALL**: `issues_admin_all`, `issues_super_admin_all`

**Triggers**:

- `issues_set_user_id_audit (BEFORE)` on INSERT
- `set_issues_updated_at (BEFORE)` on UPDATE
- `trigger_check_sla_breach (BEFORE)` on UPDATE
- `trigger_log_issue_status_change (BEFORE)` on UPDATE
- `trigger_set_issue_sla (BEFORE)` on INSERT


#### `issue_categories`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `description` | text | YES | - |
| 5 | `created_at` | timestamp with time zone | NO | `now()` |
| 6 | `color` | text | YES | - |
| 7 | `icon` | text | YES | - |
| 8 | `is_active` | boolean | YES | `true` |

**RLS Policies**:

- **SELECT**: `issue_categories_select_rbac`
- **INSERT**: `issue_categories_insert_rbac`
- **UPDATE**: `issue_categories_update_rbac`
- **DELETE**: `issue_categories_delete_rbac`
- **ALL**: `issue_categories_admin_all`, `issue_categories_super_admin_all`

**Triggers**:

- `issue_categories_set_user_id_audit (BEFORE)` on INSERT


#### `issue_comments`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `issue_id` | uuid | NO | - |
| 3 | `user_id` | uuid | NO | - |
| 4 | `comment` | text | NO | - |
| 5 | `images` | jsonb | YES | `'[]'::jsonb` |
| 6 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `issue_id` | `issues` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `issue_comments_select_rbac`
- **INSERT**: `issue_comments_insert_rbac`
- **UPDATE**: `issue_comments_update_rbac`
- **DELETE**: `issue_comments_delete_rbac`
- **ALL**: `issue_comments_admin_all`, `issue_comments_super_admin_all`

**Triggers**:

- `issue_comments_set_user_id_audit (BEFORE)` on INSERT


#### `issue_phase_history`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `issue_id` | uuid | NO | - |
| 3 | `from_phase_id` | uuid | YES | - |
| 4 | `to_phase_id` | uuid | NO | - |
| 5 | `transition_id` | uuid | YES | - |
| 6 | `user_id` | uuid | NO | - |
| 7 | `entered_at` | timestamp with time zone | NO | `now()` |
| 8 | `exited_at` | timestamp with time zone | YES | - |
| 9 | `duration_minutes` | integer | YES | - |
| 10 | `comment` | text | YES | - |
| 11 | `attachments` | jsonb | YES | - |
| 12 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `from_phase_id` | `task_phases` | `id` | NO ACTION |
| `issue_id` | `issues` | `id` | CASCADE |
| `to_phase_id` | `task_phases` | `id` | NO ACTION |
| `transition_id` | `phase_transitions` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `issue_phase_history_select_rbac`
- **INSERT**: `issue_phase_history_insert_rbac`
- **UPDATE**: `issue_phase_history_update_rbac`
- **DELETE**: `issue_phase_history_delete_rbac`
- **ALL**: `issue_phase_history_admin_all`, `issue_phase_history_super_admin_all`

**Triggers**:

- `issue_phase_history_set_user_id_audit (BEFORE)` on INSERT


#### `issue_status_history`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `issue_id` | uuid | NO | - |
| 3 | `user_id` | uuid | NO | - |
| 4 | `old_status` | character varying | YES | - |
| 5 | `new_status` | character varying | NO | - |
| 6 | `changed_by` | uuid | YES | - |
| 7 | `notes` | text | YES | - |
| 8 | `created_at` | timestamp without time zone | YES | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `issue_id` | `issues` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `issue_status_history_select_rbac`
- **INSERT**: `issue_status_history_insert_rbac`
- **UPDATE**: `issue_status_history_update_rbac`
- **DELETE**: `issue_status_history_delete_rbac`
- **ALL**: `issue_status_history_admin_all`, `issue_status_history_super_admin_all`

**Triggers**:

- `issue_status_history_set_user_id_audit (BEFORE)` on INSERT


#### `jobs`

*28 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `code` | text | NO | - |
| 4 | `title` | text | NO | - |
| 5 | `description` | text | YES | - |
| 6 | `building_id` | uuid | YES | - |
| 7 | `room_id` | uuid | YES | - |
| 8 | `bed_id` | uuid | YES | - |
| 10 | `job_type_id` | uuid | YES | - |
| 11 | `priority` | text | NO | `'NORMAL'::text` |
| 12 | `assignee_id` | uuid | YES | - |
| 13 | `deadline` | timestamp with time zone | YES | - |
| 14 | `status` | text | NO | `'IN_PROGRESS'::text` |
| 15 | `visible_to_customer` | boolean | YES | `false` |
| 16 | `attachments` | jsonb | YES | - |
| 17 | `completion_time` | timestamp with time zone | YES | - |
| 18 | `completion_description` | text | YES | - |
| 19 | `completion_attachments` | jsonb | YES | - |
| 20 | `acceptance_result` | text | YES | - |
| 21 | `customer_evaluation` | text | YES | - |
| 22 | `customer_comments` | text | YES | - |
| 23 | `accepted_at` | timestamp with time zone | YES | - |
| 24 | `started_at` | timestamp with time zone | YES | - |
| 25 | `created_at` | timestamp with time zone | YES | `now()` |
| 26 | `updated_at` | timestamp with time zone | YES | `now()` |
| 27 | `assignee_name` | text | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `assignee_id` | `profiles` | `id` | SET NULL |
| `bed_id` | `beds` | `id` | SET NULL |
| `building_id` | `buildings` | `id` | SET NULL |
| `job_type_id` | `job_types` | `id` | SET NULL |
| `room_id` | `rooms` | `id` | SET NULL |

**RLS Policies**:

- **SELECT**: `jobs_select_rbac`
- **INSERT**: `jobs_insert_rbac`
- **UPDATE**: `jobs_update_rbac`
- **DELETE**: `jobs_delete_rbac`
- **ALL**: `jobs_super_admin_all`

**Triggers**:

- `jobs_set_user_id_audit (BEFORE)` on INSERT
- `trigger_generate_job_code (BEFORE)` on INSERT
- `trigger_jobs_updated_at (BEFORE)` on UPDATE


#### `job_groups`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `description` | text | YES | - |
| 5 | `color` | text | YES | - |
| 6 | `icon` | text | YES | - |
| 7 | `created_at` | timestamp with time zone | NO | `now()` |
| 8 | `updated_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **SELECT**: `job_groups_select_rbac`
- **INSERT**: `job_groups_insert_rbac`
- **UPDATE**: `job_groups_update_rbac`
- **DELETE**: `job_groups_delete_rbac`
- **ALL**: `job_groups_admin_all`, `job_groups_super_admin_all`

**Triggers**:

- `job_groups_set_user_id_audit (BEFORE)` on INSERT


#### `job_types`

*7 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `job_group_id` | uuid | YES | - |
| 5 | `description` | text | YES | - |
| 6 | `default_priority` | USER-DEFINED | YES | `'MEDIUM'::issue_priority` |
| 7 | `customer_contact_deadline` | integer | YES | `0` |
| 8 | `acceptance_deadline` | integer | YES | `0` |
| 9 | `completion_deadline` | integer | YES | `0` |
| 10 | `business_hours_only` | boolean | YES | `false` |
| 11 | `default_department_id` | uuid | YES | - |
| 12 | `auto_assign` | boolean | YES | `false` |
| 13 | `is_active` | boolean | YES | `true` |
| 14 | `created_at` | timestamp with time zone | NO | `now()` |
| 15 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `default_department_id` | `departments` | `id` | NO ACTION |
| `job_group_id` | `job_groups` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `job_types_select_rbac`
- **INSERT**: `job_types_insert_rbac`
- **UPDATE**: `job_types_update_rbac`
- **DELETE**: `job_types_delete_rbac`
- **ALL**: `job_types_admin_all`, `job_types_super_admin_all`

**Triggers**:

- `job_types_set_user_id_audit (BEFORE)` on INSERT


#### `task_flows`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `description` | text | YES | - |
| 5 | `job_type_id` | uuid | YES | - |
| 6 | `is_active` | boolean | YES | `true` |
| 7 | `is_default` | boolean | YES | `false` |
| 8 | `created_at` | timestamp with time zone | NO | `now()` |
| 9 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `job_type_id` | `job_types` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `task_flows_select_rbac`
- **INSERT**: `task_flows_insert_rbac`
- **UPDATE**: `task_flows_update_rbac`
- **DELETE**: `task_flows_delete_rbac`
- **ALL**: `task_flows_admin_all`, `task_flows_super_admin_all`

**Triggers**:

- `task_flows_set_user_id_audit (BEFORE)` on INSERT


#### `task_phases`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `flow_id` | uuid | NO | - |
| 3 | `name` | text | NO | - |
| 4 | `description` | text | YES | - |
| 5 | `sequence_order` | integer | NO | - |
| 6 | `phase_type` | text | NO | - |
| 7 | `auto_transition` | boolean | YES | `false` |
| 8 | `transition_conditions` | jsonb | YES | - |
| 9 | `time_limit` | integer | YES | - |
| 10 | `require_comment` | boolean | YES | `false` |
| 11 | `require_attachment` | boolean | YES | `false` |
| 12 | `require_rating` | boolean | YES | `false` |
| 13 | `allowed_departments` | ARRAY | YES | - |
| 14 | `notify_on_enter` | boolean | YES | `false` |
| 15 | `notify_template_id` | uuid | YES | - |
| 16 | `color` | text | YES | - |
| 17 | `icon` | text | YES | - |
| 18 | `created_at` | timestamp with time zone | NO | `now()` |
| 19 | `updated_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `flow_id` | `task_flows` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `task_phases_select_rbac`
- **INSERT**: `task_phases_insert_rbac`
- **UPDATE**: `task_phases_update_rbac`
- **DELETE**: `task_phases_delete_rbac`
- **ALL**: `task_phases_admin_all`, `task_phases_super_admin_all`


#### `task_types`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `name` | text | NO | - |
| 3 | `description` | text | YES | - |
| 4 | `color` | text | YES | - |
| 5 | `user_id` | uuid | NO | - |
| 6 | `created_at` | timestamp with time zone | NO | `now()` |
| 7 | `updated_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **SELECT**: `task_types_select_rbac`
- **INSERT**: `task_types_insert_rbac`
- **UPDATE**: `task_types_update_rbac`
- **DELETE**: `task_types_delete_rbac`
- **ALL**: `task_types_admin_all`, `task_types_super_admin_all`

**Triggers**:

- `task_types_set_user_id_audit (BEFORE)` on INSERT


#### `phase_transitions`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `from_phase_id` | uuid | NO | - |
| 3 | `to_phase_id` | uuid | NO | - |
| 4 | `name` | text | NO | - |
| 5 | `description` | text | YES | - |
| 6 | `require_approval` | boolean | YES | `false` |
| 7 | `approval_roles` | ARRAY | YES | - |
| 8 | `actions` | jsonb | YES | - |
| 9 | `button_label` | text | YES | - |
| 10 | `button_color` | text | YES | - |
| 11 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `from_phase_id` | `task_phases` | `id` | CASCADE |
| `to_phase_id` | `task_phases` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `phase_transitions_select_rbac`
- **INSERT**: `phase_transitions_insert_rbac`
- **UPDATE**: `phase_transitions_update_rbac`
- **DELETE**: `phase_transitions_delete_rbac`
- **ALL**: `phase_transitions_admin_all`, `phase_transitions_super_admin_all`


#### `sla_configs`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `priority` | character varying | NO | - |
| 4 | `response_time_minutes` | integer | NO | - |
| 5 | `resolution_time_minutes` | integer | NO | - |
| 6 | `is_active` | boolean | YES | `true` |
| 7 | `created_at` | timestamp without time zone | YES | `now()` |
| 8 | `updated_at` | timestamp without time zone | YES | `now()` |

**RLS Policies**:

- **SELECT**: `sla_configs_select_rbac`
- **INSERT**: `sla_configs_insert_rbac`
- **UPDATE**: `sla_configs_update_rbac`
- **DELETE**: `sla_configs_delete_rbac`
- **ALL**: `sla_configs_admin_all`, `sla_configs_super_admin_all`

**Triggers**:

- `sla_configs_set_user_id_audit (BEFORE)` on INSERT


### IX. Notification & Template

#### `notifications`

*25 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `type` | USER-DEFINED | NO | - |
| 4 | `channel` | USER-DEFINED | NO | - |
| 5 | `recipient_tenant_ids` | ARRAY | YES | - |
| 6 | `recipient_emails` | ARRAY | YES | - |
| 7 | `recipient_phones` | ARRAY | YES | - |
| 8 | `subject` | text | YES | - |
| 9 | `content` | text | NO | - |
| 10 | `invoice_id` | uuid | YES | - |
| 11 | `contract_id` | uuid | YES | - |
| 12 | `issue_id` | uuid | YES | - |
| 13 | `scheduled_at` | timestamp with time zone | YES | - |
| 14 | `sent_at` | timestamp with time zone | YES | - |
| 15 | `status` | USER-DEFINED | YES | `'PENDING'::notification_status` |
| 16 | `error_message` | text | YES | - |
| 17 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `contract_id` | `contracts` | `id` | NO ACTION |
| `issue_id` | `issues` | `id` | NO ACTION |

**RLS Policies**:

- **SELECT**: `Users can view own notifications`, `notifications_select_staff`
- **INSERT**: `Users can insert own notifications`, `notifications_staff_insert`
- **UPDATE**: `Users can update own notifications`, `notifications_staff_update`
- **DELETE**: `Users can delete own notifications`, `notifications_staff_delete`
- **ALL**: `Users can manage own notifications`, `notifications_admin_all`, `notifications_super_admin_all`


#### `notification_logs`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `notification_id` | uuid | NO | - |
| 3 | `recipient_id` | uuid | YES | - |
| 4 | `recipient_email` | text | YES | - |
| 5 | `recipient_phone` | text | YES | - |
| 6 | `channel` | USER-DEFINED | NO | - |
| 7 | `status` | USER-DEFINED | NO | - |
| 8 | `sent_at` | timestamp with time zone | YES | - |
| 9 | `error_message` | text | YES | - |
| 10 | `provider_response` | jsonb | YES | - |
| 11 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `notification_id` | `notifications` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `Users can view logs of own notifications`
- **ALL**: `notification_logs_admin_all`, `notification_logs_super_admin_all`


#### `notification_templates`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `type` | USER-DEFINED | NO | - |
| 4 | `name` | text | NO | - |
| 5 | `email_subject` | text | YES | - |
| 6 | `email_body` | text | YES | - |
| 7 | `sms_content` | text | YES | - |
| 8 | `zalo_template_id` | text | YES | - |
| 9 | `push_title` | text | YES | - |
| 10 | `push_body` | text | YES | - |
| 11 | `is_active` | boolean | YES | `true` |
| 12 | `created_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **SELECT**: `notification_templates_select_rbac`
- **INSERT**: `notification_templates_insert_rbac`
- **UPDATE**: `notification_templates_update_rbac`
- **DELETE**: `notification_templates_delete_rbac`
- **ALL**: `notification_templates_admin_all`, `notification_templates_super_admin_all`

**Triggers**:

- `notification_templates_set_user_id_audit (BEFORE)` on INSERT


#### `document_templates`

*6 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `code` | character varying | NO | - |
| 4 | `name` | character varying | NO | - |
| 5 | `category` | USER-DEFINED | NO | - |
| 6 | `description` | text | YES | - |
| 7 | `file_url` | text | NO | - |
| 8 | `file_name` | character varying | NO | - |
| 9 | `file_size` | integer | YES | - |
| 10 | `file_type` | character varying | YES | `'docx'::character varying` |
| 11 | `is_default` | boolean | YES | `false` |
| 12 | `is_active` | boolean | YES | `true` |
| 13 | `created_at` | timestamp with time zone | YES | `now()` |
| 14 | `updated_at` | timestamp with time zone | YES | `now()` |
| 15 | `deleted_at` | timestamp with time zone | YES | - |
| 16 | `content` | text | YES | - |
| 17 | `variables` | jsonb | YES | `'[]'::jsonb` |
| 18 | `type` | text | YES | - |

**RLS Policies**:

- **SELECT**: `document_templates_select_rbac`
- **INSERT**: `document_templates_insert_rbac`
- **UPDATE**: `document_templates_update_rbac`
- **DELETE**: `document_templates_delete_rbac`
- **ALL**: `document_templates_admin_all`, `document_templates_super_admin_all`

**Triggers**:

- `document_templates_set_user_id_audit (BEFORE)` on INSERT
- `ensure_single_default_template_trigger (BEFORE)` on INSERT/UPDATE
- `set_document_templates_updated_at (BEFORE)` on UPDATE


#### `signature_templates`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `code` | text | NO | - |
| 4 | `name` | text | NO | - |
| 5 | `signature_type` | text | NO | - |
| 6 | `signature_url` | text | YES | - |
| 7 | `signature_data` | jsonb | YES | - |
| 8 | `text_content` | text | YES | - |
| 9 | `font_style` | text | YES | - |
| 10 | `is_active` | boolean | YES | `true` |
| 11 | `created_at` | timestamp with time zone | NO | `now()` |
| 12 | `updated_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **SELECT**: `signature_templates_select_rbac`
- **INSERT**: `signature_templates_insert_rbac`
- **UPDATE**: `signature_templates_update_rbac`
- **DELETE**: `signature_templates_delete_rbac`
- **ALL**: `signature_templates_admin_all`, `signature_templates_super_admin_all`

**Triggers**:

- `set_signature_templates_updated_at (BEFORE)` on UPDATE
- `signature_templates_set_user_id_audit (BEFORE)` on INSERT


#### `hotlines`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `name` | text | NO | - |
| 3 | `phone_number` | text | NO | - |
| 4 | `description` | text | YES | - |
| 5 | `is_active` | boolean | YES | `true` |
| 6 | `user_id` | uuid | NO | - |
| 7 | `created_at` | timestamp with time zone | NO | `now()` |
| 8 | `updated_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **SELECT**: `hotlines_select_rbac`
- **INSERT**: `hotlines_insert_rbac`
- **UPDATE**: `hotlines_update_rbac`
- **DELETE**: `hotlines_delete_rbac`
- **ALL**: `hotlines_admin_all`, `hotlines_super_admin_all`

**Triggers**:

- `hotlines_set_user_id_audit (BEFORE)` on INSERT


### X. AI & System

#### `ai_conversations`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `title` | text | NO | - |
| 4 | `summary` | text | YES | - |
| 5 | `message_count` | integer | YES | `0` |
| 6 | `total_tokens_used` | integer | YES | `0` |
| 7 | `referenced_entities` | jsonb | YES | `'[]'::jsonb` |
| 8 | `tags` | jsonb | YES | `'[]'::jsonb` |
| 9 | `is_pinned` | boolean | YES | `false` |
| 10 | `is_archived` | boolean | YES | `false` |
| 11 | `created_at` | timestamp with time zone | NO | `now()` |
| 12 | `updated_at` | timestamp with time zone | NO | `now()` |
| 13 | `last_message_at` | timestamp with time zone | YES | - |
| 14 | `deleted_at` | timestamp with time zone | YES | - |

**RLS Policies**:

- **SELECT**: `Users can view own conversations`
- **INSERT**: `Users can insert own conversations`
- **UPDATE**: `Users can update own conversations`
- **DELETE**: `Users can delete own conversations`
- **ALL**: `ai_conversations_admin_all`, `ai_conversations_super_admin_all`

**Triggers**:

- `set_ai_conversations_updated_at (BEFORE)` on UPDATE


#### `ai_messages`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `conversation_id` | uuid | NO | - |
| 3 | `role` | USER-DEFINED | NO | - |
| 4 | `content` | text | NO | - |
| 5 | `tokens_used` | integer | YES | `0` |
| 6 | `context_used` | jsonb | YES | `'[]'::jsonb` |
| 7 | `referenced_entities` | jsonb | YES | `'[]'::jsonb` |
| 8 | `model` | text | YES | - |
| 9 | `temperature` | numeric | YES | - |
| 10 | `created_at` | timestamp with time zone | NO | `now()` |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `conversation_id` | `ai_conversations` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `Users can view messages of own conversations`
- **INSERT**: `Users can insert messages to own conversations`
- **ALL**: `ai_messages_admin_all`, `ai_messages_super_admin_all`

**Triggers**:

- `auto_generate_conversation_title_trigger (AFTER)` on INSERT
- `update_conversation_stats_on_message_trigger (AFTER)` on INSERT


#### `ai_memory_embeddings`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `conversation_id` | uuid | YES | - |
| 4 | `message_id` | uuid | YES | - |
| 5 | `content` | text | NO | - |
| 6 | `embedding` | USER-DEFINED | YES | - |
| 7 | `entity_type` | text | YES | - |
| 8 | `entity_id` | uuid | YES | - |
| 9 | `entity_name` | text | YES | - |
| 10 | `importance_score` | numeric | YES | `0.5` |
| 11 | `access_count` | integer | YES | `0` |
| 12 | `created_at` | timestamp with time zone | NO | `now()` |
| 13 | `last_accessed_at` | timestamp with time zone | YES | - |

**Foreign keys**:

| Cột | → Bảng | Cột đích | ON DELETE |
|---|---|---|---|
| `conversation_id` | `ai_conversations` | `id` | CASCADE |
| `message_id` | `ai_messages` | `id` | CASCADE |

**RLS Policies**:

- **SELECT**: `Users can view own memory embeddings`
- **INSERT**: `Users can insert own memory embeddings`
- **UPDATE**: `Users can update own memory embeddings`
- **DELETE**: `Users can delete own memory embeddings`
- **ALL**: `ai_memory_embeddings_admin_all`, `ai_memory_embeddings_super_admin_all`


#### `ai_usage_stats`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `period_start` | date | NO | - |
| 4 | `period_end` | date | NO | - |
| 5 | `total_conversations` | integer | YES | `0` |
| 6 | `total_messages` | integer | YES | `0` |
| 7 | `total_tokens_used` | integer | YES | `0` |
| 8 | `total_embeddings_created` | integer | YES | `0` |
| 9 | `estimated_cost` | numeric | YES | `0` |
| 10 | `created_at` | timestamp with time zone | NO | `now()` |
| 11 | `updated_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **SELECT**: `Users can view own usage stats`
- **ALL**: `ai_usage_stats_admin_all`, `ai_usage_stats_super_admin_all`

**Triggers**:

- `set_ai_usage_stats_updated_at (BEFORE)` on UPDATE


#### `scheduled_jobs`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `job_type` | character varying | NO | - |
| 4 | `schedule` | character varying | NO | - |
| 5 | `last_run_at` | timestamp without time zone | YES | - |
| 6 | `next_run_at` | timestamp without time zone | YES | - |
| 7 | `is_active` | boolean | YES | `true` |
| 8 | `config` | jsonb | YES | `'{}'::jsonb` |
| 9 | `created_at` | timestamp without time zone | YES | `now()` |
| 10 | `updated_at` | timestamp without time zone | YES | `now()` |

**RLS Policies**:

- **SELECT**: `scheduled_jobs_select_rbac`
- **INSERT**: `scheduled_jobs_insert_rbac`
- **UPDATE**: `scheduled_jobs_update_rbac`
- **DELETE**: `scheduled_jobs_delete_rbac`
- **ALL**: `scheduled_jobs_admin_all`, `scheduled_jobs_super_admin_all`

**Triggers**:

- `scheduled_jobs_set_user_id_audit (BEFORE)` on INSERT


#### `code_sequences`

*0 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `object_type` | text | NO | - |
| 4 | `prefix` | text | NO | - |
| 5 | `separator` | text | YES | `'-'::text` |
| 6 | `date_format` | text | YES | - |
| 7 | `sequence_length` | integer | YES | `4` |
| 8 | `current_sequence` | integer | YES | `0` |
| 9 | `reset_period` | text | YES | `'YEARLY'::text` |
| 10 | `last_reset_at` | date | YES | - |
| 11 | `created_at` | timestamp with time zone | NO | `now()` |
| 12 | `updated_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **ALL**: `Users can manage own code sequences`, `code_sequences_admin_all`, `code_sequences_super_admin_all`

**Triggers**:

- `set_code_sequences_updated_at (BEFORE)` on UPDATE


#### `settings`

*2 rows · RLS: enabled*

**Columns**:

| # | Tên | Kiểu | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `user_id` | uuid | NO | - |
| 3 | `key` | text | NO | - |
| 4 | `value` | jsonb | NO | - |
| 5 | `created_at` | timestamp with time zone | NO | `now()` |
| 6 | `updated_at` | timestamp with time zone | NO | `now()` |

**RLS Policies**:

- **SELECT**: `settings_select_staff`
- **INSERT**: `settings_staff_insert`
- **UPDATE**: `settings_staff_update`
- **DELETE**: `settings_staff_delete`
- **ALL**: `Users can manage own settings`, `settings_admin_all`, `settings_super_admin_all`

**Triggers**:

- `set_settings_updated_at (BEFORE)` on UPDATE


## 5. Helper functions (RBAC)

Các function dùng trong RLS policies + RPC để kiểm tra quyền:

| Function | Args | Mô tả |
|---|---|---|
| `is_super_admin` | `(none)` | Caller có row trong `super_admins` |
| `is_admin` | `(none)` | Caller có role permissions.__superadmin = true hoặc role.name = Admin |
| `can_access_building` | `_building_id uuid` | (SELECT) caller có quyền XEM building qua `staff_assignments` |
| `can_do_on_building` | `_table text, _action text, _building_id uuid` | (CUD) caller có quyền {action} trên {table} cho building cụ thể |
| `can_access_org_entity` | `_resource text, _action text` | Caller có quyền {action} trên global entity (không gắn building) |
| `building_of_contract` | `_id uuid` | Trả về `rooms.building_id` cho contract |
| `building_of_invoice` | `_id uuid` | Trả về `invoices.building_id` (direct) |
| `building_of_payment` | `_id uuid` | Trả về building_id của invoice cha của payment |
| `staff_can` | `_table text, _action text, _owner uuid` | (Legacy) check qua staff_assignments + role permissions cho `_owner` |
| `staff_in_building` | `_owner uuid, _building_id uuid` | (Legacy) caller staff cho `_owner` + có scope đúng building |
| `current_visible_owner_ids` | `(none)` | (Legacy) array các owner_id caller được xem |
| `customer_in_my_scope` | `_owner uuid, _customer_id uuid` | (Legacy) customer có active contract trong staff scope của caller |
| `is_account_owner` | `p_account_id uuid` | (Sổ quỹ) caller là owner của account |
| `is_account_shared_with_me` | `p_account_id uuid` | (Sổ quỹ) caller có trong `account_shared_users` |
| `set_user_id_from_auth` | `(none)` | Trigger fn: BEFORE INSERT set `NEW.user_id = auth.uid()` nếu NULL |
| `get_my_context` | `(none)` | RPC: { is_super, is_staff, owner_id } cho caller |
| `get_my_permissions` | `(none)` | RPC: trả về JSONB permissions của role caller |
| `get_my_assignments` | `(none)` | RPC: array (user_id, building_id) staff_assignments của caller |

## 6. RPCs công khai (frontend gọi)

Tổng **37** RPC SECURITY DEFINER. Danh sách đầy đủ:

| Function | Args |
|---|---|
| `approve_meter_reading` | `p_reading_id uuid` |
| `approve_voucher` | `voucher_id uuid` |
| `bulk_approve_meter_readings` | `p_reading_ids uuid[]` |
| `bulk_create_meter_readings` | `p_readings jsonb` |
| `create_new_contract_extension` | `p_contract_id uuid, p_extension_months integer, p_new_rent_price numeric, p_new_deposit numeric, p_n` |
| `create_room_transfer` | `p_contract_id uuid, p_new_room_id uuid, p_new_bed_id uuid, p_new_rent_price numeric, p_move_date dat` |
| `create_simple_extension` | `p_contract_id uuid, p_extension_months integer, p_new_rent_price numeric, p_notes text` |
| `create_tenant_transfer` | `p_contract_id uuid, p_new_tenant_id uuid, p_transfer_date date, p_transfer_fee numeric, p_reason tex` |
| `delete_staff_member` | `p_staff_id uuid` |
| `generate_invoices_for_building` | `p_user_id uuid, p_building_id uuid, p_billing_month text, p_invoice_type text` |
| `generate_invoices_for_building_v2` | `p_building_id uuid, p_billing_month text, p_invoice_type text` |
| `generate_job_code` | `` |
| `generate_recurring_vouchers` | `p_user_id uuid` |
| `generate_recurring_vouchers_v2` | `` |
| `get_invoice_statistics_v2` | `p_building_id uuid, p_room_id uuid, p_status invoice_status, p_start_date date, p_end_date date, p_b` |
| `get_meters_without_readings_v2` | `p_building_id uuid, p_room_id uuid, p_meter_type text, p_month text` |
| `get_public_latest_invoice_by_contract` | `p_contract_id uuid` |
| `handle_new_user` | `` |
| `is_staff_of` | `owner_id uuid` |
| `recompute_invoice_after_item_change` | `` |
| `recompute_invoice_after_payment_change` | `` |
| `recompute_invoice_after_voucher_change` | `` |
| `recompute_invoice_for_id` | `p_invoice_id uuid` |
| `record_invoice_payment_v2` | `p_invoice_id uuid, p_amount numeric, p_payment_method payment_method, p_payment_date date, p_notes t` |
| `renew_contract` | `p_contract_id uuid, p_new_end_date date, p_new_rent_price numeric, p_new_deposit numeric, p_notes te` |
| `seed_commission_expense_types` | `p_user_id uuid` |
| `settle_previous_debt_sources` | `` |
| `soft_delete_customer` | `p_customer_id uuid` |
| `staff_building_scope` | `owner_id uuid` |
| `super_admin_force_cancel_invoice` | `p_invoice_id uuid` |
| `terminate_contract_forfeit` | `p_contract_id uuid, p_forfeit_date date` |
| `terminate_contract_move_out` | `p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric, p_penalty_fee numeric, p_excess_` |
| `transfer_contract` | `p_contract_id uuid, p_new_customer_id uuid, p_new_rent_price numeric, p_new_deposit numeric, p_trans` |
| `transfer_room` | `p_contract_id uuid, p_new_room_id uuid, p_new_bed_id uuid, p_new_rent_price numeric, p_transfer_date` |
| `trg_seed_commission_types_on_user_create` | `` |
| `unapprove_voucher` | `voucher_id uuid` |
| `update_income_expense_quick` | `p_id uuid, p_account_id uuid, p_attachments jsonb, p_notes text` |

## 7. Triggers tổng hợp

Tổng 150 trigger trên 65 bảng.

Loại trigger phổ biến:

| Pattern | Số lượng |
|---|---|
| set_user_id_audit (RBAC) | 51 |
| set_updated_at | 35 |
| other | 27 |
| auto-generate code | 10 |
| recompute invoice | 9 |
| audit log | 9 |
| sync status | 5 |
| enforce lock_date | 3 |
| check constraint | 1 |

## 8. Views

| View | Mô tả |
|---|---|
| `accounts_with_balance` | Sổ quỹ kèm cột balance tính sẵn |
| `contract_extension_history` | - |
| `meter_readings_detailed` | Chỉ số kèm thông tin meter + room + building |
| `meters_with_latest_reading` | Đồng hồ kèm chỉ số mới nhất |
| `v_termination_calculation` | Tính toán thanh lý hợp đồng |

## 9. Quan hệ tổng (FK graph)

Các đường dẫn FK quan trọng:

```
areas                                  (TOP, NATHAN/JOEY)
  └─ buildings.area_id
     └─ rooms.building_id
     │   └─ beds.room_id
     │   └─ contracts.room_id
     │       └─ contract_customers.contract_id
     │       └─ contract_tenants.contract_id
     │       └─ contract_services.contract_id
     │       └─ contract_extensions.contract_id
     │       └─ contract_terminations.contract_id
     │       └─ contract_transfers.contract_id
     │       └─ deposits.contract_id
     │       └─ invoices.contract_id
     │           └─ invoice_items.invoice_id
     │           └─ payments.invoice_id
     │           └─ excess_amounts.source_invoice_id
     │           └─ income_expenses.invoice_id
     │
     └─ floors.building_id
     └─ building_services.building_id
     └─ meters.building_id
         └─ meter_readings.meter_id

accounts                               (sổ quỹ — entity riêng)
  └─ income_expenses.account_id
  └─ income_expenses.change_account_id  (sổ tiền thối)
  └─ income_expenses.rounding_account_id (sổ làm tròn)
  └─ account_shared_users.account_id

auth.users (Supabase managed)          (RBAC)
  ├─ profiles.id                       (1:1 mirror, tự động qua trigger)
  ├─ super_admins.user_id              (super admin set, hiện có 1 entry: Tâm)
  ├─ staff_assignments.staff_id        (staff → role + building scope)
  ├─ staff_assignments.user_id         (= owner mà staff đại diện, hiện = Tâm)
  └─ <data table>.user_id              (audit: ai tạo row; KHÔNG dùng cho access)
```

## 10. Mô hình phân quyền (RBAC)

### Cấp độ quyền (4 tier)

| Tier | Bảng/Mechanism | Mô tả |
|---|---|---|
| 1. Super admin | `super_admins` table | Toàn quyền, bypass RLS bằng `is_super_admin()` |
| 2. Admin role | `roles.permissions` có `__superadmin: true` HOẶC `roles.name = Admin` | Bypass tương đương super_admin qua `is_admin()` |
| 3. Staff full-scope | `staff_assignments` với `building_id IS NULL` | Quyền theo `roles.permissions` JSONB, áp dụng cho TẤT CẢ buildings |
| 4. Staff per-building | `staff_assignments` với `building_id = X` | Chỉ thấy/sửa data thuộc building X (qua FK chain) |

### Schema permissions JSONB (trong bảng `roles`)

```json
{
  "buildings":   { "view": true, "create": true, "edit": true, "delete": true, "export": true, "print": true, "approve": true },
  "rooms":       { "view": true, "create": true, "edit": true, "delete": true },
  "contracts":   { "view": true, "create": true, "edit": true, "delete": true },
  "invoices":    { "view": true, "create": true, "edit": true, "delete": true, "record_payment": true },
  "income_expenses": { "view": true, "create": true, "edit": true, "delete": true },
  "customers":   { "view": true, "create": true, "edit": true, "delete": true },
  "tasks":       { "view": true, "create": true, "edit": true, "delete": true },
  "__superadmin": true
}
```

**Resources khả dụng** (key trong JSONB):
- Bất động sản: `areas`, `buildings`, `rooms`, `beds`, `floors`, `building_layout`, `building_services`
- Khách hàng: `contracts`, `customers`, `tenants`, `deposits`, `vehicles`
- Tài chính: `invoices`, `payments`, `cashbooks`, `income_expenses`, `excess_amounts`, `reports_finance`, `auto_debt`
- Dịch vụ: `services`, `service_quotas`, `meters`, `meter_readings`
- Tài sản: `assets`, `asset_types`, `warehouses`
- Công việc: `tasks` (= jobs/issues), `task_types`, `leads`, `hotline`
- Cấu hình: `templates`, `document_templates`, `signature_templates`, `settings`, `categories`
- Hệ thống: `notifications`, `roles`, `users`, `subscription`, `reports_real_estate`, `reports_tasks`

### Helper RBAC

```sql
-- Xem được không?
SELECT can_access_building($building_id);

-- Sửa được không?
SELECT can_do_on_building('invoices', 'edit', $building_id);

-- Cho global entity (customers, services, ...)
SELECT can_access_org_entity('customers', 'create');

-- Trong RPC SECURITY DEFINER
SELECT * FROM invoices i WHERE can_access_building(i.building_id);
```

### Frontend hooks tương ứng

| Hook | Mục đích | RPC |
|---|---|---|
| `useMyContext` | { is_super, is_staff, owner_id } | `get_my_context` |
| `useMyPermissions` | JSONB permissions của caller | `get_my_permissions` |
| `useMyBuildingScope` | Danh sách building staff được giao | `get_my_assignments` |
| `useIsAdmin` | Caller có quyền admin? | `is_admin` |
| `useStaffAssignments` | CRUD staff_assignments | (direct table) |

### Lưu ý quan trọng khi viết code mới

1. **KHÔNG** filter `.eq("user_id", auth_uid)` trong frontend — RLS đã handle. (Trừ bảng cá nhân: `settings`, `user_subscriptions`, `notifications`).
2. **KHÔNG** truyền `p_user_id` vào RPC mới — dùng RPC v2 nếu có (`*_v2` suffix) hoặc `auth.uid()` trực tiếp trong SECURITY DEFINER function.
3. **KHÔNG** set `user_id: user.id` khi INSERT — trigger `set_user_id_from_auth` tự fill. Nếu bỏ qua, RLS INSERT check sẽ chặn (dùng `can_do_on_building`).
4. Khi tạo bảng mới có `building_id`: thêm trigger `set_user_id_audit` + 4 policy `*_rbac` theo pattern Phase 4.
5. Bảng config global (không gắn building): dùng `can_access_org_entity(resource, action)` theo pattern Phase 5.

---

*File này được generate tự động ngày 2026-05-28. Để cập nhật, chạy lại `.scratch/gen_schema.cjs`.*