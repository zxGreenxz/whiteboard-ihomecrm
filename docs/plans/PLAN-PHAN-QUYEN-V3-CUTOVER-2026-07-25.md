# PLAN — Chuyển hẳn phân quyền sang mô hình tổ chức, cắt hệ cũ một lần

> **Bản 3 — 2026-07-25 (tối), sau vòng review độc lập lần 2.** Bản 1 sai 3 chỗ (§0); bản 3 đính chính thêm 3 điểm và bổ sung 2 finding mới (§0bis).
> **Quyết định owner đã chốt**: xong tới đâu áp tới đó (không hẹn cửa sổ) · cho phép DENY cấp vai trò · 2 cổ đông chưa có tài khoản để mời sau · chỉ `nguyentamca165@gmail.com` là chủ, còn lại là quản lý · giữ bảng cũ 30 ngày rồi xoá.
> **Tiền đề**: Đợt 1 hardening đã xong (`0d1da42`).

---

## 0bis. Vòng review 2 — đính chính bản 2 và 2 finding mới

Chạy thêm 4 truy vấn xác minh trên catalog live. Kết quả:

### Đính chính (đều theo hướng **rủi ro nhẹ hơn** bản 2 tưởng)

| Bản 2 viết | Thực tế đo được | Ảnh hưởng plan |
|---|---|---|
| "Vai trò Super Admin rỗng, **18 người** đang gán → có thể mất quyền, **chặn cutover**" | 18 binding đó **của DUY NHẤT `nguyentamca165`** (OWNER), tất cả **đều có scope**, và người này đã có vai trò "Chủ sở hữu tổ chức" = 214 quyền | Vai trò rỗng này **vô hại** — không ai mất quyền. Hạ từ "Cao — chặn cutover" xuống **"Thấp — dọn rác"**. |
| "Ngữ nghĩa `current_visible_owner_ids` lệch — rủi ro **Cao**" | Đồ thị nhân viên cũ == danh sách thành viên tổ chức, **khớp tuyệt đối**: nguyentamca165 10/10, joey 4/4, nathan 4/4, bosshuy 4/4 | Ánh xạ an toàn, có bằng chứng số. Hạ rủi ro xuống **Thấp** (vẫn giữ cổng đối chiếu bóng). |
| *(không nêu)* | 214 policy `TO public` dùng helper — nhưng helper kiểm `auth.uid()` bên trong nên anon (chưa đăng nhập) luôn nhận `false`. Không phải lỗ hổng | Đổi ruột helper **không làm lộ dữ liệu cho anon**. Xác nhận an toàn. |

### Finding mới 1 — CÓ THỂ GÃY PRODUCTION nếu bỏ sót ⚠

**`settings.create` và `settings.delete` không có trong catalog 214 key.**

- 89 cặp `(resource, action)` được policy truyền vào helper. 87 cặp khớp catalog; **2 cặp không**: `settings.create`, `settings.delete`.
- Catalog chỉ có `settings.view` + `settings.edit`. Nhưng policy đang gọi `can_do_on_building('settings','create'|'delete')`.
- Helper **cũ** tự xử lý không cần key catalog. Nhưng ruột **mới** (`can_v3('settings.create')`) sẽ trả `false` ngay ở tầng "quyền phải tồn tại & đang bật" → **mất quyền tạo/xoá cấu hình sau Ngày G**.
- **Xử lý (thêm vào §5 việc 6)**: hoặc thêm 2 key `settings.create`/`settings.delete` vào `permission_definitions`, hoặc gộp create/delete-settings vào `settings.edit` và sửa 2 policy. Quyết định lúc T2, kiểm bằng đối chiếu bóng ở T3.
- *(Đã kiểm: mọi lời gọi helper đều dùng string literal, không có đối số biến, nên 89 cặp là danh sách đóng — không cặp nào lọt regex.)*

### Finding mới 2 — mở rộng phạm vi test (không chặn, nhưng phải phủ)

**71 hàm — không chỉ 337 policy — cũng gọi 11 helper.**

Đổi ruột helper đồng thời đổi hành vi của 71 function, gồm nhiều RPC quan trọng: `approve_voucher`, `unapprove_voucher`, `terminate_contract_move_out/forfeit`, `transfer_contract`, `renew_contract`, `record_invoice_payment_v2`, `create/approve/cancel_income_expense_v1`, và **cả nhóm báo cáo** `fa_monthly_pnl`, `fa_occupancy_monthly`, `occupancy_snapshot_v2`, `pra_*` (thống kê phòng công khai).

- Về mặt nhất quán đây là **điều tốt** — 71 hàm đó cũng nên dùng model mới thay vì đọc bảng cũ.
- Nhưng test ở T3 phải phủ **cả nhóm này**, không chỉ 337 policy. Đặc biệt báo cáo `fa_*`/`occupancy_*` có thể lệch số **âm thầm** (không lỗi, chỉ ra sai) nếu ngữ nghĩa "toà nào tôi thấy" đổi. Thêm vào ma trận kiểm thử §10: chạy lại toàn bộ báo cáo tài chính/vận hành trước-sau, so từng con số.

---

## 0. Đính chính bản 1

Sau khi đọc kỹ catalog live, ba nhận định trong bản 1 là **sai**:

| Bản 1 viết | Thực tế | Vì sao sai |
|---|---|---|
| "Chỉ 8 hàm dùng mô hình mới" | **~48 RPC ghi tiền** đã dùng `app_private.authorize_tenant_action_v3` | Tôi đếm caller của `authorize_v2` (evaluator **cũ**), không phải v3. `authorize_v2` giờ chỉ còn 7 hàm profit dùng. |
| "Evaluator có 5 lỗi thiết kế L1–L5, phải xây `authorize_v3`" | **`authorize_tenant_action_v3` đã vá cả 5**, và còn hơn thế | 5 lỗi đó là của `authorize_v2` (đường cũ, hẹp). Evaluator đúng đã tồn tại từ trước. |
| "DENY một toà đang chặn toàn tổ chức" | **Không đúng với đường ghi thật** | v3 join `member_override_scopes` đầy đủ. Thêm nữa 63/65 override khai `scope_mode='ORGANIZATION'` là **cố ý**, chỉ 2 dòng là `SCOPED`. |

**Điều vẫn đúng và là lõi của plan này**: 0/624 RLS policy dùng mô hình mới · `get_my_permissions()` vẫn đọc `staff_assignments` kiểu "lấy dòng đầu tiên" · màn phân quyền vẫn ghi bảng cũ · lớp tinh chỉnh từng người vẫn không được đồng bộ · không có màn quản lý tổ chức.

Bức tranh đúng gọn hơn nhiều: **đường GHI đã sang hệ mới rồi. Còn đường ĐỌC và đường QUẢN TRỊ.**

---

## 1. Ba đường, hai đã xong

```text
┌─ ĐƯỜNG GHI (RPC writer) ────────────────── ✅ ĐÃ SANG HỆ MỚI
│    48 RPC → app_private.authorize_tenant_action_v3
│    → membership + role_binding + scope + override + possession
│    → trả allowed / authorization_version / nearest_deadline / decision_reason
│
├─ ĐƯỜNG ĐỌC (RLS 624 policy) ─────────────── ❌ CÒN HỆ CŨ
│    can_access_org_entity(192) · can_do_on_building(74)
│    current_visible_owner_ids(41) · can_access_building(30) · nhóm nhỏ(31)
│    → tất cả đọc staff_assignments + roles.permissions JSONB
│
└─ ĐƯỜNG QUẢN TRỊ (UI + hàm quyền cho FE) ─── ❌ CÒN HỆ CŨ
     get_my_permissions() → staff_assignments, "lấy dòng đầu tiên"
     StaffPage → ghi thẳng staff_assignments / roles / profiles
     Không có màn tổ chức · không có luồng mời · không thấy quyền hiệu lực
```

Hệ quả thực tế của việc hai đường lệch nhau:

- Bấm nút → FE cho phép (đọc quyền cũ) → RPC từ chối `42501` (kiểm quyền mới). Đây là GAP-2 bosshuy trong punch-list go-live.
- Bỏ tick một quyền cho một người → hệ cũ tôn trọng, RPC mới vẫn cho vì binding vai trò còn nguyên.

---

## 2. Mô hình nghiệp vụ đích

### 2.1 Bốn loại thành viên

| Loại | Nghĩa nghiệp vụ | Ai đang là | Quyền nền |
|---|---|---|---|
| `OWNER` | Chủ tổ chức. Toàn quyền trong **tổ chức của mình**, không phải toàn hệ thống | `nguyentamca165@gmail.com` (org thật) · 1 tài khoản demo | Vai trò "Chủ sở hữu tổ chức" = 214/214 quyền |
| `STAFF` | Nhân sự vận hành: quản lý toà, kế toán, kỹ thuật | joey, nathan (org thật) + 6 demo | Vai trò theo chức danh, phạm vi theo toà/khu |
| `PARTNER` | Đối tác/cổ đông có tài khoản, chỉ xem phần được chia | bosshuy | Vai trò "Partner" = 19 quyền |
| `SERVICE` | Cron, worker, tích hợp | *(chưa dùng)* | Allowlist RPC nội bộ |

Tách bạch với **platform**: `nguyentamca165` đồng thời là super-admin nền tảng. Sau cutover, hai vai trò này **không lẫn nhau nữa** — quyền nền tảng nằm ở bảng riêng, quyền tổ chức nằm ở membership.

### 2.2 Công thức quyền

```text
ĐƯỢC LÀM GÌ  = vai trò (role_permissions) ± ngoại lệ riêng (member_permission_overrides)
LÀM Ở ĐÂU    = phạm vi (authorization_scopes: TỔ CHỨC │ KHU │ TOÀ │ SỔ QUỸ)
RIÊNG SỔ QUỸ = phải "đang giữ sổ" (cashbook_possession_bindings: CUSTODIAN │ KNOWER)
```

Thứ tự quyết định (đã cài đúng trong v3):

```text
1. Tổ chức phải ACTIVE                       → không thì CHẶN
2. Quyền phải tồn tại & đang bật              → không thì CHẶN
3. Thiếu chiều bắt buộc (toà/sổ)              → CHẶN
4. Phải là thành viên ACTIVE                  → không thì CHẶN
5. Đối tượng phải cùng tổ chức                → không thì CHẶN
6. Lệnh cấm khẩn cấp                          → CHẶN
7. Ngoại lệ CẤM của người này                 → CHẶN
8. Vai trò CẤM                                → CHẶN
9. Cần giữ sổ mà không giữ                    → CHẶN
10. Ngoại lệ CHO của người này                → CHO
11. Vai trò CHO                               → CHO
12. Còn lại                                   → CHẶN (mặc định cấm)
```

### 2.3 Hiện trạng org thật (4 người)

| Người | Loại | Vai trò (số phạm vi) | Ngoại lệ | Sổ quỹ đang giữ |
|---|---|---|---|---:|
| nguyentamca165 | OWNER | Chủ sở hữu tổ chức (22) + **Super Admin (1 — 0 quyền)** | 2 CHO | 21 |
| joey | STAFF | Quản Lý Tòa (1) | 15 CHO · 4 CẤM | 10 |
| nathan | STAFF | Quản Lý Tòa (1) | 15 CHO · 3 CẤM | 10 |
| bosshuy | PARTNER | Partner (1) | 20 CHO | 1 |

Khớp đúng lời owner: chỉ 1 chủ, còn lại quản lý/đối tác.

### 2.4 Sáu vai trò đang dùng

| Tổ chức | Vai trò | Hệ thống? | Số quyền CHO | Binding đang mở | Ghi chú |
|---|---|---|---:|---:|---|
| Thật | Chủ sở hữu tổ chức | ✅ | 214 | 1 | Đủ toàn bộ |
| Thật | Quản Lý Tòa | | 116 | 18 | Vai trò vận hành chính |
| Thật | Partner | | 19 | 13 | Đối tác |
| Thật | **Super Admin** | | **0** | **18** | ⚠ Vai trò rỗng — xem §6 |
| Thật | Huy | | 30 | 0 | Không ai dùng |
| Thật | Viewer | | 18 | 0 | Không ai dùng |
| Demo | Chủ sở hữu tổ chức / Quản Lý Tòa / Viewer | | 214 / 115 / 18 | 3 / 13 / 3 | |

---

## 3. Cái đã có vs cái phải xây

| Hạng mục | Trạng thái | Việc |
|---|---|---|
| Evaluator chuẩn `authorize_tenant_action_v3` | ✅ Đã có, đủ 12 tầng, trả `decision_reason` | Dùng lại, không viết mới |
| 48 RPC ghi tiền dùng evaluator | ✅ Đã có | Không đụng |
| Bảng quyền/vai trò/phạm vi/ngoại lệ/giữ sổ | ✅ Đủ, có dữ liệu | Dọn 3 chỗ (§6) |
| `permission_definitions` 214 key + metadata phạm vi/possession | ✅ Đã có | Bổ sung 1 key thiếu |
| `cashbook_possession_bindings` + RPC quản lý giữ sổ | ✅ Đã có (60 dòng) | Đưa vào UI mới |
| `set_membership_status_v1` (đình chỉ/khôi phục) | ✅ Đã có | Đưa vào UI mới |
| `organization_invitations` (bảng) | ⚠ Có bảng, **0 dòng, 0 RPC, 0 UI** | Xây RPC + UI |
| `authorization_audit_events` | ✅ Có bảng | Ghi từ RPC quản trị mới |
| **Evaluator cho đường ĐỌC** | ❌ **Chưa có** | **Xây — §4** |
| RLS dùng mô hình mới | ❌ 0/624 | Ánh xạ 11 helper — §5 |
| `get_my_permissions` từ mô hình mới | ❌ Còn legacy | Thay — §5 |
| RPC quản trị (mời/sửa quyền/vai trò) | ❌ Chưa có | Xây — §7 |
| 4 màn UI | ❌ Chưa có | Xây — §8 |

---

## 4. Mảnh kỹ thuật then chốt: evaluator cho đường ĐỌC

### 4.1 Vì sao không dùng thẳng `authorize_tenant_action_v3` trong RLS

Ba lý do kỹ thuật, đều nghiêm trọng:

1. **Nó khoá hàng tổ chức** (`for share`) theo hợp đồng "writer protocol" — caller phải gọi `lock_org_for_decision_v1()` ở statement trước. RLS không có statement trước, và khoá theo từng dòng đọc là sai.
2. **Nó có thể `RAISE`** (`raise_malformed_override`). Ném lỗi bên trong policy làm gãy cả câu đọc thay vì trả rỗng.
3. **Nó là VOLATILE** (SQL không khai `STABLE`). Trong RLS, VOLATILE nghĩa là **gọi lại cho từng dòng**, không cache được. Bảng 10.000 dòng = 10.000 lần đánh giá.

### 4.2 Thiết kế: hàm chị em cho đường đọc

```sql
-- Trả về "tôi được làm quyền này ở đâu", một lần cho cả câu truy vấn.
app_private.authorized_scope_v3(p_permission_key text, p_org uuid)
  RETURNS TABLE (org_wide boolean, building_ids uuid[], cashbook_ids uuid[])
  LANGUAGE sql STABLE SECURITY DEFINER          -- STABLE ⇒ Postgres cache trong statement
  SET search_path TO 'pg_catalog','app_private','public'
```

Khác `authorize_tenant_action_v3` đúng ba điểm: **không khoá** · **không raise** (override dị dạng bị bỏ qua và ghi log, không ném) · **STABLE** để cache. Toàn bộ logic 12 tầng còn lại **dùng chung một nguồn** — trích ra hàm nội bộ để hai bên không drift.

Trên nó dựng 2 hàm tiện dụng cho RLS:

```sql
app_private.can_v3(p_permission_key text, p_building uuid DEFAULT NULL,
                   p_cashbook uuid DEFAULT NULL) RETURNS boolean   -- STABLE
app_private.buildings_for_v3(p_permission_key text) RETURNS uuid[] -- STABLE
```

### 4.3 Ánh xạ 11 helper — giữ nguyên chữ ký, đổi ruột

| Helper (không đổi chữ ký) | Policy | Ruột mới |
|---|---:|---|
| `can_access_org_entity(resource, action)` | 192 | `can_v3(resource‖'.'‖action)` — không kèm toà ⇒ đúng ngữ nghĩa "có quyền này ở bất kỳ đâu" |
| `can_do_on_building(resource, action, building)` | 74 | `can_v3(resource‖'.'‖action, building)` |
| `current_visible_owner_ids()` | 41 | `SELECT user_id FROM organization_memberships WHERE organization_id = ANY(my_org_ids()) AND status='ACTIVE'` — lọc theo tổ chức thay vì đồ thị chủ cũ |
| `can_access_building(building)` | 30 | `can_v3('buildings.view', building)` |
| `permitted_building_ids(resource, action)` | 6 | `unnest(buildings_for_v3(resource‖'.'‖action))` |
| `accessible_building_ids()` | 5 | `unnest(buildings_for_v3('buildings.view'))` |
| `staff_can(resource, action, building)` | 9 | alias của `can_do_on_building` |
| `same_team`, `ie_all_buildings_scope`, `can_view/create_restricted_ie` | 11 | ánh xạ 1-1 sang key tương ứng |

`current_visible_owner_ids()` là mắt xích tinh tế nhất: nó trả **danh sách user_id chủ sở hữu dòng dữ liệu**, policy dùng `WHERE user_id IN (...)`. Đổi thành "mọi thành viên trong tổ chức của tôi" chính là lọc theo tổ chức — và bao đúng cả các dòng do nhân viên tạo (ví dụ joey đứng tên 4 sổ quỹ). §9 phải chứng minh tương đương bằng số.

### 4.4 Hiệu năng — rủi ro cao nhất của cả plan

`can_access_org_entity` nằm trong 192 policy. Nếu chậm, cả app chậm.

- Bắt buộc `STABLE` + `materialized` CTE để đánh giá **một lần / statement**.
- Đo p95 trên 10 truy vấn nóng nhất (danh sách phiếu, hoá đơn, phòng, hợp đồng, dashboard) trước/sau.
- Ngưỡng chặn: **không xấu hơn 20%**. Vượt → chuyển policy nóng sang dạng mảng `building_id = ANY(buildings_for_v3(...))` trước khi đi tiếp.
- Chuẩn bị sẵn index: `role_bindings(membership_id, valid_to)`, `role_binding_scopes(role_binding_id)`, `authorization_scopes(organization_id, scope_type, building_id)`, `member_override_scopes(override_id)`.

---

## 5. Đổi đường đọc và đường quản trị

### 5.1 `get_my_permissions()` — giữ hình dạng, đổi nguồn

Hình dạng JSONB `{ module: { action: true } }` **giữ nguyên** để không màn nào gãy trong lúc chuyển UI. Ruột mới:

```text
1. platform admin  → {"__platform_admin": true}     (sentinel MỚI, chỉ nền tảng)
2. thành viên      → hợp nhất MỌI binding đang mở + ngoại lệ, trừ DENY
3. còn lại         → {}                              (đóng chặt)
```

Ba thay đổi hành vi: bỏ "lấy dòng đầu tiên" · bỏ nhánh `legacy_owner_allowlist` · sentinel `__superadmin` chỉ còn cho nền tảng, chủ tổ chức nhận đủ 214 key tường minh.

`effective_perms_v2` hiện **mù phạm vi** (không join scope) nên không dùng lại được — thay bằng hàm mới dựng trên `authorized_scope_v3`.

### 5.2 `get_authorization_context_v1()` — DTO cho FE mới

```json
{
  "organizationId": "...", "membershipId": "...", "memberType": "STAFF",
  "authorizationVersion": 42,
  "nearestDeadline": "2026-08-01T00:00:00Z",
  "permissions": { "invoices.view": true, "cashbooks.post": true },
  "scopes": { "invoices.view": { "orgWide": false, "buildingIds": ["…"] },
              "cashbooks.post": { "orgWide": false, "cashbookIds": ["…"] } }
}
```

`nearestDeadline` lấy sẵn từ evaluator — FE tự làm mới cache khi một binding/ngoại lệ hết hạn. Cache key `(user, org, authorizationVersion)`; backend **không tin** version client gửi.

---

## 6. Dữ liệu phải dọn trước — 5 việc

| # | Vấn đề | Số liệu | Xử lý |
|---|---|---|---|
| 1 | **Vai trò "Super Admin" rỗng, 18 binding** | 0 quyền / 18 binding, **tất cả của mình `nguyentamca165` (OWNER)** | *(Review 2 đã đo)* Vô hại — người này đã có vai trò "Chủ sở hữu tổ chức" = 214 quyền, nên 18 binding rỗng không cấp/cắt gì. Chỉ cần **dọn rác**: xoá vai trò rỗng + 18 binding. **Không còn chặn cutover.** |
| 2 | **4 binding không có phạm vi** | 4 | Binding không phạm vi = cấp 0 quyền (v3 INNER JOIN scope). Gán phạm vi hoặc đóng. Thêm ràng buộc cấm tái diễn. |
| 3 | **Ngoại lệ per-staff chưa đồng bộ** | 5/9 người JSONB lệch mẫu | Sinh override CHO/CẤM từ diff, đúng `scope_mode`. Key không map được → bảng ngoại lệ, owner duyệt tay. **Không đoán.** |
| 4 | **`legacy_owner_allowlist`** | 5 dòng | Đã xác minh: **4 dòng là code chết** (nguyentamca165 được super_admin bắt trước; joey/nathan/bosshuy có quyền nhân viên nên hàm dừng sớm). Chỉ tài khoản **demo** thật sự dùng nhánh này. → Xoá 4 dòng ngay (không đổi hành vi), dòng demo xoá tại Ngày G khi OWNER membership thay thế. |
| 5 | **Cổ đông/quản lý LN ngoài mô hình** | 3 cổ đông có tài khoản · 2 quản lý LN · 2 cổ đông chưa có tài khoản | 5 người có tài khoản → membership `PARTNER` + vai trò tương ứng. 2 người chưa có tài khoản: **để ngoài, mời sau** (owner đã chốt). |
| 6 | **`settings.create` / `settings.delete` thiếu trong catalog** *(finding review 2)* | 2 key / catalog chỉ có view+edit | Policy đang gọi 2 action này qua helper; ruột mới sẽ trả `false` → mất quyền tạo/xoá cấu hình. Thêm 2 key vào `permission_definitions` **hoặc** gộp vào `settings.edit` + sửa 2 policy. **Chặn cutover nếu chưa xong.** |

---

## 7. RPC quản trị mới — 6 hàm

| RPC | Việc | Ràng buộc |
|---|---|---|
| `get_authorization_context_v1()` | DTO quyền cho FE | Chỉ của chính caller |
| `explain_authorization_v1(membership, key, building, cashbook)` | Trả `decision_reason` của evaluator | Cần `users.view`; đây là ruột tab "Quyền hiệu lực" |
| `update_member_authorization_v1(membership, expected_version, bindings, overrides, reason)` | **Một** đường ghi duy nhất cho vai trò + phạm vi + ngoại lệ | Một transaction · CAS `version` · cấm tự nâng quyền mình · cấm hạ chủ-cuối · bump `authorization_version` · ghi `authorization_audit_events` |
| `upsert_organization_role_v1(role_id, name, permissions[])` | CRUD mẫu vai trò, hỗ trợ **CHO và CẤM** | Vai trò hệ thống chỉ nhân bản; cấm gán quyền `permission_domain='PLATFORM'` |
| `invite_organization_member_v1(email, member_type, role_id, scopes)` | Tạo lời mời, token băm, hạn dùng | Cần `users.create`; email chuẩn hoá; token dùng một lần |
| `accept_organization_invitation_v1(token)` | Người được mời tự kích hoạt | Token còn hạn, chưa dùng; tạo membership + binding theo lời mời |

Ba hàm `set_membership_status_v1`, `set_cashbook_access_v2`, `get_cashbook_access_admin_v2` **đã có** — chỉ nối vào UI.

---

## 8. Giao diện — 4 màn thay 1

### 8.1 Nguyên tắc UX

1. **Không bao giờ hiển thị quyền mà server không công nhận.** Mọi ô tick đọc từ mô hình mới; tab "Quyền hiệu lực" đối chiếu bằng chính hàm quyết định.
2. **Ngôn ngữ nghiệp vụ, không ngôn ngữ kỹ thuật.** "Được duyệt phiếu chi ở toà Nguyễn Văn Kính", không phải `income_expenses.approve @ BUILDING:uuid`.
3. **Ba lớp rõ ràng**: Mẫu vai trò (dùng chung) → Phạm vi (ở đâu) → Ngoại lệ (riêng người này). Người dùng luôn biết mình đang sửa lớp nào.
4. **Ngoại lệ phải có lý do.** Bắt buộc nhập, hiện trong lịch sử.
5. **Thay đổi có hậu quả thì phải xem trước.** Trước khi Lưu, hiện "sau khi lưu, người này sẽ **mất** X quyền, **được thêm** Y quyền".

### 8.2 Màn A — Tổ chức · `/settings/organization`

```text
┌────────────────────────────────────────────────────────────┐
│ iHome CRM                                    [Đang hoạt động]│
│ 21 toà · 4 thành viên · 21 sổ quỹ                            │
├────────────────────────────────────────────────────────────┤
│ Chủ sở hữu     NG TÂM · nguyentamca165@gmail.com            │
│ Ngưỡng tự duyệt phiếu chi      300.000 đ        [Sửa]       │
│ Phiên bản phân quyền           v42 · cập nhật 2 giờ trước   │
└────────────────────────────────────────────────────────────┘
```

Gom "Ngưỡng tự duyệt phiếu chi" từ Cài đặt chung về đây — nó là quyết định cấp tổ chức, không phải cấu hình lặt vặt.

### 8.3 Màn B — Thành viên · `/settings/organization/members`

```text
[Nhân sự] [Đối tác] [Đã đình chỉ]              [+ Mời thành viên]

┌──────────────────────────────────────────────────────────────┐
│ NG TÂM            Chủ sở hữu   Toàn tổ chức      21 sổ  [⋯]  │
│ nguyentamca165@gmail.com                                      │
├──────────────────────────────────────────────────────────────┤
│ NATHAN            Quản lý toà  10 toà            10 sổ  [⋯]  │
│ ⚠ 15 quyền thêm riêng · 3 quyền bị gỡ riêng                  │
├──────────────────────────────────────────────────────────────┤
│ JOEY              Quản lý toà  10 toà            10 sổ  [⋯]  │
├──────────────────────────────────────────────────────────────┤
│ B.HUY             Đối tác      Toàn tổ chức       1 sổ  [⋯]  │
└──────────────────────────────────────────────────────────────┘
```

Menu `⋯`: Sửa phân quyền · Xem quyền hiệu lực · Đình chỉ · Thu hồi · Chuyển quyền chủ sở hữu.
**Không còn nút nào xoá tài khoản đăng nhập.** Thu hồi = đóng membership, giữ nguyên lịch sử.

Dòng cảnh báo "15 quyền thêm riêng" là chủ đích: cho owner thấy ngay ai đang lệch mẫu — thứ hôm nay hoàn toàn ẩn.

### 8.4 Màn C — Mẫu vai trò · `/settings/organization/roles`

```text
┌─ Chủ sở hữu tổ chức ── hệ thống ── 214/214 quyền ── 1 người ─┐
│  Không sửa được. [Nhân bản]                                   │
├─ Quản lý toà ──────────────────── 116/214 quyền ── 18 người ─┤
│  [Sửa] [Nhân bản] [Xoá]                                       │
├─ Partner ──────────────────────── 19/214 quyền ── 13 người ──┤
├─ Super Admin ──────────────────── 0/214 quyền ── 18 người ⚠ ─┤
│  ⚠ Vai trò này không cấp quyền nào. 18 người đang gán.        │
└───────────────────────────────────────────────────────────────┘
```

Trình sửa quyền nhóm theo **trang màn hình** (dùng lại `PAGE_GROUPS` sẵn có trong `permissionPages.ts` — đúng cách người dùng nghĩ), mỗi quyền có 3 trạng thái: **Cho · Không đặt · Cấm**. Quyền nhạy cảm (`ELEVATED`: duyệt, huỷ, hoàn tác, chi lương, chia lợi nhuận) có nhãn màu riêng.

### 8.5 Màn D — Hộp thoại phân quyền một người, 3 tab

**Tab 1 · Vai trò & phạm vi**

```text
Vai trò        [Quản lý toà        ▾]   116 quyền
Áp dụng ở      ( ) Toàn tổ chức
               (•) Chọn khu vực / toà nhà
               ☑ 158PVC  ☑ 80DS3  ☑ 331PHI  … (10 toà)
Sổ quỹ giữ     ☑ Tiền mặt NVK  ☑ VCB …  (10 sổ)   [Quản lý]
```

**Tab 2 · Ngoại lệ riêng**

```text
[+ Thêm ngoại lệ]

CHO THÊM (15)
  ✓ Duyệt phiếu chi          Toàn tổ chức   "Owner uỷ quyền 07/2026"  [Gỡ]
  ✓ Hoàn tác thu tiền        158PVC         "Xử lý sai sót tại chỗ"   [Gỡ]

ĐANG CẤM (3)
  ✕ Xoá hợp đồng             Toàn tổ chức   "Chỉ chủ được xoá"        [Gỡ]
```

Mỗi dòng bắt buộc: quyền · phạm vi · **lý do** · hạn dùng (tuỳ chọn). CẤM luôn thắng CHO — nói rõ trên màn.

**Tab 3 · Quyền hiệu lực** *(chỉ đọc — đây là tab quan trọng nhất)*

```text
Lọc: [Tất cả ▾]  [Chỉ quyền được phép]  Phạm vi: [158PVC ▾]

Quyền                        Kết quả    Vì sao
─────────────────────────────────────────────────────────────
Xem phiếu thu chi            ✅ Được    Vai trò "Quản lý toà"
Duyệt phiếu chi              ✅ Được    Ngoại lệ CHO — toàn tổ chức
Chi tiền từ sổ quỹ           ✅ Được    Vai trò + đang giữ sổ (CUSTODIAN)
Xoá hợp đồng                 ⛔ Không   Ngoại lệ CẤM — "Chỉ chủ được xoá"
Chia lợi nhuận cổ đông       ⛔ Không   Vai trò không có quyền này
Chi tiền từ sổ "Quỹ HN"      ⛔ Không   Không giữ sổ này
```

Cột "Vì sao" lấy thẳng `decision_reason` của evaluator, dịch sang tiếng Việt. Đây là thứ khiến màn phân quyền **không thể nói dối** nữa.

### 8.6 Luồng mời thành viên

```text
Owner: [+ Mời thành viên]
   → nhập email · chọn loại (Nhân sự/Đối tác) · chọn vai trò · chọn phạm vi
   → hệ thống gửi email chứa link 1 lần, hạn 7 ngày
   → trạng thái "Đã mời — chờ nhận"
Người được mời: mở link → tự đặt mật khẩu → membership ACTIVE
```

Thay cho cách hiện tại (admin tạo thẳng tài khoản và **biết mật khẩu ban đầu**).

### 8.7 Xử lý tình huống người dùng gặp

| Tình huống | Màn hình phải làm gì |
|---|---|
| Sửa quyền của chính mình | Chặn, kèm câu: "Bạn không thể tự sửa quyền của mình. Nhờ chủ sở hữu thực hiện." |
| Hạ chủ sở hữu cuối cùng | Chặn: "Tổ chức phải luôn có ít nhất một chủ sở hữu." |
| Hai người sửa cùng lúc | CAS version → "Có người vừa đổi phân quyền của thành viên này. Tải lại để xem thay đổi mới nhất." |
| Gỡ vai trò khi còn giữ sổ quỹ | Cảnh báo: "Người này đang giữ 10 sổ quỹ. Gỡ vai trò không tự thu hồi quyền giữ sổ." + nút xử lý luôn |
| Bấm Lưu | Xem trước: "Sẽ **mất** 3 quyền, **được thêm** 1 quyền" trước khi xác nhận |

---

## 9. Lộ trình

| GĐ | Việc | Ngày công | Chạm production? |
|---|---|---:|---|
| **T1** | Hàm đọc `authorized_scope_v3` + `can_v3` + `buildings_for_v3` + index | 2 | Không |
| **T2** | Dọn 5 việc dữ liệu ở §6 | 1,5 | Có, rất thấp (xoá 4 dòng chết) |
| **T3** | Đối chiếu bóng + đo hiệu năng | 1,5 | Không |
| **T4** | 6 RPC quản trị | 2 | Không (chưa ai gọi) |
| **T5** | 4 màn UI sau cờ tính năng | 5 | Không |
| **T6** | **Ngày G** — đổi 11 helper + `get_my_permissions` + deploy UI | 0,5 | **Có** |
| **T7** | Dọn xác sau 30 ngày | 1 | Thấp |
| | Dự phòng | 1,5 | |
| | **Tổng** | **~15** | |

Owner đã chốt: **xong tới đâu áp tới đó**, không hẹn cửa sổ. Vì T1–T5 đều không chạm production, chỉ T6 là một lần bấm.

### Đối chiếu bóng (T3) — cổng bắt buộc

Bảng so sánh `4 thành viên org thật × 214 quyền × {toàn tổ chức, 21 toà, 21 sổ}` ≈ **36.000 dòng**, mỗi dòng ghi kết quả helper cũ và kết quả v3.

Điều kiện đi tiếp:
- Mọi dòng **mất quyền** phải có giải thích được owner duyệt.
- Mọi dòng **thêm quyền** phải giải thích được (hướng nguy hiểm hơn).
- p95 không xấu hơn 20%.
- Xuất bảng "ai đổi quyền gì" cho owner ký trước Ngày G.

### Ngày G — thứ tự trong một transaction

```text
1. Sao lưu định nghĩa 11 helper vào app_private.authz_v2_helper_backup
2. CREATE OR REPLACE 11 helper  → ruột gọi can_v3 / buildings_for_v3
3. CREATE OR REPLACE get_my_permissions → chiếu từ mô hình mới
4. ai_copilot_perms_for → gọi chung một nguồn (hết 2 bản sao)
5. is_admin / is_super_admin → đọc bảng platform riêng
6. Xoá dòng allowlist cuối (tài khoản demo)
7. Bump authorization_version cả 2 tổ chức → cache FE tự hỏng
8. COMMIT
9. Deploy FE: 4 màn mới + xoá StaffPage, useStaffAssignments, fallback
```

**Rollback**: chạy lại 11 định nghĩa cũ từ bảng backup + tắt cờ. Dưới 1 phút. Ngày G **không xoá dữ liệu** nên không mất gì.

### T7 — dọn xác (owner đã chốt 30 ngày)

Đổi tên `staff_assignments`, `roles`, `legacy_owner_allowlist`, `super_admins` sang `*_dropped_<ngày>`; drop trigger a80/a81; drop `authorize_v2` + 7 hàm profit chuyển sang v3. Sau 30 ngày mới `DROP TABLE` thật.

---

## 10. Kiểm thử

| Nhóm | Ca | Kỳ vọng |
|---|---|---|
| Precedence | 12 tầng × mỗi tầng 1 ca | Đúng thứ tự §2.2 |
| Phạm vi | CẤM tại toà A → thao tác tại toà B | Vẫn được phép |
| Phạm vi | CHO tại toà A → thao tác tại toà B | Bị chặn |
| Giữ sổ | Có `cashbooks.post` toàn tổ chức, không giữ sổ X | `42501` |
| Chéo tổ chức | Mọi REST/RPC/Storage giữa 2 org | Rỗng hoặc `42501` |
| Off-boarding | Đình chỉ → thử 10 thao tác | Chặn ở **cả** đường cũ và mới |
| Đồng thời | 2 người sửa cùng membership | 1 thành công, 1 nhận lỗi CAS |
| Tự nâng quyền | Tự thêm quyền cho mình | Chặn |
| Chủ cuối | Hạ chủ sở hữu duy nhất | Chặn |
| Hiệu năng | 10 truy vấn nóng | p95 ≤ baseline + 20% |
| Tiền | Đối soát trước/sau | Tổng org thật bất biến |
| **Báo cáo** *(review 2)* | Chạy lại **71 hàm** dùng helper, đặc biệt `fa_*`, `occupancy_*`, `pra_*` | Từng con số trước = sau |
| **Catalog** *(review 2)* | Mọi cặp `(resource,action)` trong policy có key trong `permission_definitions` | 0 cặp thiếu (sau khi vá `settings.create/delete`) |
| UI | Hạm đội browser: 4 vai trò × luồng chính | Không lỗi console, quyền hiển thị = quyền thật |

---

## 11. Rủi ro

| Rủi ro | Mức | Chặn bằng |
|---|---|---|
| Hiệu năng RLS xấu đi (192 policy dùng chung 1 hàm) | **Cao** | `STABLE` + CTE materialized + index; cổng p95 ở T3; sẵn phương án mảng |
| **`settings.create/delete` thiếu catalog → mất quyền cấu hình** *(review 2)* | **Cao** | §5 việc 6 — **chặn cutover nếu chưa xong** |
| **71 hàm (không chỉ policy) đổi hành vi; báo cáo có thể lệch số âm thầm** *(review 2)* | **Cao** | Chạy lại toàn bộ báo cáo tài chính/vận hành trước-sau, so từng con số ở T3 |
| Ngữ nghĩa `current_visible_owner_ids` lệch | ~~Cao~~ **Thấp** *(review 2 đo khớp 10/10, 4/4)* | Đối chiếu bóng bằng số, không suy luận |
| Vai trò "Super Admin" rỗng | ~~Cao~~ **Thấp** *(review 2: của 1 người đã có 214 quyền)* | Dọn rác ở §5 việc 1 |
| Reconcile ngoại lệ đoán sai | Trung bình | Key không map được → bảng ngoại lệ, owner duyệt tay |
| Ngày G lỗi giữa chừng | Trung bình | Một transaction + backup helper + rollback < 1 phút |
| UI mới thiếu tính năng so với màn cũ | Thấp | Đối chiếu tính năng ở T5 trước khi xoá `StaffPage` |

---

## 12. Kết quả với tiêu chí nghiệm thu §20

| # | Tiêu chí | Trước | Sau |
|---|---|---|---|
| 2 | Orphan đóng chặt | Đạt (còn allowlist) | **Đạt sạch** |
| 4 | Backend đúng action | **Chưa đạt** | **Đạt** — 337 tham chiếu qua evaluator canonical |
| 13 | Vòng đời nhân sự | Một phần | **Đạt** — mời/đình chỉ/thu hồi có UI |
| 1 | Tenant tường minh | Một phần | Một phần *(nợ NOT NULL — tranche riêng)* |
| 8 | Maker-checker | Một phần | Một phần *(auto-duyệt là quyết định owner)* |

Tổng: **6/15 đạt · 7 một phần · 1 chưa đạt · 1 khác plan có chủ đích**.
