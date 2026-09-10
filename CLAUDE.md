# Claude Code

Đọc [Project Contract](docs/engineering/PROJECT_CONTRACT.md) trước khi sửa; đó là nguồn luật chung.

- Trả lời bằng tiếng Việt, báo kết quả và phần chưa xác minh.
- Dùng worktree của harness khi có; nháy kép đường dẫn có dấu cách.
- Skill khả dụng do phiên làm việc cung cấp; chỉ đọc skill liên quan đến nhiệm vụ.
- MCP dự án khai ở [.mcp.json](.mcp.json); gọi GitNexus qua wrapper của repo (Contract §12).
- Playwright MCP dùng để kiểm từng màn hình; quét E2E bằng `.e2e-fleet/` theo Contract §8.
- Skill sinh tự động là chỉ mục tham khảo; không để tool ghi đè các file luật.

Trailer commit:

```text
Co-Authored-By: Claude <noreply@anthropic.com>
```
