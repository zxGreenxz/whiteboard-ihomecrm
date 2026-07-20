---
title: "Câu hỏi thường gặp (FAQ)"
description: "Giải đáp nhanh những điều dễ gây bối rối khi vận hành: cọc không tính doanh thu, hợp đồng gia hạn vẫn ACTIVE, còn nợ nằm ở đâu, làm tròn tiền, phòng tự khoá cọc, nợ cũ, hai kiểu thanh lý, sổ thu tự chọn."
routes: []
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Câu hỏi thường gặp (FAQ)

Trang này gom những câu hỏi bạn hay gặp nhất khi dùng ptcrm — không phải lỗi phần mềm, mà là những chỗ **hệ thống cố tình làm khác** với suy nghĩ trực giác (cọc không phải doanh thu, hợp đồng gia hạn vẫn "đang hiệu lực", phòng tự khoá khi có cọc…). Mỗi câu có một đáp án ngắn kèm link sang trang hướng dẫn chi tiết. Nếu bạn cần tra nghĩa một thuật ngữ, xem thêm [Thuật ngữ](/07-thong-tin-khac/thuat-ngu/).

::: tip Nguyên tắc xuyên suốt cần nhớ
- **Tiền chỉ "có thật" khi phiếu thu/chi đã được Duyệt** — phiếu nháp/chưa duyệt/đã huỷ không vào số dư sổ quỹ và không vào báo cáo.
- **Sổ thu chi (`income_expenses`) là nguồn sự thật duy nhất** cho số dư, dòng tiền và lãi/lỗ. Mọi lần thu tiền hoá đơn đều tự sinh một phiếu thu tương ứng, nên các báo cáo không đếm trùng.
- **Cọc là tiền giữ hộ khách, không phải doanh thu.** Đây là gốc rễ của nhiều câu hỏi bên dưới.
:::

## Tiền cọc, doanh thu & làm tròn

### Vì sao tiền cọc khách nộp không được tính vào doanh thu?

Cọc là khoản **giữ hộ khách**, sẽ hoàn/cấn trừ lúc thanh lý — nên nó **không phải kết quả kinh doanh**. Khi bạn thu một hoá đơn có gộp phần cọc còn thiếu, hệ thống tự **tách phần cọc thành hạng mục riêng "Tiền cọc"** trên phiếu thu và loại phần đó ra khỏi lãi/lỗ (chỉ phần tiền phòng/dịch vụ mới vào kết quả kinh doanh). Tiền cọc được ghi vào sổ ảo **"CỌC (giữ hộ khách)"** và tất toán về 0 cho mỗi hợp đồng khi thanh lý. Xem [Đặt cọc giữ chỗ](/03-quan-ly-van-hanh/dat-coc/) và báo cáo lãi/lỗ đã loại cọc tại [Phân tích tài chính](/04-bao-cao/phan-tich-tai-chinh/).

### Vì sao "Dòng tiền" cao hơn doanh thu trong báo cáo lãi/lỗ?

Vì hai báo cáo đo hai thứ khác nhau. **[Dòng tiền](/04-bao-cao/dong-tien/)** đo **tiền thật vào/ra quỹ theo ngày chứng từ**, nên nó gồm **cả tiền cọc** và cả **cặp phiếu chuyển bàn giao nội bộ** (làm phồng cả Thu lẫn Chi cùng một số). Còn **[Phân tích tài chính](/04-bao-cao/phan-tich-tai-chinh/)** đo **kết quả kinh doanh (KQKD)**: đã loại cọc và phân bổ theo kỳ áp dụng. Vì vậy Thu vào ở Dòng tiền thường **lớn hơn** doanh thu KQKD — không phải sai lệch số liệu.

### Vì sao tổng hoá đơn bị làm tròn? Tiền lẻ vài trăm đồng đi đâu?

Hệ thống **làm tròn phần lẻ dưới 1.000đ về bội số 1.000** cho tổng hoá đơn (ví dụ 1.234.900đ → 1.235.000đ) để tiện thu tiền mặt. Ngoài ra, khi thu tiền còn dư một khoản rất nhỏ (dưới 10.000đ), phần lẻ đó được ghi nhận qua sổ **"Làm tròn tiền thiếu"** để hoá đơn khép về **Đã thanh toán** thay vì treo nợ vài trăm đồng. Đây là hành vi cố ý, không phải mất tiền. Xem [Sinh hoá đơn](/03-quan-ly-van-hanh/sinh-hoa-don/) và [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/).

## Hợp đồng & phòng

### Hợp đồng đã gia hạn sao trạng thái vẫn là "Đang hiệu lực" (ACTIVE)?

Đúng thiết kế. Từ bản 06/2026, **gia hạn hợp đồng được thực hiện tại chỗ và GIỮ nguyên trạng thái ACTIVE** (đổi ngày kết thúc / giá thuê / cọc), không còn trạng thái riêng "EXTENDED" như trước. Việc "đã gia hạn" được thể hiện bằng **nhãn "Đã gia hạn"** trên hợp đồng (suy từ lịch sử gia hạn), chứ không đổi trạng thái. Nhờ vậy một phòng luôn chỉ có đúng một hợp đồng "đang hiệu lực". Xem [Gia hạn / chuyển phòng](/03-quan-ly-van-hanh/gia-han-chuyen-phong/).

### Vì sao phòng tự chuyển "Đã cọc / Giữ chỗ" dù tôi chưa duyệt phiếu?

Ngay khi có **một phiếu cọc giữ chỗ** cho phòng trống, hệ thống tự đặt phòng sang **Đã đặt cọc (RESERVED)** và **ẩn phòng khỏi danh sách phòng trống** ở khắp nơi (Căn hộ/Phòng, Sơ đồ toà nhà, trang công khai) — **kể cả khi phiếu chưa được duyệt**, chỉ trừ phiếu đã huỷ. Bạn không cần chỉnh trạng thái phòng bằng tay: khi phiếu bị **Huỷ** hoặc phiếu cọc được gắn vào hợp đồng, phòng tự cập nhật lại. Lưu ý: hạn "Giữ phòng đến" chỉ là ghi chú — hệ thống **không tự nhả phòng khi hết hạn**; khách bỏ thì bạn Huỷ phiếu. Xem [Đặt cọc giữ chỗ](/03-quan-ly-van-hanh/dat-coc/) và [Căn hộ / Phòng](/03-quan-ly-van-hanh/can-ho-phong/).

### Cọc còn thiếu khi ký hợp đồng thì xử lý sao?

Khi ký, form tính **Cọc còn thiếu = Cọc cần thu − Cọc đã thu**. Nếu còn thiếu, hệ thống **chặn ký** cho tới khi bạn chọn một trong hai cách: **Nợ cọc** (cho khách nợ, kèm lý do và ngày hẹn bổ sung) hoặc **Thu ở hoá đơn đầu** (gộp phần thiếu thành hạng mục "Tiền cọc" trong hoá đơn tháng đầu). Badge ở tab **Đủ / Thiếu cọc** cho biết hợp đồng đang ở cách nào. Xem [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) và [Đặt cọc giữ chỗ](/03-quan-ly-van-hanh/dat-coc/).

## Hoá đơn, thu tiền & công nợ

### Khách trả một phần rồi, phần còn nợ nằm ở đâu?

Sau khi thu một phần, hoá đơn chuyển sang **Thu một phần** và phần còn thiếu = **Tổng hoá đơn − Đã thu**. Số "đã thu" luôn được tính lại từ các phiếu thu đã duyệt (đã trừ tiền thối), nên bạn không sửa tay. Theo dõi và thu nốt ngay trong luồng [Quy trình thu tiền](/01-bat-dau/quy-trinh-thu-tien/) hoặc mở lại [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/).

### Nợ cũ kỳ trước có tự cộng vào hoá đơn tháng sau không?

Có. Khi bạn **sinh hoá đơn kỳ mới**, hệ thống tự **cộng phần nợ chưa trả của (các) kỳ trước** vào hoá đơn tháng này và ghi rõ nguồn nợ được kéo sang. Nhờ vậy khách chỉ cần trả một hoá đơn là dứt điểm cả nợ cũ lẫn tiền kỳ mới. Muốn xem nợ cũ được cộng thế nào, xem [Sinh hoá đơn](/03-quan-ly-van-hanh/sinh-hoa-don/); muốn xử lý số còn phải thu, mở [Quy trình thu tiền](/01-bat-dau/quy-trinh-thu-tien/).

### Khi thu tiền, tiền vào sổ quỹ nào? Vì sao tôi không chọn được sổ?

Ở màn **thu tiền nhanh trên điện thoại** (`/thu-tien`), bạn có thể chọn **TM / TK / TT**; form nhiều dòng cho phép tách nhiều phương thức trong cùng lần thu. Sổ mặc định được resolve theo phương thức: TM ưu tiên sổ **"…Thu"** của bạn rồi **"Chung"**/sổ tên toà; TK/TT dùng sổ mặc định của toà hoặc sổ tên toà. Nếu báo lỗi không tìm thấy sổ, hãy cấu hình sổ phù hợp hoặc nhờ quản trị kiểm tra scope. Xem [Thu tiền trên điện thoại](/03-quan-ly-van-hanh/thu-tien-mobile/) và [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/).

### Bàn giao tiền là gì và khi nào phải nộp?

Tiền mặt bạn thu của khách vẫn đang **bạn cầm** cho tới khi **nộp lên** cấp trên. Thao tác **Bàn giao** tạo một phiên nộp tiền: bạn chọn các phiếu thu gốc rồi gửi cho người nhận (phải **cùng đội**); khi người nhận **Xác nhận**, hệ thống sinh **một phiếu chi trên sổ của bạn + một phiếu thu tổng trên sổ người nhận**, và khoá các phiếu gốc để không sửa/xoá. Số bạn **còn phải nộp** chính là số dư sổ bạn đang giữ. Xem [Bàn giao & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/) và báo cáo chu kỳ [Thu — Bàn giao](/04-bao-cao/thu-ban-giao/).

## Thanh lý & phân quyền

### Thanh lý "trả cọc" (move-out) và "bỏ cọc" (forfeit) khác nhau thế nào?

Hai kiểu khác nhau ở **số phận của tiền cọc**:

- **Thanh lý trả khách (move-out):** khách rời phòng đúng thoả thuận. Hệ thống **cấn trừ cọc + tiền thừa vào nợ và các khoản thu thêm** (tiền phòng lẻ ngày, chốt điện cuối kỳ, phí khác); phần cấn trừ ghi thành **"Doanh thu thanh lý" (có vào kết quả kinh doanh)**, phần **ròng còn lại thì trả khách** (nếu dư cọc) hoặc **thu thêm của khách** (nếu thiếu). Sổ CỌC tất toán về 0.
- **Bỏ cọc (forfeit):** khách vi phạm / bỏ ngang, **mất cọc**. Cọc thực thu **trở thành doanh thu**, hệ thống dùng khoản cọc này gạch **Đã thanh toán** cho hoá đơn thanh lý; **các hoá đơn nợ cũ bị HUỶ**. Cần **Duyệt** phiếu thì việc bỏ cọc mới hoàn tất.

Xem [Thanh lý trả khách (move-out)](/03-quan-ly-van-hanh/thanh-ly-move-out/) và [Bỏ cọc (forfeit)](/03-quan-ly-van-hanh/thanh-ly-forfeit/).

::: warning Bỏ cọc là thao tác khó hoàn tác
Bỏ cọc **huỷ các hoá đơn nợ cũ** và biến cọc thành doanh thu sau khi duyệt. Hãy chắc chắn đã chốt điện/nước và các khoản thu thêm trước khi thực hiện — làm sai thì việc dựng lại hiện trạng rất mất công.
:::

### Là nhân viên, vì sao tôi không thu được tiền hoặc không thấy phòng của toà khác?

Nhân viên chỉ thấy và thao tác trên **các toà được gán phạm vi** cho mình; toà ngoài phạm vi sẽ không hiện trong danh sách và ô lọc. Ngoài ra mỗi hành động (tạo hợp đồng, thu tiền, duyệt phiếu…) còn cần **quyền tương ứng**. Nếu một trang trống trơn hoặc một nút bị ẩn/mờ, thường là do **phạm vi toà** hoặc **thiếu quyền**, chứ không phải lỗi. Nhờ chủ nhà kiểm tra tại [Phân quyền](/05-cai-dat/phan-quyen/) và [Nhân viên & đội ngũ](/05-cai-dat/nhan-vien-doi-ngu/). Cũng nên kiểm tra ô lọc toà còn dính giá trị cũ (bộ lọc được giữ qua F5).

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/" app-label="Mở sandbox demo" view-only>

Bài này **chỉ để khám phá** — bạn dạo quanh dữ liệu mẫu để đối chiếu các câu trả lời ở trên:

1. Vào [Đặt cọc giữ chỗ](/03-quan-ly-van-hanh/dat-coc/) và [Căn hộ / Phòng](/03-quan-ly-van-hanh/can-ho-phong/): thấy phòng có cọc đã tự chuyển **Đã cọc / Giữ chỗ** và biến khỏi danh sách phòng trống.
2. Mở [Dòng tiền](/04-bao-cao/dong-tien/) rồi [Phân tích tài chính](/04-bao-cao/phan-tich-tai-chinh/): so hai con số và thấy Dòng tiền (gồm cọc) **cao hơn** doanh thu kết quả kinh doanh.
3. Gặp tình huống lạ? Tra FAQ này hoặc bấm **Reset sandbox** để làm lại từ đầu với dữ liệu mẫu sạch (Tòa **DEMO A / DEMO B**).

Kết quả mong đợi: bạn nhận ra hầu hết "điều lạ" đều là hành vi cố ý của hệ thống, và biết trang nào để xem chi tiết.

</SandboxTry>

## Quy trình liên quan

- [Thuật ngữ](/07-thong-tin-khac/thuat-ngu/) — tra nhanh nghĩa các từ chuyên môn dùng trong FAQ này.
- [Giới thiệu hệ thống](/01-bat-dau/gioi-thieu/) — bản đồ 7 khu chức năng và vòng đời nghiệp vụ tổng quát.
- [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/) — từ khách hẹn, đặt cọc đến ký hợp đồng và vận hành.
- [Quy trình thanh lý](/01-bat-dau/quy-trinh-thanh-ly/) — bức tranh tổng hai kiểu thanh lý trả cọc và bỏ cọc.
- [Bàn giao & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/) — nộp tiền mặt lên cấp trên và chốt số sổ.
- [Sandbox demo](/01-bat-dau/sandbox/) — cách vào môi trường thử và nút Reset sandbox.
