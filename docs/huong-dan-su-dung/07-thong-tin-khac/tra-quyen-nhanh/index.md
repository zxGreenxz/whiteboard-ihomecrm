---
title: "Bảng tra quyền nhanh"
description: "Bảng tra cứu nhanh quyền theo trang: mỗi module × chức năng ứng với mức Xem / Quản lý / Nhạy cảm, kèm cách hoạt động của mô hình phân quyền và phạm vi toà."
routes: []
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Bảng tra quyền nhanh

Trang này là **bảng tra cứu** để bạn nắm nhanh: mỗi trang (module) trong phần mềm có những **chức năng** nào, và mỗi chức năng thuộc **mức quyền** nào — **Xem**, **Quản lý** hay **Nhạy cảm**. Dùng bảng này khi bạn thiết kế mẫu phân quyền cho nhân viên, khi rà soát xem một người đang được cấp gì, hoặc khi muốn hiểu vì sao ai đó "thấy được nhưng không thao tác được".

Phần mềm quản lý quyền theo **hai chiều tách rời**: **quyền** (làm được *việc gì*) và **phạm vi toà** (làm được *ở toà nào*). Bảng bên dưới chỉ nói về chiều **quyền**; chiều **phạm vi toà** được giải thích riêng ở mục [Hai chiều kiểm soát](#hai-chieu-kiem-soat-quyen-x-pham-vi). Để thực sự cấp/chỉnh các quyền này, bạn vào màn hình **Phân quyền** — xem [Phân quyền theo trang](/05-cai-dat/phan-quyen/).

::: info Cách đọc trang này
- Danh mục quyền được tổ chức **theo từng trang** của phần mềm (gần **40 trang**, chia thành **10 nhóm**: Bất động sản, Khách & Hợp đồng, Hoá đơn, Thu chi, Sổ quỹ, Báo cáo, Cấu hình…).
- Mỗi trang tách quyền thành tối đa **3 mức**: **Xem** · **Quản lý** · **Nhạy cảm**. Không phải trang nào cũng có đủ 3 mức.
- Đây là trang tra cứu, **không có thao tác**. Bạn không cần quyền gì để đọc; nhưng để mở màn hình cấu hình quyền thật thì cần quyền module **Phân quyền** (`users`).
:::

## Ba mức quyền: Xem, Quản lý, Nhạy cảm {#ba-muc-quyen}

Mọi chức năng trong phần mềm được xếp vào một trong ba mức. Hiểu đúng ba mức này là đủ để đọc cả bảng tra bên dưới.

| Mức | Ý nghĩa | Ví dụ điển hình |
|---|---|---|
| **Xem** *(view)* | Chỉ **đọc** dữ liệu của trang: mở danh sách, xem chi tiết, xem báo cáo. Không tạo/sửa/xoá được gì. | Xem danh sách hợp đồng, xem hoá đơn, xem báo cáo dòng tiền. |
| **Quản lý** *(manage)* | **Tạo · sửa · xoá · duyệt** — các thao tác vận hành thông thường trên trang đó. | Thêm phòng, sửa hợp đồng, tạo phiếu thu chi, xoá khách hẹn. |
| **Nhạy cảm** *(elevated)* | Thao tác **dễ ảnh hưởng tiền hoặc ảnh hưởng phân quyền** — cần cân nhắc kỹ trước khi cấp. | Thu tiền hoá đơn, hoàn/bỏ cọc, thanh lý hợp đồng, chia lợi nhuận, quản lý nhân sự & mẫu quyền. |

::: warning Mức "Nhạy cảm" cần cấp có chọn lọc
Các chức năng mức **Nhạy cảm** cho phép người dùng **ghi nhận tiền** (thu tiền, hoàn cọc, thanh lý) hoặc **thay đổi phân quyền** (quản lý nhân viên, sửa mẫu quyền). Chỉ cấp cho người thực sự cần. Thu hồi quyền về sau **không** tự động xoá những dữ liệu (phiếu thu, hợp đồng đã thanh lý…) mà người đó đã tạo trước đó.
:::

## Hai chiều kiểm soát: quyền × phạm vi {#hai-chieu-kiem-soat-quyen-x-pham-vi}

Một nhân viên chỉ thao tác được khi **cả hai chiều** đều mở:

1. **Quyền** — người đó có được cấp chức năng đó không (chiều mô tả trong bảng tra bên dưới).
2. **Phạm vi toà** — người đó có được giao **toà** liên quan không.

Phạm vi toà được chọn khi bạn thêm/sửa nhân viên (xem [Thêm nhân viên](/01-bat-dau/them-nhan-vien/)), có **3 kiểu**:

| Kiểu phạm vi | Nghĩa |
|---|---|
| **Tất cả toà** | Áp quyền cho **mọi toà** hiện có và toà tạo sau này. |
| **Theo khu vực** *(tự cập nhật)* | Áp cho mọi toà thuộc **khu vực** được chọn; thêm toà vào khu sau này thì nhân viên **tự động** có phạm vi toà đó. |
| **Toà lẻ** *(cố định)* | Chỉ đúng các toà được tích, không tự mở rộng. |

::: tip Vì sao "có quyền mà vẫn không làm được"
Đây là nhầm lẫn phổ biến nhất. Nếu một người **có quyền** (ví dụ *Quản lý* hợp đồng) nhưng vẫn không sửa được hợp đồng của một toà, gần như luôn là do **phạm vi toà** chưa bao gồm toà đó. Kiểm tra lại phạm vi toà của người đó, không phải mẫu quyền.

Ngoại lệ: một số danh mục **cấp tổ chức** — điển hình là **Khách hàng / Cư dân** — **không** giới hạn theo toà. Ai có quyền *Quản lý* khách hàng thì sửa được mọi khách của bạn, bất kể toà.
:::

## Bảng tra nhanh: trang × chức năng × mức quyền {#bang-tra-nhanh}

Bảng dưới liệt kê các module chính. Ô để trống nghĩa là module đó **không có** mức tương ứng.

### Bất động sản

| Trang / Module | Xem | Quản lý | Nhạy cảm |
|---|---|---|---|
| **Toà nhà** | Xem danh sách & sơ đồ toà | Thêm / sửa / xoá toà | — |
| **Phòng / Căn hộ** | Xem danh sách phòng, trạng thái | Thêm / sửa / xoá phòng | — |
| **Khu vực** | Xem danh sách khu | Thêm / sửa / xoá khu *(cần phạm vi **Tất cả toà**)* | — |
| **Ghi chỉ số điện nước** | Xem chỉ số đã ghi | Ghi / sửa chỉ số | — |

### Khách & Hợp đồng

| Trang / Module | Xem | Quản lý | Nhạy cảm |
|---|---|---|---|
| **Khách hàng / Cư dân** | Xem hồ sơ khách | Thêm / sửa / xoá khách *(cấp tổ chức — không theo toà)* | — |
| **Khách hẹn** *(leads)* | Xem danh sách khách hẹn | Thêm / sửa / xoá, gán phụ trách | — |
| **Đặt cọc** | Xem danh sách cọc | Tạo phiếu cọc | **Chuyển cọc** vào hợp đồng · **Hoàn / bỏ cọc** (ghi tiền) |
| **Hợp đồng** | Xem danh sách & chi tiết hợp đồng | Tạo / sửa / xoá hợp đồng | **Gia hạn** · **Chuyển phòng** · **Thanh lý** · **Bàn giao** |

### Hoá đơn & Thu tiền

| Trang / Module | Xem | Quản lý | Nhạy cảm |
|---|---|---|---|
| **Hoá đơn** | Xem danh sách & chi tiết hoá đơn | Tạo / sửa / xoá hoá đơn, **In**, **Xuất** | **Thu tiền** (record_payment) · **Huỷ hoá đơn** · **Duyệt** |
| **Thu tiền** *(màn thu nhanh trên điện thoại)* | Xem báo cáo thu | — | **Thu tiền** · **Hoàn tác phiếu thu** |
| **Sinh hoá đơn hàng loạt** | — | Sinh hoá đơn theo tháng | — |

### Thu chi & Sổ quỹ

| Trang / Module | Xem | Quản lý | Nhạy cảm |
|---|---|---|---|
| **Thu chi** | Xem phiếu thu / chi | Tạo / sửa / xoá phiếu, **Duyệt** | **Mọi toà** (ghi thu chi vượt phạm vi toà) · **Hạng mục hạn chế** (tạo / xem hạng mục nhạy cảm) |
| **Sổ quỹ** | Xem sổ & số dư | Tạo / sửa / xoá sổ quỹ | — |
| **Kho vật tư** | Xem tồn kho | Nhập / xuất / kiểm kê vật tư | — |

### Vận hành khác

| Trang / Module | Xem | Quản lý | Nhạy cảm |
|---|---|---|---|
| **Công việc** | Xem việc & nhóm việc | Tạo / sửa / xoá, giao việc | — |
| **Phương tiện** | Xem danh sách xe | Thêm / sửa / xoá xe | — |
| **Tài sản** | Xem danh mục tài sản | Thêm / sửa / xoá | **Điều chuyển** · **Bảo trì** |
| **Sale phòng** *(trang quản trị)* | Xem cấu hình sale | — | **Quản lý liên kết chia sẻ** · **Cài đặt** · **Ảnh** · **Sơ đồ tầng** · **Khách nhờ sale** · **Thống kê** |
| **Chat Zalo** | Xem hội thoại | **Gửi tin nhắn** | **Tự động hoá** · **Mẫu tin nhắn** |

### Báo cáo & Tài chính

| Trang / Module | Xem | Quản lý | Nhạy cảm |
|---|---|---|---|
| **Báo cáo Bất động sản** | Xem từng báo cáo (lấp đầy, phòng trống, cho thuê mới, cọc…) | — | — |
| **Báo cáo Tài chính** | Xem từng báo cáo (dòng tiền, công nợ, phân tích, sổ quỹ ngày…) | — | **Đối soát / chốt số** · **Báo cáo bàn giao** · **Chu kỳ thu → bàn giao** |
| **Chia lợi nhuận cổ đông** | Xem phân bổ lợi nhuận | — | **Khoá / mở khoá** kỳ · **Chia** · **Quản lý cổ đông** |
| **Bảng lương** | Xem bảng lương | — | **Khoá / mở khoá** · **Chia** · **Quản lý lương** · **Xuất** |

### Cấu hình

| Trang / Module | Xem | Quản lý | Nhạy cảm |
|---|---|---|---|
| **Cài đặt chung & Danh mục** | Xem cấu hình, danh mục | Thêm / sửa / xoá danh mục (loại thu chi, mẫu biểu, hotline, nhà cung cấp…) | — |
| **Phân quyền & Nhân sự** *(module `users`)* | Xem trang phân quyền, danh sách nhân viên | Thêm / sửa / xoá nhân viên | **Quản lý mẫu phân quyền** — cả module này thuộc mức **Nhạy cảm** |

## Bốn mẫu hệ thống có sẵn {#bon-mau-he-thong}

Thay vì tick từng quyền, bạn thường bắt đầu từ một **mẫu hệ thống** rồi tinh chỉnh. Phần mềm có sẵn 4 mẫu (không sửa được — muốn đổi thì **Tạo bản sao**):

| Mẫu | Cấp những gì | Phù hợp với |
|---|---|---|
| **Super Admin** | Toàn quyền, bỏ qua mọi kiểm tra | Chủ nhà / người vận hành chính |
| **Quản Lý Tòa** | Đầy đủ vận hành 1+ toà (tạo/sửa/xoá/duyệt hầu hết module; **Khu vục** & **Mẫu biểu** chỉ *Xem*) | Quản lý toà |
| **Partner** | Quản lý khách hẹn & cọc, **xem** bất động sản và hợp đồng (read-only) | Cộng tác viên / đối tác |
| **Viewer** | Mọi module chỉ **Xem** | Người chỉ cần theo dõi |

Khi bạn gán một mẫu cho nhân viên, phần mềm **sao chép** bộ quyền của mẫu sang người đó. Sau đó bạn có thể **tinh chỉnh riêng** cho người này mà **không** ảnh hưởng mẫu gốc hay người khác — thẻ nhân viên sẽ hiện **N thay đổi so với mẫu** khi quyền đã lệch khỏi mẫu.

## Tình huống & lỗi thường gặp {#tinh-huong}

| Tình huống | Nguyên nhân & cách xử lý |
|---|---|
| Có quyền *Quản lý* nhưng không sửa được dữ liệu ở một toà | **Phạm vi toà** chưa bao gồm toà đó. Kiểm tra lại phạm vi (Tất cả toà / khu vực / toà lẻ) trong hồ sơ nhân viên. |
| Có quyền *Xem* khách hàng nhưng lại sửa được **mọi** khách | Đúng thiết kế: **Khách hàng / Cư dân** là danh mục cấp tổ chức, không giới hạn theo toà. Cấp quyền *Quản lý* khách cho ai là mở với **toàn bộ** khách. |
| Đã tick quyền *Xem* nhưng người dùng vẫn không mở được một trang | Trang đó có thể thuộc mức **Nhạy cảm** (ví dụ *Phân quyền*, *Chia lợi nhuận*) — cần cấp đúng chức năng nhạy cảm chứ không chỉ *Xem* chung. |
| Không thấy nhân viên bật được **Mọi toà** trong Thu chi | Đây là chức năng **Nhạy cảm** riêng của module Thu chi; phải tick riêng, không nằm trong quyền *Quản lý* thu chi thông thường. |
| Thu hồi quyền rồi mà dữ liệu cũ vẫn còn | Thu hồi quyền chỉ chặn thao tác **từ nay về sau**; các phiếu / hợp đồng người đó đã tạo trước đó vẫn được giữ nguyên. |
| Nhân viên cũ vẫn hoạt động sau khi cập nhật mẫu quyền | Quyền được **sao chép** vào từng người khi gán mẫu; sửa mẫu **không** tự động cập nhật ngược cho người đã gán. Mở lại người đó, chọn lại mẫu để nạp mới. |

## Thử trực tiếp trên sandbox {#thu-tren-sandbox}

<SandboxTry account="demo.chunha" app-path="/settings/staff" view-only>

**Bài xem**

Mở **Mẫu phân quyền** để đối chiếu với bảng tra quyền ở trên: bấm vào một mẫu (ví dụ **Quản Lý Tòa**) để xem **ma trận quyền theo trang** — quan sát danh sách trang chia theo nhóm ở cột trái, từng chức năng và ô tích ở panel phải, cùng badge **Nhạy cảm** đánh dấu các quyền dễ ảnh hưởng tiền. Chỉ xem, không cần lưu.

</SandboxTry>

## Quy trình liên quan {#quy-trinh-lien-quan}

- [Phân quyền theo trang (mẫu quyền)](/05-cai-dat/phan-quyen/)
- [Thêm nhân viên](/01-bat-dau/them-nhan-vien/)
- [Nhân viên & Đội ngũ](/05-cai-dat/nhan-vien-doi-ngu/)
- [Quản lý tài khoản (admin)](/05-cai-dat/admin-users/)
