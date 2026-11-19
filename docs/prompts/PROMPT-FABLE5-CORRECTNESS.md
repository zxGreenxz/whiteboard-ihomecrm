# Prompt Fable 5 — Tính đúng đắn của dữ liệu và hiệu năng

Dùng mẫu này khi cần rà một phép tính, luồng ghi dữ liệu hoặc điểm chậm. Điền câu hỏi và dán nội dung vào phiên làm việc của repo.

## Đầu vào

```text
CENTRAL_QUESTION = Thu tiền hai lần với cùng mã yêu cầu có tạo thêm phiếu thu không?
SCOPE            = Từ thao tác thu tiền đến ghi sổ quỹ
MODE             = PROPOSE
DEPTH            = FOCUSED
LIVE_DB_ACCESS   = UNAVAILABLE
OUTPUT_PATH      =
```

Thay câu hỏi và phạm vi ví dụ bằng yêu cầu thực tế. Với `SCOPE=AUTO`, chọn luồng sát câu hỏi nhất và nêu phạm vi đã chọn. Mặc định `PROPOSE` chỉ đề xuất. Dùng `IMPLEMENT_SAFE` khi người dùng đã yêu cầu sửa trong phạm vi đó. Việc đánh giá chuyên sâu về phân quyền thuộc đợt review riêng của chủ dự án.

## Cách kiểm

1. Xác định phiên bản đang xét. Đọc thay đổi hiện có và giữ nguyên công việc đang dở của người dùng. Khi kết luận về bản phát hành, ghi SHA đã xác minh hoặc ghi rõ phiên bản còn chưa biết.
2. Theo một ví dụ từ đầu vào đến kết quả. Chỉ ra nơi ghi dữ liệu, ranh giới transaction và nơi người dùng nhận kết quả hoặc lỗi. Với câu hỏi hiệu năng, đo cùng đầu vào trước và sau.
3. Chọn một phép thử phân biệt hành vi đúng với lỗi nghi ngờ. Ví dụ, gửi lại cùng một yêu cầu trên fixture rồi kiểm số phiếu. Với lỗi kỳ báo cáo, dùng ngày đầu tháng và múi giờ Việt Nam. Với tổng sai, đối chiếu kết quả phân trang và tổng tính trên toàn tập. Dùng số liệu giả lập cho các ví dụ trong báo cáo.
4. Dẫn vị trí trong code, test hoặc object DB cho từng phát hiện. Phân biệt điều đã quan sát với giả thuyết. Nếu kết luận phụ thuộc production, ghi môi trường và bằng chứng thực sự có.

`FOCUSED` dừng khi đã trả lời câu hỏi bằng bằng chứng hoặc xác định được dữ kiện còn thiếu. Với `DOMAIN`, theo thêm các bên cùng ghi hoặc đọc dữ liệu đó. Với `SYSTEM_WIDE`, lần theo những điểm giao nhau có rủi ro như cọc → thu tiền → sổ quỹ hoặc tác vụ nền → báo cáo. Ưu tiên lỗi ghi một phần, ghi trùng, lệch kỳ và nhầm dữ liệu rỗng với lỗi truy vấn.

## Dữ liệu, sửa và trả kết quả

- Mặc định dùng source và fixture. Nếu có `LIVE_DB_ACCESS=AVAILABLE_READ_ONLY` và cần xác minh trạng thái thật, dùng lệnh đọc DB của repo theo §2 và §9. Kết quả từ production đưa vào báo cáo chỉ gồm khớp/lệch hoặc số trường hợp sai. Loại số tiền production (kể cả tổng), dữ liệu nhận dạng và credential khỏi nội dung chia sẻ. [Project Contract](../engineering/PROJECT_CONTRACT.md)
- Trong `IMPLEMENT_SAFE`, sửa nguyên nhân đã xác minh và chạy test trực tiếp cho hành vi thay đổi. Khi chuẩn bị push, dùng gate theo diff cuối theo §10 một lượt và dùng lại kết quả hợp lệ. Thử thao tác ghi trên fixture local hoặc project TEST đúng phạm vi. Giữ production chỉ đọc suốt phiên audit. Đề xuất migration hoặc đối soát dữ liệu cần triển khai riêng theo quy trình của repo.
- Trả lời câu hỏi trước, kèm bằng chứng, ảnh hưởng và phần chưa xác minh. Nếu đã sửa, nêu thay đổi và kết quả test. `OUTPUT_PATH` trống nghĩa là trả kết quả trong chat. Chỉ tạo báo cáo khi người dùng yêu cầu lưu.
