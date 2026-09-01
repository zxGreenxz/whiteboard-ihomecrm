# Trung tâm tài liệu ptcrm

> **Last reviewed:** 2026-09-02  
> Đây là cổng vào duy nhất cho toàn bộ Markdown trong `docs/`. Mỗi nhóm có một index gần nhất; không tạo thêm file status song song khi đã có nguồn current.

## Bắt đầu từ đâu

| Nhu cầu | Nguồn nên đọc |
|---|---|
| **Sắp sửa code trong repo này** | **[PROJECT_CONTRACT.md](engineering/PROJECT_CONTRACT.md) — đọc TRƯỚC** |
| Thao tác trên giao diện | [Hướng dẫn sử dụng](huong-dan-su-dung/) và sidebar VitePress |
| Hiểu hành vi code/DB hiện tại | [Tham chiếu hệ thống](he-thong/README.md) |
| Tìm entry point/module/test | [Cấu trúc codebase](CODEBASE_STRUCTURE.md) |
| Đọc schema, migration và nguồn sự thật | [Database schema](DATABASE_SCHEMA.md) |
| Vận hành Supabase | [Supabase runbook](../supabase/README.md) |
| Xem trạng thái authorization | [Authorization current status](authorization/README.md) |
| Vận hành AI Copilot | [AI Copilot current status](ai-copilot/README.md) |
| Vận hành lương V5 | [Hệ lương thưởng](bang-luong/README.md) |
| Vận hành Zalo worker | [Zalo CRM](zalo/README.md) |

## Mục lục đầy đủ

### Hợp đồng kỹ thuật — luật, không phải mô tả

- **[engineering/PROJECT_CONTRACT.md](engineering/PROJECT_CONTRACT.md)** — luật chung cho mọi agent
  và mọi người sửa repo này: ba tổ chức trong cùng database, đường ghi production, migration, gate
  bắt buộc theo loại thay đổi, secret, công cụ tri thức. `CLAUDE.md` và `AGENTS.md` chỉ là **adapter**
  trỏ về đây; khi hai bên nói khác nhau thì Contract thắng.
- `tooling/` (ngoài `docs/`) — các file **máy đọc** mà Contract cưỡng chế, không phải tài liệu:
  `graph-policy.json`, `graph-manifests/`, `runtime-matrix.json`, `known-gaps.yaml`,
  `local-credential-contract.json`, `plan-remaining.json`, `program-status.json`, và các
  `*-baseline.json` của ratchet. Sửa văn xuôi mà quên sửa file tương ứng ở đây là cách hai bản lệch
  nhau — gate sẽ bắt, nhưng chỉ khi bạn chạy nó.

### Tài liệu gốc ở `docs/`

- [CODEBASE_STRUCTURE.md](CODEBASE_STRUCTURE.md) — canonical engineering overview.
- [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) — inventory schema và cách xác minh nguồn đúng.
- [AUTHORIZATION-PLAN.md](AUTHORIZATION-PLAN.md) — design baseline; trạng thái live ở `authorization/README.md`.
- [AI-SYSTEM-AUDIT-OPTIMIZATION-ROADMAP-2026-07-20.md](AI-SYSTEM-AUDIT-OPTIMIZATION-ROADMAP-2026-07-20.md) — audit/roadmap snapshot bất biến. File này được giữ nguyên; các số liệu và link lịch sử bên trong không thay current runtime truth.

### Hướng dẫn đã xuất bản

- [Trang chủ hướng dẫn](huong-dan-su-dung/) — 7 nhóm thao tác vận hành và khu demo kế hoạch số 8.
- [Sidebar đầy đủ](../docs-site/.vitepress/sidebar.mts) — mục lục của mọi trang published.
- [Mẫu trang](huong-dan-su-dung/_template.md) — template nội bộ, không xuất bản.
- Hai trang `cong-no-hd-moi` và `khach-no-tien` là redirect stub có `kind: redirect`, giữ cho bookmark cũ; nội dung vận hành hiện tại nằm ở Quy trình thu tiền.
- Khu [08 — Kế hoạch phát triển](huong-dan-su-dung/08-ke-hoach-phat-trien/) là presentation/proposal, không phải hướng dẫn runtime.

### Tham chiếu kỹ thuật và vận hành

- [he-thong/README.md](he-thong/README.md) — index đủ `00`–`24`, `99`, realtime và performance evidence.
- [authorization/README.md](authorization/README.md) — current status + toàn bộ evidence/tranche còn giữ.
- [ai-copilot/README.md](ai-copilot/README.md) — runtime, giới hạn, plan và spike evidence.
- [bang-luong/README.md](bang-luong/README.md) — system reference, runbook, spec, plan và implementation log.
- [zalo/README.md](zalo/README.md) — hiện trạng, rủi ro, setup và plan.
- [doi-chieu/README.md](doi-chieu/README.md) — runbook đối chiếu NABUBU/Hiển Thu và 686-TCB/TKHIEP.

### Kế hoạch, audit và hồ sơ lịch sử

- [plans/README.md](plans/README.md) — thư mục ĐÓNG BĂNG từ 02/09/2026 (index kèm trạng thái từng
  plan). **Mọi plan mới đi `docs/superpowers/plans/`** (tên `YYYY-MM-DD-<slug>.md`); spec thiết kế đi
  `docs/superpowers/specs/`; runbook đi `docs/superpowers/runbooks/`.
- [prompts/README.md](prompts/README.md) — prompt nghiên cứu tái sử dụng, không phải spec.
- [audits/README.md](audits/README.md) — index ĐẦY ĐỦ mọi audit snapshot (07/2026 → nay), kèm trạng
  thái finding.
- [refactor-2026-07/README.md](refactor-2026-07/README.md) — hồ sơ phase, risk register và bằng chứng refactor.

> **Không có `docs/archive/`, và đó là quyết định chứ không phải thiếu sót.** Plan kiến trúc liệt kê
> một thư mục `docs/archive`; vai trò đó do `refactor-2026-07/` đảm nhiệm — nó CHÍNH LÀ kho hồ sơ
> lịch sử, chỉ khác là tên nói rõ hồ sơ của đợt nào thay vì gộp mọi thứ vào một cái thùng không niên
> đại. Tạo thêm `archive/` sẽ cho hai chỗ cùng nghĩa "đồ cũ", và thứ nằm ở đâu sẽ tuỳ người cất.
> Đợt sau cần lưu trữ thì tạo `refactor-<năm>-<tháng>/` mới, đừng gom vào `archive/`.

## Phân loại vòng đời

| Loại | Ý nghĩa | Ví dụ |
|---|---|---|
| `canonical/current` | Mô tả hành vi hiện tại | `he-thong/**`, `CODEBASE_STRUCTURE.md`, `DATABASE_SCHEMA.md` |
| `current-status` | Một index duy nhất cho trạng thái runtime | `authorization/README.md`, `ai-copilot/README.md` |
| `runbook` | Quy trình vận hành/sự cố | `bang-luong/V5-RUNBOOK.md`, `zalo/ZALO-WORKER-SETUP.md`, `doi-chieu/**` |
| `active-plan` | Việc chưa đóng hoặc kế hoạch đánh giá | `plans/**`, `zalo/PLAN.md` |
| `presentation-plan` | Bản demo/proposal cho họp | `huong-dan-su-dung/08-ke-hoach-phat-trien/**` |
| `audit-evidence` | Snapshot theo ngày/commit | `audits/**`, authorization tranche, refactor phase |
| `redirect` | Biển chỉ đường từ URL tài liệu cũ | hai trang báo cáo công nợ đã chuyển |

Code chạy, generated types, migration mới hơn và runtime production luôn thắng audit/spec cũ. Tài liệu historical phải có banner hoặc nằm trong nhóm evidence.

### Quy ước banner vòng đời (chuẩn hoá 02/09/2026)

Tài liệu plan/spec/status không còn phản ánh hiện tại phải mang đúng MỘT banner ngay dưới tiêu đề H1:

```markdown
> **[LỊCH SỬ — ĐÃ SHIP <ngày>]** Tài liệu hiện hành: `docs/he-thong/<file>.md`. Giữ làm bằng chứng, không cập nhật nữa.
```

```markdown
> **[LỖI THỜI — BỊ THAY THẾ]** Thay bằng: `<đường dẫn file>`. Nội dung dưới đây có thể sai so với hiện tại.
```

```markdown
> **[CÒN SỐNG — trạng thái <ngày>]** <phần nào xong, phần nào chưa, chờ gì>
```

Luật đọc: file có banner **LỊCH SỬ** hoặc **LỖI THỜI** không được coi là mô tả hiện tại — kể cả khi
nội dung bên trong tự nhận là "hiện hành". Banner **CÒN SỐNG** phải nêu trạng thái theo ngày; quá
90 ngày không cập nhật thì coi như nghi vấn, xác minh lại bằng code trước khi tin.

## Dành cho AI agent

Thứ tự đọc khi nhận việc trong repo này:

1. **[engineering/PROJECT_CONTRACT.md](engineering/PROJECT_CONTRACT.md)** — luật, đọc trước mọi thứ.
2. **`docs/he-thong/<chủ đề>`** — hành vi hiện tại của vùng sắp sửa.
3. **Audit MỚI NHẤT của chủ đề** trong [audits/README.md](audits/README.md) — lỗi đã biết, finding
   còn mở.
4. **Plan CÒN SỐNG** (nếu đang làm dở) trong `docs/superpowers/plans/` — trạng thái từng phần.

Cảnh báo: knowledge graph (`.ua/`, GitNexus) có thể cũ hơn tài liệu — Contract §12 xếp ưu tiên
**contract manifest + SQL harness > GitNexus > UA**; graph nói ngược tài liệu hiện hành thì tin tài
liệu và ghi lại chỗ lệch. Plan/spec có banner LỊCH SỬ/LỖI THỜI chỉ dùng làm bối cảnh, không dùng làm
đặc tả để code.

## Quy tắc duy trì

- Không nhân bản cùng một nội dung ở nhiều nơi. Trang phụ tóm tắt và link về nguồn canonical.
- Khi một plan hoàn tất, chuyển kết luận bền vững vào tài liệu current rồi xoá/đánh nhãn plan lịch sử.
- Không để tài liệu historical trong `docs/he-thong/` vì AI Copilot nạp toàn bộ thư mục đó.
- Khi di chuyển/xoá file, cập nhật mọi comment/script/inbound link trong cùng commit.
- Không sửa hoặc commit secret, dữ liệu nhận diện khách hàng hay output live nhạy cảm vào Markdown.

## Kiểm tra

```powershell
npm run docs:check
npm --prefix docs-site run build
git diff --check
npm run typecheck:baseline
```

`docs:check` kiểm link, nội dung trùng SHA-256, ảnh và sidebar. Trang `kind: redirect`/`sidebar: false` được phép không xuất hiện trong sidebar.
