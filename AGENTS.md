# Codex

Đọc [Project Contract](docs/engineering/PROJECT_CONTRACT.md) trước khi sửa; đó là nguồn luật chung.

- Trả lời bằng tiếng Việt, báo kết quả và phần chưa xác minh.
- Worktree Codex đặt dưới `../codex-worktrees/<hang-muc>`; nháy kép đường dẫn có dấu cách.
- Dùng công cụ có sẵn trong phiên; nếu thiếu browser thì ghi rõ phần E2E chưa kiểm.
- MCP dự án khai ở [.mcp.json](.mcp.json). Nếu client không đọc file này, đăng ký wrapper:

```bash
codex mcp add gitnexus -- node scripts/run-pinned-gitnexus.mjs mcp
```

Quy trình graph và giới hạn bằng chứng: Contract §12. Phát hành và draft PR: Contract §3.

Trailer commit:

```text
Co-Authored-By: Codex <noreply@openai.com>
```
