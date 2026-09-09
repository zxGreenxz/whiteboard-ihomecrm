# Công việc còn lại sau đợt hoàn thiện G1

Đối chiếu ngày 09/09/2026 với plan `ki-m-tra-nh-gi-adaptive-hearth.md` và bản trong repo
`docs/superpowers/plans/2026-09-02-ai-copilot-va-nen-den-toan-quyen-muc-3.md`.
Phạm vi người dùng chốt: hoàn thiện G1, xử lý phần phát hành còn dang dở, đưa lên production,
báo cáo rồi dừng để người dùng quyết định. Không tự tiếp tục G2–G5 hoặc mở quyền cho công ty thật.
Tài liệu này là kiểm kê nguồn và bằng chứng đã có; kết quả canary/phát hành nằm trong biên nhận riêng.

## G1 bao gồm những gì

G1 là khả năng đọc dữ liệu, hiểu nghiệp vụ và ngữ cảnh trang, tra hướng dẫn, ghi nhớ,
điều hướng, hỗ trợ mobile và quản lý chi phí. Các thao tác ghi, duyệt, vào sổ và phân quyền
thuộc các giai đoạn sau.

- Inventory hiện có 55 công cụ đọc, gác quyền thuộc 34/42 module (80,95%; ngưỡng G1 là 80%).
- Điều hướng sinh từ contract: 47 contract quy về 19 trang canonical; công tắc điều hướng riêng.
- Corpus mock có 95 ca, gồm 17 ca danh mục/trạng thái C76–C92 và ba báo cáo C93–C95 mới bổ sung.
- Ba báo cáo bổ sung là khuyến mại, bàn giao tiền và chu kỳ thu/bàn giao. Mỗi danh sách có trần
  50 dòng; tổng tính trên phạm vi được cấp quyền. Hai báo cáo tài chính từ chối tổng gộp khi quyền
  báo cáo có DENY theo tòa/sổ; chu kỳ thu giao thêm phạm vi tòa người gọi quản lý.
- Ngữ cảnh bộ lọc và bản ghi đang mở: xem [bảng nguồn từng trang](copilot-active-page-context.md).
- Nghiệm thu G1 riêng gồm 19 điều hướng, ba mobile, hướng dẫn và bảng bộ nhớ; xem
  [quy trình và giới hạn](copilot-g1-canary.md). Chạy này không thay thế golden real-model G4.
- Kết quả room-pass 25/25 đã được giữ lại trong
  [biên nhận ngày 09/09](../generated/copilot-room-pass-acceptance-2026-09-09.json), không chạy lại.

Canary G1 trong plan chỉ áp dụng cho superadmin trên DEMO, có hạn dùng. Phát hành mã lên
production không đồng nghĩa tự mở tất cả công cụ cho iHome hoặc cho các vai khác.

## Các mục cần hoàn thành để chốt toàn bộ plan

| Giai đoạn | Đã có | Phần còn phải xử lý hoặc nghiệm thu |
|---|---|---|
| G2 — nền ghi có kiểm soát | Catalog có 32 action: 7 L3/L4, 1 maker-submit L5 và 24 direct L5. Đã có nonce, registry, kill switch và ledger. | Hoàn thiện các wrapper L3/L4 còn thiếu: tạo/sửa tin room-pass, metadata sổ quỹ, ghi chú khách/phòng, đánh dấu sale Zalo; hóa đơn nháp, hợp đồng mới, trạng thái phòng và tạo khách. Không lấy số action L5 để coi danh sách L3/L4 đã đủ. Chạy tiếp ma trận quyền/revoke/replay/song song cho action mới. |
| G3 — kế hoạch nhiều bước | Plan engine, batch consent, ledger và nhiều ca đồng thời/expiry đã có bằng chứng. Room-pass 25/25 hoàn tất. | Đối chiếu lại yêu cầu theo policy L5 đang sống; ca tiền đề trần L4 hiện có bằng chứng SQL cô lập, chưa phải HTTP live. Cần đủ bằng chứng canary tối thiểu một tuần không ghi ngoài ý muốn. |
| G4 — mô hình thật và bằng chứng phát hành | Manifest có 17 executor real-model; biên nhận ngày 08/09 giữ 10 ca đạt ở những build/context khác nhau. | Corpus hiện 95 ca: 78 ca chưa có executor real-model. C15 và C19 trong biên nhận gần nhất còn lỗi oracle. Hoàn thiện executor, chạy tiếp ca thiếu/hỏng, các tình huống sai org/revoke/replay/expiry, và chốt SLA độ trễ với chủ dự án. Không cộng các lượt chọn riêng thành một bộ đầy đủ đã đạt. |
| G5 — quyền L5 | PIN, standing grants, nhiều cặp preview/execute L5, RPC báo cáo ngày và màn hình quản trị đã có. | Review độc lập và nghiệm thu đầy đủ quyền, ghi sổ, đồng thời, rollback/reconcile hiệu ứng ngoài; diễn tập đường lùi của từng nhóm action. Cần bằng chứng báo cáo ngày được vận hành đều, canary hai tuần có unintended-write/duplicate/wrong-org đều bằng 0, rồi mới mở rộng vai/org theo quyết định người dùng. |

Nguồn đếm action: `src/copilot/plan/actionCatalog.ts`; executor thực:
`tooling/copilot-golden-scenarios.json`; kết quả mô hình thật:
[biên nhận ngày 08/09](../generated/copilot-golden-continuation-2026-09-08.json).
Bằng chứng trần L4 cô lập:
[biên nhận SQL](../generated/copilot-l4-isolated-acceptance-2026-09-07.json).
RPC báo cáo standing grant và giao diện đã có trong `standingGrantClient.ts` / `HanhDongTab.tsx`;
việc có màn hình này chưa chứng minh lịch gửi/tổng hợp ngày đã vận hành liên tục.

Plan cũ ghi chín báo cáo bất động sản, trong khi nguồn giao diện hiện có tám trang báo cáo BĐS.
Đợt G1 đối chiếu theo các trang đang tồn tại; không tự tạo thêm một báo cáo chưa có yêu cầu nghiệp vụ.
Các phần phải theo dõi một/hai tuần cần bằng chứng theo thời gian thật, không thay bằng việc chạy
nhiều lần trong một ngày. Chưa có cơ sở tuyên bố toàn bộ plan hoàn tất hoặc gán một tỷ lệ chung chính xác.
