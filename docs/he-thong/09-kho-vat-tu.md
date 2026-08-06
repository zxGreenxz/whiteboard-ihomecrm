# Kho vật tư tiêu hao (Materials)

> Domain quản lý **vật tư tiêu hao** dùng cho công tác bảo trì/sửa chữa toà nhà
> (bóng đèn, vòi nước, ống nước, ron, keo…). Khác với domain **Tài sản (assets)**
> — vốn theo dõi thiết bị có giá trị, có khấu hao, gắn phòng — kho vật tư theo
> dõi **số lượng tồn** và **giá vốn trung bình**, cập nhật tự động khi nhập / xuất / kiểm kê.

Nguồn code chính:

- Page: [MaterialsPage.tsx](src/pages/materials/MaterialsPage.tsx) (hub 3+1 tab), [SuppliersPage.tsx](src/pages/settings/categories/SuppliersPage.tsx) (placeholder).
- Hooks: [useMaterials.ts](src/hooks/useMaterials.ts), [useMaterialCategories.ts](src/hooks/useMaterialCategories.ts), [useMaterialPurchases.ts](src/hooks/useMaterialPurchases.ts), [useMaterialUsages.ts](src/hooks/useMaterialUsages.ts), [useMaterialAdjustments.ts](src/hooks/useMaterialAdjustments.ts). (Lưu ý: `useMaterials.ts` còn export `useMaterial` — hook detail theo id — hiện **không component nào dùng** (dead export) và **không** lọc `deleted_at`.)
- Components: thư mục [src/components/materials/](src/components/materials/). UI tạo/sửa **phiếu xuất gắn job** nằm bên domain Công việc: [MaterialUsageSection](src/components/materials/MaterialUsageSection.tsx) nhúng trong [TaskDetailDialog](src/components/tasks/TaskDetailDialog.tsx) **và** [MaterialUsageItemsEditor](src/components/materials/MaterialUsageItemsEditor.tsx) nhúng trong [TaskCreateDialog](src/components/tasks/TaskCreateDialog.tsx); từ 2026-06-30 (40369a7) có thêm [MaterialUsageFormDialog](src/components/materials/MaterialUsageFormDialog.tsx) — tạo phiếu xuất **bằng tay, không gắn job** ngay trên tab Phiếu xuất.
- Validation: [materialValidation.ts](src/lib/materialValidation.ts).
- Migration: [20260529000004_create_materials_inventory.sql](supabase/migrations/20260529000004_create_materials_inventory.sql).

> **Gotcha types**: dù [types.ts](src/integrations/supabase/types.ts) (regen 2026-06-07) đã có đủ
> các bảng `material_*`, toàn bộ hooks vẫn gọi `.from('materials' as any)`… và tự định nghĩa
> interface tay ở [src/types/material.ts](src/types/material.ts). Lý do một phần: Insert type
> generated yêu cầu `code`/`user_id` (thực tế do trigger điền) nên cast `as any` cho tiện.

---

## 1. Tổng quan & vai trò nghiệp vụ

Kho vật tư là **một kho chung duy nhất cho cả chuỗi** — không tách theo `building_id`,
không có khái niệm `warehouse_id`. Mọi toà nhà dùng chung một danh mục vật tư và một
con số tồn kho. Điều này được ghi rõ trong comment migration: *"1 kho chung cho cả chuỗi"*.

Vòng đời một vật tư xoay quanh **3 loại phiếu (movement)** tác động lên tồn kho:

| Loại phiếu | Bảng header / items | Hướng tồn | Mã sinh tự động | Nguồn phát sinh |
|---|---|---|---|---|
| **Nhập** (purchase) | `material_purchases` / `material_purchase_items` | **+** (cộng tồn, cập nhật giá vốn) | `MP-YYYYMMDD-NNNN` | Tab "Phiếu nhập" trên MaterialsPage |
| **Xuất** (usage) | `material_usages` / `material_usage_items` | **−** (trừ tồn) | `MU-YYYYMMDD-NNNN` | Gắn vào **phiếu công việc (job)** — tạo/sửa từ dialog "Chi tiết công việc" (TaskDetailDialog) **hoặc** ngay khi tạo công việc mới (TaskCreateDialog); **hoặc tạo bằng tay không gắn job** từ tab "Phiếu xuất" (MaterialUsageFormDialog, từ 2026-06-30) |
| **Điều chỉnh / kiểm kê** (adjustment) | `material_adjustments` / `material_adjustment_items` | **±** (IN cộng / OUT trừ) | `MA-YYYYMMDD-NNNN` | Tab "Kiểm kê" trên MaterialsPage |

Hai con số quan trọng nhất trên bảng `materials` — `on_hand` (tồn) và
`avg_unit_cost` (giá vốn trung bình, MAC — *moving average cost*) — **đều là cache**.
Chúng không được app ghi trực tiếp; mọi thay đổi đi qua các bảng `*_items` rồi
trigger tự tính lại (xem mục 4). Đây là **bất biến cốt lõi** của domain: app chỉ
ghi phiếu, không bao giờ `UPDATE materials.on_hand` thủ công.

Vai trò end-to-end: kho vật tư nằm ở nhánh **chi phí vận hành** của vòng đời.
Vật tư xuất ra gắn `job_id` → tính được **chi phí vật tư của từng phiếu công việc**
(qua `unit_cost_at_usage` snapshot). Con số này hiện **chỉ hiển thị** ở tab Phiếu xuất
([MaterialUsagesContent](src/components/materials/MaterialUsagesContent.tsx) — cột Chi phí)
và trong dialog công việc — **chưa có báo cáo nào tiêu thụ** nó: quy chi phí vật tư về
toà nhà (join `material_usages → jobs.building_id`) mới chỉ là **tiềm năng**, không query/UI
nào trong `src/pages/reports/` đụng tới materials. Phiếu nhập gắn `supplier_id` → liên kết
sang danh mục nhà cung cấp.

---

## 2. Cấu trúc dữ liệu

Tổng cộng **9 bảng**: 2 catalog + 3 cặp header/items giao dịch + bảng `suppliers` dùng chung.
8 bảng `material_*` bật RLS qua `can_access_org_entity('materials', <action>)` (xem mục 4);
riêng `suppliers` có RLS namespace riêng `'suppliers'` (xem 2.6 và 4.6).

> **Cảnh báo CASCADE theo user**: `user_id` trên cả 5 bảng header/catalog
> (`materials`, `material_categories`, `material_purchases`, `material_usages`,
> `material_adjustments`) là `NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`
> ([migration](supabase/migrations/20260529000004_create_materials_inventory.sql) dòng 20/31/63/97/129).
> Xoá một tài khoản auth sẽ **xoá dây chuyền** catalog + toàn bộ phiếu người đó tạo
> (trigger recompute chạy → tồn kho "mất dấu" lượng nhập/xuất tương ứng). Cột này
> audit-only về mặt **RBAC**, nhưng về **schema** thì không vô hại.

### 2.1. `material_categories` — Danh mục vật tư

Gom nhóm vật tư (Đèn, Vòi nước, Ống nước…). Phẳng, không phân cấp.

- `name` (NOT NULL, CHECK length > 0): tên danh mục.
- `description`: mô tả tuỳ chọn.
- `user_id`: **audit-only** (auth.uid() người tạo), không dùng cho RBAC.
- `id / created_at / updated_at`: chuẩn.
- Được tham chiếu bởi: `materials.category_id` (FK `ON DELETE SET NULL` → xoá danh mục thì vật tư về "không phân loại", không mất).

### 2.2. `materials` — Catalog vật tư (kèm cache tồn + giá vốn)

Bản ghi mỗi loại vật tư. Đây là **bảng trung tâm** của domain.

- `code`: mã vật tư (tuỳ chọn, **không** auto-gen — user tự nhập, vd `BD-LED-9W`). Khác với mã phiếu MP/MU/MA.
- `name` (NOT NULL): tên vật tư.
- `category_id` → `material_categories.id` (nullable).
- `unit` (NOT NULL, default `'cái'`): đơn vị tính (cái, m, kg…).
- `reorder_level` (NUMERIC, default 0): **ngưỡng cảnh báo**. UI hiện badge "Sắp hết" khi `on_hand <= reorder_level`.
- `on_hand` (NUMERIC, **cache**): tồn hiện tại = `SUM(nhập) − SUM(xuất) + SUM(adj_IN) − SUM(adj_OUT)`.
- `avg_unit_cost` (NUMERIC, **cache**): giá vốn trung bình (MAC) = `tổng tiền nhập / tổng SL nhập`. Lưu ý: **chỉ tính từ phiếu nhập**, không bị adjustment/usage làm lệch.
- `image_url`, `description`: tuỳ chọn.
- `deleted_at` (TIMESTAMPTZ, nullable): **soft delete**. Các query danh sách của app lọc `.is('deleted_at', null)` — **ngoại lệ**: hook detail `useMaterial` (dead export, chưa nơi nào dùng) query theo id mà **không** lọc `deleted_at`.
- `user_id`: audit-only (về RBAC — xem cảnh báo CASCADE ở đầu mục 2).
- FK đi ra: `category_id` → `material_categories`.
- Được tham chiếu bởi (FK `ON DELETE RESTRICT`): `material_purchase_items`, `material_usage_items`, `material_adjustment_items` — nghĩa là **không xoá cứng được** vật tư còn movement; đây là lý do app dùng soft delete.
- Index: ngoài index thường (`category_id`, `deleted_at`) còn có **GIN full-text** `idx_materials_search` trên `code+name+description` — nhưng **app không dùng** (ô tìm kiếm FE lọc client-side bằng `toLowerCase().includes`, xem 5.1); index này hiện chỉ tốn chi phí write.

### 2.3. `material_purchases` + `material_purchase_items` — Phiếu nhập

Header `material_purchases`:

- `code` (UNIQUE NOT NULL): auto-gen `MP-YYYYMMDD-NNNN`.
- `purchase_date` (DATE, default CURRENT_DATE): ngày nhập.
- `supplier_id` → `suppliers.id` (nullable, `ON DELETE SET NULL`): nhà cung cấp.
- `total` (NUMERIC, **cache**): tổng tiền = `SUM(line_total)` các dòng, cập nhật qua trigger.
- `notes`, `user_id` (audit), `id/created_at/updated_at`.

Items `material_purchase_items`:

- `purchase_id` → `material_purchases.id` (`ON DELETE CASCADE` → xoá phiếu xoá hết dòng).
- `material_id` → `materials.id` (`ON DELETE RESTRICT`).
- `quantity` (CHECK > 0), `unit_price` (CHECK ≥ 0).
- `line_total` (NUMERIC, **GENERATED ALWAYS AS `quantity * unit_price` STORED**) — cột tính sẵn ở DB, app không ghi.
- Không có `user_id` (RLS qua parent).

### 2.4. `material_usages` + `material_usage_items` — Phiếu xuất (gắn job)

Header `material_usages`:

- `code` (UNIQUE NOT NULL): auto-gen `MU-YYYYMMDD-NNNN`.
- `usage_date` (DATE, default CURRENT_DATE).
- `job_id` → `jobs.id` (nullable, `ON DELETE CASCADE`): **liên kết sang domain Công việc**. Có **UNIQUE partial index** `WHERE job_id IS NOT NULL` → **mỗi job nhiều nhất 1 phiếu xuất**. Phiếu xuất **tạo bằng tay** có `job_id = NULL` (hợp lệ — UNIQUE chỉ áp khi job_id NOT NULL); tab Phiếu xuất hiển thị "(không gắn job)".
- `notes`, `user_id` (audit), timestamps.

Items `material_usage_items`:

- `usage_id` → `material_usages.id` (CASCADE).
- `material_id` → `materials.id` (RESTRICT).
- `quantity` (CHECK > 0).
- `unit_cost_at_usage` (NUMERIC, default 0): **snapshot** `materials.avg_unit_cost` tại thời điểm xuất. Mục đích: tính chi phí vật tư của job **độc lập** với giá vốn thay đổi sau này. App tự gán giá trị này khi lưu (không phải trigger).

### 2.5. `material_adjustments` + `material_adjustment_items` — Kiểm kê / điều chỉnh

Header `material_adjustments`:

- `code` (UNIQUE NOT NULL): auto-gen `MA-YYYYMMDD-NNNN`.
- `adjustment_date` (DATE, default CURRENT_DATE).
- `type` (TEXT, **CHECK IN ('IN','OUT')**): hướng điều chỉnh. IN = cộng tồn, OUT = trừ tồn.
- `reason`: lý do (kiểm kê cuối tháng, hỏng, mất, tìm thấy thừa…).
- `user_id` (audit), `id/created_at`. **Không có `updated_at`** (phiếu kiểm kê không sửa, chỉ tạo/xoá).

Items `material_adjustment_items`:

- `adjustment_id` → `material_adjustments.id` (CASCADE).
- `material_id` → `materials.id` (RESTRICT).
- `quantity` (CHECK ≥ 0): số lượng delta (luôn dương; hướng do `type` của header quyết định).

> **Lưu ý về thao tác "SET"**: UI cho phép chọn loại `SET` (đặt lại tồn theo số kiểm
> đếm), nhưng ở **mức DB không có type `SET`** — chỉ IN/OUT. SET được hiện thực ở
> tầng app bằng cách tạo 1 phiếu IN hoặc OUT với `delta = target − current` (xem mục 5.1, tab "Kiểm kê").

### 2.6. `suppliers` — Nhà cung cấp (dùng chung)

Danh mục nhà cung cấp, **dùng chung giữa Materials và Assets**.

- `name` (NOT NULL), `phone`, `email`, `address`.
- `deleted_at` (nullable): soft delete — nhưng việc lọc **lệch nhau giữa 2 domain**: phía Materials, `useSuppliersList` trong [MaterialPurchaseFormDialog](src/components/materials/MaterialPurchaseFormDialog.tsx) **có** lọc `.is('deleted_at', null)`; phía Assets, [CreateAssetDialog](src/components/assets/CreateAssetDialog.tsx) / [EditAssetDialog](src/components/assets/EditAssetDialog.tsx) `select('*')` **không** lọc → NCC đã xoá mềm vẫn hiện trong dropdown form tài sản.
- `user_id` (audit), timestamps.
- Được tham chiếu bởi: `material_purchases.supplier_id` **và** `assets.supplier_id` → đây là điểm giao với domain Tài sản.

---

## 3. Sơ đồ quan hệ dữ liệu

```mermaid
erDiagram
  material_categories ||--o{ materials : "phan loai"
  materials ||--o{ material_purchase_items : "RESTRICT"
  materials ||--o{ material_usage_items : "RESTRICT"
  materials ||--o{ material_adjustment_items : "RESTRICT"

  material_purchases ||--o{ material_purchase_items : "CASCADE"
  material_usages ||--o{ material_usage_items : "CASCADE"
  material_adjustments ||--o{ material_adjustment_items : "CASCADE"

  suppliers ||--o{ material_purchases : "supplier_id (SET NULL)"
  jobs ||--o| material_usages : "job_id UNIQUE (CASCADE)"

  auth_users ||--o{ material_categories : "user_id (CASCADE)"
  auth_users ||--o{ materials : "user_id (CASCADE)"
  auth_users ||--o{ material_purchases : "user_id (CASCADE)"
  auth_users ||--o{ material_usages : "user_id (CASCADE)"
  auth_users ||--o{ material_adjustments : "user_id (CASCADE)"

  materials {
    uuid id PK
    text code "user nhap"
    text name
    uuid category_id FK
    text unit
    numeric reorder_level
    numeric on_hand "CACHE"
    numeric avg_unit_cost "CACHE MAC"
    timestamptz deleted_at "soft delete"
  }
  material_purchases {
    uuid id PK
    text code "MP-... auto"
    date purchase_date
    uuid supplier_id FK
    numeric total "CACHE"
  }
  material_purchase_items {
    uuid id PK
    uuid purchase_id FK
    uuid material_id FK
    numeric quantity "> 0"
    numeric unit_price ">= 0"
    numeric line_total "GENERATED"
  }
  material_usages {
    uuid id PK
    text code "MU-... auto"
    date usage_date
    uuid job_id FK "UNIQUE nullable"
  }
  material_usage_items {
    uuid id PK
    uuid usage_id FK
    uuid material_id FK
    numeric quantity "> 0"
    numeric unit_cost_at_usage "snapshot"
  }
  material_adjustments {
    uuid id PK
    text code "MA-... auto"
    date adjustment_date
    text type "IN|OUT"
  }
  material_adjustment_items {
    uuid id PK
    uuid adjustment_id FK
    uuid material_id FK
    numeric quantity ">= 0"
  }
  suppliers {
    uuid id PK
    text name
    timestamptz deleted_at
  }
```

Luồng cập nhật cache (tồn + giá vốn):

```mermaid
flowchart TD
  A["INSERT/UPDATE/DELETE trên<br/>material_purchase_items"] --> T1["trg_mpi_recompute"]
  B["INSERT/UPDATE/DELETE trên<br/>material_usage_items"] --> T2["trg_mui_recompute"]
  C["INSERT/UPDATE/DELETE trên<br/>material_adjustment_items"] --> T3["trg_mai_recompute"]
  T1 --> F["material_items_after_change()"]
  T2 --> F
  T3 --> F
  F --> R["recompute_material_stock(material_id)"]
  R --> M["UPDATE materials<br/>on_hand + avg_unit_cost"]
  A --> T4["trg_mpi_total"]
  T4 --> G["material_purchase_recompute_total()"]
  G --> P["UPDATE material_purchases.total"]
```

---

## 4. Quy tắc nghiệp vụ & tự động hoá

### 4.1. `recompute_material_stock(_material_id uuid)` — tính lại tồn + MAC

Hàm `SECURITY DEFINER` (void). Quét **toàn bộ movement** của 1 vật tư và ghi lại cache:

```text
on_hand       = SUM(purchase qty) − SUM(usage qty) + SUM(adj IN qty) − SUM(adj OUT qty)
avg_unit_cost = (SUM purchase line_total) / (SUM purchase qty)   -- nếu có nhập; 0 nếu chưa nhập
```

**Bất biến quan trọng:**

- `avg_unit_cost` **chỉ** tính từ `material_purchase_items` — usage và adjustment **không** ảnh hưởng giá vốn. Nghĩa là điều chỉnh tồn (kiểm kê) làm đổi `on_hand` nhưng giữ nguyên giá vốn.
- Hàm **tính lại từ đầu** (full recompute) mỗi lần, không cộng dồn incremental → tự đúng kể cả khi xoá/sửa phiếu cũ.

### 4.2. `material_items_after_change()` + 3 trigger recompute

Trigger function `AFTER INSERT/UPDATE/DELETE FOR EACH ROW`, gọi
`recompute_material_stock(COALESCE(NEW.material_id, OLD.material_id))`. Gắn trên cả 3 bảng items:

- `trg_mpi_recompute` trên `material_purchase_items`
- `trg_mui_recompute` trên `material_usage_items`
- `trg_mai_recompute` trên `material_adjustment_items`

→ Bất kỳ thay đổi dòng phiếu nào (kể cả xoá phiếu → CASCADE xoá items) đều kích hoạt tính lại tồn. Đây là lý do các dialog xoá phiếu nói *"tồn sẽ tự động tính lại"*.

> **Chi phí của FOR EACH ROW**: trigger chạy **mỗi dòng** — tạo phiếu nhập N dòng = N lần
> `recompute_material_stock` (mỗi lần 4 aggregate scan toàn movement của vật tư) + N lần
> `material_purchase_recompute_total` trên cùng `purchase_id`; sửa phiếu (delete hết + insert lại,
> xem 5.1) **nhân đôi** số lần. Với khối lượng hiện tại chấp nhận được; nếu cần tối ưu thì
> chuyển sang trigger statement-level/dedupe theo `material_id`.

### 4.3. `material_purchase_recompute_total()` — cập nhật `total` phiếu nhập

Trigger `trg_mpi_total` trên `material_purchase_items` (AFTER I/U/D). Set
`material_purchases.total = COALESCE(SUM(line_total), 0)` của các dòng cùng `purchase_id`.
→ `total` của phiếu nhập luôn khớp tổng dòng, app không tự tính.

### 4.4. Auto-gen mã phiếu — `set_material_{purchase,usage,adjustment}_code()`

3 trigger `BEFORE INSERT` (`trg_mp_code`, `trg_mu_code`, `trg_ma_code`). Nếu `code`
NULL/rỗng, sinh `MP-/MU-/MA-` + `YYYYMMDD` + số thứ tự 4 chữ số (`LPAD(... ,4,'0')`),
trong đó số thứ tự = `MAX(số hiện có cùng ngày) + 1`. App **không gửi `code`** khi tạo
phiếu → trigger lo.

> Đây là điểm khác biệt với `materials.code`: mã **vật tư** do user tự nhập (nullable, không auto), mã **phiếu** auto-gen và UNIQUE.

> **Đã vá SECURITY DEFINER + advisory lock (2026-07-01, 13bf498)** — migration
> [20260701000001_secdef_code_generators.sql](supabase/migrations/20260701000001_secdef_code_generators.sql):
> bản gốc là SECURITY INVOKER, tính `MAX()+1` trên bảng **có RLS** → staff (non-admin) chỉ
> thấy một phần phiếu, tính MAX thiếu → sinh mã đã tồn tại → 23505, insert fail **chỉ với
> staff** (chủ là admin thấy hết nên test bằng chủ không lộ lỗi — bug class chung của mọi
> generator MAX()/COUNT() trên bảng RLS, phát hiện từ vụ `reading_code` bên chỉ số điện).
> Cả 3 hàm `set_material_{purchase,usage,adjustment}_code` giờ chạy `SECURITY DEFINER` +
> `SET search_path = public` + `pg_advisory_xact_lock(hashtext('MP-'||ngày))` (serialize
> cấp số trong ngày → hết luôn race 2 user tạo phiếu đồng thời). Mẫu chuẩn tham chiếu là
> `generate_job_code()` của domain Công việc.

### 4.5. Audit & updated_at

- `set_user_id_from_auth` (BEFORE INSERT) gán `user_id = auth.uid()` cho cả **5 bảng catalog + header** (`material_categories`, `materials`, `material_purchases`, `material_usages`, `material_adjustments`) — chỉ audit, không dùng cho quyền.
- `update_updated_at_column` (BEFORE UPDATE) trên các bảng có `updated_at`.
- **Nhưng lưu ý**: tuy "audit-only" về quyền, `user_id` là FK `auth.users(id) ON DELETE CASCADE` — xoá tài khoản auth kéo theo xoá dữ liệu kho người đó tạo (xem cảnh báo đầu mục 2).

### 4.6. RLS — `can_access_org_entity('materials', <action>)`

Toàn bộ 8 bảng materials bật RLS. Mỗi bảng có policy SELECT/INSERT/UPDATE/DELETE
gọi `can_access_org_entity('materials','view'|'create'|'edit'|'delete')`, cộng
policy `is_admin()` / `is_super_admin()` ALL.

`can_access_org_entity(_resource, _action)` (SQL, SECURITY DEFINER, STABLE) trả true nếu:

- là super admin, **hoặc** admin, **hoặc**
- tồn tại `staff_assignments` của `auth.uid()` mà `permissions` (fallback `roles.permissions`) cho phép cặp `materials:action`.

Đây là quyền **org-level, KHÔNG scope theo building** (đúng tinh thần "1 kho chung").
Bảng items không có policy riêng theo parent — chúng cũng kiểm `materials` action trực tiếp
(view để select, create để insert, edit để update/delete dòng).

`suppliers` có RLS riêng (xem domain Cài đặt/danh mục) — không thuộc namespace `materials`.

> **Chuỗi cấp quyền FE đã được nối lại (2026-06-11, f528cd8 — thiết kế lại trang phân
> quyền theo TRANG)**: catalog [permissionPages.ts](src/lib/permissionPages.ts) (nguồn dữ
> liệu cho [PermissionPicker](src/components/authorization/PermissionPicker.tsx) — thay
> PermissionMatrix cũ đã xoá) có trang `materials` ("Vật tư", nhóm "Tài sản & Kho", features
> CRUD) → **cấp được quyền kho vật tư cho staff qua UI**. Đồng bộ cùng đợt:
>
> - Route `/materials*` bọc `ProtectedRoute` + **`RequirePermission module="materials"`**
>   ([App.tsx](src/App.tsx)) — thiếu quyền bị redirect về `/`.
> - Mục menu "Kho vật tư" ([Sidebar](src/components/layout/Sidebar.tsx), nhóm "Danh mục
>   dữ liệu") khai báo `module: 'materials'` — Sidebar **ẩn mục** với user thiếu quyền
>   (không còn hiện cho mọi user đăng nhập).
>
> Tồn đọng: các hook list vẫn **nuốt lỗi** (`console.error` → `return []`) — nếu quyền FE
> và RLS lệch nhau (vd sửa JSON tay) thì danh sách vẫn "trống im lặng" thay vì báo lỗi;
> seed role templates ([20260529000002](supabase/migrations/20260529000002_seed_system_role_templates.sql))
> vẫn không có `materials`, role hệ thống cũ không tự kèm quyền này (phải tick thêm ở
> trang phân quyền).

---

## 5. Quy trình theo từng trang (page)

### 5.1. `MaterialsPage` — hub kho vật tư

- **Route**: `/materials`, `/materials/purchases`, `/materials/usages`, `/materials/adjustments` (cả 4 cùng render `MaterialsPage`, tab xác định theo `location.pathname`). Đăng ký trong [App.tsx](src/App.tsx) — bọc `ProtectedRoute` + `RequirePermission module="materials"` (từ f528cd8, xem 4.6).
- **Mục đích**: một trang 4 tab — Vật tư / Phiếu nhập / Phiếu xuất / Kiểm kê. Đổi tab = `navigate()` đổi URL (deep-link được).

#### Tab "Vật tư" — [MaterialsListContent.tsx](src/components/materials/MaterialsListContent.tsx)

- **Dữ liệu**: `useMaterials(filters)` (filter `search` lọc client-side theo tên/mã/mô tả, `categoryId`, `onlyLowStock`), `useMaterialCategories()`. Ô tìm kiếm + danh mục + sub-tab tồn kho **giữ qua F5** bằng `usePersistedState` (sessionStorage key `flt:materials:*` — đợt 7fd2d3f).
- **Hiển thị**: bảng Mã / Tên / Danh mục / Đơn vị / Tồn (qua `StockBadge`) / Giá vốn TB. Sub-tab "Tất cả" vs "Sắp hết" (đếm `on_hand <= reorder_level`). Panel "Danh mục" gập/mở để CRUD `material_categories`.
- **Thêm/Sửa vật tư** ([MaterialFormDialog](src/components/materials/MaterialFormDialog.tsx)): react-hook-form + `materialFormSchema`. Validate: `name` min 1, `unit` min 1, `reorder_level ≥ 0`, `category_id` phải là UUID hợp lệ hoặc null. `useCreateMaterial` / `useUpdateMaterial` insert/update vào `materials` (KHÔNG ghi `on_hand`/`avg_unit_cost` — để default/trigger lo).
- **Xoá vật tư**: `useSoftDeleteMaterial` chỉ set `deleted_at` → lịch sử phiếu giữ nguyên (vì FK RESTRICT chặn xoá cứng).
- **Danh mục** ([MaterialCategoryFormDialog](src/components/materials/MaterialCategoryFormDialog.tsx)): `useCreateMaterialCategory`/`useUpdateMaterialCategory`. **Xoá danh mục** (`useDeleteMaterialCategory`) check trước: nếu còn vật tư (chưa xoá) đang dùng → chặn, toast lỗi.
- **Edge case**: filter dropdown danh mục dùng `SearchableSelect` (combobox gõ-để-tìm) đúng convention; `StockBadge` phân 3 mức: Hết hàng (≤0, đỏ), Sắp hết (≤ ngưỡng, vàng), Còn (xám).
- **Gotcha đếm badge**: badge "Tất cả" hiển thị `materials.length` của **danh sách đã lọc** (filters gồm cả `onlyLowStock` + `search`) — đứng ở sub-tab "Sắp hết" hoặc đang gõ tìm kiếm thì con số "Tất cả" = số dòng sau lọc, **không phải** tổng vật tư.
- **Gotcha hiệu năng**: `search`/`onlyLowStock` nằm trong `queryKey` nhưng việc lọc lại làm **client-side sau khi fetch toàn bộ** bảng → mỗi keystroke ô tìm kiếm tạo 1 cache entry mới + 1 lần refetch full danh sách (không debounce); GIN index server-side (`idx_materials_search`) bị bỏ phí.

#### Tab "Phiếu nhập" — [MaterialPurchasesContent.tsx](src/components/materials/MaterialPurchasesContent.tsx)

- **Dữ liệu**: `useMaterialPurchases()` — join `supplier` + `items(+material)`, sort theo `purchase_date` desc. Bảng có hàng mở rộng (expand) xem chi tiết dòng. Hook **có hỗ trợ** filter `{from?, to?}` theo `purchase_date` nhưng UI gọi **không truyền** và tab không có ô lọc ngày nào — tham số này hiện là code chết ở mức UI (toàn bộ lịch sử phiếu được fetch không phân trang).
- **Tạo phiếu nhập** ([MaterialPurchaseFormDialog](src/components/materials/MaterialPurchaseFormDialog.tsx)):
  1. Chọn ngày nhập, nhà cung cấp (Select thường — danh sách từ `suppliers` chưa xoá), nhập nhiều dòng ([MaterialPicker](src/components/materials/MaterialPicker.tsx) + số lượng + đơn giá), thành tiền/tổng tính realtime. Lưu ý hiệu năng: MaterialPicker render **toàn bộ catalog** vào Command list cho **từng dòng** (mỗi dòng 1 Popover chứa full list) — catalog lớn + nhiều dòng sẽ nặng DOM; được cứu một phần nhờ các dòng dùng chung queryKey `['materials','list',{}]` (dedupe network).
  2. Submit → lọc dòng hợp lệ (`material_id` có + `quantity > 0`); nếu 0 dòng → toast lỗi "Cần ít nhất 1 dòng… SL > 0".
  3. `useCreateMaterialPurchase`: insert header (không gửi `code` → trigger sinh MP-…), rồi insert items. **Nếu insert items lỗi → rollback bằng cách xoá header** (không có transaction RPC, làm thủ công).
  4. Side-effect DB: mỗi item insert → `trg_mpi_recompute` cập nhật `on_hand`+`avg_unit_cost` của vật tư, `trg_mpi_total` cập nhật `total` phiếu.
- **Sửa phiếu** (`useUpdateMaterialPurchase`): update header rồi **xoá hết dòng cũ + insert lại** (replace) → trigger tự tính lại tồn cho cả vật tư cũ lẫn mới. **Cảnh báo: không transaction** — đây là 3 request rời (update header → delete items → insert items); nếu bước insert mới fail (mất mạng, RLS, CHECK) thì phiếu còn lại **rỗng**, tồn kho đã bị trigger recompute thiếu hàng và **không có cơ chế khôi phục** (chỉ luồng tạo mới có rollback xoá header).
- **Xoá phiếu** (`useDeleteMaterialPurchase`): xoá header → CASCADE xoá items → trigger tính lại tồn.

```mermaid
sequenceDiagram
  actor U as User
  participant D as PurchaseFormDialog
  participant H as useCreateMaterialPurchase
  participant DB as Supabase
  U->>D: nhập ngày/NCC + các dòng
  U->>D: Submit
  D->>D: lọc dòng (material_id & qty>0)
  alt 0 dòng hợp lệ
    D-->>U: toast lỗi, dừng
  else hợp lệ
    D->>H: mutateAsync(payload)
    H->>DB: INSERT material_purchases (no code)
    Note over DB: trg_mp_code sinh MP-...
    H->>DB: INSERT material_purchase_items[]
    Note over DB: trg_mpi_recompute → on_hand + avg_unit_cost<br/>trg_mpi_total → total
    alt items lỗi
      H->>DB: DELETE header (rollback)
      H-->>U: toast lỗi
    else ok
      H-->>U: invalidate materials + purchases, toast ok
    end
  end
```

#### Tab "Phiếu xuất" — [MaterialUsagesContent.tsx](src/components/materials/MaterialUsagesContent.tsx)

- **Hết read-only từ 2026-06-30 (40369a7)**: có nút **"Tạo phiếu xuất"** mở [MaterialUsageFormDialog](src/components/materials/MaterialUsageFormDialog.tsx) tạo phiếu **bằng tay, không gắn job** (luồng 3 dưới đây); phiếu gắn job vẫn tạo/sửa từ phiếu công việc (luồng 1-2). Banner: *"Phiếu xuất tạo tự động khi staff khai báo vật tư trong phiếu công việc. Mỗi job có nhiều nhất 1 phiếu xuất — sửa qua dialog 'Chi tiết công việc'. Ngoài ra có thể tạo phiếu xuất bằng tay (không gắn job)."*
- **Dữ liệu**: `useMaterialUsages()` — join `items(+material)` + `job(id,code,title)`, fetch **toàn bộ lịch sử không phân trang** (giống 2 tab phiếu còn lại). Mỗi hàng hiện mã MU, ngày, link tới job (`/tasks`) hoặc nhãn "(không gắn job)", cột **"Người tạo"** (tên + giờ tạo — `user_id` trỏ `auth.users` không embed được nên hook fetch `profiles` riêng rồi map `full_name`), tổng SL, tổng chi phí (`Σ quantity × unit_cost_at_usage`). Expand xem dòng kèm "Giá vốn lúc xuất".
- **Luồng 1 — sửa/tạo từ "Chi tiết công việc"**: [MaterialUsageSection](src/components/materials/MaterialUsageSection.tsx), nhúng trong [TaskDetailDialog](src/components/tasks/TaskDetailDialog.tsx) (2 vị trí mobile/desktop):
  1. `useMaterialUsageByJob(jobId)` lấy phiếu hiện có của job (nếu có).
  2. User thêm dòng vật tư + số lượng ([MaterialUsageItemsEditor](src/components/materials/MaterialUsageItemsEditor.tsx)). Editor cảnh báo (viền vàng) khi `qty > on_hand + alreadyCounted` — **chỉ cảnh báo, không chặn** (cho phép xuất âm tồn).
  3. Lưu → `useUpsertJobMaterialUsage`: nếu job đã có phiếu → update header + **xoá hết item cũ** + insert lại (gán `unit_cost_at_usage = materials.avg_unit_cost` hiện tại); nếu chưa có & có item → tạo mới (trigger sinh MU-…); nếu xoá hết item của phiếu cũ → **xoá luôn header** (không để lại phiếu rỗng).
  4. Side-effect: trigger `trg_mui_recompute` trừ `on_hand`.
- **Luồng 2 — tạo ngay khi tạo công việc mới**: [TaskCreateDialog](src/components/tasks/TaskCreateDialog.tsx) nhúng `MaterialUsageItemsEditor` ở mục *"Vật tư sử dụng cho công việc (tuỳ chọn — sẽ tự trừ kho khi lưu)"*:
  1. Submit → `createJob` tạo job trước; nếu có dòng vật tư hợp lệ (`material_id` + `quantity > 0`) thì gọi tiếp `useUpsertJobMaterialUsage` với `usage_date` = ngày hiện tại, `unit_cost_at_usage` snapshot từ `avg_unit_cost` hiện tại.
  2. **Không rollback**: nếu phần vật tư lỗi thì job **vẫn được tạo** (chỉ toast lỗi — comment trong code ghi rõ "job đã tạo nên không rollback").
  3. Editor ở đây **không** truyền `existingQuantitiesByMaterial` → cảnh báo vượt tồn so với `on_hand` thuần.
- **Luồng 3 — tạo bằng tay không gắn job** (2026-06-30, 40369a7): [MaterialUsageFormDialog](src/components/materials/MaterialUsageFormDialog.tsx) mở từ nút "Tạo phiếu xuất" trên tab:
  1. Nhập **Ngày xuất** (mặc định hôm nay — user đổi được, khác 2 luồng job hard-code ngày hiện tại), các dòng vật tư (tái dùng `MaterialUsageItemsEditor` — cảnh báo vượt tồn, không chặn), ghi chú tuỳ chọn.
  2. Submit → lọc dòng hợp lệ (`material_id` + `quantity > 0`; 0 dòng → toast lỗi) → [useCreateMaterialUsage](src/hooks/useMaterialUsages.ts): insert header `{ job_id: null, usage_date, notes }` (trigger sinh MU-…, `user_id`/`created_at` do trigger audit ghi) rồi insert items với snapshot `unit_cost_at_usage = avg_unit_cost` hiện tại. **Items lỗi → rollback xoá header** (giống luồng tạo phiếu nhập).
  3. `onSuccess` invalidate `['material-usages','list']` + `['materials']` → tab tự cập nhật (khác luồng job — xem gotcha invalidate dưới).
  4. Phiếu tay **không sửa được** sau khi tạo (dialog chỉ có create; upsert/sửa chỉ tồn tại cho phiếu gắn job qua dialog công việc) và cũng chưa có nút xoá trên tab.
- **Cảnh báo re-snapshot giá vốn**: vì upsert **replace toàn bộ dòng** và caller luôn gán `unit_cost_at_usage = avg_unit_cost` **hiện tại** cho cả các dòng không đổi → chỉ cần bấm "Lưu vật tư" lại sau khi giá vốn đã thay đổi (do phiếu nhập mới) là **chi phí lịch sử của job bị ghi đè** theo giá mới — snapshot chỉ "đóng băng" đến lần lưu kế tiếp, không tuyệt đối. Tương tự, cả 2 caller đều hard-code `usage_date = ngày hiện tại` khi lưu → **ngày phiếu xuất cũng trôi** về lần lưu cuối, không giữ ngày xuất ban đầu.
- **Cảnh báo không transaction**: tương tự phiếu nhập — nhánh update là delete-all + insert qua các request rời; insert mới fail → phiếu rỗng nhưng header còn (trường hợp này header rỗng chỉ bị dọn ở nhánh "xoá hết item" chủ động, không phải khi lỗi).
- **Gotcha invalidate**: `useUpsertJobMaterialUsage.onSuccess` chỉ invalidate `['material-usages','by-job',jobId]` + `['materials']` — **không** invalidate query list `['material-usages','list']` → tab Phiếu xuất dựa vào remount/staleTime mặc định để tự cập nhật sau khi lưu **từ job**. (Luồng tạo tay `useCreateMaterialUsage` thì có invalidate list.)
- **Edge case**: UNIQUE index `job_id` đảm bảo 1 job ↔ 1 phiếu xuất; xoá job → CASCADE xoá phiếu xuất → trigger **cộng trả tồn** (kể cả khi vật tư đã tiêu hao thật ngoài đời — rủi ro nghiệp vụ cần lưu ý khi xoá job).

#### Tab "Kiểm kê" — [MaterialAdjustmentsContent.tsx](src/components/materials/MaterialAdjustmentsContent.tsx)

- **Dữ liệu**: `useMaterialAdjustments()` — list + expand, fetch toàn bộ lịch sử không phân trang. Badge IN (xanh)/OUT (đỏ).
- **Tạo phiếu kiểm kê** ([MaterialAdjustmentFormDialog](src/components/materials/MaterialAdjustmentFormDialog.tsx)) — 3 chế độ ở UI:
  - **SET** (mặc định): nhập *tồn thực đếm được*. UI hiện delta = `target − current` realtime. Submit → với **mỗi** dòng gọi `useSetMaterialStock`: tính `delta`, nếu `delta = 0` bỏ qua (toast "đã khớp"), nếu khác thì tạo 1 phiếu adjustment `type = delta>0 ? 'IN' : 'OUT'` với `quantity = |delta|`. (Một phiếu MA / vật tư.)
  - **IN**: cộng thêm (tìm thấy thừa). Một phiếu MA chứa nhiều dòng, dùng **đúng** ngày user chọn.
  - **OUT**: trừ bớt (hỏng, mất).
  - `useCreateMaterialAdjustment` insert header (không gửi code) + items; lỗi items → rollback xoá header.
- **Xoá phiếu** (`useDeleteMaterialAdjustment`): CASCADE xoá items → trigger tính lại tồn.
- **Gotcha của SET** (khác hẳn IN/OUT — cần biết khi đối chiếu số liệu):
  - **Bỏ qua "Ngày kiểm kê" đã chọn**: nhánh SET ghi `adjustment_date = ngày hiện tại` (`new Date().toISOString().slice(0,10)` hard-code trong [useSetMaterialStock](src/hooks/useMaterialAdjustments.ts)); ngày user chọn chỉ lọt vào chuỗi `reason` mặc định `Kiểm kê ${date}`. Nhánh IN/OUT thì dùng đúng ngày chọn.
  - **Delta tính từ cache client**: `current_quantity` lấy từ danh sách `useMaterials` đã fetch (có thể stale nếu người khác vừa nhập/xuất) → phiếu IN/OUT sinh ra có thể sai delta so với tồn thật tại thời điểm submit.
  - **Xé lẻ phiếu + spam toast**: SET N vật tư = vòng `for` tuần tự tạo N phiếu MA riêng + N toast "Đã cập nhật tồn kho theo kiểm kê"; xoá từng phiếu chỉ revert 1 vật tư. (Comment trong migration mô tả SET kiểu khác — insert 2 phiếu: 1 OUT bằng toàn bộ tồn hiện tại + 1 IN bằng số đếm — app không làm vậy mà tạo 1 phiếu delta/vật tư.)
- **Edge case**: không có nút "Sửa" phiếu kiểm kê (chỉ tạo/xoá — khớp việc bảng không có `updated_at`). SET với delta=0 không tạo phiếu rác. **Nhưng** chế độ IN/OUT **có thể tạo phiếu MA rỗng**: bước clean chỉ loại `NaN` (qty=0 vẫn qua validate "≥1 dòng hợp lệ"), sau đó items được lọc `qty > 0` lúc gọi mutate — nếu mọi dòng qty=0 thì header vẫn insert với 0 dòng (DB CHECK items là `quantity >= 0` nên không chặn).

```mermaid
flowchart TD
  S["Chọn loại"] -->|SET| SET["với mỗi dòng:<br/>delta = đếm − on_hand (cache client)<br/>ngày phiếu = HÔM NAY, bỏ qua ngày chọn"]
  SET -->|delta=0| skip["bỏ qua + toast"]
  SET -->|delta>0| in1["tạo MA type=IN qty=delta<br/>(1 phiếu / vật tư)"]
  SET -->|delta<0| out1["tạo MA type=OUT qty=|delta|<br/>(1 phiếu / vật tư)"]
  S -->|IN| inN["1 phiếu MA IN nhiều dòng<br/>(ngày = ngày chọn)"]
  S -->|OUT| outN["1 phiếu MA OUT nhiều dòng<br/>(ngày = ngày chọn)"]
  in1 --> rec["trg_mai_recompute → on_hand"]
  out1 --> rec
  inN --> rec
  outN --> rec
```

### 5.2. `SuppliersPage` — Nhà cung cấp (placeholder)

- **Route**: `/settings/categories/suppliers` ([App.tsx](src/App.tsx) dòng 344).
- **Trạng thái hiện tại**: [SuppliersPage.tsx](src/pages/settings/categories/SuppliersPage.tsx) chỉ là `PlaceholderPage` ("Quản lý nhà cung cấp") — **chưa có UI CRUD**. Dropdown nhà cung cấp trong phiếu nhập đọc từ `suppliers` (qua `useSuppliersList` nội bộ trong [MaterialPurchaseFormDialog](src/components/materials/MaterialPurchaseFormDialog.tsx)), và form tài sản ([CreateAssetDialog](src/components/assets/CreateAssetDialog.tsx)/[EditAssetDialog](src/components/assets/EditAssetDialog.tsx)) cũng chỉ **CHỌN** từ dropdown. **Không có UI tạo NCC ở bất kỳ đâu trong app** — NCC mới chỉ tạo được bằng seed/SQL trực tiếp, nên dropdown NCC của phiếu nhập hoàn toàn phụ thuộc dữ liệu seed.

---

## 6. Liên kết sang domain khác (vào / ra)

| Hướng | Bảng/route nguồn | Bảng/route đích | Vì sao |
|---|---|---|---|
| **Ra → Công việc (Jobs)** | `material_usages.job_id` | `jobs.id` (`ON DELETE CASCADE`, UNIQUE per job, nullable) | Phiếu xuất gắn job để quy chi phí vật tư về từng công việc bảo trì. UI tạo/sửa xuất gắn job nằm bên domain tasks ở **2 chỗ**: [TaskDetailDialog](src/components/tasks/TaskDetailDialog.tsx) (qua `MaterialUsageSection`) và [TaskCreateDialog](src/components/tasks/TaskCreateDialog.tsx) (kèm khi tạo job); phiếu **không gắn job** tạo trực tiếp trên MaterialsPage (tab Phiếu xuất, từ 2026-06-30). |
| **Ra → Nhà cung cấp** | `material_purchases.supplier_id` | `suppliers.id` (`ON DELETE SET NULL`) | Ghi nguồn nhập. `suppliers` dùng chung với domain Tài sản. |
| **Vào ← Tài sản (Assets)** | `assets.supplier_id` | `suppliers.id` | Domain Tài sản chia sẻ cùng bảng `suppliers` → mọi thay đổi danh mục NCC ảnh hưởng cả hai. Lưu ý hành xử lệch: Assets **không** lọc `deleted_at` khi đổ dropdown (xem 2.6). |
| **Ra → Chi phí / Báo cáo** | `material_usage_items.unit_cost_at_usage × quantity` | (tính toán — **tiềm năng, chưa có code**) chi phí vật tư của job | Snapshot giá vốn cho phép tổng hợp chi phí bảo trì theo job/toà nhà. **Hiện chưa report nào tiêu thụ** cột này (chỉ tab Phiếu xuất hiển thị); muốn báo cáo theo toà phải tự join `material_usages → jobs.building_id` — `useMaterialUsages` hiện chỉ lấy `job(id,code,title)`, không lấy building. |
| **Vào ← Auth** | `user_id` mọi bảng header | `auth.users.id` (`ON DELETE CASCADE`) | Xoá tài khoản auth xoá dây chuyền dữ liệu kho người đó tạo (xem mục 2). |
| **Quyền** | RLS mọi bảng materials | `can_access_org_entity('materials', …)` ([per_staff_permissions](supabase/migrations/20260529000001_per_staff_permissions.sql)) | Quyền org-level (không scope building) — đồng bộ mô hình RBAC chung của hệ thống. Từ 2026-06-11, trang `materials` có trong catalog phân quyền theo trang ([permissionPages.ts](src/lib/permissionPages.ts)) + route/sidebar gate theo quyền → cấp được cho staff qua UI (xem 4.6). |

**Điểm cần lưu ý cho người tích hợp:**

- Không bao giờ `UPDATE materials.on_hand`/`avg_unit_cost` từ app — luôn đi qua bảng `*_items` để trigger tính. Đây là bất biến giữ cache đúng.
- Cho phép tồn âm: usage không chặn `qty > on_hand` (chỉ cảnh báo UI) → `on_hand` có thể âm nếu xuất vượt; báo cáo cần lường trước.
- `avg_unit_cost` không đổi khi kiểm kê/xuất; muốn thay đổi giá vốn phải qua phiếu **nhập**. Nhưng nhớ giới hạn **re-snapshot** ở mục 5.1: sửa lại vật tư của job sau khi giá vốn đổi sẽ ghi đè `unit_cost_at_usage` lịch sử.
- **KHÔNG có liên kết nào sang Tài chính** (`income_expenses`/sổ quỹ): phiếu nhập kho (tiền mua vật tư) **không** sinh phiếu chi, không vào KQKD/sổ quỹ; chi phí vật tư của job cũng không đổ vào báo cáo tài chính nào. Đây là gap kế toán có chủ đích ở hiện tại — ai cần đối soát chi tiêu vật tư phải nhập phiếu chi tay bên Thu chi.
- Xoá job → CASCADE xoá phiếu xuất → trigger **cộng trả tồn kho**, kể cả khi vật tư đã tiêu hao thật ngoài đời — quy trình vận hành nên cân nhắc trước khi xoá job có phiếu xuất (xem thêm domain [11-cong-viec-su-co](11-cong-viec-su-co.md)).
- Sửa phiếu nhập / lưu phiếu xuất là chuỗi request rời, **không transaction** (chỉ luồng tạo mới có rollback xoá header) — nếu cần độ bền cao hơn, mô hình chuẩn của repo là gói vào RPC plpgsql như các `*_impl` của domain hợp đồng.
