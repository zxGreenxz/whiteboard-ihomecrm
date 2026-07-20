---
title: "Báo cáo: Phân tích tài chính"
description: "Bảng phân tích 5 tab: kết quả kinh doanh (P&L), cơ cấu thu chi, phát hành vs thực thu, lấp đầy và công nợ theo tuổi — gom 13 tháng để so cùng kỳ năm trước."
routes: ["/reports/finance/analysis"]
permissions: [{module: reports_finance, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Phân tích tài chính

Đây là báo cáo tổng hợp sâu nhất về "sức khoẻ tài chính" của các toà bạn quản lý. Thay vì đọc từng phiếu thu chi hay từng hoá đơn, trang này gom **13 tháng gần nhất** rồi dựng sẵn năm góc nhìn: **kết quả kinh doanh (P&L/KQKD)**, **cơ cấu thu chi theo hạng mục**, **phát hành hoá đơn so với thực thu**, **tỷ lệ lấp đầy** và **công nợ phải thu theo tuổi nợ**, kèm một bảng **insight** tự rút nhận xét. Vì cửa sổ dữ liệu là 13 tháng (bắt đầu từ đúng tháng này năm ngoái), bạn đọc được xu hướng và so **cùng kỳ năm trước (YoY)** ngay trên biểu đồ.

Trang này chủ yếu để **xem và đối chiếu** — không có nút ghi tiền, không sửa được số. Đối tượng dùng: **chủ nhà** muốn nhìn bức tranh lãi/lỗ toàn danh mục, **kế toán** cần đối chiếu doanh thu ghi nhận với tiền thực thu, và **quản lý toà** theo dõi lấp đầy cùng công nợ khu vực mình phụ trách. Một điểm cốt lõi phải nhớ khi đọc con số: **tiền cọc KHÔNG được tính là doanh thu**. Phần P&L cộng theo `kqkd_amount` (giá trị tính vào kết quả kinh doanh ở mức từng hạng mục), nên một phiếu thu gộp cả cọc chỉ tính phần *không phải cọc* vào doanh thu — cọc chảy vào sổ cọc chứ không làm phồng lãi.

::: info Điều kiện tiên quyết
- Tài khoản có quyền xem **Báo cáo tài chính** (module `reports_finance`, feature key `reports_finance.analysis`). Chủ nhà thường có đủ; nhân viên phải được cấp riêng feature key này.
- Đã có phát sinh thật để phân tích: phiếu thu chi đã **duyệt**, hoá đơn đã phát hành, hợp đồng đang hiệu lực. Toà mới tinh chưa có dữ liệu thì biểu đồ trống.
- Phạm vi số liệu bám theo **quyền truy cập toà nhà** của bạn: chủ nhà thấy mọi toà, quản lý toà chỉ thấy các toà được phân công.
:::

## Cách mở

**Bước 1**: Vào **Báo cáo** => **Tài chính** => **Phân tích tài chính**. Màn báo cáo mở ra với hàng bộ lọc phía trên (tháng neo, toà, công tắc **Dồn tích**) và năm tab: **Tổng quan**, **Doanh thu**, **Chi phí**, **Lợi nhuận**, **Vận hành**.

![Màn hình báo cáo](./images/buoc-01-man-hinh.webp)

Tab **Tổng quan** hiện mặc định, gồm dải KPI thời điểm và bảng **insight**; bốn tab còn lại đi sâu vào từng khối biểu đồ theo tháng.

## Bộ lọc & cách đọc số

Bộ lọc nằm chung một hàng phía trên, áp cho **cả năm tab**. Số của trang được **tính sẵn dưới cơ sở dữ liệu** rồi trả về, nên đổi bộ lọc là báo cáo vẽ lại ngay.

| Cột / Chỉ số | Ý nghĩa |
| --- | --- |
| Bộ lọc **Tháng** (neo) | Chọn tháng mốc. Báo cáo lùi về **13 tháng** tính từ mốc này (mốc và cùng tháng năm trước) để vẽ xu hướng và so **cùng kỳ (YoY)**. |
| Bộ lọc **Toà nhà** | Ô chọn một toà (phẳng, gõ để tìm). Để trống = **tất cả toà** trong phạm vi quyền của bạn. Toà ảo "Chung" chỉ xuất hiện ở khối P&L và cơ cấu thu chi. |
| Công tắc **Dồn tích (theo kỳ áp dụng)** | **Bật mặc định** để khớp báo cáo Phân bổ lợi nhuận: khoản trải nhiều tháng được **chia đều** theo kỳ áp dụng. Tắt đi thì mỗi phiếu ghi trọn vào **ngày phiếu**. |
| Tab **Tổng quan** — dải KPI | Ảnh chụp *thời điểm*: trạng thái phòng (thuê/trống/đã cọc), **vacancy loss** (doanh thu mất do phòng trống), **ARPU** (doanh thu bình quân mỗi phòng), **cọc đang giữ**, và **phải thu** kèm **tuổi nợ**. |
| Tuổi nợ (aging) | Phải thu chia bậc theo hạn thanh toán (`due_date`): **chưa tới hạn / 1–30 / 31–60 / 61–90 / trên 90 ngày**. Đây là bậc theo ngày thật, **độc lập** với nhãn "Quá hạn" hiển thị trên danh sách hoá đơn. |
| Bảng **Insight** (Tổng quan) | Các nhận xét tự rút: tháng tăng/giảm mạnh, hạng mục chi phí nổi bật, chênh giữa phát hành và thực thu… — đọc nhanh thay cho việc tự dò biểu đồ. |
| Tab **Doanh thu** | Doanh thu theo tháng × toà, so YoY. **Chỉ gồm phần vào KQKD** (`kqkd_amount`) — **không** có tiền cọc. |
| Tab **Chi phí** | Cơ cấu chi theo **hạng mục** qua các tháng (điện, nước, sửa chữa, hoa hồng…) để thấy khoản nào đang phình. |
| Tab **Lợi nhuận** | P&L: **Doanh thu − Chi phí = Lãi/lỗ ròng** theo tháng × toà; số âm hiển thị đỏ. |
| Tab **Vận hành** | **Lấp đầy theo tháng** (loại toà ảo), **sự kiện hợp đồng** (ký mới / gia hạn / kết thúc) và **phát hành vs thực thu** hoá đơn — soi khả năng thu hồi tiền. |

::: tip Đọc "phát hành vs thực thu" thế nào cho đúng
Trên tab **Vận hành**, cột *phát hành* là tổng giá trị hoá đơn đã lên trong tháng, còn *thực thu* là tiền thật đã vào. Khoảng cách giữa hai cột chính là **công nợ đang tồn** — khớp với bậc tuổi nợ ở tab Tổng quan. Nếu khoảng cách nới rộng dần, đó là dấu hiệu tiền thu về đang chậm lại.
:::

## Nguồn số liệu

Toàn bộ con số trên trang đến từ **sáu phép tổng hợp chạy dưới cơ sở dữ liệu** (họ hàm `fa_*`), mỗi hàm lo một khối:

| Khối trên trang | Lấy từ đâu |
| --- | --- |
| P&L / Doanh thu / Lợi nhuận | Sổ thu chi (`income_expenses`) đã **duyệt**, cộng theo `kqkd_amount` — **cọc bị loại khỏi doanh thu** ngay từ mức hạng mục. |
| Cơ cấu chi phí | Sổ thu chi, gộp theo **hạng mục** thu/chi qua từng tháng. |
| Lấp đầy & sự kiện hợp đồng | Bảng phòng và hợp đồng (ký mới / gia hạn / kết thúc). |
| Phát hành vs thực thu, tuổi nợ | Hoá đơn (`invoices`) — đối chiếu giá trị phát hành với tiền đã thu, và chia bậc phải thu theo `due_date`. |
| KPI thời điểm (vacancy loss, ARPU, cọc giữ) | Tổng hợp trạng thái phòng + hoá đơn + cọc tại thời điểm xem. |

Vài đặc điểm về nguồn cần nhớ khi đối chiếu:

- **Tính đủ phiếu nhân viên tạo**: các phép tổng hợp chặn theo **quyền truy cập toà** chứ **không lọc theo người tạo phiếu**. Nên phiếu do nhân viên nhập vẫn được cộng — số ở đây có thể **cao hơn** vài báo cáo cũ vốn chỉ lấy phiếu của chủ.
- **Chỉ trả tháng/toà có dữ liệu**: tháng nào không phát sinh thì được điền số 0 khi vẽ, không phải lỗi mất dữ liệu.
- **Dồn tích vs ngày phiếu**: bật/tắt công tắc **Dồn tích** đổi hẳn cách quy tháng của khoản trải dài (chia đều theo kỳ áp dụng so với dồn vào ngày phiếu) — hai chế độ cho hai con số khác nhau ở cùng một tháng, đều đúng theo cách hiểu của nó.
- **13 tháng cố định**: cửa sổ luôn là 13 tháng để có cặp tháng cùng kỳ năm trước, dù bạn đổi tháng neo.

## Xuất & mẹo

- **Chốt số tháng trước khi đọc**: doanh thu/lãi chỉ chính xác khi thu/chi của tháng đã đủ và đã duyệt. Xem [Quy trình chốt tháng](/01-bat-dau/quy-trinh-chot-thang/).
- **Muốn tra tới từng phiếu**: trang này là góc nhìn tổng hợp, không mở tới chứng từ gốc. Thấy một tháng bất thường thì sang [Dòng tiền](/04-bao-cao/dong-tien/) hoặc soi chi tiết ở màn thu chi.
- **Đối chiếu khoản còn phải thu**: bậc tuổi nợ ở đây là số tổng; để xem từng hóa đơn/phòng và xử lý thu, mở [Quy trình thu tiền](/01-bat-dau/quy-trinh-thu-tien/).
- **So YoY nhanh**: giữ nguyên toà, kéo qua các tab Doanh thu/Chi phí/Lợi nhuận để đọc cặp cột năm nay — năm trước trên cùng biểu đồ.
- **Bộ lọc được giữ qua F5**: tháng, toà và công tắc Dồn tích được nhớ lại khi bạn tải lại trang, nên quay lại không phải chọn từ đầu.
- **Chênh với báo cáo khác là bình thường**: trang này cộng đủ phiếu nhân viên và loại cọc khỏi doanh thu; nếu số vênh với một dashboard nhanh, hãy đối chiếu hai điểm đó trước.

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/reports/finance/analysis" app-label="Mở báo cáo Phân tích tài chính" fixtures="Tòa DEMO A/B: 8 phòng đang thuê; A102 còn nợ 2.570.000đ; A105 quá hạn 6.070.000đ; cọc giữ chỗ A301/A302" view-only>

1. Mở tab **Tổng quan**: hãy nhìn thấy dải KPI cho **Tòa DEMO A/B** với **8 phòng đang thuê**, phần **cọc đang giữ** ứng với hai phòng cọc giữ chỗ **A301/A302**, và khối **phải thu theo tuổi nợ** đang gánh khoản của **A102 (2.570.000đ)** và **A105 quá hạn (6.070.000đ)** — A105 rơi vào bậc quá hạn cao hơn A102.
2. Sang tab **Lợi nhuận**: hãy nhìn thấy P&L **Doanh thu − Chi phí = Lãi/lỗ** theo tháng, và để ý doanh thu **không** bao gồm cọc của A301/A302 (cọc không tính vào kết quả kinh doanh).
3. Sang tab **Vận hành**: hãy nhìn thấy **tỷ lệ lấp đầy** phản ánh 8 phòng thuê, **sự kiện hợp đồng** (A104 đã gia hạn) và cột **phát hành vs thực thu** — khoảng cách giữa hai cột chính là phần công nợ của A102 và A105.
4. Bật/tắt công tắc **Dồn tích** và quan sát con số một tháng đổi theo cách quy kỳ; đổi ô **Toà** giữa DEMO A và DEMO B để thấy báo cáo vẽ lại theo phạm vi.

Kết quả mong đợi: bạn đọc được bức tranh lãi/lỗ 13 tháng của danh mục, hiểu rằng **cọc không nằm trong doanh thu**, và biết dùng bậc **tuổi nợ** cùng khối **phát hành vs thực thu** để phát hiện tiền thu về đang chậm ở đâu.

</SandboxTry>

## Quy trình liên quan

- [Quy trình chốt tháng](/01-bat-dau/quy-trinh-chot-thang/) — chốt thu/chi cho đủ và đúng *trước khi* đọc phân tích, để doanh thu/lãi không thiếu phiếu.
- [Hub Báo cáo tài chính](/04-bao-cao/hub-tai-chinh/) — cửa vào chung của 12 báo cáo tài chính, nơi mở trang này.
- [Dòng tiền](/04-bao-cao/dong-tien/) — soi tiền vào/ra theo tháng-quý từ sổ quỹ khi cần truy một tháng bất thường.
- [Quy trình thu tiền](/01-bat-dau/quy-trinh-thu-tien/) — quy số phải thu tổng về từng hóa đơn/phòng và thực hiện thu.
- [Danh sách cọc](/04-bao-cao/danh-sach-coc/) — đối chiếu phần "cọc đang giữ" trong KPI với danh sách cọc thực tế.
- [Tỷ lệ chi phí trên doanh thu](/04-bao-cao/ty-le-chi-phi/) — góc nhìn bổ trợ cho cơ cấu chi phí ở tab Chi phí.
- [Chia lợi nhuận cổ đông](/03-quan-ly-van-hanh/chia-loi-nhuan/) — dùng lãi/lỗ đã tính (cùng chế độ dồn tích) làm căn cứ chốt-chia cho cổ đông.
