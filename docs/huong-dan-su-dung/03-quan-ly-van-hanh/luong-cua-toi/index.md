---
title: "Lương của tôi"
description: "Màn tự xem lương dành cho nhân viên trên điện thoại: lương cứng, thưởng theo việc đã làm, thưởng nóng, hoa hồng, tổng thực nhận và lịch sử — số liệu khớp đúng với bảng lương của quản trị."
routes: ["/finance/my-salary"]
permissions: []
viewport: mobile
audience: [nhan-vien]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Lương của tôi

Màn **Lương của tôi** là nơi bạn — nhân viên vận hành — tự xem tiền lương của chính mình ngay trên điện thoại, không phải hỏi ai. Toàn bộ con số ở đây được **tính từ dữ liệu vận hành thật**: việc bạn đã hoàn thành, hợp đồng bạn đã ký, phiếu thu bạn đã ghi — chứ không nhập tay. Màn cho bạn thấy **lương cứng**, các khoản **thưởng tự động** (thưởng theo việc, thưởng cuối tuần/ngày lễ, thưởng ký hợp đồng ngoài giờ), **hoa hồng sale**, phần **đầu tư** (nếu bạn đồng thời là cổ đông), các khoản **trừ** (ứng lương, tiền phòng ở) và cuối cùng là **Thực nhận**. Kèm theo là **lịch sử việc** liệt kê từng dòng bằng chứng đã cộng thành thưởng. Đây là màn **chỉ để xem** — bạn không ghi hay sửa tiền ở đây, nên cứ mở ra xem thoải mái.

::: info Điều kiện tiên quyết
- Bạn đã **đăng nhập** bằng tài khoản nhân viên. Mọi tài khoản đăng nhập đều mở được đường dẫn `/finance/my-salary`.
- Bạn đã được quản trị **cấu hình là người hưởng lương** trong **Bảng lương => Cấu hình** (xem [Bảng lương](/03-quan-ly-van-hanh/bang-luong/)). Nếu chưa, màn chỉ hiện thông điệp hướng dẫn liên hệ quản trị.
- Nên mở trang bằng **điện thoại** để có bố cục tối ưu (giao diện tối, gọn cho một tay cầm máy).
- Là nhân viên, khi bấm mục **Bảng lương** ở thanh bên, hệ thống mở thẳng màn **Lương của tôi** này ở **tab mới** — bạn không vào được bảng lương của người khác.
:::

## Hướng dẫn từng bước

**Bước 1**: Ở thanh bên, bấm mục **Bảng lương** — với tài khoản nhân viên, hệ thống mở màn **Lương của tôi** ở một **tab mới** (hoặc bạn mở thẳng đường dẫn `/finance/my-salary`). Nếu bạn **chưa được cấu hình** hưởng lương, màn hiện đúng một dòng nhắn: **"Bạn chưa được cấu hình hưởng lương. Liên hệ quản trị để được thiết lập."** — đây là trạng thái bình thường của tài khoản mới, hãy nhờ quản trị thêm bạn vào cấu hình lương (Bước tiếp theo giải thích).

![Màn Lương của tôi trên điện thoại (self-view của nhân viên): nền tối, tiêu đề "Lương của tôi" và thông điệp "Bạn chưa được cấu hình hưởng lương. Liên hệ quản trị để được thiết lập."](./images/buoc-01-mobile.webp)

**Bước 2**: Nếu bạn đã được cấu hình, hãy nhờ quản trị mở **Bảng lương => Cấu hình** một lần để thêm bạn vào danh sách người hưởng lương — khai **Lương cứng**, **Tiền phòng** (phòng bạn ở giá ưu đãi, nếu có), **biệt danh (alias)** để khớp phiếu hoa hồng, và **Mục tiêu thu**. Sau khi có cấu hình, mở lại màn **Lương của tôi**, phần trên cùng hiện thẻ **Thực nhận** của tháng đang xem (ví dụ nhân viên **Nguyễn Văn A** có Thực nhận **1.000.000đ**).

**Bước 3**: Đọc phần **chi tiết lương** theo đúng thứ tự cộng — trừ:

- **Lương cứng** — mức cố định theo cấu hình của bạn.
- **Thưởng tự động** — gộp 3 nhóm: thưởng **theo loại việc** đã hoàn thành, phụ cấp **cuối tuần / ngày lễ**, và **ký hợp đồng ngoài giờ** (+50.000đ khi hoàn thành sau giờ hành chính hoặc vào Chủ nhật/ngày lễ).
- **Hoa hồng (HH Sale)** — phiếu chi hoa hồng có tên người nhận khớp **biệt danh** của bạn, thuộc kỳ tháng đang xem.
- **Đầu tư** — chỉ hiện nếu bạn đồng thời là cổ đông: phần lợi nhuận được chia của các toà **đã chốt** trong tháng.
- **Ứng lương** — các phiếu ứng đã duyệt trong tháng, **trừ** vào lương.
- **Tiền phòng** — nếu bạn ở phòng giá ưu đãi, hoá đơn phòng tháng kế được **khấu trừ** thẳng vào lương.

Công thức tổng: **Thực nhận = Lương cứng + Thưởng + Hoa hồng + Đầu tư − Ứng lương − Tiền phòng**.

**Bước 4**: Kéo xuống phần **lịch sử việc** (bảng kê) để xem **từng dòng bằng chứng** đã cộng thành thưởng: mỗi việc hoàn thành, mỗi phụ cấp cuối tuần/lễ, mỗi lần ký hợp đồng — kèm ngày và số tiền. Đây là lời giải thích minh bạch cho con số **Thưởng tự động** ở trên: bạn thấy rõ tiền đến từ đâu.

**Bước 5**: Đổi **tháng** để xem lại lịch sử. Bạn lùi được về các tháng cũ **đã chốt**, nhưng hệ thống **chặn xem vượt** mốc tháng bạn được phép xem — số liệu tháng cũ đã đóng băng nên luôn khớp với lúc quản trị chốt.

::: tip Vì sao có khi bạn thấy tháng trước, chưa thấy tháng này
Mặc định màn **lùi 1 tháng cho tới khi chốt**: bạn xem **tháng trước** cho tới khi quản trị **chốt** tháng đó, rồi màn mới nhảy sang **tháng hiện tại**. Nhờ vậy bạn luôn nhìn số đã ổn định, không bị nhảy số giữa chừng khi việc trong tháng còn đang phát sinh. Quản trị có thể bật/tắt hiển thị từng tháng riêng cho bạn.
:::

::: tip Thưởng nóng khi vừa hoàn thành việc
Ngay khi bạn bấm **Hoàn thành** một việc có thưởng, một **popup thưởng** hiện lên và bạn nhận **thông báo đẩy** về máy — đó là "thưởng nóng" báo bạn vừa được cộng gì. Khoản đó **tự động dồn vào mục Thưởng tự động** ở màn Lương của tôi này; bạn không phải nhập lại. Xem thao tác hoàn thành việc ở [Việc của tôi](/02-theo-doi-nhanh/viec-cua-toi/).
:::

::: warning Số của tháng chưa chốt là tạm tính
Với tháng **chưa được quản trị chốt**, con số là **tạm tính** và có thể **thay đổi** khi bạn làm thêm việc, ký thêm hợp đồng, hoặc khi phiếu hoa hồng được duyệt. Chỉ khi quản trị **chốt tháng**, các số mới được **đóng băng** và là con số cuối cùng. Đây là màn chỉ-xem, bạn không tự chốt hay tự sửa được — mọi thay đổi tiền đều do quản trị thực hiện bên [Bảng lương](/03-quan-ly-van-hanh/bang-luong/).
:::

## Các tính năng khác trên màn hình

| Thành phần | Công dụng |
| --- | --- |
| Thẻ **Thực nhận** | Số tiền cuối cùng bạn nhận trong tháng đang xem (đã cộng thưởng, trừ ứng và tiền phòng). |
| Chi tiết **Lương cứng / Thưởng / Hoa hồng / Đầu tư** | Các khoản **cộng** vào lương, tách rõ từng nguồn. |
| Chi tiết **Ứng lương / Tiền phòng** | Các khoản **trừ** khỏi lương trong tháng. |
| **Lịch sử việc** (bảng kê) | Liệt kê từng dòng bằng chứng (việc, phụ cấp, ký HĐ) đã cộng thành Thưởng tự động. |
| Điều hướng **tháng** | Lùi về các tháng cũ đã chốt để xem lại; chặn xem vượt mốc được phép. |
| Giao diện tối, gọn tay | Bố cục tối ưu cho điện thoại, xem nhanh một tay. |

Số nhân viên bạn thấy ở đây **luôn khớp** với số quản trị thấy trong bảng lương — cùng một nguồn tính, không có "hai sổ".

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Màn hiện **"Bạn chưa được cấu hình hưởng lương"** | Tài khoản của bạn chưa nằm trong danh sách hưởng lương. Nhờ quản trị thêm bạn ở **Bảng lương => Cấu hình** (xem [Bảng lương](/03-quan-ly-van-hanh/bang-luong/)). |
| Không thấy **tháng hiện tại**, chỉ thấy tháng trước | Đúng chính sách **lùi-tháng**: bạn xem tháng trước cho tới khi nó được **chốt**, rồi màn mới sang tháng này. |
| **Thưởng** ít hơn bạn nghĩ | Thưởng phụ thuộc **loại việc** (chỉ loại tính lương mới cộng), có **ảnh** khi hệ thống yêu cầu, và điều kiện **giờ/ngày** (ký HĐ chỉ +50.000đ khi sau giờ hoặc CN/lễ). Xem lịch sử việc để đối chiếu từng dòng. |
| Phần **Đầu tư** bằng 0 dù bạn là cổ đông | Lợi nhuận toà **chưa chốt** (còn nháp) thì chưa cộng; màn hiện trạng thái "chờ chốt" cho tới khi quản trị chốt lợi nhuận (xem [Chia lợi nhuận](/03-quan-ly-van-hanh/chia-loi-nhuan/)). |
| Chưa thấy **Hoa hồng (HH Sale)** | Phiếu hoa hồng chưa được duyệt, hoặc **biệt danh** của bạn chưa khớp tên người nhận trên phiếu chi. Nhờ quản trị kiểm tra cấu hình biệt danh. |
| Số **thay đổi** giữa các lần xem | Bình thường với tháng **chưa chốt** — số là tạm tính, cập nhật theo việc mới. Chốt tháng xong sẽ đứng yên. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.kythuat" app-path="/finance/my-salary" app-label="Mở màn Lương của tôi" fixtures="tài khoản nhân viên demo chưa cấu hình hưởng lương" view-only>

Xem lương của chính mình — lương theo việc, thưởng, tổng (mở trên điện thoại, chỉ xem):

1. Mở màn **Lương của tôi** bằng điện thoại. Vì tài khoản demo **chưa được cấu hình** hưởng lương, bạn sẽ thấy thông điệp **"Bạn chưa được cấu hình hưởng lương. Liên hệ quản trị để được thiết lập."** — đây chính là trải nghiệm của một nhân viên mới trước khi quản trị thiết lập.
2. Ghi nhớ: đây là nơi **duy nhất** nhân viên tự xem lương của mình — lương cứng, thưởng theo việc đã làm, thưởng nóng, hoa hồng và tổng thực nhận — mà không cần hỏi ai.
3. Khi được cấu hình, phần trên cùng sẽ hiện thẻ **Thực nhận**, bên dưới là chi tiết cộng/trừ và **lịch sử việc**.

Đây là màn **chỉ để xem** — không có thao tác ghi tiền, nên cứ mở ra xem thoải mái.

</SandboxTry>

## Quy trình liên quan

- [Bảng lương](/03-quan-ly-van-hanh/bang-luong/) — phía quản trị: cấu hình người hưởng lương, chốt và trả lương; là nơi thiết lập để màn Lương của tôi có dữ liệu.
- [Việc của tôi](/02-theo-doi-nhanh/viec-cua-toi/) — hoàn thành việc để nhận **thưởng nóng**, khoản này dồn vào Thưởng tự động của bạn.
- [Chia lợi nhuận](/03-quan-ly-van-hanh/chia-loi-nhuan/) — nguồn của phần **Đầu tư** khi bạn đồng thời là cổ đông.
- [Ví cá nhân](/03-quan-ly-van-hanh/vi-ca-nhan/) — theo dõi tiền cá nhân của bạn tách khỏi tiền vận hành toà nhà.
