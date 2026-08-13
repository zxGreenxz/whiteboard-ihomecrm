---
title: "Đặt cọc giữ chỗ"
description: "Nhận và đối soát cọc giữ chỗ, kiểm tra trạng thái phòng, theo dõi đủ/thiếu cọc theo hợp đồng và chuyển phiếu giữ chỗ thành hợp đồng."
routes: ["/deposits"]
permissions: [{module: deposits, action: view}]
viewport: desktop
audience: [sale, quan-ly-toa]
captured:
  date: "2026-08-13"
  commit: "ca1104137123942e27c1aa6b41147b256be59e82"
  account: demo.chunha
status: published
---

# Đặt cọc giữ chỗ

Màn **Đặt cọc** là trung tâm quản lý tiền cọc: bạn nhận cọc giữ chỗ khi khách chưa ký hợp đồng, theo dõi hợp đồng nào đã đủ hay còn thiếu cọc, xem các khoản đã hoàn/bỏ cọc và chuyển một phiếu cọc giữ chỗ thành hợp đồng. Phiếu tiền và trạng thái giữ phòng hiện được ghi ở các bước riêng; sau mỗi thao tác tiền thật phải kiểm tra cả **phiếu cọc**, **người nộp**, **phòng** và **trạng thái giữ chỗ**, không suy ra một phần thành công chỉ từ phần còn lại.

::: info Điều kiện tiên quyết
- Quyền **Đặt cọc => Xem** (module `deposits`, action `view`) để mở màn.
- Quyền **Đặt cọc => Tạo** (`deposits.create`) để bấm **Tạo đặt cọc**; quyền **Đặt cọc => Chuyển hợp đồng** (`deposits.convert`) để bấm **Tạo HĐ** từ phiếu giữ chỗ.
- Đã có **toà nhà** và **phòng** trong hệ thống, và ít nhất một **sổ quỹ thu** để tiền cọc chảy vào (xem [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/)).
- Là nhân viên, bạn chỉ thấy và thao tác cọc của các toà được gán phạm vi cho mình.
:::

## Hướng dẫn từng bước

**Bước 1**: Tại menu bên trái, ấn chọn **Đặt cọc**. Màn mở ra với **4 tab** — **Tổng quan**, **Đủ / Thiếu cọc**, **Hoàn / Bỏ cọc**, **Phiếu giữ chỗ** — cùng ô lọc toà nhà dùng chung. Snapshot production ngày 13/08/2026 của `demo.chunha` hiển thị **Cọc đang giữ = 0đ**, **Cọc cần thu = 80.000.000đ**, **Thiếu cọc = 80.000.000đ** trên **20 hợp đồng**. Mỗi toà DEMO A/B/C/D có 5 hợp đồng, cần thu 20.000.000đ và đã thu 0đ. Hai phần lịch sử giữ chỗ và hoàn/bỏ cọc chưa có dòng.

![Màn Đặt cọc với bốn tab Tổng quan, Đủ Thiếu cọc, Hoàn Bỏ cọc và Phiếu giữ chỗ](./images/buoc-01-danh-sach.webp)

**Bước 2**: Ở tab **Tổng quan**, đọc các thẻ KPI nhanh: **Cọc đang giữ** (tổng cọc đã thu của các hợp đồng đang hiệu lực), **Cọc cần thu**, **Thiếu cọc**, **Giữ chỗ chờ** (tổng tiền các phiếu cọc giữ chỗ đã duyệt), **Đã hoàn cọc** và **Đã bỏ cọc**. Bảng bên dưới gộp số liệu theo từng toà nhà.

**Bước 3**: Sang tab **Phiếu giữ chỗ** để làm việc với cọc giữ chỗ trước hợp đồng. Ba thẻ đếm phiếu theo trạng thái: **Chờ duyệt** / **Đang giữ chỗ** / **Đã huỷ**. Bảng liệt kê Mã phiếu, Nội dung, Toà nhà, Phòng, Người nộp, Số tiền, Ngày và Trạng thái.

**Bước 4**: Nhận một cọc giữ chỗ mới — trước khi mở form, xác minh phòng đang **Trống/AVAILABLE**, không có hợp đồng hiệu lực và không có phiếu cọc/giữ chỗ còn hiệu lực. Ấn **Tạo đặt cọc**, chọn **Phòng**, điền **Số tiền cọc**, **Ngày đặt cọc**, và tuỳ chọn **Giữ phòng đến**, **CTV**, **Ghi chú**. Chọn đúng **Khách/người nộp** đã được đối chiếu bằng tên, SĐT hoặc giấy tờ; không chỉ dựa vào phòng. Ấn **Lưu**, sau đó mở lại danh sách để kiểm tra phiếu và trạng thái phòng.

::: danger Tạo đặt cọc là thao tác ghi tiền vào sổ quỹ
Khi bạn lưu, hệ thống tạo **một phiếu thu cọc** cho phòng đó. Nếu số tiền lớn hơn 1đ, tiền vào **sổ thu mặc định của chính bạn** (sổ quỹ thật); nếu để trống/1đ hoặc bạn chưa có sổ thu, phiếu ghi vào **sổ ảo "CỌC (giữ hộ khách)"**. Hãy chọn đúng phòng và đúng số tiền trước khi lưu — đây là tiền thật đi vào sổ.

Việc tạo/cập nhật khách, phiếu tiền và giữ phòng không nằm trong một giao dịch nguyên tử chung. Cơ chế giữ phòng có nhánh bỏ qua lỗi để không chặn phiếu tiền, nên sau khi lưu bắt buộc xác nhận: phiếu tồn tại đúng một lần, đúng người nộp, đúng số tiền; phòng không còn AVAILABLE; không có hợp đồng/cọc sống khác cho cùng phòng. Nếu một mục sai, dừng tạo thêm phiếu và chuyển cho quản trị đối soát.
:::

::: warning Giữ phòng kỹ thuật và ngày hiển thị là hai dữ liệu khác nhau
Hệ thống có thể đặt một giữ phòng kỹ thuật trong khoảng **24 giờ** khi tạo phiếu. Ô **Giữ phòng đến** trên form hiện là thông tin mô tả, không tự gia hạn hoặc tự giải phóng giữ phòng theo ngày đó. Vì bước giữ phòng có thể thất bại mà phiếu vẫn được tạo, chỉ coi phòng đã giữ sau khi kiểm tra trạng thái thực tế. Khi huỷ phiếu cũng phải xác minh phòng đã trở lại **Trống** trước khi bán cho khách khác.
:::

**Bước 5**: Chuyển cọc giữ chỗ thành hợp đồng — với một phiếu **Đang giữ chỗ** (đã duyệt) có gắn phòng, ấn **Tạo HĐ**. Form hợp đồng mở sẵn đúng **toà** và **phòng** của phiếu. Khi hợp đồng lưu thành công, hệ thống tìm phiếu cọc chưa gắn theo phòng/thời gian để liên kết; vì định danh khách chưa được ràng buộc chắc chắn, phải kiểm tra lại phiếu nào đã rời tab và số **đã thu** của hợp đồng thuộc đúng người nộp.

::: warning Cọc mồ côi có thể gắn nhầm khách nếu chỉ trùng phòng/thời gian
Khi tạo hợp đồng, cơ chế tìm phiếu cọc chưa gắn hiện dựa chủ yếu vào **cùng phòng** và khoảng thời gian, chưa ràng buộc chắc chắn theo định danh khách chuẩn. Trước khi ký, huỷ/xử lý mọi phiếu của khách cũ còn treo và đối chiếu **người nộp/khách** của từng phiếu sẽ được gắn. Sau khi lưu, kiểm tra tab tiền cọc của hợp đồng; không tiếp tục thu nếu thấy tiền của người khác.
:::

**Bước 6**: Theo dõi đủ/thiếu cọc — sang tab **Đủ / Thiếu cọc**. Tab liệt kê các hợp đồng đang hiệu lực **chưa đủ cọc**, với **Cần thu / Đã thu / Còn thiếu**, badge trạng thái (**Thu ở HĐ đầu** nếu phần thiếu được gộp vào hoá đơn tháng đầu, hoặc **Nợ cọc**) và cột **Hẹn bổ sung**. Bật **Chỉ hiện thiếu cọc** để lọc gọn các trường hợp còn nợ cọc.

**Bước 7**: Xem các khoản đã tất toán — tab **Hoàn / Bỏ cọc** hiển thị lịch sử từ các lần thanh lý hợp đồng: **Bỏ cọc** (cọc thành doanh thu) hay **Hoàn cọc**, kèm **Cọc gốc**, **Tổng nợ tất toán** và cột **Còn nợ / Hoàn lại**. Cần thao tác hoàn/bỏ cọc chi tiết thì làm ở luồng [Hoàn / Bỏ cọc](/03-quan-ly-van-hanh/hoan-bo-coc/).

::: tip Nguồn sự thật của số cọc là phiếu thu, không phải trạng thái phiếu
Số cọc "đã thu" hiển thị trên hợp đồng được tính lại từ **các phiếu có hạng mục "Tiền cọc"** ở trạng thái `APPROVED` và gắn vào hợp đồng (`deposit_remaining` = cần thu − đã tính). Bạn không sửa số này bằng tay. Lưu ý đây là phép tính nghiệp vụ legacy theo trạng thái duyệt; khi xác nhận tiền thật đã vào quỹ vẫn phải kiểm posting `POSTED`, đúng sổ và không có reversal.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
| --- | --- |
| Ô lọc toà nhà | Chọn đúng **1 toà** hoặc **Tất cả toà nhà** (danh sách phẳng A→Z, gõ để tìm); áp cho cả 4 tab. |
| Tab **Tổng quan** | Các thẻ KPI (Cọc đang giữ, Cọc cần thu, Thiếu cọc, Giữ chỗ chờ, Đã hoàn/Đã bỏ cọc) + bảng gộp theo toà. |
| Tab **Đủ / Thiếu cọc** | Danh sách hợp đồng chưa đủ cọc; toggle **Chỉ hiện thiếu cọc**; cột Hẹn bổ sung. |
| Tab **Hoàn / Bỏ cọc** | Lịch sử hoàn/bỏ cọc từ các lần thanh lý hợp đồng. |
| Tab **Phiếu giữ chỗ** | Cọc giữ chỗ trước hợp đồng; 3 thẻ Chờ duyệt / Đang giữ chỗ / Đã huỷ. |
| Ô tìm kiếm (tab Phiếu giữ chỗ) | Tìm theo mã, nội dung, người nộp, phòng. |
| Bộ lọc trạng thái (tab Phiếu giữ chỗ) | Lọc theo Chờ duyệt / Đang giữ chỗ / Đã huỷ. |
| **Tạo đặt cọc** | Mở form tạo phiếu cọc giữ chỗ mới (cần quyền `deposits.create`). |
| **Tạo HĐ** | Chuyển một phiếu giữ chỗ đã duyệt thành hợp đồng, mở sẵn toà/phòng (cần quyền `deposits.convert`). |

Bộ lọc và tab đang mở được **giữ lại khi bạn tải lại trang (F5)**.

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Có phiếu nhưng phòng vẫn **Trống** | Đây có thể là lỗi ở bước giữ phòng riêng. Không tạo thêm phiếu và không bán phòng cho khách khác; đối chiếu phiếu, hợp đồng/cọc sống của phòng và nhờ quản trị xử lý trạng thái. |
| Cọc giữ chỗ **quá hạn** mà phòng vẫn **Đã đặt cọc** | Ô "Giữ phòng đến" chỉ là thông tin mô tả và không phải bộ hẹn giờ nhả phòng. Huỷ phiếu ở màn Thu chi khi khách bỏ, rồi **kiểm tra thực tế** phòng đã về Trống; nếu chưa, báo quản trị thay vì tự tạo giao dịch đối nghịch. |
| Không thấy nút **Sửa / Duyệt / Huỷ** phiếu trong tab Phiếu giữ chỗ | Đúng: phiếu cọc là một phiếu thu, nên **sửa/duyệt/huỷ làm ở màn Thu chi** như mọi phiếu khác. Tab này chỉ để xem và bấm **Tạo HĐ**. |
| Tạo hợp đồng xong bị báo **thiếu cọc** dù khách đã đặt cọc | Kiểm tra phiếu cọc giữ chỗ đã **duyệt** chưa và có đúng **phòng** không — trường `deposit_paid` hiện cộng phiếu `APPROVED`, nên phiếu chưa duyệt hiện dạng "chưa tính". Tuy nhiên `APPROVED` chỉ là trạng thái workflow, **không chứng minh tiền đã vào sổ**; khi đối soát tiền thật vẫn phải kiểm `posting_status=POSTED` và đúng sổ quỹ. |
| Tab **Tổng quan / Đủ-Thiếu cọc** trống dù có hợp đồng | Thường do phạm vi toà: nhân viên chỉ thấy cọc của toà được gán. Kiểm tra ô lọc toà còn dính giá trị cũ (giữ qua F5) và phân quyền toà. |
| Cọc còn **thiếu** của một hợp đồng | Có 2 cách xử lý lúc ký: **Nợ cọc** (theo dõi + nhắc bổ sung) hoặc **Thu ở HĐ đầu** (gộp phần thiếu thành hạng mục "Tiền cọc" trong hoá đơn tháng đầu). Badge ở tab Đủ/Thiếu cọc cho biết đang ở cách nào. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/deposits" app-label="Mở màn Đặt cọc" fixtures="Snapshot 13/08/2026: 20 HĐ cần thu 80.000.000đ, đã thu 0đ, còn thiếu 80.000.000đ." view-only>

Quan sát cấu trúc màn hình mà không ghi tiền:

1. Ở tab **Tổng quan**, đối chiếu ba số **0đ / 80.000.000đ / 80.000.000đ** và dòng **20 hợp đồng**.
2. Đọc bảng theo toà: mỗi toà A/B/C/D có 5 hợp đồng, cần thu 20.000.000đ, đã thu 0đ và còn thiếu 20.000.000đ.
3. Chuyển qua **Đủ / Thiếu cọc**, **Hoàn / Bỏ cọc** và **Phiếu giữ chỗ** để phân biệt nghĩa vụ cọc hợp đồng với lịch sử/phiếu giữ chỗ; không bấm **Tạo đặt cọc**.
4. Khi nghiệp vụ thật có phiếu, đối chiếu độc lập **phiếu tiền, người nộp, phòng và trạng thái giữ chỗ** như checklist ở trên.

Kết quả mong đợi: bạn phân biệt được **nghĩa vụ cọc 80 triệu** với **số đã thu 0đ**, đồng thời biết cách xác minh độc lập phiếu tiền, người nộp và trạng thái phòng khi dữ liệu phát sinh.

</SandboxTry>

## Quy trình liên quan

- [Hoàn / Bỏ cọc](/03-quan-ly-van-hanh/hoan-bo-coc/) — xử lý hoàn cọc hoặc bỏ cọc khi thanh lý hợp đồng.
- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — ký hợp đồng cho phòng và đối chiếu cọc được liên kết đúng người nộp.
- [Căn hộ / Phòng](/03-quan-ly-van-hanh/can-ho-phong/) — xem trạng thái **Đã đặt cọc** của từng phòng do cọc giữ chỗ tạo ra.
- [Khách hẹn](/03-quan-ly-van-hanh/khach-hen/) — pipeline khách tiềm năng trước khi nhận cọc.
- [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/) — nơi tiền cọc chảy vào; cấu hình sổ thu mặc định.
- [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/) — vị trí bước đặt cọc trong toàn bộ vòng đời khách thuê.
