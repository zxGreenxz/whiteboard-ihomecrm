---
title: "Bảng tra quyền nhanh"
description: "Catalog 231 quyền hiện hành, cách tính quyền hiệu lực theo RBAC V3, route canonical, runtime flag, scope và các quyền nhạy cảm về tiền."
routes: []
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-08-13"
  account: demo
status: published
---

# Bảng tra quyền nhanh

Catalog frontend và registry quyền production hiện khớp **231 khoá quyền**. Snapshot production ngày 13/08/2026 cho thấy vai trò Chủ công ty có đủ 231 quyền và OpenClaw Zalo đang xuất hiện trên sidebar; bộ chọn có thể ẩn hoặc hiện 8 khoá OpenClaw theo runtime của deployment. Catalog cho biết **quyền nào tồn tại**; việc một người có mở được trang và thao tác được hay không còn phụ thuộc membership, vai trò, scope, override, runtime flag và kiểm tra RLS/RPC phía server.

## Quyền hiệu lực trong RBAC V3

Một yêu cầu chỉ thành công khi tất cả lớp liên quan đều cho phép:

1. **Membership** — tài khoản là thành viên active của đúng organization.
2. **Vai trò (`organization_roles`)** — chứa các permission key `ALLOW` và có thể có `DENY`.
3. **Role binding** — gán vai trò cho membership.
4. **Scope của binding** — organization, khu vực, toà hoặc sổ quỹ phải khớp tài nguyên đang thao tác.
5. **Override của thành viên** — ngoại lệ `ALLOW`/`DENY` theo key và scope; khi cùng áp dụng, **DENY thắng**.
6. **Guard/RLS/RPC** — route, component và database đều có thể kiểm lại quyền/phạm vi.
7. **Runtime flag** — quyền tồn tại không có nghĩa route đã được phát hành trong build.

::: warning Sửa vai trò khác với sửa “mẫu” legacy
Vai trò hiện hành là gói quyền dùng chung thật. **Sửa một vai trò tự tạo ảnh hưởng ngay mọi thành viên đang mang vai trò đó**; màn `/settings/roles` hiển thị số người bị ảnh hưởng trước khi lưu. Vai trò hệ thống là chỉ đọc; muốn tuỳ biến, hãy **nhân bản** thành vai trò mới rồi gán lại có chủ đích.
:::

### Cách xử lý khi “có quyền nhưng vẫn không làm được”

Kiểm theo đúng thứ tự: membership active → vai trò → binding → scope → override `DENY` → runtime flag → RLS/RPC. Với sổ quỹ, cần kiểm thêm người giữ sổ; với phiếu tiền, quyền **duyệt** và quyền **ghi sổ** là hai năng lực khác nhau.

## Ba mức hiển thị trong bộ chọn quyền

| Mức | Dùng để nhóm | Lưu ý |
|---|---|---|
| **Xem** (`view`) | Mở trang, đọc dữ liệu, xem báo cáo. | Một số báo cáo có key riêng cho từng tab. |
| **Quản lý** (`manage`) | Tạo, sửa, xoá, in, xuất hoặc thao tác vận hành. | Mỗi action là một key độc lập; không suy rằng có một key quản lý thì tự có mọi key khác. |
| **Nhạy cảm** (`elevated`) | Duyệt, ghi/đảo tiền, chốt sổ, thanh lý, chia lợi nhuận, phân quyền hoặc thao tác rủi ro cao. | Chỉ cấp theo nguyên tắc tối thiểu cần thiết và đúng scope. |

## Catalog quyền theo trang

Các bảng dưới dùng đúng key `module.action`. Route là route canonical mà catalog và Copilot dùng để nhận diện trang.

### Tổng quan

| Trang · route | Quyền hiện hành |
|---|---|
| **Bảng tin** · `/` | `dashboard.view` — xem bảng tin; `dashboard.view_finance` — xem doanh thu/công nợ trên dashboard. |
| **AI Copilot** · `/` | `ai_copilot.view` — dùng chat; `ai_copilot.ui_control` — cho AI điều hướng/lọc/điền form ở chế độ experimental. Quyền chưa đủ: còn entitlement và kill switch server. |
| **Thông báo** · `/notifications` | `notifications.view`, `notifications.create`, `notifications.edit`, `notifications.delete`. |
| **Sơ đồ toà nhà** · `/building-map` | `buildings.view`. |

### Kênh chat

| Trang · route | Quyền hiện hành |
|---|---|
| **Chat Zalo** · `/chat-zalo` | `chat_zalo.view`, `chat_zalo.send`, `chat_zalo.manage_automation`, `chat_zalo.manage_templates`. |
| **OpenClaw Zalo cá nhân** · `/openclaw-zalo` | `openclaw_zalo.view`, `send`, `manage_connections`, `manage_automation`, `manage_knowledge`, `manage_handoff`, `manage_operations`, `audit`. Runtime code mặc định `off`, nhưng deployment production được kiểm tra ngày 13/08/2026 đang bật bề mặt này; quyền vẫn được kiểm tra riêng. |

### Bất động sản

| Trang · route | Quyền hiện hành |
|---|---|
| **Toà nhà & Khu vực** · `/buildings` | `buildings.view/create/edit/delete`; `areas.view/create/edit/delete`. |
| **Căn hộ / Phòng** · `/apartments` | `rooms.view/create/edit/delete`. |
| **Dịch vụ** · `/services` | `services.view/create/edit/delete`. |
| **Sale Phòng** · `/sale-phong` | `sale_phong.view`, `edit`, `manage_tokens`, `manage_settings`, `manage_images`, `edit_floor_plan`, `manage_pass_listings`, `create_deposit`, `view_analytics`. `create_deposit` là quyền nhạy cảm. |

### Khách hàng & hợp đồng

| Trang · route | Quyền hiện hành |
|---|---|
| **Khách hẹn** · `/leads` | `leads.view/create/edit/delete/convert/export`. |
| **Đặt cọc** · `/deposits` | `deposits.view/create/edit/delete/convert/refund/print`. Quyền refund bao gồm hoàn/bỏ cọc theo luồng được phép. |
| **Hợp đồng** · `/contracts` | `contracts.view/create/edit/delete/approve/renew/transfer/terminate/handover/print/export`. `approve` và `terminate` là nhạy cảm. |
| **Cư dân** · `/customers` | `customers.view/create/edit/delete/import/print/export`. Đây là dữ liệu cấp tổ chức; không mặc định giới hạn theo một toà. |
| **Phương tiện** · `/vehicles` | `vehicles.view/create/edit/delete`. |

### Tài chính vận hành

| Trang · route | Quyền hiện hành |
|---|---|
| **Sổ quỹ** · `/finance/cashbooks` | `cashbooks.view/create/edit/delete/share`; `cashbooks.manage_custody` — giao/nhận người giữ sổ; `cashbooks.post` — ghi sổ; `cashbooks.close` — đề nghị chốt/bàn giao; `cashbooks.close_confirm` — xác nhận nhận bàn giao và khoá vĩnh viễn. Bốn key cuối là quyền nhạy cảm độc lập. |
| **Ghi chỉ số** · `/meter-readings` | `meter_readings.view/create/edit/delete/export`. |
| **Hoá đơn** · `/invoices` | `invoices.view/create/edit/delete/approve/cancel/record_payment/print/export`. `approve` là nhạy cảm; `record_payment` cho phép ghi nhận thanh toán nhưng posting vẫn bị server/sổ kiểm lại. |
| **Thu tiền mobile** · `/thu-tien` | `thu_tien.view`, `thu_tien.collect`, `thu_tien.undo`, `thu_tien.report`. Các route báo cáo debt cũ đều chuyển hướng về trang này. |
| **Thu chi** · `/income-expense` | `income_expenses.view/create/edit/delete/approve/cancel/print/export/all_buildings/restricted_create/restricted_view/reverse/self_approve_within_limit`; thêm `approvals.emergency_override`. Các key `approve`, `all_buildings`, `restricted_*`, `reverse`, `self_approve_within_limit` và `emergency_override` là nhạy cảm. |
| **Tiền thừa** · `/reports/finance/overpayment` | `excess_amounts.view/create/edit/delete`. Lưu ý báo cáo hiện còn tính theo chênh lệch hoá đơn, không phải credit lot authoritative. |

::: danger Duyệt, ghi sổ và đảo bút toán là ba quyền khác nhau
`income_expenses.approve` chỉ quyết định workflow. Ghi tiền cần `cashbooks.post` cùng quyền/scope giữ sổ phù hợp. Đảo một posting đã hiệu lực cần `income_expenses.reverse`; hệ thống sinh bút toán ngược và giữ phiếu gốc, không xoá lịch sử.
:::

### Cổ đông & tài chính cá nhân

| Trang · route | Quyền hiện hành |
|---|---|
| **Lợi nhuận cổ đông** · `/reports/finance/profit-distribution` | `shareholder_profit.view/lock/unlock/distribute/manage_shareholders/pay_manager/export`. `pay_manager` là quyền chi lương quản lý từ kỳ lợi nhuận đã chốt. `/finance/shareholder-profit` chỉ là route chuyển hướng. |
| **Bảng lương quản lý** · `/finance/salary` | `salary.view/lock/unlock/distribute/manage_salary/export`. Route không bọc `RequirePermission` cố định vì trang tự rẽ admin/self-view; server/RLS vẫn giới hạn dữ liệu và action. |
| **Ví thu chi cá nhân** · `/finance/personal-wallet` | `personal_finance.view/create/edit/delete`. |

### Tài sản & kho

| Trang · route | Quyền hiện hành |
|---|---|
| **Tài sản** · `/assets` | `assets.view/create/edit/delete/move/maintain`. |
| **Vật tư** · `/materials` | `materials.view/create/edit/delete`. |
| **Loại tài sản** · `/settings/categories/asset-types` | `asset_types.view/create/edit/delete`. |
| **Kho** · `/settings/categories/warehouses` | `warehouses.view/create/edit/delete`. |
| **Nhà cung cấp** · `/settings/categories/suppliers` | `suppliers.view/create/edit/delete`. |

### Vận hành

| Trang · route | Quyền hiện hành |
|---|---|
| **Trung tâm mạng** · `/network-center` | `network_center.view`, `network_center.execute`. Route mặc định không được dựng khi `VITE_NETWORK_CENTER_MODE` là `off`; đây là bề mặt nội bộ/runtime-gated. |
| **Công việc** · `/tasks` | `tasks.view/create/edit/delete/complete/approve`. `tasks.complete` tách khỏi CRUD; `tasks.approve` là quyền duyệt/nghiệm thu nhạy cảm. |
| **Loại công việc** · `/settings/categories/task-types` | `task_types.view/create/edit/delete`. |

### Báo cáo

| Trang · route | Quyền hiện hành |
|---|---|
| **Báo cáo BĐS** · `/reports/real-estate` | `reports_real_estate.view`, `vacant_rooms`, `expiring`, `renewals_transfers`, `occupancy`, `promotions`, `new_leases`, `terminations`, `expense_ratio`, `export`. Mỗi báo cáo có key xem riêng. |
| **Báo cáo tài chính** · `/reports/finance` | `reports_finance.view`, `analysis`, `daily_cashbook`, `cash_flow`, `profit_distribution`, `payment_schedule`, `overpayment`, `deposits_report`, `handover_report`, `reconcile`, `collection_cycle`, `export`. Hai key debt legacy không còn xuất hiện trong UI cấu hình mới. |

### Cấu hình hệ thống

| Trang · route | Quyền hiện hành |
|---|---|
| **Đồng hồ / Công tơ** · `/settings/meters` | `meters.view/create/edit/delete`. |
| **Định mức dịch vụ** · `/settings/categories/service-quotas` | `service_quotas.view/create/edit/delete`. |
| **Gạch nợ tự động** · `/settings/categories/auto-debt` | `auto_debt.view/create/edit/delete`. |
| **Hotline** · `/settings/categories/hotlines` | `hotline.view/create/edit/delete`. |
| **Danh mục khác** · `/settings/categories` | `categories.view/create/edit/delete`. |
| **Biểu mẫu / Chữ ký** · `/settings/templates` | `templates.view/create/edit/delete`. |
| **Cài đặt chung** · `/settings/general` | `settings.view/create/edit/delete`; xoá là quyền nhạy cảm. |
| **Phân quyền nhân viên** · `/settings/members` | `users.view/create/edit/delete/manage_templates`. Toàn bộ nhóm được xếp nhạy cảm. `/settings/staff` là route cũ chuyển hướng; vai trò nằm ở `/settings/roles`. |

## Các tình huống thường gặp

| Tình huống | Cách hiểu và xử lý |
|---|---|
| Có key `view` nhưng không thấy dữ liệu của một toà | Scope binding không bao gồm toà đó, hoặc RLS lọc theo phạm vi. |
| Có quyền duyệt phiếu nhưng không có nút Thu/Chi | Duyệt và posting tách nhau; kiểm `cashbooks.post`, custody và scope sổ. |
| Có quyền OpenClaw nhưng không thấy route | Kiểm runtime của deployment/tổ chức hiện tại; code mặc định có thể `off`, còn production ngày 13/08/2026 đang hiển thị route. |
| Có quyền Network Center nhưng route 404/không hiện | Runtime Network Center đang off hoặc build không ở mode production/demo phù hợp. |
| Sửa vai trò rồi nhiều người đổi quyền | Đúng mô hình V3: họ dùng chung vai trò. Muốn thay đổi riêng một người, chỉnh binding/scope/override hoặc tạo vai trò khác. |
| Cấp quyền lương nhưng nhân viên chỉ thấy lương mình | `/finance/salary` tự rẽ theo năng lực và cấu hình; RLS không cho xem toàn bộ chỉ vì route mở được. |
| Không thấy báo cáo công nợ cũ | Các route debt đã chuyển về `/thu-tien`; dùng quyền `thu_tien.*`. |
| Đã ALLOW nhưng vẫn bị chặn | Tìm override hoặc role `DENY`; `DENY` thắng, sau đó kiểm scope và server guard. |

## Thực hành an toàn

<SandboxTry account="demo.chunha" app-path="/settings/members" app-label="Mở Thành viên" view-only>

Chỉ xem trên sandbox:

1. Mở một thành viên để xem các vai trò, scope và quyền hiệu lực.
2. Sang `/settings/roles`, mở một vai trò hệ thống để thấy trạng thái chỉ đọc và số thành viên đang mang vai trò.
3. Không lưu thay đổi nếu bạn chỉ đang đối chiếu; mục tiêu là nhận ra quyền đến từ **vai trò + phạm vi + ngoại lệ**, không phải một danh sách tick phẳng.

</SandboxTry>

## Quy trình liên quan

- [Phân quyền theo trang](/05-cai-dat/phan-quyen/)
- [Nhân viên & Đội ngũ](/05-cai-dat/nhan-vien-doi-ngu/)
- [Thêm nhân viên](/01-bat-dau/them-nhan-vien/)
- [Thuật ngữ & bảng trạng thái](/07-thong-tin-khac/thuat-ngu/)
- [Kênh hỗ trợ](/07-thong-tin-khac/kenh-ho-tro/)
