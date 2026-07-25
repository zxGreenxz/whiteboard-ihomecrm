# PLAN — Thay hoàn toàn hệ phân quyền sang mô hình tổ chức (V3), cắt hệ cũ một lần

> **Ngày lập**: 2026-07-25 · **Nền**: audit đối chiếu `docs/AUTHORIZATION-PLAN.md` cùng ngày
> **Quyết định owner**: bỏ hẳn hệ cũ, không chạy song song, không chuyển đổi nửa vời — làm một lần
> **Trạng thái**: chờ duyệt để thi công · **Ước lượng**: ~11 ngày công, một Ngày G duy nhất
> **Tiền đề đã xong**: Đợt 1 hardening (commit `0d1da42`) — 5 khoảng hở §20 đã đóng

---

## 0. Tóm tắt cho người quyết định

Hôm nay hệ thống chạy **hai mô hình quyền song song**. Mô hình mới (tổ chức / thành viên / vai trò / phạm vi / ngoại lệ) có đủ bảng và đủ dữ liệu, nhưng **không phải là bên quyết định**: 0/624 RLS policy dùng nó, chỉ 8 hàm gọi tới. Bên quyết định thật vẫn là bảng cũ `staff_assignments` với JSONB quyền.

Kế hoạch này cắt đứt tình trạng đó bằng **một đòn bẩy nhỏ nhưng ăn toàn hệ**: viết lại đúng **4 hàm helper** mà RLS đang gọi, giữ nguyên chữ ký, đổi ruột sang đọc mô hình mới. Khi đó **337 tham chiếu policy đổi nguồn cùng lúc** mà không phải sửa một dòng policy nào.

| Hàm helper (giữ nguyên chữ ký) | Số policy đang gọi |
|---|---:|
| `can_access_org_entity(text,text)` | 192 |
| `can_do_on_building(text,text,uuid)` | 74 |
| `current_visible_owner_ids()` | 41 |
| `can_access_building(uuid)` | 30 |
| *(nhóm nhỏ)* `staff_can`, `permitted_building_ids`, `accessible_building_ids`, `same_team`, `ie_all_buildings_scope`, `can_view/create_restricted_ie` | 31 |

Nhưng **không được trỏ thẳng vào `authorize_v2` như hiện tại** — evaluator đó đang có 5 lỗi thiết kế (mục 2). Phải sửa evaluator trước, nếu không ta nhân bản lỗi ra 337 chỗ.

Thứ tự bắt buộc: **sửa evaluator → hoàn tất dữ liệu canonical → đối chiếu bóng → Ngày G → dọn xác**.

---

## 1. Hiện trạng (số liệu live 2026-07-25)

### 1.1 Hai hệ đang song song

| | Hệ cũ (đang quyết định) | Hệ mới (đang ngủ) |
|---|---|---|
| Nguồn quyền | `staff_assignments.permissions` JSONB · `roles.permissions` JSONB | `role_permissions` (744) · `member_permission_overrides` (65) |
| Danh tính | `staff_assignments` 64 dòng (42 thật) | `organization_memberships` 11 ACTIVE |
| Phạm vi | `building_id` / `area_id` trên từng dòng assignment | `authorization_scopes` 67 (ORG 2 · AREA 7 · BUILDING 26 · CASHBOOK 32) |
| Vai trò | `roles` 7 dòng | `organization_roles` 9 dòng |
| Cổng đọc FE | `get_my_permissions()` → JSONB + `__superadmin` | `effective_perms_v2(user, org)` — không ai gọi |
| Cổng quyết định | 269 policy + `staff_can` | `authorize_v2` — 8 hàm gọi, **0 policy** |
| Danh mục quyền | ~40 module × ~100 action, không FK | `permission_definitions` 214 key |

### 1.2 Cầu nối hiện có và chỗ nó gãy

Trigger `a80`/`a81` (`20260722140000_rbac_regrant_on_assignment_edit.sql`) đồng bộ `staff_assignments` → `role_bindings` khi sửa phân công. Chính migration ghi rõ nó **không đụng** `member_permission_overrides`.

Hệ quả đo được: **5/9 nhân viên** có JSONB khác mẫu vai trò, trong khi 65 override là ảnh chụp đông cứng từ Sprint 2c + seed go-live. Mỗi lần bấm Lưu ở màn Phân quyền, hai hệ lệch thêm — theo cả hai chiều:

- Bỏ tick quyền → hệ cũ tôn trọng, hệ mới **vẫn cho** (binding vai trò được cấp lại đầy đủ).
- Thêm quyền vượt mẫu → UI hiện bật, writer canonical trả `42501`.

### 1.3 Danh tính chưa vào mô hình mới

| Nhóm | Số lượng | Hiện xử lý ở đâu |
|---|---:|---|
| `shareholders` (có `auth_user_id`) | 3 / 5 | Nhánh riêng trong `get_my_permissions` |
| `profit_managers` | 2 | Nhánh riêng trong `get_my_permissions` |
| `legacy_owner_allowlist` | 5 | Trả sentinel `__superadmin` |
| `super_admins` | 1 | Platform bypass, chưa tách khỏi tenant |

---

## 2. Năm lỗi thiết kế của `authorize_v2` phải sửa TRƯỚC

Đọc body live của `public.authorize_v2(text,uuid,text,uuid)`:

### L1 · Ngoại lệ per-user được đánh giá KHÔNG theo phạm vi — nghiêm trọng

```sql
-- Body hiện tại (rút gọn):
SELECT EXISTS(SELECT 1 FROM member_permission_overrides o
  WHERE o.membership_id=v_mem AND o.permission_key=p_permission_key AND o.effect='DENY' ...)
```

Không có JOIN sang `member_override_scopes`. Nhưng **100% override đang là scoped** (65 override / 95 dòng scope). Nghĩa là:

- 1 DENY định cho **một** toà đang chặn **toàn tổ chức**.
- 1 ALLOW định cho **một** sổ quỹ đang cấp quyền ở **mọi** sổ quỹ.

Đây là lỗi cả hai chiều: vừa chặn quá tay, vừa cấp quá tay. Không được đưa lên 337 policy khi chưa sửa.

### L2 · Không có DENY cấp vai trò

`role_permissions.effect` có giá trị `DENY` nhưng evaluator chỉ lọc `effect='ALLOW'`. Hiện 0 dòng DENY nên chưa lộ hậu quả — nhưng UI mới sẽ tạo DENY vai trò, và evaluator sẽ **âm thầm bỏ qua**.

### L3 · Thứ tự ưu tiên sai so với §11.5

Plan quy định: `per-user DENY → role DENY → per-user ALLOW → role ALLOW → default deny`.
Hiện tại: `per-user DENY → per-user ALLOW → role ALLOW`. Thiếu hẳn tầng 2.

### L4 · Không kiểm `organizations.status`

Tổ chức `SUSPENDED`/`CLOSED` vẫn authorize bình thường. §11.5 điểm 1 yêu cầu chặn ở tầng cao nhất.

### L5 · Không có `scope_match_mode`

`cashbooks.post` phải **luôn** đòi khớp sổ quỹ (§11.4). Hiện `scope_type='ORGANIZATION'` cho qua mọi resource, kể cả cashbook. Ngoài ra 4 binding đang mở **không có scope nào** — do INNER JOIN `role_binding_scopes` nên chúng là binding chết im lặng, không cấp gì, không báo gì.

---

## 3. Kiến trúc đích

```text
platform_administrators                 ← tách hẳn, không phải role trong tổ chức
        │
organizations (status, authorization_version)
        │
organization_memberships (OWNER│STAFF│SHAREHOLDER│PARTNER│SERVICE, status)
        ├── role_bindings ──→ organization_roles ──→ role_permissions (ALLOW│DENY)
        │        └── role_binding_scopes ──→ authorization_scopes (ORG│AREA│BUILDING│CASHBOOK)
        └── member_permission_overrides (ALLOW│DENY, reason, expires_at)
                 └── member_override_scopes ──→ authorization_scopes

               authorize_v3(permission, org, resource_type, resource_id)
                                    │
        ┌───────────────────────────┴───────────────────────────┐
   RLS (337 tham chiếu qua 4 helper giữ nguyên chữ ký)    RPC writer (đã dùng)
```

Nguyên tắc không thoả hiệp:

1. Deny mặc định. Không có nhánh "không tìm thấy ⇒ cho qua".
2. Sentinel `__superadmin` **chỉ** còn cho platform admin. Owner tổ chức là vai trò được seed đủ 214 quyền, không phải bypass.
3. Không "first assignment wins" — hợp nhất toàn bộ binding đang mở.
4. Mọi thay đổi quyền đi qua **một** RPC, trong **một** transaction, có CAS version và security event.
5. Frontend chỉ phản chiếu. Không màn nào ghi thẳng bảng quyền nữa.

---

## 4. Lộ trình

### T1 · Sửa evaluator + hoàn tất dữ liệu canonical — 3 ngày, không ảnh hưởng production

Toàn bộ T1 chạy trên hàm/bảng **chưa ai gọi**, nên an toàn tuyệt đối.

**T1.1 — `authorize_v3` (hàm mới, không sửa `authorize_v2` để giữ đường lùi)**

```sql
create or replace function public.authorize_v3(
  p_permission_key text, p_org uuid, p_resource_type text, p_resource_id uuid
) returns boolean language plpgsql stable security definer
set search_path to 'pg_catalog','public' as $$
-- 0. auth.uid() bắt buộc; organizations.status='ACTIVE' bắt buộc     (vá L4)
-- 1. membership ACTIVE trong p_org
-- 2. resolve dimension của resource: building_id, area_id, cashbook_id
-- 3. lấy scope_match_mode từ permission_definitions                   (vá L5)
-- 4. materialize MỌI statement áp dụng (role + override), mỗi statement
--    kèm tập scope của chính nó                                       (vá L1)
-- 5. lọc statement theo scope_match_mode trên dimension đã resolve
-- 6. precedence: user DENY → role DENY → user ALLOW → role ALLOW → deny (vá L2,L3)
$$;
```

Kèm theo:

- Thêm cột `permission_definitions.scope_match_mode` (`ANY_MATCH` mặc định, `ALL_REQUIRED`, `CASHBOOK_REQUIRED`). Đặt `CASHBOOK_REQUIRED` cho `cashbooks.post`, `cashbooks.adjust_balance`, `cashbooks.lock_period`, `cashbooks.archive`.
- Hàm mảng cho RLS (đọc theo dòng phải rẻ): `authorized_building_ids_v3(permission_key, org) → uuid[]`, `authorized_cashbook_ids_v3(...)`. Bắt buộc `STABLE` để PostgreSQL cache trong một statement.
- `explain_authorization_v3(membership, permission, resource_type, resource_id) → jsonb` — trả **nguồn quyết định** (statement nào thắng, scope nào khớp). Đây là ruột của tab "Quyền hiệu lực" ở UI mới.

**T1.2 — Đối chiếu 4 binding không scope**: mỗi binding phải có ít nhất một scope, hoặc bị đóng. Thêm constraint trigger cấm binding mở mà không scope.

**T1.3 — Reconcile ngoại lệ per-staff (đóng đúng lỗ đang mở rộng mỗi ngày)**

Với mỗi `staff_assignments` có `permissions` khác `roles.permissions`:

1. Tính diff theo từng permission key.
2. Key bật thêm → `member_permission_overrides` `ALLOW`, scope = scope của binding tương ứng.
3. Key tắt đi → `DENY`, cùng scope.
4. Key không map được sang 214 key canonical → `authorization_migration_exceptions`, owner duyệt tay. **Không đoán.**

**T1.4 — Đưa nốt danh tính vào mô hình**

| Nhóm | Xử lý |
|---|---|
| 3 shareholder có `auth_user_id` | membership `SHAREHOLDER` + binding vai trò hệ thống "Cổ đông" (chỉ `shareholder_profit.view` + self-DTO) |
| 2 profit manager | membership `PARTNER` + vai trò "Quản lý lợi nhuận" |
| 2 shareholder chưa có `auth_user_id` | Không tạo membership. Ghi vào exception, chờ mời qua luồng invite |
| 5 dòng `legacy_owner_allowlist` | Từng người: hoặc là OWNER membership thật, hoặc xoá. Danh sách này **phải về 0** |
| 1 `super_admins` | Chuyển sang bảng mới `platform_administrators` (§11.2) |

**T1.5 — Đóng nốt danh mục quyền**

- Thêm `shareholder_profit.pay_manager` vào `permission_definitions` **và** catalog FE (backend đã đòi, UI chưa cấp được).
- Sinh report đối chiếu 214 key ↔ registry FE: key thiếu, key mồ côi. Đưa về 0 chênh.

**Cổng T1**: `authorize_v3` có unit test cho đủ 6 tầng precedence + 3 scope mode · 0 binding không scope · 0 diff JSONB chưa reconcile · `legacy_owner_allowlist` = 0 · 0 key lệch catalog.

---

### T2 · Đối chiếu bóng — 1 ngày

Bảng `app_private.authz_shadow_diff` sinh từ tích Descartes:

```text
11 membership × 214 permission × {ORG, 21 building, 32 cashbook}  ≈ 125k dòng
```

Mỗi dòng ghi: `legacy_result` (gọi helper cũ), `v3_result` (gọi `authorize_v3`), `verdict`.

**Cổng T2 — điều kiện đi tiếp, không thương lượng:**

- Mọi dòng `legacy=true, v3=false` (mất quyền) phải có dòng giải thích trong `authz_cutover_exceptions` do owner duyệt.
- Mọi dòng `legacy=false, v3=true` (thêm quyền) phải giải thích được — đây là hướng nguy hiểm hơn.
- Đo p95 thời gian: `authorize_v3` gọi trong RLS phải ≤ helper cũ + 20%. Nếu vượt, chuyển sang biến thể mảng `authorized_*_ids_v3` cho các policy nóng trước.

---

### T3 · Xây UI mới sau feature flag — 5 ngày, chưa lộ cho người dùng

Bốn màn thay hẳn `/settings/staff`:

**A · `/settings/organization` — Tổ chức**
Tên, mã, trạng thái, `authorization_version`, ngưỡng tự duyệt (đang nằm ở Cài đặt chung, gom về đây), số thành viên theo loại.

**B · `/settings/organization/members` — Thành viên**
Đọc từ `organization_memberships`. Cột: người, loại thành viên, trạng thái, vai trò đang gán, phạm vi, lần đổi quyền gần nhất.
Hành động: **Mời** (`invite_organization_member_v1`) · **Đình chỉ / Khôi phục** (`set_membership_status_v1`, đã có) · **Thu hồi** (đóng binding, giữ audit) · **Chuyển chủ sở hữu** (hai bước, có chấp nhận).
Không còn nút "Xoá nhân viên" nào xoá `auth.users`.

**C · `/settings/organization/roles` — Mẫu vai trò**
CRUD `organization_roles` + `role_permissions` trên đúng 214 key, nhóm theo `resource`, có cột `sensitivity` (VIEW/MANAGE/ELEVATED). Hỗ trợ **ALLOW và DENY** ở cấp vai trò (evaluator đã hiểu sau T1). Vai trò hệ thống chỉ nhân bản, không sửa.

**D · Hộp thoại phân quyền một người — 3 tab**

| Tab | Nội dung | Ghi vào |
|---|---|---|
| Vai trò & phạm vi | Chọn vai trò, chọn ORG / khu / toà / sổ quỹ | `role_bindings` + `role_binding_scopes` |
| Ngoại lệ | ALLOW/DENY từng quyền, **bắt buộc lý do**, hạn dùng tuỳ chọn, chọn phạm vi áp dụng | `member_permission_overrides` + `member_override_scopes` |
| **Quyền hiệu lực** | Bảng chỉ đọc: từng quyền × từng phạm vi, kết quả thật từ `explain_authorization_v3`, kèm **nguồn quyết định** ("DENY ngoại lệ tại toà A", "ALLOW vai trò Quản Lý Toà") | — |

Tab thứ ba là câu trả lời trực tiếp cho câu hỏi "màn này có nói thật không". Nó đọc từ chính hàm mà server dùng để quyết định, nên không thể lệch.

**Một RPC duy nhất cho mọi thao tác ghi:**

```sql
update_member_authorization_v1(
  p_membership uuid, p_expected_version bigint,
  p_role_bindings jsonb, p_overrides jsonb, p_reason text
) returns jsonb
```

Bảo đảm: một transaction · CAS trên `version` · cấm tự nâng quyền của chính mình · cấm hạ chủ-sở-hữu-cuối · bump `authorization_version` · ghi security event · trả về context mới để FE cập nhật ngay.

**`get_authorization_context_v1()`** thay `get_my_permissions()` ở FE mới, trả DTO §11.7:

```json
{ "organizationId": "...", "membershipId": "...", "memberType": "STAFF",
  "authorizationVersion": 42,
  "permissions": { "buildings.view": true },
  "scopes": { "buildings.view": { "organization": false, "buildingIds": ["..."] } } }
```

Cache key = `(user_id, organization_id, authorizationVersion)`. Backend không tin version client gửi.

---

### T4 · NGÀY G — một transaction DB + một lần deploy

Cửa sổ bảo trì ~2 giờ. Thứ tự trong **một** transaction:

1. `CREATE OR REPLACE` 4 helper lớn + 7 helper nhỏ → ruột gọi `authorize_v3`, **chữ ký không đổi** ⇒ 337 tham chiếu policy đổi nguồn tức thì.
2. `get_my_permissions()` → chiếu từ canonical, **giữ nguyên hình dạng JSONB** (để mọi màn chưa kịp chuyển vẫn chạy đúng), bỏ first-assignment-wins, bỏ nhánh `legacy_owner_allowlist`.
3. `ai_copilot_perms_for(uuid)` → gọi nội bộ cùng một nguồn. Hết hai bản sao phải giữ đồng bộ tay.
4. `is_admin()` / `is_super_admin()` → đọc `platform_administrators`.
5. Bump `authorization_version` cả hai tổ chức ⇒ mọi cache FE tự hỏng.
6. Bật flag `authz.v3` = ON.

Ngay sau commit: deploy FE gồm 4 màn mới + **xoá** `StaffPage`, `useStaffAssignments`, và toàn bộ `fallback` trong `permissionPages.ts`.

**Đường lùi**: trước bước 1, lưu `pg_get_functiondef` của 11 helper vào `app_private.authz_v2_helper_backup`. Rollback = chạy lại 11 định nghĩa cũ + tắt flag, một lệnh, dưới 1 phút. Không mất dữ liệu vì T4 **không xoá gì**.

**Nghiệm thu ngay trong cửa sổ** (script `scripts/verify-authz-v3.mjs`):

| Kiểm | Điều kiện qua |
|---|---|
| Ma trận quyền 11 người | Khớp bảng bóng T2, 0 lệch ngoài exception đã duyệt |
| Đọc chéo tổ chức | REST + RPC + Storage giữa 2 org: rỗng / 42501 |
| Ngoại lệ theo phạm vi | DENY tại toà A **không** chặn toà B (chính lỗi L1) |
| `cashbooks.post` | Người có ORG scope nhưng không giữ sổ → 42501 |
| Đối soát tiền | Tổng org thật bất biến |
| Off-boarding | Đình chỉ → mất quyền ở **cả** đường cũ lẫn mới |
| p95 truy vấn nóng | Không xấu hơn baseline > 20% |

---

### T5 · Dọn xác — sau 1 chu kỳ vận hành (khuyến nghị 14 ngày)

1. `ALTER TABLE ... RENAME TO staff_assignments_dropped_20260810` (đổi tên, **không** DROP — còn forensic).
2. Tương tự `roles`, `legacy_owner_allowlist`, `super_admins`.
3. Drop trigger `a80`/`a81` (không còn nguồn để đồng bộ).
4. Drop `authorize_v2` sau khi 0 caller.
5. Chuyển `get_my_permissions` thành alias mỏng của `get_authorization_context_v1`, hoặc bỏ hẳn khi FE không còn gọi.
6. `npm run gen:types` + cập nhật `docs/authorization/README.md`.
7. Sau 30 ngày mới `DROP TABLE` thật.

---

## 5. Ảnh hưởng đến người dùng

| Nhóm | Trước | Sau |
|---|---|---|
| Chủ sở hữu | Màn Nhân viên, không thấy tổ chức | Thêm Tổ chức / Thành viên / Vai trò; thấy quyền hiệu lực thật |
| Quản lý toà | Quyền suy từ assignment đầu tiên | Hợp nhất mọi binding — **có thể thấy quyền rộng hơn hôm nay nếu đang có nhiều assignment**; T2 phải liệt kê từng trường hợp |
| Nhân viên bị tinh chỉnh quyền | UI nói một đằng, server làm một nẻo | Trùng khớp. Vài người sẽ **mất** quyền họ tưởng có, hoặc **được** quyền server vẫn chặn |
| Cổ đông / quản lý LN | Nhánh riêng trong hàm quyền | Thành viên thật, vai trò thật |
| Tài khoản mới | Admin tạo thẳng, biết mật khẩu đầu | Mời qua email, người được mời tự đặt mật khẩu |

**Bắt buộc**: T2 phải xuất danh sách "ai đổi quyền gì" cho owner duyệt **trước** Ngày G. Không được để người dùng phát hiện bằng cách bấm nút rồi gặp 42501.

---

## 6. Rủi ro và cách chặn

| Rủi ro | Mức | Cách chặn |
|---|---|---|
| Ngữ nghĩa helper mới lệch helper cũ → mất/thừa quyền diện rộng | **Cao** | Cổng T2: 125k dòng đối chiếu, 0 lệch ngoài exception đã duyệt |
| `authorize_v3` gọi theo dòng làm chậm RLS | **Cao** | Đo p95 ở T2; biến thể mảng `authorized_*_ids_v3` cho policy nóng; `STABLE` để cache trong statement |
| Sửa L1 (ngoại lệ theo phạm vi) làm ai đó mất quyền đang dùng | Trung bình | 65 override đều scoped — T2 liệt kê từng thay đổi, owner duyệt từng dòng |
| Reconcile JSONB đoán sai | Trung bình | Key không map được → exception, **không tự quyết** |
| Ngày G lỗi giữa chừng | Trung bình | Một transaction, backup 11 định nghĩa helper, rollback < 1 phút |
| Xoá `staff_assignments` sớm | Thấp | T5 đổi tên trước, DROP thật sau 30 ngày |
| UI mới thiếu tính năng so với màn cũ | Thấp | Đối chiếu tính năng ở T3 trước khi xoá `StaffPage` |

---

## 7. Ngân sách công

| Giai đoạn | Ngày công | Chạm production? |
|---|---:|---|
| T1 · evaluator v3 + hoàn tất dữ liệu | 3 | Không |
| T2 · đối chiếu bóng + duyệt thay đổi | 1 | Không |
| T3 · 4 màn UI + RPC + DTO | 5 | Không (sau flag) |
| T4 · Ngày G | 0.5 | **Có** — một cửa sổ |
| T5 · dọn xác | 1 | Có, thấp |
| Dự phòng | 1 | |
| **Tổng** | **~11.5** | |

---

## 8. Tiêu chí §20 sau khi xong

| # | Tiêu chí | Trước | Sau |
|---|---|---|---|
| 2 | Orphan fail closed | Đạt (còn allowlist) | **Đạt sạch** |
| 4 | Backend exact action | **Chưa đạt** | **Đạt** — 337 tham chiếu qua evaluator canonical |
| 8 | Maker-checker | Một phần | Một phần *(auto-duyệt là quyết định owner, ngoài phạm vi plan này)* |
| 13 | Staff lifecycle | Một phần | **Đạt** — invite/suspend/revoke có UI |
| 1 | Explicit tenant | Một phần | Một phần *(nợ NOT NULL, tranche riêng)* |

Sau đợt này: **6/15 đạt · 7 một phần · 1 chưa đạt · 1 khác plan**. Hai việc còn lại để về 15/15 là NOT NULL toàn bộ `organization_id` và T7 Pha B (rút DML `authenticated`) — cả hai độc lập với phân quyền.

---

## 9. Điều owner cần quyết trước khi thi công

1. **Ngày G** — chọn cửa sổ 2 giờ ít giao dịch.
2. **DENY cấp vai trò** — có mở tính năng này ở UI không, hay chỉ ALLOW ở vai trò và DENY ở ngoại lệ? *(Đề xuất: mở, evaluator đã hiểu sau T1.)*
3. **2 cổ đông chưa có tài khoản** — mời vào hệ thống hay để ngoài?
4. **5 dòng `legacy_owner_allowlist`** — từng người là OWNER thật hay bỏ? Cần owner xác nhận danh tính.
5. **Thời gian giữ bảng cũ** — 14 ngày đổi tên + 30 ngày trước khi DROP, hay khác?
