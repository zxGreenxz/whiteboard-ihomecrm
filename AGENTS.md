# AGENTS.md — phần dành riêng cho Codex

> **Luật chung nằm ở [`docs/engineering/PROJECT_CONTRACT.md`](docs/engineering/PROJECT_CONTRACT.md).**
> Đọc file đó trước. Ở đây chỉ còn phần đặc thù Codex.

File này từng dài 146 dòng và chép lại gần như toàn bộ Contract. Nó cũng là bằng chứng rõ nhất cho
việc **vì sao chép luật ra nhiều nơi là sai**:

- Nó dạy chạy `npm run gen:types` kèm dấu redirect `>` đổ vào `types.ts` — suốt nhiều tháng. Shell
  cắt trắng file đích **trước khi** generator kịp chạy, nên generator lỗi là `types.ts` chỉ còn một
  dòng banner. CI ghi đúng cách làm ngay cạnh đó, nhưng file rule thì không ai sửa.
  (Cố ý KHÔNG chép nguyên văn lệnh đó ở đây: một file hướng dẫn chứa sẵn lệnh phá file thì chỉ cách
  một cú copy-paste là gây hại, bất kể câu chữ xung quanh đang chê nó. Gate `check-agent-contract`
  cũng chặn đúng như vậy.)
- Ngay trước khi rút, nó vẫn ghi ratchet TypeScript là "hiện 30" trong khi con số thật đã là **26**.

Cả hai lỗi đều không thể phát hiện bằng test — chúng là văn bản. Cách chữa duy nhất có hiệu lực là
**chỉ có một bản**. Bảng ánh xạ từng rule cũ về vị trí mới: **Contract §13**.

---

## Trailer commit

Thay đổi do Codex thực hiện dùng trailer:

```text
Co-Authored-By: Codex <noreply@openai.com>
```

Phần còn lại của quy ước commit ở Contract §3 và §11.3.

---

## MCP — GitNexus qua wrapper ghim

Codex đăng ký MCP bằng `codex mcp add`. **Trỏ vào wrapper, không trỏ thẳng vào `gitnexus`:**

```bash
codex mcp add gitnexus -- node scripts/run-pinned-gitnexus.mjs mcp
```

Repo đã có sẵn `.mcp.json` khai đúng lệnh đó (theo DỰ ÁN, không theo máy) — dòng trên chỉ cần khi
client Codex của bạn không đọc `.mcp.json`.

Ba thứ wrapper làm mà lệnh trần không làm, mỗi thứ chặn một cách hỏng cụ thể:

- **Đọc version từ `tooling/agent-tools.json`** và từ chối chạy nếu pin chưa `verified`. `@latest`
  nghĩa là hôm nay và tháng sau chạy hai công cụ khác nhau trên cùng một câu hỏi.
- **Ép `--skip-agents-md`** cho `analyze`. Không có nó, GitNexus tự chèn mục vào `CLAUDE.md` và
  `AGENTS.md` — tức công cụ tự viết luật cho chính nó, vào đúng file bạn đang đọc.
- **Ép `--repo <repo này>`** cho các lệnh truy vấn. GitNexus giữ registry **toàn cục theo máy**;
  máy nào có hai clone cùng tên thì lệnh hoặc chết với "Multiple repositories indexed", hoặc — tệ
  hơn — chạy trót lọt và trả kết quả của **repo khác** mà không báo gì.

Trước khi ĐỌC graph, chạy cửa chặn độ mới (Contract §12 luật #4):

```bash
npm run gate:graph-freshness -- --nhiem-vu <onboarding|architecture|domain-review|medium-risk|high-risk>
npm run graph:impact -- <symbol>        # bán kính ảnh hưởng — bắt buộc hỏi trước khi sửa
npm run graph:detect-changes            # git diff → symbol → luồng bị ảnh hưởng
```

---

## Mở draft PR

Repo này là **trunk-based**: việc thường đi thẳng `git push origin HEAD:main` sau khi gate xanh
(Contract §3, §10). Draft PR dùng cho ba trường hợp, không phải mặc định:

1. **Refresh graph tri thức** — Contract §12 luật #6 bắt buộc PR riêng, không kèm thay đổi nào khác.
   Commit chỉ được chứa file trong `commitAllowlist` của `tooling/graph-policy.json`; gộp thêm là
   `gate:graph-hygiene` đỏ.
2. **Thay đổi cần mắt người trước khi vào main** — đụng tiền, đụng phân quyền, đụng lịch sử migration.
3. **Việc chưa xong nhưng cần người khác thấy** — draft, không phải PR sẵn sàng merge.

```bash
git switch -c <ten-nhanh>
git push -u origin <ten-nhanh>
gh pr create --draft --base main --title "<tiêu đề>" --body "<số đo + gate đã chạy>"
```

Thân PR phải có **số đo và tên gate đã chạy**, không phải mô tả ý định. `gh` chưa đăng nhập thì nói
rõ trong báo cáo và đưa link tạo tay — đừng tuyên bố đã mở PR.

---

## Công cụ trình duyệt

Contract §8 quy định E2E chạy headless, chỉ ghi org DEMO, mật khẩu qua `FLEET_PASS_*`.

```bash
cd .e2e-fleet && FLEET_WORKERS=8 npx playwright test specs/<file>.spec.ts
```

Nếu session Codex không có công cụ browser, **ghi rõ khoảng trống xác minh trong báo cáo cuối** —
không tuyên bố đã test.
