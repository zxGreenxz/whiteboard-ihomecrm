---
title: "Chia lợi nhuận cổ đông"
description: "Khai tỷ lệ cổ phần theo toà, chốt-khoá lợi nhuận từng tháng (đã trừ lương điều hành) rồi chia và chi tiền cho cổ đông."
routes: ["/reports/finance/profit-distribution"]
permissions: [{module: shareholder_profit, action: view}]
viewport: desktop
audience: [chu-nha, co-dong]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Chia lợi nhuận cổ đông

Khi một toà nhà thuộc sở hữu chung của nhiều người góp vốn, câu hỏi lặp đi lặp lại mỗi tháng là: *"Toà này tháng vừa rồi lãi bao nhiêu, mỗi cổ đông được chia bao nhiêu, đã ứng bao nhiêu, còn nợ bao nhiêu?"*. Trang này trả lời trọn vẹn câu hỏi đó theo bốn lớp: **khai tỷ lệ cổ phần theo toà** → **chốt-khoá lợi nhuận từng tháng** (đã trừ lương điều hành trước khi chia) → **chia theo tỷ lệ và chi tiền** cho cổ đông → **cổ đông tự theo dõi phần của mình**. Bạn (chủ nhà / quản lý) thao tác ở các tab quản trị; cổ đông đăng nhập chỉ nhìn thấy đúng phần lợi nhuận của họ.

Nguyên tắc cốt lõi cần nhớ: **Được chia của một cổ đông = (LN sau điều chỉnh − Lương điều hành) × tỷ lệ % của họ tại toà đó**. Số này được **chốt-khoá thành ảnh chụp bất biến** tại thời điểm bạn bấm chốt — về sau có sửa tỷ lệ cũng không đổi số đã chốt, trừ khi bạn mở khoá rồi chốt lại.

::: info Điều kiện tiên quyết
- Quyền **Chia lợi nhuận** (`shareholder_profit`) mức quản lý (chủ nhà thường có đủ `view / lock / unlock / distribute / manage_shareholders`). Cổ đông thuần chỉ có `view` — xem phần mình, không thấy tab quản trị.
- Đã có toà nhà thật (xem [Tạo toà nhà](/01-bat-dau/tao-toa-nha/)) và đã khai **cổ đông + tỷ lệ %** ở tab **Cổ đông & tỷ lệ**.
- Nên **chốt số tháng vận hành trước** (thu/chi của tháng đã đủ và chính xác) để lợi nhuận tính ra đúng — xem [Quy trình chốt tháng](/01-bat-dau/quy-trinh-chot-thang/).
- Hệ thống cần có sẵn **toà ảo "Chung"** (được tạo tự động) để hạch toán các phiếu chi chia lợi nhuận.
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Tài chính** => **Chia lợi nhuận**. Màn **Phân bổ & chia lợi nhuận** mở ra với một hàng tab phẳng. Tuỳ quyền của bạn mà thấy các tab: **Phân bổ lợi nhuận** (báo cáo lãi/lỗ theo phiếu), **Tổng quan** (theo dõi được-chia / đã-ứng / còn-phải-trả), **Chốt LN tháng** (chốt-khoá lợi nhuận), **Cổ đông & tỷ lệ** (khai cổ đông và %). Cổ đông đăng nhập không thấy các tab này — họ vào thẳng màn chỉ-xem phần của mình.

![Màn Phân bổ và chia lợi nhuận cổ đông với 4 tab, ba thẻ tổng Doanh thu / Chi phí / Lợi nhuận và sổ phân bổ hai cột Khoản thu | Khoản chi](./images/buoc-01-man-hinh.webp)

**Bước 2**: Xem **tỷ lệ cổ đông theo toà**. Mở tab **Cổ đông & tỷ lệ**. Mỗi cổ đông là một thẻ, gồm tên, badge tài khoản đăng nhập (xanh = đã gắn tài khoản để tự xem; vàng = chưa gắn, cổ đông chưa đăng nhập được) và các badge dạng **"Toà — %"**. Trong dữ liệu demo, **Tòa DEMO A** có hai cổ đông: **DEMO Cổ Đông Xuân 60%** và **DEMO Cổ Đông Yến 40%**. Tổng % của một toà **không bắt buộc bằng 100%** — phần thiếu (nếu có) ngầm hiểu là của chủ nhà và hệ thống không tạo phần chia cho phần đó.

**Bước 3**: Xem **lợi nhuận phân bổ theo tháng**. Mở tab **Chốt LN tháng** rồi chọn **tháng/năm**. Bảng **LN theo nhà** liệt kê từng toà với các cột: **Doanh thu**, **Chi phí**, **LN tự tính** (hệ thống tính theo số dồn tích, khớp báo cáo Phân bổ lợi nhuận), ô **LN sau điều chỉnh** (bạn được sửa tay để trừ thêm chi phí ngoài sổ), **Lương điều hành** (khoản trừ trước khi chia, theo quy tắc lương đã khai — nếu chưa khai người quản lý điều hành nào thì bằng **0đ**), và **LN chia cổ đông** = **LN sau điều chỉnh − Lương điều hành** (đỏ nếu âm). Khối **Xem trước chia cho cổ đông** ngay dưới cho bạn thấy trước mỗi người sẽ nhận bao nhiêu theo % hiện tại — đây mới là số *xem trước*, chưa ghi.

::: danger Chốt lợi nhuận là thao tác tiền — chỉ chốt khi số của tháng đã đúng
Bấm chốt sẽ **đóng băng con số mỗi cổ đông được chia** (ảnh chụp bất biến) và là căn cứ để chi tiền thật cho họ. Trước khi chốt, hãy chắc chắn thu/chi của tháng đã đủ, **LN sau điều chỉnh** đúng ý, và tỷ lệ % ở tab Cổ đông & tỷ lệ chính xác. Cổ đông chỉ có quyền `shareholder_profit.view` — họ **xem** phần mình chứ không chốt được; mọi thao tác chốt/mở khoá/chi tiền đều do bạn (quản lý) thực hiện.
:::

**Bước 4**: **Chốt một tháng**. Ở tab **Chốt LN tháng**, sau khi rà xong, bấm **"Chốt tháng MM/YYYY"**. Hệ thống làm tuần tự: tính lương điều hành và **trừ trước**, rồi chia phần còn lại (**distributable = LN sau điều chỉnh − Lương điều hành**) theo % cổ đông và **chụp ảnh** vào từng dòng. Toà-tháng chuyển trạng thái **Đã chốt (LOCKED)**. Lúc này số "Được chia" của mỗi cổ đông đã cố định, không đổi dù sau này bạn sửa tỷ lệ. Lưu ý: nút Chốt áp cho **tất cả các toà** trong bảng cùng lúc, không chốt lẻ từng toà.

**Bước 5**: **Mở khoá một tháng** (khi cần sửa). Trên dòng toà **Đã chốt**, bấm nút **mở khoá** (biểu tượng ổ khoá mở). Tháng đó về trạng thái **Nháp**, các con số "Được chia" đã chụp bị **xoá sạch**, và cổ đông tạm thời không còn thấy tháng này ở màn của họ. Sửa xong (đổi %, đổi LN sau điều chỉnh, khai lương điều hành...) thì bấm **Chốt tháng** lại để chụp ảnh mới.

::: warning Mở khoá xoá sạch số đã chốt — cân nhắc trước khi bấm
Mở khoá **xoá toàn bộ phần chia đã chụp** của tháng đó (cả phần cổ đông lẫn phần lương điều hành) và đưa về nháp. Nếu bạn chỉ mở khoá để xem lại rồi chốt lại, hãy nhớ **các toà khác cũng bị chụp lại theo tỷ lệ hiện tại** khi bấm Chốt — nếu tỷ lệ đã đổi từ lần chốt trước, số "bất biến" của những toà không liên quan cũng âm thầm thay đổi. Chỉ mở khoá khi thực sự cần chỉnh số của tháng.
:::

**Bước 6**: **Chi tiền cho cổ đông** và theo dõi công nợ. Mở tab **Tổng quan**. Bảng **Theo cổ đông (luỹ kế)** hiển thị ba cột **Được chia** (tổng đã chốt) − **Đã ứng** (tổng đã trả) = **Còn lại**. Bấm **"Chi lợi nhuận"** (hoặc nút **"Chi"** trên dòng một cổ đông) để mở hộp thoại: chọn **cổ đông**, nhập **số tiền**, chọn **sổ quỹ** nguồn, **ngày** và **ghi chú**. Khi lưu, hệ thống tạo **một phiếu chi** thực (loại EXPENSE) gắn với cổ đông đó, hạch toán vào **toà ảo "Chung"** và **không tính vào kết quả kinh doanh (KQKD)** của toà — nên chi lợi nhuận không tự trừ ngược vào lãi của toà. Cột **Đã ứng** tăng ngay, **Còn lại** giảm tương ứng.

::: danger Chi lợi nhuận là chi tiền thật — không hoàn tác tự động
Mỗi lần "Chi lợi nhuận" tạo ra một **phiếu chi tiền thật** làm giảm số dư sổ quỹ bạn chọn. Hộp thoại **không** cảnh báo khi số chi vượt phần "Còn lại" — nếu lỡ chi vượt, cột **Còn lại** sẽ hiện số **âm màu đỏ**. Phiếu này xuất hiện luôn ở màn [Thu chi](/03-quan-ly-van-hanh/thu-chi/); xoá/huỷ nó ở đó sẽ làm cột "Đã ứng" tụt lại mà trang này không báo. Kiểm tra kỹ cổ đông, số tiền và sổ quỹ trước khi lưu.
:::

## Các tính năng khác trên màn hình

| Tab / Nút | Công dụng |
| --- | --- |
| Tab **Phân bổ lợi nhuận** | Báo cáo lãi/lỗ theo tháng (Doanh thu − Chi phí = Lợi nhuận) theo từng phiếu/kỳ — dùng để **đối chiếu trước khi chốt**. Khác với LN đã-chốt-snapshot ở tab Chốt LN. |
| Tab **Tổng quan** | KPI **Tổng LN đã chốt / Được chia / Đã ứng / Còn phải trả**, biểu đồ, ma trận Nhà × Tháng và bảng theo cổ đông kèm nút **Chi lợi nhuận**. |
| Tab **Chốt LN tháng** | Bảng LN theo nhà, ô **LN sau điều chỉnh**, chốt/mở khoá từng tháng. |
| Tab **Cổ đông & tỷ lệ** | Khai cổ đông + tỷ lệ % theo toà (nút **Sửa/Xoá**), gắn tài khoản đăng nhập, và khai **Quản lý điều hành** + quy tắc lương. |
| Bộ lọc **năm / tháng / cổ đông** (tab Tổng quan) | Chọn một cổ đông để thu KPI, biểu đồ và ma trận về phần riêng người đó. |
| Nút **"Chốt lại N tháng đã chốt"** | Đồng bộ lại mọi tháng đã chốt theo số thu/chi mới (khi bạn sửa/bổ sung phiếu quá khứ), giữ nguyên các ô **LN sau điều chỉnh** đã sửa tay. |
| Khu **Lương điều hành** + nút **"Chi lương điều hành"** | Theo dõi và chi tiền cho người quản lý điều hành toà góp vốn (khoản đã trừ trước khi chia cổ đông). |
| Toggle **"Hiện cả khoản không hạch toán KQKD (cọc…)"** (tab Phân bổ) | Bật để soi cả các khoản không tính lãi/lỗ như tiền cọc; mặc định tắt (chỉ hiện phần vào KQKD). |
| Toggle **"Phân bổ theo kỳ áp dụng"** (tab Phân bổ) | Bật (mặc định) để chia đều tiền theo kỳ áp dụng của từng khoản; tắt thì ghi theo ngày phiếu. |
| Nút **"Cột"** (tab Phân bổ) | Ẩn/hiện cột và bật/tắt hiển thị thẻ tổng, số tổng, hạng mục đặc biệt (lưu theo từng người, giữ qua F5). |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Cổ đông đăng nhập không thấy tab **Tổng quan / Chốt LN / Cổ đông & tỷ lệ** | Đúng thiết kế: cổ đông chỉ có quyền `shareholder_profit.view` → chỉ thấy màn chỉ-xem phần của mình. Muốn xem thêm phải cấp quyền, không mở thêm module khác. |
| Đã chốt xong rồi sửa tỷ lệ % nhưng số "Được chia" không đổi | Số đã chốt là **ảnh chụp bất biến**. Muốn cập nhật phải **mở khoá** tháng đó rồi **Chốt** lại (Bước 5 → Bước 4). |
| Cột **Còn lại** của một cổ đông ra số **âm màu đỏ** | Bạn đã chi (Đã ứng) **vượt** phần Được chia. Rà lại các phiếu chi gắn cổ đông đó ở màn Thu chi, hoặc chốt thêm lợi nhuận nếu thiếu. |
| Bấm **Chi lợi nhuận** báo lỗi thiếu toà ảo **"Chung"** | Hệ thống cần toà ảo `Chung` để hạch toán phiếu chia lợi nhuận. Liên hệ quản trị để khởi tạo/khôi phục toà ảo này rồi thử lại. |
| **LN chia cổ đông** ra số âm ở tab Chốt LN | **LN sau điều chỉnh − Lương điều hành** đang âm (chi phí/lương vượt lãi). Rà lại ô LN sau điều chỉnh và quy tắc lương điều hành trước khi chốt. |
| Cột **Đã ứng** tự tụt xuống dù không thao tác trên trang này | Một phiếu chi chia lợi nhuận đã bị **xoá/huỷ** ở màn [Thu chi](/03-quan-ly-van-hanh/thu-chi/). Đó là phiếu thu chi bình thường nên sửa/xoá được từ bên đó. |
| Cổ đông có badge **vàng** ("chưa gắn tài khoản") | Cổ đông chưa được gắn tài khoản đăng nhập nên chưa tự xem được. Tạo user ở **Quản trị → Người dùng** rồi vào **Sửa** cổ đông để gắn. |
| Ô **LN sau điều chỉnh** đang gõ dở bị nhảy về số mặc định | Bảng tự nạp lại khi dữ liệu nền refetch hoặc sau khi mở khoá một toà. Chốt/sửa xong từng phần rồi hãy chuyển thao tác khác để tránh mất số đang gõ. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/reports/finance/profit-distribution" app-label="Mở màn Chia lợi nhuận" fixtures="2 cổ đông: DEMO Cổ Đông Xuân 60% + DEMO Cổ Đông Yến 40% trên Tòa DEMO A">

1. Mở tab **Cổ đông & tỷ lệ**: xem hai thẻ cổ đông và badge tỷ lệ — **Xuân 60%** và **Yến 40%** tại **Tòa DEMO A**. Để ý phần còn thiếu so với 100% ngầm hiểu là của chủ nhà.
2. Sang tab **Chốt LN tháng**, chọn **tháng 07-2026**. Đọc bảng LN theo nhà: **Doanh thu**, **Chi phí**, **LN tự tính**, **LN chia cổ đông**. Xem khối **Xem trước chia cho cổ đông** để hình dung Xuân/Yến nhận bao nhiêu theo tỷ lệ.
3. Bấm **"Chốt tháng 07/2026"** → dòng toà chuyển **Đã chốt**. Mở tab **Tổng quan** để thấy cột **Được chia** vừa xuất hiện cho Xuân và Yến theo đúng 60/40.
4. Quay lại tab **Chốt LN tháng**, bấm nút **mở khoá** trên dòng vừa chốt → tháng về **Nháp**, số Được chia biến mất. Đây chính là cặp thao tác chốt/mở khoá bạn cần nắm.

Kết quả mong đợi: bạn hiểu lợi nhuận được **chia theo đúng tỷ lệ góp vốn** (Xuân 60% / Yến 40%), rằng con số chỉ "thật" sau khi **chốt-khoá**, và rằng **mở khoá** đưa tháng về nháp để sửa lại.

</SandboxTry>

<SandboxTry account="demo.codong" app-path="/reports/finance/profit-distribution" app-label="Xem với vai cổ đông" fixtures="Đăng nhập là một cổ đông của Tòa DEMO A" view-only>

Đăng nhập bằng tài khoản **cổ đông** (chỉ có quyền `shareholder_profit.view`). Bạn **không** thấy các tab quản trị — thay vào đó là màn chỉ-xem: 4 KPI (Được chia luỹ kế / Đã ứng / Còn lại / LN năm chọn), biểu đồ lợi nhuận theo tháng và theo nhà, ma trận Nhà × Tháng, và bảng "Lịch sử đã ứng/đã lấy" — **tất cả chỉ là phần của riêng bạn**, không thấy số của cổ đông khác.

</SandboxTry>

## Quy trình liên quan

- [Quy trình chốt tháng](/01-bat-dau/quy-trinh-chot-thang/) — chốt số thu/chi vận hành cho đúng *trước khi* chốt lợi nhuận chia cổ đông.
- [Thu chi](/03-quan-ly-van-hanh/thu-chi/) — phiếu chi chia lợi nhuận và lương điều hành là phiếu thu chi bình thường, sửa/xoá được từ đây.
- [Sổ quỹ (vận hành)](/03-quan-ly-van-hanh/so-quy/) — sổ quỹ nguồn của phiếu chi lợi nhuận; số dư giảm khi bạn chi cho cổ đông.
- [Ví cá nhân](/03-quan-ly-van-hanh/vi-ca-nhan/) — sổ thu chi riêng của cổ đông, có banner "Từ công ty: Được chia / Đã ứng / Còn lại được nhận" để tự đối chiếu.
- [Bảng lương](/03-quan-ly-van-hanh/bang-luong/) — lương nhân viên vận hành; khác với **lương điều hành** ở đây (khoản trừ khỏi lợi nhuận trước khi chia cổ đông).
