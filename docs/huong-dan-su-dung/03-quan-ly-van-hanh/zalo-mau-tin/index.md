---
title: "Chat Zalo — mẫu tin & tự động hoá"
description: "Gửi tin Zalo hàng loạt (broadcast) theo nhãn phân loại, chèn nhanh mẫu tin khi soạn, và bật/tắt các công tắc tự động hoá tin nhắn — cùng ranh giới ZNS/OA hiện chưa hỗ trợ."
routes: ["/chat-zalo"]
permissions: [{module: chat_zalo, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Chat Zalo — mẫu tin & tự động hoá

Màn **Chat Zalo** (`/chat-zalo`) đưa việc nhắn tin Zalo với khách trọ, khách tiềm năng và môi giới vào thẳng CRM. Ngoài việc chat 1-1, trang còn có ba nhóm công cụ để bạn làm việc nhanh hơn với số đông: **gửi tin hàng loạt (broadcast) theo nhãn**, **chèn mẫu tin** khi soạn, và **bật/tắt tự động hoá tin nhắn**. Bài này tập trung vào ba nhóm đó — cùng ghi rõ tính năng nào đã chạy thật và tính năng nào mới là khung để bạn khỏi kỳ vọng nhầm.

::: info Điều kiện tiên quyết
- Quyền **Chat Zalo => Xem** (module `chat_zalo`, action `view`) để mở trang `/chat-zalo`. Không có quyền này thì mục **Chat Zalo** bị ẩn khỏi menu (nhóm **Kênh chat**).
- Quyền **Chat Zalo => Gửi** (`chat_zalo.send`) để gửi tin và **broadcast**; quyền **Chat Zalo => Quản lý tự động hoá** (`chat_zalo.manage_automation`) để bật/tắt các công tắc tự động.
- Đã **kết nối ít nhất một tài khoản Zalo** (quét QR ở nút **Kết nối Zalo cá nhân**) và tiến trình đồng bộ đang chạy — nếu chưa, danh sách hội thoại và nhãn sẽ trống.
- **Nhãn phân loại** được tạo và sửa trong **ứng dụng Zalo**, hệ thống chỉ **đọc về** để lọc và chọn người nhận (xem mục Nhãn phân loại bên dưới).
:::

::: warning Zalo nối vào CRM qua tài khoản cá nhân — hãy dùng nick phụ
Kênh này chạy trên **tài khoản Zalo cá nhân** thông qua một tiến trình nền riêng (worker), không phải cổng chính thức của Zalo. Gửi quá nhiều tin trong thời gian ngắn có thể khiến Zalo **khoá tạm nick**. Vì vậy nên dùng một **tài khoản Zalo phụ** dành riêng cho CRM, và không đăng nhập cùng nick đó ở nơi khác (mở Zalo Web cùng nick sẽ làm rớt luồng nhận tin). Đây là lý do broadcast được **rải nhịp** chứ không bắn một loạt (xem bên dưới).
:::

## Gửi tin hàng loạt (broadcast) theo nhãn

Broadcast là cách gửi **cùng một nội dung** tới nhiều hội thoại một lần — ví dụ nhắc đóng tiền đầu tháng cho tất cả khách gắn nhãn "Khách trọ", hay gửi thông báo cho nhóm môi giới.

**Bước 1**: Ở **cột danh sách hội thoại** (bên trái), bấm nút **loa** (biểu tượng phát thanh) trên đầu danh sách. Hộp thoại **Gửi tin hàng loạt** mở ra.

**Bước 2**: Chọn tập người nhận. Trong hộp thoại bạn có thể:

- Lọc theo **nhãn phân loại** (ví dụ chỉ những hội thoại gắn nhãn "Khách trọ").
- Gõ **tìm** theo tên hoặc số điện thoại để thu hẹp thêm.
- Bấm **Chọn tất cả** để chọn nhanh — lưu ý **chỉ chọn trong tập đang lọc/tìm**, không phải toàn bộ danh bạ. Bạn cũng tích/bỏ tích từng hội thoại thủ công.

**Bước 3**: Nhập **nội dung tin** rồi bấm gửi. Hệ thống trả về thông báo **"Đã gửi tới N hội thoại"** — đây là số hội thoại đã được đưa vào hàng đợi gửi, tiến trình nền sẽ gửi **tuần tự** ngay sau đó.

**Bước 4**: (Cách khác để mở broadcast) Trong khung chat, mở menu thao tác của một tin và chọn **Chia sẻ** — nội dung tin đó được đổ sẵn vào hộp thoại broadcast để bạn chuyển tiếp cho nhiều người.

::: warning Broadcast gửi tin thật, không thu hồi hàng loạt được
Mỗi hội thoại trong tập chọn sẽ nhận một **tin Zalo thật**. Sau khi gửi, bạn chỉ có thể **thu hồi từng tin một** (và chỉ với tin do mình gửi đi), không có nút "thu hồi cả loạt". Trước khi bấm gửi hãy kiểm tra kỹ **đúng nhãn / đúng tập người nhận**, **đúng nội dung**, và **đúng tài khoản Zalo** đang chọn ở đầu danh sách.
:::

::: tip Vì sao broadcast gửi "chậm"
Tiến trình nền cố ý **nghỉ ngẫu nhiên khoảng 0,7–1,5 giây giữa mỗi tin** để Zalo không xem là spam và khoá nick. Với tập lớn, tin sẽ tới người nhận rải ra trong ít phút — đó là bình thường, không phải lỗi. Tránh gửi nhiều đợt lớn liên tiếp trong thời gian ngắn.
:::

::: tip Ai không đủ quyền sẽ bị bỏ qua âm thầm
Khi gửi, hệ thống kiểm tra quyền **theo từng hội thoại**. Hội thoại nào bạn không phải chủ và không có quyền **gửi** sẽ bị **lặng lẽ bỏ qua** — nên đôi khi số "đã gửi" nhỏ hơn số bạn tưởng đã chọn.
:::

## Chèn mẫu tin khi soạn

Mẫu tin giúp bạn chèn nhanh những câu hay dùng (chào hỏi, nhắc nợ, hướng dẫn chuyển khoản…) thay vì gõ lại mỗi lần.

- Khi đang mở một hội thoại, ở **ô soạn tin** (cột giữa) có nút **mẫu tin** — bấm để chọn một mẫu, nội dung được **chèn vào ô soạn** để bạn xem lại và gửi.
- Thư viện mẫu tin cũng hiển thị ở **cột thông tin bên phải**, tab **Tự động hoá**, để bạn xem nhanh các mẫu đang có.

::: warning Mẫu tin hiện chèn theo tiêu đề, chưa quản lý trong app
Trang chèn mẫu tin theo **tiêu đề mẫu**, nên hãy đặt **tiêu đề chính là câu bạn muốn gửi** (câu ngắn, đầy đủ). Ngoài ra hệ thống **chưa có màn thêm/sửa/xoá mẫu tin trong ứng dụng** — danh sách mẫu hiện do quản trị nạp sẵn ở tầng dữ liệu. Quyền **Chat Zalo => Quản lý mẫu tin** (`chat_zalo.manage_templates`) đã có trong danh mục phân quyền nhưng **chưa có màn nào dùng tới**. Nếu cần thêm/sửa mẫu, hãy nhờ quản trị hệ thống.
:::

## Nhãn phân loại khách

Nhãn (**Phân loại** trong Zalo) là công cụ chính để nhóm khách và **chọn người nhận broadcast**.

- Nhãn được **tạo và sửa trong ứng dụng Zalo** (không tạo trong CRM). Mỗi lần kết nối, hệ thống **đồng bộ về** danh sách nhãn và gắn nhãn tương ứng cho từng hội thoại.
- Ở **cột danh sách hội thoại**, dùng ô **lọc theo nhãn** để chỉ xem những hội thoại của một nhãn.
- Trong hộp thoại **broadcast**, chọn nhãn để nhắm đúng tập người nhận (ví dụ chỉ gửi cho nhãn "Sắp hết hạn HĐ").

::: tip Muốn thêm/đổi nhãn thì làm trên điện thoại
Vì nhãn thuộc về tài khoản Zalo, bạn tạo/đổi tên/đổi màu nhãn ngay trong **ứng dụng Zalo** rồi gắn nhãn cho khách ở đó. Ít phút sau (sau nhịp đồng bộ) nhãn mới sẽ xuất hiện trong bộ lọc và hộp thoại broadcast của CRM.
:::

## Bật/tắt tự động hoá tin nhắn

Ở **cột thông tin bên phải**, tab **Tự động hoá** có hai công tắc:

- **Gửi ảnh phòng trống** — ý tưởng: tự gửi ảnh/thông tin phòng trống cho một tập khách theo nhãn.
- **Tự động trả lời** — ý tưởng: tự phản hồi tin đến theo kịch bản.

Bật/tắt cần quyền **Chat Zalo => Quản lý tự động hoá** (`chat_zalo.manage_automation`); trạng thái được lưu lại theo tài khoản của bạn.

::: warning Hai công tắc này hiện mới lưu trạng thái, chưa tự gửi tin
Bật hai công tắc trên **chưa khiến hệ thống tự động gửi tin** — phần thực thi (engine) đang được hoàn thiện. Xem đây là nơi **ghi nhận ý định bật tính năng**, đừng dựa vào nó để chăm khách thay bạn. Con số **lượt chạy tự động** hiển thị ở chân danh sách hội thoại hiện là **số minh hoạ**, không phản ánh hoạt động thật. Việc gửi hàng loạt thật, ngay lúc này, hãy dùng **broadcast thủ công** ở mục trên.
:::

## ZNS và Zalo OA — hiện chưa hỗ trợ

- **ZNS** (Zalo Notification Service — tin mẫu chính thức qua Official Account) và **Zalo OA** **chưa được hỗ trợ** trong phiên bản này. Cấu trúc dữ liệu có chừa sẵn chỗ (mã mẫu ZNS, kênh `oa`) nhưng **không có luồng gửi nào chạy**.
- Toàn bộ việc gửi hiện đi qua **tài khoản Zalo cá nhân** đã kết nối. Khi cần gửi cho khách, hãy dùng **chat trực tiếp** hoặc **broadcast theo nhãn**.

## Các tính năng khác

| Nút / Khu vực | Công dụng |
| --- | --- |
| Nút **loa** (đầu danh sách hội thoại) | Mở hộp thoại **Gửi tin hàng loạt** (broadcast) theo nhãn / tìm / chọn tất cả. |
| **Chọn tài khoản Zalo** (đầu danh sách) | Chuyển hoặc xem **nhiều tài khoản Zalo cùng lúc**; nút **Kết nối Zalo cá nhân** (quét QR), kết nối lại / ngắt từng nick. |
| Ô **lọc theo nhãn** | Chỉ hiện hội thoại của một nhãn phân loại. |
| Chip **Tất cả · Chưa đọc · Khách trọ · Lead** | Lọc nhanh danh sách; lưu ý hai chip **Khách trọ / Lead** hiện thường chưa có dữ liệu vì hội thoại chưa được gắn vào hồ sơ khách. |
| Nút **mẫu tin** (ô soạn tin) | Chèn nhanh một mẫu tin vào nội dung đang soạn. |
| **Chia sẻ** (menu thao tác của một tin) | Chuyển tiếp nội dung tin đó tới nhiều người qua hộp thoại broadcast. |
| Tab **Tự động hoá** (cột phải) | Hai công tắc tự động + thư viện mẫu tin. |
| **Thông báo đẩy** khi có tin mới | Khi có tin Zalo **đến**, bạn nhận **thông báo đẩy** (Web Push) trên trình duyệt/điện thoại (xem [Thông báo](/02-theo-doi-nhanh/thong-bao/)). |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Danh sách hội thoại **trống** | Chưa kết nối tài khoản Zalo hoặc tiến trình đồng bộ chưa chạy. Bấm **Kết nối Zalo cá nhân** và quét QR; đợi ít phút để danh bạ/nhóm đồng bộ về. |
| Ô **lọc theo nhãn** không có nhãn nào | Nhãn được đọc từ ứng dụng Zalo. Hãy tạo/gắn **Phân loại** trong app Zalo trước, rồi đợi nhịp đồng bộ. |
| Bấm loa nhưng **không gửi được** hoặc nút mờ | Bạn thiếu quyền **Chat Zalo => Gửi** (`chat_zalo.send`). Nhờ quản trị cấp quyền. |
| Broadcast báo "Đã gửi tới N" nhưng **N nhỏ hơn** số chọn | Hệ thống kiểm quyền **theo từng hội thoại**; hội thoại bạn không đủ quyền bị **bỏ qua âm thầm**. |
| Broadcast **tới chậm**, rải trong vài phút | Đúng thiết kế: tin được **rải nhịp 0,7–1,5 giây/tin** để tránh bị Zalo coi là spam. Không phải lỗi. |
| Không tìm thấy màn **thêm/sửa mẫu tin** | Đúng hiện trạng: chưa có màn quản lý mẫu tin trong app. Nhờ quản trị nạp mẫu ở tầng dữ liệu; đặt **tiêu đề mẫu chính là câu cần gửi**. |
| Bật **Tự động hoá** mà không thấy tin nào tự gửi | Đúng hiện trạng: hai công tắc mới lưu trạng thái, **chưa có engine thực thi**. Dùng **broadcast thủ công** để gửi hàng loạt. |
| Muốn gửi **ZNS/OA** | Chưa hỗ trợ trong phiên bản này. Dùng chat trực tiếp hoặc broadcast qua tài khoản Zalo cá nhân. |
| Đang nhận tin thì **rớt kết nối** | Có thể do nick Zalo đang được mở ở nơi khác (Zalo Web/thiết bị khác). Dùng **nick phụ riêng** cho CRM và chỉ đăng nhập một nơi. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/chat-zalo" app-label="Mở Chat Zalo" fixtures="Vài hội thoại Zalo mẫu + nhãn phân loại (chỉ để xem)" view-only>

Bài này chỉ **xem để định vị** các khu chức năng — sandbox không gửi tin Zalo thật:

1. Mở **Chat Zalo**. Ở đầu **cột danh sách hội thoại**, tìm nút **loa** — đây là nơi mở hộp thoại **Gửi tin hàng loạt (broadcast)**. Bấm để xem cách **lọc theo nhãn**, **tìm** và **Chọn tất cả** (chỉ chọn trong tập đang lọc). Đóng lại mà không gửi.
2. Vẫn ở cột trái, thử **ô lọc theo nhãn** để thấy nhãn phân loại được đọc từ Zalo.
3. Mở một hội thoại bất kỳ, để ý nút **mẫu tin** ở **ô soạn tin** — đây là nơi chèn nhanh câu mẫu.
4. Sang **cột thông tin bên phải**, mở tab **Tự động hoá** để thấy hai công tắc **Gửi ảnh phòng trống** / **Tự động trả lời** và thư viện mẫu tin.

Kết quả mong đợi: bạn biết chính xác **broadcast**, **mẫu tin** và **tự động hoá** nằm ở đâu trong màn Chat Zalo, và nhớ rằng cách gửi hàng loạt thật hiện nay là **broadcast thủ công theo nhãn**.

</SandboxTry>

## Quy trình liên quan

- [Thông báo](/02-theo-doi-nhanh/thong-bao/) — thông báo đẩy (Web Push) khi có tin Zalo mới về.
- [Thu tiền tại phòng (điện thoại)](/03-quan-ly-van-hanh/thu-tien-mobile/) — nút **Zalo** trên từng ô phòng để nhắn nhanh cho khách đại diện.
- [Phân quyền](/05-cai-dat/phan-quyen/) — cấp quyền `chat_zalo` (Xem / Gửi / Quản lý tự động hoá) cho nhân viên.
- [Nhân viên & đội ngũ](/05-cai-dat/nhan-vien-doi-ngu/) — giao phạm vi và tài khoản để nhân viên dùng Chat Zalo.
