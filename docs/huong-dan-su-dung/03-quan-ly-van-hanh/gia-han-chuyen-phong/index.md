---
title: "Gia hạn & chuyển phòng"
description: "Gia hạn hợp đồng đang hiệu lực (giữ trạng thái ACTIVE) và chuyển khách sang phòng khác cùng hoặc khác toà, xử lý chênh giá thuê và tiền cọc."
routes: ["/contracts/:id"]
permissions: [{module: contracts, action: edit}]
viewport: desktop
audience: [quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Gia hạn & chuyển phòng

Trang này hướng dẫn hai thao tác biến động hợp đồng thường gặp nhất: **gia hạn** khi hợp đồng sắp hết hạn nhưng khách muốn ở tiếp, và **chuyển phòng** khi khách đổi sang một phòng khác (cùng toà hoặc khác toà). Cả hai đều mở ngay từ **trang chi tiết hợp đồng**, chạy tức thì và tự ghi lại lịch sử — bạn không cần lập hợp đồng mới.

::: info Điều kiện tiên quyết
- Quyền **Hợp đồng => Sửa** (module `contracts`, action `edit`) trên toà của hợp đồng.
- Hợp đồng phải **đang hiệu lực** (trạng thái **ACTIVE**). Riêng **Gia hạn** còn bật cho hợp đồng **sắp hết hạn** hoặc **đã quá hạn**; **Chuyển phòng** chỉ bật khi hợp đồng còn hiệu lực.
- Muốn chuyển phòng: phải có sẵn **phòng trống** ở toà đích (phòng đang có khách hoặc đang giữ cọc sẽ không hiện trong danh sách chọn).
- Là nhân viên, bạn chỉ thao tác được trên hợp đồng thuộc toà được gán phạm vi cho mình.
:::

::: warning Gia hạn KHÔNG đổi trạng thái hợp đồng
Khi gia hạn, hợp đồng **giữ nguyên trạng thái ACTIVE** — hệ thống chỉ đẩy **ngày kết thúc** ra xa hơn và ghi một dòng vào lịch sử gia hạn. Mô hình cũ (đổi sang trạng thái "EXTENDED") **đã bỏ từ 2026-06-06**. Vì vậy đừng tìm một trạng thái riêng cho hợp đồng đã gia hạn: dấu hiệu **"Đã gia hạn"** là một chip xanh dương suy ra từ lịch sử gia hạn, hiển thị cạnh trạng thái ở đầu trang chi tiết.
:::

## Hướng dẫn từng bước

**Bước 1**: Mở **trang chi tiết** hợp đồng cần xử lý — từ menu **Hợp đồng**, ấn vào dòng hợp đồng trong danh sách. Trên đầu trang chi tiết, khi hợp đồng còn hiệu lực bạn sẽ thấy các nút thao tác vòng đời: **Gia hạn**, **Chuyển phòng**, **Nhượng HĐ**, **Đăng ký chuyển đi**, **Thanh lý**.

![Trang chi tiết hợp đồng — nơi mở nút Gia hạn và Chuyển phòng](./images/buoc-01-chi-tiet.webp)

### Gia hạn hợp đồng

**Bước 2**: Ấn **Gia hạn**. Hộp thoại **Gia hạn hợp đồng** mở ra, hiển thị sẵn **Ngày kết thúc hiện tại** (chỉ đọc) để bạn đối chiếu.

**Bước 3**: Điền **Ngày kết thúc mới** (bắt buộc) — phải muộn hơn ngày kết thúc hiện tại. Nếu muốn đổi giá hoặc cọc, điền **Giá thuê mới** và **Tiền cọc mới**; để trống hai ô này thì hệ thống **giữ nguyên** giá và cọc cũ. Thêm **Ghi chú** nếu cần, rồi ấn **Gia hạn**.

**Bước 4**: Hệ thống cập nhật ngày kết thúc (và giá/cọc nếu bạn có nhập), nối một ghi chú `[Gia hạn]` vào hợp đồng, đồng thời ghi một dòng vào **lịch sử gia hạn**. Kiểm tra lại: hợp đồng vẫn ở trạng thái **ACTIVE**, ngày kết thúc đã lùi ra, và chip **"Đã gia hạn"** xuất hiện cạnh trạng thái ở đầu trang.

::: tip Số tháng gia hạn được tính tự động
Bạn chỉ cần chọn **ngày kết thúc mới**; hệ thống tự suy ra số tháng gia hạn từ khoảng cách so với ngày kết thúc cũ và lưu vào lịch sử. Muốn gia hạn thêm 6 tháng, chỉ việc đặt ngày kết thúc mới muộn hơn khoảng 6 tháng.
:::

### Chuyển phòng

**Bước 5**: Quay lại trang chi tiết, ấn **Chuyển phòng**. Hộp thoại **Chuyển phòng** hiện một khung tóm tắt tình trạng hiện tại: **Khách hàng**, **Toà nhà**, **Phòng** và **Giá thuê hiện tại**.

**Bước 6**: Chọn **Toà nhà mới** (bắt buộc). Chọn đúng toà đang đứng để **chuyển phòng trong cùng toà**, hoặc chọn một toà khác để **chuyển sang toà khác**. Sau đó chọn **Phòng mới** — danh sách chỉ liệt kê **phòng đang trống** của toà vừa chọn.

**Bước 7**: Nếu phòng mới có giá khác, điền **Giá thuê mới** (để trống thì giữ nguyên giá cũ). Chọn **Ngày chuyển** (mặc định là hôm nay), thêm **Ghi chú** nếu cần, rồi ấn **Chuyển phòng**.

**Bước 8**: Hệ thống chuyển hợp đồng sang phòng mới, cập nhật giá thuê (nếu có nhập), nối ghi chú, và ghi một dòng vào **lịch sử chuyển phòng**. Trạng thái hợp đồng **giữ nguyên ACTIVE**. **Phòng cũ tự về Trống**, **phòng mới thành Đang thuê**.

::: warning Chuyển phòng có hiệu lực ngay và khó hoàn tác
Ngay khi bạn ấn **Chuyển phòng**, phòng cũ được giải phóng về **Trống** và phòng mới bị chiếm thành **Đang thuê**. Không có nút "hoàn tác": nếu chuyển nhầm, bạn phải mở lại **Chuyển phòng** và chuyển ngược về phòng cũ (khi phòng cũ vẫn còn trống). Hãy kiểm tra kỹ toà và phòng đích trước khi xác nhận.
:::

::: tip Tiền cọc đi theo hợp đồng, không phải theo phòng
Chuyển phòng **không** hoàn hay thu lại cọc — cọc vẫn thuộc chính hợp đồng đó. Nếu phòng mới cần mức cọc khác, hãy điều chỉnh mức cọc khi **gia hạn** hoặc xử lý riêng theo quy trình cọc; đừng kỳ vọng thao tác chuyển phòng tự tính chênh lệch cọc. Cọc của hệ thống luôn truy nguồn từ phiếu thu cọc thực tế, nên số cọc chỉ đổi khi có phiếu thu/chi cọc tương ứng.
:::

## Các tính năng khác trên màn hình

| Nút / Ô nhập | Công dụng |
| --- | --- |
| **Gia hạn** (header chi tiết) | Mở hộp thoại gia hạn; bật khi hợp đồng đang hiệu lực, sắp hết hạn hoặc đã quá hạn. |
| **Chuyển phòng** (header chi tiết) | Mở hộp thoại chuyển phòng; chỉ bật khi hợp đồng còn hiệu lực. |
| Ô **Ngày kết thúc hiện tại** | Chỉ đọc — hiển thị mốc kết thúc đang áp dụng để bạn đối chiếu trước khi gia hạn. |
| Ô **Ngày kết thúc mới** | Bắt buộc khi gia hạn; phải muộn hơn ngày kết thúc hiện tại. |
| Ô **Giá thuê mới** / **Tiền cọc mới** | Tuỳ chọn; để trống thì giữ nguyên giá/cọc cũ (cả khi gia hạn lẫn chuyển phòng). |
| Ô **Toà nhà mới** | Chọn toà đích khi chuyển phòng — cùng toà hoặc khác toà đều được. |
| Ô **Phòng mới** | Chỉ liệt kê phòng đang **Trống** của toà đã chọn. |
| Ô **Ngày chuyển** | Mốc chuyển phòng, mặc định là ngày hiện tại. |
| Ô **Ghi chú** | Ghi chú kèm theo, được nối vào phần ghi chú của hợp đồng. |
| Chip **"Đã gia hạn"** | Dấu hiệu ở đầu trang chi tiết cho biết hợp đồng đã từng gia hạn (suy từ lịch sử gia hạn). |
| Tab **Lịch sử** | Xem lại các lần gia hạn / chuyển phòng / thanh lý của hợp đồng theo dòng thời gian. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Không thấy nút **Gia hạn** / **Chuyển phòng** | Nút chỉ hiện khi hợp đồng còn hiệu lực (và với gia hạn thì cả khi sắp/đã hết hạn). Hợp đồng đã **Thanh lý** thì không còn hai nút này. Nhân viên ngoài phạm vi toà bấm vào sẽ bị hệ thống từ chối (lỗi quyền). |
| Gia hạn báo lỗi ngày kết thúc | **Ngày kết thúc mới** phải muộn hơn ngày kết thúc hiện tại. Lỗi này chỉ hiện qua thông báo sau khi ấn **Gia hạn**, nên hãy kiểm tra lại ngày trước khi bấm. |
| Ô **Phòng mới** trống rỗng, không có phòng để chọn | Toà đích chưa có phòng nào **Trống**. Chọn toà khác, hoặc giải phóng/duyệt xong một phòng trước (phòng đang có khách hoặc đang giữ cọc không hiện ở đây). |
| Đã gia hạn nhưng trạng thái vẫn là **ACTIVE** | Đúng thiết kế — gia hạn **giữ nguyên ACTIVE**. Hãy nhìn chip **"Đã gia hạn"** ở đầu trang chi tiết và ngày kết thúc mới để xác nhận, đừng tìm một trạng thái "đã gia hạn" riêng. |
| Danh sách **Hợp đồng** chưa hiện dấu "đã gia hạn" | Chip **"Đã gia hạn"** hiện tại chỉ hiển thị ở **đầu trang chi tiết**, chưa hiển thị ngoài danh sách. Mở chi tiết hợp đồng để xem. |
| Chuyển nhầm phòng | Mở lại **Chuyển phòng** và chuyển ngược về phòng cũ (nếu phòng cũ vẫn còn trống). Không có nút hoàn tác tự động. |
| Sau chuyển phòng, phòng cũ vẫn báo **Đang thuê** | Kiểm tra lại phòng cũ có còn hợp đồng hiệu lực nào khác không. Với thao tác chuyển phòng chuẩn, phòng cũ tự về **Trống** ngay khi xác nhận. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/contracts" app-label="Mở danh sách Hợp đồng" fixtures="A103 sắp hết hạn (gia hạn), A104 đã gia hạn (xem kết quả)">

Thực hành gia hạn và quan sát dấu "đã gia hạn":

1. Mở chi tiết hợp đồng phòng **A103** (khách **Nguyễn Văn C**, hợp đồng **sắp hết hạn**). Ghi nhớ **Ngày kết thúc hiện tại**.
2. Ấn **Gia hạn**, điền **Ngày kết thúc mới** muộn hơn khoảng **6 tháng**, rồi ấn **Gia hạn**.
3. Kiểm tra: ngày kết thúc đã lùi ra, hợp đồng **vẫn ở trạng thái ACTIVE**, và chip **"Đã gia hạn"** xuất hiện cạnh trạng thái.
4. Mở chi tiết hợp đồng phòng **A104** (khách **Phạm Thị Dung**, **đã gia hạn**) để thấy sẵn chip **"Đã gia hạn"** — một hợp đồng đã gia hạn trông như thế nào.

Kết quả mong đợi: bạn hiểu rằng gia hạn chỉ đẩy ngày kết thúc và gắn dấu "đã gia hạn", còn **hợp đồng vẫn giữ trạng thái ACTIVE**.

</SandboxTry>

## Quy trình liên quan

- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — danh sách hợp đồng, nơi cũng mở được Gia hạn / Chuyển phòng cho từng dòng.
- [Chi tiết hợp đồng](/03-quan-ly-van-hanh/hop-dong-chi-tiet/) — trang chi tiết 5 tab, gốc mở các thao tác vòng đời và xem tab Lịch sử.
- [Hoàn / bỏ cọc](/03-quan-ly-van-hanh/hoan-bo-coc/) — xử lý tiền cọc khi kết thúc hoặc bỏ cọc hợp đồng.
- [Căn hộ / Phòng](/03-quan-ly-van-hanh/can-ho-phong/) — trạng thái phòng tự đổi theo hợp đồng: phòng cũ về Trống, phòng mới thành Đang thuê.
- [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/) — vòng đời khách thuê từ đặt cọc, ký hợp đồng đến gia hạn và thanh lý.
