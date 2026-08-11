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

## Công cụ tri thức (GitNexus · Understand Anything)

Luật đầy đủ ở Contract §12. Đây là cách gọi cụ thể.

**Trước khi đọc graph, chạy cửa chặn độ mới** — Contract §12 luật #4 cấm nạp graph khi chưa có
verdict còn hiệu lực:

```bash
npm run gate:graph-freshness -- --nhiem-vu <onboarding|architecture|domain-review|generated-docs|medium-risk|high-risk>
```

**GitNexus — luôn qua wrapper, không gọi thẳng `gitnexus`.** Wrapper đọc version từ
`tooling/agent-tools.json` (pin chưa `verified` thì nó từ chối chạy) và tự chèn hai thứ người gọi
hay quên:

```bash
npm run graph:analyze            # index lại (tự ép --skip-agents-md)
npm run graph:status
npm run graph:impact -- <symbol>       # bán kính ảnh hưởng: đổi symbol này thì vỡ gì
npm run graph:detect-changes           # git diff → symbol → luồng thực thi bị ảnh hưởng
```

`graph:impact` và `graph:detect-changes` là hai lệnh trả lời câu hỏi mà Contract §12 bắt phải hỏi
trước khi sửa (bán kính ảnh hưởng). Dùng chúng thay vì đoán.

> **Vì sao phải qua wrapper, không phải cho vui**: GitNexus giữ registry **toàn cục theo máy**, không
> theo repo. Máy dev thường có nhiều clone/worktree cùng tên; khi đó lệnh truy vấn hoặc chết với
> "Multiple repositories indexed", hoặc — tệ hơn — chạy trót lọt và trả kết quả của **repo khác** mà
> không báo gì. Wrapper ép `--repo <đường dẫn repo này>` để câu trả lời luôn thuộc về đúng cây mã.

**Understand Anything**: refresh graph là `/understand --full --language vi`, và theo Contract §12
luật #6 nó phải đi **PR riêng**, không kèm thay đổi nào khác. Sau khi dựng lại, bắt buộc:

```bash
npm run gate:graph-secrets       # secret + PII trên artifact (cần binary gitleaks)
npm run gate:graph-hygiene       # hộ chiếu khớp artifact
```

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
