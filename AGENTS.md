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

Vì sao phải qua wrapper (pin version, ép `--skip-agents-md`, ép `--repo`): xem mục
"Công cụ tri thức" trong `CLAUDE.md` — một bản, đừng chép lại đây (chính file này là án lệ
của việc hai bản lệch nhau).

Trước khi ĐỌC graph, chạy cửa chặn độ mới (Contract §12 luật #4):

```bash
npm run gate:graph-freshness -- --nhiem-vu <onboarding|architecture|domain-review|generated-docs|medium-risk|high-risk>
npm run graph:impact -- <symbol>        # bán kính ảnh hưởng — bắt buộc hỏi trước khi sửa
npm run graph:detect-changes            # git diff → symbol → luồng bị ảnh hưởng
```

---

## Làm việc song song

Luật đầy đủ ở **Contract §3, mục "Làm việc song song — mỗi hạng mục một worktree"**. Riêng cho
Codex: worktree của Codex nằm dưới `codex-worktrees/` cạnh repo; đường dẫn repo CÓ DẤU CÁCH nên
mọi lệnh phải nháy kép. Migration mới xin tên bằng `node scripts/tao-ten-migration.mjs <slug>`
(cấm chọn tay mốc tròn) và `git add` trước khi chạy `provenance:generate`.

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

E2E: xem Contract §8 (headless, chỉ org DEMO) — lệnh cụ thể ở `CLAUDE.md` mục "Công cụ trình duyệt".
Nếu session Codex không có công cụ browser, **ghi rõ khoảng trống xác minh trong báo cáo cuối** —
không tuyên bố đã test.
