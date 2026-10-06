---
title: "Tài sản"
description: "Quản lý tài sản/nội thất: khai báo tài sản theo loại, gắn phòng, theo dõi tình trạng, lập phiếu di chuyển, phiếu bảo trì và biên bản bàn giao theo hợp đồng."
routes: ["/assets"]
permissions: [{module: assets, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-10-07"
  commit: "81c5a3cdf03740321061db919a40991c772bd4b4"
  account: demo.chunha
status: published
---

# Tài sản

Màn **Quản lý Tài sản** là sổ quản lý toàn bộ nội thất và tài sản cố định của bạn: máy lạnh, tủ lạnh, giường, bàn ghế… Mỗi món là một dòng, có **loại tài sản**, **tình trạng**, **giá trị**, **số lượng** và **vị trí** (toà nhà + căn hộ). Dùng màn này khi cần biết một phòng đang có những đồ gì, theo dõi món nào đã cũ/hỏng cần thay, ghi lại việc chuyển đồ giữa các phòng, lập phiếu sửa chữa hay làm biên bản giao/nhận tài sản khi khách vào/ra.

Toàn bộ nghiệp vụ tài sản gom trong một màn với ba tab: **Danh sách tài sản**, **Lịch sử di chuyển** và **Lịch sử sửa chữa**. Từ đây bạn tạo tài sản mới, lập phiếu di chuyển, phiếu bảo trì và biên bản bàn giao theo hợp đồng.

::: info Điều kiện tiên quyết
- Quyền **Tài sản => Xem** (module `assets`, action `view`) để mở màn danh sách.
- Quyền **Tạo** trên module `assets` để thêm tài sản; quyền **Di chuyển tài sản** (`assets.move`) và **Tạo phiếu bảo trì / sửa chữa** (`assets.maintain`) cho hai thao tác tương ứng.
- Nút **Biên bản bàn giao** dùng quyền **Bàn giao** của module hợp đồng (`contracts.handover`), không phải quyền `assets`.
- Đã có **toà nhà** và **phòng** trong hệ thống để gắn vị trí tài sản, và có sẵn **loại tài sản** (xem [Loại tài sản](/05-cai-dat/loai-tai-san/)). Biên bản bàn giao cần có **hợp đồng** để chọn.
- Là nhân viên, bạn chỉ thấy/sửa tài sản thuộc các **toà được gán phạm vi** cho mình; tài sản chưa gắn toà thì cần quyền cấp tổ chức mới sửa được.
:::

## Hướng dẫn từng bước

**Bước 1**: Tại menu bên trái, mở **Danh mục dữ liệu** => **Tài sản**. Màn **Quản lý Tài sản** hiện hàng nút thao tác (**Di chuyển**, **Bảo trì**, **Biên bản bàn giao**, **Tạo tài sản** — hiện theo quyền), 4 thẻ thống kê (**Tổng số tài sản** / **Giá trị tổng** / **Tốt / Mới** / **Hỏng / Kém**), ba tab, ô **Tìm kiếm theo tên, mã, loại...** và các bộ lọc **Tất cả toà nhà**, **Tất cả căn hộ**, **Tất cả loại**, **Tình trạng**. Bảng có các cột **Mã TS**, **Tên tài sản**, **Loại**, **Số lượng**, **Giá trị**, **Tình trạng**, **Vị trí**, **Nhà cung cấp**, **Ngày mua**, **Thao tác**. Ảnh chụp ngày 07/10/2026 của tài khoản DEMO: **chưa có tài sản nào** (các thẻ đều 0, bảng báo "Không tìm thấy tài sản nào").

![Màn Quản lý Tài sản DEMO đang trống: bốn nút Di chuyển, Bảo trì, Biên bản bàn giao, Tạo tài sản, bốn thẻ thống kê bằng 0, ba tab và các bộ lọc](./images/buoc-01-danh-sach.webp)

**Bước 2**: Muốn thêm tài sản, ấn **Tạo tài sản** để mở hộp thoại **Tạo tài sản mới**. Điền các trường:

- **Tên tài sản \*** và **Loại tài sản \*** — ví dụ "Máy lạnh Daikin", loại "Điện lạnh".
- **Số lượng \*** (mặc định 1), **Tình trạng \*** (**Mới / Tốt / Khá / Kém / Hỏng**, mặc định **Tốt**), **Giá mua \***.
- Tuỳ chọn thêm: **Mã tài sản**, **Nhà cung cấp**, **Ngày mua**, **Tòa nhà**, **Căn hộ**, **Mô tả**.

Điền xong ấn **Tạo tài sản**. Tài sản mới xuất hiện ngay trong danh sách và cả trong tab **Tài sản** ở trang chi tiết của phòng bạn gắn.

![Hộp thoại Tạo tài sản mới với các ô Mã tài sản, Tên tài sản, Loại tài sản, Nhà cung cấp, Số lượng, Tình trạng, Giá mua, Ngày mua, Tòa nhà, Căn hộ, Mô tả và nút Tạo tài sản](./images/buoc-02-form-tao.webp)

**Bước 3**: Cần chỉnh, ấn **Sửa** trên dòng tài sản để mở **Chỉnh sửa tài sản**, đổi thông tin (giá trị ở ô **Giá trị (VNĐ)**) rồi bấm **Lưu thay đổi**. Muốn bỏ một món (thanh lý, nhập nhầm…), ấn **Xoá** — món đó được ẩn khỏi danh sách. **Tình trạng** của tài sản do bạn **tự cập nhật tay** qua nút Sửa; hệ thống không tự đổi tình trạng.

**Bước 4**: Muốn ghi lại việc chuyển một món sang phòng khác, ấn **Di chuyển** để mở hộp thoại **Di chuyển tài sản**. Chọn **Tài sản \***, **Từ căn hộ** (vị trí hiện tại), **Đến căn hộ \***, nhập **Số lượng \***, **Ngày di chuyển \*** và **Lý do**, rồi lưu. Phiếu được ghi vào tab **Lịch sử di chuyển** (cột **Ngày**, **Tài sản**, **Từ**, **Đến**, **Số lượng**, **Lý do**).

**Bước 5**: Cần ghi nhận sửa chữa/bảo trì, ấn **Bảo trì** để mở **Tạo phiếu bảo trì**. Điền **Tài sản \***, **Mô tả công việc \***, **Ngày bảo trì \***, tuỳ chọn **Chi phí (VNĐ)**, **Phân công cho**, **Ghi chú** và **Trạng thái \*** (**Chờ xử lý / Đang xử lý / Hoàn thành**), rồi bấm **Tạo phiếu bảo trì**. Phiếu vào tab **Lịch sử sửa chữa** (cột **Ngày**, **Tài sản**, **Mô tả**, **Người xử lý**, **Chi phí**, **Trạng thái**, **Ghi chú**).

Ô **Chi phí** trên phiếu bảo trì chỉ là thông tin theo dõi của tài sản. Nó không tự tạo phiếu chi, không làm giảm sổ quỹ công ty và không tự vào báo cáo tài chính; nếu đã trả tiền sửa chữa, hãy ghi khoản chi riêng ở [Thu chi](/03-quan-ly-van-hanh/thu-chi/) — khoản đó chỉ thành tiền ra sổ quỹ khi phiếu chi được ghi sổ (**Đã Chi**).

**Bước 6**: Khi khách nhận hoặc trả căn hộ, ấn **Biên bản bàn giao** để mở **Biên bản bàn giao tài sản**. Chọn **Hợp đồng \*** (theo số hợp đồng), **Loại \*** (**Nhận căn hộ** khi khách vào / **Trả căn hộ** khi khách ra), **Ngày \***, điền ô **Danh sách tài sản (JSON) \*** rồi ấn **Tạo biên bản**.

::: warning Ô "Danh sách tài sản (JSON)" là ô chữ thô
Biên bản bàn giao hiện **chưa có bảng chọn tài sản**: ô **Danh sách tài sản (JSON)** nhận nguyên văn nội dung bạn gõ (mẫu gợi ý `{"items":[]}`) và lưu đúng như vậy. Hãy ghi rõ, nhất quán các món bàn giao trong ô này.
:::

::: warning Phiếu di chuyển chỉ ghi lịch sử — không tự đổi vị trí tài sản
Lập phiếu **Di chuyển** chỉ ghi lại một dòng lịch sử; nó **không tự cập nhật** vị trí (toà/phòng) của tài sản trong danh sách. Muốn tài sản hiển thị đúng ở phòng mới, sau khi tạo phiếu bạn hãy vào **Sửa** món đó và đổi lại **Toà nhà** / **Căn hộ**. Ngoài ra ô **Số lượng** trên phiếu di chuyển không tự trừ/cộng vào số lượng của tài sản — nó chỉ là con số ghi nhận.
:::

::: warning Phiếu bảo trì và biên bản bàn giao chưa sửa lại được sau khi tạo
Sau khi tạo, phiếu bảo trì **giữ nguyên trạng thái** bạn chọn lúc đầu — giao diện chưa có nút đổi trạng thái từ **Chờ xử lý** sang **Đang xử lý** / **Hoàn thành**, nên hãy chọn đúng trạng thái ngay khi tạo. Biên bản bàn giao cũng **chưa có màn xem lại** danh sách đã lập; hãy kiểm tra kỹ **Hợp đồng** và **Loại** trước khi lưu.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
| --- | --- |
| Ô **Tìm kiếm theo tên, mã, loại...** | Tìm nhanh theo **tên**, **mã** hoặc **loại tài sản**; áp ngay vào danh sách. |
| Bộ lọc **Tất cả toà nhà** / **Tất cả căn hộ** / **Tất cả loại** / **Tình trạng** | Thu hẹp danh sách theo toà, phòng, loại hoặc tình trạng. Các bộ lọc và ô tìm kiếm được giữ lại khi tải lại trang (F5). |
| Thẻ **Tổng số tài sản** | Đếm số món đang có (theo danh sách đã lọc). |
| Thẻ **Giá trị tổng** | Tổng giá trị = giá mua × số lượng của các món đang lọc. |
| Thẻ **Tốt / Mới** và **Hỏng / Kém** | Gộp nhanh số món theo nhóm tình trạng để biết bao nhiêu đồ còn tốt, bao nhiêu đồ đã xuống cấp. |
| Tab **Lịch sử di chuyển** | Xem lại các phiếu di chuyển đã lập. |
| Tab **Lịch sử sửa chữa** | Xem lại các phiếu bảo trì/sửa chữa đã lập. |
| **Tạo tài sản** / **Di chuyển** / **Bảo trì** / **Biên bản bàn giao** | Mở các hộp thoại tương ứng (hiện theo quyền của bạn). |
| **Sửa** / **Xoá** | Chỉnh thông tin hoặc ẩn (xoá mềm) một tài sản. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Không thấy nút **Tạo tài sản** / **Di chuyển** / **Bảo trì** | Thiếu quyền tương ứng (`assets.create` / `assets.move` / `assets.maintain`). Nhờ quản trị bật quyền cho tài khoản. |
| Không thấy nút **Biên bản bàn giao** | Nút này dùng quyền **Bàn giao** của module hợp đồng (`contracts.handover`), không phải quyền tài sản. |
| Danh sách trống dù chắc chắn có tài sản | Thường do phạm vi: nhân viên chỉ thấy tài sản thuộc toà được gán. Cũng nên kiểm tra ô tìm kiếm và bộ lọc còn dính giá trị cũ (bộ lọc giữ qua F5). |
| Đã lập phiếu **Di chuyển** nhưng tài sản vẫn hiện ở phòng cũ | Đúng hiện trạng: phiếu chỉ ghi lịch sử. Vào **Sửa** tài sản và đổi lại **Toà nhà** / **Căn hộ** để cập nhật vị trí. |
| Không thấy **Loại tài sản** cần dùng trong ô chọn | Màn [Loại tài sản](/05-cai-dat/loai-tai-san/) hiện chỉ là trang giữ chỗ, chưa thêm loại mới trên giao diện được; liên hệ quản trị bổ sung loại trước khi tạo tài sản. |
| Hộp thoại báo chưa tải đủ dữ liệu, các ô bị khoá | Bấm **Tải lại dữ liệu** trong hộp thoại; hộp thoại chỉ cho lưu khi danh sách nguồn (loại, toà, phòng, nhà cung cấp…) đã tải xong. |
| Ô **Phân công cho** trong phiếu bảo trì chỉ có tên mình | Đúng hiện trạng: ô này chỉ lấy hồ sơ của chính bạn. Ghi thêm người thực hiện vào ô **Ghi chú** nếu cần. |
| Không đổi được trạng thái phiếu bảo trì đã tạo | Giao diện chưa có nút đổi trạng thái sau khi tạo. Hãy chọn đúng **Trạng thái** ngay lúc lập phiếu. |
| Tình trạng ở chi tiết phòng hiển thị khác với màn Tài sản | Tab **Tài sản** ở trang chi tiết phòng dùng cách hiển thị riêng; số liệu chuẩn về tình trạng và giá trị hãy xem tại màn **Tài sản** này. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/assets" app-label="Mở màn Tài sản" fixtures="Ảnh chụp 07/10/2026: DEMO chưa có tài sản nào." view-only>

Quan sát trạng thái trống mà không tạo dữ liệu:

1. Mở tab **Danh sách tài sản**, đọc bốn thẻ thống kê (đều bằng 0) và xác nhận bảng báo "Không tìm thấy tài sản nào".
2. Mở **Lịch sử di chuyển** và **Lịch sử sửa chữa** để kiểm tra trạng thái trống của từng tab.
3. (Tuỳ chọn) Bấm **Tạo tài sản** để xem các ô trong hộp thoại, rồi bấm **Hủy** — không bấm **Tạo tài sản** trong hộp thoại.

Kết quả mong đợi: bạn nhận diện đúng trạng thái trống và biết các điều kiện dữ liệu cần có trước khi tạo tài sản, di chuyển hoặc bảo trì.

</SandboxTry>

## Quy trình liên quan

- [Căn hộ / Phòng](/03-quan-ly-van-hanh/can-ho-phong/) — nơi gắn vị trí tài sản; trang chi tiết phòng có tab **Tài sản** liệt kê đồ trong phòng.
- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — hợp đồng thuê, dùng để chọn khi lập **Biên bản bàn giao** tài sản.
- [Toà nhà](/03-quan-ly-van-hanh/toa-nha/) — quản lý toà; phạm vi toà quyết định tài sản nào bạn thấy và sửa được.
- [Loại tài sản](/05-cai-dat/loai-tai-san/) — trạng thái danh mục loại tài sản.
- [Kho vật tư](/03-quan-ly-van-hanh/kho-vat-tu/) — vật tư tiêu hao (bóng đèn, vòi nước…), khác với tài sản có giá trị.
