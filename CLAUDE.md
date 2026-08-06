# CLAUDE.md — phần dành riêng cho Claude Code

> **Luật chung nằm ở [`docs/engineering/PROJECT_CONTRACT.md`](docs/engineering/PROJECT_CONTRACT.md).**
> Đọc file đó trước. Ở đây chỉ còn những gì KHÔNG chung được — thứ phụ thuộc vào công cụ mà
> Claude Code có, chứ không phụ thuộc vào dự án.

File này từng dài 211 dòng và lặp lại gần như toàn bộ Contract. Vấn đề của việc lặp không phải độ
dài mà là **hai bản sẽ lệch nhau**, rồi không ai biết bản nào đúng. Đã xảy ra thật: `AGENTS.md` dạy
chạy `npm run gen:types` kèm dấu redirect `>` đổ vào `types.ts` — cách viết mà shell cắt trắng file
đích TRƯỚC khi generator kịp chạy — suốt nhiều tháng, trong khi CI ghi đúng cách làm ngay cạnh đó
và không ai sửa file rule.

Bảng ánh xạ từng rule cũ về vị trí mới: **Contract §13**. Gate `node scripts/check-agent-contract.mjs`
canh cả hai đầu — file này phải trỏ về Contract, và Contract không được đánh rơi 16 invariant đắt nhất.

---

## Công cụ trình duyệt

Contract §8 quy định E2E chạy **headless** và chỉ ghi vào org DEMO. Phần dưới là cách gọi cụ thể
trong Claude Code.

```bash
cd .e2e-fleet && FLEET_WORKERS=8 npx playwright test specs/<file>.spec.ts
```

Tăng `FLEET_WORKERS` (8 → 30) khi cần quét rộng. Mỗi worker là một browser context riêng nên nhiều
tài khoản đăng nhập song song không đá nhau.

**Playwright MCP** (`mcp__playwright__browser_*`) cũng chạy ẩn — dùng khi cần soi kỹ MỘT màn hình
(chụp ảnh, đọc DOM từng bước), không dùng để quét diện rộng.

**Chỉ mở trình duyệt hiện hình khi user YÊU CẦU TƯỜNG MINH** ("bật web lên để tôi xem"):

```bash
cd .e2e-fleet && FLEET_HEADED=1 FLEET_WORKERS=2 npx playwright test specs/<file>.spec.ts
```

Giữ `FLEET_WORKERS` nhỏ (1–2) cho user nhìn kịp; config đã bật `slowMo` sẵn ở chế độ headed.

Nếu session không có công cụ browser nào, **ghi rõ khoảng trống xác minh trong báo cáo cuối** —
không tuyên bố đã test.

---

## Trailer commit

Mọi commit kèm:

```text
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Phần còn lại của quy ước commit (prefix `feat`/`fix`/`chore`, và luật stage đúng file của phiên
mình) ở Contract §3 và §11.3.

---

## Ngôn ngữ

Trả lời user bằng **tiếng Việt**. Commit message viết Việt-Anh trộn theo style hiện có — xem
`git log --oneline`.
