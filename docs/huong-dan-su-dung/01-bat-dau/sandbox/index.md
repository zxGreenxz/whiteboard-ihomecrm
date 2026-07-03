---
title: Sandbox — Môi trường thực hành
description: Tài khoản demo, quy tắc thực hành và nút reset dữ liệu sandbox.
routes: []
permissions: []
viewport: desktop
status: published
---

# Sandbox — Môi trường thực hành

Tài liệu này không chỉ để đọc. Bạn có thể **đăng nhập vào app thật** bằng tài khoản demo, tự tay thao tác trên **Tòa DEMO A** và **Tòa DEMO B**, rồi bấm **Reset** để đưa mọi thứ về trạng thái gốc cho người sau. Dữ liệu demo nằm tách biệt hoàn toàn với dữ liệu kinh doanh thật — bạn không thể nhìn thấy hay làm hỏng số liệu thật.

::: tip Cách học hiệu quả nhất
Mỗi trang hướng dẫn có khối **🧪 Thử trực tiếp** ở cuối phần các bước: đọc xong thì mở app bằng tài khoản gợi ý, làm theo **bài tập thực hành**, đối chiếu **kết quả mong đợi**. Xong thì bấm Reset.
:::

## Tài khoản demo

Tất cả tài khoản đăng nhập tại <https://ptcrm.vercel.app> bằng **username** (không phải email), cùng một mật khẩu ở mục dưới.

| Tài khoản | Vai trò | Dùng khi học nhóm trang |
|---|---|---|
| `demo.chunha` | Chủ nhà (toàn quyền demo) | Phân quyền, chia lợi nhuận, báo cáo tổng, cài đặt hệ thống |
| `demo.quanly` | Quản lý tòa | Tòa/phòng, hợp đồng, ghi chỉ số, công việc |
| `demo.ketoan` | Kế toán | Hoá đơn, thu tiền, thu chi, sổ quỹ, bàn giao – đối soát |
| `demo.sale` | Sale | Khách hẹn, đặt cọc giữ chỗ, khách hàng |
| `demo.kythuat` | Kỹ thuật | Công việc, tài sản, kho vật tư |
| `demo.codong` | Cổ đông | Báo cáo phân bổ lợi nhuận (chỉ xem) |

## Mật khẩu

::: info Mật khẩu đăng nhập cho cả 6 tài khoản demo
```
Aa@0378160165
```
Mật khẩu này chỉ ghi tại trang Sandbox. Các trang hướng dẫn khác chỉ hiện username và liên kết về đây.
:::

## Quy tắc sandbox

1. **Không nhập dữ liệu thật** — tên, số điện thoại, CCCD của người thật. Dùng dữ liệu giả (Nguyễn Văn A, `0900 000 001`…).
2. **Dữ liệu dùng chung** — có thể có người khác đang thực hành cùng lúc; số liệu bạn thấy đôi khi khác bài tập.
3. **Reset ảnh hưởng mọi người** — nút Reset đưa **toàn bộ** sandbox về trạng thái gốc, xoá cả thao tác dở dang của người khác.
4. **Cooldown 10 phút** — sau một lần reset, phải chờ ~10 phút mới reset lại được.
5. **Mỗi bài tập một phòng riêng** — chỉ thao tác đúng phòng mà bài tập chỉ định, để không giẫm lên bài của người khác.

## Reset dữ liệu demo

Bấm nút dưới để đưa sandbox về trạng thái gốc (chỉ hoạt động trên bản đã xuất bản của trang tài liệu này):

<DemoResetButton />

## Bố cục dữ liệu demo

- **Tòa DEMO A** (15 phòng, 3 tầng) — các phòng ở đây minh hoạ mọi trạng thái để xem và chụp ảnh: hợp đồng lâu năm, sắp hết hạn, đã gia hạn, phòng giữ chỗ, phòng bảo trì… Nên **xem, hạn chế thao tác phá**.
- **Tòa DEMO B** (4 phòng) + vài phòng trống của Tòa A — dành cho **bài tập**: thu tiền, ghi chỉ số, ký hợp đồng, gia hạn, thanh lý…

## Câu hỏi thường gặp

**Số liệu khác với hướng dẫn?** Có thể người khác vừa thao tác. Bấm Reset rồi làm lại từ đầu.

**Tôi có thể làm hỏng dữ liệu thật không?** Không. Tài khoản demo chỉ nhìn thấy 2 tòa DEMO; toàn bộ dữ liệu khách hàng, hoá đơn, sổ quỹ thật đều bị ẩn hoàn toàn.

**Reset có xoá tài khoản demo không?** Không. Reset chỉ đưa **dữ liệu** (phòng, hợp đồng, hoá đơn…) về gốc; tài khoản đăng nhập luôn còn.
