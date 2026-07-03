---
title: "Sinh hoá đơn hàng loạt"
description: "Phát hành hoá đơn cho cả một toà trong một lần: mỗi phòng một dòng, chỉ số kéo sẵn, tự gộp nợ cũ và cọc thiếu, làm tròn về bội số 1.000đ."
routes: ["/invoices"]
permissions: [{module: invoices, action: create}]
viewport: desktop
audience: [ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Sinh hoá đơn hàng loạt

Khi đến kỳ ra hoá đơn, bạn không cần tạo từng hoá đơn một. Màn **Hoá đơn** có hộp thoại **Sinh hoá đơn hàng loạt** dạng bảng (Excel): chọn **một toà** và **một kỳ**, hệ thống liệt kê mỗi phòng đang có hợp đồng hiệu lực thành **một dòng**, kéo sẵn chỉ số điện/nước và tiền phòng theo hợp đồng để bạn chỉ việc nhập **chỉ số mới** rồi phát hành cả loạt. Đây là cách nhanh nhất để ra hoá đơn cho cả toà mỗi đầu tháng.

::: info Điều kiện tiên quyết
- Quyền **Hoá đơn => Tạo** (module `invoices`, action `create`).
- Đã có **hợp đồng đang hiệu lực** cho các phòng cần ra hoá đơn (chỉ hợp đồng còn hiệu lực mới lên bảng).
- Đã cấu hình **đơn giá điện/nước và dịch vụ** cho toà/hợp đồng (xem [Dịch vụ & định mức](/01-bat-dau/dich-vu-dinh-muc/)) để hệ thống tự tính tiền.
- Nên **ghi chỉ số** đầu kỳ trước cho các phòng — phòng chưa từng có chỉ số sẽ không kéo được số cũ và sẽ báo khi bạn nhập số mới (xem [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/)).
- Là nhân viên, bạn chỉ sinh được hoá đơn cho các toà thuộc phạm vi được gán.
:::

## Hướng dẫn từng bước

**Bước 1**: Tại menu bên trái, ấn chọn **Hoá đơn**. Trên thanh công cụ đầu trang, ấn nút mở **Sinh hoá đơn hàng loạt** (bảng dạng Excel).

![Màn Hoá đơn — nơi mở hộp thoại sinh hoá đơn hàng loạt dạng bảng Excel](./images/buoc-01-danh-sach.webp)

**Bước 2**: Chọn **Toà nhà** và **Kỳ** (tháng hoá đơn, dạng `YYYY-MM`). Mỗi lần chạy chỉ sinh cho **một toà** — muốn ra cho toà khác thì làm lại. Sau khi chọn, bảng tự nạp: **mỗi phòng đang có hợp đồng hiệu lực = một dòng**.

**Bước 3**: Kiểm tra từng dòng. Với mỗi phòng bạn thấy **Tiền phòng** (lấy theo hợp đồng), **chỉ số điện/nước đầu kỳ** đã kéo sẵn từ lần ghi gần nhất (carry-forward), và các ô để nhập **chỉ số mới**. Khi bạn nhập chỉ số mới, hệ thống tự tính: tiền điện = (số mới − số cũ) × đơn giá, tiền nước, và các **dịch vụ theo hợp đồng** (rác, gửi xe, v.v.).

::: tip Nhập chỉ số ở đây là đã "chốt số" luôn
Mỗi phòng bạn nhập chỉ số mới, hệ thống vừa tính tiền điện cho hoá đơn **vừa lưu luôn một bản ghi chỉ số** (chốt vào ngày cuối kỳ) để kỳ sau tự carry-forward. Bạn không phải vào màn Ghi chỉ số nhập lại lần nữa.
:::

**Bước 4**: Xem các khoản tự gộp vào tổng. **Nợ cũ kỳ trước** của phòng được **tự cộng vào tổng** hoá đơn mới (kèm truy nguồn để khi thu đủ sẽ tự tất toán hoá đơn nợ gốc). Với **hoá đơn tháng đầu** của hợp đồng mới còn thiếu cọc, phần **cọc còn thiếu tự trở thành một hạng mục "Tiền cọc"** ngay trong hoá đơn tháng đầu. Bạn cũng có thể nhập **khuyến mãi / giảm trừ** cho từng phòng.

::: tip Cọc gộp trong hoá đơn tháng đầu — và không lẫn vào doanh thu
Cọc còn thiếu được đưa vào hoá đơn tháng đầu như một hạng mục **"Tiền cọc"** (chỉ với hợp đồng ký ở chế độ "Đóng đủ"; ký ở chế độ "Nợ cọc" thì không gộp, chỉ theo dõi nợ cọc). Về sau khi bạn thu hoá đơn này, phần cọc được **tách thành một hạng mục riêng** (đánh dấu cọc, `is_deposit`) và **không được tính vào Kết quả kinh doanh (KQKD)** — cọc là tiền giữ hộ khách, không phải doanh thu.
:::

**Bước 5**: Đối chiếu tổng. Tổng mỗi hoá đơn = **tạm tính (tiền phòng + điện + nước + dịch vụ) − giảm trừ + nợ cũ kỳ trước**, sau đó **làm tròn về bội số 1.000đ**: phần lẻ dưới 900đ làm tròn xuống, từ 900đ trở lên làm tròn lên. Vì vậy tổng lưu lại có thể lệch tối đa vài trăm đồng so với khi bạn cộng tay — đây là làm tròn cố ý ngay lúc lập hoá đơn để khách không phải trả tiền lẻ.

**Bước 6**: Ấn nút phát hành để **sinh cả loạt**. Hệ thống chạy **tuần tự từng phòng**, mỗi phòng tạo một hoá đơn và (nếu có nhập chỉ số) chốt luôn bản ghi chỉ số điện.

::: danger Sinh hàng loạt là phát hành hoá đơn thật — không có bước duyệt lại
Hoá đơn sinh ra được **đặt thẳng trạng thái Đã duyệt (APPROVED), sẵn sàng thu tiền** — không qua bước duyệt thủ công. Đồng thời mỗi phòng có nhập chỉ số sẽ **chốt số điện** vào hệ thống. Hãy kiểm tra kỹ **đúng toà, đúng kỳ, đúng chỉ số mới** trước khi ấn phát hành. Nếu ra nhầm, bạn phải vào từng hoá đơn để **Huỷ** (chỉ hoá đơn chưa thu tiền mới huỷ/sửa được).
:::

::: warning Chạy tuần tự — đừng đóng tab giữa chừng, và phòng chưa ghi chỉ số sẽ báo
Việc phát hành lặp qua từng phòng và **chưa xong ngay lập tức**. **Đừng đóng tab hay chuyển trang khi đang chạy** — nếu ngắt giữa chừng, một số phòng đã có hoá đơn, số còn lại thì chưa. Mở lại hộp thoại và chạy tiếp: những phòng **đã có hoá đơn cùng kỳ sẽ được bỏ qua**, nên bạn không tạo trùng. Phòng **chưa từng ghi chỉ số** (không có số cũ để trừ) sẽ **được báo** để bạn xử lý trước.
:::

## Các tính năng khác trên màn hình

| Nút / Cột | Công dụng |
| --- | --- |
| Chọn **Toà nhà** | Chọn đúng **một toà** để sinh hoá đơn; mỗi lần chạy chỉ cho một toà. |
| Chọn **Kỳ** | Tháng hoá đơn (`YYYY-MM`); mỗi hợp đồng chỉ có **một hoá đơn còn hiệu lực / kỳ**. |
| Bảng **mỗi phòng một dòng** | Liệt kê các phòng đang có hợp đồng hiệu lực của toà đã chọn. |
| Cột **Chỉ số cũ** (điện/nước) | Kéo sẵn từ lần ghi gần nhất (carry-forward) — chỉ đọc. |
| Cột **Chỉ số mới** | Bạn nhập; hệ thống tự tính tiền điện/nước và chốt luôn bản ghi chỉ số. |
| Cột **Tiền phòng / Dịch vụ** | Lấy theo hợp đồng và dịch vụ đã cấu hình. |
| **Nợ cũ kỳ trước** | Tự gộp vào tổng của phòng còn nợ; khi thu đủ sẽ tự tất toán hoá đơn nợ gốc. |
| Hạng mục **"Tiền cọc"** | Cọc còn thiếu tự gộp vào hoá đơn tháng đầu (hợp đồng mới, chế độ Đóng đủ). |
| **Khuyến mãi / Giảm trừ** | Nhập khoản giảm cho từng phòng trước khi phát hành. |
| Nút **Phát hành / Sinh** | Chạy tuần tự tạo hoá đơn (Đã duyệt) + chốt chỉ số cho cả loạt. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Phòng **không lên bảng** dù có khách | Chỉ phòng có **hợp đồng đang hiệu lực** mới lên; kiểm tra hợp đồng đã ký/còn hiệu lực chưa. |
| Báo **phòng chưa có chỉ số cũ** | Phòng chưa từng ghi chỉ số nên không có số để trừ — vào [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/) nhập chỉ số đầu cho phòng đó rồi sinh lại. |
| Phòng **bị bỏ qua**, không tạo hoá đơn | Phòng đã có **hoá đơn cùng kỳ** rồi (mỗi hợp đồng chỉ một hoá đơn còn hiệu lực / kỳ). Muốn làm lại phải huỷ hoá đơn cũ trước. |
| Lỡ **đóng tab** khi đang chạy | Một số phòng đã có hoá đơn, số còn lại chưa. Mở lại hộp thoại, chọn đúng toà/kỳ và chạy tiếp — phòng đã có hoá đơn tự được bỏ qua, không trùng. |
| Toast đỏ **"Chưa lưu được chỉ số điện"** | Hoá đơn **vẫn được tạo** nhưng bản ghi chỉ số của phòng đó chưa lưu; vào [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/) bổ sung để kỳ sau carry-forward đúng. |
| Tổng **lệch vài trăm đồng** so với cộng tay | Do làm tròn tổng về bội số 1.000đ (dưới 900đ tròn xuống, từ 900đ tròn lên) — đúng thiết kế. |
| Hợp đồng mới còn **thiếu cọc** | Nếu ký ở chế độ **Đóng đủ**, phần thiếu tự gộp thành hạng mục "Tiền cọc" trong hoá đơn tháng đầu; nếu ký **Nợ cọc** thì không gộp, chỉ theo dõi nợ cọc riêng (xem [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/)). |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.ketoan" app-path="/invoices" app-label="Mở màn Hoá đơn" fixtures="hoá đơn tháng 7 đã sinh cho A/B">

Thực hành xem quy trình sinh hoá đơn cả một toà (chỉ xem, không cần phát hành — dữ liệu demo đã có sẵn hoá đơn tháng 7):

1. Ở màn **Hoá đơn**, mở hộp thoại **Sinh hoá đơn hàng loạt** (dạng bảng Excel).
2. Chọn **Toà DEMO A** và **Kỳ** tháng 7 (`2026-07`). Quan sát bảng hiện **mỗi phòng một dòng** cho A101–A105.
3. Để ý mỗi dòng đã **kéo sẵn chỉ số điện/nước cũ** và **Tiền phòng** theo hợp đồng; ô **Chỉ số mới** để trống chờ bạn nhập.
4. Vì các phòng của Toà DEMO A đã có hoá đơn tháng 7, chúng hiện ở trạng thái **đã có hoá đơn / sẽ bỏ qua** — đây là cơ chế chống tạo trùng. **Đừng phát hành lại** trong bài tập này; chỉ quan sát cấu trúc bảng.

Kết quả mong đợi: bạn hiểu quy trình sinh hoá đơn cho cả toà — mỗi phòng một dòng, chỉ số cũ kéo sẵn, chỉ nhập số mới là ra được cả loạt hoá đơn, và phòng đã có hoá đơn cùng kỳ được tự bỏ qua.

</SandboxTry>

## Quy trình liên quan

- [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/) — ghi chỉ số điện/nước đầu kỳ để bảng sinh hoá đơn kéo số cũ chính xác.
- [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/) — danh sách, lọc, tìm và các thao tác trên hoá đơn sau khi sinh.
- [Chi tiết hoá đơn](/03-quan-ly-van-hanh/hoa-don-chi-tiet/) — xem/sửa/huỷ một hoá đơn, in và mã QR công khai.
- [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) — thu tiền cho hoá đơn đã phát hành; phần cọc được tách khỏi doanh thu khi thu.
- [Dịch vụ & định mức](/01-bat-dau/dich-vu-dinh-muc/) — cấu hình đơn giá điện/nước và dịch vụ mà bảng sinh hoá đơn dùng để tính tiền.
- [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) — cọc còn thiếu gộp vào hoá đơn tháng đầu.
- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — nguồn tiền phòng, dịch vụ và tình trạng cọc của mỗi phòng.
- [Quy trình thu tiền](/01-bat-dau/quy-trinh-thu-tien/) — vị trí bước sinh hoá đơn trong toàn bộ chu kỳ thu tiền.
