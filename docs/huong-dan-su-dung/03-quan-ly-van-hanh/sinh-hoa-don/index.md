---
title: "Sinh hoá đơn hàng loạt"
description: "Rà soát và phát hành hóa đơn cho nhiều hợp đồng trong cùng tòa/kỳ, với kết quả từng dòng rõ ràng."
routes: ["/invoices"]
permissions: [{module: invoices, action: view}, {module: invoices, action: create}]
viewport: desktop
audience: [ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Sinh hoá đơn hàng loạt

Luồng sinh hàng loạt giúp phát hành hóa đơn cho nhiều phòng trong một tòa và kỳ. Bạn cần quyền xem và tạo hóa đơn.

## Trước khi sinh

1. Chốt chỉ số và các dữ liệu dịch vụ của kỳ.
2. Lọc danh sách hóa đơn theo đúng tòa/kỳ để phát hiện hóa đơn đã tồn tại.
3. Kiểm tra hợp đồng còn hiệu lực và thông tin phòng.
4. Xác định các trường hợp ngoại lệ cần tạo lẻ thay vì đưa vào lô.

## Các bước thực hiện

**Bước 1**: Tại **Hoá đơn**, chọn **Sinh hoá đơn** và chọn tòa, kỳ cần phát hành.

![Màn Hoá đơn — nơi mở hộp thoại sinh hoá đơn hàng loạt](./images/buoc-01-danh-sach.webp)

**Bước 2**: Rà từng dòng xem trước: hợp đồng, phòng, kỳ, hạn thanh toán và các khoản tính tiền. Sửa dữ liệu nguồn nếu một dòng sai; không phát hành rồi mới dùng chứng từ tài chính để bù một lỗi tính hóa đơn.

**Bước 3**: Bỏ chọn các dòng chưa sẵn sàng và xác nhận lô.

**Bước 4**: Đọc kết quả từng dòng, sau đó lọc lại danh sách theo tòa/kỳ để kiểm tra hóa đơn đã tạo và các dòng bị lỗi.

::: warning Trạng thái sau khi tạo
Writer chuẩn hiện tạo hóa đơn ở trạng thái **APPROVED**. Thiết lập **Tự động duyệt hóa đơn** chưa điều khiển writer này, vì vậy phải kiểm tra trạng thái thực tế thay vì suy đoán từ cấu hình.
:::

## Khi lô có lỗi

- Không bấm sinh lại toàn bộ ngay; trước hết xác định dòng nào đã thành công.
- Lọc theo hợp đồng và kỳ để tránh tạo trùng.
- Sửa dữ liệu nguồn của các dòng lỗi rồi chỉ chạy lại phần còn thiếu.
- Với một trường hợp riêng lẻ, dùng chức năng tạo hóa đơn lẻ.

## Sau khi phát hành

- Mở mẫu một số hóa đơn để đối chiếu dòng tiền và hạn thanh toán.
- Dùng [Lịch thanh toán](/04-bao-cao/lich-thanh-toan/) như báo cáo hỗ trợ, nhưng lưu ý các giới hạn dữ liệu của báo cáo đó.
- Khi khách thanh toán, dùng [Thu tiền tại hóa đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) hoặc [Thu tiền tại phòng](/03-quan-ly-van-hanh/thu-tien-mobile/).

## Quy trình liên quan

- [Hoá đơn — danh sách & tạo lẻ](/03-quan-ly-van-hanh/hoa-don/)
- [Chi tiết, in hoá đơn & QR tra cứu](/03-quan-ly-van-hanh/hoa-don-chi-tiet/)
- [Lịch thanh toán](/04-bao-cao/lich-thanh-toan/)
