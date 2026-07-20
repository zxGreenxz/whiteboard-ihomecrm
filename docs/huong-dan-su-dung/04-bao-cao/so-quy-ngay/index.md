---
title: "Báo cáo: Sổ quỹ theo ngày"
description: "Xem số dư từng sổ quỹ theo ngày (as-of): số dư đầu ngày, tổng thu, tổng chi trong ngày và tồn cuối ngày, lọc theo tòa và tài khoản."
routes: ["/reports/finance/daily-cashbook"]
permissions: [{module: reports_finance, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Sổ quỹ theo ngày

Báo cáo **Sổ quỹ theo ngày** (trong ứng dụng hiển thị nhãn **Tài khoản theo ngày**) cho bạn biết một **sổ quỹ** đang có bao nhiêu tiền tại **bất kỳ ngày nào** trong kỳ, và mỗi ngày tiền vào/ra bao nhiêu. Mỗi dòng là một **ngày**, với **Số dư đầu ngày**, **Tổng thu**, **Tổng chi** phát sinh trong ngày và **Tồn cuối ngày** — chính là **số dư as-of** (số dư tính đến hết ngày đó). Đây là màn **chỉ để xem**: bạn không ghi tiền ở đây.

Ai nên xem: **chủ nhà** muốn nắm dòng tiền hằng ngày, **kế toán** cần đối chiếu số dư một sổ tại một mốc ngày cụ thể, và **quản lý tòa** muốn kiểm tra tiền thu/chi trong ngày của tòa mình. Vì báo cáo lấy đúng một nguồn duy nhất là sổ cái thu chi (`income_expenses`), số liệu ở đây khớp với sổ quỹ thật — không phải con số nhanh ước lượng như thẻ KPI trên trang chủ.

::: info Điều kiện tiên quyết
- Quyền **Báo cáo tài chính => Xem** (module `reports_finance`, action `view`; báo cáo này là feature key `daily_cashbook`) để mở màn hình.
- Đã có ít nhất một **sổ quỹ** (tài khoản) và các **phiếu thu/chi đã duyệt** — báo cáo chỉ cộng phiếu có trạng thái **Đã duyệt**, phiếu nháp không được tính.
- **Nhân viên** chỉ thấy phiếu của các **tòa trong phạm vi** được giao; chủ nhà và super admin thấy toàn bộ.
:::

## Cách mở

**Bước**: Vào menu **Báo cáo** => nhóm **Tài chính** => **Tài khoản theo ngày** (chính là báo cáo Sổ quỹ theo ngày). Màn hình mở ra với ba bộ lọc ở đầu trang (**Tòa nhà**, **Tài khoản**, **Khoảng thời gian**) và một bảng liệt kê từng ngày trong kỳ. Mặc định kỳ xem là **từ đầu tháng đến hôm nay**.

![Màn hình báo cáo](./images/buoc-01-man-hinh.webp)

## Bộ lọc & cách đọc số

Ở đầu trang có ba bộ lọc; cả **Tòa nhà** và **Tài khoản** đều được lọc **ngay trên máy chủ** (chọn xong báo cáo tự tính lại), nên số dư luôn đúng theo phạm vi bạn chọn.

| Cột / Chỉ số | Ý nghĩa |
| --- | --- |
| Bộ lọc **Tòa nhà** | Chọn một tòa (đơn-chọn) hoặc **Tất cả tòa nhà**. Danh sách gồm cả **tòa ảo "Chung"** (nơi ghi các phiếu không thuộc tòa cụ thể). Chọn một tòa thì báo cáo chỉ tính phiếu của tòa đó. |
| Bộ lọc **Tài khoản** | Chọn một **sổ quỹ** cụ thể (ví dụ *DEMO A Thu*, sổ chuyển khoản…) hoặc **Tất cả tài khoản**. Đây là "sổ quỹ" mà bạn muốn soi số dư theo ngày. Cột **Tài khoản** trong bảng hiển thị tên sổ đang lọc (hoặc "Tất cả"). |
| Bộ lọc **Khoảng thời gian** | Chọn **từ ngày — đến ngày**. Bảng liệt kê mỗi ngày trong khoảng này thành một dòng, kể cả ngày không có giao dịch. |
| Cột **Ngày** | Ngày của dòng (định dạng dd-mm-yyyy). |
| Cột **Số dư đầu ngày** | Số tiền còn trong sổ **lúc bắt đầu ngày** đó. Với dòng đầu tiên của kỳ, đây là **số dư đầu kỳ** = tổng thu trừ tổng chi của **mọi phiếu đã duyệt có ngày chứng từ trước ngày bắt đầu** (cộng dồn từ đầu, không chỉ trong tháng). Các ngày sau lấy **Tồn cuối ngày** của ngày liền trước. |
| Cột **Tổng thu** | Tổng tiền các **phiếu thu (INCOME) đã duyệt** có ngày chứng từ đúng bằng ngày đó, trong phạm vi tòa/tài khoản đã lọc. Hiển thị màu xanh. |
| Cột **Tổng chi** | Tổng tiền các **phiếu chi (EXPENSE) đã duyệt** cùng ngày. Hiển thị màu đỏ. |
| Cột **Tồn cuối ngày** | **Số dư as-of** cuối ngày = Số dư đầu ngày + Tổng thu − Tổng chi. Đây là con số bạn dùng để nói "cuối ngày X, sổ này còn bấy nhiêu tiền". Dòng cuối bảng chính là **số dư hiện tại** của sổ tại cuối kỳ. |

::: tip Cách đọc cho đúng
- **Phiếu chuyển bàn giao nội bộ CÓ được tính** ở báo cáo này — vì nó thật sự dịch tiền: khi bàn giao, tiền rời **sổ Thu** và vào **sổ nhận**, nên **Tồn cuối ngày** của sổ Thu giảm đúng bằng số đã nộp. (Khác với báo cáo [Bàn giao & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/) — nơi cố tình loại cặp phiếu chuyển này để không đếm doanh thu hai lần.)
- **Tiền thối** trả khách đã được **net (trừ sẵn) trong tổng thu**, và **làm tròn tiền thiếu** ghi vào sổ riêng — nên số dư ở đây đã là số ròng, đừng cộng/trừ tay lần nữa.
- **Tiền cọc** khách nộp vẫn nằm trong số dư sổ thật (nên có mặt trong Tồn cuối ngày), dù phần cọc không tính vào kết quả kinh doanh. "Số dư sổ" là **tiền mặt/tài khoản đang có**, khác với doanh thu.
:::

## Nguồn số liệu

Báo cáo lấy **đúng một nguồn duy nhất**: sổ cái thu chi `income_expenses`, chỉ cộng các phiếu **Đã duyệt** và **chưa xóa**. Vì mỗi lần thu tiền hóa đơn đều tự sinh một dòng tương ứng trong sổ cái này, nên **thu tiền hóa đơn cũng nằm trong báo cáo** — bạn **không** cần (và hệ thống cũng không) cộng thêm bảng phiếu thu/chi riêng, tránh đếm trùng.

- **Số dư đầu kỳ** (số dư đầu ngày của dòng đầu tiên) được tính bằng một hàm tổng hợp trên máy chủ, cộng dồn toàn bộ phiếu đã duyệt có ngày chứng từ **trước** ngày bắt đầu — trả về đúng một con số thay vì kéo cả lịch sử về máy bạn.
- **Số dư từng ngày** = số dư đầu kỳ, rồi cộng dồn Tổng thu và trừ Tổng chi của từng ngày theo thứ tự thời gian.
- Bộ lọc **Tòa nhà** và **Tài khoản** áp dụng cho **cả kỳ hiện tại lẫn số dư đầu kỳ**, nên đổi bộ lọc là toàn bộ con số (kể cả số dư mở đầu) tính lại cho đúng.

Chi tiết nghiệp vụ sổ quỹ và loại thu chi xem trang [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/).

## Xuất & mẹo

- Màn hình này **chưa có nút xuất file** riêng. Muốn lưu lại, bạn có thể **in/lưu PDF** từ trình duyệt (Ctrl/Cmd + P) hoặc chụp màn hình bảng.
- **Muốn nhìn theo tháng/quý** thay vì từng ngày: dùng báo cáo [Dòng tiền](/04-bao-cao/dong-tien/) — cùng nguồn sổ cái nhưng gom 12 tháng và 4 quý.
- **Muốn biết "tiền đã thu còn phải nộp"** cho từng người đi thu: xem [Bàn giao & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/) — nơi hiển thị *Còn phải nộp* và cho **chốt số** theo ngày as-of.
- **Bộ lọc được giữ qua F5**: tòa, tài khoản và khoảng thời gian bạn chọn sẽ được nhớ khi tải lại trang trong cùng phiên làm việc.
- Nếu bảng báo **"Không có dữ liệu nào để hiển thị"**: kiểm tra lại **khoảng thời gian**, đảm bảo sổ có **phiếu đã duyệt** (phiếu nháp không tính), và bộ lọc **tòa/tài khoản** không quá hẹp.

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/reports/finance/daily-cashbook" view-only>

Bài này **chỉ xem** — bạn quan sát số dư sổ quỹ theo ngày, không ghi tiền:

1. Ở bộ lọc **Tài khoản**, chọn sổ **DEMO A Thu**; ở **Tòa nhà** để **Tất cả tòa nhà**; chọn **Khoảng thời gian** phủ tháng 7/2026.
2. **Hãy nhìn thấy** mỗi ngày là một dòng, với **Số dư đầu ngày**, **Tổng thu**, **Tổng chi** và **Tồn cuối ngày**. Tìm ngày khách **Nguyễn Văn A** nộp **1.000.000đ** — cột **Tổng thu** ngày đó tăng đúng **1.000.000đ** và **Tồn cuối ngày** nhích lên tương ứng.
3. **Hãy nhìn thấy** rằng **Tồn cuối ngày** của một ngày trở thành **Số dư đầu ngày** của ngày kế tiếp — số dư cộng dồn liên tục.
4. Đổi bộ lọc **Tòa nhà** sang **Tòa DEMO B** và quan sát các con số (kể cả số dư đầu kỳ) tính lại theo đúng phạm vi tòa.

Kết quả mong đợi: bạn hiểu **Tồn cuối ngày = số dư sổ quỹ tính đến hết ngày (as-of)**, biết mỗi ngày tiền vào/ra bao nhiêu, và thấy số dư cộng dồn từ số dư đầu kỳ.

</SandboxTry>

## Quy trình liên quan

- [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) — quản lý từng sổ quỹ, số dư và khóa sổ; nguồn của các con số trong báo cáo này.
- [Thu chi](/03-quan-ly-van-hanh/thu-chi/) — danh sách phiếu thu/chi (đã duyệt) tạo nên Tổng thu / Tổng chi từng ngày.
- [Thu tiền hóa đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) — ghi nhận thanh toán hóa đơn (TM/TK/TT) sinh ra phiếu thu vào sổ.
- [Dòng tiền](/04-bao-cao/dong-tien/) — cùng nguồn sổ cái, gom theo tháng và quý.
- [Bàn giao tiền & đối soát chốt sổ](/03-quan-ly-van-hanh/ban-giao-doi-soat/) — theo dõi tiền đã thu còn phải nộp và chốt số dư sổ theo ngày.
- [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/) — cấu hình sổ thu, sổ thối, sổ làm tròn và các loại thu chi.
- [Quy trình thu tiền](/01-bat-dau/quy-trinh-thu-tien/) — bức tranh tổng quát từ thu tiền tới sổ quỹ.
- [Quy trình bàn giao](/01-bat-dau/quy-trinh-ban-giao/) — thu → bàn giao → chốt sổ.
