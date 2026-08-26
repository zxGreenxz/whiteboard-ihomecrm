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
canh cả hai đầu — file này phải trỏ về Contract, và Contract không được đánh rơi các invariant đắt
nhất (danh sách sống là `MUST_MENTION` trong chính script — đừng chép con số vào đây: bản trước ghi
"16" khi danh sách đã lên 36).

---

## Trước khi push — MỘT lệnh

```bash
npm run gate:truoc-push                          # đầy đủ (kèm đảo strict, ~3 phút)
npm run gate:truoc-push -- --khong-dao-strict    # ~60 giây, đủ cho thay đổi docs/script
```

Nó TỰ sinh mọi artifact máy-sở-hữu đúng thứ tự (types.ts, bề mặt RPC/Edge/realtime, kiểm kê repo,
docs views, số đếm tài liệu, số baseline), TỰ `git add` các file đó, rồi chạy ~34 gate tĩnh không
dừng ở lỗi đầu. Mổ xẻ 17 lần CI đỏ (20–25/08/2026): 12 lần vì số đếm, 8 lần vì types.ts trôi —
toàn thứ lệnh này tự chữa. Đừng tự tay chạy lẻ 5 generator theo trí nhớ.

Đọc kết quả CI bằng `gh api .../runs/<id> --jq '.conclusion'` — `gh run watch --exit-status` từng
trả 0 trên run failure (đo 25/08/2026).

## OpenClaw: NGỪNG PHÁT TRIỂN (25/08/2026)

Mã `openclaw-*`/`openclaw-zalo` đóng băng làm tài liệu tham khảo — đã rút khỏi CI và vitest gốc.
KHÔNG sửa, không viết test mới, không import vào code CRM (`check-openclaw-isolation` chặn).
Chi tiết + điều kiện hồi sinh: `tooling/test-matrix.json → blockedFromCi`.

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

### Dùng lệnh nào cho việc nào

| Việc | Lệnh | Vì sao không dùng cái kia |
|---|---|---|
| Người mới vào dự án | `/understand-onboard`, `/understand-domain` | GitNexus trả quan hệ symbol, không kể được câu chuyện kiến trúc |
| Hiểu một vùng chưa biết | `/understand-explain <file\|symbol>` | — |
| **Sắp sửa code: đổi cái này thì vỡ gì** | `npm run graph:impact -- <symbol>` | UA **không** trả lời được câu này. Bậc quan hệ chính xác nằm ở GitNexus |
| Đọc lại một PR / thay đổi lớn | `/understand-diff` + `npm run graph:detect-changes` | Hai cái bổ sung nhau: diff kể ý nghĩa, detect-changes chỉ đích danh symbol và luồng |
| Trả lời câu hỏi về codebase | `/understand-chat` | — |

**Không thay thế nhau**: `/understand-diff` KHÔNG thay `graph:impact`. Diff kể *cái gì đã đổi*;
impact trả lời *cái gì sẽ vỡ*. Contract §12 bắt hỏi bán kính ảnh hưởng trước khi sửa — đó là việc
của `impact`.

**Ai đối chiếu kết quả**: mọi kết luận từ graph phải soi lại với `docs/he-thong/` (tài liệu hiện
hành) và contract manifest. Contract §12 xếp thứ tự ưu tiên rõ ràng: **contract manifest + SQL
harness > GitNexus > UA**. Graph nói ngược tài liệu hiện hành thì tin tài liệu, và ghi lại chỗ lệch
— đó là dấu hiệu graph đã cũ, không phải phát hiện mới.

---

## Skill và hook

Skill khả dụng liệt kê trong system prompt mỗi phiên; gọi bằng `/tên-skill`. Ba điều riêng của repo
này:

- **`/understand*` ghi vào `.ua/`** — thư mục đã commit. Đừng chạy chúng "cho biết" giữa một lát
  việc khác: artifact sẽ bẩn và lẫn vào commit của bạn. Refresh đi PR riêng (luật #6).
- **Skill sinh tự động không auto-commit**: `.claude/skills/generated/` nằm trong `.gitignore`
  (plan §15). Skill nào đáng giữ thì viết tay và commit tường minh.
- **Hook**: repo không cài hook tự sửa mã. GitNexus có tuỳ chọn cài hook và tự chèn mục vào
  `CLAUDE.md`/`AGENTS.md` — wrapper `run-pinned-gitnexus.mjs` **ép `--skip-agents-md`** để chặn,
  vì để công cụ tự sửa hợp đồng agent là để nó tự viết luật cho chính nó.

## Trailer commit

Thay đổi do Claude Code thực hiện dùng trailer:

```text
Co-Authored-By: Claude <noreply@anthropic.com>
```

**Không ghi số hiệu model vào đây.** Dòng này từng ghi cứng `Claude Opus 4.7 (1M context)` và
lặng lẽ cũ đi khi model đổi: đo ngày 22/08/2026 trên 25 commit gần nhất thì 15 commit ghi 4.7,
10 commit ghi Opus 5, **đan xen nhau ngay trong cùng một ngày**. Mỗi phiên tự xử một kiểu —
phiên nào theo file rule thì ghi sai model thật, phiên nào ghi đúng model thì lệch file rule.
Cả hai đều biến `git log` thành nguồn không tin được về việc ai làm gì.

Bỏ số hiệu là chữa nguyên nhân gốc, không phải chữa triệu chứng: quy ước không còn thứ để cũ đi.
Muốn biết model nào chạy phiên nào thì tra transcript phiên, đừng suy từ trailer. Cách này cũng
khớp `AGENTS.md`, vốn đã dùng `Co-Authored-By: Codex <noreply@openai.com>` không kèm phiên bản.

Phần còn lại của quy ước commit (prefix `feat`/`fix`/`chore`, và luật stage đúng file của phiên
mình) ở Contract §3 và §11.3.

---

## Ngôn ngữ

Trả lời user bằng **tiếng Việt**. Commit message viết Việt-Anh trộn theo style hiện có — xem
`git log --oneline`.
