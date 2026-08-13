---
title: "Loại tài sản"
description: "Danh mục nhóm các món tài sản/nội thất theo loại (điện lạnh, nội thất...) để phân loại khi khai báo và tra cứu tài sản."
routes: ["/settings/categories/asset-types"]
permissions: [{module: asset_types, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-08-13"
  account: demo
status: published
---

# Loại tài sản

**Loại tài sản** là danh mục dùng để **gom các món tài sản/nội thất thành từng nhóm** — ví dụ *Điện lạnh* hoặc *Nội thất*. Dữ liệu thuộc tổ chức và chịu RLS; người dùng chỉ thấy danh sách mà membership và quyền hiệu lực cho phép.

Một điểm cần nắm ngay để khỏi loay hoay: **trang Cài đặt riêng cho Loại tài sản hiện đang được hoàn thiện** — nó chưa có bảng thêm/sửa/xoá loại trực tiếp. Trên thực tế, danh sách loại tài sản **xuất hiện dưới dạng ô chọn (dropdown)** ở hai nơi trong màn hình **Tài sản**: ô lọc **Loại tài sản** đầu trang, và trường **Loại tài sản** khi bạn **Tạo tài sản**. Trang này giải thích loại tài sản dùng để làm gì và bạn xem/dùng nó ở đâu.

::: info Điều kiện tiên quyết
- Route yêu cầu `asset_types.view`. Trang hiện là placeholder nên chưa có thao tác dùng các quyền create/edit/delete tại đây.
- Khi danh mục và tài sản đã được quản trị cấu hình, loại sẽ xuất hiện trong các ô chọn ở màn **Tài sản**. Snapshot DEMO hiện chưa có tài sản.
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Cài đặt** => mục **Danh mục** => **Loại tài sản** (đường dẫn `/settings/categories/asset-types`).

::: warning Trang đang được hoàn thiện
Trang **Loại tài sản** trong Cài đặt hiện là trang **giữ chỗ** — chưa có nút **Thêm / Sửa / Xoá** loại tài sản ngay tại đây. Bạn vẫn **xem và dùng** loại tài sản bình thường ở màn hình **Tài sản** (các bước dưới). Muốn **thêm một loại mới** vào lúc này, hãy nhờ **quản trị hệ thống** bổ sung trực tiếp; nút thêm trên giao diện sẽ có ở bản cập nhật sau.
:::

**Bước 2**: Để **xem danh sách loại tài sản đang có**, mở màn hình **Tài sản** (menu **Tài sản** trong nhóm *Danh mục dữ liệu*) rồi bấm vào ô lọc **Loại tài sản** ở đầu trang. Danh sách xổ xuống liệt kê **tất cả loại đang dùng** (ví dụ *Điện lạnh*, *Nội thất*). Đây cũng chính là cách lọc bảng tài sản về đúng một loại để soi cho gọn.

**Bước 3**: Khi **khai báo một món tài sản mới**, vào **Tài sản** => **Tạo tài sản**. Trường **Loại tài sản** là **bắt buộc** — bạn chọn đúng nhóm cho món đồ (ví dụ *máy lạnh* => **Điện lạnh**, *giường* => **Nội thất**). Nhờ vậy về sau bạn lọc và đếm tài sản theo loại được ngay.

**Bước 4**: Nếu lỡ gán nhầm loại cho một tài sản, mở **Tài sản** => bấm **Sửa** ở dòng tài sản đó => chọn lại **Loại tài sản** đúng => **Lưu**. Việc này chỉ đổi loại của **một món**, không đổi tên loại trong danh mục.

## Các tính năng khác trên màn hình

Vì trang Cài đặt còn là bản giữ chỗ, dưới đây là những nơi loại tài sản **thực sự xuất hiện và phát huy tác dụng** trong hệ thống:

| Vị trí trong hệ thống | Vai trò của Loại tài sản |
| --- | --- |
| Ô lọc **Loại tài sản** (màn hình **Tài sản**) | Lọc bảng tài sản về đúng một loại. Bộ lọc này chạy **phía máy chủ** và được **giữ nguyên qua F5** cùng các ô lọc khác. |
| Trường **Loại tài sản** (hộp thoại **Tạo tài sản** / **Sửa tài sản**) | **Bắt buộc** khi khai báo; quyết định món đồ thuộc nhóm nào. Ô chọn có **gõ-để-tìm**. |
| **Danh mục theo tổ chức** | Loại tài sản thuộc dữ liệu tổ chức và chịu RLS; phạm vi nhìn thấy phụ thuộc membership/quyền hiệu lực. |
| Liên kết với **Nhà cung cấp** | Loại tài sản (món đồ *là gì*) độc lập với nhà cung cấp (mua *từ ai*); cả hai cùng mô tả một tài sản. |

## Tình huống & lỗi thường gặp

| Tình huống | Nguyên nhân & cách xử lý |
| --- | --- |
| Vào trang **Loại tài sản** trong Cài đặt nhưng **không thấy bảng / nút Thêm** | Bình thường — trang này đang được hoàn thiện (bản giữ chỗ). Xem và dùng loại tài sản ở màn hình **Tài sản**; muốn thêm loại mới thì nhờ quản trị hệ thống bổ sung. |
| Ô chọn **Loại tài sản** ở màn Tài sản **trống rỗng** | Chưa có loại nào được khai báo, hoặc tài khoản của bạn **chưa có quyền xem Tài sản**. Kiểm tra lại quyền trong nhóm *Tài sản & Kho*. |
| Có `asset_types.view` nhưng vẫn không thấy dữ liệu mong đợi | Kiểm tra membership, role binding, scope và RLS của tổ chức; permission không tự vượt phạm vi dữ liệu. |
| Muốn **đổi tên** một loại đang dùng | Hiện **chưa có** thao tác sửa tên loại trên giao diện. Cần đổi tên hàng loạt, hãy nhờ quản trị hệ thống. |
| Gán **nhầm loại** cho một tài sản | Mở **Tài sản** => **Sửa** dòng đó => chọn lại **Loại tài sản** đúng => **Lưu** (chỉ đổi món đó, không ảnh hưởng danh mục). |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/settings/categories/asset-types" app-label="Mở trang Loại tài sản" fixtures="Snapshot 13/08/2026: trang hiển thị Tính năng đang phát triển; màn Tài sản đang rỗng." view-only>

Bài này **chỉ xem** — mục tiêu là xác nhận trạng thái hiện tại và nơi loại tài sản sẽ được dùng:

1. Mở trang **Loại tài sản** trong Cài đặt và xác nhận thông báo **Tính năng đang phát triển**.
2. Chuyển sang màn **Tài sản** và xác nhận snapshot hiện tại không có dòng tài sản.
3. Nhận diện ô lọc/trường **Loại tài sản** là nơi danh mục sẽ xuất hiện khi dữ liệu được quản trị cấu hình; không mở/lưu form tạo mới.

Kết quả mong đợi: bạn hiểu **Loại tài sản = danh mục theo tổ chức để phân nhóm tài sản**, biết rằng trang Cài đặt riêng còn đang hoàn thiện, và biết **xem/dùng loại tài sản qua màn hình Tài sản**.

</SandboxTry>

## Quy trình liên quan

- [Nhà cung cấp](/05-cai-dat/nha-cung-cap/) — danh mục nơi mua tài sản; đi cùng Loại tài sản để mô tả đầy đủ một món (là gì / mua từ ai).
- [Căn hộ & phòng](/03-quan-ly-van-hanh/can-ho-phong/) — nơi tài sản được gắn vị trí (toà / phòng) sau khi đã phân loại.
- [Phân quyền](/05-cai-dat/phan-quyen/) — cấp quyền nhóm *Tài sản & Kho* để nhân viên xem/dùng loại tài sản.
- [Tạo tầng & phòng](/01-bat-dau/tao-tang-phong/) — khai báo toà, tầng, phòng để có nơi đặt tài sản.
