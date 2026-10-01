# Claude Code

Đọc [Project Contract](docs/engineering/PROJECT_CONTRACT.md) trước khi sửa; đó là nguồn luật chung.

- Trả lời bằng tiếng Việt, báo kết quả và phần chưa xác minh.
- Dùng worktree của harness khi có; nháy kép đường dẫn có dấu cách.
- Skill khả dụng do phiên làm việc cung cấp; chỉ đọc skill liên quan đến nhiệm vụ.
- Tra mã nguồn và GitNexus tùy chọn theo [Contract §12](docs/engineering/PROJECT_CONTRACT.md#12-tra-cứu-mã-nguồn-và-gitnexus).
- Playwright MCP dùng để kiểm từng màn hình; quét E2E bằng `.e2e-fleet/` theo Contract §8.
- Skill sinh tự động là chỉ mục tham khảo; không để tool ghi đè các file luật.

## Kiểm chứng và agent con

Phép kiểm của repo là các lệnh ở Contract §8 và §10. Kết quả xanh của đúng bản đang commit là
bằng chứng để báo cáo; chỉ chạy lại khi file đã đổi sau lượt đó. Ở repo này Contract thay cho các
bước kiểm thêm của skill cá nhân (kiểm "tươi" trước mỗi câu báo xong, review sau từng task).

Giao diện chỉ coi là xong khi đã nhìn ảnh chụp màn hình bị đổi ở khổ desktop và điện thoại:
đo DOM không bắt được lỗi nền trong suốt hay token CSS mất trong portal.

Chỉ giao việc cho agent con khi có nhiều nhánh việc lớn, độc lập, chạy song song được, ví dụ
khảo sát rộng nhiều thư mục. Việc tự làm xong trong vài lệnh thì tự làm; không dùng agent con để
kiểm lại việc của chính mình. Review độc lập theo Contract §3.

Trailer commit:

```text
Co-Authored-By: Claude <noreply@anthropic.com>
```
