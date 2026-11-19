# Prompt Hội đồng — Audit nghiệp vụ, code và dữ liệu

Dùng mẫu này khi cần đối chiếu hành vi thực tế với yêu cầu vận hành. Điền phần đầu vào và dán vào phiên làm việc của repo.

## Đầu vào

```text
CENTRAL_QUESTION = Khi mất mạng sau khi bấm thu tiền, người vận hành thấy gì và sổ quỹ ghi mấy lần?
SCOPE            = Hoá đơn → thu tiền → sổ quỹ
BUSINESS_GOAL    = Mỗi khoản thu hợp lệ vào sổ đúng một lần
MODE             = AUDIT_ONLY
DEPTH            = FOCUSED
TIMEBOX          = AUTO
LIVE_DB_ACCESS   = UNAVAILABLE
OUTPUT_PATH      =
SPECIAL_CONCERNS =
```

Thay ví dụ bằng câu hỏi thực tế. Các trường chưa cần có thể để trống. Với `SCOPE=AUTO`, chọn luồng sát câu hỏi nhất và nói rõ phạm vi. `TIMEBOX` là thời gian khảo sát nếu người dùng có giới hạn.

## FOCUSED — mặc định cho một tính năng

1. Chốt điều phải đúng và đối tượng chịu ảnh hưởng. Theo một đường chạy thực tế từ thao tác đến nơi ghi dữ liệu và phản hồi cho người dùng. Chọn góc nhìn cần thiết theo câu hỏi, chẳng hạn nghiệp vụ, kế toán, quyền, vận hành hoặc UX.
2. Kiểm giả thuyết bằng bằng chứng có thể tìm lại như `file:line`, test, định nghĩa DB hoặc quan sát runtime. Với nghi vấn ghi trùng, kiểm cả tình huống yêu cầu được gửi lại. Với nghi vấn sai quyền, đối chiếu quyền của người thực hiện và phạm vi tổ chức trên fixture. Tìm một phản ví dụ trước khi kết luận lỗi nghiêm trọng.
3. Trả lời trong chat bằng kết luận, bằng chứng, tác động và cách xác minh phần còn thiếu. Phân biệt lỗi trên working tree với lỗi trên bản đã phát hành. Khi cần khẳng định hành vi production, ghi SHA triển khai hoặc thời điểm quan sát tương ứng.

## DOMAIN và SYSTEM_WIDE

- Với `DOMAIN`, mở rộng từ tính năng sang các luồng dùng chung dữ liệu hoặc trách nhiệm nghiệp vụ. Ví dụ, đối chiếu nơi nhận cọc với nơi cấn trừ khi quyết toán.
- Với `SYSTEM_WIDE`, chọn các điểm giao giữa domain có thể làm sai tiền, trạng thái, quyền hoặc báo cáo. Lập bản đồ từ nguồn ghi đến các bên đọc. Đánh dấu ranh giới transaction, nghĩa vụ theo từng vai trò, retry của worker/cron và nơi dữ liệu lịch sử có thể lệch.
- Phân công các câu hỏi độc lập khi có lợi. Với phát hiện nghiêm trọng, đối chiếu bằng góc nhìn thứ hai hoặc phép thử có thể bác bỏ giả thuyết. Tái sử dụng truy vấn và bằng chứng đã có. Ghi nhận bất đồng còn ảnh hưởng đến kết luận.
- Báo cáo theo thứ tự ảnh hưởng. Với mỗi phát hiện, ghi đối tượng bị ảnh hưởng, bằng chứng, mức chắc chắn và hành động đề xuất. Chỉ thêm bảng drift khi các nguồn mâu thuẫn, và kế hoạch đối soát khi có lý do nghi dữ liệu đã ghi sai.

## Phạm vi thực hiện

- `AUDIT_ONLY` thu thập bằng chứng và kết luận. `PROPOSE` bổ sung phương án và tiêu chí nghiệm thu. `IMPLEMENT_AFTER_APPROVAL` sửa phần người dùng đã duyệt. Khi có sửa, chạy test trực tiếp cho hành vi thay đổi. Trước khi push, dùng gate theo diff cuối và quy trình review của repo. [Project Contract](../engineering/PROJECT_CONTRACT.md)
- Mặc định khảo sát trên repo. Nếu phép thử cần ghi dữ liệu, dùng fixture local hoặc project TEST trong phạm vi được giao. Chỉ truy vấn production khi đã có quyền đọc và câu hỏi cần dữ liệu thật. Chọn lệnh đọc qua repo, giới hạn theo phạm vi và ghi rõ phần còn chưa xác minh khi thiếu quyền. [Môi trường dữ liệu](../engineering/DATA_ENVIRONMENTS.md)
- Báo cáo có thể nêu kết quả đối soát khớp/lệch, số ca bất thường hoặc ví dụ bằng dữ liệu DEMO. Loại số tiền production, kể cả tổng hợp, cùng dữ liệu nhận dạng, bản ghi khách hàng và credential khỏi báo cáo hoặc log được chia sẻ.
- Để trống `OUTPUT_PATH` để trả kết quả trong chat. Ghi file khi người dùng yêu cầu báo cáo lưu tại đó. Khi cần backfill hoặc phát hành, ghi phương án để thực hiện riêng theo runbook.
