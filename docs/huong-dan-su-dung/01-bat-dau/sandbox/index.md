---
title: Sandbox — Môi trường thực hành
description: Tài khoản demo, phạm vi dữ liệu hiện hành, quy tắc thực hành và reset snapshot.
routes: []
permissions: []
viewport: desktop
captured:
  date: "2026-10-07"
  commit: "81c5a3cdf03740321061db919a40991c772bd4b4"
  account: demo.chunha
  manifest: null
audience: [chu-nha, quan-ly-toa, ke-toan, sale, ky-thuat, co-dong]
status: published
---

# Sandbox — Môi trường thực hành

Sandbox production là tổ chức **DEMO** tách biệt dữ liệu công ty thật. Snapshot thiết kế có **4 toà** — `DEMO Toà A`, `DEMO Toà B`, `DEMO Toà C`, `DEMO Toà D` — mỗi toà ít nhất 10 phòng, cùng khách hàng, hợp đồng, hoá đơn và phiếu thu chi để thực hành các luồng liên quan.

::: info Số liệu đo ngày 07/10/2026
Đăng nhập `demo.chunha` thấy **44 phòng** (16 đang thuê, 24 trống), **40 hợp đồng**, **17 hoá đơn**, **27 khách hàng** và **83 phiếu thu chi**. Sổ cọc, chỉ số điện nước và tài sản hiện **trống**; bảng tin ghi 0 hợp đồng sắp hết hạn trong 30 ngày. Vì dữ liệu dùng chung và thời gian trôi, một số trạng thái của snapshot (giữ chỗ, sắp hết hạn) có thể không còn — đây là trạng thái dữ liệu, không phải lỗi màn hình.
:::

::: tip Cách học hiệu quả
Mỗi trang có khối **Thử trực tiếp**. Đọc điều kiện/quyền trước, mở app bằng tài khoản gợi ý, đối chiếu kết quả rồi chỉ reset khi thật sự cần.
:::

## Tài khoản demo

Đăng nhập tại <https://ptcrm.vercel.app> bằng username và mật khẩu do trang Sandbox đã xuất bản hoặc quản trị viên cung cấp.

| Tài khoản | Vai trò / phạm vi hiện hành | Dùng khi học |
|---|---|---|
| `demo.chunha` | Chủ tổ chức DEMO | Thành viên, vai trò, báo cáo tổng, cài đặt. |
| `demo.quanly` | Quản lý DEMO Toà A + B | Toà/phòng, hợp đồng, chỉ số, công việc trong A+B. |
| `demo.quanly2` | Quản lý DEMO Toà C + D | Kiểm tra phân tách phạm vi C+D. |
| `demo.ketoan` | Kế toán, phạm vi tổ chức | Hoá đơn, thu tiền, thu chi, sổ quỹ, đối soát. |
| `demo.sale` | Sale, phạm vi tổ chức | Khách hẹn, cọc giữ chỗ, khách hàng. |
| `demo.kythuat` | Kỹ thuật, phạm vi tổ chức | Việc của tôi, kiểm tra nhà, tài sản/kho. |
| `demo.codong` | Cổ đông, phạm vi tổ chức | Báo cáo phân bổ lợi nhuận được cấp. |

## Mật khẩu

::: info Nguồn mật khẩu
Mật khẩu demo có thể được thay khi làm mới snapshot. Dùng mật khẩu đang hiển thị trên bản Sandbox đã xuất bản hoặc mật khẩu quản trị viên cung cấp; không sao chép mật khẩu từ tài liệu cũ/cache.
:::

## Quy tắc sandbox

1. **Không nhập dữ liệu thật** — không dùng tên, số điện thoại, CCCD hoặc email của người thật.
2. **Dữ liệu dùng chung** — người khác có thể đang thao tác, nên số liệu có thể thay đổi giữa hai lần mở.
3. **Tôn trọng phạm vi** — `demo.quanly` chỉ A+B, `demo.quanly2` chỉ C+D; đây là dữ liệu để kiểm chứng RLS, không phải lỗi thiếu toà.
4. **Reset ảnh hưởng mọi người** — reset toàn snapshot DEMO, không chỉ dữ liệu của tài khoản đang dùng.
5. **Cooldown 10 phút** — database chặn reset liên tiếp trong khoảng 10 phút.

## Reset dữ liệu demo

<DemoResetButton />

Reset khôi phục **snapshot đang được phát hành**, không khôi phục mô hình cũ 2 toà. Nếu snapshot hoặc tripwire kiểm tra không hợp lệ, reset sẽ fail closed thay vì ghi dữ liệu nửa chừng. Reset dữ liệu không xoá tài khoản Auth/profile DEMO.

## Bố cục dữ liệu demo

- 4 toà, mỗi toà ≥10 phòng (44 phòng).
- Khi vừa reset, các trạng thái phòng đang thuê, sắp hết hạn, giữ chỗ, trống, bảo trì được tạo bằng dữ liệu hợp đồng/cọc thật; theo thời gian hợp đồng hết hạn và thao tác của người dùng chung sẽ làm số liệu lệch khỏi snapshot.
- `demo.quanly` và `demo.quanly2` tạo hai lát cắt phạm vi không chồng lấn để kiểm tra phân quyền theo toà.
- Tài khoản kỹ thuật/kế toán/sale/cổ đông có phạm vi tổ chức nhưng capability khác nhau, vì phạm vi không thay thế quyền thao tác.

## Câu hỏi thường gặp

**Số liệu khác hướng dẫn?** Có thể người khác vừa thao tác. Chỉ reset khi không có bài thực hành đang dùng chung và cooldown đã hết.

**Tôi chỉ thấy 2 toà?** Kiểm tra tài khoản: hai tài khoản quản lý cố ý chỉ thấy A+B hoặc C+D. Chủ/kỹ thuật/kế toán/sale/cổ đông có phạm vi tổ chức theo cấu hình demo hiện hành.

**Reset có xoá tài khoản demo không?** Không. Reset khôi phục dữ liệu snapshot và giữ Auth/profile.

**Reset báo lỗi?** Chờ hết cooldown; nếu vẫn lỗi, snapshot/tripwire có thể đang fail closed và cần quản trị viên xử lý.
