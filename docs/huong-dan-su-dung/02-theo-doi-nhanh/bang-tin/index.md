---
title: "Bảng tin"
description: "Màn hình đầu tiên sau đăng nhập: thẻ chỉ số, biểu đồ và cảnh báo để nắm nhanh tình hình các toà nhà."
routes: ["/", "/dashboard"]
permissions: []
viewport: desktop
audience: [tat-ca]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Bảng tin

Bảng tin là màn hình mở đầu, tự động hiện ngay sau khi bạn đăng nhập trên máy tính. Trang gom các thẻ chỉ số (KPI), biểu đồ và danh sách cảnh báo để bạn nắm nhanh tình hình cho thuê mà không cần vào từng nghiệp vụ. Dùng trang này mỗi đầu ngày để soát phòng trống, công nợ, hợp đồng sắp hết hạn và các việc cần xử lý.

::: info Điều kiện tiên quyết
- Đã đăng nhập bằng tài khoản có quyền vào hệ thống (xem [Đăng nhập](/01-bat-dau/dang-nhap/)).
- Có ít nhất một toà nhà và phòng để bảng tin có số liệu (xem [Tạo khu vực & toà nhà](/01-bat-dau/tao-toa-nha/)).
- Muốn thấy các thẻ tài chính (doanh thu tháng, công nợ) thì tài khoản cần quyền **dashboard.view_finance**. Không có quyền này thì hai thẻ tiền sẽ được ẩn.
:::

## Hướng dẫn từng bước

**Bước 1**: Sau khi đăng nhập, bạn ở ngay màn hình **Bảng tin**. Đọc hàng thẻ chỉ số ở đầu trang: **Tổng số căn**, **Đang thuê** (kèm % lấp đầy), **Phòng trống** (đã trừ phòng đã cọc giữ chỗ), **Doanh thu tháng** (kèm số hợp đồng mới trong tháng) và **Công nợ** (kèm số việc chưa xử lý).

![Bảng tin với các thẻ chỉ số, biểu đồ và danh sách cảnh báo](./images/buoc-01-tong-quan.webp)

**Bước 2**: Ở góc trên, mở bộ lọc **Toà nhà** rồi ấn chọn một toà (ví dụ **Tòa DEMO A**). Các thẻ phần phòng (tổng căn, đang thuê, trống, % lấp đầy), doanh thu, công nợ và biểu đồ sẽ tính lại theo toà bạn chọn. Bộ lọc là ô gõ-để-tìm, gõ tên toà để lọc nhanh.

**Bước 3**: Kéo xuống khu biểu đồ để xem xu hướng: **Doanh thu** theo tháng, **Lấp đầy** (biểu đồ này còn tách riêng phần **Đã cọc** khi có phòng giữ chỗ) và **Công nợ**. Biểu đồ giúp bạn so sánh nhanh giữa các tháng gần đây.

**Bước 4**: Xem danh sách **Cảnh báo** bên cạnh. Trang gom sẵn: hoá đơn quá hạn, hợp đồng sắp hết hạn (còn ≤ 30 ngày), việc khẩn quá 24 giờ chưa xử lý và hợp đồng còn thiếu cọc. Ấn một dòng cảnh báo để đi thẳng tới hoá đơn hoặc hợp đồng tương ứng.

**Bước 5**: Xem khối **Hoạt động gần đây** (hợp đồng mới, phiếu thu, việc mới trong 7 ngày) và khu **Báo cáo & Phân tích** ở cuối trang. Ấn một thẻ trong khu này để mở nhóm báo cáo bất động sản hoặc tài chính chuyên sâu.

::: tip
Bộ lọc **Toà nhà** được giữ nguyên khi bạn tải lại trang (F5) hoặc quay lại sau, nên bạn không phải chọn lại toà mỗi lần vào Bảng tin.
:::

::: info Bảng tin trên điện thoại
Khi mở trên điện thoại, thay vì Bảng tin bạn sẽ gặp màn hình **HomeLauncher** — lưới các ô chức năng để bạn bấm vào từng nghiệp vụ. Bảng tin đầy đủ (thẻ chỉ số + biểu đồ) là màn hình dành cho máy tính.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
|---|---|
| **Toà nhà** (bộ lọc) | Lọc số liệu phần phòng, doanh thu, công nợ và biểu đồ theo một toà; giữ lựa chọn qua F5 |
| Thẻ **Phòng trống** | Ấn vào để mở hộp thoại **Danh sách phòng trống**, tô màu theo số ngày trống; ấn tiếp một dòng để mở trang phòng đó |
| Danh sách **Cảnh báo** | Ấn một dòng để đi tới hoá đơn quá hạn hoặc hợp đồng sắp hết hạn / thiếu cọc |
| Khối **Hoạt động gần đây** | Xem nhanh hợp đồng, phiếu thu, việc mới phát sinh trong 7 ngày |
| Khu **Báo cáo & Phân tích** | Ba thẻ điều hướng sang nhóm báo cáo bất động sản, tài chính và công việc |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
|---|---|
| Không thấy thẻ **Doanh thu tháng** và **Công nợ** | Tài khoản chưa có quyền **dashboard.view_finance**; nhờ chủ nhà/quản trị cấp quyền xem tài chính |
| Số **Phòng trống** ít hơn dự đoán | Phòng đang giữ chỗ bằng cọc được xếp vào nhóm **Đã cọc**, không tính là trống; xem phần "Đã cọc" trên biểu đồ lấp đầy |
| Chọn toà nhưng **Hợp đồng mới**, **Việc chưa xử lý**, cảnh báo và hoạt động không đổi | Đúng theo thiết kế: các mục này hiển thị toàn hệ thống, chưa lọc theo toà; chỉ phần phòng, doanh thu, công nợ và biểu đồ mới đổi theo bộ lọc |
| Bảng tin trống trơn, mọi số bằng 0 | Chưa có toà/phòng/hợp đồng, hoặc tài khoản nhân viên chưa được gán phạm vi toà nào; kiểm tra dữ liệu và phân quyền phạm vi |
| Số liệu chưa cập nhật ngay sau khi thu tiền | Thẻ chỉ số tự làm mới mỗi phút; chờ một nhịp hoặc tải lại trang |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/dashboard" view-only>

**Bạn sẽ nhìn thấy**

- Quan sát các thẻ chỉ số của 2 toà **DEMO**: tổng căn, đang thuê, phòng trống, doanh thu tháng và công nợ.
- Đổi bộ lọc **Toà nhà** giữa **Tòa DEMO A** và **Tòa DEMO B** để thấy phần phòng, doanh thu và biểu đồ tính lại theo từng toà.
- Đăng nhập lại bằng tài khoản **demo.ketoan** và mở cùng màn hình để thấy thẻ tài chính ẩn/hiện thay đổi theo quyền **dashboard.view_finance**.

</SandboxTry>

## Quy trình liên quan

- [Làm quen giao diện](/01-bat-dau/lam-quen-giao-dien/)
- [Sơ đồ toà nhà](/02-theo-doi-nhanh/so-do-toa-nha/)
- [Thông báo](/02-theo-doi-nhanh/thong-bao/)
- [Việc của tôi](/02-theo-doi-nhanh/viec-cua-toi/)
