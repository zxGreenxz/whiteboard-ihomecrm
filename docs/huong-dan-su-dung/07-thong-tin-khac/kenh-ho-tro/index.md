---
title: "Kênh hỗ trợ"
description: "Cách liên hệ hỗ trợ, dùng sandbox để thử trước và báo lỗi kèm đủ thông tin để được xử lý nhanh."
routes: []
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Kênh hỗ trợ

Trang này giúp bạn tự xử lý nhanh khi gặp vướng mắc và biết cách **báo lỗi đúng cách** để được hỗ trợ hiệu quả. Phần lớn thắc mắc ("sao tôi không thấy nút này?", "số liệu lệch?", "thu tiền không được?") có thể tự giải quyết bằng vài bước kiểm tra bên dưới trước khi cần nhờ đến ai. Khi thật sự cần hỗ trợ, một báo lỗi có **đường dẫn + các bước tái hiện + ảnh chụp** sẽ được xử lý nhanh hơn nhiều so với một câu "hệ thống bị lỗi".

## Thử tự xử lý trước

Làm nhanh 4 bước này — đa số vướng mắc dừng lại ở đây:

1. **Tải lại trang** (F5). Nhiều lỗi hiển thị tạm thời (danh sách trống, số chưa cập nhật) hết ngay sau khi tải lại.
2. **Kiểm tra quyền và phạm vi toà**. Nếu bạn không thấy một nút, một trang hay một số liệu, rất có thể do **quyền** hoặc **phạm vi toà nhà** của tài khoản. Đối chiếu ở trang [Tra quyền nhanh](/07-thong-tin-khac/tra-quyen-nhanh/).
3. **Tra thuật ngữ**. Nếu một nhãn hay trạng thái khó hiểu (ví dụ `ACTIVE`, cọc "giữ chỗ", KQKD), xem [Thuật ngữ](/07-thong-tin-khac/thuat-ngu/).
4. **Đọc câu hỏi thường gặp**. Các tình huống hay gặp và cách xử lý gom tại [Câu hỏi thường gặp](/07-thong-tin-khac/faq/).

::: tip Tái hiện trên sandbox trước khi hỏi
Nếu vẫn chưa rõ, hãy **thử lại đúng thao tác đó trên sandbox** (dữ liệu demo, tách biệt hoàn toàn với số liệu thật). Nếu sandbox chạy đúng còn dữ liệu thật thì không, khả năng cao là do **dữ liệu hoặc quyền** của tài khoản bạn, không phải lỗi phần mềm. Xem mục **Thử trực tiếp trên sandbox** ở cuối trang.
:::

## Cách liên hệ hỗ trợ

Chọn đúng người theo loại vấn đề để khỏi mất thời gian chuyển qua lại:

| Loại vấn đề | Liên hệ ai |
| --- | --- |
| Không thấy nút/trang, không mở được tính năng, thiếu số liệu của một toà | **Chủ nhà / quản trị viên** trong đơn vị bạn — thường là vấn đề **phân quyền** hoặc **phạm vi toà** (xử lý ở [Phân quyền](/05-cai-dat/phan-quyen/), [Nhân viên & Đội ngũ](/05-cai-dat/nhan-vien-doi-ngu/)). |
| Quên mật khẩu, cần tạo/khoá tài khoản nhân viên | **Chủ nhà / quản trị viên** — quản lý tại trang quản trị người dùng. |
| Nghi ngờ lỗi phần mềm: trang trắng, báo lỗi đỏ, thao tác đúng nhưng kết quả sai, số tiền/số liệu lệch không giải thích được | **Nhà cung cấp phần mềm ptcrm** — gửi kèm đủ thông tin ở mục "Khi báo lỗi, hãy gửi kèm" bên dưới. |
| Góp ý tính năng, thắc mắc nghiệp vụ | Trao đổi nội bộ trước; nếu cần thay đổi phần mềm thì chuyển cho nhà cung cấp. |

::: warning Đừng gửi mật khẩu hay ảnh chứa thông tin nhạy cảm
Khi báo lỗi, **không** gửi mật khẩu của bạn cho bất kỳ ai. Trong ảnh chụp màn hình, hãy che các thông tin nhạy cảm không liên quan đến lỗi (số CCCD, số điện thoại khách thật, số dư tài khoản ngân hàng) nếu không cần thiết cho việc xử lý.
:::

## Khi báo lỗi, hãy gửi kèm

Một báo lỗi tốt trả lời được ba câu: **ở đâu**, **làm gì**, **thấy gì**. Cụ thể gửi kèm:

- **Đường dẫn (route)**: sao chép **toàn bộ URL** trên thanh địa chỉ trình duyệt tại màn hình bị lỗi (ví dụ `https://ptcrm.vercel.app/contracts/...`). Đây là thứ giúp người hỗ trợ tới đúng chỗ nhanh nhất.
- **Tài khoản và vai trò** đang đăng nhập lúc gặp lỗi (chủ nhà, quản lý toà, kế toán…) và **toà nhà** liên quan.
- **Các bước tái hiện, đánh số**: liệt kê từng thao tác dẫn tới lỗi. Ví dụ: "1. Vào Thu tiền. 2. Chọn phòng B101. 3. Bấm Thu đủ → hiện lỗi đỏ".
- **Kết quả mong đợi vs kết quả thực tế**: bạn nghĩ sẽ xảy ra gì, và thực tế đã xảy ra gì.
- **Ảnh chụp màn hình** nguyên trạng lỗi (chụp cả thanh địa chỉ nếu được). Nếu có hộp thông báo lỗi, chụp đủ nội dung.
- **Thời điểm** xảy ra (ngày, giờ) — giúp đối chiếu nhật ký.

::: tip Cách lấy thêm lỗi kỹ thuật (không bắt buộc)
Nếu quen thao tác: nhấn **F12** để mở công cụ nhà phát triển, chọn tab **Console**, tái hiện lại lỗi, rồi chụp các dòng chữ **đỏ** hiện ra. Thông tin này giúp nhà cung cấp phần mềm khoanh vùng nguyên nhân rất nhanh.
:::

::: danger Với lỗi liên quan đến tiền, đừng lặp lại thao tác nhiều lần
Nếu lỗi xảy ra khi **thu tiền, chi tiền, bàn giao hoặc thanh lý**, đừng bấm lại nhiều lần vì có thể tạo trùng phiếu vào sổ quỹ. Hãy dừng lại, chụp màn hình, kiểm tra ở [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) xem giao dịch đã ghi hay chưa, rồi mới báo lỗi kèm ảnh.
:::

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/" view-only>

Bài xem: **Trước khi hỏi hỗ trợ, thử tái hiện trên sandbox rồi bấm Reset.**

1. Đăng nhập tài khoản demo và đi tới đúng màn hình bạn nghi ngờ có lỗi (dùng dữ liệu **Tòa DEMO A** / **Tòa DEMO B**).
2. Lặp lại từng bước thao tác giống lúc gặp lỗi trên dữ liệu thật. Vừa làm vừa ghi lại **các bước đã đánh số** — chính là phần bạn sẽ gửi kèm khi báo lỗi.
3. Nếu tái hiện được lỗi ở đây, chụp màn hình và ghi lại **đường dẫn** trên thanh địa chỉ.
4. Xong thì mở trang [Sandbox](/01-bat-dau/sandbox/) và bấm **Reset** để trả dữ liệu demo về gốc cho người sau.

Kết quả mong đợi: bạn có sẵn một bộ mô tả lỗi gọn (đường dẫn + các bước + ảnh) để gửi hỗ trợ; hoặc phát hiện ra thao tác đúng chạy bình thường trên sandbox, nghĩa là vấn đề nằm ở **quyền/dữ liệu** của tài khoản thật chứ không phải phần mềm.

</SandboxTry>

## Quy trình liên quan

- [Sandbox](/01-bat-dau/sandbox/) — môi trường demo để tái hiện lỗi an toàn và nút **Reset**.
- [Câu hỏi thường gặp](/07-thong-tin-khac/faq/) — các tình huống hay gặp và cách tự xử lý.
- [Tra quyền nhanh](/07-thong-tin-khac/tra-quyen-nhanh/) — kiểm tra quyền/phạm vi khi không thấy nút hoặc số liệu.
- [Thuật ngữ](/07-thong-tin-khac/thuat-ngu/) — giải nghĩa nhãn và trạng thái trong hệ thống.
- [Ghi chú phiên bản](/07-thong-tin-khac/ghi-chu-phien-ban/) — kiểm tra tính năng có thay đổi gần đây không.
